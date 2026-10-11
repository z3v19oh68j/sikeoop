import { useState } from "react";
import type { ResearchCandidate, ResearchPreset, ResearchRequest, ResearchRun } from "@shared/types";
import { Icon } from "../Icon";
import { StatusBadge, cleanError } from "../settings/ui";
import { callEstimate, isScience, num } from "./format";

const MIN_AGENTS = 2;
const MAX_AGENTS = 5;
const DEFAULT_ROUNDS = 30;
/** A normal run settles after about 13 rounds (report 2.5). */
const TYPICAL_ROUNDS = 13;

type Repo = "none" | "preset" | "file";

/** What the form holds; kept by ResearchScreen so it survives looking at a run. */
export interface StudyDraft {
  question: string;
  repo: Repo;
  presetId: string;
  file: string | null;
  /** Candidate keys in order: agent_0, agent_1… */
  agents: string[];
  evidence: string;
  rounds: number;
  moreExamples: boolean;
}

export const EMPTY_DRAFT: StudyDraft = { question: "", repo: "none", presetId: "", file: null, agents: [], evidence: "", rounds: DEFAULT_ROUNDS, moreExamples: false };
const key = (c: { providerId: string; model: string }) => `${c.providerId}::${c.model}`;

interface Props {
  ready: boolean;
  presets: ResearchPreset[];
  candidates: ResearchCandidate[];
  onSettings(providerId: string): void;
  onStarted(run: ResearchRun): void;
  draft: StudyDraft;
  onDraft(fn: (d: StudyDraft) => StudyDraft): void;
}

/** The form for a new study, then the confirmation card. Nothing is sent before 「确认开始」. */
export function NewStudy({ ready, presets, candidates, onSettings, onStarted, draft, onDraft }: Props) {
  const { question, repo, presetId, file, agents, evidence, rounds, moreExamples } = draft;
  const patch = (p: Partial<StudyDraft>) => onDraft((d) => ({ ...d, ...p }));
  const setQuestion = (question: string) => patch({ question });
  const setRepo = (repo: Repo) => patch({ repo });
  const setPresetId = (presetId: string) => patch({ presetId });
  const setFile = (file: string | null) => patch({ file });
  const setAgents = (fn: (list: string[]) => string[]) => onDraft((d) => ({ ...d, agents: fn(d.agents) }));
  const setEvidence = (evidence: string) => patch({ evidence });
  const setRounds = (rounds: number) => patch({ rounds });
  const setMoreExamples = (moreExamples: boolean) => patch({ moreExamples });
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const byKey = new Map(candidates.map((c) => [key(c), c]));
  const chosen = agents.map((k) => byKey.get(k)).filter((c): c is ResearchCandidate => !!c);
  const readyCandidates = candidates.filter((c) => c.ready);
  const evidenceKey = evidence && byKey.get(evidence)?.ready ? evidence : chosen[0] ? key(chosen[0]) : readyCandidates[0] ? key(readyCandidates[0]) : "";
  const evidenceModel = byKey.get(evidenceKey);
  const preset = presets.find((p) => p.id === presetId);
  const science = presets.filter(isScience);
  const others = presets.filter((p) => !isScience(p));

  const problem = !ready
    ? "先把上面的运行环境准备好"
    : !question.trim()
      ? "写下你想研究的问题"
      : chosen.length < MIN_AGENTS
        ? `至少选 ${MIN_AGENTS} 个辩论模型`
        : chosen.some((c) => !c.ready)
          ? "有选中的模型还没填 Key"
          : !evidenceModel
            ? "选一个证据模型"
            : repo === "preset" && !preset
              ? "选一个示例证据库，或改成「不用」"
              : repo === "file" && !file
                ? "选一个证据库文件，或改成「不用」"
                : rounds < 4 || rounds > 200
                  ? "轮数上限填 4 到 200 之间"
                  : "";

  function toggle(c: ResearchCandidate) {
    const k = key(c);
    setAgents((list) => (list.includes(k) ? list.filter((x) => x !== k) : list.length >= MAX_AGENTS ? list : [...list, k]));
  }
  function move(i: number, by: number) {
    setAgents((list) => {
      const j = i + by;
      if (j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  function pickPreset(p: ResearchPreset) {
    setPresetId(p.id);
    if (!question.trim()) setQuestion(p.question);
  }
  async function pickFile() {
    setError("");
    try {
      const path = await window.sweet.researchPickRepository();
      if (path) setFile(path);
    } catch (e) {
      setError(cleanError(e));
    }
  }

  async function start() {
    if (!evidenceModel) return;
    const req: ResearchRequest = {
      question: question.trim(),
      agents: chosen.map((c) => ({ providerId: c.providerId, model: c.model })),
      evidence: { providerId: evidenceModel.providerId, model: evidenceModel.model },
      repository: repo === "preset" && preset ? { kind: "preset", id: preset.id } : repo === "file" && file ? { kind: "file", path: file } : undefined,
      maxRounds: rounds,
    };
    setStarting(true);
    setError("");
    try {
      const run = await window.sweet.researchStart(req);
      setConfirming(false);
      setQuestion("");
      onStarted(run);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setStarting(false);
    }
  }

  if (confirming && evidenceModel) {
    const typical = Math.min(TYPICAL_ROUNDS, rounds);
    const [tLo, tHi] = callEstimate(chosen.length, typical);
    const [lo, hi] = callEstimate(chosen.length, rounds);
    const vendors = [...new Set([...chosen, evidenceModel].map((c) => c.providerName))];
    return (
      <section className="rs-card rs-confirm" aria-label="开始前确认">
        <header className="rs-card-head">
          <Icon name="shield-check" />
          <h3>开始前确认一下</h3>
        </header>
        <div className="rs-confirm-grid">
          <div>
            <div className="rs-label">问题</div>
            <p className="rs-question">{question.trim()}</p>
          </div>
          <div>
            <div className="rs-label">辩论模型（{chosen.length} 个）</div>
            <ol className="rs-model-list">
              {chosen.map((c, i) => (
                <li key={key(c)}>
                  <span className="rs-agent-no">agent_{i}</span>
                  {c.providerName} · <code>{c.model}</code>
                </li>
              ))}
            </ol>
            <div className="rs-label">证据模型</div>
            <p>
              {evidenceModel.providerName} · <code>{evidenceModel.model}</code>
            </p>
          </div>
          <div>
            <div className="rs-label">证据库</div>
            <p>{repo === "preset" && preset ? `${preset.title}（${preset.records} 条记录）` : repo === "file" && file ? file : "不用，只靠问题本身"}</p>
            <div className="rs-label">轮数上限</div>
            <p>{rounds} 轮（通常 13–57 轮收敛，可能提前结束）</p>
            <div className="rs-label">预计模型调用（每轮约 {chosen.length + 1}–{chosen.length + 3} 次）</div>
            {rounds > TYPICAL_ROUNDS ? (
              <ul className="rs-tiers">
                <li>
                  <span>通常（约 {TYPICAL_ROUNDS} 轮）</span>
                  <b>
                    {num(tLo)}–{num(tHi)} 次
                  </b>
                </li>
                <li>
                  <span>最多（跑满 {rounds} 轮上限）</span>
                  <b>
                    {num(lo)}–{num(hi)} 次
                  </b>
                </li>
              </ul>
            ) : (
              <p>
                最多约 <b>{num(lo)}–{num(hi)}</b> 次（跑满 {rounds} 轮）
              </p>
            )}
          </div>
        </div>
        <div className="rs-callout warn">
          <p>
            <Icon name="warning" /> <b>问题和证据会发给这几家服务商：</b>
            {vendors.join("、")}。
          </p>
          <p>
            <Icon name="warning" /> <b>会花你自己 Key 的钱。</b>证据越多、轮数越多越贵；格式出错时的重试不在上面的估计里。
          </p>
        </div>
        {error && <p className="err-text">{error}</p>}
        <div className="rs-actions">
          <button type="button" className="mini-btn" onClick={() => setConfirming(false)} disabled={starting}>
            返回修改
          </button>
          <button type="button" className="send rs-accent" onClick={() => void start()} disabled={starting}>
            {starting ? "启动中…" : "确认开始"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rs-card rs-new" aria-label="新研究">
      <header className="rs-card-head">
        <Icon name="chat-plus" />
        <h3>新研究</h3>
      </header>

      <div className="rs-field">
        <label htmlFor="rs-question" className="rs-label">
          研究什么问题
        </label>
        <textarea
          id="rs-question"
          className="rs-textarea"
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="比如：β-淀粉样蛋白是阿尔茨海默病的主要病因吗？问得越具体，结论越有用。"
        />
      </div>

      <div className="rs-field">
        <span className="rs-label">证据库</span>
        <div className="seg" role="radiogroup" aria-label="证据库">
          {(
            [
              ["none", "不用"],
              ["preset", "自带示例"],
              ["file", "我的文件"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={repo === id} className={repo === id ? "on" : undefined} onClick={() => setRepo(id)}>
              {label}
            </button>
          ))}
        </div>
        {repo === "none" && <p className="hint">只靠问题本身和模型自己的知识。给一份证据库，结论会更扎实。</p>}
        {repo === "preset" && (
          <>
            <div className="rs-presets" role="radiogroup" aria-label="自带示例">
              {science.map((p) => (
                <PresetCard key={p.id} p={p} on={p.id === presetId} onPick={() => pickPreset(p)} />
              ))}
            </div>
            {others.length > 0 && (
              <details className="st-disclosure" open={moreExamples} onToggle={(e) => setMoreExamples((e.target as HTMLDetailsElement).open)}>
                <summary>
                  <Icon name="chevron-right" /> 其他示例（营销审计、协议自我评测，{others.length} 个）
                </summary>
                <div className="rs-presets">
                  {others.map((p) => (
                    <PresetCard key={p.id} p={p} on={p.id === presetId} onPick={() => pickPreset(p)} />
                  ))}
                </div>
              </details>
            )}
            {preset && question.trim() !== preset.question && (
              <button type="button" className="link-btn rs-self-start" onClick={() => setQuestion(preset.question)}>
                把问题换成这个示例的问题
              </button>
            )}
            <p className="hint">示例里的文献没有逐条核对过，只用来体验。</p>
          </>
        )}
        {repo === "file" && (
          <div className="rs-file">
            {file ? (
              <>
                <code title={file}>{file}</code>
                <button type="button" className="mini-btn" onClick={() => void pickFile()}>
                  换一个
                </button>
                <button type="button" className="link-btn" onClick={() => setFile(null)}>
                  移除
                </button>
              </>
            ) : (
              <button type="button" className="mini-btn" onClick={() => void pickFile()}>
                <Icon name="folder-open" /> 选择 JSON 文件
              </button>
            )}
            <p className="hint">一个 JSON 数组，每条记录有 ref、title、detail（可选 source、claims）。超长的内容会被截断。</p>
          </div>
        )}
      </div>

      <div className="rs-field">
        <span className="rs-label">
          辩论模型 <span className="rs-count">{chosen.length} / {MAX_AGENTS}</span>
        </span>
        <p className="hint">选 2–5 个，不同家的模型更容易互相挑出毛病。排在前面的是 agent_0，依次往后。</p>
        {chosen.length > 0 && (
          <ol className="rs-chosen">
            {chosen.map((c, i) => (
              <li key={key(c)}>
                <span className="rs-agent-no">agent_{i}</span>
                <span className="rs-chosen-name">
                  {c.providerName} · <code>{c.model}</code>
                </span>
                <span className="rs-order">
                  <button type="button" className="mini-btn icon-only" disabled={i === 0} onClick={() => move(i, -1)} title="上移" aria-label="上移">
                    <Icon name="arrow-up" />
                  </button>
                  <button type="button" className="mini-btn icon-only flip" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} title="下移" aria-label="下移">
                    <Icon name="arrow-up" />
                  </button>
                  <button type="button" className="mini-btn icon-only" onClick={() => toggle(c)} title="移出" aria-label={`移出 ${c.model}`}>
                    <Icon name="close" />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="rs-pool">
          {candidates.length === 0 && <p className="hint">没有可用的模型。深度科研只支持官方接口的服务商（DeepSeek、通义千问、Kimi 等）。</p>}
          {candidates.map((c) => {
            const k = key(c);
            const on = agents.includes(k);
            return (
              <div key={k} className={"rs-cand" + (on ? " on" : "") + (c.ready ? "" : " off")}>
                <button
                  type="button"
                  className="rs-cand-btn"
                  disabled={!c.ready || (!on && agents.length >= MAX_AGENTS)}
                  aria-pressed={on}
                  onClick={() => toggle(c)}
                  title={c.ready ? (on ? "点一下移出" : "加入辩论") : "还没填这家的 Key"}
                >
                  <Icon name={on ? "check" : "plus"} />
                  <span>
                    {c.providerName} · <code>{c.model}</code>
                  </span>
                </button>
                {!c.ready && (
                  <button type="button" className="link-btn" onClick={() => onSettings(c.providerId)}>
                    去填 Key
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rs-two">
        <div className="rs-field">
          <label htmlFor="rs-evidence" className="rs-label">
            证据模型
          </label>
          <select id="rs-evidence" className="rs-select" value={evidenceKey} onChange={(e) => setEvidence(e.target.value)}>
            {!evidenceKey && <option value="">（没有填好 Key 的模型）</option>}
            {readyCandidates.map((c) => (
              <option key={key(c)} value={key(c)}>
                {c.providerName} · {c.model}
              </option>
            ))}
          </select>
          <p className="hint">负责找证据、判断新观点，便宜快速的就行。</p>
        </div>
        <div className="rs-field">
          <label htmlFor="rs-rounds" className="rs-label">
            轮数上限
          </label>
          <input id="rs-rounds" className="rs-input" type="number" min={4} max={200} value={rounds} onChange={(e) => setRounds(Math.round(Number(e.target.value) || 0))} />
          <p className="hint">默认 30。通常 13–57 轮就收敛，讨论稳定后会提前结束。</p>
        </div>
      </div>

      <div className="rs-actions">
        {problem && <span className="hint">{problem}</span>}
        <span className="spacer" />
        <button type="button" className="send rs-accent" disabled={!!problem} onClick={() => setConfirming(true)}>
          下一步：确认
        </button>
      </div>
    </section>
  );
}

function PresetCard({ p, on, onPick }: { p: ResearchPreset; on: boolean; onPick(): void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={"rs-preset" + (on ? " on" : "")} onClick={onPick} title={p.question}>
      <span className="rs-preset-title">{p.title}</span>
      <span className="rs-preset-meta">
        <StatusBadge tone={p.records ? "ok" : "muted"}>{p.records ? `${p.records} 条记录` : "只有问题"}</StatusBadge>
        <span className={"rs-lang " + p.language}>{p.language === "zh" ? "中文" : "English"}</span>
      </span>
    </button>
  );
}
