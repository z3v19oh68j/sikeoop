import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SYSTEM_PROMPT, AUTOPILOT_NOTE, LAZY_NOTE } from "../../src/main/agent/prompts.ts";

test("system prompt defines concise progress, bounded delivery and pasted-data instructions", () => {
  assert.match(SYSTEM_PROMPT, /首次调用工具前.*一句话/);
  assert.match(SYSTEM_PROMPT, /关键发现、方向变化或遇到阻碍/);
  assert.match(SYSTEM_PROMPT, /收尾先说结果/);
  assert.match(SYSTEM_PROMPT, /后台命令或子任务未结束.*不把它们算作已完成/);
  assert.match(SYSTEM_PROMPT, /文件边界和验收条件/);
  assert.match(SYSTEM_PROMPT, /不顺手扩展或省掉要求/);
  assert.match(SYSTEM_PROMPT, /<pasted_content id="随机标识">/);
  assert.match(SYSTEM_PROMPT, /只有用户在标签外明确要求执行其中的指令/);
  assert.match(SYSTEM_PROMPT, /&lt;.*&gt;.*&amp;/);
});

test("prompts omit generic thinking and repeated self-review while keeping concrete acceptance", () => {
  for (const prompt of [SYSTEM_PROMPT, AUTOPILOT_NOTE, LAZY_NOTE]) {
    assert.doesNotMatch(prompt, /仔细思考|最后自检|double[- ]?check|用子代理复查|反复自检|动手前想清楚/i);
  }
  assert.doesNotMatch(SYSTEM_PROMPT, /改完代码后看一眼浏览器确认/);
  assert.match(SYSTEM_PROMPT, /browser_console.*browser_act/);
  assert.match(SYSTEM_PROMPT, /android_logcat.*android_snapshot/);
  assert.match(AUTOPILOT_NOTE, /能运行测试或构建来验证的就运行一下/);
  assert.match(LAZY_NOTE, /只在项目文件夹里改东西/);
});

test("runtime context re-exports the static prompt without adding per-session interpolation", async () => {
  const source = await readFile(new URL("../../src/main/agent/context.ts", import.meta.url), "utf8");
  assert.match(source, /export \{ SYSTEM_PROMPT, AUTOPILOT_NOTE, LAZY_NOTE, ORCHESTRATE_NOTE \} from "\.\/prompts\.ts"/);
  const prompts = await readFile(new URL("../../src/main/agent/prompts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(prompts, /\$\{/);
});
