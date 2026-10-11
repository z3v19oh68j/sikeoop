// Puts the soundtrack under out/video.mp4: the music bed plus every sound cue from the page.
//   node mix.cjs   →   out/sikeoop-pv.mp4
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const cues = JSON.parse(fs.readFileSync(path.join(dir, "out", "cues.json"), "utf8"));
const DUR = 90;
/** Where in the track the bed starts, and how loud it sits under the sound effects. The page's
 * beat grid (pv.js: BEAT, PHASE) is measured from the start of this track, so keep MUSIC_FROM 0. */
const MUSIC = "music-voxel.mp3";
const MUSIC_FROM = 0;
const MUSIC_VOL = 0.42;

const args = ["-y", "-loglevel", "error", "-i", path.join(dir, "out", "video.mp4"), "-ss", String(MUSIC_FROM), "-t", String(DUR), "-i", path.join(dir, "assets", MUSIC)];
const files = [...new Set(cues.map((c) => c[1].replace(/\.ogg$/, ".wav")))];
for (const f of files) args.push("-i", path.join(dir, "assets", "sfx", f));
const inputOf = (f) => 2 + files.indexOf(f.replace(/\.ogg$/, ".wav"));

const parts = [];
// Music: in straight away (the hook types to the beat), gently out over the end card.
parts.push(`[1:a]volume=${MUSIC_VOL},afade=t=in:d=0.3,afade=t=out:st=${DUR - 4}:d=4,apad=whole_dur=${DUR}[m]`);
// Each source file is split once per use, then delayed to its cue.
const uses = new Map();
cues.forEach(([, f]) => uses.set(inputOf(f), (uses.get(inputOf(f)) ?? 0) + 1));
const taken = new Map();
for (const [i, n] of uses) parts.push(`[${i}:a]asplit=${n}${Array.from({ length: n }, (_, k) => `[s${i}_${k}]`).join("")}`);
const labels = cues.map(([t, f, vol], j) => {
  const i = inputOf(f);
  const k = taken.get(i) ?? 0;
  taken.set(i, k + 1);
  const ms = Math.round(t * 1000);
  parts.push(`[s${i}_${k}]volume=${vol},adelay=${ms}|${ms}[c${j}]`);
  return `[c${j}]`;
});
parts.push(`[m]${labels.join("")}amix=inputs=${labels.length + 1}:normalize=0:duration=first,alimiter=limit=0.95[a]`);

args.push("-filter_complex", parts.join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-t", String(DUR), path.join(dir, "out", "sikeoop-pv.mp4"));
execFileSync("ffmpeg", args, { stdio: "inherit" });
console.log(`${cues.length} cues mixed → out/sikeoop-pv.mp4`);
