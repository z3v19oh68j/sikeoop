import { existsSync, promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArktsFeature, ArktsStatus } from "@shared/types";
import { LspClient } from "./client";

// ArkTS (HarmonyOS .ets) code intelligence from Naily's ArkTS language server
// (@arkts/language-server, github.com/ohosvscode/arkTS, MIT). It needs an OpenHarmony SDK, the
// `sdk/default/openharmony` folder of a DevEco Studio install, which is looked up in the usual
// places or picked once by the user. One server per open project, started on the first .ets file.

/** Requests the editor may forward, by feature. */
const METHODS: Record<ArktsFeature, string> = {
  completion: "textDocument/completion",
  resolve: "completionItem/resolve",
  hover: "textDocument/hover",
  definition: "textDocument/definition",
  signatureHelp: "textDocument/signatureHelp",
};

interface Settings {
  sdkPath?: string;
}

export class ArktsService {
  private client: LspClient | null = null;
  private ready: Promise<void> | null = null;
  private root: string | null = null;
  private status: ArktsStatus = { state: "idle" };
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly opts: {
      settingsFile: string;
      root(): string | null;
      onStatus(s: ArktsStatus): void;
      onDiagnostics(file: string, diagnostics: unknown[]): void;
    },
  ) {}

  getStatus(): ArktsStatus {
    return this.status;
  }

  /** A .ets file was opened in the editor: start the server if needed and tell it. */
  async open(file: string, text: string): Promise<void> {
    if (!(await this.ensure())) return;
    this.versions.set(file, 1);
    this.client!.notify("textDocument/didOpen", { textDocument: { uri: this.uri(file), languageId: "ets", version: 1, text } });
  }

  change(file: string, text: string): void {
    if (!this.client?.alive || this.status.state !== "ready" || !this.versions.has(file)) return;
    const version = this.versions.get(file)! + 1;
    this.versions.set(file, version);
    // Whole text each time: simple, and .ets files are small.
    this.client.notify("textDocument/didChange", { textDocument: { uri: this.uri(file), version }, contentChanges: [{ text }] });
  }

  close(file: string): void {
    if (!this.versions.delete(file) || !this.client?.alive || this.status.state !== "ready") return;
    this.client.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
  }

  /** Completion, hover… at a position (0-based line and UTF-16 character, as LSP counts). */
  async request(feature: ArktsFeature, file: string, payload: unknown): Promise<unknown> {
    const method = METHODS[feature];
    if (!method) throw new Error("不支持的请求");
    if (!this.client?.alive || this.status.state !== "ready" || !this.versions.has(file)) return null;
    const params = feature === "resolve" ? payload : { textDocument: { uri: this.uri(file) }, ...(payload as object) };
    const result = await this.client.request(method, params, AbortSignal.timeout(15_000));
    return feature === "definition" ? this.locations(result) : result;
  }

  /** Points the server at an SDK the user picked (the DevEco install, its sdk folder, or openharmony itself). */
  async setSdk(picked: string): Promise<ArktsStatus> {
    const sdk = await findIn(picked);
    if (!sdk) throw new Error("这个文件夹里没有找到 OpenHarmony SDK。请选 DevEco Studio 的安装目录，或者其中的 sdk/default/openharmony 文件夹");
    await fs.mkdir(path.dirname(this.opts.settingsFile), { recursive: true });
    await fs.writeFile(this.opts.settingsFile, JSON.stringify({ sdkPath: sdk } satisfies Settings), "utf8");
    await this.restart();
    return this.status;
  }

  /** Stops the server; the next .ets file starts it again (for the current project). */
  async restart(): Promise<void> {
    this.stop();
    const files = [...this.versions.keys()];
    this.versions.clear();
    if (files.length) this.setStatus({ state: "idle" });
    // The editor re-sends its open .ets files when the status turns ready.
    if (files.length) await this.ensure();
  }

  stop(): void {
    const client = this.client;
    this.client = null;
    this.ready = null;
    this.root = null;
    this.versions.clear();
    if (client?.alive) {
      void client.request("shutdown", null, AbortSignal.timeout(2000)).catch(() => {}).finally(() => {
        client.notify("exit", null);
        setTimeout(() => client.kill(), 500);
      });
    }
    if (this.status.state !== "idle") this.setStatus({ state: "idle" });
  }

  /** Starts the server for the open project once; resolves false when it can't run. */
  private async ensure(): Promise<boolean> {
    const root = this.opts.root();
    if (!root) return false;
    if (this.root !== root) this.stop();
    if (!this.ready) {
      this.root = root;
      this.ready = this.start(root);
    }
    try {
      await this.ready;
      return this.status.state === "ready";
    } catch {
      return false;
    }
  }

  private async start(root: string): Promise<void> {
    const sdk = await this.findSdk(root);
    if (!sdk) {
      this.setStatus({ state: "no-sdk" });
      throw new Error("no sdk");
    }
    this.setStatus({ state: "starting", sdkPath: sdk });
    const script = require.resolve("@arkts/language-server");
    const client = new LspClient(script, ["--stdio"], {
      cwd: root,
      onExit: (code, stderr) => {
        if (this.client !== client) return;
        this.client = null;
        this.ready = null;
        this.root = null;
        this.versions.clear();
        const reason = lastLine(stderr);
        this.setStatus({ state: "error", sdkPath: sdk, message: `ArkTS 语言服务器退出了（${code ?? "被终止"}）${reason ? `：${reason}` : ""}` });
      },
    });
    this.client = client;
    client.onNotification("textDocument/publishDiagnostics", (p) => {
      const { uri, diagnostics } = p as { uri: string; diagnostics: unknown[] };
      const file = this.relative(uri);
      if (file) this.opts.onDiagnostics(file, diagnostics);
    });
    client.onNotification("window/showMessage", (p) => {
      const { type, message } = p as { type: number; message: string };
      if (type === 1 && this.client === client) this.setStatus({ ...this.status, message });
    });
    client.onRequest("workspace/configuration", (p) => ((p as { items?: unknown[] })?.items ?? []).map(() => null));
    client.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(root).href, name: path.basename(root) }]);

    const hms = hmsBeside(sdk);
    await client.request(
      "initialize",
      {
        processId: process.pid,
        locale: "zh-cn",
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
        initializationOptions: { ets: { sdkPath: sdk, ...(hms ? { hmsPath: hms } : {}) } },
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                insertReplaceSupport: false,
                resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
              },
              contextSupport: true,
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } } },
            definition: { linkSupport: false },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      },
      AbortSignal.timeout(120_000),
    ).catch((err: Error) => {
      if (this.client === client) this.setStatus({ state: "error", sdkPath: sdk, message: `ArkTS 语言服务器启动失败：${err.message}` });
      client.kill();
      throw err;
    });
    client.notify("initialized", {});
    this.setStatus({ state: "ready", sdkPath: sdk });
  }

  private async findSdk(root: string): Promise<string | null> {
    const candidates: string[] = [];
    try {
      const saved = JSON.parse(await fs.readFile(this.opts.settingsFile, "utf8")) as Settings;
      if (saved.sdkPath) candidates.push(saved.sdkPath);
    } catch {
      // Not picked yet.
    }
    const local = await fs.readFile(path.join(root, "local.properties"), "utf8").catch(() => "");
    const dir = local.match(/^\s*sdk\.dir\s*=\s*(.+)$/m)?.[1]?.trim();
    // Java properties escape ":" and "\" on Windows: C\:\\Users\\…
    if (dir) candidates.push(dir.replace(/\\(.)/g, "$1"));
    for (const v of ["DEVECO_SDK_HOME", "OHOS_SDK_HOME", "OHOS_BASE_SDK_HOME"]) if (process.env[v]) candidates.push(process.env[v]!);
    const home = os.homedir();
    if (process.platform === "darwin") {
      candidates.push("/Applications/DevEco-Studio.app", path.join(home, "Applications/DevEco-Studio.app"), path.join(home, "Library/Huawei/Sdk"), path.join(home, "Library/OpenHarmony/Sdk"));
    } else if (process.platform === "win32") {
      const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData/Local");
      for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files", "D:\\Program Files", "D:\\DevEco Studio"]) {
        if (pf) candidates.push(pf.endsWith("DevEco Studio") ? pf : path.join(pf, "Huawei", "DevEco Studio"));
      }
      candidates.push(path.join(local, "Huawei", "Sdk"), path.join(local, "OpenHarmony", "Sdk"));
    } else {
      candidates.push(path.join(home, "OpenHarmony/Sdk"), path.join(home, "Huawei/Sdk"));
    }
    for (const c of candidates) {
      const hit = await findIn(c);
      if (hit) return hit;
    }
    return null;
  }

  private uri(file: string): string {
    return pathToFileURL(path.join(this.root!, file)).href;
  }

  /** Project-relative path of a file URI; null for files outside the project (like the SDK's). */
  private relative(uri: string): string | null {
    if (!this.root || !uri.startsWith("file:")) return null;
    let abs: string;
    try {
      abs = fileURLToPath(uri.replace(/^file:\/\/\/([a-zA-Z])%3[aA]/, "file:///$1:"));
    } catch {
      return null;
    }
    const rel = path.relative(this.root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  /** Definition results as project paths; places outside the project are dropped. */
  private locations(result: unknown): { file: string; range: unknown }[] {
    const list = (Array.isArray(result) ? result : result ? [result] : []) as { uri?: string; targetUri?: string; range?: unknown; targetSelectionRange?: unknown }[];
    return list.flatMap((l) => {
      const file = this.relative(l.uri ?? l.targetUri ?? "");
      return file ? [{ file, range: l.range ?? l.targetSelectionRange }] : [];
    });
  }

  private setStatus(s: ArktsStatus): void {
    this.status = s;
    this.opts.onStatus(s);
  }
}

const isSdk = (dir: string) => existsSync(path.join(dir, "ets", "build-tools", "ets-loader", "tsconfig.json"));

/** The OpenHarmony SDK inside a folder: itself, a known sub-path, or its newest API-level folder. */
async function findIn(dir: string): Promise<string | null> {
  if (!dir || !existsSync(dir)) return null;
  const roots = [dir, path.join(dir, "openharmony"), path.join(dir, "default", "openharmony"), path.join(dir, "sdk", "default", "openharmony"), path.join(dir, "Contents", "sdk", "default", "openharmony")];
  for (const r of roots) {
    if (isSdk(r)) return path.resolve(r);
    // Older layouts: <sdk>/openharmony/<api level>/ or <sdk>/<api level>/
    const levels = await fs.readdir(r).catch(() => [] as string[]);
    for (const l of levels.filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a))) {
      if (isSdk(path.join(r, l))) return path.resolve(r, l);
    }
  }
  return null;
}

/** The HarmonyOS (HMS) SDK next to the OpenHarmony one: …/default/hms, or …/hms/<api level>. */
function hmsBeside(sdk: string): string | null {
  const base = path.basename(sdk);
  const candidate = /^\d+$/.test(base) ? path.join(path.dirname(path.dirname(sdk)), "hms", base) : path.join(path.dirname(sdk), "hms");
  try {
    return statSync(path.join(candidate, "ets")).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error/i.test(l)) ?? lines[lines.length - 1] ?? "").slice(0, 200);
}
