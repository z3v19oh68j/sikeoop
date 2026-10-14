import type { CodexQuotaLimit, CodexQuotaWindow, OpenAIAccount } from "@shared/types";
import { AccountList, type AccountApi, type AccountUsage, type UsageBar } from "./AccountList";

const API: AccountApi<OpenAIAccount> = {
  list: () => window.sweet.openaiAccounts(),
  switchTo: (id) => window.sweet.openaiAccountSwitch(id),
  remove: (id) => window.sweet.openaiAccountRemove(id),
};

/** 18000 → "5 小时", 604800 → "7 天"; the endpoint's first window is the short one. */
function windowLabel(w: CodexQuotaWindow, fallback: string): string {
  const s = w.window_seconds;
  if (!s) return fallback;
  return s % 86_400 === 0 ? `${s / 86_400} 天` : s % 3600 === 0 ? `${s / 3600} 小时` : `${Math.round(s / 60)} 分钟`;
}

function limitBars(l: CodexQuotaLimit, name = ""): UsageBar[] {
  const pre = name ? `${name} · ` : "";
  return [
    ...(l.primary ? [{ key: `${name}:primary`, label: pre + windowLabel(l.primary, "5 小时"), used: l.primary.used_percent, resetsAt: l.primary.resets_at }] : []),
    ...(l.secondary ? [{ key: `${name}:secondary`, label: pre + windowLabel(l.secondary, "7 天"), used: l.secondary.used_percent, resetsAt: l.secondary.resets_at }] : []),
  ];
}

/** Two main windows for every account; the account in use also shows the additional limits. */
function usageOf(a: OpenAIAccount): AccountUsage {
  const q = a.usage;
  if ("error" in q) return q;
  const bars = [...limitBars(q), ...(a.active ? q.additional.flatMap((x) => limitBars(x, x.name)) : [])];
  // The bars already say so when one of them is at 100%.
  const shown = bars.some((b) => Math.round(b.used) >= 100);
  return { bars, warn: q.limit_reached && !shown ? "订阅额度已用完" : undefined };
}

function planOf(a: OpenAIAccount): string | undefined {
  return a.plan_type || ("error" in a.usage ? undefined : a.usage.plan_type);
}

interface Props {
  reloadKey: number;
  adding: boolean;
  onToggleAdd(): void;
  onChanged(): void;
  onActiveChange(id: string): void;
}

/** Every logged-in ChatGPT subscription account with its quota; switch, log out, add. */
export function OpenAIAccounts(props: Props) {
  return <AccountList title="ChatGPT 账号" api={API} usage={usageOf} tag={planOf} emptyHint="还没有账号数据。点「添加账号」登录一个，就能在这里看额度。" {...props} />;
}
