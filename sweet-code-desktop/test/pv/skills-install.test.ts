import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPvSkills } from "../../src/main/pv/skills.ts";
import type { SkillStore, BuiltinSkill } from "../../src/main/plugins/skills.ts";

const names = ["pv-storyboard", "remotion-pv", "ffmpeg-recipes", "pv-html-timeline", "pv-audio-mix"];
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pv-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), installed = path.join(root, "installed");
  await fs.mkdir(source); await fs.mkdir(installed);
  const calls: BuiltinSkill[][] = [];
  const store = { dirOf: (name: string) => path.join(installed, name),
    syncBuiltin: async (pack: BuiltinSkill[]) => { calls.push(pack); },
  } as unknown as SkillStore;
  const put = async (name: string) => {
    await fs.mkdir(path.join(source, name), { recursive: true });
    await fs.writeFile(path.join(source, name, "SKILL.md"), `# ${name}\n`);
  };
  return { source, installed, store, calls, put };
}

test("PV 技能安装名单包含 timeline/mix，读取完整 SKILL.md 后交给 syncBuiltin", async t => {
  const f = await fixture(t);
  for (const name of names) await f.put(name);
  await installPvSkills(f.store, f.source);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].map(skill => skill.name), names);
  for (const skill of f.calls[0]) assert.equal(Buffer.from(skill.files.get("SKILL.md")!).toString(), `# ${skill.name}\n`);
});

test("不存在的资源目录/未写完的 SKILL.md 跳过，已安装目录保持不覆盖", async t => {
  const f = await fixture(t);
  await f.put("pv-storyboard"); await f.put("remotion-pv");
  await fs.mkdir(path.join(f.installed, "remotion-pv"));
  await fs.mkdir(path.join(f.source, "pv-audio-mix"));
  // pv-html-timeline has no directory; pv-audio-mix has a directory but no SKILL.md yet.
  await installPvSkills(f.store, f.source);
  assert.deepEqual(f.calls[0].map(skill => skill.name), ["pv-storyboard"]);
  await f.put("pv-html-timeline"); await f.put("pv-audio-mix");
  await installPvSkills(f.store, f.source);
  assert.deepEqual(f.calls[1].map(skill => skill.name), ["pv-storyboard", "pv-html-timeline", "pv-audio-mix"]);
});

test("SKILL.md 不是文件时保留错误，不把真实读取失败当作尚未提供资源", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, "pv-storyboard", "SKILL.md"), { recursive: true });
  await assert.rejects(installPvSkills(f.store, f.source), { code: "EISDIR" });
  assert.equal(f.calls.length, 0);
});
