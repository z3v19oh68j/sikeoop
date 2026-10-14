// Performance baseline for the renderer (docs/方案-性能优化.md): builds it as it ships, with the dev
// mock standing in for the main process, and drives it in Chromium through the cases that used to
// stutter. Prints one JSON object; compare runs on the same machine, the numbers depend on it.
//
//   npm i --no-save playwright-core          # once; not a dependency of the app
//   npm run perf                             # all cases
//   npm run perf -- --only=stream-code,typing --skip-build --chrome=/path/to/chrome
//
// Chromium: --chrome, else $PERF_CHROME, else an installed Google Chrome, else Playwright's own.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(here, "vite.perf.config.ts");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("需要 playwright-core：先运行 npm i --no-save playwright-core");
  process.exit(1);
}

async function launch() {
  const executablePath = typeof args.chrome === "string" ? args.chrome : process.env.PERF_CHROME;
  if (executablePath) return chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    return chromium.launch();
  }
}

// ---- what the cases stream ---------------------------------------------------------------------

const PROSE_BLOCK = [
  "## 调度器的排队逻辑\n\n",
  "这里先说结论：`pump()` 每 2 秒跑一次，按提交顺序检查每个排队任务，**执行体空闲**且名额够才会启动。下面分几点说明：\n\n",
  "1. 先看执行体是否还活着，退出了就直接结束任务；\n2. 再看同一执行体上是否已有任务在跑；\n3. 最后检查全局名额和 lane。\n\n",
  "| 字段 | 含义 | 默认值 |\n|---|---|---|\n| maxRunning | 同时运行上限 | 4 |\n| queueTimeoutMs | 排队超时 | 60 分钟 |\n\n",
  "```ts\n" + Array.from({ length: 12 }, (_, i) => `const v${i} = entries.filter((e) => e.job.status === "running" && e.lane === lane${i});`).join("\n") + "\n```\n\n",
  "> 注意：子任务在父任务运行时可以绕过上限，见 [scheduler.ts:285](src/main/dispatch/scheduler.ts:285)。\n\n",
].join("");
const prose = (n) => {
  let s = "";
  while (s.length < n) s += PROSE_BLOCK;
  return s.slice(0, n);
};
const CODE =
  "下面是完整实现：\n\n```ts\n" +
  Array.from({ length: 150 }, (_, i) => `export function step${i}(job: DispatchJob, queue: string[]): boolean { return queue.includes(job.id) && job.status !== "done"; } // ${i}`).join("\n") +
  "\n```\n";

// ---- in the page --------------------------------------------------------------------------------

/** Before the app loads: no tour, and the mock's listeners caught so the cases can feed them. */
function instrument() {
  for (const c of ["start", "work"]) localStorage.setItem("sweet.tour." + c, "1");
  const caught = (window.__listeners = { agent: new Set(), term: new Set(), dispatch: new Set() });
  window.__tabs = [];
  let real;
  Object.defineProperty(window, "sweet", {
    configurable: true,
    get: () => real,
    set(v) {
      const wrap = (name, set) => {
        const orig = v[name].bind(v);
        v[name] = (cb) => {
          set.add(cb);
          const off = orig(cb);
          return () => {
            set.delete(cb);
            off?.();
          };
        };
      };
      wrap("onAgentEvent", caught.agent);
      wrap("onTermData", caught.term);
      wrap("onDispatchChanged", caught.dispatch);
      const start = v.termStart.bind(v);
      v.termStart = (tab, ...rest) => (window.__tabs.push(tab), start(tab, ...rest));
      real = v;
    },
  });
  const perf = (window.__perf = { long: [], frames: [] });
  new PerformanceObserver((l) => l.getEntries().forEach((e) => perf.long.push({ s: e.startTime, d: e.duration }))).observe({ type: "longtask", buffered: true });
  addEventListener("load", () => {
    let last = performance.now();
    const frame = (t) => {
      perf.frames.push({ t, d: t - last });
      last = t;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  window.__emit = (e) => caught.agent.forEach((l) => l(e));
  window.__frames = (t0, t1) => {
    const long = perf.long.filter((x) => x.s >= t0 && x.s < t1);
    const frames = perf.frames.filter((x) => x.t >= t0 && x.t < t1).map((x) => x.d).sort((a, b) => a - b);
    return {
      longTasks: long.length,
      maxTaskMs: Math.round(Math.max(0, ...long.map((x) => x.d))),
      framesOver50ms: frames.filter((d) => d > 50).length,
      p95FrameMs: Math.round(frames[Math.floor(frames.length * 0.95)] ?? 0),
    };
  };
  /** One reply, streamed `size` characters every `every` ms (or all at once). */
  window.__turn = async (text, size, every, tools = 0) => {
    window.__emit({ type: "remote_message", text: "问题" });
    window.__emit({ type: "status", state: "thinking" });
    for (let k = 0; k < tools; k++) {
      const id = `t${Math.random()}`;
      window.__emit({ type: "tool_start", id, name: "read_file", summary: `阅读 src/file${k}.ts` });
      window.__emit({ type: "tool_end", id, ok: true, preview: "ok" });
    }
    if (size >= text.length) window.__emit({ type: "text_delta", text });
    else
      await new Promise((done) => {
        let i = 0;
        const tick = () => {
          if (i >= text.length) return done();
          window.__emit({ type: "text_delta", text: text.slice(i, i + size) });
          i += size;
          setTimeout(tick, every);
        };
        tick();
      });
    window.__emit({ type: "done", reason: "end_turn" });
    window.__emit({ type: "status", state: "idle" });
  };
}

// ---- the cases ----------------------------------------------------------------------------------

async function openApp(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(".recent-list .open:not([disabled])").first().click();
  await page.waitForSelector(".sidebar");
  const ok = page.getByRole("button", { name: "知道了" });
  if (await ok.count()) await ok.first().click().catch(() => {});
  await page.waitForTimeout(800);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  /** Script and layout seconds and frame health while `fn` runs. */
  const measure = async (fn) => {
    const m0 = await metrics();
    const t0 = await page.evaluate(() => performance.now());
    await fn();
    await page.waitForTimeout(300);
    const t1 = await page.evaluate(() => performance.now());
    const m1 = await metrics();
    return {
      seconds: +((t1 - t0) / 1000).toFixed(1),
      scriptS: +(m1.ScriptDuration - m0.ScriptDuration).toFixed(2),
      layoutS: +(m1.LayoutDuration - m0.LayoutDuration).toFixed(2),
      ...(await page.evaluate(([a, b]) => window.__frames(a, b), [t0, t1])),
    };
  };
  return { page, measure, metrics };
}

const KEYS = "abcdefghij".repeat(10);
async function typing(app) {
  const { page, metrics } = app;
  await page.locator(".sidebar").getByText("types.ts", { exact: true }).click();
  await page.waitForSelector(".monaco-editor .view-lines");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+End");
  const m0 = await metrics();
  await page.keyboard.type(KEYS, { delay: 30 });
  await page.waitForTimeout(300);
  const m1 = await metrics();
  return { scriptMsPerKey: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / KEYS.length).toFixed(2) };
}

const CASES = {
  /** A long answer that is one big code block (it used to be re-highlighted on every delta). */
  "stream-code": async (app) => app.measure(() => app.page.evaluate((t) => window.__turn(t, 6, 20), CODE)),
  /** A long prose answer of the same length. */
  "stream-prose": async (app) => app.measure(() => app.page.evaluate((t) => window.__turn(t, 6, 20), prose(CODE.length))),
  /** Typing in the editor, with a short and then a long conversation next to it. */
  typing: async (app) => {
    const short = await typing(app);
    await app.page.evaluate(async (t) => {
      for (let i = 0; i < 60; i++) await window.__turn(t, 1e9, 0, 6);
    }, prose(3000));
    await app.page.waitForTimeout(1000);
    return { chat1Turn: short, chat60Turns: await typing(app) };
  },
  /** Four terminal tabs printing like a coding CLI: a status line 25 times a second, bursts of output. */
  terminal: async (app) => {
    const { page } = app;
    await page.locator(".statusbar").getByText("终端").click();
    await page.waitForTimeout(800);
    for (let i = 0; i < 3; i++) {
      await page.locator('summary[aria-label="新标签页"]').click();
      await page.locator(".install-pop button", { hasText: "终端" }).first().dispatchEvent("click");
      await page.waitForTimeout(500);
    }
    return app.measure(() =>
      page.evaluate(
        () =>
          new Promise((done) => {
            let n = 0;
            const send = (tab, d) => window.__listeners.term.forEach((l) => l(tab, d));
            const t = setInterval(() => {
              n++;
              for (const tab of window.__tabs) {
                let s = `\x1b[s\x1b[3A\x1b[2K\r✻ Thinking… (${(n / 25).toFixed(0)}s · ↑ ${n * 13} tokens)\x1b[u`;
                if (n % 25 === 0) s += Array.from({ length: 40 }, (_, i) => `  ${i} │ const value${i} = await load(${i});`).join("\r\n") + "\r\n";
                send(tab, s);
              }
              if (n >= 25 * 15) clearInterval(t), done();
            }, 40);
          }),
      ),
    );
  },
  /** The dispatch console: no listener while it is hidden; the cost of its updates while it is shown. */
  dispatch: async (app) => {
    const { page } = app;
    const hiddenListeners = await page.evaluate(() => window.__listeners.dispatch.size);
    await page.evaluate(() => document.querySelector('[aria-label="调度台"], [title*="调度台"]')?.click());
    await page.waitForTimeout(800);
    // 0 here means the console didn't open (the sidebar changed): the "shown" numbers would mean nothing.
    const shownListeners = await page.evaluate(() => window.__listeners.dispatch.size);
    const shown = await app.measure(() =>
      page.evaluate(
        () =>
          new Promise((done) => {
            let tick = 0;
            const now = Date.now();
            const view = () => ({
              jobs: Array.from({ length: 30 }, (_, i) => ({
                id: "job-" + i, rootId: "job-" + (i - (i % 5)), parentId: i % 5 ? "job-" + (i - (i % 5)) : undefined, origin: "chat", from: "sikeoop",
                executor: { kind: "session", ref: "worker:" + i, name: "openai/gpt-x" }, input: "实现第 " + i + " 个模块。",
                limits: { timeoutMs: 1860000 }, status: "running", createdAt: now - 60000, startedAt: now - 50000,
                progress: [{ type: "tool", at: Date.now(), title: `阅读 src/module${i}/file${tick}.ts` }],
              })),
              budgets: [], running: 30, queued: 0, maxRunning: 4,
            });
            const t = setInterval(() => {
              window.__listeners.dispatch.forEach((l) => l(view()));
              if (++tick >= 40) clearInterval(t), done();
            }, 250);
          }),
      ),
    );
    return { listenersWhileHidden: hiddenListeners, listenersWhileShown: shownListeners, shown };
  },
};

async function boot(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(url);
  await page.waitForSelector(".recent-list .open");
  const readyMs = Math.round(await page.evaluate(() => performance.now()));
  await page.waitForTimeout(1500);
  const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const long = await page.evaluate(() => window.__perf.long);
  await context.close();
  return { startPageReadyMs: readyMs, scriptS: +m.ScriptDuration.toFixed(2), biggestTaskMs: Math.round(Math.max(0, ...long.map((x) => x.d))), domNodes: m.Nodes };
}

// ---- run ----------------------------------------------------------------------------------------

if (!args["skip-build"]) await build({ configFile, logLevel: "warn" });
const server = await preview({ configFile, preview: { port: 5299, strictPort: false }, logLevel: "warn" });
const url = server.resolvedUrls.local[0];
const browser = await launch();
const results = {};
try {
  if (!only || only.has("boot")) results.boot = await boot(browser, url);
  for (const [name, run] of Object.entries(CASES)) {
    if (only && !only.has(name)) continue;
    // Each case in a fresh page, so one doesn't slow the next.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(instrument);
    results[name] = await run(await openApp(context, url));
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(JSON.stringify(results, null, 1));
