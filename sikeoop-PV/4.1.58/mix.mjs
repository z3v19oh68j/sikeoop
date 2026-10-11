// Mixes the PV audio and muxes it with the silent video (based on the 4.1 PV's mix.mjs).
//   voice lines at their scene's voice start; Mixkit sound effects at their cues; the Mixkit music
//   with its lead-in trimmed (MUSIC_OFFSET, from bpm.py) so its 120 BPM grid starts at 0 and every
//   cut (whole 2 s bars) lands on a downbeat; music ducked under the voice; -14 LUFS.
// node mix.mjs video-silent.mp4 out.mp4
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const [videoIn, out] = process.argv.slice(2);
const tl = JSON.parse(readFileSync(path.join(dir, "timeline.json"), "utf8"));
const MUSIC = path.join(dir, "downloads", "music-just-kidding-11.mp3");
const MUSIC_OFFSET = 0.12;
const SFX = { whoosh: "sfx-whoosh-1491.wav", pop: "sfx-pop-2358.wav", correct: "sfx-correct-2870.wav", alarm: "sfx-alarm-995.wav", typing: "sfx-typing-1392.wav", sparkle: "sfx-sparkle-2350.wav", click: "sfx-click-1113.wav", back: "sfx-back-2575.wav" };
const D = tl.total.toFixed(3);

const inputs = ["-i", path.resolve(dir, videoIn), "-i", MUSIC];
const parts = [];
let n = 2;
const vo = [], sfx = [];
for (const s of tl.scenes) {
  inputs.push("-i", path.join(dir, "vo", `${s.id}.wav`));
  const ms = Math.round(s.vo * 1000);
  parts.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=90,acompressor=threshold=0.25:ratio=2.5:attack=5:release=120,volume=1.4,adelay=${ms}|${ms},apad[v${n}]`);
  vo.push(`[v${n}]`); n++;
}
for (const c of tl.cues) {
  inputs.push("-i", path.join(dir, "downloads", SFX[c.file]));
  const ms = Math.round(c.t * 1000);
  const trim = c.len ? `atrim=0:${c.len},afade=t=out:st=${c.len - 0.3}:d=0.3,` : "";
  parts.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,${trim}volume=${c.gain},adelay=${ms}|${ms},apad[s${n}]`);
  sfx.push(`[s${n}]`); n++;
}
parts.push(`${vo.join("")}amix=inputs=${vo.length}:normalize=0,atrim=0:${D},asplit=2[vo][vokey]`);
parts.push(`${sfx.join("")}amix=inputs=${sfx.length}:normalize=0,atrim=0:${D}[sfx]`);
parts.push(`[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=start=${MUSIC_OFFSET},asetpts=PTS-STARTPTS,atrim=0:${D},afade=t=in:d=0.3,afade=t=out:st=${(tl.total - 4).toFixed(3)}:d=4,volume=0.42[bgm]`);
parts.push(`[bgm][vokey]sidechaincompress=threshold=0.02:ratio=5:attack=15:release=350[duck]`);
parts.push(`[duck][vo][sfx]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", parts.join(";"), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", D, path.resolve(dir, out)], { stdio: "inherit" });
console.log("done", out);
