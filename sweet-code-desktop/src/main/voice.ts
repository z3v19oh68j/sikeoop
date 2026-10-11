import { promises as fs } from "node:fs";
import { net, safeStorage } from "electron";
import type { VoiceSettings } from "@shared/types";

// Voice input: the island records (as WAV), this turns it into text. MiMo's ASR model by default,
// on the MiMo key the user already has: /chat/completions with the audio as a base64 data URL
// (mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition; wav or mp3 only, ≤ 10 MB encoded).
// Any other model goes to the OpenAI-style /audio/transcriptions (Whisper, SiliconFlow, Groq…).
// A key of its own is kept encrypted with the system keychain, like provider keys.

const DEFAULTS = { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.5-asr" };

interface Saved {
  baseUrl?: string;
  model?: string;
  /** base64 of safeStorage.encryptString(key) */
  key?: string;
}

export class Voice {
  private saved: Saved = {};

  constructor(
    private readonly file: string,
    /** A key that already works for this address (the MiMo provider's), or "" — used when none is saved here. */
    private readonly fallbackKey: (baseUrl: string) => string,
  ) {}

  private key(): string {
    if (this.saved.key) return safeStorage.decryptString(Buffer.from(this.saved.key, "base64"));
    return this.fallbackKey(this.settings().baseUrl);
  }

  async init(): Promise<void> {
    try {
      this.saved = JSON.parse(await fs.readFile(this.file, "utf8")) as Saved;
    } catch {
      // Not set up yet.
    }
  }

  settings(): VoiceSettings {
    const baseUrl = this.saved.baseUrl || DEFAULTS.baseUrl;
    return { baseUrl, model: this.saved.model || DEFAULTS.model, hasKey: !!this.saved.key, sharedKey: !this.saved.key && !!this.fallbackKey(baseUrl) };
  }

  ready(): boolean {
    return !!this.key();
  }

  async update(change: { baseUrl?: string; model?: string; key?: string; clearKey?: boolean }): Promise<VoiceSettings> {
    if (typeof change.baseUrl === "string") this.saved.baseUrl = change.baseUrl.trim().replace(/\/+$/, "");
    if (typeof change.model === "string") this.saved.model = change.model.trim();
    if (change.clearKey) delete this.saved.key;
    else if (change.key?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("这台电脑上没法加密保存 Key");
      this.saved.key = safeStorage.encryptString(change.key.trim()).toString("base64");
    }
    await fs.writeFile(this.file, JSON.stringify(this.saved), "utf8");
    return this.settings();
  }

  /** Audio (webm/opus from the island) → text. */
  async transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<string> {
    const key = this.key();
    if (!key) throw new Error("先在设置里填语音识别的 Key");
    const { baseUrl, model } = this.settings();
    if (/^mimo-.*asr/i.test(model)) return this.mimoAsr(baseUrl, model, key, audio, mime, signal);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), mime.includes("wav") ? "voice.wav" : "voice.webm");
    form.append("model", model);
    form.append("response_format", "json");
    const res = await net.fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 160);
      throw new Error(`语音识别失败（${res.status}）${detail ? `：${detail}` : ""}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }

  private async mimoAsr(baseUrl: string, model: string, key: string, audio: Buffer, mime: string, signal?: AbortSignal): Promise<string> {
    const res = await net.fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:${mime};base64,${audio.toString("base64")}` } }] }],
        asr_options: { language: "auto" },
      }),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 160);
      throw new Error(`语音识别失败（${res.status}）${detail ? `：${detail}` : ""}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
}
