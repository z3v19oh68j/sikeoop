// Routing by difficulty: before a message goes out, is it plainly light (a question, a translation,
// a greeting) or plainly heavy (change code, fix a bug, a long brief)? Anything in between stays on
// the current model: every switch costs the prompt cache, so the router only moves when it's sure.

import type { Effort, EffortPurpose, RoutingSettings } from "../../shared/types.ts";
import { isEffort } from "../providers/effort.ts";

export type Difficulty = "light" | "heavy";

export interface RouteInput {
  text: string;
  hasFiles: boolean;
  hasImages: boolean;
  /** A plan with steps still open: the task is under way, don't drop to a lighter model. */
  planOpen: boolean;
  autopilot: boolean;
}

const HEAVY =
  /实现|重构|修复|修改|改一下|改成|bug|报错|错误|异常|崩溃|优化|新增|添加|加一个|写一个|开发|设计|迁移|测试|调试|部署|架构|接口|函数|组件|页面|代码|\brefactor|\bimplement|\bfix|\bdebug|\bbuild|\bmigrate|\boptimi[sz]e|\bwrite (a|an|the)\b|\badd (a|an|the)\b/i;
const LIGHT =
  /是什么|什么意思|解释一下|翻译|总结|概括|查一下|在哪|怎么用|为什么|谢谢|你好|早上好|晚安|\bwhat is\b|\bwhat does\b|\bexplain\b|\btranslate\b|\bsummari[sz]e\b|\bthanks?\b|^\s*(hi|hello|hey)\b/i;

/** "light" / "heavy" when it's clear, null when it isn't (stay on the current model). */
export function classify(input: RouteInput): Difficulty | null {
  const text = input.text.trim();
  if (input.autopilot || input.planOpen || input.hasFiles) return "heavy";
  if (text.includes("```") || text.length > 300 || HEAVY.test(text)) return "heavy";
  if (!input.hasImages && text.length <= 80 && LIGHT.test(text)) return "light";
  return null;
}

export const DEFAULT_EFFORT: Record<EffortPurpose, Effort> = {
  chat: "low", subtask: "low", compress: "low", coding: "medium", hard: "high",
};

/** Heavy difficulty is only promoted when difficulty routing is enabled by the caller. */
export function selectEffort(purpose: EffortPurpose, overrides?: RoutingSettings["effort"], difficulty?: Difficulty | null, explicit?: Effort): Effort {
  const use = purpose === "coding" && difficulty === "heavy" ? "hard" : purpose;
  return isEffort(explicit) ? explicit : isEffort(overrides?.[use]) ? overrides![use]! : DEFAULT_EFFORT[use];
}

export function effortPurpose(input: RouteInput): "chat" | "coding" {
  return classify(input) === "heavy" ? "coding" : "chat";
}

/** Preserve omission (automatic defaults), reject malformed IPC overrides before saving. */
export function effortOverrides(value: unknown): RoutingSettings["effort"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("effort 设置无效");
  const out: NonNullable<RoutingSettings["effort"]> = {};
  for (const key of Object.keys(DEFAULT_EFFORT) as EffortPurpose[]) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    if (!isEffort(entry)) throw new Error(`effort.${key} 只支持 low / medium / high`);
    out[key] = entry;
  }
  return out;
}

/** Name heuristics, not a price/capability claim. Stable provider order breaks ties. */
const CHEAP_MODEL = /flash|mini|lite|chat|haiku/i;
const STRONG_MODEL = /reasoner|pro|opus|max|thinking/i;
const MAIN_MODEL = /sonnet|coder|code|instruct/i;
const HARD_TASK = /难题|复杂|推理|证明|算法|架构|\breason(?:ing)?\b|\bprove\b|\bcomplex\b|\barchitecture\b/i;

export function autoPurpose(input: RouteInput, purpose?: "subtask"): EffortPurpose {
  if (purpose) return purpose;
  if (HARD_TASK.test(input.text)) return "hard";
  const level = classify(input);
  return level === "light" ? "chat" : "coding";
}

export function selectAutoModel(models: readonly string[], purpose: EffortPurpose): string | undefined {
  const ids = [...new Set(models.map(m => m.trim()).filter(m => m && m.toLowerCase() !== "auto"))];
  if (purpose === "chat" || purpose === "compress" || purpose === "subtask")
    return ids.find(m => CHEAP_MODEL.test(m)) ?? ids[0];
  if (purpose === "hard") return ids.find(m => STRONG_MODEL.test(m)) ?? ids[0];
  return ids.find(m => MAIN_MODEL.test(m) && !CHEAP_MODEL.test(m) && !STRONG_MODEL.test(m))
    ?? ids.find(m => !CHEAP_MODEL.test(m) && !STRONG_MODEL.test(m)) ?? ids[0];
}
