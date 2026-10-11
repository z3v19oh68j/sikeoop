import type { ContextSettings } from "@shared/types";
import type { MemoryStore } from "../memory/store";
import type { RagService } from "../rag/service";
import type { BuiltinHook } from "./bus";

// The app's own context features, built on the hook bus. Each module is imported only the
// first time its event fires (and only while its setting is on).

export interface BuiltinDeps {
  memory: MemoryStore;
  rag: RagService;
  settings(): ContextSettings;
}

export function builtinHooks(deps: BuiltinDeps): BuiltinHook[] {
  return [
    {
      id: "rules",
      name: "项目规则",
      description: "新对话开始时，读项目里的 AGENTS.md、CLAUDE.md、.cursorrules 等规则文件给 AI。",
      events: ["SessionStart"],
      enabled: () => deps.settings().rules,
      load: () => import("./builtin/rules").then((m) => m.create()),
    },
    {
      id: "memory",
      name: "长期记忆",
      description: "新对话开始时带上之前记住的事（你的偏好、项目约定），AI 也可以随时记下新的。",
      events: ["SessionStart"],
      enabled: () => deps.settings().memory,
      load: () => import("./builtin/memory").then((m) => m.createIndex(deps.memory)),
    },
    {
      id: "recent-session",
      name: "上次的进度",
      description: "新对话开始时，带上这个项目里上一次对话整理出的摘要（7 天内的），AI 就知道上次做到哪了。",
      events: ["SessionStart"],
      enabled: () => deps.settings().memory,
      load: () => import("./builtin/memory").then((m) => m.createRecentSession()),
    },
    {
      id: "recall",
      name: "相关记忆",
      description: "每条消息发出前，找出和它相关的记忆一起给 AI。",
      events: ["UserPromptSubmit"],
      enabled: () => deps.settings().memory && deps.settings().autoRecall,
      load: () => import("./builtin/memory").then((m) => m.createRecall(deps.memory)),
    },
    {
      id: "rag",
      name: "自动找相关代码",
      description: "每条消息发出前，在项目的代码索引里找出可能相关的几段代码一起给 AI，省得它到处翻文件。",
      events: ["UserPromptSubmit"],
      enabled: () => deps.settings().autoContext,
      load: () => import("./builtin/rag").then((m) => m.create(deps.rag)),
    },
  ];
}
