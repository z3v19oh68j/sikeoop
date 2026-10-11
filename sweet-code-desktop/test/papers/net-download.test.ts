// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cancelled, allowedUrl, downloadTo, getJson, getText, headOf, requestAllowed, sha256File } from "../../src/main/papers/net-download.ts";
import { fakeNet, json, redirect, serve, type ServeOptions } from "./net-fixtures.ts";

const HOSTS = ["github.com", "release-assets.githubusercontent.com"];
const URL_ = "https://github.com/quarto-dev/quarto-cli/releases/download/v1/q.tar.gz";
const CDN = "https://release-assets.githubusercontent.com/asset/1?sig=abc";
const DATA = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) % 251));

function setup(options: ServeOptions = {}, existing?: Buffer) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-dl-")));
  const part = path.join(dir, "q.tar.gz.part");
  if (existing) writeFileSync(part, existing);
  const net = fakeNet({ [URL_]: redirect(CDN), [CDN]: serve(DATA, options) });
  const seen: [number, number][] = [];
  const go = (extra: { total?: number; signal?: AbortSignal; stallMs?: number } = {}) =>
    downloadTo({ request: net.request, url: URL_, hosts: HOSTS, part, total: extra.total ?? DATA.length, signal: extra.signal ?? new AbortController().signal, stallMs: extra.stallMs, progress: (r, t) => seen.push([r, t]) });
  return { net, part, seen, go, set: (o: ServeOptions) => (net.routes[CDN] = serve(DATA, o)), file: () => readFileSync(part), ranges: () => net.calls.filter((c) => c.url === CDN).map((c) => c.range ?? null) };
}

test("only plain https addresses of the named hosts are asked", () => {
  assert.equal(allowedUrl("https://api.github.com/repos/x", ["api.github.com"]).hostname, "api.github.com");
  for (const bad of ["http://api.github.com/x", "https://api.github.com.evil.example/x", "https://evil.example/api.github.com", "https://user:pw@api.github.com/x", "https://api.github.com:8443/x", "file:///etc/passwd", "ftp://api.github.com/x", "not a url"])
    assert.throws(() => allowedUrl(bad, ["api.github.com"]), /没有访问|下载地址不对/, bad);
});

test("a redirect is followed only to an allowed host, and never asked otherwise", async () => {
  const net = fakeNet({
    "https://github.com/a": redirect(CDN),
    [CDN]: () => new Response("file"),
    "https://github.com/evil": redirect("https://evil.example/malware"),
    "https://github.com/http": redirect("http://github.com/plain"),
    "https://github.com/relative": redirect("/a", 307),
    "https://github.com/loop": redirect("https://github.com/loop"),
    "https://evil.example/malware": () => new Response("bad"),
  });
  const ok = await requestAllowed(net.request, "https://github.com/a", HOSTS);
  assert.deepEqual([ok.url, await ok.res.text()], [CDN, "file"]);
  assert.equal((await requestAllowed(net.request, "https://github.com/relative", HOSTS)).url, CDN, "a relative address is read from where it was given");
  await assert.rejects(requestAllowed(net.request, "https://github.com/evil", HOSTS), /evil\.example 不在允许访问的地址里/);
  await assert.rejects(requestAllowed(net.request, "https://github.com/http", HOSTS), /只从 https 地址下载/);
  await assert.rejects(requestAllowed(net.request, "https://github.com/loop", HOSTS), /转了太多次/);
  await assert.rejects(requestAllowed(net.request, "https://evil.example/malware", HOSTS), /不在允许访问的地址里/);
  assert.equal(net.calls.some((c) => c.url.includes("evil.example") || c.url.startsWith("http://")), false, "the refused addresses were never contacted");
});

test("small answers: JSON, a rate limit said plainly, and a file's size without downloading it", async () => {
  const net = fakeNet({
    "https://api.github.com/ok": json({ tag_name: "v1.0.0" }),
    "https://api.github.com/limited": () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    "https://api.github.com/html": () => new Response("<html>"),
    "https://github.com/file": redirect(CDN),
    [CDN]: serve(DATA),
  });
  assert.deepEqual(await getJson(net.request, "https://api.github.com/ok", ["api.github.com"]), { tag_name: "v1.0.0" });
  await assert.rejects(getJson(net.request, "https://api.github.com/limited", ["api.github.com"]), /限制了查询次数/);
  await assert.rejects(getJson(net.request, "https://api.github.com/missing", ["api.github.com"]), /api\.github\.com 返回 404/);
  await assert.rejects(getJson(net.request, "https://api.github.com/html", ["api.github.com"]), /不是预期的格式/);
  assert.equal(await getText(net.request, "https://api.github.com/html", ["api.github.com"]), "<html>");
  assert.deepEqual(await headOf(net.request, "https://github.com/file", HOSTS), { url: CDN, size: 5000 });
  assert.deepEqual(net.calls.at(-1), { url: CDN, method: "HEAD" });
});

test("a file is downloaded whole, with progress up to its size", async () => {
  const t = setup();
  assert.equal(await t.go(), 5000);
  assert.deepEqual(t.file(), DATA);
  assert.deepEqual([t.seen[0], t.seen.at(-1)], [[0, 5000], [5000, 5000]]);
  assert.deepEqual(t.ranges(), [null]);
  // Asked again with the whole file there: nothing is requested.
  assert.equal(await t.go(), 5000);
  assert.equal(t.net.calls.length, 2);
});

test("a download that broke off is continued from where it stopped", async () => {
  const t = setup({ breakAfter: 1200 });
  await assert.rejects(t.go(), /socket hang up/);
  assert.equal(t.file().length, 1200, "what arrived is kept");
  t.set({ endAfter: 800 });
  await assert.rejects(t.go(), /下载中断了（收到 2000 \/ 5000 字节），再试一次会接着下/);
  t.set({});
  assert.equal(await t.go(), 5000);
  assert.deepEqual(t.file(), DATA, "the pieces make the same file");
  assert.deepEqual(t.ranges(), [null, "bytes=1200-", "bytes=2000-"]);
  assert.deepEqual(t.seen.at(-1), [5000, 5000]);
});

test("a server that won't continue starts the file over instead of spoiling it", async () => {
  const ignoring = setup({ ignoreRange: true }, DATA.subarray(0, 700));
  assert.equal(await ignoring.go(), 5000);
  assert.deepEqual(ignoring.file(), DATA, "the whole file again, not appended to the old part");

  // What is on disk is not the start of this file (it is longer than the server's): asked again from the beginning.
  const beyond = setup({}, Buffer.alloc(9000, 1));
  assert.equal(await beyond.go({ total: 0 }), 5000);
  assert.deepEqual(beyond.file(), DATA);
  assert.deepEqual(beyond.ranges(), ["bytes=9000-", null]);

  const tooBig = setup({}, Buffer.alloc(6000, 1));
  assert.equal(await tooBig.go(), 5000, "more than the published size on disk: thrown away first");
  assert.deepEqual(tooBig.ranges(), [null]);
});

test("a size that doesn't match what was published is an error", async () => {
  const bigger = setup();
  await assert.rejects(bigger.go({ total: 4000 }), /比公布的大，已删除/);
  assert.equal(existsSync(bigger.part), false);
  const missing = setup();
  missing.net.routes[CDN] = () => new Response("gone", { status: 404 });
  await assert.rejects(missing.go(), /服务器返回 404/);
  const evil = setup();
  evil.net.routes[URL_] = redirect("https://evil.example/q.tar.gz");
  await assert.rejects(evil.go(), /evil\.example 不在允许访问的地址里/);
  assert.equal(existsSync(evil.part), false);
});

test("stopping ends the download at once; silence for too long ends it too", async () => {
  const t = setup({ hangAfter: 1000 });
  const stop = new AbortController();
  const going = t.go({ signal: stop.signal });
  while (!t.seen.some(([r]) => r === 1000)) await new Promise((r) => setTimeout(r, 2));
  stop.abort();
  await assert.rejects(going, Cancelled);
  await assert.rejects(t.go({ signal: stop.signal }), Cancelled, "already stopped: nothing is asked");
  assert.equal(t.net.calls.length, 2);

  const quiet = setup({ hangAfter: 1000 });
  await assert.rejects(quiet.go({ stallMs: 30 }), /网络太久没有数据/);
  assert.equal(quiet.file().length, 1000, "kept for the next try");
});

test("the SHA-256 of a file", async () => {
  const t = setup();
  await t.go();
  assert.equal(await sha256File(t.part), createHash("sha256").update(DATA).digest("hex"));
  writeFileSync(t.part, "abc");
  assert.equal(await sha256File(t.part), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
