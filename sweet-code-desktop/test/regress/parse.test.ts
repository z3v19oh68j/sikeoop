// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCandidate, generatePrompt, parseCandidates, parseVerdict, runPrompt, stripAnsi } from "../../src/main/regress/parse.ts";

const block = (items: unknown) => `我读完了。\n<<<REGRESS_ITEMS\n${JSON.stringify(items)}\nREGRESS_ITEMS>>>`;

test("the prompts carry the focus, the limit and the item", () => {
  assert.match(generatePrompt(undefined, 30), /重点：全项目.*最多 30 条/s);
  assert.match(generatePrompt("  登录  ", 5), /重点：登录/);
  const p = runPrompt({ title: "能登录", detail: "输入账号密码", criteria: "进入首页" });
  assert.match(p, /标题：能登录\n说明：输入账号密码\n通过标准：进入首页/);
  assert.match(p, /RESULT: PASS — 一句理由\nRESULT: FAIL — 一句理由$/);
});

test("the verdict is the RESULT line among the last five non-empty lines, bottom up", () => {
  assert.deepEqual(parseVerdict("看过了。\n\nRESULT: PASS — 行为符合").auto, "pass");
  assert.equal(parseVerdict("RESULT: FAIL — 少了校验\n").reason, "少了校验");
  assert.equal(parseVerdict("**RESULT: FAIL** - 加粗也认").auto, "fail");
  assert.equal(parseVerdict("result: pass: 小写和冒号").auto, "pass");
  assert.equal(parseVerdict("\x1b[32mRESULT: PASS\x1b[0m — 带颜色").auto, "pass");
  assert.equal(parseVerdict("RESULT: FAIL — 早先的\n改了主意\nRESULT: PASS — 最后的").auto, "pass", "the lowest one wins");
  assert.equal(parseVerdict("RESULT: PASS — 太靠前\n1\n2\n3\n4\n5").auto, "pending", "only the last five lines count");
  assert.equal(parseVerdict("我觉得没问题").auto, "pending");
  assert.equal(parseVerdict("RESULT: PASS 或 FAIL，我拿不准").auto, "pending", "a line naming both is no answer");
  assert.equal(parseVerdict("").auto, "pending");
  assert.equal(parseVerdict(`RESULT: FAIL — ${"长".repeat(900)}`).reason.length, 500);
  assert.equal(parseVerdict(`${"x".repeat(5000)}\nRESULT: PASS — ok`).excerpt.length, 2048);
});

test("candidates come from the last block; bad ones are dropped, long ones cut, repeats skipped", () => {
  const r = parseCandidates(
    block([
      { title: "能登录", detail: "d", owner: "frontend", criteria: "c" },
      { title: "能登录", detail: "重复", owner: "backend", criteria: "c" },
      { title: "已有的", detail: "d", owner: "both", criteria: "c" },
      { title: "  ", detail: "d", owner: "both", criteria: "c" },
      { title: "字段不是文字", detail: 3, owner: "both", criteria: "c" },
      { title: "奇怪的归属", detail: "d", owner: "ops", criteria: "c" },
      { title: "长".repeat(100), detail: "细".repeat(900), owner: "both", criteria: "准".repeat(900) },
      "不是对象",
    ]),
    ["已有的"],
    30,
  );
  assert.ok("candidates" in r);
  assert.deepEqual(r.candidates.map((c) => [c.title.slice(0, 5), c.owner]), [["能登录", "frontend"], ["奇怪的归属", "both"], ["长长长长长", "both"]]);
  assert.deepEqual([r.candidates[2].title.length, r.candidates[2].detail.length, r.candidates[2].criteria.length], [60, 500, 300]);

  const capped = parseCandidates(block(Array.from({ length: 10 }, (_, i) => ({ title: `第 ${i} 条`, detail: "", owner: "both", criteria: "" }))), [], 3);
  assert.ok("candidates" in capped && capped.candidates.length === 3);

  const two = parseCandidates(`${block([{ title: "旧的", detail: "", owner: "both", criteria: "" }])}\n改一下：\n${block([{ title: "新的", detail: "", owner: "both", criteria: "" }])}`, [], 30);
  assert.ok("candidates" in two);
  assert.deepEqual(two.candidates.map((c) => c.title), ["新的"]);
});

test("a reply without a usable block says so and hands back its end", () => {
  for (const reply of ["我没找到什么", "<<<REGRESS_ITEMS\n不是 JSON\nREGRESS_ITEMS>>>", '<<<REGRESS_ITEMS\n{"title":"不是数组"}\nREGRESS_ITEMS>>>']) {
    const r = parseCandidates(reply, [], 30);
    assert.ok("error" in r);
    assert.equal(r.error, "未找到条目块");
    assert.equal(r.rawExcerpt, reply);
  }
  const long = parseCandidates("x".repeat(9000), [], 30);
  assert.ok("error" in long && long.rawExcerpt.length === 2048);
});

test("a candidate is cleaned the same way wherever it comes from", () => {
  assert.equal(cleanCandidate(null), null);
  assert.equal(cleanCandidate({ title: "t", detail: "d", criteria: "c", owner: 3 }), null);
  assert.deepEqual(cleanCandidate({ title: " t ", detail: " d ", criteria: " c " }), { title: "t", detail: "d", owner: "both", criteria: "c" });
  assert.equal(stripAnsi("\x1b]0;标题\x07\x1b[1m粗\x1b[0m"), "粗");
});
