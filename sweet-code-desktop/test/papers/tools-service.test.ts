// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolEvent, ToolTask } from "../../src/shared/types.ts";
import { ToolsService } from "../../src/main/papers/tools.ts";
import { BBT_RELEASE, QUARTO_RELEASE } from "../../src/main/papers/tools-release.ts";
import { tgz, zip } from "./archive-fixtures.ts";
import { fakeNet, json, redirect, serve, type ServeOptions } from "./net-fixtures.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SCRIPT = "#!/bin/sh\necho 1.10.19\n";

/** Quarto's packages as they really are laid out: macOS flat, Linux inside one folder, Windows a flat zip. */
const PACKAGES: Record<string, Buffer> = {
  "quarto-1.10.19-macos.tar.gz": tgz([{ name: "./", type: "5" }, { name: "./bin/", type: "5" }, { name: "./bin/quarto", data: SCRIPT, mode: 0o755 }, { name: "./share/version", data: "1.10.19" }]),
  "quarto-1.10.19-linux-amd64.tar.gz": tgz([{ name: "quarto-1.10.19/", type: "5" }, { name: "quarto-1.10.19/bin/", type: "5" }, { name: "quarto-1.10.19/bin/quarto", data: SCRIPT, mode: 0o755 }, { name: "quarto-1.10.19/share/version", data: "1.10.19" }]),
  "quarto-1.10.19-win.zip": zip([{ name: "bin/quarto.cmd", data: "@echo off\r\n" }, { name: "bin/quarto.exe", data: "MZ" }, { name: "share/version", data: "1.10.19" }]),
};
const assetUrl = (name: string, version = "1.10.19") => `https://github.com/quarto-dev/quarto-cli/releases/download/v${version}/${name}`;
const cdn = (name: string) => `https://release-assets.githubusercontent.com/asset/${name}?sig=1`;
const XPI = Buffer.from("PK\u0003\u0004 pretend plugin file");
const XPI_URL = "https://github.com/retorquere/zotero-better-bibtex/releases/download/v9.0.71/zotero-better-bibtex-9.0.71.xpi";
const DMG = Buffer.alloc(3000, 5);
const ZOTERO_PAGE = "https://www.zotero.org/download/client/dl?channel=release&platform=";
const ZOTERO_FILE = "https://download.zotero.org/client/release/10.0.6/";

function quartoRelease(version = "1.10.19", digest = true) {
  return {
    tag_name: `v${version}`,
    body: "",
    assets: Object.entries(PACKAGES).map(([name, data]) => {
      const file = name.replace("1.10.19", version);
      return { name: file, size: data.length, browser_download_url: assetUrl(file, version), ...(digest ? { digest: `sha256:${sha(data)}` } : {}) };
    }),
  };
}

function setup(o: { platform?: NodeJS.Platform; arch?: string; runs?: boolean } = {}) {
  const platform = o.platform ?? "darwin";
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-tools-")));
  const userData = path.join(base, "userData");
  const downloads = path.join(base, "Downloads");
  mkdirSync(downloads);
  const quartoDir = path.join(userData, "tools", "quarto");
  const events: ToolEvent[] = [];
  const ran: string[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const installed = new Set<string>();
  let runs = o.runs ?? true;
  const net = fakeNet({
    [QUARTO_RELEASE]: json(quartoRelease()),
    [BBT_RELEASE]: json({
      tag_name: "v9.0.71",
      body: "This release is compatible with Zotero 8 and Zotero 9 beta.\n\nMore text.",
      assets: [{ name: "zotero-better-bibtex-9.0.71.xpi", size: XPI.length, browser_download_url: XPI_URL, digest: `sha256:${sha(XPI)}` }],
    }),
    [XPI_URL]: redirect(cdn("bbt")),
    [cdn("bbt")]: serve(XPI),
    [`${ZOTERO_PAGE}mac`]: redirect(`${ZOTERO_FILE}Zotero-10.0.6.dmg`),
    [`${ZOTERO_FILE}Zotero-10.0.6.dmg`]: serve(DMG),
    [`${ZOTERO_PAGE}linux-x86_64`]: redirect(`${ZOTERO_FILE}Zotero-10.0.6_linux-x86_64.tar.xz`),
    [`${ZOTERO_FILE}Zotero-10.0.6_linux-x86_64.tar.xz`]: serve(DMG),
  });
  for (const [name, data] of Object.entries(PACKAGES)) {
    net.routes[assetUrl(name)] = redirect(cdn(name));
    net.routes[cdn(name)] = serve(data);
  }
  const svc = new ToolsService({
    userData: () => userData,
    downloads: () => downloads,
    platform,
    arch: o.arch ?? (platform === "darwin" ? "arm64" : "x64"),
    env: () => ({}),
    home: "/Users/me",
    request: net.request,
    run: async (bin, args, _cwd, out) => {
      ran.push(`${path.relative(quartoDir, bin)} ${args.join(" ")}`);
      if (!runs) {
        out("bad CPU type in executable\n");
        return 126;
      }
      out("1.10.19\n");
      return 0;
    },
    // Real files under the test's folder; anywhere else only what the test says is installed.
    exists: async (file) => (file.startsWith(base) ? existsSync(file) : installed.has(file)),
    open: async (file) => void opened.push(file),
    reveal: (file) => void revealed.push(file),
    emit: (e) => events.push(e),
  });
  const task = (tool: string): ToolTask | undefined => events.filter((e) => e.task.tool === tool).at(-1)?.task;
  const ended = async (tool: string): Promise<ToolTask> => {
    for (let i = 0; i < 600; i++) {
      const t = task(tool);
      if (t && ["done", "failed", "cancelled"].includes(t.phase)) return t;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waited too long");
  };
  /** Offer, download, and wait for the end. */
  const get = async (tool: "quarto" | "zotero" | "bbt") => {
    const offer = await svc.offer(tool);
    await svc.download(tool, offer.version);
    return ended(tool);
  };
  const phases = (tool: string) => events.filter((e) => e.task.tool === tool).map((e) => e.task.phase).filter((p, i, all) => p !== all[i - 1]);
  const pkg = (name: string, options: ServeOptions = {}, data = PACKAGES[name]) => (net.routes[cdn(name)] = serve(data, options));
  return { svc, net, base, userData, downloads, quartoDir, events, ran, opened, revealed, installed, task, ended, get, phases, pkg, setRuns: (v: boolean) => (runs = v), hosts: () => [...new Set(net.calls.map((c) => new URL(c.url).hostname))] };
}
const MAC = "quarto-1.10.19-macos.tar.gz";

test("the offer says what would be downloaded, from where, how big and under which licence; nothing is downloaded for it", async () => {
  const t = setup();
  const offer = await t.svc.offer("quarto");
  assert.deepEqual([offer.tool, offer.version, offer.file, offer.size, offer.checksum, offer.have], ["quarto", "1.10.19", MAC, PACKAGES[MAC].length, true, undefined]);
  assert.match(offer.source, /quarto-dev\/quarto-cli/);
  assert.match(offer.license, /MIT.*Pandoc（GPL-2\.0）/);
  assert.match(offer.where, /tools.quarto.1\.10\.19.*不需要管理员权限/);
  assert.equal(offer.url, assetUrl(MAC));
  assert.deepEqual(t.net.calls, [{ url: QUARTO_RELEASE, method: "GET" }], "one small question to api.github.com");
  assert.deepEqual((await t.svc.state()).quarto, []);
  await assert.rejects(t.svc.offer("pandoc"), /不认识这个工具/);
  await assert.rejects(setup({ platform: "win32", arch: "ia32" }).svc.offer("quarto"), /没有给这种电脑/);
});

test("Quarto is downloaded, checked, unpacked into sikeoop's own folder, tried, and only then put in place", async () => {
  const t = setup();
  const done = await t.get("quarto");
  const dir = path.join(t.quartoDir, "1.10.19");
  assert.deepEqual([done.phase, done.path, done.received, done.total, done.error], ["done", dir, PACKAGES[MAC].length, PACKAGES[MAC].length, undefined]);
  assert.deepEqual(t.phases("quarto"), ["downloading", "verifying", "extracting", "done"]);
  assert.equal(readFileSync(path.join(dir, "bin", "quarto"), "utf8"), SCRIPT);
  assert.equal(statSync(path.join(dir, "bin", "quarto")).mode & 0o111, 0o111, "it can be run");
  assert.equal(t.ran.length, 1);
  assert.match(t.ran[0], /^\.staging-1\.10\.19-\w+\/bin\/quarto --version$/, "tried where it was unpacked, before being put in place");
  assert.deepEqual(readdirSync(t.quartoDir).sort(), [".downloads", "1.10.19"], "nothing half-done is left");
  assert.deepEqual(readdirSync(path.join(t.quartoDir, ".downloads")), [], "the package is deleted once unpacked");
  assert.deepEqual(t.hosts(), ["api.github.com", "github.com", "release-assets.githubusercontent.com"]);
  const state = await t.svc.state();
  assert.deepEqual(state.quarto, [{ version: "1.10.19", dir, bin: path.join(dir, "bin", "quarto") }]);
  assert.deepEqual([state.quartoDir, state.tasks.map((x) => x.phase)], [t.quartoDir, ["done"]]);

  // It is there now: the offer says so, and asking again downloads nothing.
  assert.equal((await t.svc.offer("quarto")).have, true);
  const calls = t.net.calls.length;
  await t.svc.download("quarto", "1.10.19");
  assert.equal((await t.ended("quarto")).phase, "done");
  assert.equal(t.net.calls.length, calls);
  await t.svc.reveal("quarto");
  assert.deepEqual(t.revealed, [dir]);
});

test("each system's package is unpacked to the same shape", async () => {
  const linux = setup({ platform: "linux" });
  assert.equal((await linux.get("quarto")).phase, "done");
  assert.equal(readFileSync(path.join(linux.quartoDir, "1.10.19", "bin", "quarto"), "utf8"), SCRIPT, "the folder the Linux package wraps everything in is taken off");
  assert.deepEqual(readdirSync(path.join(linux.quartoDir, "1.10.19")).sort(), ["bin", "share"]);
  assert.equal(linux.net.calls.some((c) => c.url === assetUrl("quarto-1.10.19-linux-amd64.tar.gz")), true);

  const win = setup({ platform: "win32" });
  const done = await win.get("quarto");
  assert.deepEqual([done.phase, done.file], ["done", "quarto-1.10.19-win.zip"]);
  assert.equal(readFileSync(path.join(win.quartoDir, "1.10.19", "bin", "quarto.exe"), "utf8"), "MZ");
  assert.match(win.ran[0], /quarto\.exe --version$/);
  assert.equal((await win.svc.managedQuarto())[0].bin, path.join(win.quartoDir, "1.10.19", "bin", "quarto.exe"));
});

test("a package that doesn't match the published SHA-256 is deleted and nothing is installed", async () => {
  const t = setup();
  const tampered = Buffer.from(PACKAGES[MAC]);
  tampered[tampered.length - 9] ^= 0xff;
  t.pkg(MAC, {}, tampered);
  const failed = await t.get("quarto");
  assert.equal(failed.phase, "failed");
  assert.match(failed.error ?? "", /校验不通过.*SHA-256 不一样，已删除/);
  assert.equal(failed.resumable, undefined);
  assert.deepEqual(t.phases("quarto"), ["downloading", "verifying", "failed"]);
  assert.deepEqual([readdirSync(path.join(t.quartoDir, ".downloads")), t.ran, (await t.svc.state()).quarto], [[], [], []], "not unpacked, not run, not listed");
});

test("a download that broke off can be tried again and continues; a cancelled one leaves nothing", async () => {
  const t = setup();
  t.pkg(MAC, { breakAfter: 100 });
  const failed = await t.get("quarto");
  assert.deepEqual([failed.phase, failed.resumable, failed.received], ["failed", true, 100]);
  assert.equal(statSync(path.join(t.quartoDir, ".downloads", `${MAC}.part`)).size, 100);
  t.pkg(MAC);
  await t.svc.download("quarto", "1.10.19");
  assert.equal((await t.ended("quarto")).phase, "done");
  assert.deepEqual(t.net.calls.filter((c) => c.url === cdn(MAC)).map((c) => c.range ?? null), [null, "bytes=100-"]);
  assert.equal(readFileSync(path.join(t.quartoDir, "1.10.19", "bin", "quarto"), "utf8"), SCRIPT);

  const c = setup();
  c.pkg(MAC, { hangAfter: 50 });
  const offer = await c.svc.offer("quarto");
  await c.svc.download("quarto", offer.version);
  await assert.rejects(c.svc.download("quarto", offer.version), /已经在下载了/);
  await assert.rejects(c.svc.removeQuarto("1.10.19"), /正在下载或安装/);
  const part = path.join(c.quartoDir, ".downloads", `${MAC}.part`);
  while (!existsSync(part) || statSync(part).size !== 50) await new Promise((r) => setTimeout(r, 2));
  c.svc.cancel("quarto");
  const cancelled = await c.ended("quarto");
  assert.deepEqual([cancelled.phase, cancelled.error], ["cancelled", undefined]);
  assert.deepEqual(readdirSync(path.join(c.quartoDir, ".downloads")), [], "the unfinished file is removed");
  c.pkg(MAC);
  await c.svc.download("quarto", offer.version);
  assert.equal((await c.ended("quarto")).phase, "done", "and it can be started again");
});

test("a Quarto that doesn't run here, or a package that isn't one, is not installed", async () => {
  const t = setup({ runs: false });
  const failed = await t.get("quarto");
  assert.equal(failed.phase, "failed");
  assert.match(failed.error ?? "", /运行不起来，没有安装（bad CPU type in executable）/);
  assert.deepEqual(readdirSync(t.quartoDir).sort(), [".downloads"], "neither the version's folder nor what was unpacked stays");
  assert.deepEqual((await t.svc.state()).quarto, []);

  const empty = setup();
  const other = tgz([{ name: "README.md", data: "not quarto" }]);
  empty.net.routes[QUARTO_RELEASE] = json({ tag_name: "v1.10.19", assets: [{ name: MAC, size: other.length, browser_download_url: assetUrl(MAC), digest: `sha256:${sha(other)}` }] });
  empty.pkg(MAC, {}, other);
  assert.match((await empty.get("quarto")).error ?? "", /没有找到 Quarto 的程序/);

  // The checksum only proves it is what was published; unpacking still refuses to write outside.
  const evil = setup();
  const bad = tgz([{ name: "./bin/quarto", data: SCRIPT, mode: 0o755 }, { name: "../../../escaped.txt", data: "x" }]);
  evil.net.routes[QUARTO_RELEASE] = json({ tag_name: "v1.10.19", assets: [{ name: MAC, size: bad.length, browser_download_url: assetUrl(MAC), digest: `sha256:${sha(bad)}` }] });
  evil.pkg(MAC, {}, bad);
  assert.match((await evil.get("quarto")).error ?? "", /上级文件夹/);
  assert.deepEqual([readdirSync(evil.base).sort(), readdirSync(evil.userData), readdirSync(evil.quartoDir).sort()], [["Downloads", "userData"], ["tools"], [".downloads"]]);
});

test("without a published checksum nothing is offered; an older release's checksums file is used", async () => {
  const none = setup();
  none.net.routes[QUARTO_RELEASE] = json(quartoRelease("1.10.19", false));
  await assert.rejects(none.svc.offer("quarto"), /没有公布校验值，不下载/);
  await assert.rejects(none.svc.download("quarto", "1.10.19"), /没有公布校验值/);
  assert.equal(none.events.length, 0);

  const old = setup();
  const release = quartoRelease("1.10.19", false);
  const sums = "https://github.com/quarto-dev/quarto-cli/releases/download/v1.10.19/quarto-1.10.19-checksums.txt";
  release.assets.push({ name: "quarto-1.10.19-checksums.txt", size: 100, browser_download_url: sums });
  old.net.routes[QUARTO_RELEASE] = json(release);
  old.net.routes[sums] = () => new Response(Object.entries(PACKAGES).map(([name, data]) => `${sha(data)}  ${name}`).join("\n"));
  assert.equal((await old.get("quarto")).phase, "done");
});

test("what is downloaded is the version the user was shown", async () => {
  const t = setup();
  await assert.rejects(t.svc.download("quarto", "1.9.36"), /最新版本已经变成 1\.10\.19 了，请重新查看/);
  await assert.rejects(t.svc.download("quarto", "../../x"), /版本号不对/);
  assert.equal(t.events.length, 0);
  // Shown 1.10.19; a newer release appears before the click: 1.10.19 is still what is fetched.
  await t.svc.offer("quarto");
  t.net.routes[QUARTO_RELEASE] = json(quartoRelease("1.10.20"));
  await t.svc.download("quarto", "1.10.19");
  assert.deepEqual([(await t.ended("quarto")).version, (await t.svc.state()).quarto.map((q) => q.version)], ["1.10.19", ["1.10.19"]]);
});

test("updating replaces the older copy; a copy can be deleted; only sikeoop's own folders are touched", async () => {
  const t = setup();
  for (const v of ["1.9.36", "1.4.550"]) {
    mkdirSync(path.join(t.quartoDir, v, "bin"), { recursive: true });
    writeFileSync(path.join(t.quartoDir, v, "bin", "quarto"), "old");
  }
  mkdirSync(path.join(t.quartoDir, "notes"), { recursive: true });
  mkdirSync(path.join(t.quartoDir, "1.2.3"), { recursive: true });
  mkdirSync(path.join(t.quartoDir, ".staging-1.10.19-dead", "bin"), { recursive: true });
  assert.deepEqual((await t.svc.managedQuarto()).map((q) => q.version), ["1.9.36", "1.4.550"], "newest first; folders without Quarto in them don't count");
  assert.equal((await t.svc.offer("quarto")).have, undefined);

  await t.svc.removeQuarto("1.4.550");
  assert.equal(existsSync(path.join(t.quartoDir, "1.4.550")), false);
  await assert.rejects(t.svc.removeQuarto("1.4.550"), /没有 sikeoop 下载的 Quarto 1\.4\.550/);
  for (const bad of ["..", "../../x", "notes", ".downloads", "1.2.3", "", 5]) await assert.rejects(t.svc.removeQuarto(bad), /版本号不对|没有 sikeoop 下载的/, String(bad));
  assert.equal(existsSync(path.join(t.quartoDir, "notes")), true);

  assert.equal((await t.get("quarto")).phase, "done");
  assert.deepEqual((await t.svc.managedQuarto()).map((q) => q.version), ["1.10.19"], "the older copy went when the new one was in place");
  assert.deepEqual(readdirSync(t.quartoDir).sort(), [".downloads", "1.10.19", "1.2.3", "notes"], "what an unfinished unpacking left is cleared; other folders are not touched");
  assert.deepEqual((await t.svc.removeQuarto("1.10.19")).quarto, []);
  assert.deepEqual((await t.svc.state()).tasks, [], "the finished download of what was deleted is forgotten");
});

test("Zotero: the installer comes from zotero.org, is saved to Downloads and handed to the system; nothing is installed silently", async () => {
  const t = setup();
  const offer = await t.svc.offer("zotero");
  assert.deepEqual([offer.version, offer.file, offer.size, offer.checksum, offer.license, offer.url], ["10.0.6", "Zotero-10.0.6.dmg", 3000, false, "AGPL-3.0", `${ZOTERO_FILE}Zotero-10.0.6.dmg`]);
  assert.match(offer.where, /下完自动打开安装包，安装由你自己完成/);
  assert.deepEqual(t.net.calls.map((c) => c.method), ["HEAD", "HEAD"], "the size is asked for, the file is not fetched");
  assert.deepEqual(readdirSync(t.downloads), []);

  await t.svc.download("zotero", offer.version);
  const done = await t.ended("zotero");
  const file = path.join(t.downloads, "Zotero-10.0.6.dmg");
  assert.deepEqual([done.phase, done.path, done.opened], ["done", file, true]);
  assert.deepEqual(t.phases("zotero"), ["downloading", "done"], "no checksum is published for it: only the size is checked");
  assert.deepEqual([readFileSync(file).equals(DMG), readdirSync(t.downloads), t.opened], [true, ["Zotero-10.0.6.dmg"], [file]]);
  assert.deepEqual(t.hosts(), ["www.zotero.org", "download.zotero.org"]);
  assert.deepEqual(t.ran, [], "nothing is run");
  await t.svc.open("zotero");
  await t.svc.reveal("zotero");
  assert.deepEqual([t.opened, t.revealed], [[file, file], [file]]);

  // The same file is there already: used again without downloading.
  const gets = t.net.calls.filter((c) => c.method === "GET").length;
  assert.equal((await t.get("zotero")).path, file);
  assert.equal(t.net.calls.filter((c) => c.method === "GET").length, gets);
  // A different file of that name is the user's: left alone.
  writeFileSync(file, "something else");
  const second = await t.get("zotero");
  assert.equal(second.path, path.join(t.downloads, "Zotero-10.0.6 (2).dmg"));
  assert.deepEqual([readFileSync(file, "utf8"), readFileSync(second.path!).equals(DMG)], ["something else", true]);
});

test("Zotero: a download address that leads anywhere else is refused; a Linux archive is not opened", async () => {
  const t = setup();
  t.net.routes[`${ZOTERO_PAGE}mac`] = redirect("https://evil.example/Zotero-10.0.6.dmg");
  await assert.rejects(t.svc.offer("zotero"), /evil\.example 不在允许访问的地址里/);
  t.net.routes[`${ZOTERO_PAGE}mac`] = redirect("https://download.zotero.org/client/release/10.0.6/setup.sh");
  t.net.routes["https://download.zotero.org/client/release/10.0.6/setup.sh"] = serve(DMG);
  await assert.rejects(t.svc.offer("zotero"), /不是预期的样子/);
  assert.equal(t.net.calls.some((c) => c.url.includes("evil")), false);
  t.net.routes[`${ZOTERO_PAGE}mac`] = redirect(`${ZOTERO_FILE}Zotero-10.0.6.dmg`);
  t.net.routes[`${ZOTERO_FILE}Zotero-10.0.6.dmg`] = () => new Response(null, { status: 200 });
  await assert.rejects(t.svc.offer("zotero"), /没有说安装包有多大/, "no checksum and no size: nothing to check a download against");

  const cut = setup();
  cut.net.routes[`${ZOTERO_FILE}Zotero-10.0.6.dmg`] = serve(DMG, { endAfter: 1000 });
  const failed = await cut.get("zotero");
  assert.deepEqual([failed.phase, failed.resumable, cut.opened, readdirSync(cut.downloads)], ["failed", true, [], ["Zotero-10.0.6.dmg.part"]], "a file that isn't whole is never opened");
  cut.net.routes[`${ZOTERO_FILE}Zotero-10.0.6.dmg`] = serve(DMG);
  await cut.svc.download("zotero", "10.0.6");
  assert.equal((await cut.ended("zotero")).phase, "done");
  assert.deepEqual([cut.net.calls.at(-1)?.range, readdirSync(cut.downloads), cut.opened.length], ["bytes=1000-", ["Zotero-10.0.6.dmg"], 1], "the next try continues, and only the whole file is opened");

  const linux = setup({ platform: "linux" });
  const offer = await linux.svc.offer("zotero");
  assert.match(offer.where, /压缩包，要你自己解压/);
  const done = await linux.get("zotero");
  assert.deepEqual([done.phase, done.opened, linux.opened], ["done", undefined, []]);
  await assert.rejects(linux.svc.open("zotero"), /不是可以直接打开的安装包/);
});

test("Better BibTeX: the plugin file is checked against its SHA-256 and saved for the user to install", async () => {
  const t = setup();
  const offer = await t.svc.offer("bbt");
  assert.deepEqual([offer.version, offer.file, offer.size, offer.checksum, offer.license, offer.note], ["9.0.71", "zotero-better-bibtex-9.0.71.xpi", XPI.length, true, "MIT", "This release is compatible with Zotero 8 and Zotero 9 beta."]);
  await assert.rejects(t.svc.reveal("bbt"), /还没有下载好的文件/);
  await t.svc.download("bbt", offer.version);
  const done = await t.ended("bbt");
  const file = path.join(t.downloads, "zotero-better-bibtex-9.0.71.xpi");
  assert.deepEqual([done.phase, done.path, done.opened, readFileSync(file).equals(XPI)], ["done", file, undefined, true]);
  assert.deepEqual(t.phases("bbt"), ["downloading", "verifying", "done"]);
  assert.deepEqual(t.opened, [], "the plugin is installed from inside Zotero, not opened");
  await assert.rejects(t.svc.open("bbt"), /不是可以直接打开的安装包/);
  await t.svc.reveal("bbt");
  assert.deepEqual(t.revealed, [file]);

  const bad = setup();
  bad.net.routes[cdn("bbt")] = serve(Buffer.from(XPI.toString("latin1").replace("pretend", "PRETEND"), "latin1"));
  const failed = await bad.get("bbt");
  assert.match(failed.error ?? "", /校验不通过/);
  assert.deepEqual(readdirSync(bad.downloads), [], "the file that failed the check is not kept");
});

test("whether Zotero looks installed, and each tool's download is independent", async () => {
  const t = setup();
  assert.equal((await t.svc.state()).zoteroInstalled, false);
  t.installed.add("/Users/me/Applications/Zotero.app");
  const state = await t.svc.state();
  assert.deepEqual([state.zoteroInstalled, state.downloads, state.tasks], [true, t.downloads, []]);
  const [a, b] = await Promise.all([t.get("bbt"), t.get("zotero")]);
  assert.deepEqual([a.phase, b.phase, (await t.svc.state()).tasks.map((x) => x.tool).sort()], ["done", "done", ["bbt", "zotero"]]);
  t.svc.cancel("quarto");
  assert.throws(() => t.svc.cancel("other"), /不认识这个工具/);
});
