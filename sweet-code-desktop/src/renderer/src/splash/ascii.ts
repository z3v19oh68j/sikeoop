// The opening shot, told in characters (Canvas 2D):
//   1. boot log      a few lines typed fast in the corner: memory, model, the whale waking up
//   2. gather        code glyphs flicker across the screen; hundreds fly in, scrambling as they go,
//                    and land as the sikeoop heart, denser and brighter toward its core
//   3. hold          the heart beats once, a scanline sweeps it, two red/cyan glitch frames;
//                    "sikeoop" decodes letter by letter under it, then the tagline types out
//   4. scatter       the characters burst outward and fade, and the app comes up
// render(t) is a pure function of t (all randomness is drawn once up front), so a frame can be
// held for inspection and nothing drifts with the frame rate.

export const SHOT = { end: 2.1 };

const BG = "#07070b";
const NOISE = "rgba(240, 120, 155, 0.16)";
const DIM = "#6f6c78";
const OK = "#7fdca3";
const PINK = [240, 120, 155];
const CORE = [255, 226, 236];
const GLYPHS = "{}[]()<>/\\=+-*;:.,_|~^#$%&@!?01";
const RAMP = ".:-=+*x#%@";
const SCRAMBLE = "!<>-_\\/[]{}=+*^?#";

const BOOT: [string, string][] = [
  ["sikeoop 0.2.0 · booting", ""],
  ["> 读取记忆 c1–c4 ", "ok"],
  ["> 连接模型 ", "ok"],
  ["> 唤醒鲸鱼娘 ", "醒了"],
];
const WORD = "sikeoop";
const TAGLINE = "说出你想做的东西，剩下的交给 AI。";

const FONT = '"Geist Mono Variable", "Geist Mono", "SF Mono", Menlo, Consolas, monospace';

interface Cell {
  /** Landing position (CSS px) and how deep inside the heart (0 edge … 1 core). */
  x: number;
  y: number;
  depth: number;
  glyph: string;
  /** Where it flies in from, when it lands, and its scatter direction. */
  sx: number;
  sy: number;
  land: number;
  vx: number;
  vy: number;
  seed: number;
}

export interface Ascii {
  render(t: number): void;
  resize(): void;
  dispose(): void;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
/** Cheap deterministic noise: the same (i, step) always gives the same number. */
const hash = (i: number, step: number) => {
  const s = Math.sin(i * 127.1 + step * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const pick = (set: string, i: number, step: number) => set[Math.floor(hash(i, step) * set.length) % set.length];

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inside the heart (x² + y² − 1)³ − x²y³ ≤ 0, with y up; returns how far inside, or −1 outside. */
function heartDepth(x: number, y: number): number {
  const a = x * x + y * y - 1;
  const v = a * a * a - x * x * y * y * y;
  return v > 0 ? -1 : Math.min(1, Math.pow(-v, 0.35) * 1.6);
}

export async function createAscii(canvas: HTMLCanvasElement): Promise<Ascii> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  try {
    await document.fonts.load(`14px ${FONT}`);
  } catch {
    // The fallback monospace is fine.
  }

  let W = 0;
  let H = 0;
  let fs = 14;
  let cw = 8.6;
  let ch = 15;
  let cells: Cell[] = [];
  let noise: { x: number; y: number; i: number }[] = [];
  let heart = { cx: 0, cy: 0, r: 0 };

  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    fs = Math.max(11, Math.min(15, Math.round(Math.min(W, H) / 60)));
    cw = fs * 0.62;
    ch = fs * 1.12;
    const rand = mulberry(20260409);
    // The heart: about 46% of the shorter side, a little above centre.
    heart = { cx: W / 2, cy: H * 0.45, r: Math.min(W, H) * 0.23 };
    cells = [];
    const cols = Math.ceil((heart.r * 2.6) / cw);
    const rows = Math.ceil((heart.r * 2.6) / ch);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = heart.cx + (c - cols / 2 + 0.5) * cw;
        const y = heart.cy + (r - rows / 2 + 0.5) * ch;
        const depth = heartDepth((x - heart.cx) / heart.r, -(y - heart.cy) / heart.r - 0.12);
        if (depth < 0) continue;
        const ang = rand() * Math.PI * 2;
        const far = Math.hypot(W, H) * (0.45 + rand() * 0.4);
        const out = Math.atan2(y - heart.cy, x - heart.cx);
        const dist = Math.hypot(x - heart.cx, y - heart.cy) / heart.r;
        cells.push({
          x,
          y,
          depth,
          glyph: RAMP[Math.min(RAMP.length - 1, Math.floor(depth * RAMP.length))],
          sx: W / 2 + Math.cos(ang) * far,
          sy: H / 2 + Math.sin(ang) * far,
          // The core lands first and the heart fills outward.
          land: 0.55 + dist * 0.38 + rand() * 0.18,
          vx: Math.cos(out) * (240 + rand() * 520),
          vy: Math.sin(out) * (240 + rand() * 520) - 120,
          seed: rand() * 1000,
        });
      }
    }
    // Background flicker: a sparse random scatter of grid cells.
    noise = [];
    const nCols = Math.ceil(W / cw);
    const nRows = Math.ceil(H / ch);
    const count = Math.min(1600, Math.floor(nCols * nRows * 0.12));
    for (let i = 0; i < count; i++) noise.push({ x: Math.floor(rand() * nCols) * cw, y: Math.floor(rand() * nRows) * ch + ch, i });
  }

  const color = (k: number, a: number) => {
    const r = Math.round(PINK[0] + (CORE[0] - PINK[0]) * k);
    const g = Math.round(PINK[1] + (CORE[1] - PINK[1]) * k);
    const b = Math.round(PINK[2] + (CORE[2] - PINK[2]) * k);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  function drawBoot(t: number) {
    const fade = 1 - clamp01((t - 0.75) / 0.3);
    if (fade <= 0) return;
    ctx!.font = `${fs}px ${FONT}`;
    ctx!.textBaseline = "alphabetic";
    let y = 28 + fs;
    BOOT.forEach(([text, status], n) => {
      const start = n * 0.12;
      const shown = Math.floor(clamp01((t - start) / 0.1) * text.length);
      if (shown <= 0) return;
      const line = text.slice(0, shown);
      ctx!.fillStyle = `rgba(139, 139, 147, ${0.9 * fade})`;
      ctx!.fillText(line, 24, y);
      if (status && shown === text.length) {
        const w = ctx!.measureText(line).width;
        // Leader dots, then the status once the dots have run.
        const dots = Math.floor(clamp01((t - start - 0.1) / 0.08) * 12);
        ctx!.fillStyle = `rgba(111, 108, 120, ${fade})`;
        ctx!.fillText(".".repeat(dots), 24 + w, y);
        if (dots === 12) {
          ctx!.fillStyle = status === "ok" ? OK : `rgba(240, 120, 155, ${fade})`;
          ctx!.globalAlpha = fade;
          ctx!.fillText(` ${status}`, 24 + w + ctx!.measureText(".".repeat(12)).width, y);
          ctx!.globalAlpha = 1;
        }
      }
      y += fs * 1.6;
    });
    // A blinking cursor after the last line.
    if (Math.floor(t * 6) % 2 === 0) {
      ctx!.fillStyle = `rgba(240, 120, 155, ${fade})`;
      ctx!.fillRect(24, y - fs + 2, cw, fs);
    }
  }

  function drawNoise(t: number) {
    const a = clamp01((t - 0.3) / 0.25) * (1 - clamp01((t - 1.55) / 0.4));
    if (a <= 0) return;
    ctx!.font = `${fs}px ${FONT}`;
    const step = Math.floor(t * 14);
    ctx!.fillStyle = NOISE;
    ctx!.globalAlpha = a;
    for (const n of noise) {
      // Each cell is lit only part of the time, so the field shimmers.
      if (hash(n.i, step) < 0.55) continue;
      ctx!.fillText(pick(GLYPHS, n.i, step), n.x, n.y);
    }
    ctx!.globalAlpha = 1;
  }

  function drawHeart(t: number, dx = 0, tint?: string) {
    ctx!.font = `${fs}px ${FONT}`;
    const beat = 1 + 0.07 * Math.sin(clamp01((t - 1.22) / 0.22) * Math.PI);
    const scan = (t - 1.3) / 0.35; // 0..1 down the heart
    const step = Math.floor(t * 24);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const fly = clamp01((t - (c.land - 0.32)) / 0.32);
      if (fly <= 0) continue;
      const k = easeOut(fly);
      let x = c.sx + (c.x - c.sx) * k;
      let y = c.sy + (c.y - c.sy) * k;
      let alpha = 0.25 + 0.75 * fly;
      // The beat scales the landed heart about its centre.
      if (fly >= 1) {
        x = heart.cx + (x - heart.cx) * beat;
        y = heart.cy + (y - heart.cy) * beat;
      }
      // Scatter at the end.
      const s = clamp01((t - 1.75 - (c.seed % 1) * 0.08) / 0.4);
      if (s > 0) {
        x += c.vx * s * 0.45;
        y += c.vy * s * 0.45 + 300 * s * s * 0.2;
        alpha *= 1 - s;
      }
      if (alpha <= 0.01) continue;
      const landed = fly >= 1;
      const glyph = landed && s === 0 ? c.glyph : pick(GLYPHS, i, step);
      // The scanline brightens the row it passes.
      const rowPos = (c.y - (heart.cy - heart.r * 1.2)) / (heart.r * 2.4);
      const lit = scan > 0 && scan < 1.2 ? Math.max(0, 1 - Math.abs(rowPos - scan) * 9) : 0;
      ctx!.fillStyle = tint ?? color(Math.min(1, c.depth * 0.85 + lit), alpha);
      ctx!.fillText(glyph, x - cw / 2 + dx, y + fs / 3);
    }
  }

  function drawWord(t: number) {
    const a = 1 - clamp01((t - 1.75) / 0.3);
    if (t < 1.15 || a <= 0) return;
    const big = fs * 2.3;
    ctx!.font = `600 ${big}px ${FONT}`;
    ctx!.textAlign = "center";
    const step = Math.floor(t * 30);
    let word = "";
    for (let i = 0; i < WORD.length; i++) {
      const lock = 1.18 + i * 0.055;
      if (t < lock - 0.2) word += " ";
      else word += t >= lock ? WORD[i] : pick(SCRAMBLE, i, step);
    }
    const y = heart.cy + heart.r * 1.42;
    ctx!.globalAlpha = a;
    ctx!.shadowColor = "rgba(240, 120, 155, 0.6)";
    ctx!.shadowBlur = 18;
    ctx!.fillStyle = "#ffd6e3";
    // Letter spacing by hand: canvas letterSpacing isn't everywhere yet.
    const gap = big * 0.32;
    const total = word.length * (big * 0.62 + gap) - gap;
    for (let i = 0; i < word.length; i++) ctx!.fillText(word[i], W / 2 - total / 2 + i * (big * 0.62 + gap) + big * 0.31, y);
    ctx!.shadowBlur = 0;
    // The tagline types out under it.
    const typed = Math.floor(clamp01((t - 1.42) / 0.3) * TAGLINE.length);
    if (typed > 0) {
      ctx!.font = `${fs}px ${FONT}`;
      ctx!.fillStyle = DIM;
      ctx!.fillText(TAGLINE.slice(0, typed), W / 2, y + big * 0.95);
    }
    ctx!.textAlign = "left";
    ctx!.globalAlpha = 1;
  }

  function render(t: number) {
    ctx!.fillStyle = BG;
    ctx!.fillRect(0, 0, W, H);
    drawBoot(t);
    drawNoise(t);
    // Two short glitch frames: the heart drawn red- and cyan-shifted, added on top.
    const glitch = (t > 1.26 && t < 1.31) || (t > 1.52 && t < 1.56);
    if (glitch) {
      ctx!.globalCompositeOperation = "lighter";
      drawHeart(t, -4, "rgba(255, 60, 90, 0.55)");
      drawHeart(t, 4, "rgba(60, 220, 255, 0.45)");
      ctx!.globalCompositeOperation = "source-over";
    } else drawHeart(t);
    drawWord(t);
    // Faint scanlines over everything, for the screen feel.
    ctx!.fillStyle = "rgba(0, 0, 0, 0.18)";
    for (let y = 0; y < H; y += 3) ctx!.fillRect(0, y, W, 1);
  }

  layout();
  return { render, resize: layout, dispose: () => ctx.clearRect(0, 0, W, H) };
}
