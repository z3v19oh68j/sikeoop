import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRelayServer } from "../../relay/src/node-server.mjs";
import { openMobileFrame, sealMobileFrame } from "../../sweet-code-desktop/src/main/mobile/crypto.ts";
import { MobileGateway, checkRelayUrl } from "../../sweet-code-desktop/src/main/mobile/gateway.ts";
import {
  b64,
  baseTranscript,
  dh,
  helloDigest,
  helloProof,
  signP256,
  transcriptHash,
  verifyP256,
} from "../../sweet-code-desktop/src/main/mobile/handshake.ts";
import { deriveMobileSessionKey } from "../../sweet-code-desktop/src/main/mobile/crypto.ts";
import { MobileStore } from "../../sweet-code-desktop/src/main/mobile/store.ts";

// End to end through the real local relay: a simulated phone scans the QR payload, runs the
// handshake of protocol/CRYPTO.md + PAIRING.md, waits for approval, then calls RPCs over sealed frames.

const fakeBox = { available: () => true, encrypt: (t) => Buffer.from(`enc:${t}`), decrypt: (b) => b.toString().slice(4) };
const spki = (k) => k.export({ format: "der", type: "spki" });

/** The phone side, written from the spec (and reusing the canonical helpers). */
class Phone {
  constructor(qr, keys = null) {
    this.qr = qr;
    this.deviceId = keys?.deviceId ?? b64(randomBytes(16));
    this.signing = keys?.signing ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.staticDh = keys?.staticDh ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  }
  async connect() {
    this.ws = new WebSocket(this.qr.relayUrl);
    // Everything the relay sends is queued, so nothing is lost between two awaits.
    this.inbox = [];
    this.waiters = [];
    this.ws.addEventListener("message", (ev) => {
      this.inbox.push(JSON.parse(String(ev.data)));
      this.waiters.splice(0).forEach((w) => w());
    });
    await new Promise((r) => this.ws.addEventListener("open", r, { once: true }));
    this.ws.send(JSON.stringify({ type: "join", protocolVersion: 1, roomId: this.qr.roomId, roomToken: this.qr.roomToken, role: "mobile" }));
    await this.take((m) => m.type === "joined");
  }
  /** The first queued message matching pred (earlier non-matching ones of the same kind stay queued). */
  async take(pred, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  sendHs(msg) {
    this.ws.send(JSON.stringify({ type: "handshake", payload: Buffer.from(JSON.stringify(msg)).toString("base64url") }));
  }
  async nextHs() {
    const m = await this.take((x) => x.type === "forward" && x.envelope.type === "handshake");
    return JSON.parse(Buffer.from(m.envelope.payload, "base64url").toString());
  }
  async handshake({ pairing = true, tamperProof = false } = {}) {
    const eph = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const clientNonce = randomBytes(32);
    const hello = {
      t: "hello",
      v: 1,
      roomId: this.qr.roomId,
      ...(pairing ? { pairId: this.qr.pairId } : {}),
      deviceId: this.deviceId,
      deviceName: "测试手机",
      deviceSigningPublicKey: b64(spki(this.signing.publicKey)),
      deviceStaticDhPublicKey: b64(spki(this.staticDh.publicKey)),
      deviceEphemeralPublicKey: b64(spki(eph.publicKey)),
      clientNonce: b64(clientNonce),
    };
    if (pairing) {
      const token = Buffer.from(this.qr.pairingToken, "base64url");
      const proof = helloProof(token, helloDigest(hello));
      if (tamperProof) proof[0] ^= 1;
      hello.helloProof = b64(proof);
    }
    this.sendHs(hello);
    const ch = await this.nextHs();
    if (ch.t !== "challenge") return ch;
    assert.equal(ch.computerSigningPublicKey, this.qr.computerSigningPublicKey, "QR identity key matches");
    const compSign = createPublicKey({ key: Buffer.from(ch.computerSigningPublicKey, "base64url"), format: "der", type: "spki" });
    const compDh = createPublicKey({ key: Buffer.from(ch.computerStaticDhPublicKey, "base64url"), format: "der", type: "spki" });
    const compEph = createPublicKey({ key: Buffer.from(ch.computerEphemeralPublicKey, "base64url"), format: "der", type: "spki" });
    const base = baseTranscript({
      roomId: this.qr.roomId,
      pairId: pairing ? this.qr.pairId : "",
      computerId: ch.computerId,
      deviceId: this.deviceId,
      deviceName: "测试手机",
      computerSigningPublicKey: Buffer.from(ch.computerSigningPublicKey, "base64url"),
      computerStaticDhPublicKey: Buffer.from(ch.computerStaticDhPublicKey, "base64url"),
      deviceSigningPublicKey: spki(this.signing.publicKey),
      deviceStaticDhPublicKey: spki(this.staticDh.publicKey),
      computerEphemeralPublicKey: Buffer.from(ch.computerEphemeralPublicKey, "base64url"),
      deviceEphemeralPublicKey: spki(eph.publicKey),
      clientNonce,
      serverNonce: Buffer.from(ch.serverNonce, "base64url"),
    });
    const compSig = Buffer.from(ch.computerSignature, "base64url");
    assert.ok(verifyP256(compSign, base, compSig), "computer signature verifies");
    const devSig = signP256(this.signing.privateKey, Buffer.concat([base, compSig]));
    this.sendHs({ t: "authenticate", v: 1, sessionId: ch.sessionId, deviceSignature: b64(devSig) });
    this.sessionId = ch.sessionId;
    this.key = deriveMobileSessionKey({
      ss: dh(this.staticDh.privateKey, compDh),
      es: dh(eph.privateKey, compDh),
      se: dh(this.staticDh.privateKey, compEph),
      ee: dh(eph.privateKey, compEph),
      pairingToken: pairing ? Buffer.from(this.qr.pairingToken, "base64url") : Buffer.alloc(0),
      transcriptHash: transcriptHash(base, compSig, devSig),
    });
    this.send = 0n;
    this.recv = 0n;
    return ch;
  }
  async nextRpc(pred = () => true) {
    for (;;) {
      const m = await this.take((x) => x.type === "forward" && x.envelope.type === "data");
      const plain = JSON.parse(openMobileFrame(this.key, m.envelope.frame, "desktop-to-mobile", this.recv).toString());
      this.recv++;
      if (pred(plain)) return plain;
    }
  }
  call(id, method, params = {}) {
    const frame = sealMobileFrame(this.key, this.sessionId, "mobile-to-desktop", this.send++, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    this.ws.send(JSON.stringify({ type: "data", frame }));
    return frame;
  }
  close() {
    this.ws?.close();
  }
}

async function setup(t) {
  const relay = createRelayServer({ port: 0, host: "127.0.0.1" });
  const address = await relay.listen();
  const dir = await mkdtemp(path.join(tmpdir(), "mobile-gw-"));
  const store = new MobileStore(dir, fakeBox);
  await store.load();
  await store.setRelay(`ws://127.0.0.1:${address.port}/v1/relay`);
  const listeners = new Set();
  const calls = [];
  let latest;
  const changed = [];
  const gw = new MobileGateway({
    store,
    computerName: () => "测试电脑",
    dispatcher: (device) => ({
      dispatch: async (req) => {
        calls.push({ device, req });
        return { jsonrpc: "2.0", id: req.id, result: { ok: true, method: req.method } };
      },
    }),
    view: () => ({ status: "idle", presence: { online: true }, computer: { id: "c", name: "测试电脑" }, pendingApprovals: 0 }),
    eventCursor: () => 7,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    onChange: (s) => {
      latest = s;
      changed.push(s);
    },
  });
  await gw.start();
  await gw.setEnabled(true);
  const until = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred(latest)) {
      if (Date.now() > end) throw new Error("state timed out: " + JSON.stringify(latest));
      await new Promise((r) => setTimeout(r, 10));
    }
    return latest;
  };
  await until((s) => s?.relay.status === "connected");
  t.after(async () => {
    gw.stop();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });
  const qr = () => {
    const { payload } = gw.createPairing();
    assert.match(payload, /^sikeoop:\/\/pair\//);
    return JSON.parse(Buffer.from(payload.slice("sikeoop://pair/".length), "base64url").toString());
  };
  return { gw, store, dir, qr, until, calls, emit: (e) => listeners.forEach((l) => l(e)) };
}

test("pairing, approval, sealed RPC and events, then reconnect without a QR code", async (t) => {
  const { gw, store, dir, qr, until, calls, emit } = await setup(t);
  const code = qr();
  assert.equal(code.v, 1);
  assert.ok(code.roomToken && code.pairingToken && code.computerStaticDhPublicKey);

  const phone = new Phone(code);
  t.after(() => phone.close());
  await phone.connect();
  await phone.handshake();
  assert.deepEqual((await phone.nextRpc()).params, { status: "pending" });
  let s = await until((x) => !!x.pendingDevice);
  assert.equal(s.pendingDevice.name, "测试手机");
  assert.equal(s.pairing, undefined, "the QR code is used up");

  // Before approval: nothing reaches the dispatcher.
  phone.call(1, "session.snapshot");
  const early = await phone.nextRpc((m) => m.id === 1);
  assert.equal(early.error.code, -32006);
  assert.equal(calls.length, 0);

  await gw.approveDevice(phone.deviceId, true);
  assert.deepEqual((await phone.nextRpc((m) => m.method === "mobile.pairing")).params, { status: "approved" });
  assert.equal(gw.phoneOnline(), true);
  phone.call(2, "session.snapshot");
  assert.deepEqual((await phone.nextRpc((m) => m.id === 2)).result, { ok: true, method: "session.snapshot" });
  assert.equal(calls[0].device.name, "测试手机");

  emit({ type: "text_delta", text: "你好" });
  const ev = await phone.nextRpc((m) => m.method === "mobile.event");
  assert.deepEqual(ev.params, { cursor: 7, event: { type: "text_delta", text: "你好" } });

  // Secrets are encrypted at rest; the public file holds the device's public keys only.
  assert.equal((await stat(path.join(dir, "secrets.bin"))).mode & 0o777, 0o600);
  assert.equal(store.devices.length, 1);

  // Reconnect: no QR, enrolled keys, fresh session.
  phone.close();
  await until((x) => !x.phone);
  const again = new Phone(code, { deviceId: phone.deviceId, signing: phone.signing, staticDh: phone.staticDh });
  t.after(() => again.close());
  await again.connect();
  const ch = await again.handshake({ pairing: false });
  assert.notEqual(ch.sessionId, phone.sessionId);
  s = await until((x) => x.phone?.approved === true);
  assert.equal(s.pendingDevice, undefined);
  again.call(3, "agents.list");
  assert.equal((await again.nextRpc((m) => m.id === 3)).result.method, "agents.list");

  // A replayed frame ends the session.
  const replay = again.call(4, "chat.cancel");
  await again.nextRpc((m) => m.id === 4);
  again.ws.send(JSON.stringify({ type: "data", frame: replay }));
  await until((x) => !x.phone);

  // Revoked: its keys stop working.
  await gw.revoke(again.deviceId);
  const third = new Phone(code, { deviceId: phone.deviceId, signing: phone.signing, staticDh: phone.staticDh });
  t.after(() => third.close());
  again.close();
  await new Promise((r) => setTimeout(r, 50));
  await third.connect();
  const fail = await third.handshake({ pairing: false });
  assert.deepEqual(fail, { t: "error", v: 1, code: "HANDSHAKE_FAILED" });
});

test("a wrong proof burns the QR code; denial drops the phone", async (t) => {
  const { gw, qr, until } = await setup(t);
  const code = qr();
  const bad = new Phone(code);
  t.after(() => bad.close());
  await bad.connect();
  assert.equal((await bad.handshake({ tamperProof: true })).t, "error");
  // A failed handshake frees the phone seat: the relay disconnects it at the desktop's request.
  assert.equal((await bad.take((m) => m.type === "error")).code, "KICKED");
  // The same code can't be retried with the right proof.
  const retry = new Phone(code);
  t.after(() => retry.close());
  await new Promise((r) => setTimeout(r, 50));
  await retry.connect();
  assert.equal((await retry.handshake()).t, "error");
  retry.close();

  const code2 = qr();
  const p = new Phone(code2);
  t.after(() => p.close());
  bad.close();
  await new Promise((r) => setTimeout(r, 50));
  await p.connect();
  await p.handshake();
  await until((x) => !!x.pendingDevice);
  await gw.approveDevice(p.deviceId, false);
  assert.deepEqual((await p.nextRpc((m) => m.method === "mobile.pairing" && m.params.status === "rejected")).params, { status: "rejected" });
  const s = await until((x) => !x.phone);
  assert.equal(s.devices.length, 0);
});

test("relay addresses: ws only on this machine and private networks", () => {
  assert.equal(checkRelayUrl("ws://127.0.0.1:8787/v1/relay"), null);
  assert.equal(checkRelayUrl("ws://192.168.1.20:8787/v1/relay"), null);
  assert.equal(checkRelayUrl("wss://relay.example.com/v1/relay"), null);
  assert.match(checkRelayUrl("ws://relay.example.com/v1/relay"), /wss/);
  assert.match(checkRelayUrl("https://x/y"), /ws:\/\//);
  assert.match(checkRelayUrl("wss://a:b@x.com/"), /账号密码/);
});
