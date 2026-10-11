import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, providerHealth, recordFailure, recordSuccess, resetProviderHealth } from "../../src/main/providers/health.ts";

const httpError = (status: number, message = "") => Object.assign(new Error(message), { status });

test("failures are classified as rate limit, quota or error", () => {
  assert.equal(classifyFailure(httpError(429, "Too many requests")), "rate_limited");
  assert.equal(classifyFailure(httpError(429, "You exceeded your current quota")), "quota");
  assert.equal(classifyFailure(httpError(429, "账户额度已用完")), "quota");
  assert.equal(classifyFailure(httpError(402)), "quota");
  assert.equal(classifyFailure(httpError(503)), "error");
  assert.equal(classifyFailure(httpError(401)), "error");
  assert.equal(classifyFailure(httpError(400, "bad request")), null);
  assert.equal(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" })), null);
});

test("the latest outcome wins and unrelated errors keep the last status", () => {
  resetProviderHealth();
  assert.equal(providerHealth("p"), undefined);
  recordFailure("p", httpError(429), 1);
  assert.deepEqual(providerHealth("p"), { status: "rate_limited", at: 1, message: "请求太频繁或额度用完了" });
  recordFailure("p", httpError(400), 2);
  assert.equal(providerHealth("p")?.at, 1);
  recordSuccess("p", 3);
  assert.deepEqual(providerHealth("p"), { status: "ok", at: 3 });
  resetProviderHealth();
});
