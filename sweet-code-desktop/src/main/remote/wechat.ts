import { promises as fs } from "node:fs";
import path from "node:path";
import type { IncomingMessage, WeChatBot } from "@wechatbot/wechatbot";
import type { RemoteView } from "@shared/types";

// Remote control over WeChat (@wechatbot/wechatbot): the user scans a QR code with their phone,
// then messages sent to the bot go to sikeoop's main agent, which directs the Claude Code and
// Codex sessions in the terminal tabs (tools/agent-bus-tools.ts) and answers back here.
// Nobody is at the computer, so turns run in lazy mode (dangerous actions refused); Claude Code's
// permission requests are forwarded to WeChat. Only the WeChat user who scanned the QR code may
// control it; everyone else is ignored.

/** A turn taking longer is stopped. */
const TURN_TIMEOUT_MS = 30 * 60_000;
/** WeChat cuts long text; replies are sent in pieces of this size. */
const CHUNK = 1800;
const MAX_PIECES = 6;

const HELP = [
  "sikeoop 远程控制：直接发消息就是给 sikeoop 主控布置任务，它会指挥 Claude Code / Codex 去做。",
  "/stop 停下当前任务  /status 看状态  /y /n 批准或拒绝 Claude Code 的权限请求  /help 这条说明",
].join("\n");

type Msg = IncomingMessage;
type Bot = WeChatBot;

interface Saved {
  enabled: boolean;
}

export class WeChatRemote {
  private bot: Bot | null = null;
  private view: RemoteView = { status: "off", qrUrl: null, verifyRetry: false, busy: false, error: "" };
  private saved: Saved = { enabled: false };
  /** The WeChat user who scanned: the only one who may control sikeoop. */
  private owner: string | null = null;
  /** Waiting for the code WeChat shows on the phone (login step after the scan). */
  private verify: ((code: string) => void) | null = null;
  /** Claude Code permission requests forwarded to WeChat, oldest first. */
  private asks: { id: string; title: string }[] = [];

  constructor(
    private readonly opts: {
      dir: string;
      root(): string | null;
      /** The main chat is working (on a message typed at the computer, or an earlier one from here). */
      busy(): boolean;
      /** A message to the main agent; resolves with its final reply when the turn ends. */
      run(text: string): Promise<{ text: string; done: string; error: string }>;
      cancel(): void;
      /** What the Claude Code / Codex sessions are doing. */
      agents(): string;
      answerAsk(id: string, allow: boolean): void;
      emit(v: RemoteView): void;
    },
  ) {}

  private get file(): string {
    return path.join(this.opts.dir, "remote.json");
  }

  async init(): Promise<void> {
    try {
      this.saved = { ...this.saved, ...JSON.parse(await fs.readFile(this.file, "utf8")) };
    } catch {
      // First run: off.
    }
    // Turned on last time: reconnect with the saved credentials (no scan when they're still valid).
    if (this.saved.enabled) void this.enable().catch(() => {});
  }

  state(): RemoteView {
    return { ...this.view };
  }

  private set(patch: Partial<RemoteView>): void {
    Object.assign(this.view, patch);
    this.opts.emit(this.state());
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.saved));
  }

  async enable(force = false): Promise<RemoteView> {
    if (this.bot) return this.state();
    this.set({ status: "connecting", qrUrl: null, error: "", verifyRetry: false });
    try {
      const { WeChatBot } = await import("@wechatbot/wechatbot");
      const bot = new WeChatBot({
        storage: "file",
        storageDir: path.join(this.opts.dir, "wechatbot"),
        logLevel: "warn",
        botAgent: "sikeoop",
      });
      this.bot = bot;
      bot.on("session:expired", () => this.set({ status: "connecting", error: "微信登录过期了，请重新扫码" }));
      bot.on("error", (err) => console.error("[wechat]", err));
      bot.onMessage((m) => this.onMessage(m));
      const creds = await bot.login({
        force,
        callbacks: {
          onQrUrl: (url) => this.set({ status: "qr", qrUrl: url }),
          onScanned: () => this.set({ status: "scanned" }),
          onExpired: () => this.set({ status: "connecting", qrUrl: null }),
          // The default reads stdin, which an app doesn't have: the code is typed on the screen.
          onVerifyCode: (isRetry) =>
            new Promise<string>((resolve) => {
              this.verify = resolve;
              this.set({ status: "verify", verifyRetry: isRetry });
            }),
        },
      });
      if (this.bot !== bot) return this.state();
      this.owner = creds.userId;
      this.saved.enabled = true;
      await this.save();
      this.set({ status: "online", qrUrl: null });
      // start() long-polls until stopped.
      void bot.start().catch((err: Error) => {
        if (this.bot === bot) this.set({ status: "off", error: err.message.slice(0, 300) });
        this.bot = null;
      });
    } catch (err) {
      this.bot = null;
      this.set({ status: "off", qrUrl: null, error: (err as Error).message.slice(0, 300) });
    }
    return this.state();
  }

  /** The code from the phone, typed on the remote screen. */
  submitVerify(code: string): void {
    const v = this.verify;
    this.verify = null;
    if (!v) return;
    this.set({ status: "scanned" });
    v(code.trim());
  }

  async disable(): Promise<RemoteView> {
    this.stop();
    this.saved.enabled = false;
    await this.save();
    this.set({ status: "off", qrUrl: null, busy: false });
    return this.state();
  }

  /** Log in again with a new scan (another WeChat account). */
  async relogin(): Promise<RemoteView> {
    this.stop();
    return this.enable(true);
  }

  stop(): void {
    const bot = this.bot;
    this.bot = null;
    this.owner = null;
    this.verify = null;
    bot?.stop();
  }

  /** Claude Code asks for permission (also shown on the island): ask on WeChat too. */
  ask(id: string, title: string, detail: string): void {
    if (!this.bot || !this.owner) return;
    this.asks.push({ id, title });
    void this.bot.send(this.owner, `🔐 ${title}\n${detail}\n\n回复 /y 批准，/n 拒绝`).catch(() => {});
  }

  /** Answered elsewhere (island, terminal) or timed out. */
  askGone(id: string): void {
    this.asks = this.asks.filter((a) => a.id !== id);
  }

  private async onMessage(m: Msg): Promise<void> {
    const bot = this.bot;
    if (!bot) return;
    const text = m.type === "text" ? m.text.trim() : "";
    // Only the account that scanned; anyone else is ignored without an answer.
    if (m.userId !== this.owner) return;
    if (!text) return void bot.reply(m, "暂时只支持文字消息。");

    const cmd = text.toLowerCase();
    if (cmd === "/help") return void bot.reply(m, HELP);
    if (cmd === "/status") {
      const root = this.opts.root();
      return void bot.reply(m, [root ? `项目：${path.basename(root)}` : "没有打开项目", `主控：${this.opts.busy() ? "正在干活" : "空闲"}`, this.opts.agents()].join("\n"));
    }
    if (cmd === "/stop") {
      if (!this.opts.busy()) return void bot.reply(m, "主控现在没有在跑的任务。");
      this.opts.cancel();
      return void bot.reply(m, "好的，让主控停下了。");
    }
    if (cmd === "/y" || cmd === "/n") {
      const a = this.asks.shift();
      if (!a) return void bot.reply(m, "现在没有待批准的请求。");
      this.opts.answerAsk(a.id, cmd === "/y");
      return void bot.reply(m, `${cmd === "/y" ? "已批准" : "已拒绝"}：${a.title}`);
    }
    if (this.opts.busy()) return void bot.reply(m, "主控还在干活（可能是电脑上的任务），等它做完，或者发 /stop 停下。");
    if (!this.opts.root()) return void bot.reply(m, "电脑上的 sikeoop 还没有打开项目，先在电脑上打开一个项目吧。");
    await this.runTurn(bot, m, text);
  }

  private async runTurn(bot: Bot, m: Msg, text: string): Promise<void> {
    this.set({ busy: true });
    void bot.sendTyping(m.userId).catch(() => {});
    const timer = setTimeout(() => this.opts.cancel(), TURN_TIMEOUT_MS);
    let r = { text: "", done: "", error: "" };
    try {
      r = await this.opts.run(text);
    } catch (err) {
      r.error = (err as Error).message;
    } finally {
      clearTimeout(timer);
      this.set({ busy: false });
    }
    const why = r.error || { step_limit: "步数用完了，还没做完。发「继续」接着做。", refusal: "模型拒绝了这个请求。", cancelled: "已停下。" }[r.done] || "";
    const answer = [r.text.trim(), r.done === "end_turn" ? "" : why].filter(Boolean).join("\n\n") || "（做完了，没有文字回复）";
    for (const piece of pieces(answer)) await bot.reply(m, piece).catch((err) => console.error("[wechat] reply", err));
  }
}

function pieces(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length && out.length < MAX_PIECES; i += CHUNK) out.push(s.slice(i, i + CHUNK));
  if (s.length > CHUNK * MAX_PIECES) out[out.length - 1] += "\n…（太长了，剩下的请在电脑上看）";
  return out;
}
