import type { WritingAction } from "@shared/types";

/** The writing buttons, in order. */
export const ACTIONS: { id: WritingAction; label: string; hint: string }[] = [
  { id: "polish_zh", label: "学术润色（中）", hint: "让中文更通顺、更像论文" },
  { id: "polish_en", label: "学术润色（英）", hint: "Improve academic English" },
  { id: "proofread", label: "纠错", hint: "找出语法、拼写、标点错误" },
  { id: "translate_zh_en", label: "中 → 英", hint: "翻译成英文" },
  { id: "translate_en_zh", label: "英 → 中", hint: "翻译成中文" },
  { id: "shorten", label: "缩写", hint: "压短，保留要点" },
  { id: "expand", label: "扩写", hint: "补充论证和过渡" },
  { id: "title_abstract", label: "生成标题和摘要", hint: "根据正文写标题和摘要" },
];
export const ACTION_LABEL = Object.fromEntries(ACTIONS.map((a) => [a.id, a.label])) as Record<WritingAction, string>;

