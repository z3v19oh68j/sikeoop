import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpConnector, acpEnvironment } from "../../src/main/connectors/acp.ts";
import { AgentApprovals } from "../../src/main/connectors/approval.ts";
import { parseAcpLine, updateProgress, permissionCard, permissionOutcome, stopStatus } from "../../src/main/connectors/acp-protocol.ts";
import type { DispatchProgress } from "../../src/shared/types.ts";

const stub = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-test-"));
  const cwd = path.join(dir, "workspace"); await fs.mkdir(cwd);
  const log = path.join(dir, "rpc.jsonl");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const records = async (): Promise<any[]> => (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { cwd, log, records };
}
function gone(pid: number) { assert.throws(() => process.kill(pid, 0), /ESRCH/); }

for (const choice of ["opaque:once", "opaque:forever", "opaque:no", null]) {
  test(`stdio handshake, progress and permission round trip: ${choice}`, async t => {
    const f = await fixture(t); const events: DispatchProgress[] = [];
    const c = new AcpConnector({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], readOnly: true, model: "provider/model", progress: p => events.push(p), permission: async card => {
      assert.equal(card.title, "原始权限标题"); assert.equal(card.options[0].name, "只这一次"); assert.deepEqual(card.options[0].extra, { v: 1 }); return choice;
    } });
    const r = await c.run("job", "permission", new AbortController().signal);
    assert.equal(r.outcome, "end_turn"); assert.ok(r.text.startsWith("hello "));
    const rows = await f.records(); gone(rows[0].pid);
    assert.equal(rows[0].cwd, await fs.realpath(f.cwd)); assert.equal(rows[0].config.model, "provider/model");
    assert.equal(rows[0].config.permission, "ask"); assert.deepEqual(rows[0].config.plugin, []);
    const methods = rows.filter(r => r.method).map(r => r.method);
    assert.deepEqual(methods, ["initialize", "session/new", "session/set_mode", "session/prompt"]);
    assert.deepEqual(rows.find(r => r.method === "initialize").params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false });
    assert.deepEqual(rows.find(r => r.method === "session/new").params, { cwd: f.cwd, mcpServers: [] });
    assert.deepEqual(rows.find(r => r.id === "permission-opaque").result, choice === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: choice } });
    assert.ok(events.some(p => p.type === "tool" && p.status === "completed"));
    assert.ok(events.some(p => p.type === "permission")); assert.equal(c.alive(), false);
  });
}
test("permission timeout is cancelled, never implicitly allowed", async t => {
  const f = await fixture(t); let aborted = false;
  const c = new AcpConnector({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], permissionTimeoutMs: 20, progress: () => {}, permission: async (_card, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {});
  } });
  await c.run("j", "permission", new AbortController().signal);
  assert.equal(aborted, true);
  assert.deepEqual((await f.records()).find(r => r.id === "permission-opaque").result, { outcome: { outcome: "cancelled" } });
});
for (const behavior of ["", "ignore-cancel"]) test(`cancel notification and actual child exit: ${behavior || "cooperative"}`, async t => {
  const f = await fixture(t); const ac = new AbortController();
  const c = new AcpConnector({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log, behavior], cancelGraceMs: 30, permission: async () => null, progress: p => { if (p.type === "text") ac.abort(); } });
  const result = await c.run("j", "cancel", ac.signal).catch(e => e);
  if (!behavior) assert.equal(result.outcome, "cancelled"); else assert.match(result.message, /grace expired/);
  const rows = await f.records(); assert.ok(rows.some(r => r.method === "session/cancel")); gone(rows[0].pid);
});
for (const task of ["crash", "disconnect"]) test(`child ${task} fails outstanding prompt`, async t => {
  const f = await fixture(t);
  const c = new AcpConnector({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log], permission: async () => null, progress: () => {} });
  await assert.rejects(c.run("j", task, new AbortController().signal), /exited|disconnected/);
  gone((await f.records())[0].pid);
});
for (const behavior of ["handshake-crash", "handshake-hang", "malformed", "no-plan"]) test(`handshake failure closes child: ${behavior}`, async t => {
  const f = await fixture(t);
  const c = new AcpConnector({ cwd: f.cwd, bin: process.execPath, args: [stub, f.log, behavior], readOnly: true, requestTimeoutMs: 1000, permission: async () => null, progress: () => {} });
  await assert.rejects(c.run("j", "normal", new AbortController().signal));
  gone((await f.records())[0].pid);
  if (behavior === "no-plan") assert.equal((await f.records()).some(r => r.method === "session/prompt"), false);
});
test("environment whitelist drops inherited provider secrets/config/plugins", () => {
  const env = acpEnvironment({ PATH: "/bin", HOME: "/home/u", OPENAI_API_KEY: "secret", SIKEOOP_TOKEN: "secret", OPENCODE_CONFIG_CONTENT: '{"plugin":["bad"]}' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.SIKEOOP_TOKEN, undefined);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!), { permission: "ask", plugin: [] });
});
test("pure protocol validates framing, maps progress, preserves options and fails unknown stops", () => {
  assert.throws(() => parseAcpLine('{"jsonrpc":"1.0"}'));
  assert.equal(updateProgress({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: {} } }, "s"), null);
  assert.equal(stopStatus("end_turn"), "done"); assert.equal(stopStatus("cancelled"), "cancelled");
  for (const r of ["max_tokens", "max_turn_requests", "refusal", "unknown"]) assert.equal(stopStatus(r), "failed");
  const card = permissionCard({ jsonrpc: "2.0", method: "session/request_permission", params: { sessionId: "s", toolCall: {}, options: [{ optionId: "x", name: "raw", kind: "allow_always" }] } }, "j", "c");
  assert.deepEqual(permissionOutcome(card, "bogus"), { outcome: { outcome: "cancelled" } });
});
test("approval broker selects original optionId; abort removes stale card", async () => {
  const shown: any[] = []; const removed: string[] = [];
  const broker = new AgentApprovals(c => shown.push(c), id => removed.push(id));
  const card = { id: "c", jobId: "j", sessionId: "s", title: "raw", toolCall: {}, options: [{ optionId: "opaque", name: "原始", kind: "reject_always" }] };
  const controller = new AbortController(); const promise = broker.ask(card, controller.signal);
  assert.equal(shown[0], card); assert.throws(() => broker.answer("c", "bad"));
  broker.answer("c", "opaque"); assert.equal(await promise, "opaque"); assert.deepEqual(removed, ["c"]);
  const next = broker.ask(card, controller.signal); controller.abort(); assert.equal(await next, null); assert.equal(broker.has("c"), false);
});
