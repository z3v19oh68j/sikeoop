// Background music for the PV, synthesized here (so there are no licensing questions):
// 112 BPM, Fmaj7 – G6 – Em7 – Am7, a soft pad, a plucked 16th arpeggio, bass and light drums.
// Sections follow timeline.json: pad only through the boot, drums from the wordmark, everything
// on in the feature scenes, drums out for the end card, the last chord ringing out.
// node synth.mjs → bgm.wav (48 kHz, 16-bit stereo)
import { readFileSync, writeFileSync } from "node:fs";

const tl = JSON.parse(readFileSync(new URL("./timeline.json", import.meta.url), "utf8"));
const SR = 48000;
const TOTAL = tl.total + 0.4;
const N = Math.ceil(TOTAL * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);
const BPM = 112;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const sceneStart = Object.fromEntries(tl.scenes.map((s) => [s.id, s.start]));
const DRUMS_IN = 3.3; // the wordmark locks in
const FULL_IN = sceneStart.browser;
const DRUMS_OUT = sceneStart.end;

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Chords as MIDI notes (pad voicing), and their roots for the bass.
const CHORDS = [
  { notes: [53, 57, 60, 64], root: 41 }, // Fmaj7
  { notes: [55, 59, 62, 64], root: 43 }, // G6
  { notes: [52, 55, 59, 62], root: 40 }, // Em7
  { notes: [57, 60, 64, 67], root: 45 }, // Am7
];
const chordAt = (t) => CHORDS[Math.floor(t / BAR) % CHORDS.length];

let seed = 1;
const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
const add = (i, l, r) => {
  if (i >= 0 && i < N) {
    L[i] += l;
    R[i] += r;
  }
};
const level = (t) => {
  // Overall shape: fade in, and the end card a little quieter before the tail.
  const fadeIn = Math.min(1, t / 1.2);
  const tail = t > tl.total - 1.8 ? Math.max(0, (TOTAL - t) / (TOTAL - (tl.total - 1.8))) : 1;
  return fadeIn * tail;
};

// ---- pad: detuned sines, chord changes crossfaded ----
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const bar = t / BAR;
  const k = bar - Math.floor(bar);
  const cur = chordAt(t);
  const prev = CHORDS[(Math.floor(bar) + CHORDS.length - 1) % CHORDS.length];
  const xf = Math.min(1, k / 0.12); // 0.12 of a bar to glide into the new chord
  let l = 0;
  let r = 0;
  for (const [chord, w] of [
    [cur, xf],
    [prev, 1 - xf],
  ]) {
    if (w <= 0) continue;
    chord.notes.forEach((n, j) => {
      const f = midi(n);
      const a = Math.sin(2 * Math.PI * f * 0.9988 * t + j);
      const b = Math.sin(2 * Math.PI * f * 1.0012 * t + j * 2);
      l += w * (a * 0.6 + b * 0.4);
      r += w * (a * 0.4 + b * 0.6);
    });
  }
  const swell = 0.85 + 0.15 * Math.sin(2 * Math.PI * t / (BAR * 2));
  const g = 0.022 * swell * level(t);
  L[i] += l * g;
  R[i] += r * g;
}

// ---- events on the 16th grid ----
const SIX = BEAT / 4;
for (let step = 0; step * SIX < TOTAL; step++) {
  const t0 = step * SIX;
  const s16 = step % 16; // position in the bar
  const lv = level(t0);
  const drums = t0 >= DRUMS_IN && t0 < DRUMS_OUT;
  const full = t0 >= FULL_IN && t0 < DRUMS_OUT;
  const chord = chordAt(t0);
  const i0 = Math.round(t0 * SR);

  // Arpeggio: chord tones up an octave, every 16th from the wordmark on (8ths before full).
  if (t0 >= DRUMS_IN - BAR && (full || s16 % 2 === 0 || t0 >= DRUMS_OUT)) {
    const order = [0, 1, 2, 3, 2, 1, 3, 2];
    const n = chord.notes[order[step % 8]] + 12 + (s16 >= 12 ? 12 : 0);
    const f = midi(n);
    const pan = step % 2 ? 0.35 : -0.35;
    const amp = 0.05 * lv * (t0 >= DRUMS_OUT ? 0.8 : 1);
    for (let j = 0; j < SR * 0.4; j++) {
      const t = j / SR;
      const env = Math.exp(-t / 0.11) * Math.min(1, t / 0.003);
      const v = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 3 * t)) * env * amp;
      add(i0 + j, v * (1 - pan), v * (1 + pan));
    }
  }
  // Bass: the root on 1 and the "and" of 3.
  if (full && (s16 === 0 || s16 === 10)) {
    const f = midi(chord.root);
    for (let j = 0; j < SR * 0.5; j++) {
      const t = j / SR;
      const env = Math.exp(-t / 0.28) * Math.min(1, t / 0.005);
      const v = Math.tanh(1.6 * Math.sin(2 * Math.PI * f * t)) * env * 0.11 * lv;
      add(i0 + j, v, v);
    }
  }
  if (!drums) continue;
  // Kick on every beat (softer before the full section).
  if (s16 % 4 === 0) {
    const amp = (full ? 0.42 : 0.22) * lv * (s16 === 0 ? 1 : 0.85);
    let ph = 0;
    for (let j = 0; j < SR * 0.3; j++) {
      const t = j / SR;
      const f = 45 + 95 * Math.exp(-t / 0.035);
      ph += (2 * Math.PI * f) / SR;
      const v = Math.sin(ph) * Math.exp(-t / 0.13) * amp;
      add(i0 + j, v, v);
    }
  }
  // Clap on 2 and 4.
  if (full && (s16 === 4 || s16 === 12)) {
    let lp = 0;
    for (let j = 0; j < SR * 0.18; j++) {
      const t = j / SR;
      const x = noise();
      lp += 0.35 * (x - lp);
      const v = (x - lp) * Math.exp(-t / 0.05) * 0.09 * lv;
      add(i0 + j, v * 0.9, v * 1.1);
    }
  }
  // Hats on the off-8ths.
  if (s16 % 4 === 2) {
    let prev = 0;
    for (let j = 0; j < SR * 0.06; j++) {
      const t = j / SR;
      const x = noise();
      const v = (x - prev) * Math.exp(-t / 0.018) * (full ? 0.035 : 0.02) * lv;
      prev = x;
      add(i0 + j, v * 1.1, v * 0.9);
    }
  }
}

// ---- a riser into the browser scene, and a soft impact on the cut ----
const riseStart = FULL_IN - 1.6;
for (let i = Math.round(riseStart * SR); i < Math.round(FULL_IN * SR); i++) {
  const k = (i / SR - riseStart) / 1.6;
  const v = noise() * k * k * 0.05;
  add(i, v, v);
}

// ---- master: soft clip, write ----
const pcm = Buffer.alloc(N * 4);
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const gain = 0.9 / Math.max(peak, 1e-6);
for (let i = 0; i < N; i++) {
  pcm.writeInt16LE(Math.round(Math.tanh(L[i] * gain) * 30000), i * 4);
  pcm.writeInt16LE(Math.round(Math.tanh(R[i] * gain) * 30000), i * 4 + 2);
}
const h = Buffer.alloc(44);
h.write("RIFF", 0);
h.writeUInt32LE(36 + pcm.length, 4);
h.write("WAVEfmt ", 8);
h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20);
h.writeUInt16LE(2, 22);
h.writeUInt32LE(SR, 24);
h.writeUInt32LE(SR * 4, 28);
h.writeUInt16LE(4, 32);
h.writeUInt16LE(16, 34);
h.writeUInt32LE(pcm.length, 40);
h.write("data", 36);
writeFileSync(new URL("./bgm.wav", import.meta.url), Buffer.concat([h, pcm]));
console.log("bgm.wav", TOTAL.toFixed(2), "s");
