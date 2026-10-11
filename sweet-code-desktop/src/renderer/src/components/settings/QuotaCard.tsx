import { useEffect, useState } from "react";
import type { QuotaSettings } from "@shared/types";
import { SettingRow, StatusBadge, Switch, cleanError } from "./ui";

/**
 * 额度用完后自动继续 (main/quota): when Claude Code / Codex or the main conversation stops on a usage
 * limit, send a message at the reset time. Saved by itself, apart from the 模型分工 save bar.
 */
export function QuotaCard() {
  const [q, setQ] = useState<QuotaSettings | null>(null);
  const [hours, setHours] = useState("5");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.sweet.quotaSettings().then((s) => {
      setQ(s);
      setHours(String(s.defaultDelayHours));
      setMessage(s.message);
    });
  }, []);
  if (!q) return null;

  async function save(patch: Partial<QuotaSettings>) {
    if (!q) return;
    setError("");
    try {
      const s = await window.sweet.setQuotaSettings({ ...q, ...patch });
      setQ(s);
      setHours(String(s.defaultDelayHours));
      setMessage(s.message);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const h = Number(hours);
  const hoursOk = Number.isInteger(h) && h >= 1 && h <= 24;
  const dirty = (hoursOk && h !== q.defaultDelayHours) || (message.trim() !== "" && message.trim() !== q.message);

  return (
    <SettingRow
      icon="clock"
      title="额度用完后自动继续"
      desc="Claude Code、Codex 或主对话因为额度用完停下时，到额度恢复的时间自动发一句话让它接着做。"
      status={q.autoResume ? <StatusBadge tone="ok">已打开</StatusBadge> : <StatusBadge tone="muted">没开</StatusBadge>}
      control={<Switch checked={q.autoResume} onChange={(autoResume) => void save({ autoResume })} label="额度用完后自动继续" />}
    >
      <div className={"st-quota" + (q.autoResume ? "" : " off")}>
        <label className="st-quota-field">
          <span>读不出重置时间时等多久</span>
          <span className="st-inline">
            <input
              type="number"
              min={1}
              max={24}
              step={1}
              value={hours}
              disabled={!q.autoResume}
              onChange={(e) => setHours(e.target.value)}
              aria-label="读不出重置时间时等几小时"
            />
            <span className="st-mini-label">小时（1–24）</span>
          </span>
        </label>
        <label className="st-quota-field">
          <span>到点发送的话</span>
          <input value={message} disabled={!q.autoResume} onChange={(e) => setMessage(e.target.value)} placeholder="继续" aria-label="到点发送的话" />
        </label>
      </div>
      <p className="hint">
        到点前你自己接着操作了（打字、发消息），这次就不会再自动发；会话已经关掉或者正在忙，也会跳过。等待中的计划在「调度台」里能看到、能取消。
      </p>
      <div className="st-inline">
        {!hoursOk && <span className="warn-text">等待时间填 1 到 24 之间的整数</span>}
        {error && <span className="err-text">{error}</span>}
        {saved && <span className="ok-text">已保存</span>}
        <span className="spacer" />
        <button
          type="button"
          className="mini-btn"
          disabled={!q.autoResume || !dirty || !hoursOk}
          onClick={() => void save({ defaultDelayHours: h, message: message.trim() || q.message })}
        >
          保存
        </button>
      </div>
    </SettingRow>
  );
}
