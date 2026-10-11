// Speech recordings for transcription: MiMo ASR takes only wav / mp3, MediaRecorder makes webm.

/** Any recording the browser can decode → 16 kHz mono 16-bit PCM WAV (about 1.9 MB a minute). */
export async function toWav(data: ArrayBuffer): Promise<ArrayBuffer> {
  const RATE = 16000;
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(data).finally(() => void ctx.close());
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return out.buffer;
}
