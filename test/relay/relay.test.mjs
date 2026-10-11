import assert from "node:assert/strict";
import test from "node:test";
import { RoomHub } from "../../relay/src/room-hub.mjs";
import { createRelayServer } from "../../relay/src/node-server.mjs";

const roomId = Buffer.alloc(16, 0x42).toString("base64url");
const roomToken = Buffer.alloc(32, 0x24).toString("base64url");
const ownerToken = Buffer.alloc(32, 0x77).toString("base64url");
const join = (role, token = roomToken) => ({ type: "join", protocolVersion: 1, roomId, roomToken: token, role, ...(role === "desktop" ? { ownerToken } : {}) });
const validFrame = (direction, counter = "0") => ({
  type: "data",
  frame: { version: 1, sessionId: "session-123456", direction, counter, ciphertext: "AQID", tag: "AAAAAAAAAAAAAAAAAAAAAA" },
});

class FakePeer {
  messages = [];
  sendJson(value) { this.messages.push(value); }
}

function waitForMessage(socket, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for relay message")), timeoutMs);
    const listener = (event) => {
      const value = JSON.parse(String(event.data));
      if (!predicate(value)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(value);
    };
    socket.addEventListener("message", listener);
  });
}

async function openWebSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
  });
  return socket;
}

test("room hub requires desktop-created secret room and a matching token", () => {
  const hub = new RoomHub();
  const phone = new FakePeer();
  assert.throws(() => hub.join(phone, join("mobile")), { code: "ROOM_NOT_FOUND" });
  const desktop = new FakePeer();
  hub.join(desktop, join("desktop"));
  assert.equal(hub.roomCount, 1);
  assert.throws(() => hub.join(new FakePeer(), join("mobile", Buffer.alloc(32, 0x25).toString("base64url"))), { code: "AUTH_FAILED" });
  hub.join(phone, join("mobile"));
  assert.equal(phone.messages[0].presence.online, true);
  assert.equal(desktop.messages.at(-1).type, "presence");
  assert.equal(desktop.messages.at(-1).online, true);
});

test("room hub forwards opaque handshake and encrypted data without buffering", () => {
  const hub = new RoomHub();
  const desktop = new FakePeer();
  const phone = new FakePeer();
  hub.join(desktop, join("desktop"));
  assert.equal(hub.forward(desktop, { type: "handshake", payload: Buffer.from("hello").toString("base64url") }), false);
  hub.join(phone, join("mobile"));
  const envelope = validFrame("mobile-to-desktop", "8");
  assert.equal(hub.forward(phone, envelope), true);
  assert.deepEqual(desktop.messages.at(-1), { type: "forward", from: "mobile", envelope });
  assert.throws(() => hub.forward(phone, validFrame("desktop-to-mobile")), { code: "BAD_FRAME" });
  assert.throws(() => hub.forward(phone, { type: "handshake", payload: "x".repeat(32_769) }), { code: "BAD_ENVELOPE" });
  assert.throws(() => hub.forward(phone, { ...validFrame("mobile-to-desktop"), frame: { ...validFrame("mobile-to-desktop").frame, ciphertext: "A".repeat(1_100_000) } }), { code: "FRAME_TOO_LARGE" });
});

test("room cleanup emits offline and removes idle room records", () => {
  let now = 100;
  const hub = new RoomHub({ clock: () => now, idleTtlMs: 10 });
  const desktop = new FakePeer();
  const phone = new FakePeer();
  hub.join(desktop, join("desktop"));
  hub.join(phone, join("mobile"));
  hub.leave(desktop);
  assert.equal(phone.messages.at(-1).online, false);
  hub.leave(phone);
  now = 111;
  assert.equal(hub.sweep(), 1);
  assert.equal(hub.roomCount, 0);
});

test("Node development relay serves health and routes WebSocket frames", async (t) => {
  const relay = createRelayServer({ port: 0, host: "127.0.0.1" });
  const address = await relay.listen();
  t.after(async () => relay.close());
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, protocolVersion: 1 });

  const url = `ws://127.0.0.1:${address.port}/v1/relay`;
  const desktop = await openWebSocket(url);
  t.after(() => desktop.close());
  const desktopJoin = waitForMessage(desktop, (m) => m.type === "joined");
  desktop.send(JSON.stringify(join("desktop")));
  assert.equal((await desktopJoin).role, "desktop");

  const phone = await openWebSocket(url);
  t.after(() => phone.close());
  const phoneJoin = waitForMessage(phone, (m) => m.type === "joined");
  const desktopPresence = waitForMessage(desktop, (m) => m.type === "presence" && m.online);
  phone.send(JSON.stringify(join("mobile")));
  assert.equal((await phoneJoin).presence.online, true);
  assert.equal((await desktopPresence).role, "mobile");

  const forwarded = waitForMessage(phone, (m) => m.type === "forward");
  desktop.send(JSON.stringify(validFrame("desktop-to-mobile", "0")));
  const packet = await forwarded;
  assert.equal(packet.from, "desktop");
  assert.equal(packet.envelope.frame.direction, "desktop-to-mobile");
});

test("connections that never join are closed, and one address can't take every slot", async (t) => {
  const relay = createRelayServer({ port: 0, host: "127.0.0.1", joinTimeoutMs: 100, maxPerIp: 2 });
  const address = await relay.listen();
  t.after(async () => relay.close());
  const url = `ws://127.0.0.1:${address.port}/v1/relay`;
  const open = (u) => new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("refused")), { once: true });
  });
  const a = await open(url);
  const b = await open(url);
  await assert.rejects(open(url), /refused/);
  const closed = await new Promise((resolve) => a.addEventListener("close", () => resolve(true), { once: true }));
  assert.equal(closed, true, "idle unjoined connection is dropped");
  b.close();
});

test("rooms are isolated: per-role credentials, owner-only kick, per-address room cap", () => {
  const hub = new RoomHub({ maxRoomsPerIp: 2 });
  const room = (n) => Buffer.alloc(16, n).toString("base64url");
  const tok = (n) => Buffer.alloc(32, n).toString("base64url");
  const peer = (ip = "1.1.1.1") => Object.assign(new FakePeer(), { ip, closed: false, close() { this.closed = true; } });
  const j = (p, r, role, rt, ot) => hub.join(p, { type: "join", protocolVersion: 1, roomId: room(r), roomToken: tok(rt), role, ...(ot ? { ownerToken: tok(ot) } : {}) });

  // Two rooms, two pairs.
  const deskA = peer(); j(deskA, 1, "desktop", 1, 101);
  const phoneA = peer("2.2.2.2"); j(phoneA, 1, "mobile", 1);
  const deskB = peer("3.3.3.3"); j(deskB, 2, "desktop", 2, 102);
  const phoneB = peer("4.4.4.4"); j(phoneB, 2, "mobile", 2);

  // Traffic stays in its room.
  hub.forward(phoneA, { type: "handshake", payload: "aGVsbG8" });
  assert.equal(deskA.messages.at(-1).type, "forward");
  assert.ok(!deskB.messages.some((m) => m.type === "forward"), "room B saw nothing from room A");
  assert.ok(!phoneB.messages.some((m) => m.type === "forward"));

  // A phone of room A can't join room B, and can't take a desktop seat (no owner token, or the wrong one).
  assert.throws(() => j(peer("2.2.2.2"), 2, "mobile", 1), /AUTH|authentication/);
  assert.throws(() => j(peer("2.2.2.2"), 1, "desktop", 1), /owner token/);
  hub.leave(deskA);
  assert.throws(() => j(peer("2.2.2.2"), 1, "desktop", 1, 55), /authentication/);
  j(deskA, 1, "desktop", 1, 101);

  // Only the desktop can disconnect the phone, and only in its own room.
  assert.throws(() => hub.forward(phoneA, { type: "kick" }), /only the desktop/);
  assert.equal(hub.forward(deskA, { type: "kick" }), true);
  assert.equal(phoneA.closed, true);
  assert.equal(phoneB.closed, false, "room B's phone untouched");
  assert.equal(phoneA.messages.at(-1).code, "KICKED");

  // One address can't fill the relay with rooms.
  const busy = "9.9.9.9";
  j(peer(busy), 10, "desktop", 10, 110);
  j(peer(busy), 11, "desktop", 11, 111);
  assert.throws(() => j(peer(busy), 12, "desktop", 12, 112), /too many rooms/);
  j(peer("8.8.8.8"), 12, "desktop", 12, 112);
});
