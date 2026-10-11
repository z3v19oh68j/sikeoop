// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../src/main/agent/route.ts";
import { failoverReason } from "../../src/main/agent/failover.ts";

const base = { hasFiles: false, hasImages: false, planOpen: false, autopilot: false };

test("difficulty: clear cases route, unclear ones stay put", () => {
  assert.equal(classify({ ...base, text: "useEffect 是什么意思？" }), "light");
  assert.equal(classify({ ...base, text: "把这段翻译成英文" }), "light");
  assert.equal(classify({ ...base, text: "hi" }), "light");
  assert.equal(classify({ ...base, text: "帮我修复登录页的报错" }), "heavy");
  assert.equal(classify({ ...base, text: "refactor the store into two modules" }), "heavy");
  assert.equal(classify({ ...base, text: "看看这个\n```ts\nconst a = 1\n```" }), "heavy");
  assert.equal(classify({ ...base, text: "好的，继续" }), null);
  // A task under way doesn't drop to a lighter model, even for a short question.
  assert.equal(classify({ ...base, text: "这一步是什么意思？", planOpen: true }), "heavy");
  assert.equal(classify({ ...base, text: "这是什么？", hasImages: true }), null);
});

test("failover: errors another model can get past, and ones it can't", () => {
  assert.match(failoverReason({ status: 429 }) ?? "", /频繁/);
  assert.match(failoverReason({ status: 402 }) ?? "", /余额/);
  assert.match(failoverReason({ status: 401 }) ?? "", /Key/);
  assert.match(failoverReason({ status: 529 }) ?? "", /不可用/);
  assert.match(failoverReason(Object.assign(new Error("x"), { name: "APIConnectionError" })) ?? "", /连不上/);
  assert.match(failoverReason(new Error("fetch failed")) ?? "", /网络/);
  assert.equal(failoverReason({ status: 400 }), null);
  assert.equal(failoverReason(Object.assign(new Error("aborted"), { name: "APIUserAbortError" })), null);
  assert.equal(failoverReason("nope"), null);
});
