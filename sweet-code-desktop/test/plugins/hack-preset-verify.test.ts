import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import type { SkillStore as SkillStoreType, BuiltinSkill } from "../../src/main/plugins/skills.ts";

const skillsURL = new URL("../../src/main/plugins/skills.ts", import.meta.url).href;
const forcedURL = new URL("../../src/main/plugins/forced-skills.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === skillsURL && ["./skill-audit", "./skill-review", "./skillhub"].includes(specifier))
      return nextResolve(`${specifier}.ts`, context);
    if (context.parentURL === forcedURL && specifier === "./skills.ts")
      return nextResolve("./skills.ts", context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === skillsURL || url === forcedURL) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
let SkillStore: typeof SkillStoreType;
let FORCED_SKILL_NAMES: string[];
let ensureHackPreset: (store: SkillStoreType) => Promise<string[]>;
let splitFrontmatter: (text: string) => { data: Record<string, unknown>; body: string };
try {
  ({ SkillStore, FORCED_SKILL_NAMES, splitFrontmatter } = await import(skillsURL));
  ({ ensureHackPreset } = await import(forcedURL));
} finally { hook.deregister(); }

const noFetch = async (): Promise<Response> => { throw new Error("Unexpected network request"); };

test("hack-preset 内置 skill frontmatter 合法", async () => {
  const md = await fs.readFile(new URL("../../src/main/plugins/builtin-skills/hack-preset/SKILL.md", import.meta.url), "utf8");
  const { data, body } = splitFrontmatter(md);
  assert.equal(data.name, "hack-preset");
  assert.ok(String(data.description).includes("zhenxin"));
  assert.ok(body.includes("zhenxin-recon"));
});

test("FORCED 名单一共 18 个（1 总入口 + 17 链）", () => {
  assert.equal(FORCED_SKILL_NAMES.length, 18);
  assert.ok(FORCED_SKILL_NAMES.includes("hack-preset"));
  assert.ok(FORCED_SKILL_NAMES.includes("zhenxin-web-attack"));
});

test("开机自检从 opencode 目录导入 zhenxin 链并锁定", async t => {
  const src = path.join(os.homedir(), ".config", "opencode", "skills");
  await fs.stat(path.join(src, "zhenxin-recon", "SKILL.md"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hack-preset-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SkillStore(root, noFetch);
  const installed = await ensureHackPreset(store);
  assert.ok(installed.includes("zhenxin-recon"));
  const item = (await store.list()).find(s => s.name === "zhenxin-recon")!;
  assert.equal(item.enabled, true);
  assert.equal(item.forced, true);
  await assert.rejects(store.setEnabled("zhenxin-recon", false), /强制预设/);
  await assert.rejects(store.remove("zhenxin-recon"), /强制预设/);
});

test("强制内置 skill 被删后 syncBuiltin 自动重装并启用", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hack-preset-restore-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SkillStore(root, noFetch);
  const pack = (text: string): BuiltinSkill[] => [{ name: "hack-preset", files: new Map([["SKILL.md", new TextEncoder().encode(text)]]) }];
  await store.syncBuiltin(pack("# v1"));
  assert.equal((await store.list()).find(s => s.name === "hack-preset")?.forced, true);
  await fs.rm(path.join(root, "hack-preset"), { recursive: true, force: true });
  await store.syncBuiltin(pack("# v1"));
  assert.equal((await store.list()).find(s => s.name === "hack-preset")?.enabled, true);
});
