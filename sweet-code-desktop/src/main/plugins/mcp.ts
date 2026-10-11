import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerInput, McpServerView, McpTransport } from "@shared/types";

// MCP servers the user added. Config lives in mcp.json; the values of env vars and headers
// (API keys, tokens) are kept apart and encrypted, the same way provider keys are.

const CONNECT_TIMEOUT_MS = 90_000; // npx / uvx may download the server on first run
const CALL_TIMEOUT_MS = 120_000;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

interface ServerConfig {
  type: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  trusted: boolean;
}

/**
 * MCP servers that ship with sikeoop. Windows-MCP (CursorTouch/Windows-MCP, MIT) lets the agent
 * control the Windows desktop. It starts off and untrusted: each of its tool calls asks first.
 * Needs uv (uvx) and Python 3.13+ on the machine.
 */
const BUILTIN_SERVERS: Record<string, ServerConfig> = {
  "windows-mcp": { type: "stdio", command: "uvx", args: ["windows-mcp", "serve"], enabled: false, trusted: false },
};

interface Secrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface Live {
  client: Client | null;
  status: McpServerView["status"];
  error?: string;
  tools: McpTool[];
  stderr: string;
}

export interface SecretBox {
  encrypt(text: string): Buffer;
  decrypt(buf: Buffer): string;
  available(): boolean;
}

export class McpManager {
  private servers: Record<string, ServerConfig> = {};
  private secrets: Record<string, Secrets> = {};
  private live = new Map<string, Live>();

  constructor(
    private readonly dir: string,
    private readonly box: SecretBox,
    private readonly onChange: (servers: McpServerView[]) => void,
  ) {}

  private get configFile() {
    return path.join(this.dir, "mcp.json");
  }
  private get secretFile() {
    return path.join(this.dir, "mcp-secrets.bin");
  }

  async load(): Promise<void> {
    try {
      this.servers = JSON.parse(await fs.readFile(this.configFile, "utf8")).servers ?? {};
    } catch {
      this.servers = {};
    }
    // Built-in servers appear in the list when missing. They start off and untrusted.
    for (const [name, preset] of Object.entries(BUILTIN_SERVERS)) if (!this.servers[name]) this.servers[name] = { ...preset };
    try {
      this.secrets = JSON.parse(this.box.decrypt(await fs.readFile(this.secretFile)));
    } catch {
      this.secrets = {};
    }
    // Connect in the background; the app does not wait for slow servers.
    for (const name of Object.keys(this.servers)) if (this.servers[name].enabled) void this.connect(name);
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.configFile, JSON.stringify({ servers: this.servers }, null, 2));
    const hasSecrets = Object.values(this.secrets).some((s) => Object.keys(s.env ?? {}).length || Object.keys(s.headers ?? {}).length);
    if (hasSecrets) {
      if (!this.box.available()) throw new Error("这台电脑的系统钥匙串不可用，没法安全保存 MCP 的密钥");
      await fs.writeFile(this.secretFile, this.box.encrypt(JSON.stringify(this.secrets)), { mode: 0o600 });
    } else {
      await fs.rm(this.secretFile, { force: true });
    }
  }

  view(): McpServerView[] {
    return Object.entries(this.servers).map(([name, c]) => {
      const l = this.live.get(name);
      const s = this.secrets[name] ?? {};
      return {
        name,
        type: c.type,
        summary: c.type === "stdio" ? [c.command, ...(c.args ?? [])].join(" ") : (c.url ?? ""),
        enabled: c.enabled,
        trusted: c.trusted,
        status: c.enabled ? (l?.status ?? "connecting") : "off",
        error: l?.error,
        tools: (l?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
        secretKeys: [...Object.keys(s.env ?? {}), ...Object.keys(s.headers ?? {})],
      };
    });
  }

  private changed() {
    this.onChange(this.view());
  }

  async add(inputs: McpServerInput[]): Promise<void> {
    for (const i of inputs) {
      const name = i.name.trim();
      if (!/^[\w.-]{1,40}$/.test(name)) throw new Error(`服务器名「${i.name}」只能用字母、数字、- _ .，最长 40 个字符`);
      await this.disconnect(name);
      this.servers[name] = {
        type: i.type,
        ...(i.type === "stdio" ? { command: i.command, args: i.args ?? [] } : { url: i.url }),
        enabled: true,
        trusted: this.servers[name]?.trusted ?? false,
      };
      this.secrets[name] = { env: i.env, headers: i.headers };
    }
    await this.save();
    for (const i of inputs) void this.connect(i.name.trim());
    this.changed();
  }

  async remove(name: string): Promise<void> {
    await this.disconnect(name);
    delete this.servers[name];
    delete this.secrets[name];
    this.live.delete(name);
    await this.save();
    this.changed();
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const c = this.servers[name];
    if (!c) return;
    c.enabled = enabled;
    await this.save();
    if (enabled) void this.connect(name);
    else await this.disconnect(name);
    this.changed();
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    if (!this.servers[name]) return;
    this.servers[name].trusted = trusted;
    await this.save();
    this.changed();
  }

  async reconnect(name: string): Promise<void> {
    await this.disconnect(name);
    void this.connect(name);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((n) => this.disconnect(n)));
  }

  /** Connected servers and their tools, for building a conversation's tool list. */
  connected(): { server: string; trusted: boolean; tools: McpTool[] }[] {
    return Object.entries(this.servers)
      .filter(([n, c]) => c.enabled && this.live.get(n)?.status === "connected")
      .map(([n, c]) => ({ server: n, trusted: c.trusted, tools: this.live.get(n)!.tools }));
  }

  isTrusted(server: string): boolean {
    return this.servers[server]?.trusted ?? false;
  }

  async call(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    const l = this.live.get(server);
    if (!l?.client || l.status !== "connected") throw new Error(`MCP server "${server}" is not connected.`);
    return l.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
  }

  private async disconnect(name: string): Promise<void> {
    const l = this.live.get(name);
    if (!l) return;
    this.live.delete(name);
    try {
      await l.client?.close();
    } catch {
      // Already closed.
    }
  }

  private async connect(name: string): Promise<void> {
    const c = this.servers[name];
    if (!c) return;
    const l: Live = { client: null, status: "connecting", tools: [], stderr: "" };
    this.live.set(name, l);
    this.changed();
    const s = this.secrets[name] ?? {};
    try {
      // A fresh client per attempt: one that failed half-way may still hold its transport.
      const attempt = async (transport: Transport): Promise<Client> => {
        const c = new Client({ name: "sweet-code", version: "0.1.0" });
        try {
          await withTimeout(c.connect(transport), CONNECT_TIMEOUT_MS, "连接超时");
          return c;
        } catch (err) {
          void c.close().catch(() => {});
          throw err;
        }
      };
      let client: Client;
      if (c.type === "stdio") {
        if (!c.command) throw new Error("没有填启动命令");
        const transport = new StdioClientTransport({
          command: c.command,
          args: c.args ?? [],
          env: { ...getDefaultEnvironment(), PATH: process.env.PATH ?? "", ...(s.env ?? {}) },
          cwd: os.homedir(),
          stderr: "pipe",
        });
        // Keep the tail of stderr: it usually says why a server failed to start.
        transport.stderr?.on("data", (d: Buffer) => (l.stderr = (l.stderr + d.toString()).slice(-2000)));
        client = await attempt(transport);
      } else {
        const url = new URL(c.url ?? "");
        const requestInit = { headers: s.headers ?? {} };
        if (c.type === "sse") client = await attempt(new SSEClientTransport(url, { requestInit }));
        else {
          try {
            client = await attempt(new StreamableHTTPClientTransport(url, { requestInit }));
          } catch {
            // Older servers only speak the SSE transport.
            client = await attempt(new SSEClientTransport(url, { requestInit }));
          }
        }
      }
      if (this.live.get(name) !== l) return void client.close(); // removed or reconnected meanwhile
      l.client = client;
      l.tools = await listTools(client);
      l.status = "connected";
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        l.tools = await listTools(client);
        this.changed();
      });
      client.onclose = () => {
        if (this.live.get(name) === l && l.status === "connected") {
          l.status = "error";
          l.error = "连接断开了";
          this.changed();
        }
      };
    } catch (err) {
      if (this.live.get(name) !== l) return;
      l.status = "error";
      l.error = explain(err as Error, c, l.stderr);
    }
    this.changed();
  }
}

async function listTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      tools.push({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
        readOnly: t.annotations?.readOnlyHint === true,
      });
    }
    cursor = page.nextCursor;
  } while (cursor && tools.length < 500);
  return tools;
}

function explain(err: Error, c: ServerConfig, stderr: string): string {
  const msg = err.message || String(err);
  if (/ENOENT/.test(msg) && c.type === "stdio") {
    const hint = /^(npx|npm|node)$/.test(c.command ?? "")
      ? "需要先安装 Node.js（nodejs.org）"
      : /^(uvx|uv)$/.test(c.command ?? "")
        ? "需要先安装 uv（docs.astral.sh/uv）"
        : "检查命令是否已安装";
    return `找不到命令「${c.command}」，${hint}。`;
  }
  const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return tail ? `${msg}｜${tail}` : msg;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

// ---- reading pasted configs ---------------------------------------------------------

/**
 * Accepts the shapes people share:
 *   { "mcpServers": { name: {...} } }   Claude Desktop, Cursor, Windsurf
 *   { "servers": { name: {...} } }      VS Code
 *   { name: {...}, ... }                a bare map
 *   { "command": ... } / { "url": ... } a single server (named after its package)
 */
export function parseMcpConfig(text: string): McpServerInput[] {
  let json: unknown;
  try {
    json = JSON.parse(stripJsonComments(text));
  } catch {
    throw new Error("不是有效的 JSON。复制的时候要包含最外层的 { }。");
  }
  if (!json || typeof json !== "object") throw new Error("没有找到 MCP 服务器配置");
  const obj = json as Record<string, unknown>;
  const map = (obj.mcpServers ?? obj.servers ?? (isServer(obj) ? { [guessName(obj)]: obj } : obj)) as Record<string, unknown>;
  const out: McpServerInput[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!isServer(raw)) continue;
    const r = raw as Record<string, unknown>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
    const rec = (v: unknown) =>
      v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : undefined;
    if (typeof r.url === "string" || typeof r.serverUrl === "string") {
      const type = String(r.type ?? r.transport ?? "") === "sse" ? "sse" : "http";
      out.push({ name: name.replace(/[^\w.-]/g, "-"), type, url: String(r.url ?? r.serverUrl), headers: rec(r.headers) });
    } else {
      out.push({ name: name.replace(/[^\w.-]/g, "-"), type: "stdio", command: String(r.command), args: strs(r.args), env: rec(r.env) });
    }
  }
  if (!out.length) throw new Error("没有找到 MCP 服务器配置：需要 command（本地命令）或 url（远程服务）");
  return out;
}

function isServer(v: unknown): boolean {
  return !!v && typeof v === "object" && ("command" in v || "url" in v || "serverUrl" in v);
}

function guessName(o: Record<string, unknown>): string {
  if (typeof o.url === "string") return new URL(o.url).hostname.split(".")[0] || "server";
  const pkg = (Array.isArray(o.args) ? o.args : []).map(String).find((a) => !a.startsWith("-")) ?? String(o.command);
  return pkg.replace(/^@[^/]+\//, "").replace(/@.*$/, "").replace(/^(server-|mcp-server-)/, "").replace(/[^\w.-]/g, "-") || "server";
}

/** VS Code configs allow // comments and trailing commas. */
function stripJsonComments(s: string): string {
  return s
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
}
