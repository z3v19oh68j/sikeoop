import "@fontsource-variable/geist";
import "./island.css";
import type { AgentSessionView, IslandApi, IslandLayout, IslandState } from "@shared/types";
import { characterFor } from "../home/characters";
import { toWav } from "../wav";

// The Dynamic Island page. One element morphs between states: its size and corner radius
// animate (CSS transitions), and the content inside is swapped and fades in from a blur once the
// shape is mostly there. Two layouts: a floating capsule ("pill"), or wrapped around a Mac's
// camera notch ("notch": a row of "ears" beside the notch, the rest below it). Plain DOM.

declare global {
  interface Window {
    island: IslandApi;
  }
}

type Kind = IslandState["kind"];
type SizeKey = Kind | "hover" | "usage";

/** Floating capsule: width, height, corner radius. */
const PILL: Record<SizeKey, [number, number, number]> = {
  idle: [200, 36, 18],
  hover: [216, 40, 20],
  usage: [300, 62, 26],
  working: [290, 36, 18],
  cli: [290, 36, 18],
  done: [344, 62, 26],
  question: [344, 62, 26],
  error: [344, 62, 26],
  progress: [344, 62, 26],
  ask: [396, 150, 32],
  shot: [440, 200, 28],
  shotThinking: [440, 112, 28],
  shotAnswer: [460, 400, 28],
  procs: [460, 420, 28],
  voice: [310, 52, 26],
};

/** Around the notch: `top` is the notch row; expanded states grow below it. */
const notchSize = (k: SizeKey, top: number): [number, number, number] =>
  (<Record<SizeKey, [number, number, number]>>{
    idle: [320, top, 12],
    hover: [340, top + 4, 14],
    usage: [460, top + 58, 22],
    working: [460, top + 50, 22],
    cli: [460, top + 46, 22],
    done: [460, top + 72, 24],
    question: [460, top + 72, 24],
    error: [460, top + 72, 24],
    progress: [460, top + 64, 24],
    ask: [500, top + 132, 26],
    shot: [480, top + 196, 26],
    shotThinking: [480, top + 108, 26],
    shotAnswer: [500, top + 390, 28],
    procs: [500, top + 400, 28],
    voice: [460, top + 56, 22],
  })[k];

/** done / error go back by themselves after this long (paused while hovered). */
const SETTLE_MS: Partial<Record<Kind, number>> = { done: 4000, error: 6000 };

const el = document.getElementById("island")!;
let layout: IslandLayout = { mode: "pill", top: 0 };
let current: IslandState = { kind: "idle", providerId: "" };
let hovered = false;
let settleTimer: number | undefined;
let settleLeft = 0;
let settleStarted = 0;
let clock: number | undefined;

// ---- small builders ----

function span(cls: string, text = ""): HTMLElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function avatar(providerId: string, size: number): HTMLElement {
  const c = characterFor(providerId);
  const a = span("av");
  a.style.width = a.style.height = `${size}px`;
  if (c?.art) {
    const img = document.createElement("img");
    img.src = c.art;
    img.alt = "";
    a.append(img);
  } else {
    a.textContent = (c?.name ?? "s").slice(0, 1);
    if (c) a.style.setProperty("--av", c.accent);
  }
  return a;
}

/** A round glossy badge with an icon: check (done), ! (error), ? (question). Fixed markup only. */
function orb(kind: "ok" | "bad" | "q"): HTMLElement {
  const o = span(`orb ${kind}`);
  const path =
    kind === "ok"
      ? '<path class="check" d="M5 12.5l4.5 4.5L19 7.5"/>'
      : kind === "bad"
        ? '<path d="M12 6.5v7"/><path d="M12 17.5h.01"/>'
        : '<path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.4-1.5 1.2-1.5 2.1v.4"/><path d="M12 17.5h.01"/>';
  o.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return o;
}

/** The current time, HH:mm (24-hour); kept up to date by the ticker below. */
const now = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const clockEl = () => span("clock", now());

function bars(): HTMLElement {
  const b = span("bars");
  for (let i = 0; i < 4; i++) b.append(span("bar"));
  return b;
}

function textCol(title: string, sub: string): HTMLElement {
  const c = span("col");
  c.append(span("title", title), span("sub", sub));
  return c;
}

function button(label: string, cls: string, onClick: () => void): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `gbtn ${cls}`;
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const elapsed = (from: number) => {
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function progressBar(pct: number | null): HTMLElement {
  const track = span(`track${pct === null ? " indeterminate" : ""}`);
  const fill = span("fill");
  if (pct !== null) fill.style.width = `${pct}%`;
  track.append(fill);
  return track;
}

// ---- content per state ----

/** The main part of a state: what goes in the capsule, or below the notch. */
function body(s: IslandState): HTMLElement[] {
  switch (s.kind) {
    case "idle":
      return s.usage ? [textCol(`今天 ${s.usage.today} tokens`, `累计 ${s.usage.total}`), button("🎤", "mic", () => window.island.voice("start")), button("进程", "", () => window.island.procs(true))] : [];
    case "working":
      return [span("text", s.text)];
    case "cli": {
      // Hovered: one row per session. Otherwise a one-line summary.
      if (hovered) return [agentList(s.sessions)];
      const n = (st: string) => s.sessions.filter((x) => x.status === st).length;
      const parts = [`${s.sessions.length} 个 AI 会话`];
      if (n("working")) parts.push(`${n("working")} 在干活`);
      if (n("waiting")) parts.push(`${n("waiting")} 等你`);
      if (s.sessions.length === 1) parts.splice(0, parts.length, `${s.sessions[0].name} · ${STATUS[s.sessions[0].status]}`);
      return [span("text", parts.join(" · "))];
    }
    case "done":
      return [orb("ok"), textCol(s.text, s.detail)];
    case "error":
      return [orb("bad"), textCol("出了点问题", s.text)];
    case "question":
      return [orb("q"), textCol("AI 有问题想问你", s.title), button("去回答", "", () => window.island.open())];
    case "progress": {
      const c = span("col wide");
      const row = span("row");
      row.append(span("title small", s.label), span("pct", s.pct === null ? "" : `${s.pct}%`));
      c.append(row, progressBar(s.pct));
      return [c];
    }
    case "ask": {
      const head = span("ask-head");
      head.append(avatar(s.providerId, 26), span("title", s.title));
      const actions = span("actions");
      if (s.warning) actions.append(span("warn", s.warning));
      actions.append(
        button("拒绝", "", () => window.island.decide(s.id, false)),
        button("批准", "pri", () => window.island.decide(s.id, true)),
      );
      return [head, span("chip", s.detail), actions];
    }
    case "shot": {
      const head = span("shot-head");
      head.append(thumb(s.image), textCol(s.copied ? "截好了，图片已复制" : "截好了", s.copied ? "可以直接粘贴到聊天软件；也可以在这里问 AI" : "问点什么，或者直接回车让 AI 看看"));
      const input = document.createElement("input");
      input.className = "shot-input";
      input.placeholder = "比如：这个报错是什么意思？";
      input.maxLength = 2000;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) window.island.shotAsk(input.value);
        else if (e.key === "Escape") window.island.shotClose();
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      requestAnimationFrame(() => input.focus());
      const actions = span("actions");
      actions.append(
        button(s.copied ? "只要图片" : "取消", "", () => window.island.shotClose()),
        button("问 AI", "pri", () => window.island.shotAsk(input.value)),
      );
      return [head, input, actions];
    }
    case "shotThinking": {
      const head = span("shot-head");
      head.append(thumb(s.image), textCol("正在看图…", s.question || "让 AI 看看这张截图"), bars(), button("取消", "", () => window.island.shotClose()));
      return [head];
    }
    case "voice": {
      const listening = s.phase === "listening";
      const t = span("timer", elapsed(s.startedAt));
      t.dataset.since = String(s.startedAt);
      const parts: HTMLElement[] = [span(`mic-dot${listening ? " live" : ""}`), span("text", listening ? "在听…" : "正在识别…")];
      if (listening) parts.push(t, button("取消", "", () => window.island.voice("cancel")), button("说完了", "pri", () => window.island.voice("stop")));
      else parts.push(bars());
      return parts;
    }
    case "procs": {
      const head = span("procs-head");
      head.append(textCol("正在运行的进程", s.total ? `共 ${s.total} 个 · 每 3 秒刷新` : "正在读取…"));
      const sorts = span("procs-sort");
      sorts.append(
        button("CPU", s.sort === "cpu" ? "on" : "", () => window.island.procs(true, "cpu")),
        button("内存", s.sort === "mem" ? "on" : "", () => window.island.procs(true, "mem")),
      );
      head.append(sorts, button("关闭", "", () => window.island.procs(false)));
      const list = span("procs-list");
      list.addEventListener("click", (e) => e.stopPropagation());
      for (const p of s.procs) {
        const row = span("proc");
        row.title = `${p.name} · PID ${p.pid}`;
        row.append(span("name", p.name), span("pid", String(p.pid)), span("num", `${p.cpu.toFixed(1)}%`), span("num", fmtMem(p.mem)));
        list.append(row);
      }
      return [head, list];
    }
    case "shotAnswer": {
      const head = span("shot-head");
      head.append(thumb(s.image), textCol(s.question || "AI 看到的", s.model || "识图没有成功"));
      const answer = span("shot-answer", s.answer);
      answer.addEventListener("click", (e) => e.stopPropagation());
      const actions = span("actions");
      const copy = button("复制", "", () => {
        window.island.shotCopy();
        copy.textContent = "已复制";
      });
      actions.append(button("关闭", "", () => window.island.shotClose()), copy);
      if (s.model) actions.append(button("到对话里继续", "pri", () => window.island.shotToChat()));
      return [head, answer, actions];
    }
  }
}

const STATUS: Record<AgentSessionView["status"], string> = { starting: "启动中", working: "在干活", waiting: "等你", idle: "空闲" };

/** The terminal agents, one row each: status light, name, what it's doing, how long. Click to go there. */
function agentList(sessions: AgentSessionView[]): HTMLElement {
  const list = span("agents");
  for (const a of sessions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `agent ${a.status}`;
    row.title = `${a.name} · ${STATUS[a.status]} · ${a.detail}\n点一下切到它的终端`;
    const t = span("timer", elapsed(a.since));
    t.dataset.since = String(a.since);
    row.append(span("light"), span("name", a.name), span("detail", a.detail || STATUS[a.status]), t);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      window.island.focusAgent(a.id);
    });
    list.append(row);
  }
  return list;
}

function fmtMem(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function thumb(src: string): HTMLElement {
  const box = span("thumb");
  const img = document.createElement("img");
  img.src = src;
  img.alt = "截图";
  box.append(img);
  return box;
}

function badge(s: IslandState): HTMLElement | null {
  return s.badge ? span("badge", `+${s.badge}`) : null;
}

/** Capsule layout: one row (the ask card stacks). */
function pillContent(s: IslandState): HTMLElement {
  const box = span(`content pill ${s.kind}${s.kind === "idle" && s.usage ? " usage" : ""}${CARD.has(s.kind) ? " card" : ""}`);
  if (s.kind === "idle") {
    box.append(avatar(s.providerId, s.usage ? 34 : 22), ...(s.usage ? body(s) : [clockEl()]), span("dot"));
  } else if (s.kind === "working") {
    box.append(avatar(s.providerId, 22), ...body(s), bars());
  } else if (s.kind === "cli") {
    if (!hovered) box.append(span("term-icon", "›_"));
    box.append(...body(s));
  } else {
    box.append(...body(s));
  }
  const b = badge(s);
  if (b) box.append(b);
  return box;
}

/** Notch layout: the ears row beside the notch, then the body below it. */
function notchContent(s: IslandState): HTMLElement {
  const box = span(`content notch ${s.kind}`);
  const ears = span("ears");
  ears.style.height = `${layout.top}px`;
  const dot =
    s.kind === "done" ? "dot ok-dot" : s.kind === "error" ? "dot bad-dot" : s.kind === "ask" || s.kind === "question" ? "dot ask-dot" : "dot";
  const right = span("ear-right");
  const b = badge(s);
  if (b) right.append(b);
  // The idle right ear shows the time beside the status light.
  if (s.kind === "idle") right.append(clockEl());
  right.append(s.kind === "working" ? bars() : span(dot));
  ears.append(avatar(s.providerId, 22), right);
  box.append(ears);
  const parts = body(s);
  if (parts.length) {
    const below = span(`body ${s.kind}${CARD.has(s.kind) ? " card" : ""}`);
    below.append(...parts);
    box.append(below);
  }
  return box;
}

const content = (s: IslandState) => (layout.mode === "notch" ? notchContent(s) : pillContent(s));

// ---- state changes ----

function sizeKey(): SizeKey {
  if (current.kind !== "idle") return current.kind;
  if (current.usage) return "usage";
  return hovered ? "hover" : "idle";
}

function applySize(): void {
  const k = sizeKey();
  let [w, h, r] = layout.mode === "notch" ? notchSize(k, layout.top) : PILL[k];
  // The session list grows with the number of sessions.
  if (current.kind === "cli" && hovered) {
    const rows = Math.min(current.sessions.length, 8);
    w = layout.mode === "notch" ? 500 : 420;
    h = (layout.mode === "notch" ? layout.top + 12 : 20) + rows * 34;
    r = 22;
  }
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.borderRadius = layout.mode === "notch" ? `0 0 ${r}px ${r}px` : `${r}px`;
  el.dataset.kind = current.kind;
}

/** States that are cards (stacked content) rather than one row. */
const CARD = new Set<Kind>(["ask", "shot", "shotThinking", "shotAnswer", "procs"]);

/** Same shape, new words (working → working, progress → progress): update in place, no re-entrance. */
function sameShape(a: IslandState, b: IslandState): boolean {
  return a.kind === b.kind && (a.kind === "working" || a.kind === "progress" || a.kind === "procs") && a.badge === b.badge;
}

function show(s: IslandState): void {
  const prev = current;
  current = s;
  applySize();
  if (sameShape(prev, s) && el.firstElementChild) {
    if (s.kind === "working") {
      const t = el.querySelector(".text");
      if (t) t.textContent = s.text;
    } else if (s.kind === "progress") {
      const title = el.querySelector(".title");
      if (title) title.textContent = s.label;
      const pct = el.querySelector(".pct");
      if (pct) pct.textContent = s.pct === null ? "" : `${s.pct}%`;
      const fill = el.querySelector<HTMLElement>(".fill");
      if (fill && s.pct !== null) fill.style.width = `${s.pct}%`;
      el.querySelector(".track")?.classList.toggle("indeterminate", s.pct === null);
    } else if (s.kind === "procs") {
      // New numbers every few seconds: swap the card but keep where the list was scrolled to.
      const top = el.querySelector(".procs-list")?.scrollTop ?? 0;
      const card = content(s);
      card.style.animation = "none"; // no fade-in on every refresh
      el.replaceChildren(card);
      const list = el.querySelector(".procs-list");
      if (list) list.scrollTop = top;
    }
    return;
  }
  el.replaceChildren(content(s));
  // done / error settle back after a while.
  clearTimeout(settleTimer);
  settleLeft = SETTLE_MS[s.kind] ?? 0;
  if (settleLeft && !hovered) startSettle();
  // The CLI timer ticks every second.
  clearInterval(clock);
  if (s.kind === "cli" || s.kind === "voice") {
    clock = window.setInterval(() => {
      const t = el.querySelector<HTMLElement>(".timer");
      if (t?.dataset.since) t.textContent = elapsed(Number(t.dataset.since));
    }, 1000);
  }
}

function startSettle(): void {
  settleStarted = Date.now();
  settleTimer = window.setTimeout(() => window.island.settled(), settleLeft);
}

el.addEventListener("mouseenter", () => {
  hovered = true;
  window.island.hover(true);
  applySize();
  if (current.kind === "cli") el.replaceChildren(content(current));
  if (settleLeft) {
    clearTimeout(settleTimer);
    settleLeft = Math.max(800, settleLeft - (Date.now() - settleStarted));
  }
});
el.addEventListener("mouseleave", () => {
  hovered = false;
  window.island.hover(false);
  applySize();
  if (current.kind === "cli") el.replaceChildren(content(current));
  if (settleLeft && SETTLE_MS[current.kind]) startSettle();
});
// A click on the capsule opens sikeoop; cards (approval, screenshot) only act through their buttons.
el.addEventListener("click", () => {
  if (!CARD.has(current.kind)) window.island.open();
});

// Keep every clock on the island current (checked often so the minute flips on time).
setInterval(() => {
  const t = now();
  for (const c of el.querySelectorAll(".clock")) if (c.textContent !== t) c.textContent = t;
}, 5000);

// ---- voice input: the island page holds the microphone while the main process says "listening" ----

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
/** Stopped because the user finished (upload) rather than cancelled (throw away). */
let sendOnStop = false;

async function startRecording(): Promise<void> {
  if (recorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    // The state may have moved on while the permission prompt was up.
    if (current.kind !== "voice") return stream.getTracks().forEach((t) => t.stop());
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      if (!sendOnStop) return;
      sendOnStop = false;
      const type = (rec.mimeType || "audio/webm").split(";")[0];
      const blob = new Blob(chunks, { type });
      chunks = [];
      // MiMo ASR takes only wav / mp3: re-encode the recording as 16 kHz mono WAV.
      void blob
        .arrayBuffer()
        .then(toWav)
        .then((wav) => window.island.voiceAudio(wav, "audio/wav"))
        .catch(() => window.island.voiceAudio(new ArrayBuffer(0), "", "录音转换失败"));
    };
    recorder = rec;
    rec.start(250);
    // "Stop" arrived before the microphone was ready.
    if (current.kind === "voice" && current.phase === "sending") stopRecording(true);
  } catch (err) {
    window.island.voiceAudio(new ArrayBuffer(0), "", err instanceof DOMException && err.name === "NotAllowedError" ? "没有麦克风权限" : "打不开麦克风");
    // The main process waits in "sending" for this; make sure it is there.
    window.island.voice("stop");
  }
}

function stopRecording(send: boolean): void {
  if (!recorder) return;
  sendOnStop = send;
  if (recorder.state !== "inactive") recorder.stop();
}

/** Follow the main process: record while listening, hand the audio over when it asks, drop it when cancelled. */
function syncRecording(s: IslandState): void {
  if (s.kind === "voice" && s.phase === "listening") void startRecording();
  else if (s.kind === "voice" && s.phase === "sending") stopRecording(true);
  else if (s.kind !== "voice") stopRecording(false);
}

window.island.onState((s) => {
  syncRecording(s);
  show(s);
});
window.island.onLayout((l) => {
  layout = l;
  document.body.dataset.mode = l.mode;
  applySize();
  el.replaceChildren(content(current));
});
applySize();
el.replaceChildren(content(current));
// Drop in once the first frame is painted.
requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("shown")));
