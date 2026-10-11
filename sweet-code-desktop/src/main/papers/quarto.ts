import path from "node:path";
import type { DispatchJob, QuartoFormat, QuartoStatus } from "@shared/types";
import type { Executor } from "../dispatch/scheduler.ts";
import { compareVersions } from "./tools-release.ts";

// Quarto (https://quarto.org) through its command line: `quarto --version`, `quarto render`.
// It is never shipped with sikeoop: the user installs it, or has sikeoop download a copy into its
// own data folder (tools.ts). This file has the parts without I/O (where to look for it, which
// copy to use, the command for a rendering, reading what it printed) and the executor that makes
// a rendering a dispatch-core job.

/**
 * Every place Quarto's program may be, in the order they are tried: the folders on PATH first,
 * then where its installers put it. Nothing is run or read here.
 */
export function quartoCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string[] {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const names = win ? ["quarto.exe", "quarto.cmd"] : ["quarto"];
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").map((d) => d.trim().replace(/^"|"$/g, "")).filter((d) => d && p.isAbsolute(d));
  const usual = win
    ? [env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, "Programs", "Quarto", "bin"), env.ProgramFiles && p.join(env.ProgramFiles, "Quarto", "bin"), p.join(home, "scoop", "shims")]
    : platform === "darwin"
      ? ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/quarto/bin", p.join(home, "Applications", "quarto", "bin"), p.join(home, ".local", "bin")]
      : ["/usr/local/bin", "/usr/bin", "/opt/quarto/bin", p.join(home, ".local", "bin"), p.join(home, "bin")];
  const out: string[] = [];
  for (const dir of [...dirs, ...usual]) for (const name of names) if (dir && !out.includes(p.join(dir, name))) out.push(p.join(dir, name));
  return out;
}

/** `quarto --version` prints just the version ("1.5.57"). */
export function parseQuartoVersion(stdout: string): string | null {
  return /^\s*(\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?)\s*$/m.exec(stdout)?.[1] ?? null;
}

/** Typst (PDF without LaTeX) came with Quarto 1.4. */
export function supportsTypst(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 4);
}

const INSTALL = [
  "点下面的「下载 Quarto」，sikeoop 从 Quarto 的官方发布页下载一份，放在自己的数据文件夹里（不动系统，不需要管理员权限）",
  "或者自己到 quarto.org/docs/get-started 下载安装包安装，装好后点「重新检测」；如果还找不到，重启一次 sikeoop",
];

export interface FoundQuarto {
  path: string;
  version: string;
  /** The copy sikeoop downloaded, not one the user installed. */
  managed?: boolean;
}

/**
 * Which Quarto is used: the user's own when it can do everything (1.4 or newer), otherwise the
 * newest copy sikeoop downloaded, and only then a too-old one of the user's.
 */
export function chooseQuarto(user: FoundQuarto | null, managed: FoundQuarto[]): FoundQuarto | null {
  if (user && supportsTypst(user.version)) return user;
  const ours = managed.filter((m) => supportsTypst(m.version)).sort((a, b) => compareVersions(b.version, a.version))[0];
  if (ours) return { ...ours, managed: true };
  return user;
}

export function quartoStatusOf(found: FoundQuarto | null): QuartoStatus {
  if (!found) return { found: false, typst: false, message: "没有找到 Quarto。排版要用它，sikeoop 不自带。", steps: INSTALL };
  const typst = supportsTypst(found.version);
  return {
    found: true,
    path: found.path,
    version: found.version,
    typst,
    message: typst ? "" : `Quarto ${found.version} 比较旧：可以出 Word 和网页，出 PDF 需要 1.4 或更新的版本。`,
    steps: typst ? [] : ["点下面的「下载 Quarto」让 sikeoop 另外下载一份新版（不动你装的那份），或到 quarto.org/docs/get-started 下载新版覆盖安装", "然后点「重新检测」"],
    ...(found.managed ? { managed: true } : {}),
  };
}

/** Quarto's name for each output. PDF goes through Typst, which Quarto brings itself (no LaTeX needed). */
const TO: Record<QuartoFormat, string> = { pdf: "typst", docx: "docx", html: "html" };
const EXTENSION: Record<QuartoFormat, string> = { pdf: ".pdf", docx: ".docx", html: ".html" };

/** Documents Quarto is given: .qmd and Markdown. */
export const QUARTO_DOCUMENT = /\.(qmd|md|markdown)$/i;

/**
 * The arguments for rendering one document. Run in the document's folder with only its file name,
 * so the output lands beside it. Code cells are not run unless asked for.
 */
export function renderArgs(fileName: string, format: QuartoFormat, execute: boolean): string[] {
  if (path.basename(fileName) !== fileName || fileName.startsWith("-") || !QUARTO_DOCUMENT.test(fileName)) throw new Error("只能排版 .qmd 或 .md 文件");
  return ["render", fileName, "--to", TO[format], ...(execute ? [] : ["--no-execute"])];
}

/** Where the output is when Quarto doesn't say: beside the document, same name. */
export function expectedOutput(fileName: string, format: QuartoFormat): string {
  return fileName.replace(QUARTO_DOCUMENT, "") + EXTENSION[format];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const plain = (s: string) => s.replace(ANSI, "").replace(/\r\n?/g, "\n");

export interface RenderReport {
  /** "Output created: …", relative to the folder Quarto ran in. */
  output?: string;
  /** What a person needs to read: errors first, then warnings worth acting on. */
  points: string[];
}

/** Lines that say what went wrong, as people need them: one line each, no stack traces. */
export function parseRenderOutput(log: string): RenderReport {
  const lines = plain(log).split("\n");
  const created = lines.map((l) => /^\s*Output created:\s*(.+?)\s*$/.exec(l)?.[1]).filter(Boolean).at(-1);
  const errors: string[] = [];
  const warnings: string[] = [];
  const add = (list: string[], text: string) => {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (clean && !list.includes(clean) && list.length < 8) list.push(clean);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m: RegExpExecArray | null;
    if ((m = /^ERROR:\s*(.*)$/.exec(line))) {
      // Quarto sometimes puts the reason on the next line.
      add(errors, m[1] || lines[i + 1] || "");
    } else if ((m = /^error:\s*(.+)$/.exec(line))) {
      // Typst: "error: unknown variable: foo", then "┌─ paper.typ:12:3".
      const at = /[┌╭]─\s*(\S+:\d+(?::\d+)?)/.exec(lines[i + 1] ?? "")?.[1];
      add(errors, at ? `${m[1]}（${at}）` : m[1]);
    } else if ((m = /^(?:\[WARNING\]\s*)?Citeproc: citation (\S+) not found/.exec(line))) {
      add(warnings, `引用 ${m[1]} 在参考文献里找不到：先同步 references.bib，或检查 key 有没有写错`);
    } else if ((m = /^(?:WARNING|\[WARNING\]):?\s*(.+)$/.exec(line))) {
      add(warnings, m[1]);
    } else if ((m = /^(?:Error|YAMLError|YAMLException|SyntaxError|TypeError)\b:?\s*(.+)$/.exec(line))) {
      add(errors, m[1]);
    } else if (/^(?:pandoc|typst): /.test(line) || /unknown font family|font .* not found|Could not find bibliography file|File .* not found in resource path|No valid input files/i.test(line)) {
      add(errors, line);
    }
  }
  return { output: created, points: [...errors, ...warnings].slice(0, 10) };
}

/** What a failure most likely means, when Quarto's own lines don't say it plainly. */
export function failureHint(points: string[], log: string): string | null {
  const all = points.join("\n") + "\n" + plain(log);
  if (/unknown font family|font .* not found/i.test(all)) return "文档里指定的字体这台电脑上没有：改掉 mainfont，或装上这个字体";
  if (/Could not find bibliography file|bibliography.*(?:not found|does not exist)|failed to load file/i.test(all)) return "找不到参考文献文件：确认 references.bib 在文稿旁边，可以先做一次同步";
  if (/Unknown format|unknown output format/i.test(all)) return "这个版本的 Quarto 不认识这种输出格式：更新 Quarto 再试";
  if (/YAML/i.test(all)) return "文稿开头的 YAML 设置有写错的地方：检查缩进和冒号";
  return null;
}

/** Runs a program and hands over what it prints; resolves with its exit code. Killing it (and what it started) on `signal`. */
export type RunProcess = (bin: string, args: string[], cwd: string, onOutput: (text: string) => void, signal: AbortSignal) => Promise<number>;

export interface QuartoWork {
  bin: string;
  args: string[];
  cwd: string;
  run: RunProcess;
  /** Right before Quarto starts (the job has its turn now). */
  begin?(): void;
  output?(text: string): void;
}

/** How much of Quarto's output is kept. */
const LOG_BYTES = 64 * 1024;

/**
 * One rendering as a dispatch-core job. The job's result is Quarto's output (its end, when long);
 * a non-zero exit fails the job with the first thing that went wrong.
 */
export class QuartoExecutor implements Executor {
  readonly kind = "process" as const;
  readonly ref: string;
  readonly name = "Quarto";
  private readonly work: QuartoWork;
  log = "";

  constructor(ref: string, work: QuartoWork) {
    this.ref = ref;
    this.work = work;
  }

  ready(): boolean {
    return true;
  }

  alive(): boolean {
    return true;
  }

  async run(_job: DispatchJob, signal: AbortSignal): Promise<{ text: string }> {
    this.work.begin?.();
    const code = await this.work.run(
      this.work.bin,
      this.work.args,
      this.work.cwd,
      (text) => {
        this.log = (this.log + text).slice(-LOG_BYTES);
        this.work.output?.(text);
      },
      signal,
    );
    if (signal.aborted) throw new Error(signal.reason === "timeout" ? "排版太久没有结束，已停下" : "已取消");
    if (code !== 0) throw new Error(parseRenderOutput(this.log).points[0] ?? `Quarto 退出了（代码 ${code}）`);
    return { text: plain(this.log).trim() || "排版完成" };
  }
}
