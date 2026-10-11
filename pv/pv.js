// sikeoop PV — 90 seconds, 1920×1080. Everything is a function of time: window.seek(t) lays out
// the frame at t seconds. render.cjs steps through it; the sound cues are listed in window.CUES.
// Cut to "Voxel Revolution" (122 BPM): every scene change sits on a bar line, every click on a beat.
"use strict";

// ---------- helpers ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const P = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, x) => a + (b - a) * x;
const out3 = (x) => 1 - Math.pow(1 - x, 3);
const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const back = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2));
/** 0 → 1 between a and b, back to 0 between c and d. */
const win = (t, a, b, c, d) => out3(P(t, a, b)) * (1 - inOut(P(t, c, d)));

// ---------- beat grid ----------
/** Measured from the track: 122 BPM, first beat 24 ms in. */
const BEAT = 60 / 122;
const PHASE = 0.024;
/** Time of beat n (fractions are fine: 0.5 is the off-beat, 0.25 a sixteenth). */
const bt = (n) => PHASE + n * BEAT;
/** Time of bar k (4 beats a bar). */
const bar = (k) => bt(4 * k);
/** Nearest sixteenth note: sound cues are snapped to it so they play in time with the music. */
const snap = (t) => PHASE + Math.round((t - PHASE) / (BEAT / 4)) * (BEAT / 4);
/** 1 on each beat, decaying quickly: the kick drum, for things that pulse with the music. */
const kick = (t) => Math.exp(-(((t - PHASE) % BEAT + BEAT) % BEAT) * 9);

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function el(tag, cls, html, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.append(e);
  return e;
}

/** Transform + opacity + blur in one go. */
function set(e, { o, x = 0, y = 0, s = 1, r = 0, blur = 0, sx, sy } = {}) {
  if (o !== undefined) e.style.opacity = o;
  e.style.transform = `translate(${x}px, ${y}px) scale(${sx ?? s}, ${sy ?? s}) rotate(${r}deg)`;
  e.style.filter = blur > 0.05 ? `blur(${blur}px)` : "";
}

const GRAD = [[255, 255, 255], [255, 194, 212], [240, 120, 155]];
function gradAt(x) {
  const i = x < 0.5 ? 0 : 1;
  const f = x < 0.5 ? x * 2 : (x - 0.5) * 2;
  return `rgb(${GRAD[i].map((v, k) => Math.round(lerp(v, GRAD[i + 1][k], f))).join(",")})`;
}

/**
 * Splits an element's text into per-character spans, keeping inner elements (a highlighted
 * phrase). Gradient text is coloured character by character: background-clip can't follow
 * characters that move on their own.
 */
function chars(e) {
  const out = [];
  const walk = (node) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        for (const c of n.textContent) {
          const s = el("span", "ch", c === " " ? "&nbsp;" : c.replace(/</g, "&lt;"));
          frag.append(s);
          out.push(s);
        }
        n.replaceWith(frag);
      } else walk(n);
    }
  };
  walk(e);
  const groups = new Map();
  for (const s of out) {
    const g = s.closest(".grad");
    if (g) groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  for (const [g, cs] of groups) {
    g.style.background = "none";
    cs.forEach((s, i) => (s.style.color = gradAt(cs.length > 1 ? i / (cs.length - 1) : 1)));
  }
  return out;
}

/** Characters rise in from a blur, one after another. */
function reveal(cs, t, start, stagger = 0.04, dur = 0.55, dist = 40) {
  cs.forEach((c, i) => {
    const p = out3(P(t, start + i * stagger, start + i * stagger + dur));
    set(c, { o: p, y: (1 - p) * dist, blur: (1 - p) * 14 });
  });
}

const CURSOR = `<svg viewBox="0 0 24 24" width="34" height="34"><path d="M4 2l15 9.5-6.6 1.4 3.9 7.4-3 1.6-3.9-7.5L4 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

/** A mouse pointer that glides between points and clicks. path: [time, x, y][]; clicks: times. */
function pointer(parent) {
  const c = el("div", "cursor-ptr", CURSOR, parent);
  const ring = el("div", "click-ring", undefined, parent);
  return (t, path, clicks = []) => {
    let x = path[0][1], y = path[0][2];
    for (let i = 1; i < path.length; i++) {
      const [t0, x0, y0] = path[i - 1];
      const [t1, x1, y1] = path[i];
      if (t >= t0) {
        const p = inOut(P(t, t0, t1));
        x = lerp(x0, x1, p);
        y = lerp(y0, y1, p);
      }
    }
    let press = 0;
    let ringP = -1;
    for (const ct of clicks) {
      press = Math.max(press, win(t, ct - 0.08, ct, ct + 0.05, ct + 0.18));
      if (t >= ct && t < ct + 0.6) ringP = P(t, ct, ct + 0.6);
    }
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
    set(c, { o: path.length ? 1 : 0, s: 1 - press * 0.15 });
    ring.style.left = `${x + 4}px`;
    ring.style.top = `${y + 4}px`;
    set(ring, { o: ringP < 0 ? 0 : 1 - ringP, s: 0.3 + ringP * 1.4 });
  };
}

const ART = (id) => `assets/art/${id}.webp`;
const CUES = [];
/** While a scene is being built: maps its authored times onto the final timeline. */
let toFinal = (t) => t;
/** A sound at time t (seconds, in the scene's own timing): file in assets/sfx, volume 0–1. */
const cue = (t, file, vol = 0.6) => CUES.push([+snap(toFinal(t)).toFixed(3), file, vol]);

const root = document.getElementById("scenes");
const scenes = [];
/** Piecewise-linear map through [x, y] points, carried on past the ends; no points: unchanged. */
function warp(pts, from, to) {
  return (t) => {
    if (pts.length < 2) return t;
    let k = 1;
    while (k < pts.length - 1 && t > pts[k][from]) k++;
    const p = pts[k - 1], q = pts[k];
    return p[to] + ((t - p[from]) * (q[to] - p[to])) / (q[from] - p[from]);
  };
}

/**
 * A scene lives from a to b on the final timeline, fading in and out over `fade` seconds. Scenes
 * written in their own timing pass `keys`: [scene time, final time] pairs that pin their key
 * moments (a click, a card popping up) onto beats; the time between is stretched to fit.
 */
function scene(a, b, build, { fadeIn = 0.45, fadeOut = 0.45, keys = [] } = {}) {
  const box = el("div", "scene", undefined, root);
  toFinal = warp(keys, 0, 1);
  const update = build(box);
  toFinal = (t) => t;
  scenes.push({ a, b, box, update, fadeIn, fadeOut, map: warp(keys, 1, 0) });
}

// ---------- background ----------
const blobs = [...document.querySelectorAll(".blob")];
const dust = document.getElementById("dust");
const dr = rng(7);
const motes = Array.from({ length: 46 }, () => {
  const m = el("i", "", undefined, dust);
  return { m, x: dr() * 2200, y: dr() * 1300, sp: 8 + dr() * 26, ph: dr() * 6.28, sz: 0.4 + dr() * 0.9 };
});
const grid = document.getElementById("grid");
function background(t) {
  const glow = 0.2 + 0.8 * P(t, bt(11), bar(4));
  // In the drops the light breathes with the kick drum.
  const drop = Math.max(win(t, bar(8) - 0.1, bar(8), bar(30) - 0.5, bar(30)), win(t, bar(40) - 0.1, bar(40), bar(45), bar(46)));
  const k = 1 + 0.35 * kick(t) * drop;
  set(blobs[0], { o: 0.55 * glow * k, x: 300 + Math.sin(t * 0.21) * 260, y: 120 + Math.cos(t * 0.17) * 160 });
  set(blobs[1], { o: 0.45 * glow * k, x: 1250 + Math.cos(t * 0.15) * 300, y: 520 + Math.sin(t * 0.19) * 160 });
  grid.style.opacity = 0.7 + 0.3 * kick(t) * drop;
  set(blobs[2], { o: 0.28 * glow, x: 800 + Math.sin(t * 0.12 + 2) * 400, y: 900 + Math.cos(t * 0.23) * 100 });
  for (const d of motes) {
    const y = ((d.y - t * d.sp) % 1300 + 1300) % 1300;
    d.m.style.left = `${d.x + Math.sin(t * 0.6 + d.ph) * 30}px`;
    d.m.style.top = `${y}px`;
    set(d.m, { o: (0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.3 + d.ph))) * glow, s: d.sz });
  }
}

// ======================================================================
// 1 · Hook (intro, bars 0–3): "写代码，好难。" → "如果，有人陪你一起写呢？"
// ======================================================================
/** How many of `len` characters are typed by t: one every `step` seconds from `start`. */
const typed = (t, start, step, len) => (t < start ? 0 : Math.min(len, Math.floor((t - start) / step + 1e-4) + 1));

scene(0, bar(3) + 0.05, (box) => {
  const c = el("div", "center", undefined, box);
  const line = el("div", "hook-line", `<span class="prompt">›</span><span class="txt"></span><span class="caret"></span>`, c);
  const txt = line.querySelector(".txt");
  const caret = line.querySelector(".caret");
  const L1 = [..."写代码，好难。"];
  const L2 = [..."如果，有人陪你一起写呢？"];
  // The first line plods along in eighths; the second one rushes out in sixteenths.
  const s1 = bt(1), k1 = BEAT / 2, del = [bt(5), bt(5.5)], s2 = bt(6), k2 = BEAT / 4;
  L1.forEach((_, i) => cue(s1 + i * k1, `key${(i % 4) + 1}.ogg`, 0.35));
  L2.forEach((_, i) => cue(s2 + i * k2, `key${(i % 4) + 1}.ogg`, 0.3));
  cue(del[0], "back.ogg", 0.4);
  cue(bt(11), "rise.ogg", 0.7);
  const end1 = s1 + L1.length * k1, end2 = s2 + L2.length * k2;
  return (t) => {
    let s = "";
    let typing = false;
    if (t < del[0]) {
      s = L1.slice(0, typed(t, s1, k1, L1.length)).join("");
      typing = t > s1 && t < end1;
    } else if (t < s2) {
      s = L1.slice(0, Math.ceil((1 - P(t, del[0], del[1])) * L1.length)).join("");
      typing = t < del[1];
    } else {
      s = L2.slice(0, typed(t, s2, k2, L2.length)).join("");
      typing = t < end2;
    }
    txt.textContent = s;
    // Second line: the heart of it, in pink.
    txt.style.color = t >= s2 ? "#ffd3df" : "#fff";
    // The caret blinks on the beat.
    caret.style.opacity = typing || ((t - PHASE) / BEAT) % 1 < 0.5 ? 1 : 0;
    const zoom = P(t, bt(11), bar(3));
    set(line, { s: 1 + inOut(zoom) * 0.35, blur: zoom * 10, o: 1 - zoom });
  };
}, { fadeIn: 0.3, fadeOut: 0.05 });

// ======================================================================
// 2 · Logo (build, bars 3–5): pops on the flash
// ======================================================================
scene(bar(3) - 0.1, bar(5) + 0.1, (box) => {
  const c = el("div", "center", undefined, box);
  const icon = el("div", "logo-icon", `<img src="assets/icon.png" alt="">`, c);
  const rings = [0, 1, 2].map(() => el("div", "ring", undefined, icon));
  const word = el("div", "logo-word grad", "sikeoop", c);
  const tag = el("div", "logo-tag", "给新手的粉色 AI 代码编辑器", c);
  const sub = el("div", "logo-sub", "写代码，有人陪。", c);
  const wc = chars(word), tc = chars(tag), sc = chars(sub);
  cue(7.1, "logo.ogg", 0.8);
  cue(8.0, "glass.ogg", 0.45);
  cue(9.0, "pluck.ogg", 0.5);
  return (t) => {
    const p = back(P(t, 7.05, 7.8));
    set(icon, { s: 0.2 + 0.8 * p, o: P(t, 7.05, 7.3), r: (1 - p) * -18, y: Math.sin(t * 1.6) * 6 });
    rings.forEach((r, i) => {
      const q = P(t, 7.25 + i * 0.28, 8.6 + i * 0.28);
      r.style.width = r.style.height = `${260 + q * 520}px`;
      r.style.opacity = q > 0 && q < 1 ? (1 - q) * 0.8 : 0;
    });
    reveal(wc, t, 7.75, 0.05, 0.6, 60);
    reveal(tc, t, 8.75, 0.035, 0.5);
    reveal(sc, t, 9.7, 0.06, 0.6, 20);
    const exit = inOut(P(t, 12.35, 13));
    set(c, { y: -exit * 80, o: 1 - exit, s: 1 - exit * 0.05 });
  };
}, { fadeIn: 0.05, fadeOut: 0.2, keys: [[7.05, bar(3)], [13, bar(5)]] });

// ======================================================================
// 3 · Partners (bars 5–10): the cards fan out on the build, Claudia steps forward on the drop
// ======================================================================
const CAST = [
  ["anthropic", "克劳迪娅", "Claude"],
  ["openai", "欧小糖", "GPT"],
  ["gemini", "星语", "Gemini"],
  ["deepseek", "深深", "DeepSeek"],
  ["qwen", "千问", "通义千问"],
  ["zhipu", "智智", "智谱 GLM"],
  ["doubao", "小豆包", "豆包"],
  ["minimax", "麦麦", "MiniMax"],
];
scene(bar(5), bar(10) + 0.1, (box) => {
  const title = el("div", "p-title", `<div class="t">每个模型，都是一位 <span class="grad">AI 伙伴</span></div><div class="s">选一个你喜欢的她，陪你从第一行代码写起</div>`, box);
  const tt = chars(title.querySelector(".t"));
  const ts = title.querySelector(".s");
  const cards = CAST.map(([id, nm, model]) => el("div", "card", `<img src="${ART(id)}" alt=""><div class="nm">${nm}<small>${model}</small></div>`, box));
  const say = el("div", "say", "心事和灵感，我都认真听。", box);
  const models = el("div", "models", "<b>Claude</b> · GPT · Gemini · DeepSeek · 通义千问 · Kimi · 智谱 · 豆包 · <b>小米 MiMo</b> · MiniMax · OpenRouter · Ollama 本地模型", box);
  cards.forEach((_, i) => cue(13.6 + i * 0.16, "card.ogg", 0.35));
  cue(18.5, "select.ogg", 0.6);
  cue(19.3, "pop.ogg", 0.5);
  cue(21.7, "card.ogg", 0.4);
  return (t) => {
    reveal(tt, t, 13.2, 0.035, 0.5);
    set(ts, { o: out3(P(t, 13.9, 14.6)), y: (1 - out3(P(t, 13.9, 14.6))) * 16 });
    const focus = win(t, 18.4, 19.2, 21.6, 22.4);
    const drift = Math.sin(t * 0.5) * 0.6;
    cards.forEach((card, i) => {
      const k = i - 3.5;
      const enter = back(P(t, 13.6 + i * 0.16, 14.4 + i * 0.16));
      const exit = inOut(P(t, 24.3 + i * 0.03, 24.95));
      let x = k * 190 + drift * 20, y = Math.abs(k) * Math.abs(k) * 9 + 30, r = k * 5 + drift, s = 1;
      if (i === 0) {
        x = lerp(x, -330, focus); y = lerp(y, 10, focus); r = lerp(r, -3, focus); s = lerp(1, 1.42, focus);
      } else {
        x = lerp(x, x + 420 + k * 40, focus); y = lerp(y, y + 120, focus); s = lerp(1, 0.75, focus);
      }
      card.style.zIndex = i === 0 && focus > 0.05 ? 20 : 10 - Math.abs(Math.round(k));
      set(card, { x, y: y + (1 - enter) * 700 + exit * 500, r: r + (1 - enter) * k * 6, s, o: (i === 0 ? 1 : 1 - focus * 0.55) * (1 - exit) });
    });
    const sp = win(t, 19.2, 19.7, 21.3, 21.7);
    say.style.left = "880px";
    say.style.top = "300px";
    set(say, { o: sp, s: 0.6 + back(P(t, 19.2, 19.7)) * 0.4, y: (1 - sp) * 20 });
    set(models, { o: win(t, 22.3, 23, 24.4, 24.9), y: (1 - out3(P(t, 22.3, 23))) * 20 });
    set(title, { o: 1 - P(t, 24.3, 24.8) });
  };
}, { fadeIn: 0.2, fadeOut: 0.2, keys: [[13, bar(5)], [19.2, bar(8)], [25, bar(10)]] });

// ======================================================================
// 4 · The AI edits, you approve (bars 10–15): approve on beat 50, undo on bar 13
// ======================================================================
scene(bar(10) - 0.1, bar(15) + 0.25, (box) => {
  const w = el("div", "win", undefined, box);
  Object.assign(w.style, { left: "150px", top: "50px", width: "1620px", height: "740px", transformOrigin: "78% 25%" });
  w.innerHTML = `
    <div class="win-bar"><span class="lights"><i></i><i></i><i></i></span><span class="brand">♥ sikeoop</span><span class="dim">/ todo-app</span></div>
    <div class="app">
      <div class="act"><i></i><i class="on"></i><i></i><i></i><i></i></div>
      <div class="tree"><div class="h">资源管理器</div><div>📁 src</div><div class="on">&nbsp;&nbsp;App.tsx</div><div class="newfile new">&nbsp;&nbsp;TodoList.tsx</div><div>&nbsp;&nbsp;main.tsx</div><div>index.html</div><div>package.json</div></div>
      <div class="editor"></div>
      <div class="chat"></div>
    </div>`;
  const editor = w.querySelector(".editor");
  const newFile = w.querySelector(".newfile");
  const CODE = [
    [`<span class="kw">import</span> { useState } <span class="kw">from</span> <span class="str">"react"</span>;`],
    [`<span class="kw">import</span> { TodoList } <span class="kw">from</span> <span class="str">"./TodoList"</span>;`, true],
    [""],
    [`<span class="kw">export function</span> <span class="fn">App</span>() {`],
    [`  <span class="kw">const</span> [todos, setTodos] = <span class="fn">useState</span>&lt;<span class="tag">string</span>[]&gt;([]);`, true],
    [`  <span class="kw">return</span> (`],
    [`    &lt;<span class="tag">main</span> className=<span class="str">"page"</span>&gt;`],
    [`      &lt;<span class="tag">h1</span>&gt;我的待办&lt;/<span class="tag">h1</span>&gt;`],
    [`      &lt;<span class="tag">TodoList</span> items={todos} onAdd={setTodos} /&gt;`, true],
    [`    &lt;/<span class="tag">main</span>&gt;`],
    [`  );`],
    [`}`],
    [""],
    [`<span class="cm">// 粉色的完成按钮，点了会有小爱心 ♥</span>`, true],
  ];
  const lines = CODE.map(([html, added], i) => {
    const ln = el("div", "ln", `<span>${i + 1}</span><span>${html || "&nbsp;"}</span>`, editor);
    return { ln, added: !!added };
  });
  const chat = w.querySelector(".chat");
  const me = el("div", "bubble-me", "帮我做一个待办清单页面，要可爱一点 🌸", chat);
  const head = el("div", "ai-head", `<span class="av"><img src="${ART("anthropic")}" alt=""></span>克劳迪娅`, chat);
  const st1 = el("div", "step", "<i>✓</i>读了 App.tsx 和 index.html", chat);
  const st2 = el("div", "step", "<i>✓</i>想好了：新建 TodoList 组件，再接进页面", chat);
  const card = el("div", "approve", `
    <div class="hd">想修改一个文件<span class="path">src/App.tsx</span></div>
    <div class="df"><div class="p">+ import { TodoList } from "./TodoList";</div><div class="m">- const title = "Hello";</div><div class="p">+ const [todos, setTodos] = useState([]);</div><div class="p">+ &lt;TodoList items={todos} onAdd={setTodos} /&gt;</div></div>
    <div class="ft"><span class="btn">拒绝</span><span class="btn pri ok">批准</span></div>`, chat);
  const okBtn = card.querySelector(".ok");
  const undo = el("div", "undo", "✓ 这一轮改了 2 个文件 <b>↶ 撤销这一轮</b>", chat);
  const cap1 = el("div", "caption", `<div class="k">安全感</div><div class="t">每一处改动，<span class="grad">都先问你</span></div>`, box);
  const cap2 = el("div", "caption", `<div class="k">后悔药</div><div class="t">不满意？<span class="grad">一键撤销整轮</span></div>`, box);
  const cap1c = chars(cap1.querySelector(".t")), cap2c = chars(cap2.querySelector(".t"));
  cap1.style.bottom = cap2.style.bottom = "46px";
  const ptr = pointer(box);
  cue(25.9, "send.ogg", 0.5);
  cue(27.0, "tick.ogg", 0.35);
  cue(27.5, "tick.ogg", 0.35);
  cue(28.1, "tick.ogg", 0.35);
  cue(28.9, "ask.ogg", 0.6);
  cue(31.4, "click.ogg", 0.7);
  cue(31.6, "ok.ogg", 0.5);
  for (let i = 0; i < 4; i++) cue(31.9 + i * 0.22, "tick.ogg", 0.25);
  cue(33.0, "pluck.ogg", 0.45);
  let target = [1500, 700];
  return (t) => {
    const enter = out3(P(t, 25, 26.2));
    const zoom = win(t, 28.6, 29.6, 33.8, 34.8);
    set(w, { s: (0.9 + 0.1 * enter) * (1 + zoom * 0.12), y: (1 - enter) * 60, x: -zoom * 120, o: enter });
    const show = (e, a, d = 0.4) => set(e, { o: out3(P(t, a, a + d)), y: (1 - out3(P(t, a, a + d))) * 18 });
    show(me, 25.8);
    show(head, 26.6);
    show(st1, 27.0);
    show(st2, 27.6);
    // The approval card slides in, then folds to "已批准" after the click.
    const cIn = back(P(t, 28.8, 29.4));
    const folded = inOut(P(t, 31.55, 32));
    set(card, { o: P(t, 28.8, 29.0), y: (1 - cIn) * 40, s: 0.95 + cIn * 0.05 });
    card.style.borderColor = folded > 0.5 ? "rgba(95,211,141,.5)" : "rgba(240,120,155,.45)";
    okBtn.textContent = folded > 0.5 ? "已批准 ✓" : "批准";
    okBtn.style.transform = `scale(${1 - win(t, 31.3, 31.4, 31.45, 31.6) * 0.08})`;
    show(undo, 33.0);
    lines.forEach(({ ln, added }, i) => {
      if (!added) return;
      const p = P(t, 31.9 + (i % 5) * 0.12, 32.4 + (i % 5) * 0.12);
      ln.classList.toggle("add", p > 0);
      ln.style.opacity = p > 0 ? 0.35 + 0.65 * p : 0.25;
    });
    set(newFile, { o: P(t, 32.0, 32.4) });
    // The pointer heads for the approve button wherever the zoom put it.
    const r = okBtn.getBoundingClientRect();
    if (r.width) target = [r.left + r.width / 2 - 6, r.top + r.height / 2 - 6];
    ptr(t, [[29.6, 1700, 980], [30.4, 1700, 980], [31.25, target[0], target[1]], [33.2, target[0] + 40, target[1] + 120]], [31.4]);
    set(box.querySelector(".cursor-ptr"), { o: win(t, 29.7, 30, 32.6, 33.0) });
    set(cap1, { o: win(t, 26.3, 26.7, 32.0, 32.4) });
    reveal(cap1c, t, 26.4, 0.04, 0.45);
    set(cap2, { o: win(t, 32.5, 32.9, 37.3, 37.8) });
    reveal(cap2c, t, 32.6, 0.04, 0.45);
  };
}, { fadeIn: 0.25, fadeOut: 0.3, keys: [[25, bt(40)], [28.9, bt(46)], [31.4, bt(50)], [33, bt(52)], [38, bt(60)]] });

// ======================================================================
// 4b · Editor details (bars 15–19): AI completion taken with Tab, a terminal error handed to the
// AI with 「帮我看看」, its command run with 「▶ 在终端运行」, and a long chat tidied up on its own.
// ======================================================================
/** The [width, height, radius] a shape is at t, easing between [time, w, h, r] keyframes. */
function shape(t, K) {
  let [, w, h, r] = K[0];
  for (let i = 1; i < K.length; i++) {
    if (t < K[i - 1][0]) break;
    const p = inOut(P(t, K[i - 1][0], K[i][0]));
    w = lerp(K[i - 1][1], K[i][1], p); h = lerp(K[i - 1][2], K[i][2], p); r = lerp(K[i - 1][3], K[i][3], p);
  }
  return [w, h, r];
}

scene(bar(15) - 0.15, bar(19) + 0.2, (box) => {
  const w = el("div", "win", undefined, box);
  Object.assign(w.style, { left: "150px", top: "50px", width: "1620px", height: "740px" });
  w.innerHTML = `
    <div class="win-bar"><span class="lights"><i></i><i></i><i></i></span><span class="brand">♥ sikeoop</span><span class="dim">/ todo-app</span></div>
    <div class="app2">
      <div class="tree"><div class="h">资源管理器</div><div>📁 src</div><div>&nbsp;&nbsp;App.tsx</div><div class="on">&nbsp;&nbsp;TodoList.tsx</div><div class="newitem new">&nbsp;&nbsp;TodoItem.tsx</div><div>&nbsp;&nbsp;main.tsx</div><div>index.html</div><div>package.json</div></div>
      <div class="mid">
        <div class="tabs"><span class="on">TodoList.tsx</span><span>App.tsx</span></div>
        <div class="editor"></div>
        <div class="termp">
          <div class="th"><span class="ttab on">● 终端 1</span><span class="ttab">终端 2</span><span class="ttab">＋</span><span class="help">✦ 帮我看看</span></div>
          <div class="tbody"></div>
        </div>
      </div>
      <div class="chat"></div>
    </div>
    <div class="sbar"><span class="bug"></span><span class="ctx">上下文 <i><b></b></i> <em></em></span><span class="mdl">补全 DeepSeek · 对话 Claude</span></div>`;
  const editor = w.querySelector(".editor");
  const term = w.querySelector(".termp");
  const tbody = w.querySelector(".tbody");
  const help = w.querySelector(".help");
  const bug = w.querySelector(".bug");
  const ctxBar = w.querySelector(".ctx b"), ctxPct = w.querySelector(".ctx em");
  const newItem = w.querySelector(".newitem");
  const TYPE = [..."addTodo("];
  const GHOST = [`<span class="kw">text</span>: <span class="tag">string</span>) {`, `    <span class="fn">onAdd</span>([...items, text]);`, `    <span class="fn">setText</span>(<span class="str">""</span>);`, `  }`];
  const CODE = [
    `<span class="kw">import</span> { useState } <span class="kw">from</span> <span class="str">"react"</span>;`,
    `<span class="kw">import</span> { TodoItem } <span class="kw">from</span> <span class="str">"./TodoItem"</span>;`,
    "",
    `<span class="kw">export function</span> <span class="fn">TodoList</span>({ items, onAdd }) {`,
    `  <span class="kw">const</span> [text, setText] = <span class="fn">useState</span>(<span class="str">""</span>);`,
    `  <span class="kw">function</span> <span class="fn typing"></span><span class="ghost g0"></span><span class="caret ed-caret"></span>`,
    `<span class="ghost g1"></span>`,
    `<span class="ghost g2"></span>`,
    `<span class="ghost g3"></span>`,
    `  <span class="kw">return</span> &lt;<span class="tag">ul</span>&gt;{items.<span class="fn">map</span>(<span class="fn">TodoItem</span>)}&lt;/<span class="tag">ul</span>&gt;;`,
    `}`,
  ];
  CODE.forEach((html, i) => el("div", "ln", `<span>${i + 1}</span><span>${html || "&nbsp;"}</span>`, editor));
  const typing = editor.querySelector(".typing");
  const edCaret = editor.querySelector(".ed-caret");
  const ghosts = [0, 1, 2, 3].map((i) => {
    const g = editor.querySelector(`.g${i}`);
    g.innerHTML = GHOST[i];
    return g;
  });
  const ghostLines = ghosts.map((g) => g.closest(".ln"));
  const chip = el("div", "ai-chip", `✦ AI 代码补全<span class="kbd">Tab</span>`, editor);
  const kbd = chip.querySelector(".kbd");
  // Terminal output: [beat it appears, class, text].
  const OUT = [
    [65.5, "u", "npm run dev"],
    [66, "", "  VITE v6.3.5  building…"],
    [66.5, "err", `✘ [ERROR] Could not resolve "./TodoItem"`],
    [67, "dim", "    src/TodoList.tsx:2:26"],
    [72.25, "u", "npm run dev"],
    [72.75, "ok", "  VITE v6.3.5  ready in 312 ms"],
    [73.25, "", "  ➜  Local:   http://localhost:5173/"],
  ].map(([b, cls, text]) => ({ at: bt(b), e: el("div", cls, text, tbody) }));
  const chat = w.querySelector(".chat");
  const old = el("div", "old", "…之前已经聊了 46 轮", chat);
  const me = el("div", "bubble-me", `终端里出现了下面这些输出，帮我看看是什么意思、有没有出错：<code>✘ Could not resolve "./TodoItem"</code>`, chat);
  const head = el("div", "ai-head", `<span class="av"><img src="${ART("anthropic")}" alt=""></span>克劳迪娅`, chat);
  const say = el("div", "ai-say", "少了 <b>TodoItem</b> 这个组件，我先帮你建好了 ✓<br>然后重新启动一下开发服务器：", chat);
  const code = el("div", "codeblk", `<div class="ch2"><span>bash</span><span class="run">▶ 在终端运行</span></div><div class="cb">npm run dev</div>`, chat);
  const run = code.querySelector(".run");
  const toast = el("div", "toast", `<span class="ti">✦</span><span>上下文满了（约 180K），压缩助手把前面的工作整理成了摘要，计划和改过的文件都记着，接着往下做。</span>`, chat);
  const caps = [
    el("div", "caption", `<div class="k">AI 代码补全</div><div class="t">写一半，<span class="grad">Tab 一下就补完</span></div>`, box),
    el("div", "caption", `<div class="k">终端报错</div><div class="t">看不懂？<span class="grad">点「帮我看看」</span></div><div class="s">AI 给的命令，点「▶ 在终端运行」就跑起来</div>`, box),
    el("div", "caption", `<div class="k">长对话</div><div class="t">聊再久，<span class="grad">它都记得</span></div><div class="s">上下文满了，自动整理成摘要，接着往下做</div>`, box),
  ];
  caps.forEach((c) => (c.style.bottom = "46px"));
  const capc = caps.map((c) => chars(c.querySelector(".t")));
  const ptr = pointer(box);
  TYPE.forEach((_, i) => cue(bt(60.5 + i * 0.25), `key${(i % 4) + 1}.ogg`, 0.3));
  cue(bt(62.5), "glass.ogg", 0.35);
  cue(bt(64), "keydown.ogg", 0.55);
  cue(bt(64), "ok.ogg", 0.4);
  cue(bt(65), "drop.ogg", 0.35);
  cue(bt(66.5), "back.ogg", 0.45);
  cue(bt(68), "click.ogg", 0.7);
  cue(bt(68.5), "send.ogg", 0.45);
  cue(bt(69.5), "receive.ogg", 0.5);
  cue(bt(70.5), "pop.ogg", 0.4);
  cue(bt(72), "click.ogg", 0.7);
  cue(bt(72.75), "ok.ogg", 0.5);
  cue(bt(73.5), "pluck.ogg", 0.45);
  let helpAt = [1300, 700], runAt = [1500, 600];
  return (t) => {
    const enter = out3(P(t, bar(15) - 0.15, bar(15) + 0.5));
    set(w, { o: enter, s: 0.96 + 0.04 * enter, y: (1 - enter) * 30 });
    // Completion: type, a grey suggestion appears, Tab takes it.
    typing.textContent = TYPE.slice(0, typed(t, bt(60.5), BEAT / 4, TYPE.length)).join("");
    const gIn = P(t, bt(62.5), bt(63));
    const took = t >= bt(64);
    ghosts.forEach((g) => {
      g.style.opacity = took ? 1 : gIn * 0.42;
      g.classList.toggle("taken", took);
    });
    ghostLines.forEach((l, i) => l.classList.toggle("add", took && t < bt(66) + i * 0.05));
    edCaret.style.opacity = t < bt(64) && ((t - PHASE) / BEAT) % 1 < 0.5 ? 1 : 0;
    chip.style.left = "430px";
    chip.style.top = "112px";
    set(chip, { o: win(t, bt(62.75), bt(63.25), bt(64.5), bt(65)), y: (1 - out3(P(t, bt(62.75), bt(63.25)))) * 8 });
    kbd.style.transform = `translateY(${win(t, bt(63.9), bt(64), bt(64.05), bt(64.25)) * 4}px)`;
    kbd.style.background = t >= bt(64) ? "#f0789b" : "";
    // The terminal slides up and fails; 「帮我看看」 sends it to the chat.
    term.style.height = `${out3(P(t, bt(65), bt(65.75))) * 250}px`;
    OUT.forEach(({ at, e }) => {
      e.style.display = t >= at ? "" : "none";
      set(e, { o: P(t, at, at + 0.12) });
    });
    const failing = t >= bt(66.5) && t < bt(72.75);
    help.classList.toggle("hot", failing);
    help.style.transform = `scale(${1 + (failing ? 0.08 * kick(t) : 0) - win(t, bt(67.9), bt(68), bt(68.05), bt(68.25)) * 0.1})`;
    bug.textContent = t < bt(66.5) ? "✓ 没有报错" : failing ? "🐞 1 个报错 · 帮我看看" : "✓ 没有报错";
    bug.classList.toggle("bad", failing);
    set(newItem, { o: P(t, bt(69.5), bt(70)) });
    const show = (e, b, d = 0.35) => set(e, { o: out3(P(t, bt(b), bt(b) + d)), y: (1 - out3(P(t, bt(b), bt(b) + d))) * 14 });
    set(old, { o: 0.6 });
    show(me, 68.5);
    show(head, 69.5);
    show(say, 70);
    show(code, 70.5);
    run.style.transform = `scale(${1 - win(t, bt(71.9), bt(72), bt(72.05), bt(72.25)) * 0.1})`;
    run.classList.toggle("done", t >= bt(72));
    run.textContent = t >= bt(72) ? "✓ 已发到终端" : "▶ 在终端运行";
    show(toast, 73.5);
    // The context meter empties once the chat is summarised.
    const used = lerp(92, 18, inOut(P(t, bt(73.75), bt(74.75))));
    ctxBar.style.width = `${used}%`;
    ctxBar.style.background = used > 80 ? "#f0b45a" : "#5fd38d";
    ctxPct.textContent = `${Math.round(used)}%`;
    const hr = help.getBoundingClientRect();
    if (hr.width && t < bt(68)) helpAt = [hr.left + hr.width / 2 - 6, hr.top + hr.height / 2 - 6];
    const rr = run.getBoundingClientRect();
    if (rr.width && t < bt(72) && t > bt(70.5)) runAt = [rr.left + rr.width / 2 - 6, rr.top + rr.height / 2 - 6];
    ptr(t, [[bt(66.5), 1000, 980], [bt(66.75), 1000, 980], [bt(67.75), helpAt[0], helpAt[1]], [bt(70.25), helpAt[0], helpAt[1]], [bt(71.75), runAt[0], runAt[1]], [bt(74), runAt[0] + 50, runAt[1] + 140]], [bt(68), bt(72)]);
    set(box.querySelector(".cursor-ptr"), { o: win(t, bt(66.5), bt(66.9), bt(73), bt(73.5)) });
    const capWin = [[59.75, 67.5], [67.75, 73.25], [73.5, 76.5]];
    caps.forEach((c, i) => {
      set(c, { o: win(t, bt(capWin[i][0]), bt(capWin[i][0]) + 0.3, bt(capWin[i][1]) - 0.25, bt(capWin[i][1])) });
      reveal(capc[i], t, bt(capWin[i][0]) + 0.05, 0.035, 0.4);
    });
  };
}, { fadeIn: 0.15, fadeOut: 0.3 });

// ======================================================================
// 5 · Dynamic Island (bars 19–24): every morph on a beat
// ======================================================================
scene(bar(19) - 0.1, bar(24) + 0.25, (box) => {
  const d1 = el("div", "desk-win", `<div class="bar"><span class="lights"><i></i><i></i><i></i></span></div><div class="lines"><i style="width:70%"></i><i style="width:90%"></i><i style="width:55%"></i><i style="width:80%"></i><i style="width:40%"></i></div>`, box);
  Object.assign(d1.style, { left: "220px", top: "330px", width: "700px", height: "420px" });
  const d2 = el("div", "desk-win", `<div class="bar"><span class="lights"><i></i><i></i><i></i></span></div><div class="lines"><i style="width:60%"></i><i style="width:85%"></i><i style="width:75%"></i></div>`, box);
  Object.assign(d2.style, { left: "1000px", top: "400px", width: "640px", height: "340px" });
  const isl = el("div", "island", undefined, box);
  const idle = el("div", "isl", `<span class="av"><img src="${ART("anthropic")}" alt=""></span><span style="margin-left:auto;color:#9a9aa3;font-family:var(--mono)">21:47</span>`, isl);
  const work = el("div", "isl", `<span class="av"><img src="${ART("anthropic")}" alt=""></span><span class="wt">正在改文件 · 已改 1 个</span><span class="bars"><i></i><i></i><i></i><i></i></span>`, isl);
  const wt = work.querySelector(".wt");
  const wbars = [...work.querySelectorAll(".bars i")];
  const ask = el("div", "isl icard", `<div style="display:flex;align-items:center;gap:14px"><span class="av"><img src="${ART("anthropic")}" alt=""></span><span class="col"><span class="a">想运行一条命令</span></span></div><div class="chip">npm install canvas-confetti</div><div class="acts"><span class="btn">拒绝</span><span class="btn pri ok">批准</span></div>`, isl);
  const okBtn = ask.querySelector(".ok");
  const done = el("div", "isl", `<span class="orb ok">✓</span><span class="col"><span class="a">做完了</span><span class="b">改了 3 个文件 · 用时 42 秒</span></span>`, isl);
  const cap = el("div", "caption", `<div class="k">灵动岛</div><div class="t">不用守着窗口，<span class="grad">抬头就知道</span></div><div class="s">AI 在干什么、要你确认什么、做完没有，都在屏幕顶上</div>`, box);
  const capc = chars(cap.querySelector(".t"));
  const ptr = pointer(box);
  cue(38.3, "drop.ogg", 0.5);
  cue(39.8, "morph.ogg", 0.45);
  cue(42.3, "ask.ogg", 0.65);
  cue(44.1, "click.ogg", 0.7);
  cue(44.25, "morph.ogg", 0.4);
  cue(46.3, "done.ogg", 0.7);
  // [time, width, height, radius]: the island morphs between these.
  const K = [[38.3, 260, 64, 32], [39.6, 260, 64, 32], [40.1, 540, 64, 32], [42.0, 540, 64, 32], [42.6, 660, 250, 40], [44.15, 660, 250, 40], [44.6, 540, 64, 32], [46.0, 540, 64, 32], [46.5, 600, 100, 40], [48.8, 600, 100, 40], [49.3, 260, 64, 32]];
  let target = [960, 300];
  return (t) => {
    let [, w, h, r] = K[0];
    for (let i = 1; i < K.length; i++) {
      if (t >= K[i - 1][0]) {
        const p = back(P(t, K[i - 1][0], K[i][0]) * 1) * 0 + inOut(P(t, K[i - 1][0], K[i][0]));
        w = lerp(K[i - 1][1], K[i][1], p); h = lerp(K[i - 1][2], K[i][2], p); r = lerp(K[i - 1][3], K[i][3], p);
      }
    }
    // A little overshoot on every size change: it feels alive.
    isl.style.width = `${w}px`;
    isl.style.height = `${h}px`;
    isl.style.borderRadius = `${r}px`;
    const drop = back(P(t, 38.1, 38.7));
    isl.style.top = `${lerp(-90, 40, drop)}px`;
    const vis = (a, b) => win(t, a, a + 0.3, b, b + 0.2);
    set(idle, { o: Math.max(vis(38.2, 39.55), vis(49.3, 60)) });
    set(work, { o: Math.max(vis(40.0, 42.0), vis(44.5, 45.95)) });
    set(ask, { o: vis(42.45, 44.1), y: (1 - out3(P(t, 42.45, 42.9))) * 10 });
    set(done, { o: vis(46.4, 48.7), s: 0.9 + 0.1 * back(P(t, 46.4, 46.9)) });
    wt.textContent = t < 44 ? `正在改文件 · 已改 ${t < 41 ? 1 : 2} 个` : "正在安装依赖 · 已改 3 个";
    wbars.forEach((b, i) => (b.style.transform = `scaleY(${0.35 + 0.65 * Math.abs(Math.sin(t * 7 + i * 1.3))})`));
    okBtn.style.transform = `scale(${1 - win(t, 44.0, 44.1, 44.12, 44.25) * 0.1})`;
    const rr = okBtn.getBoundingClientRect();
    if (rr.width && t < 44.2) target = [rr.left + rr.width / 2 - 6, rr.top + rr.height / 2 - 6];
    ptr(t, [[42.8, 1300, 760], [43.2, 1300, 760], [43.95, target[0], target[1]], [45.5, target[0] + 60, target[1] + 260]], [44.1]);
    set(box.querySelector(".cursor-ptr"), { o: win(t, 42.8, 43.1, 45.0, 45.4) });
    const dk = out3(P(t, 38, 38.8));
    set(d1, { o: 0.8 * dk, y: (1 - dk) * 30 });
    set(d2, { o: 0.8 * dk, y: (1 - dk) * 40 });
    set(cap, { o: win(t, 39.0, 39.4, 49.3, 49.8) });
    reveal(capc, t, 39.1, 0.04, 0.45);
  };
}, { fadeIn: 0.3, fadeOut: 0.3, keys: [[38, bt(76)], [38.3, bt(77)], [40.1, bt(80)], [42.6, bt(84)], [44.1, bt(86)], [46.5, bt(90)], [50, bt(96)]] });

// ======================================================================
// 5b · Screenshot → ask, then the island's little moves (bars 24–30): ⌘⇧2, drag a box, ask in
// the island, carry the answer to the chat; hover for today's tokens, open the process list;
// on a notched MacBook the island grows out of the notch.
// ======================================================================
scene(bar(24) - 0.1, bar(30) + 0.1, (box) => {
  const page = el("div", "browser glass", `
    <div class="bbar"><span class="lights"><i></i><i></i><i></i></span><span class="url">localhost:5173</span></div>
    <div class="bpage">
      <div class="bh">我的待办 🌸</div>
      <div class="brow"><span class="inp">写点什么…</span><span class="addb">添加</span></div>
      <div class="bitem done">✓ 买草莓</div><div class="bitem">○ 写周报</div><div class="bitem">○ 学一点 React</div>
    </div>`, box);
  Object.assign(page.style, { left: "460px", top: "230px", width: "1000px", height: "560px" });
  const row = page.querySelector(".brow");
  const keys = el("div", "keyrow", `<span class="key k1">⌘</span><span class="key k2">⇧</span><span class="key k3">2</span>`, box);
  const kcs = [...keys.querySelectorAll(".key")];
  const marq = el("div", "marq", `<span class="msz"></span>`, box);
  const msz = marq.querySelector(".msz");
  const xh = el("div", "xhair", `<svg viewBox="0 0 40 40" width="40" height="40"><path d="M20 2v15M20 23v15M2 20h15M23 20h15" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><circle cx="20" cy="20" r="2" fill="#f0789b"/></svg>`, box);
  const snapFlash = el("div", "snapflash", undefined, box);
  // The menu bar of a notched MacBook, for the last bit.
  const menubar = el("div", "menubar", `<span> </span><b>sikeoop</b><span>文件</span><span>编辑</span><span>显示</span><span class="mr">周三 21:48</span>`, box);
  const notch = el("div", "notch", `<i></i>`, box);
  const isl = el("div", "island", undefined, box);
  const AV = `<span class="av"><img src="${ART("anthropic")}" alt=""></span>`;
  const THUMB = `<span class="thumb"><i></i><b></b></span>`;
  const idle = el("div", "isl", `${AV}<span style="margin-left:auto;color:#9a9aa3;font-family:var(--mono)">21:48</span>`, isl);
  const QUESTION = [..."这个按钮为什么歪了？"];
  const shot = el("div", "isl icard", `<div class="shot-head">${THUMB}<span class="col"><span class="a">截好了</span><span class="b">问点什么，或者直接回车让 AI 看看</span></span></div><div class="shot-input"><span class="q"></span><span class="caret" style="height:24px;width:2px;margin-left:2px"></span></div><div class="acts"><span class="btn">取消</span><span class="btn pri">问 AI</span></div>`, isl);
  const q = shot.querySelector(".q");
  const think = el("div", "isl", `${THUMB}<span class="col"><span class="a">正在看图…</span><span class="b">这个按钮为什么歪了？</span></span><span class="bars"><i></i><i></i><i></i><i></i></span>`, isl);
  const tbars = [...think.querySelectorAll(".bars i")];
  const ANSWER = [..."「添加」按钮多了一行 margin-left: 12px，还被 rotate(-4deg) 转歪了。删掉这两行，让它和输入框待在同一个 flex 里，就正了。"];
  const answer = el("div", "isl icard", `<div class="shot-head">${THUMB}<span class="col"><span class="a">这个按钮为什么歪了？</span><span class="b">Claude · 识图</span></span></div><div class="shot-answer"></div><div class="acts"><span class="btn">关闭</span><span class="btn">复制</span><span class="btn pri tochat">到对话里继续</span></div>`, isl);
  const ans = answer.querySelector(".shot-answer");
  const toChat = answer.querySelector(".tochat");
  const hover = el("div", "isl", `${AV}<span class="col"><span class="a">今天 48.2K tokens</span><span class="b">累计 1.3M</span></span><span class="btn ib">🎤</span><span class="btn ib procs-btn">进程</span>`, isl);
  const procsBtn = hover.querySelector(".procs-btn");
  const PROCS = [["node · vite", 4127, "12.4%", "186 MB"], ["claude", 3980, "3.1%", "242 MB"], ["codex", 4012, "2.2%", "158 MB"], ["python3", 3876, "0.8%", "64 MB"], ["esbuild", 4130, "0.4%", "38 MB"], ["sikeoop", 3501, "0.3%", "121 MB"]];
  const procs = el("div", "isl icard", `<div class="procs-head"><span class="col"><span class="a">正在运行的进程</span><span class="b">共 6 个 · 每 3 秒刷新</span></span><span class="sorts"><span class="btn on">CPU</span><span class="btn">内存</span></span><span class="btn close">关闭</span></div><div class="procs-list">${PROCS.map(([n, pid, c, m]) => `<div class="proc"><span class="name">${n}</span><span class="pid">${pid}</span><span class="num">${c}</span><span class="num">${m}</span></div>`).join("")}</div>`, isl);
  const rows = [...procs.querySelectorAll(".proc")];
  const closeBtn = procs.querySelector(".close");
  const notchState = el("div", "isl notched", `${AV}<span class="nm2">克劳迪娅</span><span class="gap"></span><span class="wt2">正在改文件</span><span class="bars"><i></i><i></i><i></i><i></i></span>`, isl);
  const nbars = [...notchState.querySelectorAll(".bars i")];
  const caps = [
    el("div", "caption", `<div class="k">截图问 AI</div><div class="t">框一下，<span class="grad">直接问</span></div><div class="s">⌘⇧2 截图 · 在灵动岛里提问 · 一键带回对话接着聊</div>`, box),
    el("div", "caption", `<div class="k">灵动岛的小动作</div><div class="t">悬停看用量，<span class="grad">点开看进程</span></div><div class="s">今天用了多少 token、电脑上在跑哪些程序，一眼就知道</div>`, box),
    el("div", "caption", `<div class="k">刘海屏</div><div class="t">贴着刘海，<span class="grad">严丝合缝</span></div><div class="s">MacBook 上，灵动岛就长在刘海两边</div>`, box),
  ];
  const capc = caps.map((c) => chars(c.querySelector(".t")));
  const ptr = pointer(box);
  cue(bt(96), "keydown.ogg", 0.6);
  cue(bt(97), "select.ogg", 0.4);
  cue(bt(100), "glass.ogg", 0.6);
  cue(bt(100.5), "morph.ogg", 0.4);
  QUESTION.forEach((_, i) => cue(bt(100.75 + i * 0.25), `key${(i % 4) + 1}.ogg`, 0.25));
  cue(bt(103.25), "send.ogg", 0.5);
  cue(bt(104.5), "receive.ogg", 0.55);
  cue(bt(107.5), "click.ogg", 0.7);
  cue(bt(107.75), "morph.ogg", 0.35);
  cue(bt(109.5), "pop.ogg", 0.45);
  cue(bt(112), "click.ogg", 0.7);
  cue(bt(112.5), "morph.ogg", 0.4);
  rows.forEach((_, i) => cue(bt(112.75 + i * 0.25), "tick.ogg", 0.22));
  cue(bt(115.5), "click.ogg", 0.6);
  cue(bt(116.5), "drop.ogg", 0.5);
  cue(bt(118), "pluck.ogg", 0.45);
  // [time, width, height, radius] the island morphs through.
  const K = [[bt(96), 260, 64, 32], [bt(100.25), 260, 64, 32], [bt(101), 480, 196, 26], [bt(103.25), 480, 196, 26], [bt(103.75), 480, 108, 26],
    [bt(104.5), 480, 108, 26], [bt(105.1), 520, 330, 28], [bt(107.75), 520, 330, 28], [bt(108.4), 260, 64, 32], [bt(109.5), 260, 64, 32],
    [bt(110), 560, 76, 38], [bt(112.25), 560, 76, 38], [bt(112.9), 600, 370, 28], [bt(115.6), 600, 370, 28], [bt(116.2), 260, 64, 32],
    [bt(116.5), 260, 64, 32], [bt(117.1), 620, 40, 20]];
  let rect = [700, 330, 1220, 520];
  let target = { chat: [1300, 500], hover: [960, 70], procs: [1200, 70], close: [1200, 100] };
  return (t) => {
    // The page being looked at.
    const pIn = out3(P(t, bar(24) - 0.1, bar(24) + 0.4));
    set(page, { o: pIn * lerp(1, 0.35, P(t, bt(107.75), bt(108.5))) * (1 - P(t, bt(116), bt(116.5)) * 0.6), y: (1 - pIn) * 30 });
    // ⌘⇧2, pressed together on the downbeat.
    set(keys, { o: win(t, bt(95.5), bt(95.9), bt(97.25), bt(97.75)), y: (1 - out3(P(t, bt(95.5), bt(95.9)))) * 20 });
    const press = win(t, bt(95.9), bt(96), bt(96.2), bt(96.5));
    kcs.forEach((k) => {
      k.style.transform = `translateY(${press * 8}px)`;
      k.style.borderColor = press > 0.5 ? "#f0789b" : "#4a4a54";
      k.style.boxShadow = `0 ${10 - press * 8}px 0 #17171b, 0 20px 30px rgba(0,0,0,.5)${press > 0.5 ? ", 0 0 40px rgba(240,120,155,.6)" : ""}`;
    });
    // Drag a box around the crooked button.
    const rr = row.getBoundingClientRect();
    if (rr.width && t < bt(97)) rect = [rr.left - 26, rr.top - 22, rr.right + 26, rr.bottom + 22];
    const drag = inOut(P(t, bt(97), bt(99.5)));
    const x1 = lerp(rect[0] + 4, rect[2], drag), y1 = lerp(rect[1] + 4, rect[3], drag);
    const mOn = t >= bt(96.5) && t < bt(100.15);
    Object.assign(marq.style, { left: `${rect[0]}px`, top: `${rect[1]}px`, width: `${x1 - rect[0]}px`, height: `${y1 - rect[1]}px` });
    marq.style.boxShadow = `0 0 0 4000px rgba(0,0,0,${0.5 * P(t, bt(96.25), bt(96.75))})`;
    set(marq, { o: mOn ? 1 : 0 });
    marq.style.borderColor = t >= bt(97) ? "#fff" : "transparent";
    msz.textContent = `${Math.round(x1 - rect[0])} × ${Math.round(y1 - rect[1])}`;
    xh.style.left = `${x1 - 20}px`;
    xh.style.top = `${y1 - 20}px`;
    set(xh, { o: win(t, bt(96.5), bt(96.9), bt(100), bt(100.15)) });
    Object.assign(snapFlash.style, { left: `${rect[0]}px`, top: `${rect[1]}px`, width: `${rect[2] - rect[0]}px`, height: `${rect[3] - rect[1]}px` });
    set(snapFlash, { o: win(t, bt(99.95), bt(100), bt(100.05), bt(100.6)) * 0.85, s: 1 + 0.06 * P(t, bt(100), bt(100.6)) });
    // The island: shape, place, and which face is showing.
    const [w, h, r] = shape(t, K);
    const nt = inOut(P(t, bt(116.5), bt(117.1)));
    Object.assign(isl.style, { width: `${w}px`, height: `${h}px`, top: `${lerp(40, 0, nt)}px`, borderRadius: `${r * (1 - nt)}px ${r * (1 - nt)}px ${r}px ${r}px` });
    const vis = (a, b) => win(t, bt(a), bt(a) + 0.2, bt(b), bt(b) + 0.12);
    set(idle, { o: Math.max(vis(95, 100.2), vis(108.3, 109.6), vis(116.1, 116.5)) });
    set(shot, { o: vis(100.75, 103.2), y: (1 - out3(P(t, bt(100.75), bt(101.2)))) * 10 });
    q.textContent = QUESTION.slice(0, typed(t, bt(100.75), BEAT / 4, QUESTION.length)).join("");
    set(think, { o: vis(103.6, 104.45) });
    tbars.forEach((b, i) => (b.style.transform = `scaleY(${0.35 + 0.65 * Math.abs(Math.sin(t * 7 + i * 1.3))})`));
    set(answer, { o: vis(104.9, 107.7) });
    ans.textContent = ANSWER.slice(0, typed(t, bt(105), BEAT / 24, ANSWER.length)).join("");
    toChat.style.transform = `scale(${1 - win(t, bt(107.4), bt(107.5), bt(107.55), bt(107.75)) * 0.1})`;
    set(hover, { o: vis(109.9, 112.2) });
    set(procs, { o: vis(112.8, 115.55) });
    rows.forEach((row, i) => set(row, { o: P(t, bt(112.75 + i * 0.25), bt(112.75 + i * 0.25) + 0.15), x: (1 - out3(P(t, bt(112.75 + i * 0.25), bt(112.75 + i * 0.25) + 0.25))) * 16 }));
    procsBtn.style.transform = `scale(${1 - win(t, bt(111.9), bt(112), bt(112.05), bt(112.25)) * 0.12})`;
    set(notchState, { o: vis(117, 130) });
    nbars.forEach((b, i) => (b.style.transform = `scaleY(${0.35 + 0.65 * Math.abs(Math.sin(t * 7 + i * 1.3))})`));
    // The MacBook's menu bar and notch come in for the last bit.
    const mb = out3(P(t, bt(116), bt(116.6)));
    set(menubar, { o: mb, y: (1 - mb) * -36 });
    set(notch, { o: mb });
    // The pointer: the answer card's button, then hover, 进程, 关闭.
    const at = (e, key, until) => {
      const b = e.getBoundingClientRect();
      if (b.width && t < until) target[key] = [b.left + b.width / 2 - 6, b.top + b.height / 2 - 6];
    };
    at(toChat, "chat", bt(107.5));
    at(procsBtn, "procs", bt(112));
    at(closeBtn, "close", bt(115.5));
    target.hover = [960 + 40, 60];
    ptr(t, [[bt(105.5), 1400, 760], [bt(105.75), 1400, 760], [bt(107.25), ...target.chat], [bt(108.25), ...target.chat], [bt(109.25), ...target.hover], [bt(110.5), ...target.hover],
      [bt(111.75), ...target.procs], [bt(114.25), ...target.procs], [bt(115.25), ...target.close], [bt(117), target.close[0] + 40, target.close[1] + 220]], [bt(107.5), bt(112), bt(115.5)]);
    set(box.querySelector(".cursor-ptr"), { o: win(t, bt(105.5), bt(105.9), bt(116), bt(116.5)) });
    const capWin = [[96.25, 107.75], [108.25, 115.75], [116.25, 120.5]];
    caps.forEach((c, i) => {
      set(c, { o: win(t, bt(capWin[i][0]), bt(capWin[i][0]) + 0.3, bt(capWin[i][1]) - 0.25, bt(capWin[i][1])) });
      reveal(capc[i], t, bt(capWin[i][0]) + 0.05, 0.035, 0.4);
    });
  };
}, { fadeIn: 0.2, fadeOut: 0.3 });

// ======================================================================
// 6 · Voice input anywhere (bars 30–35): the key comes up as the breakdown starts
// ======================================================================
scene(bar(30) - 0.1, bar(35) + 0.1, (box) => {
  const cap = el("div", "caption", `<div class="k">随处语音输入</div><div class="t">按住说话，<span class="grad">松开就打字</span></div><div class="s">任何软件的输入框都行 · 小米 MiMo 语音识别</div>`, box);
  Object.assign(cap.style, { top: "90px", bottom: "auto" });
  const capc = chars(cap.querySelector(".t"));
  const notes = el("div", "win notes glass", `<div class="title">📝 随便哪个 App</div><div class="field"><span class="ph">输入点什么…</span><span class="typed"></span><span class="caret" style="height:40px;width:3px;vertical-align:middle;margin-left:4px"></span></div>`, box);
  Object.assign(notes.style, { top: "390px", height: "330px" });
  const field = notes.querySelector(".field");
  const ph = notes.querySelector(".ph");
  const typed = notes.querySelector(".typed");
  const caret = notes.querySelector(".caret");
  const bubble = el("div", "vbubble", `<span class="dot"></span><span class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="vt">在听…松开就输入</span>`, box);
  const vt = bubble.querySelector(".vt");
  const waves = [...bubble.querySelectorAll(".wave i")];
  const kc = el("div", "keycap", `<span>按住</span><span class="key">右 Ctrl</span><span>说话</span>`, box);
  const key = kc.querySelector(".key");
  const ptr = pointer(box);
  const SAID = "把首页的按钮改成粉色，再圆一点 ✨";
  const wr = rng(3);
  const levels = Array.from({ length: 400 }, () => wr());
  cue(51.2, "keydown.ogg", 0.6);
  cue(51.45, "pop.ogg", 0.5);
  cue(54.6, "keyup.ogg", 0.6);
  cue(55.45, "ok.ogg", 0.45);
  [...SAID].forEach((_, i) => i % 2 === 0 && cue(lerp(55.5, 57.4, i / SAID.length), `key${(i % 4) + 1}.ogg`, 0.25));
  return (t) => {
    set(cap, { o: win(t, 50.2, 50.6, 60.4, 60.9) });
    reveal(capc, t, 50.3, 0.04, 0.45);
    const nIn = out3(P(t, 50.1, 50.8));
    set(notes, { o: nIn, y: (1 - nIn) * 40 });
    field.classList.toggle("focus", t > 50.9);
    const n = Math.floor(P(t, 55.5, 57.5) * [...SAID].length + 0.0001);
    typed.textContent = [...SAID].slice(0, n).join("");
    ph.style.display = n ? "none" : "";
    caret.style.opacity = t > 50.9 && ((t % 1) < 0.55 || (t > 55.5 && t < 57.5)) ? 1 : 0;
    // The key goes down while held.
    const held = win(t, 51.1, 51.25, 54.5, 54.65);
    set(kc, { o: win(t, 50.5, 50.9, 58.6, 59.1) });
    key.style.transform = `translateY(${held * 8}px)`;
    key.style.boxShadow = `0 ${10 - held * 8}px 0 #17171b, 0 20px 30px rgba(0,0,0,.5)${held > 0.5 ? ", 0 0 40px rgba(240,120,155,.6)" : ""}`;
    key.style.borderColor = held > 0.5 ? "#f0789b" : "#4a4a54";
    // The bubble pops up by the pointer, listens, transcribes, and goes.
    const px = 1180, py = 560;
    bubble.style.left = `${px + 30}px`;
    bubble.style.top = `${py + 40}px`;
    const bv = win(t, 51.45, 51.8, 55.3, 55.5);
    set(bubble, { o: bv, s: 0.7 + 0.3 * back(P(t, 51.45, 51.85)) });
    const listening = t < 54.6;
    vt.textContent = listening ? "在听…松开就输入" : "正在识别…";
    waves.forEach((w, i) => {
      const lv = listening ? 0.2 + 0.8 * levels[Math.floor(t * 14) % 400] * (0.6 + 0.4 * Math.sin(i * 0.9 + t * 9)) : 0.35 + 0.4 * Math.abs(Math.sin(t * 6 + i * 0.6));
      w.style.transform = `scaleY(${Math.max(0.15, lv)})`;
      w.style.background = listening ? "#f0789b" : "rgba(255,255,255,.6)";
    });
    ptr(t, [[50.5, 1400, 900], [50.9, px, py]], []);
    set(box.querySelector(".cursor-ptr"), { o: win(t, 50.5, 50.8, 60.3, 60.8) });
  };
}, { fadeIn: 0.3, fadeOut: 0.25, keys: [[50, bt(120)], [51.2, bt(122)], [54.6, bt(128)], [55.5, bt(130)], [57.5, bt(134)], [61, bt(140)]] });

// ======================================================================
// 7 · Claude Code × Codex team up (bars 35–40): the reply lands on the riser before the second drop
// ======================================================================
scene(bar(35), bar(40) + 0.05, (box) => {
  const mk = (left, name, who) => {
    const tm = el("div", "term", `<div class="tb"><span class="st"></span>${name}<span class="who">${who}</span></div><div class="body"></div>`, box);
    tm.style.left = `${left}px`;
    return { tm, body: tm.querySelector(".body"), st: tm.querySelector(".st") };
  };
  const A = mk(150, "Claude-1", "Claude Code");
  const B = mk(970, "Codex-1", "Codex");
  const line = (term, at, cls, text, typeDur = 0) => ({ e: el("div", cls, "", term.body), at, text, typeDur });
  const L = [
    line(A, 61.8, "u", "登录页写好了，让 Codex-1 帮我 review 一下", 1.3),
    line(A, 63.5, "tool", "sikeoop · list_peers"),
    line(A, 64.0, "ok", "Codex-1（Codex）· 空闲"),
    line(A, 64.5, "tool", "sikeoop · send_to → Codex-1"),
    line(B, 65.9, "msg", "[来自 Claude-1 的消息] 帮我 review src/login.tsx"),
    line(B, 66.6, "tool", "Read src/login.tsx"),
    line(B, 67.2, "tool", "Search \"password\""),
    line(B, 67.8, "", "发现 2 个问题：密码没校验长度；登录失败的提示会暴露账号是否存在。", 0.9),
    line(B, 68.9, "tool", "sikeoop · send_to → Claude-1"),
    line(A, 70.2, "msg", "[来自 Codex-1 的消息] 发现 2 个问题…"),
    line(A, 70.9, "tool", "Edit src/login.tsx"),
    line(A, 71.6, "ok", "✓ 两处都改好了，谢谢 Codex-1"),
  ];
  const pk1 = el("div", "packet", "✉ 帮我 review src/login.tsx", box);
  const pk2 = el("div", "packet", "✉ 发现 2 个问题", box);
  const isl = el("div", "island agents-isl", `
    <div class="row"><span class="lt a"></span><span class="nm">Claude-1</span><span class="dt da"></span><span class="tm">00:12</span></div>
    <div class="row"><span class="lt b"></span><span class="nm">Codex-1</span><span class="dt db"></span><span class="tm">00:04</span></div>`, box);
  Object.assign(isl.style, { width: "620px", height: "112px", padding: "8px 0", top: "60px" });
  const la = isl.querySelector(".lt.a"), lb = isl.querySelector(".lt.b"), da = isl.querySelector(".da"), db = isl.querySelector(".db");
  const cap = el("div", "caption", `<div class="t" style="font-size:56px">Claude Code × Codex，<span class="grad">在 sikeoop 里组队干活</span></div>`, box);
  Object.assign(cap.style, { bottom: "70px", left: "0", right: "0", textAlign: "center" });
  const capc = chars(cap.querySelector(".t"));
  L.forEach((l) => cue(l.at, l.cls === "msg" ? "receive.ogg" : "tick.ogg", l.cls === "msg" ? 0.6 : 0.25));
  cue(64.8, "send.ogg", 0.6);
  cue(69.1, "send.ogg", 0.6);
  cue(71.6, "done.ogg", 0.5);
  const lights = { working: ["#5fd38d", "0 0 10px #5fd38d"], idle: ["#82a8f5", "none"] };
  const light = (e, s) => ((e.style.background = lights[s][0]), (e.style.boxShadow = lights[s][1]));
  return (t) => {
    const ein = out3(P(t, 61, 61.8));
    set(A.tm, { o: ein, x: (1 - ein) * -80 });
    set(B.tm, { o: ein, x: (1 - ein) * 80 });
    for (const l of L) {
      const p = P(t, l.at, l.at + 0.25);
      l.e.style.display = t >= l.at ? "" : "none";
      set(l.e, { o: p, y: (1 - out3(p)) * 10 });
      const n = l.typeDur ? Math.floor(P(t, l.at, l.at + l.typeDur) * [...l.text].length + 0.0001) : [...l.text].length;
      l.e.textContent = [...l.text].slice(0, n).join("");
    }
    // Messages fly across between the two terminals.
    const fly = (pk, a, b, x0, x1) => {
      const p = inOut(P(t, a, b));
      pk.style.left = `${lerp(x0, x1, p)}px`;
      pk.style.top = `${560 - Math.sin(p * Math.PI) * 140}px`;
      set(pk, { o: win(t, a, a + 0.15, b - 0.1, b + 0.1), s: 0.8 + Math.sin(p * Math.PI) * 0.35 });
    };
    fly(pk1, 64.8, 65.9, 520, 1220);
    fly(pk2, 69.1, 70.2, 1300, 560);
    const aWork = t < 64.9 || t > 70.2 && t < 71.7;
    const bWork = t > 65.9 && t < 69.2;
    light(la, aWork ? "working" : "idle");
    light(lb, bWork ? "working" : "idle");
    light(A.st, aWork ? "working" : "idle");
    light(B.st, bWork ? "working" : "idle");
    da.textContent = t < 64.9 ? "sikeoop · send_to" : t < 70.2 ? "等 Codex-1 回复" : t < 71.7 ? "Edit src/login.tsx" : "两处都改好了";
    db.textContent = t < 65.9 ? "空闲" : t < 69.2 ? "Read src/login.tsx" : "review 完成";
    const ii = back(P(t, 61.4, 62));
    isl.style.top = `${lerp(-130, 60, ii)}px`;
    set(cap, { o: win(t, 62.2, 62.6, 74.3, 74.8) });
    reveal(capc, t, 62.3, 0.03, 0.45);
  };
}, { fadeIn: 0.25, fadeOut: 0.15, keys: [[61, bt(140)], [64.8, bt(146)], [65.9, bt(148)], [70.2, bt(156)], [71.6, bt(158)], [75, bt(160)]] });

// ======================================================================
// 8 · Partners and the little touches (second drop, bars 40–43): a group chat of AIs argues a
// plan out, the conclusion goes to the Agent with one click; sounds, a home, a hidden letter.
// ======================================================================
scene(bar(40) - 0.05, bar(43) + 0.05, (box) => {
  const g = el("div", "group glass", `
    <div class="gh"><span class="gt">Agent 群聊</span><span class="gs">登录页怎么做更安全？</span><span class="gav">${["anthropic", "deepseek", "qwen", "openai"].map((id) => `<span class="av"><img src="${ART(id)}" alt=""></span>`).join("")}</span></div>
    <div class="gbody"></div>
    <div class="gft"><span class="gsum">结论 · 3 条　群成员只看代码不动手</span><span class="btn pri go">交给 Agent 去做 →</span></div>`, box);
  Object.assign(g.style, { left: "140px", top: "110px", width: "1000px", height: "660px" });
  const body = g.querySelector(".gbody");
  const MSGS = [
    [160.5, "anthropic", "克劳迪娅", "密码至少 8 位，前端后端都要校验。"],
    [161.5, "deepseek", "深深", "登录失败统一说「账号或密码不对」，别暴露账号存不存在。"],
    [162.5, "qwen", "千问", "再加一条：连续输错 5 次，锁 10 分钟～"],
    [163.5, "openai", "欧小糖", "同意！我整理成 3 条结论了 ✓"],
  ].map(([b, id, nm, text]) => ({ at: bt(b), e: el("div", "gmsg", `<span class="av"><img src="${ART(id)}" alt=""></span><div><div class="gn">${nm}</div><div class="gx">${text}</div></div>`, body) }));
  const ft = g.querySelector(".gft");
  const go = g.querySelector(".go");
  const card = el("div", "card vibe-card", `<img src="${ART("doubao")}" alt=""><div class="nm">小豆包<small>豆包</small></div>`, box);
  const bubble = el("div", "say", "今天也辛苦啦～ 🌸", box);
  const chips = ["🔊 每个动作，都有小音效", "🏠 首页是伙伴们的小房间", "💌 还藏着一封彩蛋信…"].map((s) => el("div", "vchip glass", s, box));
  const isl = el("div", "island", `<div class="isl">${`<span class="av"><img src="${ART("anthropic")}" alt=""></span>`}<span class="wt">按群聊结论改 · 已改 1 个</span><span class="bars"><i></i><i></i><i></i><i></i></span></div>`, box);
  const ibars = [...isl.querySelectorAll(".bars i")];
  const cap = el("div", "caption", `<div class="t" style="font-size:54px">一个人写代码，<span class="grad">也有一群伙伴</span></div>`, box);
  Object.assign(cap.style, { bottom: "56px", left: "0", right: "0", textAlign: "center" });
  const capc = chars(cap.querySelector(".t"));
  const ptr = pointer(box);
  MSGS.forEach(({ at }) => cue(at, "receive.ogg", 0.45));
  cue(bt(164.5), "pop.ogg", 0.4);
  cue(bt(165), "card.ogg", 0.45);
  cue(bt(165.5), "pluck.ogg", 0.4);
  chips.forEach((_, i) => cue(bt(166 + i * 0.5), "pop.ogg", 0.35));
  cue(bt(168), "click.ogg", 0.7);
  cue(bt(168.5), "done.ogg", 0.5);
  let goAt = [900, 700];
  return (t) => {
    const gIn = out3(P(t, bar(40) - 0.05, bar(40) + 0.35));
    const out = inOut(P(t, bt(171), bt(172)));
    set(g, { o: gIn * (1 - out), x: (1 - gIn) * -60, s: 1 - out * 0.04 });
    MSGS.forEach(({ at, e }) => {
      e.style.display = t >= at ? "" : "none";
      const p = back(P(t, at, at + 0.35));
      set(e, { o: P(t, at, at + 0.15), s: 0.85 + 0.15 * p, y: (1 - p) * 16 });
    });
    set(ft, { o: out3(P(t, bt(164.5), bt(165))) });
    go.style.transform = `scale(${1 + (t > bt(164.5) && t < bt(168) ? 0.06 * kick(t) : 0) - win(t, bt(167.9), bt(168), bt(168.05), bt(168.25)) * 0.1})`;
    go.textContent = t >= bt(168) ? "已交给 Agent ✓" : "交给 Agent 去做 →";
    // The partner on the right, her bubble, and the little touches.
    const cIn = back(P(t, bt(165), bt(165.6)));
    card.style.left = "1460px";
    card.style.top = "48%";
    set(card, { o: P(t, bt(165), bt(165.2)) * (1 - out), x: (1 - cIn) * 300, r: 5 - (1 - cIn) * 10, s: 0.9 + Math.sin(t * 2) * 0.01 });
    card.style.zIndex = 5;
    Object.assign(bubble.style, { left: "1290px", top: "150px", zIndex: 6 });
    set(bubble, { o: win(t, bt(165.5), bt(166), bt(171), bt(172)), s: 0.6 + 0.4 * back(P(t, bt(165.5), bt(166))) });
    chips.forEach((c, i) => {
      Object.assign(c.style, { left: "1240px", top: `${700 + i * 70}px` });
      const p = back(P(t, bt(166 + i * 0.5), bt(166.4 + i * 0.5)));
      set(c, { o: P(t, bt(166 + i * 0.5), bt(166.15 + i * 0.5)) * (1 - out), x: (1 - p) * 40, s: 0.9 + 0.1 * p });
    });
    // After the click the island picks up the work.
    const ii = back(P(t, bt(168.5), bt(169.1)));
    Object.assign(isl.style, { width: "520px", height: "64px", top: `${lerp(-90, 30, ii)}px` });
    ibars.forEach((b, i) => (b.style.transform = `scaleY(${0.35 + 0.65 * Math.abs(Math.sin(t * 7 + i * 1.3))})`));
    set(isl.firstElementChild, { o: 1 });
    const gr = go.getBoundingClientRect();
    if (gr.width && t < bt(168)) goAt = [gr.left + gr.width / 2 - 6, gr.top + gr.height / 2 - 6];
    ptr(t, [[bt(166), 1150, 980], [bt(166.25), 1150, 980], [bt(167.75), goAt[0], goAt[1]], [bt(170), goAt[0] + 40, goAt[1] + 160]], [bt(168)]);
    set(box.querySelector(".cursor-ptr"), { o: win(t, bt(166), bt(166.4), bt(169.5), bt(170)) });
    set(cap, { o: win(t, bt(160.5), bt(161), bt(171), bt(171.75)) });
    reveal(capc, t, bt(160.5), 0.035, 0.4);
  };
}, { fadeIn: 0.05, fadeOut: 0.15 });

// ======================================================================
// 9 · End card (bar 43 – 90 s)
// ======================================================================
scene(bar(43) - 0.05, 90.1, (box) => {
  const c = el("div", "center", undefined, box);
  const icon = el("div", "logo-icon", `<img src="assets/icon.png" alt="">`, c);
  icon.style.width = icon.style.height = "200px";
  const word = el("div", "end-word grad", "sikeoop", c);
  const tag = el("div", "end-tag", "写代码，有人陪。", c);
  const plat = el("div", "end-plat", "<span> macOS</span><span>⊞ Windows</span>", c);
  el("div", "credit", "Music: “Voxel Revolution” by Kevin MacLeod (incompetech.com) · Licensed under CC BY 4.0<br>Sound effects: Kenney (kenney.nl) · CC0", box);
  const wc = chars(word), tgc = chars(tag);
  cue(83.1, "logo.ogg", 0.7);
  cue(84.6, "glass.ogg", 0.4);
  return (t) => {
    const p = back(P(t, 83.1, 83.8));
    set(icon, { s: 0.3 + 0.7 * p, o: P(t, 83.1, 83.3), y: Math.sin(t * 1.5) * 6 });
    reveal(wc, t, 83.6, 0.05, 0.6, 50);
    reveal(tgc, t, 84.5, 0.08, 0.6);
    set(plat, { o: out3(P(t, 85.4, 86)), y: (1 - out3(P(t, 85.4, 86))) * 20 });
  };
}, { fadeIn: 0.05, fadeOut: 0.01, keys: [[83.1, bar(43)], [90.1, bar(43) + 7]] });

// ---------- timeline ----------
const stage = document.getElementById("stage");
const FLASHES = [[bar(3), 0.75], [bar(8), 0.3], [bar(40), 0.4], [bar(43), 0.45]];
const flash = document.getElementById("flash");
window.CUES = CUES;
const stamp = document.getElementById("stamp");
window.seek = (t, frame = 0) => {
  // Frame number in the top-left pixel: render.cjs waits until it sees it.
  stamp.style.background = `rgb(${frame & 255}, ${(frame >> 8) & 255}, 77)`;
  background(t);
  for (const s of scenes) {
    const on = t >= s.a && t <= s.b;
    s.box.style.display = on ? "" : "none";
    if (!on) continue;
    s.box.style.opacity = Math.min(P(t, s.a, s.a + s.fadeIn), 1 - P(t, s.b - s.fadeOut, s.b));
    s.update(s.map(t));
  }
  // Pink flashes on the big hits: hook → logo, both drops, the end card. Then fade to black.
  flash.style.opacity = Math.max(...FLASHES.map(([at, k]) => win(t, at - 0.12, at, at + 0.04, at + 0.55) * k));
  stage.style.opacity = Math.min(P(t, 0, 0.6), 1 - P(t, 89, 90));
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
};
window.ready = Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => document.fonts.ready).then(() => window.seek(0));
