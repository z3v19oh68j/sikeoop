import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import type { SkillStore as SkillStoreType } from "../../src/main/plugins/skills.ts";

// Exercise the real store and dependencies. Transform only the existing constructor parameter
// properties and resolve its extensionless imports so this runs with the normal Node test command.
const skillsURL = new URL("../../src/main/plugins/skills.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === skillsURL && ["./skill-audit", "./skill-review", "./skillhub"].includes(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === skillsURL) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
let SkillStore: typeof SkillStoreType;
try { ({ SkillStore } = await import(skillsURL)); } finally { hook.deregister(); }

const noFetch = async (): Promise<Response> => { throw new Error("Unexpected network request"); };
async function fixture(t: TestContext) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "skills-dirof-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "skills");
  await fs.mkdir(root);
  const store = new SkillStore(root, noFetch);
  const copySkill = async (name: string) => {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\ndescription: Local regression fixture\n---\n# Skill\n");
    return dir;
  };
  return { temp, root, store, copySkill };
}

test("hand-copied Chinese skills can be enabled, persisted, listed and disabled after restart", async t => {
  const { root, store, copySkill } = await fixture(t);
  for (const name of ["Web攻击类-API攻击", "Linux提权类"]) {
    const dir = await copySkill(name);
    await assert.rejects(fs.stat(path.join(dir, ".sweet.json")), { code: "ENOENT" });
    assert.equal((await store.list()).find(skill => skill.name === name)?.enabled, false);
    await store.setEnabled(name, true);
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".sweet.json"), "utf8"));
    assert.deepEqual(meta, { format: "standard", origin: "标准 Skill", source: "本地", enabled: true, installedAt: 0 });
    const restarted = new SkillStore(root, noFetch);
    assert.equal((await restarted.list()).find(skill => skill.name === name)?.enabled, true);
    assert.equal((await restarted.enabled()).find(skill => skill.name === name)?.dir, dir);
    await restarted.setEnabled(name, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, ".sweet.json"), "utf8")).enabled, false);
    assert.equal((await store.list()).find(skill => skill.name === name)?.enabled, false);
  }
});

test("English slug skills retain enable, disable and remove behavior", async t => {
  const { store, copySkill } = await fixture(t);
  const name = "web-api-attack";
  const dir = await copySkill(name);
  assert.equal(store.dirOf(name), dir);
  await store.setEnabled(name, true);
  assert.equal((await store.list())[0].enabled, true);
  await store.setEnabled(name, false);
  assert.equal((await store.list())[0].enabled, false);
  await store.remove(name);
  await assert.rejects(fs.stat(dir), { code: "ENOENT" });
});

test("dirOf accepts Unicode single components and resolves relative/trailing-separator roots", async t => {
  const { root, store } = await fixture(t);
  for (const name of ["中文目录", "日本語-Skill", "résumé", "技能🛠️", "Skill_中文.v2", "English Skill"])
    assert.equal(store.dirOf(name), path.join(root, name));
  for (const variant of [root + path.sep, path.relative(process.cwd(), root)]) {
    const relativeStore = new SkillStore(variant, noFetch);
    assert.equal(relativeStore.dirOf("中文目录"), path.resolve(root, "中文目录"));
  }
});

const invalidNames = ["", ".", "..", "../x", "..\\x", "a/b", "a\\b", "/tmp/x", "\\tmp\\x", ".hidden", ".sweet.json", "a\0b",
  ...Array.from({ length: 32 }, (_, code) => `a${String.fromCharCode(code)}b`),
  ...Array.from({ length: 33 }, (_, index) => `a${String.fromCharCode(127 + index)}b`),
];

test("unsafe names still throw Unknown skill and cannot toggle/remove outside the root", async t => {
  const { temp, root, store } = await fixture(t);
  const outside = path.join(temp, "x");
  await fs.mkdir(outside);
  const metadata = '{"enabled":false}';
  await fs.writeFile(path.join(outside, ".sweet.json"), metadata);
  for (const name of invalidNames) {
    assert.throws(() => store.dirOf(name), /^Error: Unknown skill:/);
    await assert.rejects(store.setEnabled(name, true), /^Error: Unknown skill:/);
    await assert.rejects(store.remove(name), /^Error: Unknown skill:/);
  }
  assert.equal(await fs.readFile(path.join(outside, ".sweet.json"), "utf8"), metadata);
  assert.deepEqual(await fs.readdir(root), []);
});

test("Chinese builtins retain update, disabled-state, deletion and explicit restore semantics", async t => {
  const { root, store } = await fixture(t);
  const name = "内置中文技能";
  const pack = (text: string) => [{ name, files: new Map([["SKILL.md", new TextEncoder().encode(text)]]) }];
  await store.syncBuiltin(pack("# v1"));
  assert.equal((await store.list())[0].enabled, true);
  await store.setEnabled(name, false);
  await store.syncBuiltin(pack("# v2"));
  assert.equal(await fs.readFile(path.join(root, name, "SKILL.md"), "utf8"), "# v2");
  assert.equal((await store.list())[0].enabled, false);
  await store.remove(name);
  await store.syncBuiltin(pack("# v2"));
  assert.deepEqual(await store.list(), []);
  await store.syncBuiltin(pack("# v2"), true);
  assert.equal((await store.list())[0].enabled, true);
});

test("syncBuiltin rejects traversal names without installing outside the root", async t => {
  const { temp, store } = await fixture(t);
  await assert.rejects(store.syncBuiltin([{ name: "../x", files: new Map([["SKILL.md", new TextEncoder().encode("# invalid")]]) }]),
    /^Error: Unknown skill:/);
  await assert.rejects(fs.stat(path.join(temp, "x")), { code: "ENOENT" });
});
