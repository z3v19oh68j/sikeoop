// Run: node --test test/renderer/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBlocks } from "../../src/renderer/src/markdown-blocks.ts";

test("paragraphs, headings, lists and tables at the left margin are separate blocks", () => {
  const text = "## 标题\n\n第一段，\n还是第一段。\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |";
  assert.deepEqual(splitBlocks(text), ["## 标题", "第一段，\n还是第一段。", "- a\n- b", "| x | y |\n|---|---|\n| 1 | 2 |"]);
});

test("a fenced code block stays whole, blank lines and all", () => {
  const code = "```ts\nconst a = 1;\n\nconst b = 2;\n\n\nexport { a, b };\n```";
  assert.deepEqual(splitBlocks(`前面\n\n${code}\n\n后面`), ["前面", code, "后面"]);
  const tilde = "~~~\nx\n\ny\n~~~";
  assert.deepEqual(splitBlocks(`${tilde}\n\nz`), [tilde, "z"]);
});

test("a fence closes only with the same character, at least as long, and nothing after it", () => {
  const outer = "````md\n```js\nx\n\n```\n\nstill inside\n````";
  assert.deepEqual(splitBlocks(`${outer}\n\nafter`), [outer, "after"]);
  const tildeInside = "```\n~~~\n\nstill inside\n```";
  assert.deepEqual(splitBlocks(`${tildeInside}\n\nafter`), [tildeInside, "after"]);
  const infoString = "```\na\n\n```ts\n\nstill inside\n```";
  assert.deepEqual(splitBlocks(infoString), [infoString]);
});

test("while a fence is still open (the reply is streaming), everything after it is the last block", () => {
  const text = "说明\n\n```py\ndef f():\n\n    return 1\n\n";
  assert.deepEqual(splitBlocks(text), ["说明", "```py\ndef f():\n\n    return 1\n\n"]);
});

test("an indented line after a blank line belongs to the block before it", () => {
  const item = "1. 第一步\n\n   第一步的第二段\n\n       缩进代码\n\n2. 第二步";
  assert.deepEqual(splitBlocks(item), ["1. 第一步\n\n   第一步的第二段\n\n       缩进代码", "2. 第二步"]);
});

test("leading and repeated blank lines never make an empty block", () => {
  assert.deepEqual(splitBlocks("\n\na\n\n\n\nb"), ["\n\na\n\n", "b"]);
  assert.deepEqual(splitBlocks(""), [""]);
  assert.deepEqual(splitBlocks("一行"), ["一行"]);
});

test("the blocks put back together are the text", () => {
  const text = "# T\n\n段落\n\n```\nx\n\ny\n```\n\n- a\n\n  继续\n\n> 引用\n\n结尾";
  assert.equal(splitBlocks(text).join("\n\n"), text);
});
