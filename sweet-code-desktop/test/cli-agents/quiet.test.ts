// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { QuietWatch, plainTail } from "../../src/main/cli-agents/quiet.ts";

test("a turn ends after output followed by silence, once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ended: string[] = [];
  const w = new QuietWatch(5000, (tail) => ended.push(tail));

  w.output("启动横幅");
  t.mock.timers.tick(10_000);
  assert.deepEqual(ended, [], "not armed: output alone means nothing");

  w.arm();
  t.mock.timers.tick(10_000);
  assert.deepEqual(ended, [], "armed but nothing printed yet: still thinking");

  w.output("正在改 a.ts\r\n");
  t.mock.timers.tick(4000);
  w.output("\x1b[32m改好了\x1b[0m\r\n");
  t.mock.timers.tick(4000);
  assert.deepEqual(ended, [], "output keeps pushing the end back");
  t.mock.timers.tick(1000);
  assert.deepEqual(ended, ["正在改 a.ts\n改好了"]);

  w.output("光标闪了一下");
  t.mock.timers.tick(10_000);
  assert.equal(ended.length, 1, "until the next prompt it stays ended");
});

test("stopping it (the tab closed) cancels a pending end", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ended = 0;
  const w = new QuietWatch(1000, () => ended++);
  w.arm();
  w.output("x");
  w.stop();
  t.mock.timers.tick(5000);
  assert.equal(ended, 0);
});

test("the tail is readable text: no colours, cursor moves or window titles", () => {
  assert.equal(plainTail("\x1b]0;title\x07\x1b[2J\x1b[1;1H\x1b[1mDone\x1b[0m   \r\n\r\n\r\n\r\nnext\x1b[?25h"), "Done\n\nnext");
  assert.equal(plainTail("x".repeat(50), 10), "x".repeat(10));
});

test("armed from now, it ends after silence even when nothing was printed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ended: string[] = [];
  const w = new QuietWatch(3000, (tail) => ended.push(tail));
  w.arm(true);
  t.mock.timers.tick(2000);
  w.output("Interrupted\r\n");
  t.mock.timers.tick(2000);
  assert.deepEqual(ended, [], "output pushes it back");
  t.mock.timers.tick(1000);
  assert.deepEqual(ended, ["Interrupted"]);

  const silent = new QuietWatch(3000, (tail) => ended.push(`silent:${tail}`));
  silent.arm(true);
  t.mock.timers.tick(3000);
  assert.deepEqual(ended, ["Interrupted", "silent:"]);
});
