// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chooseQuarto } from "../../src/main/papers/quarto.ts";
import {
  bbtAsset,
  checksumsAsset,
  compareVersions,
  compatibilityNote,
  expectedSha256,
  opensAsInstaller,
  parseChecksums,
  parseRelease,
  parseZoteroInstaller,
  pickAsset,
  quartoAssetName,
  quartoBinIn,
  zoteroCandidates,
  zoteroDownloadPage,
  zoteroPlatform,
} from "../../src/main/papers/tools-release.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const asset = (name: string, size: number, digest?: string | null) => ({ name, size, browser_download_url: `https://github.com/quarto-dev/quarto-cli/releases/download/v1.10.19/${name}`, digest: digest === undefined ? `sha256:${A}` : digest });

/** The shape GitHub answers with (fields this code doesn't read left out). */
const QUARTO = {
  tag_name: "v1.10.19",
  draft: false,
  prerelease: false,
  body: "**Changelog since last release**",
  assets: [
    asset("changelog.md", 22652),
    asset("quarto-1.10.19-checksums.txt", 1042),
    asset("quarto-1.10.19-linux-amd64.deb", 149526572),
    asset("quarto-1.10.19-linux-amd64.tar.gz", 147020886),
    asset("quarto-1.10.19-linux-arm64.tar.gz", 145751670),
    asset("quarto-1.10.19-macos.pkg", 247698243),
    asset("quarto-1.10.19-macos.tar.gz", 247498232, `SHA256:${B.toUpperCase()}`),
    asset("quarto-1.10.19-win.msi", 148041728),
    asset("quarto-1.10.19-win.zip", 148269697),
    asset("quarto-1.10.19.tar.gz", 113461248),
  ],
};

test("a release is read: version from the tag, each asset with its size and SHA-256", () => {
  const r = parseRelease(QUARTO);
  assert.equal(r.version, "1.10.19");
  assert.equal(r.assets.length, 10);
  assert.deepEqual(pickAsset(r, "quarto-1.10.19-macos.tar.gz"), { name: "quarto-1.10.19-macos.tar.gz", url: "https://github.com/quarto-dev/quarto-cli/releases/download/v1.10.19/quarto-1.10.19-macos.tar.gz", size: 247498232, sha256: B });
  assert.equal(checksumsAsset(r)?.name, "quarto-1.10.19-checksums.txt");
  assert.throws(() => pickAsset(r, "quarto-1.10.19-solaris.tar.gz"), /发布里没有/);
});

test("a release that isn't a plain final version, or isn't a release at all, is refused", () => {
  for (const bad of [null, "text", {}, { tag_name: 5 }, { message: "Not Found" }]) assert.throws(() => parseRelease(bad), /看不懂/);
  // The version names a folder later: nothing but digits and dots gets through.
  for (const tag of ["v1.10.19-rc1", "../../etc", "v1.10/../..", "latest", "v1"]) assert.throws(() => parseRelease({ tag_name: tag, assets: [] }), /不是正式版的写法/, tag);
  assert.throws(() => parseRelease({ ...QUARTO, prerelease: true }), /还不是正式版/);
  assert.throws(() => parseRelease({ ...QUARTO, draft: true }), /还不是正式版/);
  const odd = parseRelease({ tag_name: "v2.0.0", assets: [null, { name: "a/b.zip", browser_download_url: "https://github.com/x" }, { name: "no-url.zip" }, { name: "ok.zip", browser_download_url: "https://github.com/x", digest: "md5:abc", size: -1 }] });
  assert.deepEqual(odd.assets, [{ name: "ok.zip", url: "https://github.com/x", size: 0 }], "assets it can't use are left out; a digest that isn't SHA-256 is not taken as one");
});

test("the Quarto package for each kind of computer", () => {
  const name = (platform: NodeJS.Platform, arch: string) => quartoAssetName("1.10.19", platform, arch);
  assert.equal(name("darwin", "arm64"), "quarto-1.10.19-macos.tar.gz");
  assert.equal(name("darwin", "x64"), "quarto-1.10.19-macos.tar.gz");
  assert.equal(name("win32", "x64"), "quarto-1.10.19-win.zip");
  assert.equal(name("win32", "arm64"), "quarto-1.10.19-win.zip");
  assert.equal(name("linux", "x64"), "quarto-1.10.19-linux-amd64.tar.gz");
  assert.equal(name("linux", "arm64"), "quarto-1.10.19-linux-arm64.tar.gz");
  for (const [platform, arch] of [["win32", "ia32"], ["linux", "arm"], ["freebsd", "x64"]] as const) assert.throws(() => name(platform, arch), /没有给这种电脑/);
  assert.throws(() => quartoAssetName("../1", "darwin", "arm64"), /版本号不对/);
  // Every name this code can ask for is in a real release.
  const r = parseRelease(QUARTO);
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "x64"], ["linux", "arm64"]] as const) assert.ok(pickAsset(r, name(platform, arch)));
});

test("the checksum comes from GitHub's digest or the release's checksums file, and the two must agree", () => {
  const sums = parseChecksums(
    [`${A}  quarto-1.10.19-win.zip`, `${B.toUpperCase()}  quarto-1.10.19-macos.tar.gz`, `${A} *quarto-1.10.19-linux-amd64.tar.gz`, "", "not a line", "abc  short-hash.zip"].join("\r\n"),
  );
  assert.deepEqual([...sums], [["quarto-1.10.19-win.zip", A], ["quarto-1.10.19-macos.tar.gz", B], ["quarto-1.10.19-linux-amd64.tar.gz", A]]);
  const one = (sha256?: string) => ({ name: "quarto-1.10.19-win.zip", url: "u", size: 1, ...(sha256 ? { sha256 } : {}) });
  assert.equal(expectedSha256(one(A)), A);
  assert.equal(expectedSha256(one(), sums), A, "no digest: the checksums file");
  assert.equal(expectedSha256(one(A), sums), A);
  assert.throws(() => expectedSha256(one(B), sums), /两处校验值对不上/);
  assert.throws(() => expectedSha256(one()), /没有公布校验值/);
  assert.throws(() => expectedSha256({ name: "other.zip", url: "u", size: 1 }, sums), /没有公布校验值/);
});

test("Better BibTeX's release: the one .xpi and what it says about Zotero versions", () => {
  const r = parseRelease({
    tag_name: "v9.0.71",
    body: "This release is compatible with Zotero 8 and Zotero 9 beta. Per BBT 8.0.26, Zotero 7 is no longer supported.\n\nIf you use Firefox, make sure to right-click and save the XPI file.",
    assets: [{ name: "zotero-better-bibtex-9.0.71.xpi", size: 29603572, browser_download_url: "https://github.com/retorquere/zotero-better-bibtex/releases/download/v9.0.71/zotero-better-bibtex-9.0.71.xpi", digest: `sha256:${A}` }],
  });
  assert.deepEqual([bbtAsset(r).name, bbtAsset(r).size, bbtAsset(r).sha256], ["zotero-better-bibtex-9.0.71.xpi", 29603572, A]);
  assert.equal(compatibilityNote(r.notes), "This release is compatible with Zotero 8 and Zotero 9 beta. Per BBT 8.0.26, Zotero 7 is no longer supported.");
  assert.equal(compatibilityNote("Bug fixes."), undefined);
  assert.throws(() => bbtAsset(parseRelease({ tag_name: "v1.0.0", assets: [] })), /没有找到 Better BibTeX/);
  assert.throws(() => bbtAsset(parseRelease({ tag_name: "v1.0.0", assets: [{ name: "evil.xpi", browser_download_url: "https://github.com/x" }] })), /没有找到 Better BibTeX/);
});

test("versions are compared by their numbers", () => {
  assert.equal(compareVersions("1.10.19", "1.9.36"), 1);
  assert.equal(compareVersions("1.4", "1.4.0"), 0);
  assert.equal(compareVersions("v1.5.57", "1.5.57"), 0);
  assert.equal(compareVersions("1.3.450", "1.4.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.6.0-rc1", "1.6.0"), 0);
  assert.deepEqual(["1.4.550", "1.10.19", "1.9.36"].sort(compareVersions), ["1.4.550", "1.9.36", "1.10.19"]);
});

test("the user's own Quarto comes first; sikeoop's copy only when theirs is missing or too old", () => {
  const user = (version: string) => ({ path: "/usr/local/bin/quarto", version });
  const ours = (version: string) => ({ path: `/data/tools/quarto/${version}/bin/quarto`, version });
  assert.deepEqual(chooseQuarto(user("1.5.57"), [ours("1.10.19")]), user("1.5.57"), "theirs can do everything: it is used, even though ours is newer");
  assert.deepEqual(chooseQuarto(null, [ours("1.9.36"), ours("1.10.19"), ours("1.4.550")]), { ...ours("1.10.19"), managed: true }, "none of their own: our newest");
  assert.deepEqual(chooseQuarto(user("1.3.450"), [ours("1.10.19")]), { ...ours("1.10.19"), managed: true }, "theirs can't make PDF: ours");
  assert.deepEqual(chooseQuarto(user("1.3.450"), []), user("1.3.450"), "theirs is old but all there is");
  assert.deepEqual(chooseQuarto(user("1.3.450"), [ours("1.2.0")]), user("1.3.450"));
  assert.equal(chooseQuarto(null, []), null);
});

test("Zotero's download address for each kind of computer, and what it leads to", () => {
  assert.deepEqual(
    [zoteroPlatform("darwin", "arm64"), zoteroPlatform("darwin", "x64"), zoteroPlatform("win32", "x64"), zoteroPlatform("win32", "arm64"), zoteroPlatform("win32", "ia32"), zoteroPlatform("linux", "x64"), zoteroPlatform("linux", "arm64")],
    ["mac", "mac", "win-x64", "win-arm64", "win32", "linux-x86_64", "linux-arm64"],
  );
  assert.throws(() => zoteroPlatform("linux", "arm"), /没有给这种电脑/);
  assert.equal(zoteroDownloadPage("darwin", "arm64"), "https://www.zotero.org/download/client/dl?channel=release&platform=mac");
  assert.deepEqual(parseZoteroInstaller("https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6.dmg"), { version: "10.0.6", file: "Zotero-10.0.6.dmg" });
  assert.deepEqual(parseZoteroInstaller("https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6_x64_setup.exe"), { version: "10.0.6", file: "Zotero-10.0.6_x64_setup.exe" });
  assert.deepEqual(parseZoteroInstaller("https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6_linux-x86_64.tar.xz"), { version: "10.0.6", file: "Zotero-10.0.6_linux-x86_64.tar.xz" });
  for (const bad of [
    "https://evil.example/client/release/10.0.6/Zotero-10.0.6.dmg",
    "https://download.zotero.org/client/release/10.0.6/evil.dmg",
    "https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6.sh",
    "https://download.zotero.org/client/release/..%2F..%2Fx/Zotero-10.0.6.dmg",
    "https://download.zotero.org/client/release/10.0.6/Zotero-..%2Fx.dmg",
    "https://download.zotero.org/other/Zotero-10.0.6.dmg",
    "https://www.zotero.org/download/",
  ])
    assert.throws(() => parseZoteroInstaller(bad), /不是预期的样子/, bad);
  assert.deepEqual([opensAsInstaller("Zotero-10.0.6.dmg"), opensAsInstaller("Zotero-10.0.6_x64_setup.exe"), opensAsInstaller("Zotero-10.0.6_linux-x86_64.tar.xz")], [true, true, false]);
});

test("where Zotero and an unpacked Quarto are looked for", () => {
  assert.deepEqual(zoteroCandidates("darwin", {}, "/Users/me"), ["/Applications/Zotero.app", "/Users/me/Applications/Zotero.app"]);
  assert.deepEqual(zoteroCandidates("win32", { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me"), [
    "C:\\Program Files\\Zotero\\zotero.exe",
    "C:\\Users\\me\\AppData\\Local\\Zotero\\zotero.exe",
    "C:\\Users\\me\\AppData\\Local\\Programs\\Zotero\\zotero.exe",
  ]);
  const linux = zoteroCandidates("linux", { PATH: "/usr/bin:relative:/home/me/bin" }, "/home/me");
  assert.deepEqual(linux.slice(0, 3), ["/usr/bin/zotero", "/home/me/bin/zotero", "/opt/zotero/zotero"]);
  assert.ok(linux.includes("/home/me/Zotero/zotero"));
  assert.equal(quartoBinIn("/data/tools/quarto/1.10.19", "darwin"), path.join("/data/tools/quarto/1.10.19", "bin", "quarto"));
  assert.equal(quartoBinIn("/data/tools/quarto/1.10.19", "win32"), path.join("/data/tools/quarto/1.10.19", "bin", "quarto.exe"), "Windows runs the .exe, not the .cmd beside it");
});
