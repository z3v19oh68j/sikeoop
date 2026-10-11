import { test } from "node:test";
import assert from "node:assert/strict";
import { runBrowserBatch } from "../../src/main/browser/batch.ts";

test("batch executes every action sequentially and reports completion", async () => {
  const actions = ["fill", "click", "press", "select", "check", "hover", "scroll", "upload", "wait_for"];
  const seen: string[] = [];
  const result = await runBrowserBatch(actions, async action => { seen.push(action); });
  assert.deepEqual(seen, actions);
  assert.deepEqual(result, { completed: 9, failedStep: null, reason: null });
});
for (const reason of ["element missing", "The user declined file upload.", "The user declined submit."]) {
  test(`batch stops immediately: ${reason}`, async () => {
    const seen: number[] = [];
    const result = await runBrowserBatch([1, 2, 3], async step => { seen.push(step); if (step === 2) throw new Error(reason); });
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(result, { completed: 1, failedStep: 2, reason });
  });
}
test("batch cancellation never starts a later step", async () => {
  const controller = new AbortController(); const seen: number[] = [];
  const result = await runBrowserBatch([1, 2], async step => { seen.push(step); controller.abort(); }, controller.signal);
  assert.deepEqual(seen, [1]); assert.equal(result.failedStep, 2); assert.match(result.reason!, /cancelled/);
});
test("pre-cancelled batch starts no steps", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runBrowserBatch([1], async () => { assert.fail("must not run"); }, controller.signal);
  assert.equal(result.completed, 0); assert.equal(result.failedStep, 1);
});
