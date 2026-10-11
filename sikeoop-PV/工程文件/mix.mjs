// Mixes the PV's audio and muxes it with the silent video:
//   voice lines at their scene's voice start, sound effects at their cues, the music ducked under
//   the voice (sidechain), loudness-normalized to -14 LUFS.
// node mix.mjs video-silent.mp4 out.mp4
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const [videoIn, out] = process.argv.slice(2);
const tl = JSON.parse(readFileSync(path.join(dir, "timeline.json"), "utf8"));

// The Kenney sound files, by name.
const sfxDir = (() => {
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
  return Object.fromEntries(walk(path.join(dir, "sfx-src")).filter((f) => f.endsWith(".wav")).map((f) => [path.basename(f, ".wav"), f]));
})();

const inputs = ["-i", path.join(dir, videoIn), "-i", path.join(dir, "bgm.wav")];
const parts = [];
let n = 2;
const voIds = [];
for (const s of tl.scenes) {
  inputs.push("-i", path.join(dir, "vo", `${s.id}.wav`));
  const ms = Math.round(s.vo * 1000);
  parts.push(`[${n}:a]aresample=48000,highpass=f=90,acompressor=threshold=0.25:ratio=2.5:attack=5:release=120,volume=1.35,adelay=${ms}|${ms},apad[v${n}]`);
  voIds.push(`[v${n}]`);
  n++;
}
const sfxIds = [];
for (const c of tl.cues) {
  const f = sfxDir[c.file];
  if (!f) throw new Error(`no sound ${c.file}`);
  inputs.push("-i", f);
  const ms = Math.round(c.t * 1000);
  parts.push(`[${n}:a]aresample=48000,volume=${c.gain},adelay=${ms}|${ms},apad[s${n}]`);
  sfxIds.push(`[s${n}]`);
  n++;
}
const D = tl.total.toFixed(3);
parts.push(`${voIds.join("")}amix=inputs=${voIds.length}:normalize=0,atrim=0:${D},asplit=2[vo][vokey]`);
parts.push(`${sfxIds.join("")}amix=inputs=${sfxIds.length}:normalize=0,atrim=0:${D}[sfx]`);
parts.push(`[1:a]aresample=48000,volume=0.5,atrim=0:${D}[bgm]`);
parts.push(`[bgm][vokey]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350:makeup=1[duck]`);
parts.push(`[duck][vo][sfx]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);

execFileSync(
  "ffmpeg",
  ["-y", "-loglevel", "error", ...inputs, "-filter_complex", parts.join(";"), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", path.join(dir, out)],
  { stdio: "inherit" },
);
console.log("done", out);
