// A real desktop gateway + local relay for the Android interop test
// (sikeoop-android/app/src/test/.../HandshakeInteropTest.kt runs this with node).
// Prints one JSON line {"qr": "sikeoop://pair/…"} once ready, auto-approves the first phone that
// pairs, answers every RPC with {"echo": method}, and exits when stdin closes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRelayServer } from "../../relay/src/node-server.mjs";
import { MobileGateway } from "../../sweet-code-desktop/src/main/mobile/gateway.ts";
import { MobileStore } from "../../sweet-code-desktop/src/main/mobile/store.ts";

// RELAY_URL=wss://… uses that relay (e.g. the public one) instead of starting a local one.
const relay = process.env.RELAY_URL ? null : createRelayServer({ port: 0, host: "127.0.0.1" });
const address = await relay?.listen();
const dir = await mkdtemp(path.join(tmpdir(), "mobile-harness-"));
const store = new MobileStore(dir, { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() });
await store.load();
await store.setRelay(process.env.RELAY_URL ?? `ws://127.0.0.1:${address.port}/v1/relay`);

let ready;
const connected = new Promise((r) => (ready = r));
const gw = new MobileGateway({
  store,
  computerName: () => "互通测试电脑",
  dispatcher: () => ({ dispatch: async (req) => ({ jsonrpc: "2.0", id: req.id, result: { echo: req.method } }) }),
  view: () => ({ status: "idle", presence: { online: true }, computer: { id: "c", name: "互通测试电脑" }, pendingApprovals: 0 }),
  eventCursor: () => 0,
  subscribe: () => () => {},
  onChange: (s) => {
    if (s.relay.status === "connected") ready();
    if (s.pendingDevice) void gw.approveDevice(s.pendingDevice.id, true);
  },
});
await gw.start();
await gw.setEnabled(true);
await connected;
process.stdout.write(JSON.stringify({ qr: gw.createPairing().payload }) + "\n");

const shutdown = async () => {
  gw.stop();
  await relay?.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
};
process.stdin.on("end", shutdown);
process.stdin.resume();
setTimeout(shutdown, 60_000).unref();
