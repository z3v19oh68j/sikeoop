import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAutoModel, autoPurpose } from "../../src/main/agent/route.ts";
import { orderedFailover } from "../../src/main/agent/failover.ts";
import { builtinFreePresets, PRESETS } from "../../src/main/providers/presets.ts";
import { modelDiscovery, availableModels, resolveAuto, withAutoFailover } from "../../src/main/providers/model-routing.ts";
import type { ResolvedProvider } from "../../src/main/providers/store.ts";

const input = { text: "", hasFiles: false, hasImages: false, planOpen: false, autopilot: false };
test("auto purpose separates conversation, programming, hard reasoning and subtasks", () => {
  assert.equal(autoPurpose({ ...input, text: "你好" }), "chat");
  assert.equal(autoPurpose({ ...input, text: "修复登录 bug" }), "coding");
  assert.equal(autoPurpose({ ...input, text: "请证明这个算法的复杂度" }), "hard");
  assert.equal(autoPurpose({ ...input, text: "复杂架构", autopilot: true }, "subtask"), "subtask");
  for (const property of ["hasFiles", "planOpen", "autopilot"])
    assert.equal(autoPurpose({ ...input, text: "hi", [property]: true }), "coding");
});

for (const purpose of ["chat", "compress", "subtask"] as const) {
  for (const marker of ["flash", "mini", "lite", "chat", "haiku"]) {
    test(`auto ${purpose}: cheap ${marker} match`, () => {
      assert.equal(selectAutoModel(["main", `Vendor/${marker.toUpperCase()}-v1`, "other-mini"], purpose), `Vendor/${marker.toUpperCase()}-v1`);
    });
  }
}
for (const marker of ["reasoner", "pro", "opus", "max", "thinking"]) {
  test(`auto hard: strong ${marker} match`, () => {
    assert.equal(selectAutoModel(["main", `Vendor/${marker.toUpperCase()}-v1`, "other-opus"], "hard"), `Vendor/${marker.toUpperCase()}-v1`);
  });
}
test("coding prefers general coding/sonnet models, then neutral ids, not light or strong variants", () => {
  assert.equal(selectAutoModel(["mini", "opus", "neutral", "sonnet"], "coding"), "sonnet");
  assert.equal(selectAutoModel(["code-mini", "coder-pro", "plain", "coder"], "coding"), "coder");
  assert.equal(selectAutoModel(["mini", "opus", "neutral"], "coding"), "neutral");
});
test("all purposes fallback to first usable id, with empty/auto sentinels excluded", () => {
  for (const purpose of ["chat", "compress", "subtask", "coding", "hard"] as const) {
    assert.equal(selectAutoModel(["", "auto", " unfamiliar ", "other"], purpose), "unfamiliar");
    assert.equal(selectAutoModel([], purpose), undefined);
    assert.equal(selectAutoModel(["auto", " "], purpose), undefined);
  }
  assert.deepEqual(orderedFailover("second", ["auto", "first", "second", "third", "first"]), ["second", "first", "third"]);
});
test("free preset is absent for empty build constants; enabled preset only uses injected values", () => {
  assert.equal(PRESETS.some(p => p.id === "builtin-free"), false);
  for (const [base, key] of [["", ""], ["https://provider.invalid", ""], ["", "test-only"], [" ", "test-only"]])
    assert.deepEqual(builtinFreePresets(base, key), []);
  const [preset] = builtinFreePresets("https://provider.invalid", "test-only");
  assert.equal(preset.baseURL, "https://provider.invalid");
  assert.equal(preset.builtinKey, "test-only");
  assert.equal(preset.defaultModel, "auto");
  assert.equal(preset.discoverModels, true);
});

function configured(id: string): ResolvedProvider {
  return { preset: { id, name: "Test", kind: "openai", baseURL: "", defaultModel: "auto", suggestedModels: ["first", "cheap-mini", "last"], needsKey: false, keyHint: "" },
    model: "auto", apiKey: "", baseURL: "", authMode: "api_key", openaiApi: "chat" };
}

test("auto resolves real ids, and eligible failures follow provider order once each", async () => {
  const p = configured("test-auto-order");
  const signal = new AbortController().signal;
  const picked = await resolveAuto(p, "subtask", signal);
  assert.equal(picked.model, "cheap-mini");
  assert.equal(p.model, "auto");
  assert.deepEqual(availableModels(p), ["first", "cheap-mini", "last"]);
  const attempted: string[] = [];
  const result = await withAutoFailover(p, "subtask", signal, async selected => {
    attempted.push(selected.model);
    if (selected.model !== "last") throw { status: 429 };
    return "success";
  });
  assert.equal(result, "success");
  assert.deepEqual(attempted, ["cheap-mini", "first", "last"]);
  modelDiscovery.invalidate(p.preset.id);
});
test("nonretryable failures, cancelled requests and emitted streams do not fail over", async () => {
  const p = configured("test-auto-errors"), controller = new AbortController();
  let calls = 0;
  await assert.rejects(withAutoFailover(p, "chat", controller.signal, async () => { calls++; throw { status: 400 }; }));
  assert.equal(calls, 1);
  await assert.rejects(withAutoFailover(p, "chat", controller.signal, async () => { calls++; throw { status: 503 }; }, () => false));
  assert.equal(calls, 2);
  controller.abort();
  await assert.rejects(resolveAuto(p, "chat", controller.signal), { name: "AbortError" });
  assert.equal(calls, 2);
});
test("fixed model stays fixed and empty auto list fails before model request", async () => {
  const p = configured("test-fixed"), signal = new AbortController().signal;
  assert.equal((await resolveAuto({ ...p, model: "chosen" }, "chat", signal)).model, "chosen");
  await assert.rejects(resolveAuto({ ...p, preset: { ...p.preset, suggestedModels: [] } }, "chat", signal), /没有可用模型/);
});
