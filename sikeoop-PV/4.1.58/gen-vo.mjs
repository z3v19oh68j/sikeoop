import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync("script.json","utf8"));
const style = "活泼俏皮的年轻女生，傲娇又开心，语速偏快，吐字清楚，句尾带点调侃";
for (const x of s) execFileSync("node", ["tts.mjs", `vo/${x.id}.wav`, "冰糖", style, x.line], { stdio: "inherit" });
