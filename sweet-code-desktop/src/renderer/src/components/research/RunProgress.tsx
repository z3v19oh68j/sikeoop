import { useState } from "react";
import type { ResearchRun } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, cleanError } from "../settings/ui";
import { agentNamer } from "./format";

/** A run that is preparing or going: rounds, counts, who is talking to a model, failures, cancel. */
export function RunProgress({ run, onOpenDispatch }: { run: ResearchRun; onOpenDispatch(): void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const name = agentNamer(run);
  const p = run.progress;
  const max = p?.maxRounds || run.request.maxRounds;
  const round = p?.round ?? 0;

  async function cancel() {
    setError("");
    try {
      await window.sweet.researchCancel(run.id);
      setAsking(false);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  return (
    <section className="rs-card rs-progress" aria-live="polite">
      <header className="rs-card-head">
        <span className="rs-pulse" aria-hidden="true" />
        <h3>{run.status === "preparing" ? "正在启动…" : "讨论进行中"}</h3>
        <StatusBadge tone="accent">{run.status === "preparing" ? "准备中" : "进行中"}</StatusBadge>
      </header>
      <p className="rs-question">{run.request.question}</p>

      <div className="rs-rounds">
        <div className="rs-rounds-text">
          <b>第 {round} 轮</b>
          <span className="hint">
            上限 {max} 轮 · 讨论稳定后会提前结束，不一定跑满
          </span>
        </div>
        <div className="rs-bar" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.min(1, max ? round / max : 0)})` }} />
        </div>
      </div>

      <div className="rs-stats">
        <Stat k="命题" v={p?.claims ?? 0} />
        <Stat k="推理链" v={p?.chains ?? 0} />
        <Stat k="攻击" v={p?.attacks ?? 0} />
      </div>

      <div className="rs-agents">
        {run.agents.map((a) => {
          const calling = p?.calling.includes(a.agent);
          const failed = p?.failures.some((f) => f.agent === a.agent);
          return (
            <span key={a.agent} className={"rs-agent" + (calling ? " calling" : "") + (failed ? " failed" : "")} title={calling ? "正在等模型回复" : undefined}>
              <span className="rs-agent-dot" aria-hidden="true" />
              <span className="rs-agent-no">{a.agent}</span>
              {a.providerName} · {a.model}
              {calling && <span className="sr-only">（正在调用）</span>}
            </span>
          );
        })}
      </div>

      {p?.activity && (
        <p className="rs-activity">
          <Icon name="thought" /> {p.activity}
        </p>
      )}

      {p && p.failures.length > 0 && (
        <div className="rs-failures">
          <div className="rs-label">调用失败 {p.failures.length} 次</div>
          <ul>
            {p.failures.map((f, i) => (
              <li key={i}>
                <b>{name(f.agent)}</b>
                <span>{f.message}</span>
                <time>{new Date(f.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              </li>
            ))}
          </ul>
          <p className="hint">某个模型一直失败时，它这几轮等于没发言，结论会少一个视角。多半是 Key、余额或限流的问题。</p>
        </div>
      )}

      <div className="rs-actions">
        <button type="button" className="link-btn" onClick={onOpenDispatch}>
          在调度台里也能看到这次运行
        </button>
        <span className="spacer" />
        {asking ? (
          <>
            <span className="hint">会结束整个运行进程，这次拿不到结果，已花的调用不会退回。</span>
            <button type="button" className="mini-btn" onClick={() => setAsking(false)}>
              继续跑
            </button>
            <button type="button" className="send danger" onClick={() => void cancel()}>
              确定取消
            </button>
          </>
        ) : (
          <button type="button" className="mini-btn" onClick={() => setAsking(true)}>
            <Icon name="stop" /> 取消
          </button>
        )}
      </div>
      {error && <p className="err-text">{error}</p>}
    </section>
  );
}

function Stat({ k, v }: { k: string; v: number }) {
  return (
    <div className="rs-stat">
      <span className="v">{v}</span>
      <span className="k">{k}</span>
    </div>
  );
}
