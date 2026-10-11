// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QuartoEvent, QuartoRun } from "../../src/shared/types.ts";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { isFile, runProcess, watchFile } from "../../src/main/papers/host.ts";
import { ProjectFiles } from "../../src/main/papers/project-files.ts";
import { TypesetService } from "../../src/main/papers/typeset.ts";

const QUARTO = "/usr/local/bin/quarto";
const CSL = `<?xml version="1.0" encoding="utf-8"?>\n<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">\n<info><title>Sample style</title><rights license="http://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</rights></info>\n${"<macro/>".repeat(80)}\n</style>`;

type Render = { args: string[]; cwd: string; out(text: string): void; exit(code: number): void; signal: AbortSignal };

function setup(opts: { version?: string | null; managed?: { path: string; version: string; reports?: string | null }[] } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-typeset-")));
  const project = path.join(base, "project");
  const userData = path.join(base, "userData");
  mkdirSync(path.join(project, "paper"), { recursive: true });
  writeFileSync(path.join(project, "paper", "main.qmd"), "---\ntitle: T\n---\nText.");
  const version = opts.version === undefined ? "1.5.57" : opts.version;
  const renders: Render[] = [];
  const events: QuartoEvent[] = [];
  const asked: { files: string[]; detail: string }[] = [];
  const opened: [string, string][] = [];
  const fetched: string[] = [];
  const probed: string[] = [];
  let approve = true;
  let csl: string | null = CSL;
  let saved: (() => void) | null = null;
  let stopped = 0;
  const gone = new Set<string>();
  const svc = new TypesetService({
    userData: () => userData,
    root: () => project,
    platform: "darwin",
    env: () => ({ PATH: "/nowhere/bin:/usr/local/bin" }),
    home: "/Users/me",
    dispatcher: new Dispatcher({ emit: () => {} }),
    files: new ProjectFiles(() => project),
    isFile: async (file) => (file === QUARTO ? version !== null : gone.has(file) ? false : (opts.managed?.some((m) => m.path === file) ?? false) || existsSync(file)),
    ...(opts.managed ? { managed: async () => opts.managed!.map(({ path, version }) => ({ path, version })) } : {}),
    run: (bin, args, cwd, out, signal) => {
      if (args[0] === "--version") {
        probed.push(bin);
        // A copy sikeoop downloaded says its own version (null: it doesn't run).
        const ours = opts.managed?.find((m) => m.path === bin);
        if (ours?.reports === null) return Promise.resolve(1);
        out(`${ours ? (ours.reports ?? ours.version) : version}\n`);
        return Promise.resolve(0);
      }
      return new Promise<number>((resolve) => {
        renders.push({ args, cwd, out, exit: resolve, signal });
        signal.addEventListener("abort", () => resolve(143));
      });
    },
    fetch: (async (url: string) => {
      fetched.push(url);
      return csl === null ? new Response("not found", { status: 404 }) : new Response(csl, { status: 200 });
    }) as unknown as typeof fetch,
    approveNew: async (files, detail) => {
      asked.push({ files, detail });
      return approve;
    },
    watchFile: (_file, changed) => {
      saved = changed;
      return () => {
        stopped++;
        saved = null;
      };
    },
    open: async (file, format) => void opened.push([file, format]),
    emit: (e) => events.push(e),
    debounceMs: 5,
  });
  const until = async (what: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (what()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waited too long");
  };
  const ended = async (id: string): Promise<QuartoRun> => {
    await until(() => svc.list().find((r) => r.id === id)?.endedAt !== undefined);
    return svc.list().find((r) => r.id === id)!;
  };
  const inProject = (relative: string) => path.join(project, relative);
  return { svc, gone, project, userData, renders, events, asked, opened, fetched, probed, until, ended, inProject, save: () => saved?.(), watched: () => saved !== null, stops: () => stopped, setApprove: (v: boolean) => (approve = v), setCsl: (v: string | null) => (csl = v) };
}

test("Quarto is found where it is installed and asked for its version; missing says how to install", async () => {
  const t = setup();
  assert.deepEqual(await t.svc.status(), { found: true, path: QUARTO, version: "1.5.57", typst: true, message: "", steps: [] });
  assert.deepEqual(t.probed, [QUARTO], "only a program that is there is run");
  const none = setup({ version: null });
  const status = await none.svc.status();
  assert.deepEqual([status.found, status.steps.length > 0, none.probed], [false, true, []]);
  await assert.rejects(none.svc.render({ file: "paper/main.qmd", format: "pdf" }), /没有找到 Quarto/);
  await assert.rejects(setup({ version: "1.3.450" }).svc.render({ file: "paper/main.qmd", format: "pdf" }), /出不了 PDF，需要 1\.4/);
});

test("the user's own Quarto is used first; a copy sikeoop downloaded only when theirs is missing or too old", async () => {
  const OURS = "/data/tools/quarto/1.10.19/bin/quarto";
  const OLDER = "/data/tools/quarto/1.9.36/bin/quarto";
  const both = setup({ managed: [{ path: OURS, version: "1.10.19" }] });
  assert.deepEqual(await both.svc.status(), { found: true, path: QUARTO, version: "1.5.57", typst: true, message: "", steps: [] });
  assert.deepEqual(both.probed, [QUARTO], "theirs will do: ours is not even run");

  const none = setup({ version: null, managed: [{ path: OLDER, version: "1.9.36" }, { path: OURS, version: "1.10.19" }] });
  assert.deepEqual(await none.svc.status(), { found: true, path: OURS, version: "1.10.19", typst: true, message: "", steps: [], managed: true });
  const run = await none.svc.render({ file: "paper/main.qmd", format: "pdf" });
  await none.until(() => none.renders.length === 1);
  none.renders[0].exit(0);
  await none.ended(run.id);

  const old = setup({ version: "1.3.450", managed: [{ path: OURS, version: "1.10.19" }] });
  assert.deepEqual([(await old.svc.status()).path, (await old.svc.status()).managed], [OURS, true], "theirs can't make PDF: ours");
  const onlyOld = setup({ version: "1.3.450", managed: [] });
  const status = await onlyOld.svc.status();
  assert.deepEqual([status.path, status.typst, status.managed, /下载 Quarto/.test(status.steps[0])], [QUARTO, false, undefined, true]);

  // What a copy says about itself counts, not its folder's name; one that doesn't run is passed over.
  const lying = setup({ version: null, managed: [{ path: OURS, version: "1.10.19", reports: "1.3.0" }, { path: OLDER, version: "1.9.36", reports: null }] });
  assert.deepEqual([(await lying.svc.status()).found, (await lying.svc.status()).typst], [false, false]);

  // Deleted after it was found (设置 → 删除): looked for again instead of failing on a missing program.
  const deleted = setup({ version: null, managed: [{ path: OURS, version: "1.10.19" }] });
  await deleted.svc.status();
  deleted.gone.add(OURS);
  await assert.rejects(deleted.svc.render({ file: "paper/main.qmd", format: "html" }), /没有找到 Quarto/);
});

test("a rendering is a job: Quarto runs in the document's folder and the output it names is the result", async () => {
  const t = setup();
  const run = await t.svc.render({ file: "paper/main.qmd", format: "pdf" });
  assert.deepEqual([run.file, run.format, run.trigger, run.status], ["paper/main.qmd", "pdf", "manual", "queued"]);
  await t.until(() => t.renders.length === 1);
  assert.deepEqual([t.renders[0].args, t.renders[0].cwd], [["render", "main.qmd", "--to", "typst", "--no-execute"], t.inProject("paper")]);
  assert.equal(t.svc.list()[0].status, "running");
  writeFileSync(t.inProject("paper/main.pdf"), "%PDF");
  t.renders[0].out("[WARNING] Citeproc: citation ghost2019 not found\nOutput created: main.pdf\n");
  t.renders[0].exit(0);
  const done = await t.ended(run.id);
  assert.deepEqual([done.status, done.output, done.points.length], ["done", "paper/main.pdf", 1]);
  assert.match(done.points[0], /ghost2019/);
  assert.match(done.log, /Output created: main\.pdf$/);
  assert.deepEqual(t.events.filter((e) => e.type === "run").map((e) => e.type === "run" && e.run.status), ["queued", "running", "done"]);

  await t.svc.open("paper/main.pdf");
  assert.deepEqual(t.opened, [[t.inProject("paper/main.pdf"), "pdf"]]);
  await assert.rejects(t.svc.open("paper/main.qmd"), /只能打开排版出来的/);
  await assert.rejects(t.svc.open("../outside.pdf"), /超出了项目文件夹/);
  await assert.rejects(t.svc.open("paper/missing.html"), /没有找到/);
});

test("a failed rendering shows what matters; one that names no output file is not called done", async () => {
  const t = setup();
  const failed = await t.svc.render({ file: "paper/main.qmd", format: "pdf", execute: true });
  await t.until(() => t.renders.length === 1);
  assert.deepEqual(t.renders[0].args, ["render", "main.qmd", "--to", "typst"]);
  t.renders[0].out("error: unknown font family: songti sc\n   ┌─ main.typ:3:1\nERROR: Error\n");
  t.renders[0].exit(1);
  const f = await t.ended(failed.id);
  assert.deepEqual([f.status, f.output], ["failed", undefined]);
  assert.deepEqual(f.points, ["unknown font family: songti sc（main.typ:3:1）", "Error", "文档里指定的字体这台电脑上没有：改掉 mainfont，或装上这个字体"]);

  const silent = await t.svc.render({ file: "paper/main.qmd", format: "docx" });
  await t.until(() => t.renders.length === 2);
  t.renders[1].exit(2);
  assert.deepEqual((await t.ended(silent.id)).points, ["Quarto 退出了（代码 2）"]);

  const lost = await t.svc.render({ file: "paper/main.qmd", format: "html" });
  await t.until(() => t.renders.length === 3);
  t.renders[2].out("Output created: main.html\n");
  t.renders[2].exit(0);
  const l = await t.ended(lost.id);
  assert.deepEqual([l.status, l.points[0]], ["failed", "Quarto 说排完了，但没有找到输出文件"]);
});

test("a rendering can be cancelled; two of the same document run one after the other", async () => {
  const t = setup();
  const first = await t.svc.render({ file: "paper/main.qmd", format: "pdf" });
  const second = await t.svc.render({ file: "paper/main.qmd", format: "html" });
  await t.until(() => t.renders.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.renders.length, 1, "the second waits for the first");
  t.svc.cancel(first.id);
  assert.equal((await t.ended(first.id)).status, "cancelled");
  assert.ok(t.renders[0].signal.aborted);
  await t.until(() => t.renders.length === 2);
  writeFileSync(t.inProject("paper/main.html"), "<html>");
  t.renders[1].exit(0);
  const done = await t.ended(second.id);
  assert.deepEqual([done.status, done.output], ["done", "paper/main.html"], "without an 'Output created' line the file beside the document is taken");
  t.svc.cancel(first.id);
  t.svc.cancel("nope");
});

test("a request is checked before Quarto is run", async () => {
  const t = setup();
  await assert.rejects(t.svc.render({ file: "paper/main.tex", format: "pdf" }), /只能排版 \.qmd 或 \.md/);
  await assert.rejects(t.svc.render({ file: "paper/main.qmd", format: "epub" }), /只能是 PDF、Word 或网页/);
  await assert.rejects(t.svc.render({ file: "../outside.qmd", format: "pdf" }), /超出了项目文件夹/);
  await assert.rejects(t.svc.render({ file: "paper/missing.qmd", format: "pdf" }), /没有找到 paper\/missing\.qmd/);
  await assert.rejects(t.svc.render(null), /格式不正确/);
  assert.deepEqual([t.renders.length, t.svc.list()], [0, []]);
  mkdirSync(t.inProject("node_modules/pkg"), { recursive: true });
  writeFileSync(t.inProject("node_modules/pkg/README.md"), "x");
  writeFileSync(t.inProject("notes.md"), "x");
  assert.deepEqual(await t.svc.documents(), ["notes.md", "paper/main.qmd"]);
});

test("a watched document is rendered when watching starts and again on every save, never two at once", async () => {
  const t = setup();
  const watch = await t.svc.watch({ file: "paper/main.qmd", format: "html", execute: false });
  assert.deepEqual([watch, t.svc.watchingNow(), t.watched()], [{ file: "paper/main.qmd", format: "html", execute: false }, { file: "paper/main.qmd", format: "html", execute: false }, true]);
  writeFileSync(t.inProject("paper/main.html"), "<html>");
  await t.until(() => t.renders.length === 1);
  assert.equal(t.svc.list()[0].trigger, "save");

  // Saved three times while the first rendering is still going: one more rendering, not three.
  t.save();
  t.save();
  t.save();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(t.renders.length, 1);
  t.renders[0].exit(0);
  await t.until(() => t.renders.length === 2);
  t.renders[1].exit(0);
  await t.until(() => t.svc.list().every((r) => r.endedAt !== undefined));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(t.renders.length, 2);

  t.save();
  await t.until(() => t.renders.length === 3);
  t.renders[2].exit(0);
  await t.until(() => t.svc.list().every((r) => r.endedAt !== undefined));

  assert.equal(await t.svc.watch(null), null);
  assert.deepEqual([t.svc.watchingNow(), t.watched(), t.stops()], [null, false, 1]);
  assert.deepEqual(t.events.filter((e) => e.type === "watch").map((e) => e.type === "watch" && e.watch?.file), ["paper/main.qmd", undefined]);
  await assert.rejects(t.svc.watch({ file: "paper/missing.qmd", format: "html", execute: false }), /没有找到/);
});

test("a new paper: the document, an empty references.bib and the style file, added only after asking", async () => {
  const t = setup();
  assert.deepEqual((await t.svc.cslStyles()).map((s) => [s.id, s.cached, s.license]), [["gbt7714", false, "CC BY-SA 3.0"], ["apa", false, "CC BY-SA 3.0"]]);
  const req = { dir: "thesis", name: "main", title: "我的论文", authors: ["李旺"], abstract: "摘要。", lang: "zh", csl: "gbt7714", downloadCsl: true };

  t.setApprove(false);
  await assert.rejects(t.svc.newPaper(req), /你取消了新建，没有添加文件/);
  assert.equal(existsSync(t.inProject("thesis")), false);
  assert.deepEqual(t.asked[0].files, ["thesis/main.qmd", "thesis/references.bib", "thesis/china-national-standard-gb-t-7714-2015-numeric.csl"]);
  assert.match(t.asked[0].detail, /来自 CSL 官方样式库（CC BY-SA 3\.0），原样保存/);

  t.setApprove(true);
  const made = await t.svc.newPaper(req);
  assert.deepEqual(made, { document: "thesis/main.qmd", files: ["thesis/main.qmd", "thesis/references.bib", "thesis/china-national-standard-gb-t-7714-2015-numeric.csl"], skipped: [] });
  assert.equal(readFileSync(t.inProject("thesis/china-national-standard-gb-t-7714-2015-numeric.csl"), "utf8"), CSL, "the style file is saved unchanged, licence line included");
  assert.match(readFileSync(t.inProject("thesis/main.qmd"), "utf8"), /^csl: "china-national-standard-gb-t-7714-2015-numeric\.csl"$/m);
  assert.equal(t.fetched.length, 1, "kept after the first download: the cancelled try already fetched it");
  assert.equal((await t.svc.cslStyles())[0].cached, true);

  await assert.rejects(t.svc.newPaper(req), /thesis\/main\.qmd 已经存在/);
  // A second paper in the same folder: the files already there are left alone, and no download is needed.
  const second = await t.svc.newPaper({ ...req, name: "chapter2", downloadCsl: false });
  assert.deepEqual([second.files, second.skipped.length, t.fetched.length], [["thesis/chapter2.qmd"], 2, 1]);
});

test("without the style file the paper is still made and says how it falls back", async () => {
  const t = setup();
  const req = { dir: "", name: "paper", title: "Routing", authors: [], abstract: "", lang: "en", csl: "apa", downloadCsl: false };
  const plain = await t.svc.newPaper(req);
  assert.deepEqual([plain.files, plain.cslError, t.fetched.length], [["paper.qmd", "references.bib"], undefined, 0], "nothing is fetched unless the user agreed");
  assert.match(readFileSync(t.inProject("paper.qmd"), "utf8"), /^ {4}csl: apa$/m);

  t.setCsl(null);
  const failed = await t.svc.newPaper({ ...req, name: "paper2", downloadCsl: true });
  assert.deepEqual([failed.files, failed.cslError], [["paper2.qmd"], "样式文件下载失败（404）"]);
  t.setCsl("<html>captive portal</html>".repeat(40));
  assert.equal((await t.svc.newPaper({ ...req, name: "paper3", downloadCsl: true })).cslError, "下载到的不是 CSL 样式文件");
  assert.equal(existsSync(path.join(t.userData, "papers-csl", "apa.csl")), false, "something that isn't a style file is not kept");
  await assert.rejects(t.svc.newPaper({ ...req, dir: "../outside" }), /相对路径/);
});

test("on this machine: a program's output arrives, its exit code comes back, and it can be stopped", async () => {
  const out: string[] = [];
  const code = await runProcess(process.execPath, ["-e", "console.log('to stdout'); console.error('to stderr'); process.exit(3)"], os.tmpdir(), (t) => out.push(t), new AbortController().signal);
  assert.equal(code, 3);
  assert.ok(out.join("").includes("to stdout") && out.join("").includes("to stderr"));

  const stop = new AbortController();
  const started = Date.now();
  const running = runProcess(process.execPath, ["-e", "console.log('up'); setTimeout(() => {}, 60000)"], os.tmpdir(), (t) => t.includes("up") && stop.abort(), stop.signal);
  assert.notEqual(await running, 0);
  assert.ok(Date.now() - started < 10_000, "stopped long before it would have ended");
  await assert.rejects(runProcess(path.join(os.tmpdir(), "no-such-program-here"), [], os.tmpdir(), () => {}, new AbortController().signal));
  assert.deepEqual([await isFile(process.execPath), await isFile(os.tmpdir()), await isFile(path.join(os.tmpdir(), "nope"))], [true, false, false]);
});

test("on this machine: saving a watched file is noticed, other files in the folder are not", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-watch-")));
  const file = path.join(dir, "main.qmd");
  writeFileSync(file, "one");
  let changes = 0;
  const stop = watchFile(file, () => changes++);
  await new Promise((r) => setTimeout(r, 100));
  writeFileSync(path.join(dir, "main.pdf"), "output");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(changes, 0);
  writeFileSync(file, "two");
  for (let i = 0; i < 100 && !changes; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(changes > 0);
  stop();
  const seen = changes;
  writeFileSync(file, "three");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(changes, seen, "nothing after it is stopped");
});
