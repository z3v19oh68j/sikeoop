import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuiltinFreeProviders, mergeBuiltinFreeProviders } from "../../src/main/providers/builtin-free.ts";
import { builtinFreePresets } from "../../src/main/providers/presets.ts";

const entry = (id = "one", protocol: "openai" | "anthropic" = "openai") => ({
  id, name: `Free ${id}`, baseUrl: `https://example.invalid/${id}/v1`, key: "test-placeholder", protocol,
});

test("builtin JSON supports both protocols, namespaces ids and defaults to empty", () => {
  assert.deepEqual(parseBuiltinFreeProviders(), []);
  const parsed = parseBuiltinFreeProviders(JSON.stringify([entry(), entry("two", "anthropic")]));
  assert.deepEqual(parsed.map(p => [p.id, p.protocol]), [["builtin-free-one", "openai"], ["builtin-free-two", "anthropic"]]);
  assert.deepEqual(parseBuiltinFreeProviders(JSON.stringify(parsed)), parsed);
  const presets = builtinFreePresets("", "", JSON.stringify([entry(), entry("two", "anthropic")]));
  assert.equal(presets.length, 2);
  for (const p of presets) {
    assert.equal(p.defaultModel, "auto"); assert.equal(p.discoverModels, true); assert.equal(p.builtinFree, true);
  }
  assert.equal(presets[1].compat, true);
});

test("invalid JSON and nonarrays log one sanitized diagnostic", () => {
  for (const raw of ["bad-test-placeholder", "null", "{}", '"test-placeholder"']) {
    const logs: string[] = [];
    assert.deepEqual(parseBuiltinFreeProviders(raw, m => logs.push(m)), []);
    assert.equal(logs.length, 1); assert.ok(!logs[0].includes("test-placeholder"));
  }
});

test("each invalid or duplicate item is ignored with one value-free log", () => {
  const invalid = [null, [], {}, { ...entry(), key: "" }, { ...entry(), name: " " },
    { ...entry(), protocol: "other" }, { ...entry(), baseUrl: "not-a-url" },
    { ...entry(), baseUrl: "file:///tmp" }, { ...entry(), baseUrl: "https://test-placeholder@example.invalid" },
    { ...entry(), baseUrl: "https://example.invalid/?key=test-placeholder" },
    { ...entry(), id: "__proto__" }, { ...entry(), id: "has space" }, { ...entry(), key: 3 }];
  const logs: string[] = [];
  const result = parseBuiltinFreeProviders(JSON.stringify([...invalid, entry(), entry(), entry("two", "anthropic")]), m => logs.push(m));
  assert.deepEqual(result.map(p => p.id), ["builtin-free-one", "builtin-free-two"]);
  assert.equal(logs.length, invalid.length + 1);
  assert.ok(logs.every(m => !m.includes("test-placeholder") && !m.includes("example.invalid")));
});

test("legacy configuration merges once, array wins endpoint and id duplicates", () => {
  const raw = JSON.stringify([entry()]);
  const merged = mergeBuiltinFreeProviders(raw, "https://example.invalid/legacy/v1/", "legacy-placeholder");
  assert.deepEqual(merged.map(p => p.id), ["builtin-free-one", "builtin-free"]);
  assert.equal(merged[1].baseUrl, "https://example.invalid/legacy/v1");
  const dup = mergeBuiltinFreeProviders(raw, entry().baseUrl + "/", "legacy-placeholder");
  assert.equal(dup.length, 1); assert.equal(dup[0].key, "test-placeholder");
  assert.equal(mergeBuiltinFreeProviders(JSON.stringify([entry("builtin-free")]), "https://example.invalid/legacy", "legacy-placeholder").length, 1);
  assert.equal(mergeBuiltinFreeProviders(raw, "", "legacy-placeholder").length, 1);
  assert.equal(mergeBuiltinFreeProviders(raw, "https://example.invalid/legacy", "").length, 1);
  const logs: string[] = [];
  assert.equal(mergeBuiltinFreeProviders(raw, "bad", "legacy-placeholder", m => logs.push(m)).length, 1);
  assert.equal(logs.length, 1);
});

test("a fixed model pins the preset, and one endpoint may serve several models", () => {
  const glm = { ...entry("glm"), baseUrl: entry().baseUrl, model: " glm-test " };
  const parsed = parseBuiltinFreeProviders(JSON.stringify([entry(), glm]));
  assert.deepEqual(parsed.map(p => [p.id, p.model]), [["builtin-free-one", undefined], ["builtin-free-glm", "glm-test"]]);
  const [auto, fixed] = builtinFreePresets("", "", JSON.stringify([entry(), glm]));
  assert.equal(auto.defaultModel, "auto"); assert.equal(auto.discoverModels, true);
  assert.equal(fixed.defaultModel, "glm-test"); assert.equal(fixed.discoverModels, false);
  assert.deepEqual(fixed.suggestedModels, ["glm-test"]);
  const logs: string[] = [];
  assert.equal(parseBuiltinFreeProviders(JSON.stringify([glm, { ...glm, id: "glm2" }]), m => logs.push(m)).length, 1);
  assert.equal(parseBuiltinFreeProviders(JSON.stringify([{ ...entry(), model: "" }]), m => logs.push(m)).length, 0);
  assert.equal(logs.length, 2);
});
