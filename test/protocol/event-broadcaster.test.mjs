import assert from "node:assert/strict";
import test from "node:test";
import { EventBroadcaster } from "../../sweet-code-desktop/src/main/mobile/event-broadcaster.ts";

test("remote event broadcaster fans out to independent clients", () => {
  const errors = [];
  const bus = new EventBroadcaster((error) => errors.push(error));
  const seen = [[], []];
  const offA = bus.subscribe((event) => seen[0].push(event));
  const offB = bus.subscribe((event) => seen[1].push(event));
  const event = { type: "text_delta", text: "hi" };
  bus.emit(event);
  assert.deepEqual(seen, [[event], [event]]);
  offA();
  bus.emit({ type: "done", reason: "end_turn" });
  assert.equal(seen[0].length, 1);
  assert.equal(seen[1].length, 2);
  assert.equal(bus.size, 1);
  offB();
  assert.equal(errors.length, 0);
});

test("one broken subscriber does not prevent remaining listeners", () => {
  const errors = [];
  const bus = new EventBroadcaster((error) => errors.push(error));
  let delivered = false;
  bus.subscribe(() => { throw new Error("receiver failed"); });
  bus.subscribe(() => { delivered = true; });
  bus.emit({ type: "workspace_changed" });
  assert.equal(delivered, true);
  assert.equal(errors.length, 1);
});

