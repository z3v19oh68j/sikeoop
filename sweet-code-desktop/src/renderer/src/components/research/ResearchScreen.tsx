import { memo, useEffect, useState } from "react";
import type { CcResult, ResearchCandidate, ResearchEnv, ResearchPreset, ResearchRun } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, cleanError } from "../settings/ui";
import { MoreMenu } from "../plugins/ui";
import { EnvCard } from "./EnvCard";
import { EMPTY_DRAFT, NewStudy, type StudyDraft } from "./NewStudy";
import { RunProgress } from "./RunProgress";
import { ResultView } from "./ResultView";
import { RUN_STATUS, terminationText, when } from "./format";
import "../../styles/settings.css";
import "../../styles/plugins.css";
import "../../styles/research.css";

interface Props {
  hidden: boolean;
  /** Open the settings dialog on a provider (to fill its key). */
  onSettings(providerId: string): void;
  onOpenDispatch(): void;
  /** From 论文工坊: open the new-study form with this evidence repository file chosen. */
  /** From the paper workshop: an evidence repository, and the question when it brings one. */
  initialRepository?: { path: string; question?: string; at: number };
}

const LIVE = new Set<ResearchRun["status"]>(["preparing", "running"]);

/**
 * 深度科研: several models argue over one question with Chain-Centric (a separate Python process),
 * and the claims that survive the attacks are sorted into four zones.
 */
export const ResearchScreen = memo(function ResearchScreen({ hidden, onSettings, onOpenDispatch, initialRepository }: Props) {
  const [env, setEnv] = useState<ResearchEnv | null>(null);
  const [presets, setPresets] = useState<ResearchPreset[]>([]);
  const [candidates, setCandidates] = useState<ResearchCandidate[]>([]);
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  /** null = the new-study form. */
  const [viewId, setViewId] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; data: CcResult | null } | null>(null);
  const [error, setError] = useState("");
  /** The new-study form, kept while other runs are being looked at. */
  const [draft, setDraft] = useState<StudyDraft>(EMPTY_DRAFT);

  useEffect(() => {
    void window.sweet.researchEnv().then(setEnv);
    void window.sweet.researchPresets().then(setPresets);
    void window.sweet.researchList().then(setRuns);
    return window.sweet.onResearchEvent((e) => {
      if (e.type === "env") setEnv(e.env);
      else setRuns((list) => (list.some((r) => r.id === e.run.id) ? list.map((r) => (r.id === e.run.id ? e.run : r)) : [e.run, ...list]));
    });
  }, []);

  // Keys may be filled in the settings dialog meanwhile: refresh the candidates whenever the page shows.
  useEffect(() => {
    if (!hidden) void window.sweet.researchCandidates().then(setCandidates);
  }, [hidden]);

  useEffect(() => {
    if (!initialRepository) return;
    const { path, question } = initialRepository;
    setDraft((d) => ({ ...d, repo: "file", file: path, ...(question?.trim() ? { question } : {}) }));
    setViewId(null);
  }, [initialRepository?.at]);

  const view = runs.find((r) => r.id === viewId) ?? null;

  // Load the result once the viewed run has one.
  useEffect(() => {
    if (!view?.hasResult || result?.id === view.id) return;
    setError("");
    window.sweet.researchResult(view.id).then(
      (data) => setResult({ id: view.id, data }),
      (e) => setError(cleanError(e)),
    );
  }, [view?.id, view?.hasResult, result?.id]);

  async function remove(id: string) {
    try {
      await window.sweet.researchDelete(id);
      setRuns((list) => list.filter((r) => r.id !== id));
      if (viewId === id) setViewId(null);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  const envReady = !!env && env.python.found && env.installed && !env.installing;

  return (
    <main className="research" hidden={hidden}>
      <div className="rs-inner">
        <header className="rs-head">
          <div>
            <h1>深度科研</h1>
            <p className="hint">让几个 AI 围绕一个问题互相挑错，留下经得起攻击的结论，也标出还有争议、已经站不住的说法。</p>
          </div>
          {viewId && (
            <button type="button" className="send rs-accent" onClick={() => setViewId(null)}>
              <Icon name="plus" /> 新研究
            </button>
          )}
        </header>

        <div className="rs-layout">
          <div className="rs-main">
            <EnvCard env={env} onEnv={setEnv} />
            {error && <p className="err-text">{error}</p>}
            {!view ? (
              <NewStudy
                ready={envReady}
                presets={presets}
                candidates={candidates}
                onSettings={onSettings}
                draft={draft}
                onDraft={setDraft}
                onStarted={(run) => {
                  setRuns((list) => [run, ...list.filter((r) => r.id !== run.id)]);
                  setViewId(run.id);
                }}
              />
            ) : LIVE.has(view.status) ? (
              <RunProgress run={view} onOpenDispatch={onOpenDispatch} />
            ) : view.hasResult ? (
              result?.id === view.id && result.data ? (
                <ResultView key={view.id} run={view} result={result.data} />
              ) : result?.id === view.id ? (
                <p className="rs-card hint">结果文件找不到了。</p>
              ) : (
                <p className="rs-card hint">正在读取结果…</p>
              )
            ) : (
              <section className="rs-card">
                <header className="rs-card-head">
                  <Icon name={view.status === "failed" ? "warning" : "stop"} />
                  <h3>{view.status === "failed" ? "这次没跑成" : "已取消"}</h3>
                  <StatusBadge tone={RUN_STATUS[view.status].tone}>{RUN_STATUS[view.status].text}</StatusBadge>
                </header>
                <p className="rs-question">{view.request.question}</p>
                {view.error && <p className="err-text">{view.error}</p>}
                {view.progress?.failures.length ? <p className="hint">过程中有 {view.progress.failures.length} 次模型调用失败。</p> : null}
              </section>
            )}
          </div>

          <aside className="rs-history" aria-label="历史研究">
            <h2>
              历史 <span className="rs-count">{runs.length}</span>
            </h2>
            {runs.length === 0 && <p className="hint">还没有做过研究。</p>}
            <ul>
              {runs.map((r) => {
                const st = RUN_STATUS[r.status];
                return (
                  <li key={r.id} className={"rs-hist" + (r.id === viewId ? " on" : "")}>
                    <button type="button" className="rs-hist-main" onClick={() => setViewId(r.id)} aria-current={r.id === viewId ? "true" : undefined}>
                      <span className="rs-hist-q">{r.request.question}</span>
                      <span className="rs-hist-meta">
                        <StatusBadge tone={st.tone}>{st.text}</StatusBadge>
                        <span>{when(r.createdAt)}</span>
                        <span>{r.agents.length || r.request.agents.length} 个模型</span>
                        {r.status === "done" && r.termination !== undefined && <span>{terminationText(r.termination)}</span>}
                      </span>
                    </button>
                    {!LIVE.has(r.status) && (
                      <MoreMenu name={r.request.question.slice(0, 20)} items={[{ label: "删除", icon: "trash", danger: true, onClick: () => void remove(r.id) }]} />
                    )}
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
      </div>
    </main>
  );
});
