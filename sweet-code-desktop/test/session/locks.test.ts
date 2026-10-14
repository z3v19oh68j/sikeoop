import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { FileLocks } from "../../src/main/session/locks.ts";

const TTL = 10 * 60_000;
test("T6-1: touch renews all live owner locks; untouched locks expire", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const locks = new FileLocks();
  t.after(() => locks.close());
  const files = ["a", "b", "untouched"].map(n => path.join(os.tmpdir(), `f6-${process.pid}-${n}`));
  assert.deepEqual(await locks.acquire("active", files.slice(0, 2)), { ok: true });
  assert.deepEqual(await locks.acquire("idle", [files[2]]), { ok: true });
  t.mock.timers.tick(TTL - 1);
  locks.touch("active");
  t.mock.timers.tick(TTL - 1);
  for (const file of files.slice(0, 2)) {
    const result = await locks.acquire("other", [file]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.owner, "active");
  }
  assert.deepEqual(await locks.acquire("other", [files[2]]), { ok: true });
  t.mock.timers.tick(1);
  assert.deepEqual(await locks.acquire("other", files.slice(0, 2)), { ok: true });
});

test("touch does not resurrect expired locks or interfere with release", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const locks = new FileLocks();
  t.after(() => locks.close());
  const file = path.join(os.tmpdir(), `f6-${process.pid}-expired`);
  await locks.acquire("old", [file]);
  t.mock.timers.tick(TTL);
  locks.touch("old");
  assert.deepEqual(await locks.acquire("new", [file]), { ok: true });
  locks.release("new");
  locks.touch("new");
  assert.deepEqual(await locks.acquire("third", [file]), { ok: true });
});
