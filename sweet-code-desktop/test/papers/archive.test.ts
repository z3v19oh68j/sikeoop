// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { extractTarGz, extractZip, linkStaysInside, safeEntryPath } from "../../src/main/papers/archive.ts";
import { type TarEntry, type ZipItem, gnuLongName, pax, tar, tgz, zip } from "./archive-fixtures.ts";

/** A folder with the archive in it, an empty folder to unpack into, and a file outside that must stay as it is. */
function place(archive: Buffer, name: string) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-archive-")));
  const file = path.join(base, name);
  const dest = path.join(base, "out");
  writeFileSync(file, archive);
  mkdirSync(dest);
  writeFileSync(path.join(base, "outside.txt"), "untouched");
  return { base, file, dest, read: (rel: string) => readFileSync(path.join(dest, rel), "utf8"), outside: () => [readFileSync(path.join(base, "outside.txt"), "utf8"), readdirSync(base).sort()] as const };
}
const untar = (entries: TarEntry[]) => {
  const p = place(tgz(entries), "a.tar.gz");
  return { ...p, done: extractTarGz(p.file, p.dest, { windows: false }) };
};
const unzip = (items: ZipItem[]) => {
  const p = place(zip(items), "a.zip");
  return { ...p, done: extractZip(p.file, p.dest) };
};
const CLEAN = ["untouched", ["a.tar.gz", "out", "outside.txt"]];

test("an entry's name becomes folders inside the target, or is refused", () => {
  assert.deepEqual(safeEntryPath("./bin/quarto"), ["bin", "quarto"]);
  assert.deepEqual(safeEntryPath("quarto-1.10.19/share//version"), ["quarto-1.10.19", "share", "version"]);
  assert.deepEqual(safeEntryPath("./"), [], "the archive's own root");
  for (const bad of ["../x", "a/../../x", "a/..", "/etc/passwd", "", "a\0b"]) assert.throws(() => safeEntryPath(bad), /压缩包/, bad);
  // A backslash is an ordinary character on macOS and Linux, a separator on Windows.
  assert.deepEqual(safeEntryPath("a\\b"), ["a\\b"]);
  assert.deepEqual(safeEntryPath("bin\\quarto.exe", true), ["bin", "quarto.exe"]);
  for (const bad of ["..\\x", "a\\..\\..\\x", "C:\\Windows\\x", "c:x", "\\\\server\\share", "a/b:stream", "a./b", "a /b"]) assert.throws(() => safeEntryPath(bad, true), /压缩包/, bad);
});

test("a link may only point inside the folder", () => {
  assert.equal(linkStaysInside(["bin", "tools", "deno"], "../../share/deno"), true);
  assert.equal(linkStaysInside(["bin", "quarto"], "tools/quarto"), true);
  assert.equal(linkStaysInside(["quarto"], ".."), false);
  assert.equal(linkStaysInside(["bin", "quarto"], "../../outside"), false);
  assert.equal(linkStaysInside(["bin", "quarto"], "a/../../../x"), false);
  assert.equal(linkStaysInside(["bin", "quarto"], "/usr/bin/env"), false);
  assert.equal(linkStaysInside(["bin", "quarto"], "C:\\x"), false);
  assert.equal(linkStaysInside(["bin", "quarto"], ""), false);
});

test("a tar.gz is unpacked: folders, files with their run bit, links, long names", async () => {
  const long = "share/" + "deep/".repeat(30) + "file.txt";
  const t = untar([
    { name: "./", type: "5" },
    { name: "./bin/", type: "5" },
    { name: "./bin/quarto", data: "#!/bin/sh\necho 1.10.19\n", mode: 0o755 },
    { name: "./share/version", data: "1.10.19" },
    { name: "./bin/q", type: "2", link: "quarto" },
    { name: "./share/copy", type: "1", link: "share/version" },
    gnuLongName(long),
    { name: long.slice(0, 100), data: "long" },
    pax({ path: "share/名字.txt" }),
    { name: "share/x.txt", data: "pax" },
    { name: "version", prefix: "share/prefixed", data: "p" },
    { name: "share/big.bin", data: Buffer.alloc(70_000, 7) },
    { name: "share/empty", data: "" },
  ]);
  assert.deepEqual(await t.done, { files: 7, bytes: 23 + 7 + 4 + 3 + 1 + 70_000 });
  assert.equal(t.read("bin/quarto"), "#!/bin/sh\necho 1.10.19\n");
  assert.equal(statSync(path.join(t.dest, "bin/quarto")).mode & 0o777, 0o755);
  assert.equal(statSync(path.join(t.dest, "share/version")).mode & 0o777, 0o644);
  assert.equal(readlinkSync(path.join(t.dest, "bin/q")), "quarto");
  assert.deepEqual([t.read("share/copy"), t.read(long), t.read("share/名字.txt"), t.read("share/prefixed/version"), t.read("share/empty")], ["1.10.19", "long", "pax", "p", ""]);
  assert.equal(readFileSync(path.join(t.dest, "share/big.bin")).length, 70_000);
  assert.equal(existsSync(path.join(t.dest, "share/x.txt")), false, "the pax name replaces the short one");
});

test("a tar.gz can't put anything outside the folder", async () => {
  const refused: [string, TarEntry[], RegExp][] = [
    ["a parent path", [{ name: "../evil.txt", data: "x" }], /上级文件夹/],
    ["a parent path further in", [{ name: "a/../../evil.txt", data: "x" }], /上级文件夹/],
    ["an absolute path", [{ name: "/tmp/sikeoop-evil.txt", data: "x" }], /绝对路径/],
    ["a long name going up", [gnuLongName("../evil.txt"), { name: "ok.txt", data: "x" }], /上级文件夹/],
    ["a pax name going up", [pax({ path: "../evil.txt" }), { name: "ok.txt", data: "x" }], /上级文件夹/],
    ["a link to outside", [{ name: "out", type: "2", link: ".." }], /指向外面的链接/],
    ["an absolute link", [{ name: "out", type: "2", link: "/etc" }], /指向外面的链接/],
    ["writing through a link", [{ name: "sub/", type: "5" }, { name: "sub/up", type: "2", link: "." }, { name: "sub/up/x.txt", data: "x" }], /通过链接写文件/],
    ["a hard link to a file that isn't in the archive", [{ name: "h", type: "1", link: "nothing" }], /不存在文件的链接/],
    ["a hard link going up", [{ name: "h", type: "1", link: "../outside.txt" }], /上级文件夹/],
    ["a device", [{ name: "dev", type: "3" }], /不该出现的内容/],
    ["a damaged header", [{ name: "a.txt", data: "x", badChecksum: true }], /文件头校验不对/],
  ];
  for (const [what, entries, message] of refused) {
    const t = untar(entries);
    await assert.rejects(t.done, message, what);
    assert.deepEqual(t.outside(), CLEAN, what);
  }
  // A link whose own text stays inside, then a second one through it: the write is refused, nothing is followed.
  const chained = untar([{ name: "a/", type: "5" }, { name: "a/x", type: "2", link: ".." }, { name: "b", type: "2", link: "a/x/.." }, { name: "b/evil.txt", data: "x" }]);
  await assert.rejects(chained.done, /通过链接写文件/);
  assert.deepEqual(chained.outside(), CLEAN);
});

test("a tar.gz that is cut off, too big, or stopped is reported", async () => {
  const whole = tgz([{ name: "a.txt", data: Buffer.alloc(5000, 1) }]);
  const cut = place(whole.subarray(0, whole.length - 20), "a.tar.gz");
  await assert.rejects(extractTarGz(cut.file, cut.dest), /压缩包不完整或已损坏/);
  // The gzip is whole, the tar inside it stops in the middle of a file.
  const short = place(zlib.gzipSync(tar([{ name: "a.txt", data: Buffer.alloc(5000, 1) }]).subarray(0, 1024)), "a.tar.gz");
  await assert.rejects(extractTarGz(short.file, short.dest), /压缩包不完整/);
  const nothing = untar([]);
  assert.deepEqual(await nothing.done, { files: 0, bytes: 0 });
  const many = place(tgz([{ name: "1", data: "a" }, { name: "2", data: "b" }, { name: "3", data: "c" }]), "a.tar.gz");
  await assert.rejects(extractTarGz(many.file, many.dest, { maxEntries: 2 }), /多得不正常/);
  const heavy = place(tgz([{ name: "1", data: Buffer.alloc(2000) }]), "a.tar.gz");
  await assert.rejects(extractTarGz(heavy.file, heavy.dest, { maxBytes: 1000 }), /大得不正常/);
  const stopped = place(tgz([{ name: "1", data: "a" }]), "a.tar.gz");
  await assert.rejects(extractTarGz(stopped.file, stopped.dest, { signal: AbortSignal.abort() }), /已取消/);
  assert.deepEqual(readdirSync(stopped.dest), []);
});

test("a zip is unpacked: deflated and stored files, folders, Windows' separators", async () => {
  const t = unzip([
    { name: "bin/", data: "" },
    { name: "bin/quarto.cmd", data: "@echo off\r\n" },
    { name: "bin/quarto.exe", data: Buffer.alloc(50_000, 9) },
    { name: "share\\version", data: "1.10.19", store: true },
    { name: "share/empty.txt", data: "" },
    { name: "tools/run.sh", data: "#!/bin/sh\n", unixMode: 0o100755 },
  ]);
  assert.deepEqual(await t.done, { files: 5, bytes: 11 + 50_000 + 7 + 10 });
  assert.deepEqual([t.read("bin/quarto.cmd"), t.read("share/version"), t.read("share/empty.txt")], ["@echo off\r\n", "1.10.19", ""]);
  assert.equal(readFileSync(path.join(t.dest, "bin/quarto.exe")).length, 50_000);
  assert.equal(statSync(path.join(t.dest, "tools/run.sh")).mode & 0o777, 0o755);
  assert.equal(lstatSync(path.join(t.dest, "bin")).isDirectory(), true);
});

test("a zip can't put anything outside the folder, and a damaged one is refused", async () => {
  const CLEAN_ZIP = ["untouched", ["a.zip", "out", "outside.txt"]];
  const refused: [string, ZipItem[], RegExp][] = [
    ["a parent path", [{ name: "../evil.txt", data: "x" }], /上级文件夹/],
    ["a parent path with backslashes", [{ name: "..\\evil.txt", data: "x" }], /上级文件夹/],
    ["an absolute path", [{ name: "/tmp/sikeoop-evil.txt", data: "x" }], /绝对路径/],
    ["a drive letter", [{ name: "C:\\evil.txt", data: "x" }], /绝对路径/],
    ["another stream of a file", [{ name: "a.txt:hidden", data: "x" }], /Windows 不能安全处理/],
    ["a link", [{ name: "l", data: "../outside.txt", unixMode: 0o120777 }], /有链接/],
    ["an encrypted file", [{ name: "a.txt", data: "x", flags: 1 }], /加密/],
    ["a wrong checksum", [{ name: "a.txt", data: "hello", badCrc: true }], /解出来和记录的不一样/],
    ["a name used as file and folder", [{ name: "a", data: "x" }, { name: "a/b.txt", data: "y" }], /既是文件又是文件夹/],
  ];
  for (const [what, items, message] of refused) {
    const t = unzip(items);
    await assert.rejects(t.done, message, what);
    assert.deepEqual(t.outside(), CLEAN_ZIP, what);
  }
  const notZip = place(Buffer.from("this is not a zip file at all, just some text"), "a.zip");
  await assert.rejects(extractZip(notZip.file, notZip.dest), /不是一个完整的 zip/);
  const whole = zip([{ name: "a.txt", data: "hello" }]);
  const cut = place(whole.subarray(0, whole.length - 30), "a.zip");
  await assert.rejects(extractZip(cut.file, cut.dest));
  const stopped = place(whole, "a.zip");
  await assert.rejects(extractZip(stopped.file, stopped.dest, { signal: AbortSignal.abort() }), /已取消/);
});
