// node tts.mjs <out.wav> <voice> <style> <text>
import { readFileSync, writeFileSync } from "node:fs";
const [out, voice, style, text] = process.argv.slice(2);
const key = readFileSync(new URL("./.mimo-tts-key", import.meta.url), "utf8").trim();
const res = await fetch("https://token-plan-cn.xiaomimimo.com/v1/chat/completions", {
  method: "POST",
  headers: { "api-key": key, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "mimo-v2.5-tts",
    messages: [{ role: "user", content: style }, { role: "assistant", content: text }],
    audio: { format: "wav", voice },
  }),
});
const body = await res.json();
if (!res.ok) { console.error(res.status, JSON.stringify(body).slice(0, 400)); process.exit(1); }
const data = body.choices?.[0]?.message?.audio?.data;
if (!data) { console.error("no audio", JSON.stringify(body).slice(0, 400)); process.exit(1); }
writeFileSync(out, Buffer.from(data, "base64"));
console.log(out, Buffer.from(data, "base64").length, "bytes");
