import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CdpSession } from "../../src/main/browser/cdp/session.ts";
class Fake extends EventEmitter {
  attached = false;
  calls: any[] = [];
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  async sendCommand(method: string, params?: any, sessionId?: string) { this.calls.push({ method, params, sessionId }); return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "frame" } } } : {}; }
  event(method: string, params: any, sessionId?: string) { this.emit("message", {}, method, params, sessionId); }
}
test("OOPIF enables flattened children, routes commands and separates invalidation", async () => {
  const fake = new Fake(); const session = new CdpSession(fake); await session.connect();
  let documents = 0; let changed = 0; let received: unknown;
  session.on("document", () => documents++); session.on("framesChanged", () => changed++);
  session.on("event", (_method, _params, id) => received = id);
  fake.event("Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "frame" } });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(session.sessionIds(), ["child"]); assert.equal(session.frameSession("frame"), "child");
  assert.equal(session.frameIdForSession("child"), "frame");
  assert.ok(fake.calls.some(c => c.method === "Target.setAutoAttach" && c.params.flatten && c.sessionId === "child"));
  await session.send("DOM.resolveNode", {}, "child"); assert.equal(fake.calls.at(-1).sessionId, "child");
  fake.event("DOM.documentUpdated", {}, "child"); assert.equal(documents, 0); assert.equal(received, "child");
  fake.event("Target.detachedFromTarget", { sessionId: "child" }); assert.deepEqual(session.sessionIds(), []); assert.ok(changed >= 3);
  session.dispose();
});
test("network summary removes all query credentials and nonallowlisted headers or bodies", async () => {
  const fake = new Fake(); const session = new CdpSession(fake); await session.connect();
  fake.event("Network.requestWillBeSent", { requestId: "r", request: { url: "https://user:pass@example.com/a?token=secret#secret", method: "POST", postData: "secret", headers: { Cookie: "secret", Authorization: "secret", "X-Key": "secret", "Content-Type": "text/plain" } } }, "child");
  fake.event("Network.responseReceived", { requestId: "r", response: { status: 200, headers: { "Set-Cookie": "secret", "Content-Length": "5" } } }, "child");
  fake.event("Network.loadingFinished", { requestId: "r", encodedDataLength: 5 }, "child");
  const summary = session.networkSummary(); assert.equal(summary[0].url, "https://example.com/a"); assert.equal(summary[0].status, 200);
  assert.doesNotMatch(JSON.stringify(summary), /secret|postData|Cookie|Authorization/); summary[0].url = "changed";
  assert.equal(session.networkSummary()[0].url, "https://example.com/a"); await session.waitForIdle(200, 1); session.dispose();
});
test("downloads require contained real directory and record only known event GUIDs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cdp-download-"));
  const outside = await mkdtemp(path.join(tmpdir(), "cdp-outside-"));
  const fake = new Fake(); const session = new CdpSession(fake);
  try {
    const dir = await session.configureDownloads(root); assert.equal(dir, path.join(await realpath(root), ".sikeoop", "downloads"));
    fake.event("Browser.downloadProgress", { guid: "unknown", filePath: "/etc/passwd", state: "completed" });
    fake.event("Browser.downloadWillBegin", { guid: "known", suggestedFilename: "../../file.txt", url: "https://example.com/a?token=secret" });
    fake.event("Browser.downloadProgress", { guid: "known", filePath: "/etc/passwd", state: "completed", receivedBytes: 5 });
    assert.deepEqual(session.downloadSummary(), [{ guid: "known", filename: "file.txt", expectedPath: path.join(dir, "file.txt"), url: "https://example.com/a", state: "completed", receivedBytes: 5, totalBytes: undefined }]);
    await session.denyDownloads(); assert.deepEqual(session.downloadSummary(), []); assert.equal(fake.calls.at(-1).params.behavior, "deny");
    await rm(path.join(root, ".sikeoop"), { recursive: true }); await symlink(outside, path.join(root, ".sikeoop"));
    await assert.rejects(session.configureDownloads(root), /项目内/);
  } finally { session.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("network redacts non-HTTP URL payloads", async () => {
  const fake = new Fake(); const session = new CdpSession(fake); await session.connect();
  for (const url of ["data:text/plain,secret", "blob:https://example.com/secret", "javascript:secret", "file:///secret"])
    fake.event("Network.requestWillBeSent", { requestId: url, request: { url } });
  assert.ok(session.networkSummary().every(row => row.url === "[redacted URL]")); session.dispose();
});
test("download names cannot escape expected directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cdp-names-"));
  const fake = new Fake(); const session = new CdpSession(fake);
  try {
    const directory = await session.configureDownloads(root);
    for (const name of [".", "..", "", "../../escape", "..\\..\\escape", "bad\u0000name"]) {
      fake.event("Browser.downloadWillBegin", { guid: name, suggestedFilename: name, url: "data:text/plain,secret" });
    }
    for (const row of session.downloadSummary()) {
      assert.equal(path.dirname(row.expectedPath), directory);
      assert.ok(![".", "..", ""].includes(row.filename));
      assert.equal(row.url, "[redacted URL]");
      assert.ok(!("path" in row));
    }
  } finally { session.dispose(); await rm(root, { recursive: true, force: true }); }
});
