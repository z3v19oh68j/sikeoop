import { randomBytes } from "node:crypto";
import type { AgentEvent, MobileGatewayState, MobilePairingQr, MobileView } from "@shared/types";
import { MOBILE_ERROR, MOBILE_MAX_FRAME_BYTES, type RpcFailure } from "../../shared/protocol.ts";
import { openMobileFrame, sealMobileFrame, type SealedMobileFrame } from "./crypto.ts";
import {
  acceptAuthenticate,
  acceptHello,
  b64,
  type DesktopHandshakeContext,
  type EstablishedSession,
  type HandshakeFailedMessage,
  type PendingHandshake,
} from "./handshake.ts";
import type { MobileStore } from "./store.ts";

// The desktop end of the phone link (mobile-design/sikeoop-android.md §5): keeps a WebSocket to the
// relay while the person has the feature on, pairs phones with one-time QR codes, runs the handshake
// of protocol/CRYPTO.md, and then carries JSON-RPC both ways as sealed frames. Decrypted requests go
// to MobileRpcDispatcher; the main conversation's events go back as notifications.
// The relay only ever sees routing data and ciphertext.

export const PAIRING_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 5 * 60_000;
const HANDSHAKE_TTL_MS = 30_000;
const MAX_PENDING_HANDSHAKES = 4;
const MAX_HANDSHAKE_PAYLOAD = 32_768;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
/** Events after which the phone gets a fresh MobileView (mobile.status). */
const STATUS_EVENTS = new Set<AgentEvent["type"]>(["status", "done", "error", "approval_request", "approval_result", "plan", "turn_changes", "question", "question_answered"]);

export interface RelaySocket {
  send(text: string): void;
  close(): void;
}
export type ConnectRelay = (url: string, on: { open(): void; message(text: string): void; close(): void }) => RelaySocket;

/** The relay connection through the WebSocket built into Node / Electron's main process. */
export const connectWebSocket: ConnectRelay = (url, on) => {
  const ws = new WebSocket(url);
  ws.onopen = () => on.open();
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") on.message(ev.data);
  };
  ws.onclose = () => on.close();
  ws.onerror = () => undefined; // onclose follows
  return { send: (t) => ws.readyState === WebSocket.OPEN && ws.send(t), close: () => ws.close() };
};

export interface Dispatcher {
  dispatch(input: unknown): Promise<unknown>;
}

export interface GatewayDeps {
  store: MobileStore;
  computerName(): string;
  connect?: ConnectRelay;
  /** The RPC handler for an approved device. */
  dispatcher(device: { id: string; name: string }): Dispatcher;
  /** The main conversation as the phone's home screen shows it. */
  view(): MobileView;
  /** The main conversation's event cursor (AgentSession.mobileCursor). */
  eventCursor(): number;
  /** The main conversation's events (index.ts remoteEvents). */
  subscribe(listener: (e: AgentEvent) => void): () => void;
  onChange(s: MobileGatewayState): void;
  now?(): number;
  log?(message: string): void;
}

interface Session {
  est: EstablishedSession;
  send: bigint;
  recv: bigint;
  approved: boolean;
  since: number;
  dispatcher: Dispatcher | null;
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/i;

/** A relay address the gateway accepts, or an error message. ws:// is only allowed on this machine and private networks. */
export function checkRelayUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "中继地址不是有效的网址";
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") return "中继地址要以 ws:// 或 wss:// 开头";
  if (u.protocol === "ws:" && !PRIVATE_HOST.test(u.hostname) && !PRIVATE_HOST.test(`[${u.hostname}]`)) return "公网中继必须用 wss://（加密连接）";
  if (u.username || u.password) return "中继地址里不能带账号密码";
  return null;
}

export class MobileGateway {
  private socket: RelaySocket | null = null;
  private status: MobileGatewayState["relay"]["status"] = "off";
  private error: string | undefined;
  private secretsAvailable = true;
  private loaded = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pairing: { pairId: string; token: Buffer; expiresAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private handshakes = new Map<string, { pending: PendingHandshake; at: number }>();
  private session: Session | null = null;
  private pendingDevice: { est: EstablishedSession; at: number; expiresAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private unsubscribe: (() => void) | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private log(m: string) {
    this.deps.log?.(m);
  }
  private changed() {
    this.deps.onChange(this.state());
  }

  async start(): Promise<void> {
    try {
      await this.deps.store.load();
      this.loaded = true;
    } catch (e) {
      this.secretsAvailable = false;
      this.error = e instanceof Error ? e.message : String(e);
      this.changed();
      return;
    }
    this.unsubscribe = this.deps.subscribe((e) => this.onAgentEvent(e));
    if (this.deps.store.enabled) this.connect();
    this.changed();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disconnect();
  }

  /** True while an approved phone is connected: only then may human-only approvals wait for the phone. */
  phoneOnline(): boolean {
    return !!this.session?.approved;
  }

  state(): MobileGatewayState {
    const st = this.loaded ? this.deps.store : null;
    const s = this.session;
    return {
      enabled: st?.enabled ?? false,
      secretsAvailable: this.secretsAvailable,
      relay: {
        url: st?.relayUrl ?? "",
        phoneUrl: st?.phoneRelayUrl ?? "",
        status: this.status,
        ...(this.error ? { error: this.error } : {}),
      },
      computer: { id: st?.computer.computerId ?? "", name: this.deps.computerName() },
      devices: (st?.devices ?? []).map(({ id, name, addedAt, lastSeenAt }) => ({ id, name, addedAt, ...(lastSeenAt ? { lastSeenAt } : {}) })),
      ...(s ? { phone: { deviceId: s.est.deviceId, deviceName: s.est.deviceName, since: s.since, approved: s.approved } } : {}),
      ...(this.pairing ? { pairing: { pairId: this.pairing.pairId, expiresAt: this.pairing.expiresAt } } : {}),
      ...(this.pendingDevice
        ? { pendingDevice: { id: this.pendingDevice.est.deviceId, name: this.pendingDevice.est.deviceName, at: this.pendingDevice.at, expiresAt: this.pendingDevice.expiresAt } }
        : {}),
    };
  }

  private requireLoaded() {
    if (!this.loaded) throw new Error(this.error ?? "手机连接还没准备好");
  }

  async setEnabled(on: boolean): Promise<MobileGatewayState> {
    this.requireLoaded();
    await this.deps.store.setEnabled(on);
    if (on) this.connect();
    else this.disconnect();
    this.changed();
    return this.state();
  }

  async setRelay(url: string, phoneUrl?: string): Promise<MobileGatewayState> {
    this.requireLoaded();
    const bad = checkRelayUrl(url) ?? (phoneUrl ? checkRelayUrl(phoneUrl) : null);
    if (bad) throw new Error(bad);
    await this.deps.store.setRelay(url, phoneUrl);
    if (this.deps.store.enabled) {
      this.disconnect();
      this.connect();
    }
    this.changed();
    return this.state();
  }

  /** A new one-time QR code; any code still showing stops working. */
  createPairing(): MobilePairingQr {
    this.requireLoaded();
    if (!this.deps.store.enabled) throw new Error("先打开手机连接");
    this.cancelPairing(false);
    const pairId = b64(randomBytes(16));
    const token = randomBytes(32);
    const expiresAt = this.now() + PAIRING_TTL_MS;
    const timer = setTimeout(() => this.cancelPairing(), PAIRING_TTL_MS);
    timer.unref?.();
    this.pairing = { pairId, token, expiresAt, timer };
    const st = this.deps.store;
    const c = st.computer;
    const body = {
      v: 1,
      relayUrl: st.phoneRelayUrl,
      roomId: st.roomId,
      roomToken: st.roomToken,
      computerId: c.computerId,
      computerName: this.deps.computerName(),
      pairId,
      expiresAt,
      pairingToken: b64(token),
      computerSigningPublicKey: c.signing.publicKey,
      computerStaticDhPublicKey: c.staticDh.publicKey,
    };
    this.changed();
    return { payload: `sikeoop://pair/${Buffer.from(JSON.stringify(body), "utf8").toString("base64url")}`, expiresAt };
  }

  cancelPairing(notify = true): void {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer);
    this.pairing.token.fill(0);
    this.pairing = null;
    if (notify) this.changed();
  }

  async approveDevice(deviceId: string, allow: boolean): Promise<MobileGatewayState> {
    const p = this.pendingDevice;
    if (!p || p.est.deviceId !== deviceId) throw new Error("这台手机已经不在等待确认了");
    clearTimeout(p.timer);
    this.pendingDevice = null;
    const s = this.session;
    const live = s && s.est.sessionId === p.est.sessionId ? s : null;
    if (allow) {
      await this.deps.store.addDevice({
        id: p.est.deviceId,
        name: p.est.deviceName,
        signingPublicKey: p.est.deviceSigningPublicKey,
        staticDhPublicKey: p.est.deviceStaticDhPublicKey,
        lastSeenAt: this.now(),
      });
      if (live) {
        live.approved = true;
        live.dispatcher = this.deps.dispatcher({ id: p.est.deviceId, name: p.est.deviceName });
        this.notify("mobile.pairing", { status: "approved" });
      }
    } else if (live) {
      this.notify("mobile.pairing", { status: "rejected" });
      this.dropSession();
      this.kickPhone();
    }
    this.changed();
    return this.state();
  }

  async revoke(deviceId: string): Promise<MobileGatewayState> {
    this.requireLoaded();
    await this.deps.store.removeDevice(deviceId);
    if (this.session?.est.deviceId === deviceId) {
      this.dropSession();
      this.kickPhone();
    }
    if (this.pendingDevice?.est.deviceId === deviceId) {
      clearTimeout(this.pendingDevice.timer);
      this.pendingDevice = null;
    }
    this.changed();
    return this.state();
  }

  // ---- relay connection ----

  private connect() {
    if (this.socket) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const st = this.deps.store;
    const bad = checkRelayUrl(st.relayUrl);
    if (bad) {
      this.status = "error";
      this.error = bad;
      this.changed();
      return;
    }
    this.status = "connecting";
    this.error = undefined;
    const connect = this.deps.connect ?? connectWebSocket;
    let sock: RelaySocket | null = null;
    sock = connect(st.relayUrl, {
      open: () => sock?.send(JSON.stringify({ type: "join", protocolVersion: 1, roomId: st.roomId, roomToken: st.roomToken, ownerToken: st.ownerToken, role: "desktop" })),
      message: (text) => {
        if (this.socket === sock) this.onRelayMessage(text);
      },
      close: () => {
        if (this.socket !== sock) return;
        this.socket = null;
        this.dropSession();
        this.handshakes.clear();
        if (!this.deps.store.enabled) return;
        this.status = this.status === "error" ? "error" : "connecting";
        const wait = BACKOFF_MS[Math.min(this.retry++, BACKOFF_MS.length - 1)];
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, wait);
        this.retryTimer.unref?.();
        this.changed();
      },
    });
    this.socket = sock;
    this.changed();
  }

  private disconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.dropSession();
    this.handshakes.clear();
    this.cancelPairing(false);
    if (this.pendingDevice) {
      clearTimeout(this.pendingDevice.timer);
      this.pendingDevice = null;
    }
    this.status = "off";
    this.error = undefined;
    this.retry = 0;
  }

  private onRelayMessage(text: string) {
    if (text.length > MOBILE_MAX_FRAME_BYTES + 4096) return;
    let m: { type?: string; [k: string]: unknown };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m.type) {
      case "joined":
        this.status = "connected";
        this.error = undefined;
        this.retry = 0;
        this.changed();
        return;
      case "presence":
        if (m.role === "mobile" && m.online === false) {
          this.dropSession();
          this.handshakes.clear();
          this.changed();
        }
        return;
      case "error":
        this.status = "error";
        this.error = m.code === "ROLE_BUSY" ? "另一台电脑上的 sikeoop 正连着这个房间" : `中继拒绝了连接（${String(m.code ?? "未知")}）`;
        this.changed();
        return;
      case "forward": {
        if (m.from !== "mobile") return;
        const env = m.envelope as { type?: string; payload?: unknown; frame?: unknown } | undefined;
        if (env?.type === "handshake") this.onHandshake(env.payload);
        else if (env?.type === "data") void this.onData(env.frame as SealedMobileFrame);
        return;
      }
    }
  }

  private sendEnvelope(envelope: unknown) {
    // After join, the relay takes each envelope as is and delivers it wrapped in { type: "forward" }.
    this.socket?.send(JSON.stringify(envelope));
  }

  /** Asks the relay to disconnect whoever holds the room's phone seat (only the room's owner may). */
  private kickPhone() {
    this.sendEnvelope({ type: "kick" });
  }

  private sendHandshake(msg: unknown) {
    this.sendEnvelope({ type: "handshake", payload: Buffer.from(JSON.stringify(msg), "utf8").toString("base64url") });
  }

  private ctx(): DesktopHandshakeContext {
    const st = this.deps.store;
    return {
      roomId: st.roomId,
      computer: st.computer,
      consumePairing: (pairId) => {
        const p = this.pairing;
        if (!p || p.pairId !== pairId || this.now() > p.expiresAt) return null;
        const token = Buffer.from(p.token);
        this.cancelPairing();
        return token;
      },
      enrolled: (id) => {
        const d = st.device(id);
        return d ? { signingPublicKey: d.signingPublicKey, staticDhPublicKey: d.staticDhPublicKey } : null;
      },
    };
  }

  private onHandshake(payload: unknown) {
    if (typeof payload !== "string" || payload.length > MAX_HANDSHAKE_PAYLOAD) return;
    let msg: { t?: string; sessionId?: string };
    try {
      msg = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return;
    }
    const failed: HandshakeFailedMessage = { t: "error", v: 1, code: "HANDSHAKE_FAILED" };
    const now = this.now();
    for (const [id, h] of this.handshakes) if (now - h.at > HANDSHAKE_TTL_MS) this.handshakes.delete(id);

    if (msg.t === "hello") {
      if (this.handshakes.size >= MAX_PENDING_HANDSHAKES) return this.sendHandshake(failed);
      const r = acceptHello(this.ctx(), msg);
      if (!r) return this.refuse(failed);
      this.handshakes.set(r.pending.sessionId, { pending: r.pending, at: now });
      this.sendHandshake(r.challenge);
      return;
    }
    if (msg.t === "authenticate") {
      const h = typeof msg.sessionId === "string" ? this.handshakes.get(msg.sessionId) : undefined;
      if (h) this.handshakes.delete(msg.sessionId!);
      const est = h ? acceptAuthenticate(h.pending, msg) : null;
      h?.pending.token.fill(0);
      if (!est) return this.refuse(failed);
      this.establish(est);
    }
  }

  /** A failed handshake: say so, then free the phone seat so an unknown or revoked device can't sit in it. */
  private refuse(failed: HandshakeFailedMessage) {
    this.sendHandshake(failed);
    if (!this.session) this.kickPhone();
  }

  private establish(est: EstablishedSession) {
    this.dropSession();
    // A device re-pairing over an enrolled id still needs approval: its keys are new.
    const enrolled = !est.pairing && !!this.deps.store.device(est.deviceId);
    this.session = {
      est,
      send: 0n,
      recv: 0n,
      approved: enrolled,
      since: this.now(),
      dispatcher: enrolled ? this.deps.dispatcher({ id: est.deviceId, name: est.deviceName }) : null,
    };
    if (enrolled) {
      void this.deps.store.touchDevice(est.deviceId);
    } else {
      if (this.pendingDevice) clearTimeout(this.pendingDevice.timer);
      const timer = setTimeout(() => {
        if (this.pendingDevice?.est.sessionId === est.sessionId) void this.approveDevice(est.deviceId, false).catch(() => undefined);
      }, APPROVAL_TTL_MS);
      timer.unref?.();
      this.pendingDevice = { est, at: this.now(), expiresAt: this.now() + APPROVAL_TTL_MS, timer };
      this.notify("mobile.pairing", { status: "pending" });
    }
    this.log(`phone connected: ${est.deviceName}${enrolled ? "" : " (waiting for approval)"}`);
    this.changed();
  }

  private dropSession() {
    if (!this.session) return;
    this.session.est.key.fill(0);
    this.session = null;
  }

  private async onData(frame: SealedMobileFrame) {
    const s = this.session;
    if (!s || !frame || frame.sessionId !== s.est.sessionId) return;
    let plain: Buffer;
    try {
      plain = openMobileFrame(s.est.key, frame, "mobile-to-desktop", s.recv);
    } catch {
      // A replayed, reordered or forged frame ends the session; the phone reconnects with a fresh handshake.
      this.log("dropped a phone session after a bad frame");
      this.dropSession();
      this.kickPhone();
      this.changed();
      return;
    }
    s.recv++;
    let req: { id?: unknown; method?: unknown };
    try {
      req = JSON.parse(plain.toString("utf8"));
    } catch {
      return this.sendRpc(s, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const hasId = typeof req?.id === "string" || typeof req?.id === "number";
    if (!s.approved || !s.dispatcher) {
      if (hasId) this.sendRpc(s, { jsonrpc: "2.0", id: req.id as string | number, error: { code: MOBILE_ERROR.PAIRING_PENDING, message: "等电脑上点「允许」" } } satisfies RpcFailure);
      return;
    }
    const res = await s.dispatcher.dispatch(req);
    if (this.session === s && hasId) this.sendRpc(s, res);
  }

  /** Seals one JSON-RPC message for the phone; one that would exceed the frame limit is replaced by an error. */
  private sendRpc(s: Session, msg: unknown) {
    let body = Buffer.from(JSON.stringify(msg), "utf8");
    if (body.length > MOBILE_MAX_FRAME_BYTES - 64 * 1024) {
      const id = (msg as { id?: unknown }).id;
      if (id === undefined) return; // a notification that doesn't fit is dropped; the phone re-syncs via session.snapshot
      body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, error: { code: MOBILE_ERROR.INVALID_STATE, message: "回复太大，手机上放不下" } }), "utf8");
    }
    const frame = sealMobileFrame(s.est.key, s.est.sessionId, "desktop-to-mobile", s.send, body);
    s.send++;
    this.sendEnvelope({ type: "data", frame });
  }

  private notify(method: string, params: unknown) {
    const s = this.session;
    if (s) this.sendRpc(s, { jsonrpc: "2.0", method, params });
  }

  private onAgentEvent(e: AgentEvent) {
    if (!this.session?.approved) return;
    this.notify("mobile.event", { cursor: this.deps.eventCursor(), event: e });
    if (STATUS_EVENTS.has(e.type) && !this.statusTimer) {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = null;
        if (this.session?.approved) this.notify("mobile.status", this.deps.view());
      }, 250);
      this.statusTimer.unref?.();
    }
  }
}
