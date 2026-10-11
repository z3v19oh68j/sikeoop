import type { ResearchPreset, ResearchRun } from "@shared/types";
import type { Tone } from "../settings/ui";

/** agent_N → 「DeepSeek · deepseek-chat」, from the run's own mapping. */
export function agentNamer(run: Pick<ResearchRun, "agents"> | null | undefined) {
  const map = new Map((run?.agents ?? []).map((a) => [a.agent, `${a.providerName} · ${a.model}`]));
  return (agent: string) => map.get(agent) ?? agent;
}

export const TERMINATION: Record<string, string> = {
  SYSTEM_STATE_STABILIZED: "讨论稳定下来了",
  ALL_PASS_CONSECUTIVE: "大家都不再发言",
  BUDGET_EXHAUSTED: "到了轮数上限",
  SEMANTIC_SATURATION: "新观点不再出现",
};

export function terminationText(reason: string | undefined): string {
  if (!reason) return "没到收敛判据就结束了";
  if (reason.startsWith("ENTROPY_CONVERGED")) return "分歧不再变化";
  return TERMINATION[reason] ?? reason;
}

export const RUN_STATUS: Record<ResearchRun["status"], { text: string; tone: Tone }> = {
  preparing: { text: "准备中", tone: "accent" },
  running: { text: "进行中", tone: "accent" },
  done: { text: "完成", tone: "ok" },
  failed: { text: "失败", tone: "bad" },
  cancelled: { text: "已取消", tone: "muted" },
};

export const CHAIN_STATUS: Record<string, { text: string; tone: Tone }> = {
  active: { text: "存活", tone: "ok" },
  broken: { text: "被击穿", tone: "bad" },
  superseded: { text: "被新版本替代", tone: "muted" },
  archived: { text: "已归档", tone: "muted" },
};

/** Per round: every agent speaks, plus 1–3 evidence / format calls (report section 7.1). */
export function callEstimate(agents: number, rounds: number): [number, number] {
  return [(agents + 1) * rounds, (agents + 3) * rounds];
}

/** The science presets go first; marketing audits and "evaluate yourself" ones are tucked away. */
export const isScience = (p: ResearchPreset) => !p.id.startsWith("geo_") && !p.id.includes("self");

export function when(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const num = (n: number) => n.toLocaleString("zh-CN");
