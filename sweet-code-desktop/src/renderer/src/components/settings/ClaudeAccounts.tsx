import type { ClaudeAccount, ClaudeUsage } from "@shared/types";
import { AccountList, type AccountApi, type AccountUsage } from "./AccountList";

export const USAGE_WINDOWS: { key: keyof ClaudeUsage; label: string }[] = [
  { key: "five_hour", label: "5 小时" },
  { key: "seven_day", label: "7 天" },
  { key: "seven_day_sonnet", label: "7 天 Sonnet" },
  { key: "seven_day_overage_included", label: "超额额度" },
];

/** The two windows every account row shows; the account in use shows all of USAGE_WINDOWS. */
const MAIN_WINDOWS = USAGE_WINDOWS.slice(0, 2);

const API: AccountApi<ClaudeAccount> = {
  list: () => window.sweet.claudeAccounts(),
  switchTo: (id) => window.sweet.claudeAccountSwitch(id),
  remove: (id) => window.sweet.claudeAccountRemove(id),
};

function usageOf(a: ClaudeAccount): AccountUsage {
  const u = a.usage;
  if ("error" in u) return u;
  return {
    bars: (a.active ? USAGE_WINDOWS : MAIN_WINDOWS).flatMap(({ key, label }) => (u[key] ? [{ key, label, used: u[key].utilization, resetsAt: u[key].resets_at }] : [])),
  };
}

interface Props {
  reloadKey: number;
  adding: boolean;
  onToggleAdd(): void;
  onChanged(): void;
  onActiveChange(id: string): void;
}

/** Every logged-in Claude subscription account with its usage; switch, log out, add. */
export function ClaudeAccounts(props: Props) {
  return (
    <AccountList
      title="Claude 账号"
      api={API}
      usage={usageOf}
      emptyHint="还没有用站内登录添加的账号。点「添加账号」登录一个，就能在这里看额度。"
      {...props}
    />
  );
}
