import { promises as fs, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PvBeats, PvStoryboard } from "../../shared/types.ts";
import type { RunProcess } from "../papers/quarto.ts";
import type { FfmpegService } from "./ffmpeg.ts";
import { safePath, parseStoryboard } from "./store.ts";
import { assetPath } from "./assets.ts";
import { assetKind } from "./media.ts";

export const PCM_RATE = 8000;
export const MAX_AUDIO_SECONDS = 3600;
export type BeatGrid = { bpm: number; offset: number; beatsPerBar: number };
export function makeBeatGrid(file: string, duration: number, grid: BeatGrid, confidence = 1): PvBeats {
  if (!grid || !Number.isFinite(grid.bpm) || grid.bpm < 20 || grid.bpm > 400 ||
      !Number.isFinite(grid.offset) || grid.offset < 0 || !Number.isInteger(grid.beatsPerBar) || grid.beatsPerBar < 1 || grid.beatsPerBar > 16 ||
      !Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_SECONDS || grid.offset >= duration ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("节拍网格参数无效");
  const beats: number[] = [], bars: number[] = [];
  const period = 60 / grid.bpm;
  for (let i = 0; ; i++) {
    const at = grid.offset + i * period;
    if (at >= duration) break;
    const seconds = Math.round(at * 1e6) / 1e6;
    if (seconds >= duration) break;
    beats.push(seconds);
    if (i % grid.beatsPerBar === 0) bars.push(seconds);
  }
  return { file, bpm: grid.bpm, offset: grid.offset, beatsPerBar: grid.beatsPerBar, duration, beats, bars, confidence };
}

/** Positive log-energy flux, normalized autocorrelation, then weighted onset phase fitting. */
export function detectBeats(samples: Float32Array, sampleRate = PCM_RATE, file = "music.wav"): PvBeats {
  const duration = samples.length / sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 48000 || duration < 2 || duration > MAX_AUDIO_SECONDS)
    throw new Error("音乐长度无效（需要 2 秒至 1 小时）");
  const hop = Math.max(1, Math.round(sampleRate / 100)), rate = sampleRate / hop;
  const flux = new Float64Array(Math.ceil(samples.length / hop));
  let previous = 0, max = 0;
  for (let i = 0; i < flux.length; i++) {
    let energy = 0;
    const end = Math.min(samples.length, (i + 1) * hop);
    for (let j = i * hop; j < end; j++) {
      if (!Number.isFinite(samples[j])) throw new Error("音频 PCM 数据无效");
      energy += samples[j] * samples[j];
    }
    const current = Math.log1p(1000 * energy / Math.max(1, end - i * hop));
    flux[i] = Math.max(0, current - previous);
    previous = current;
    max = Math.max(max, flux[i]);
  }
  if (max < 0.00001) throw new Error("未检测到可用起音，请手动设置节拍网格");
  const peaks: { frame: number; weight: number }[] = [];
  for (let i = 0; i < flux.length; i++) {
    if (flux[i] < max * 0.12 || flux[i] < (flux[i - 1] ?? 0) || flux[i] < (flux[i + 1] ?? 0)) continue;
    const weight = (flux[i] / max) ** 2;
    if (peaks.length && i - peaks[peaks.length - 1].frame < rate * 0.08) {
      if (weight > peaks[peaks.length - 1].weight) peaks[peaks.length - 1] = { frame: i, weight };
    } else peaks.push({ frame: i, weight });
  }
  if (peaks.length < 3) throw new Error("可用起音太少，请手动设置节拍网格");
  // Squared strengths suppress quiet subdivisions. Test both half/double-tempo peaks rather
  // than always taking the first correlation maximum; phase coverage rejects skipped beats.
  const onset = new Float64Array(flux.length);
  for (const peak of peaks) onset[peak.frame] = peak.weight;
  const candidates: { lag: number; correlation: number; coverage: number; phase: number; score: number }[] = [];
  const minLag = Math.round(60 * rate / 200), maxLag = Math.min(Math.round(60 * rate / 60), Math.floor(flux.length / 3));
  const totalWeight = peaks.reduce((sum, p) => sum + p.weight, 0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, left = 0, right = 0;
    // +/- one flux frame makes correlation robust to quantized/non-integral intervals.
    for (let i = lag; i < onset.length; i++) {
      const a = onset[i], b = Math.max(onset[i - lag], onset[i - lag - 1] ?? 0, onset[i - lag + 1] ?? 0);
      sum += a * b; left += a * a; right += b * b;
    }
    const correlation = left && right ? Math.min(1, sum / Math.sqrt(left * right)) : 0;
    if (correlation < 0.15) continue;
    // Fit a fractional period from matching onset pairs before evaluating phase. Otherwise
    // e.g. 180 BPM (33.333 flux frames) drifts and misleadingly favors a 60 BPM harmonic.
    let distanceSum = 0, distanceWeight = 0;
    for (let i = 0; i < peaks.length; i++) for (let j = i + 1; j < Math.min(peaks.length, i + 5); j++) {
      const distance = peaks[j].frame - peaks[i].frame;
      if (distance > lag + 1.5) break;
      if (Math.abs(distance - lag) <= 1.5) {
        const weight = peaks[i].weight * peaks[j].weight;
        distanceSum += distance * weight; distanceWeight += weight;
      }
    }
    const periodFrames = distanceWeight ? distanceSum / distanceWeight : lag;
    let phase = peaks[0].frame, covered = 0;
    // Bounded phase histogram (period <= 100 frames), not quadratic in track length.
    const bins = Math.ceil(periodFrames), histogram = new Float64Array(bins);
    for (const peak of peaks) histogram[Math.floor(peak.frame % periodFrames)] += peak.weight;
    for (let k = 0; k < bins; k++) {
      const weight = histogram[k] + histogram[(k + bins - 1) % bins] + histogram[(k + 1) % bins];
      if (weight > covered) { covered = weight; phase = k; }
    }
    const coverage = covered / totalWeight;
    const bpm = 60 * rate / periodFrames;
    const prior = bpm >= 70 && bpm <= 180 ? 1 : 0.8;
    candidates.push({ lag: periodFrames, correlation, coverage, phase, score: 0.75 * correlation + 0.2 * coverage + 0.05 * prior });
  }
  candidates.sort((a, b) => b.score - a.score || a.lag - b.lag);
  const best = candidates[0];
  if (!best) throw new Error("节奏不够稳定，请手动设置节拍网格");
  const aligned = peaks.filter(p => Math.abs(p.frame - best.phase - Math.round((p.frame - best.phase) / best.lag) * best.lag) <= 2);
  const first = aligned.find(p => p.weight >= 0.2) ?? aligned[0];
  if (!first) throw new Error("未找到起拍，请手动设置节拍网格");
  // Linear fit improves non-integer BPM and preserves the actual first audible beat, not
  // its modulo-period phase (which would invent beats in an opening silence).
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const peak of aligned) {
    const x = Math.round((peak.frame - first.frame) / best.lag), y = peak.frame / rate, w = peak.weight;
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
  }
  const divisor = sw * sxx - sx * sx;
  const period = divisor > 0 ? (sw * sxy - sx * sy) / divisor : best.lag / rate;
  const fittedBpm = 60 / period;
  const bpm = Math.round((fittedBpm >= 60 && fittedBpm <= 200 ? fittedBpm : 60 * rate / best.lag) * 1000) / 1000;
  const offset = Math.max(0, (sy - period * sx) / sw);
  const harmonic = candidates.find(c => Math.abs(c.lag / best.lag - 2) < 0.06 || Math.abs(c.lag / best.lag - 0.5) < 0.03);
  const ambiguity = harmonic && harmonic.score > best.score * 0.95 ? 0.85 : 1;
  return makeBeatGrid(file, duration, { bpm, offset, beatsPerBar: 4 }, Math.min(1, best.correlation * best.coverage * ambiguity));
}

export function snapStoryboard(sb: PvStoryboard, beats: PvBeats, unit: "bar" | "beat"): PvStoryboard {
  if (unit !== "bar" && unit !== "beat") throw new Error("吸附单位无效");
  makeBeatGrid(beats.file, beats.duration, beats, beats.confidence);
  const seconds = 60 / beats.bpm * (unit === "bar" ? beats.beatsPerBar : 1);
  return parseStoryboard({ shots: parseStoryboard(sb).shots.map(shot => ({ ...shot,
    seconds: Math.round(Math.max(1, Math.round(shot.seconds / seconds)) * seconds * 1e6) / 1e6,
  })) });
}

export async function decodeMusic(root: string, id: string, file: string, ffmpeg: FfmpegService, run: RunProcess, signal: AbortSignal): Promise<Float32Array> {
  if (assetKind(file) !== "audio") throw new Error("配乐必须是音频素材");
  const source = await assetPath(root, id, file);
  const state = await ffmpeg.state();
  if (state.status !== "ready" || !state.path) throw new Error("ffmpeg 未就绪，无法分析节拍：" + (state.hint ?? state.error ?? "请先安装或批准下载 ffmpeg"));
  const output = await safePath(root, id, "out/.beats-" + randomUUID() + ".pcm");
  let log = "";
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    signal.throwIfAborted();
    const code = await run(state.path, ["-nostdin", "-hide_banner", "-i", source, "-vn", "-ac", "1", "-ar", String(PCM_RATE),
      "-t", String(MAX_AUDIO_SECONDS + 1), "-c:a", "pcm_f32le", "-f", "f32le", output], path.dirname(output), text => { log = (log + text).slice(-2000); }, signal);
    signal.throwIfAborted();
    if (code !== 0) throw new Error("音乐解码失败：" + log);
    await safePath(root, id, "out/" + path.basename(output));
    const handle = await fs.open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size === 0 || st.size % 4 || st.size > MAX_AUDIO_SECONDS * PCM_RATE * 4) throw new Error("音乐 PCM 无效或超过 1 小时");
      const bytes = await handle.readFile();
      const samples = new Float32Array(bytes.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
      return samples;
    } finally { await handle.close(); }
  } finally { await fs.rm(output, { force: true }); }
}
