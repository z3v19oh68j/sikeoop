import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { SYSTEM_PROMPT } from "../../src/main/agent/prompts.ts";
import { UnlockEnv, unlockMode, withUnlockModule } from "../../src/main/agent/unlock.ts";
import { UNLOCK_CORE_EN, UNLOCK_CORE_ZH, UNLOCK_FILES, UNLOCK_MEMORY, UNLOCK_SKILLS } from "../../src/main/agent/unlock-bundle.ts";

const sealed = (rel: string) => readFile(new URL(`../../src/main/agent/unlock/${rel}`, import.meta.url), "utf8");

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[UnlockEnv];
  try {
    if (value === undefined) delete process.env[UnlockEnv];
    else process.env[UnlockEnv] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[UnlockEnv];
    else process.env[UnlockEnv] = prev;
  }
}

test("unlock module defaults to on and only explicit opt-out leaves the base prompt byte-identical", () => {
  for (const value of ["0", "off", " OFF ", "no", "false", "disabled"]) {
    withEnv(value, () => {
      assert.equal(unlockMode(), "off");
      assert.equal(withUnlockModule(SYSTEM_PROMPT), SYSTEM_PROMPT);
      assert.equal(withUnlockModule("BASE"), "BASE");
    });
  }
});

test("zh mode is the default and appends the sealed core and skills without touching the base", () => {
  for (const value of [undefined, "", "1", "full", " FULL ", "zh", "yes", "TRUE"]) {
    withEnv(value, () => {
      assert.equal(unlockMode(), "zh");
      const out = withUnlockModule("BASE");
      assert.ok(out.startsWith("BASE\n\n<unlock-module>"));
      assert.match(out, /cc-unlock v8\.0\.2/);
      assert.match(out, /Loop Engineering/);
      assert.match(out, /<skill name="loop-sec\.md">/);
      assert.match(out, /<skill name="ad-c2-postex\.md">/);
    });
  }
});

test("en mode injects only the English core", () => {
  withEnv("en", () => {
    assert.equal(unlockMode(), "en");
    const out = withUnlockModule("BASE");
    assert.ok(out.startsWith("BASE\n\n<unlock-module>"));
    assert.match(out, /technical sidekick/);
    assert.doesNotMatch(out, /cc-unlock v8\.0\.2/);
  });
});

test("bundle content matches the sealed files and the manifest covers them all", async () => {
  assert.equal(await sealed("CLAUDE.md"), UNLOCK_CORE_ZH);
  assert.equal(await sealed("system-prompt.md"), UNLOCK_CORE_EN);
  for (const name of Object.keys(UNLOCK_SKILLS)) assert.equal(await sealed(`skills/${name}`), UNLOCK_SKILLS[name]);
  for (const name of Object.keys(UNLOCK_MEMORY)) assert.equal(await sealed(`memory/${name}`), UNLOCK_MEMORY[name]);
  const onDisk = ["CLAUDE.md", "system-prompt.md"];
  for (const sub of ["memory", "skills"]) {
    const dir = new URL(`../../src/main/agent/unlock/${sub}`, import.meta.url);
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) onDisk.push(`${sub}/${name}`);
  }
  assert.deepEqual([...UNLOCK_FILES].sort(), onDisk.sort());
  assert.equal(UNLOCK_FILES.length, 26);
});
