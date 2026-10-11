import "@fontsource-variable/geist";
import "./dictation.css";
import type { DictationApi, DictationState } from "@shared/types";
import { toWav } from "../wav";

// The dictation bubble: follows the main process. While "listening" it holds the microphone and
// shows the voice level; on "sending" it hands over the recording as WAV.

declare global {
  interface Window {
    dictation: DictationApi;
  }
}

const bubble = document.getElementById("bubble")!;
const text = document.getElementById("text")!;
const bars = [...document.querySelectorAll<HTMLElement>("#wave i")];

let phase: DictationState["phase"] = "idle";
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let sendOnStop = false;
let meter: { ctx: AudioContext; raf: number } | null = null;

const LABEL: Record<DictationState["phase"], string> = {
  idle: "",
  listening: "在听…松开就输入",
  sending: "正在识别…",
  thinking: "正在识别…",
  error: "",
};

async function startRecording(): Promise<void> {
  if (recorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (phase !== "listening" && phase !== "sending") return stream.getTracks().forEach((t) => t.stop());
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      stopMeter();
      recorder = null;
      if (!sendOnStop) return;
      sendOnStop = false;
      const blob = new Blob(chunks, { type: (rec.mimeType || "audio/webm").split(";")[0] });
      chunks = [];
      void blob
        .arrayBuffer()
        .then(toWav)
        .then((wav) => window.dictation.audio(wav))
        .catch(() => window.dictation.audio(new ArrayBuffer(0), "录音转换失败"));
    };
    recorder = rec;
    rec.start(250);
    startMeter(stream);
    if (phase === "sending") stopRecording(true);
  } catch (err) {
    window.dictation.audio(new ArrayBuffer(0), err instanceof DOMException && err.name === "NotAllowedError" ? "没有麦克风权限" : "打不开麦克风");
  }
}

function stopRecording(send: boolean): void {
  if (!recorder) return;
  sendOnStop = send;
  if (recorder.state !== "inactive") recorder.stop();
}

/** The little bars follow the voice level. */
function startMeter(stream: MediaStream): void {
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  const tick = () => {
    an.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    const level = Math.min(1, peak / 50);
    bars.forEach((b, i) => (b.style.transform = `scaleY(${0.25 + level * (0.75 - Math.abs(i - 2) * 0.15)})`));
    if (meter) meter.raf = requestAnimationFrame(tick);
  };
  meter = { ctx, raf: requestAnimationFrame(tick) };
}

function stopMeter(): void {
  if (!meter) return;
  cancelAnimationFrame(meter.raf);
  void meter.ctx.close();
  meter = null;
  bars.forEach((b) => (b.style.transform = ""));
}

window.dictation.onState((s) => {
  phase = s.phase;
  if (s.phase === "listening") void startRecording();
  else if (s.phase === "sending") stopRecording(true);
  else if (s.phase === "idle") stopRecording(false);
  bubble.hidden = s.phase === "idle";
  bubble.dataset.phase = s.phase;
  text.textContent = s.phase === "error" ? (s.message ?? "出了点问题") : LABEL[s.phase];
});
