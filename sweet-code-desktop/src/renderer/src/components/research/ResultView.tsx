import { useEffect, useRef, useState } from "react";
import type { CcResult, ResearchRun } from "@shared/types";
import { researchZones, targetChain, type ResearchClaimView, type ResearchZone } from "@shared/research";
import { Icon } from "../Icon";
import { StatusBadge } from "../settings/ui";
import { CHAIN_STATUS, agentNamer, num, pct, terminationText } from "./format";

const ZONES: { id: ResearchZone; title: string; note: string }[] = [
  { id: "consensus", title: "共识区", note: "被反复攻击后仍然站得住" },
  { id: "contested", title: "争议区", note: "有证据支持，但还有人不服" },
  { id: "collapsed", title: "崩塌区", note: "证据弱，或推理链被击穿" },
  { id: "unscrutinized", title: "未审查区", note: "没人攻击过，还不能当真" },
];

/** A finished run: the four zones (recomputed with researchZones), the summary and convergence. */
export function ResultView({ run, result }: { run: ResearchRun; result: CcResult }) {
  const [tab, setTab] = useState<"zones" | "summary">("zones");
  const [openId, setOpenId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const z = researchZones(result);
  const name = agentNamer(run);
  /** Refs of the evidence library this run used; anything else came from a model and is unverified. */
  const mine = new Set(run.repositoryRefs ?? []);
  const open = z.claims.find((c) => c.claim.claim_id === openId) ?? null;

  useEffect(() => {
    if (openId) detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [openId]);

  return (
    <section className="rs-card rs-result" aria-label="研究结果">
      <header className="rs-card-head">
        <Icon name="check-circle" />
        <h3>结果</h3>
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="结果视图">
          <button type="button" role="tab" aria-selected={tab === "zones"} className={tab === "zones" ? "on" : undefined} onClick={() => setTab("zones")}>
            四区图
          </button>
          <button type="button" role="tab" aria-selected={tab === "summary"} className={tab === "summary" ? "on" : undefined} onClick={() => setTab("summary")}>
            总结
          </button>
        </div>
      </header>
      <p className="rs-question">{result.question}</p>

      <Convergence result={result} />

      {tab === "summary" ? (
        <div className="rs-summary">
          <div className="rs-summary-text">{result.natural_summary || "（这次没有生成总结）"}</div>
          <details className="st-disclosure">
            <summary>
              <Icon name="chevron-right" /> 原始结论图（Chain-Centric 输出的文字版）
            </summary>
            <pre className="rs-raw">{result.divergence_map}</pre>
          </details>
        </div>
      ) : (
        <>
          <div className="rs-zones">
            {ZONES.map((zone) => {
              const list = z.zones[zone.id];
              const broken = zone.id === "collapsed" ? z.brokenChains : [];
              return (
                <div key={zone.id} className={"rs-zone " + zone.id}>
                  <div className="rs-zone-head">
                    <span className={"rs-mark " + zone.id} aria-hidden="true" />
                    <h4>{zone.title}</h4>
                    <span className="rs-count">{list.length}</span>
                    <span className="rs-zone-note">{zone.note}</span>
                  </div>
                  {list.length === 0 && broken.length === 0 && <p className="rs-zone-empty">这一区是空的</p>}
                  <ul>
                    {list.map((v) => (
                      <ClaimRow key={v.claim.claim_id} v={v} on={v.claim.claim_id === openId} onClick={() => setOpenId(openId === v.claim.claim_id ? null : v.claim.claim_id)} />
                    ))}
                  </ul>
                  {broken.length > 0 && (
                    <div className="rs-broken">
                      <div className="rs-label">被击穿的推理链 {broken.length}</div>
                      <ul>
                        {broken.map((c) => (
                          <li key={c.chain_id}>
                            <button type="button" onClick={() => setOpenId(c.claim_id)} title="看它属于哪条命题">
                              <s>{c.steps[0]?.assertion || c.chain_id}</s>
                              <span className="rs-who">{name(c.agent)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div ref={detailRef}>{open ? <ClaimDetail v={open} name={name} mine={mine} onClose={() => setOpenId(null)} /> : <p className="hint rs-tip">点一条命题，看它的推理链和受到的攻击。</p>}</div>
        </>
      )}
    </section>
  );
}

function ClaimRow({ v, on, onClick }: { v: ResearchClaimView; on: boolean; onClick(): void }) {
  return (
    <li>
      <button type="button" className={"rs-claim " + v.zone + (on ? " on" : "")} aria-expanded={on} onClick={onClick}>
        <span className="rs-claim-desc">
          {v.tier === "ironclad" && <span className="rs-tier iron">铁证</span>}
          {v.tier === "consensus" && <span className="rs-tier">共识</span>}
          {v.claim.description || "（没有描述）"}
        </span>
        <span className="rs-claim-stats">
          <span title="被攻击的次数">攻击 {v.claim.attacks}</span>
          <span title="还活着的推理链占比">存活 {pct(v.survivalRate)}</span>
          <span title="综合了证据独立性、存活率和攻击次数">可信度 {v.trust.toFixed(2)}</span>
          <span title="证据彼此独立的程度（alpha）">独立性 {v.claim.alpha.toFixed(2)}</span>
        </span>
      </button>
    </li>
  );
}

function ClaimDetail({ v, name, mine, onClose }: { v: ResearchClaimView; name(agent: string): string; mine: Set<string>; onClose(): void }) {
  const chainIds = new Set(v.chains.map((c) => c.chain_id));
  return (
    <div className={"rs-detail " + v.zone}>
      <header>
        <span className={"rs-mark " + v.zone} aria-hidden="true" />
        <h4>{v.claim.description || v.claim.claim_id}</h4>
        <button type="button" className="icon-btn square" onClick={onClose} aria-label="收起" title="收起">
          <Icon name="close" />
        </button>
      </header>
      <p className="rs-claim-stats">
        <span>攻击 {v.claim.attacks} 次</span>
        <span>存活率 {pct(v.survivalRate)}</span>
        <span>可信度 {v.trust.toFixed(2)}</span>
        <span>独立性 {v.claim.alpha.toFixed(2)}</span>
        <span>证据 {v.claim.evidence_count} 条</span>
      </p>

      <div className="rs-label">推理链 {v.chains.length}</div>
      {v.chains.length === 0 && <p className="hint">没有推理链。</p>}
      {v.chains.map((c) => {
        const st = CHAIN_STATUS[c.status] ?? { text: c.status, tone: "muted" as const };
        return (
          <div key={c.chain_id} className={"rs-chain " + c.status}>
            <div className="rs-chain-head">
              <code>{c.chain_id}</code>
              <span className="rs-who">{name(c.agent)}</span>
              <span className="hint">第 {c.version} 版</span>
              <StatusBadge tone={st.tone}>{st.text}</StatusBadge>
            </div>
            <ol className="rs-steps">
              {c.steps.map((s) => {
                const deps = Array.isArray(s.depends_on) ? (s.depends_on as unknown[]).map(String) : s.depends_on ? [String(s.depends_on)] : [];
                return (
                  <li key={s.step_id}>
                    <span className="rs-step-id">{s.step_id}</span>
                    <div>
                      <p>{s.assertion}</p>
                      {(s.evidence.length > 0 || deps.length > 0) && (
                        <div className="rs-refs">
                          {s.evidence.map((r) => (
                            <span key={r} className={"rs-ref" + (mine.has(r) ? " mine" : "")} title={mine.has(r) ? "来自你的证据库" : "模型给的引用，未核实"}>
                              {r}
                            </span>
                          ))}
                          {s.evidence.some((r) => mine.has(r)) && <span className="rs-ref-note mine">来自你的证据库</span>}
                          {s.evidence.some((r) => !mine.has(r)) && <span className="rs-ref-note">模型给的引用，未核实</span>}
                          {deps.length > 0 && <span className="rs-dep">依赖 {deps.join("、")}</span>}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}

      <div className="rs-label">受到的攻击 {v.attacks.length}</div>
      {v.attacks.length === 0 ? (
        <p className="hint">输出里没有找到针对它的攻击记录。</p>
      ) : (
        <ul className="rs-attacks">
          {v.attacks.map((a) => {
            const chain = targetChain(a.target);
            const step = a.target.split("/").pop();
            return (
              <li key={a.attack_id}>
                <div className="rs-attack-head">
                  <span className="rs-who">{name(a.attacker)}</span>
                  <Icon name="chevron-right" />
                  <span>
                    {chainIds.has(chain) ? <code>{chain}</code> : chain} 的 {step}
                  </span>
                </div>
                <p>{a.claim_preview}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Convergence({ result }: { result: CcResult }) {
  const t = result.token_estimates;
  const series = result.entropy_trajectory
    .map((e) => (typeof e.H_sym === "number" ? e.H_sym : typeof e.H_remaining === "number" ? e.H_remaining : null))
    .filter((x): x is number => x !== null);
  const metric = result.entropy_trajectory.some((e) => typeof e.H_sym === "number") ? "H_sym" : "H_remaining";
  return (
    <div className="rs-converge">
      <div className="rs-converge-item">
        <span className="k">讨论了</span>
        <span className="v">{result.total_rounds} 轮</span>
      </div>
      <div className="rs-converge-item">
        <span className="k">为什么停</span>
        <span className="v">{terminationText(result.termination_reason)}</span>
      </div>
      <div className="rs-converge-item" title="Chain-Centric 自己的粗略统计，格式重试、新颖度判断等调用没算进去，实际更多">
        <span className="k">模型调用（偏低）</span>
        <span className="v">{num(t.calls)} 次</span>
      </div>
      <div className="rs-converge-item" title="按字符数除以 4 粗估，只供参考">
        <span className="k">token 粗估（偏低）</span>
        <span className="v">
          入 {num(t.input)} · 出 {num(t.output)}
        </span>
      </div>
      <div className="rs-converge-item">
        <span className="k">证据池</span>
        <span className="v">{result.evidence_pool_size} 条</span>
      </div>
      {series.length > 2 && (
        <div className="rs-converge-item rs-spark-wrap" title={`每轮的 ${metric}：越平稳说明讨论越收敛`}>
          <span className="k">分歧变化（{metric}）</span>
          <Sparkline values={series} />
        </div>
      )}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 120;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg className="rs-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
