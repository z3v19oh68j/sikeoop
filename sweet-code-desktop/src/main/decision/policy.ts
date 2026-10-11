import type { Answer } from "./client";

// When a Jev answer can be taken as it is, and when it should go to the main model or a person
// (docs/jev-decision-layer.md §4). The defaults are deliberately strict; templates override them.

export interface Thresholds {
  /** noul: sure when p ≥ yes or p ≤ 1 − yes. */
  noulSure: number;
  /** choice: sure when confidence ≥ this and the lead over the runner-up ≥ choiceMargin. */
  choiceConfidence: number;
  choiceMargin: number;
  /** score: sure when confidence ≥ this and the distribution isn't split between two levels. */
  scoreConfidence: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { noulSure: 0.9, choiceConfidence: 0.8, choiceMargin: 0.3, scoreConfidence: 0.6 };

/** Options that mean "none of these fit": a sure pick of one still needs a look. */
const NONE_OPTION = /^(none|none_of_the_above|other|unknown|unsure|n\/?a)$/i;

export interface Assessment {
  sure: boolean;
  /** Why it isn't sure, in Chinese, for the agent and the review queue. */
  why?: string;
}

export function assess(a: Answer, t: Thresholds = DEFAULT_THRESHOLDS): Assessment {
  if (a.type === "noul") {
    return a.p >= t.noulSure || a.p <= 1 - t.noulSure ? { sure: true } : { sure: false, why: `是的概率 ${pct(a.p)}，不够确定` };
  }
  const ranked = Object.values(a.probabilities).sort((x, y) => y - x);
  if (a.type === "choice") {
    if (NONE_OPTION.test(a.choice)) return { sure: false, why: "选了「都不合适」" };
    if (a.confidence < t.choiceConfidence) return { sure: false, why: `最可能的「${a.choice}」只有 ${pct(a.confidence)}` };
    const margin = (ranked[0] ?? 0) - (ranked[1] ?? 0);
    return margin >= t.choiceMargin ? { sure: true } : { sure: false, why: `前两个选项差不多（只差 ${pct(margin)}）` };
  }
  if (a.confidence < t.scoreConfidence) return { sure: false, why: `最可能的等级只有 ${pct(a.confidence)}` };
  const split = Object.entries(a.probabilities).filter(([, p]) => p > 0.3);
  if (split.length >= 2) return { sure: false, why: `在 ${split.map(([k]) => a.legend[k] ?? k).join(" 和 ")} 之间拿不准` };
  return { sure: true };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** One answer as a short line for the agent: `team=billing 95%`, `severity=2.0「Material impact」94%`, `urgent=是 86%`. */
export function describe(name: string, a: Answer): string {
  if (a.type === "noul") return `${name}=${a.p >= 0.5 ? "是" : "否"} ${pct(a.p >= 0.5 ? a.p : 1 - a.p)}`;
  if (a.type === "choice") return `${name}=${a.choice} ${pct(a.confidence)}`;
  const level = Math.round(a.score);
  const label = a.legend[String(level)];
  return `${name}=${a.score.toFixed(1)}${label ? `「${label}」` : ""} ${pct(a.confidence)}`;
}
