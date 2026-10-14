import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { noteRows, parseNotes } from "../../src/renderer/src/components/update/notes.ts";

const sample = `# sikeoop 9.9.9 更新公告

> 一句俏皮话，**看完**再更新。

开头的一段话。

## 新增

- **超级调度模式**（输入框左下角）：说一句要做的事。
  - 细节一
  - 细节二
- 没有加粗的一条，带 \`code\` 和 [链接](https://example.com)。

## 改进
1. **汇报更短**：只报四项。

## 修复

- **修好了闪退**

## 注意

- 会同时消耗多个模型的额度。

## 空的一节
`;

test("parseNotes: tagline, sections with tones, bold leads, nested details and loose paragraphs", () => {
  const parsed = parseNotes(sample);
  assert.equal(parsed.tagline, "一句俏皮话，看完再更新。");
  assert.deepEqual(parsed.sections.map((s) => [s.heading, s.tone, s.items.length]), [
    ["", "plain", 0], ["新增", "new", 2], ["改进", "better", 1], ["修复", "fix", 1], ["注意", "warn", 1],
  ]);
  assert.deepEqual(parsed.sections[0].paragraphs, ["开头的一段话。"]);
  assert.deepEqual(parsed.sections[1].items[0], { lead: "超级调度模式", text: "（输入框左下角）：说一句要做的事。", details: ["细节一", "细节二"] });
  assert.deepEqual(parsed.sections[1].items[1], { lead: "", text: "没有加粗的一条，带 code 和 链接。", details: [] });
  assert.deepEqual(parsed.sections[2].items[0], { lead: "汇报更短", text: "只报四项。", details: [] });
  assert.deepEqual(parsed.sections[3].items[0], { lead: "修好了闪退", text: "", details: [] });
});

test("parseNotes: empty, plain text and notes without headings", () => {
  assert.deepEqual(parseNotes(undefined), { tagline: "", sections: [] });
  assert.deepEqual(parseNotes("  \n"), { tagline: "", sections: [] });
  assert.deepEqual(parseNotes("修了几个小问题。").sections, [{ heading: "", tone: "plain", items: [], paragraphs: ["修了几个小问题。"] }]);
  assert.deepEqual(parseNotes("- 甲\n- 乙").sections[0].items.map((i) => i.text), ["甲", "乙"]);
});

test("every published 更新公告 parses into at least one section, and the card rows still come out", async () => {
  const dir = path.resolve(import.meta.dirname, "../../../更新公告");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), "utf8");
    const parsed = parseNotes(text);
    assert.ok(parsed.sections.some((s) => s.items.length > 0), file);
    assert.ok(noteRows(text).length > 0, file);
    for (const s of parsed.sections) for (const it of s.items) assert.doesNotMatch(it.lead + it.text, /\*\*/, file);
  }
});
