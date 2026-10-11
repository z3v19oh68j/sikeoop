import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = resolve(root, "protocol/fixtures");
const files = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json")).sort();
const frames = await Promise.all(files.map(async (name) => [name, JSON.parse(await readFile(resolve(fixtureDir, name), "utf8"))]));

test("all checked-in protocol fixtures are valid JSON-RPC 2.0 frames", () => {
  assert.equal(files.length, 26);
  for (const [name, frame] of frames) {
    assert.equal(frame.jsonrpc, "2.0", name);
    assert.ok(frame.method || Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"), name);
    assert.equal(Boolean(frame.method), !Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"), name);
  }
});

test("fixture coverage includes every mobile request method and server event", () => {
  const methods = new Set(frames.map(([, frame]) => frame.method).filter(Boolean));
  for (const method of [
    "initialize", "session.snapshot", "chat.send", "chat.cancel", "approval.respond",
    "question.answer", "turn.undo", "diff.get", "agents.list", "agents.respond",
    "mobile.event", "mobile.status", "mobile.ask", "mobile.presence", "mobile.log",
  ]) assert.ok(methods.has(method), `missing fixture for ${method}`);
});

test("all fixture filenames are unique and represent JSON files", () => {
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.every((name) => name.endsWith(".json")));
});

