import { memo, useEffect, useState } from "react";
import type { ClusterRun, ClusterView } from "@shared/types";
import { Icon } from "./Icon";
import "../styles/cluster.css";

// The Harmony cluster console: every dispatch to a cluster role, live. Each card is one dispatch
// (its own session); the card shows the role's latest activity while it runs and its summary,
// route and errors once it has finished.

const LABEL: Record<ClusterRun["status"], string> = {
  running: "运行中",
  ok: "完成",
  fail: "失败",
  blocked: "受阻",
  cancelled: "已停止",
};

const EMPTY: ClusterView = { runs: [], running: 0, batchTotal: 0, batchDone: 0, batchFailed: 0 };

function elapsed(run: ClusterRun, now: number): string {
  const sec = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

interface Props {
  hidden: boolean;
}

export const ClusterConsole = memo(function ClusterConsole({ hidden }: Props) {
  const [view, setView] = useState<ClusterView>(EMPTY);
  const [now, setNow] = useState(Date.now());

  // Followed only while it is on screen; fetched afresh each time it comes back.
  useEffect(() => {
    if (hidden) return;
    void window.sweet.clusterView().then(setView);
    return window.sweet.onClusterChanged(setView);
  }, [hidden]);

  // The elapsed time of running cards ticks once a second; nothing else needs the clock.
  useEffect(() => {
    if (view.running === 0 || hidden) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view.running, hidden]);

  const finished = view.runs.filter((r) => r.status !== "running").length;

  return (
    <main className="group cluster" hidden={hidden}>
      <div className="section-head cluster-head">
        <div>
          <strong>鸿蒙集群</strong>
          <span className="cluster-counts">
            {" "}运行中 {view.running} · 本轮 {view.batchDone}/{view.batchTotal}
            {view.batchFailed > 0 ? ` · 失败 ${view.batchFailed}` : ""}
          </span>
        </div>
        <button type="button" className="cluster-clear" disabled={finished === 0} onClick={() => void window.sweet.clearCluster().then(setView)}>
          <Icon name="trash" /> 清除已完成
        </button>
      </div>

      {view.runs.length === 0 ? (
        <div className="wiki-empty">
          <p>还没有分派过任何子代理。</p>
          <p className="cluster-hint">长任务里，主 Agent 通过 dispatch_agent 分派的角色会显示在这里。</p>
        </div>
      ) : (
        <ul className="cluster-list">
          {view.runs.map((run) => (
            <li key={run.id} className={`cluster-card ${run.status}`}>
              <div className="cluster-card-head">
                <span className={`cluster-status ${run.status}`}>
                  <Icon name={run.status === "ok" ? "check-circle" : run.status === "running" ? "refresh" : run.status === "cancelled" ? "stop" : "warning"} />
                  {LABEL[run.status]}
                </span>
                <code className="cluster-role">{run.role}</code>
                <span className="cluster-time">{elapsed(run, now)}</span>
              </div>
              <p className="cluster-goal">{run.goal}</p>
              {run.status === "running" && <p className="cluster-activity">{run.activity}</p>}
              {run.status !== "running" && run.summary && <p className="cluster-summary">{run.summary}</p>}
              {run.routeRole && run.status !== "running" && <p className="cluster-route">下一步建议：{run.routeRole}</p>}
              {run.errors.length > 0 && (
                <ul className="cluster-errors">
                  {run.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
});
