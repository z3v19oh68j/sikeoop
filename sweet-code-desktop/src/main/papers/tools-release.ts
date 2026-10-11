import path from "node:path";

// Where Quarto, Zotero and Better BibTeX are published, and how to read what those places say
// (docs/方案-论文工坊.md §9). Nothing here touches the network or the disk.
//
// Checked against the real services on 2026-10-11 (metadata only):
//   Quarto v1.10.19 assets: quarto-<v>-macos.tar.gz (one file for both chips), quarto-<v>-win.zip,
//   quarto-<v>-linux-amd64.tar.gz, quarto-<v>-linux-arm64.tar.gz, quarto-<v>-checksums.txt
//   ("<sha256>  <file name>" per line). The API gives each asset a `digest` of "sha256:<hex>".
//   Better BibTeX v9.0.71: one asset, zotero-better-bibtex-<v>.xpi, with a digest.
//   Zotero: www.zotero.org/download/client/dl?channel=release&platform=<p> answers 302 to
//   download.zotero.org/client/release/<v>/<file>.

export const GITHUB_API_HOSTS = ["api.github.com"] as const;
/** github.com hands a release download on to one of its file hosts. */
export const GITHUB_DOWNLOAD_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"] as const;
export const ZOTERO_HOSTS = ["www.zotero.org", "download.zotero.org"] as const;

export const QUARTO_RELEASE = "https://api.github.com/repos/quarto-dev/quarto-cli/releases/latest";
export const BBT_RELEASE = "https://api.github.com/repos/retorquere/zotero-better-bibtex/releases/latest";

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  /** Lower-case hex, when GitHub gives one. */
  sha256?: string;
}

export interface Release {
  /** "1.10.19": the tag without its "v". Only digits and dots, so it can name a folder. */
  version: string;
  notes: string;
  assets: ReleaseAsset[];
}

const VERSION = /^\d+(?:\.\d+){1,3}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const isVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);

/** GitHub's answer for one release. Assets it can't make sense of are left out. */
export function parseRelease(json: unknown): Release {
  const r = json as { tag_name?: unknown; body?: unknown; assets?: unknown; draft?: unknown; prerelease?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.tag_name !== "string") throw new Error("GitHub 返回的发布信息看不懂");
  const version = r.tag_name.replace(/^v/, "");
  if (!isVersion(version)) throw new Error(`发布的版本号「${r.tag_name.slice(0, 40)}」不是正式版的写法`);
  if (r.draft === true || r.prerelease === true) throw new Error(`${version} 还不是正式版`);
  const assets: ReleaseAsset[] = [];
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    const { name, size, browser_download_url: url, digest } = (a ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || typeof url !== "string" || path.posix.basename(name) !== name || /[\\\0]/.test(name)) continue;
    const hex = typeof digest === "string" && digest.toLowerCase().startsWith("sha256:") ? digest.slice(7).toLowerCase() : undefined;
    assets.push({ name, url, size: typeof size === "number" && size > 0 ? size : 0, ...(hex && HEX64.test(hex) ? { sha256: hex } : {}) });
  }
  return { version, notes: typeof r.body === "string" ? r.body : "", assets };
}

/** A checksums file: "<sha256>  <file name>" per line (sha256sum's format; a "*" may mark binary mode). */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** The name of Quarto's package for this computer. */
export function quartoAssetName(version: string, platform: NodeJS.Platform, arch: string): string {
  if (!isVersion(version)) throw new Error("版本号不对");
  // One macOS package holds both chips; Windows has x64 only, which Windows on ARM can run.
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `quarto-${version}-macos.tar.gz`;
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `quarto-${version}-win.zip`;
  if (platform === "linux" && arch === "x64") return `quarto-${version}-linux-amd64.tar.gz`;
  if (platform === "linux" && arch === "arm64") return `quarto-${version}-linux-arm64.tar.gz`;
  throw new Error(`Quarto 没有给这种电脑（${platform} ${arch}）发布免安装包，需要你自己安装`);
}

export function pickAsset(release: Release, name: string): ReleaseAsset {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`${release.version} 的发布里没有 ${name}`);
  return asset;
}

export const checksumsAsset = (release: Release): ReleaseAsset | undefined => release.assets.find((a) => /-checksums\.txt$/.test(a.name));

/**
 * The SHA-256 the download has to have: GitHub's own digest of the asset, or the line for it in the
 * release's checksums file. When both are there they must agree. None: nothing is installed.
 */
export function expectedSha256(asset: ReleaseAsset, checksums?: Map<string, string>): string {
  const listed = checksums?.get(asset.name);
  if (asset.sha256 && listed && asset.sha256 !== listed) throw new Error(`${asset.name} 的两处校验值对不上，不下载`);
  const sha = asset.sha256 ?? listed;
  if (!sha) throw new Error(`${asset.name} 没有公布校验值，不下载`);
  return sha;
}

/** The plugin file of a Better BibTeX release. */
export function bbtAsset(release: Release): ReleaseAsset {
  const found = release.assets.filter((a) => /^zotero-better-bibtex-[\d.]+\.xpi$/.test(a.name));
  if (found.length !== 1) throw new Error("这次发布里没有找到 Better BibTeX 的 .xpi 文件");
  return found[0];
}

/** The first line of a release's notes, when it talks about which Zotero it works with. */
export function compatibilityNote(notes: string): string | undefined {
  const line = notes.split(/\r?\n/).map((l) => l.trim()).find((l) => /zotero\s*\d/i.test(l) && /compatib|support/i.test(l));
  return line ? line.slice(0, 240) : undefined;
}

/** Negative when a is older than b. Compares the numbers; anything after them ("-rc1") is ignored. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => (/^\d+(?:\.\d+)*/.exec(v.trim().replace(/^v/, ""))?.[0] ?? "0").split(".").map(Number);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---- Zotero ----

/** zotero.org's name for this computer in its download address. */
export function zoteroPlatform(platform: NodeJS.Platform, arch: string): string {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return arch === "arm64" ? "win-arm64" : arch === "ia32" ? "win32" : "win-x64";
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) return arch === "arm64" ? "linux-arm64" : "linux-x86_64";
  throw new Error(`Zotero 没有给这种电脑（${platform} ${arch}）提供安装包`);
}

export const zoteroDownloadPage = (platform: NodeJS.Platform, arch: string): string =>
  `https://www.zotero.org/download/client/dl?channel=release&platform=${zoteroPlatform(platform, arch)}`;

/** The installer zotero.org sent us to: https://download.zotero.org/client/release/<version>/<file>. */
export function parseZoteroInstaller(finalUrl: string): { version: string; file: string } {
  const u = new URL(finalUrl);
  const m = /^\/client\/release\/([^/]+)\/([^/]+)$/.exec(u.pathname);
  const file = m ? decodeURIComponent(m[2]) : "";
  if (u.hostname !== "download.zotero.org" || !m || !isVersion(m[1]) || !/^Zotero-[\w.-]+\.(dmg|exe|tar\.xz|tar\.bz2)$/.test(file)) throw new Error("zotero.org 给的下载地址不是预期的样子，没有下载");
  return { version: m[1], file };
}

/** Installers the system can be asked to open; a Linux archive is unpacked by the user. */
export const opensAsInstaller = (file: string): boolean => /\.(dmg|exe)$/i.test(file);

/** Where Zotero usually is once installed. Not finding it there doesn't prove it isn't installed. */
export function zoteroCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string[] {
  if (platform === "darwin") return ["/Applications/Zotero.app", path.posix.join(home, "Applications", "Zotero.app")];
  if (platform === "win32") {
    const p = path.win32;
    const bases = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA, env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, "Programs")];
    return bases.filter((b): b is string => !!b).map((b) => p.join(b, "Zotero", "zotero.exe"));
  }
  const p = path.posix;
  const onPath = (env.PATH ?? "").split(":").filter((d) => p.isAbsolute(d)).map((d) => p.join(d, "zotero"));
  const usual = ["/opt/zotero/zotero", "/usr/lib/zotero/zotero", p.join(home, "Zotero", "zotero"), p.join(home, "zotero", "zotero"), "/var/lib/flatpak/exports/bin/org.zotero.Zotero", p.join(home, ".local/share/flatpak/exports/bin/org.zotero.Zotero"), "/snap/bin/zotero-snap"];
  return [...new Set([...onPath, ...usual])];
}

// ---- Quarto copies kept by sikeoop ----

/** The program inside an unpacked Quarto. */
export function quartoBinIn(dir: string, platform: NodeJS.Platform): string {
  return path.join(dir, "bin", platform === "win32" ? "quarto.exe" : "quarto");
}

export const archiveKind = (file: string): "tar.gz" | "zip" => (/\.zip$/i.test(file) ? "zip" : "tar.gz");
