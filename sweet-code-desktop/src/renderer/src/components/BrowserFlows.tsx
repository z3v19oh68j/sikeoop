import { useEffect, useState } from "react";
import type { BrowserFlow, BrowserFlowRunResult } from "@shared/types";
import { Icon } from "./Icon";

// Browser scripts (自动化浏览器 第四批): record what you do in the built-in browser, replay it later
// with variables. Used by BrowserPane (record / list / run) and by the automation graph's
// 「运行浏览器脚本」 step (pick a script, fill its variables).

const errText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** The {variables} a script's steps use, in order of first appearance. */
export function flowVars(flow: BrowserFlow): string[] {
  const out: string[] = [];
  for (const s of flow.steps)
    for (const v of [s.text, s.url, s.key, ...(s.files ?? [])])
      for (const m of (v ?? "").matchAll(/\{([^{}\s]+)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const ACTION: Record<BrowserFlow["steps"][number]["action"], string> = { click: "点击", fill: "填写", select: "选择", check: "勾选", press: "按键", navigate: "打开", upload: "上传" };
export const stepText = (s: BrowserFlow["steps"][number]) =>
  s.description || `${ACTION[s.action]} ${s.url ?? s.text ?? s.key ?? (s.password ? "（密码，回放时你手动填）" : "")}`.trim();

function VarInputs({ names, values, onChange }: { names: string[]; values: Record<string, string>; onChange(v: Record<string, string>): void }) {
  if (!names.length) return <p className="bf-hint">这个脚本没有变量。</p>;
  return (
    <div className="bf-vars">
      {names.map((n) => (
        <label key={n}>
          <span>{n}</span>
          <input value={values[n] ?? ""} onChange={(e) => onChange({ ...values, [n]: e.target.value })} placeholder={`{${n}}`} />
        </label>
      ))}
    </div>
  );
}

/** The 脚本 panel in the browser: record, list, run (with variables), delete. */
export function FlowsPanel({ onClose, recording, onRecording }: { onClose(): void; recording: string | null; onRecording(name: string | null): void }) {
  const [flows, setFlows] = useState<BrowserFlow[]>([]);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [parameterize, setParameterize] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [selfHeal, setSelfHeal] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; r: BrowserFlowRunResult } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = () => void window.sweet.browserFlowList().then(setFlows, (e) => setError(errText(e)));
  useEffect(refresh, []);

  async function start() {
    setError("");
    try {
      // Named when the recording stops.
      await window.sweet.browserFlowStartRecording(undefined, { values: parameterize ? "parameterize" : "record" });
      onRecording("新脚本");
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  }
  async function run(f: BrowserFlow) {
    setError("");
    setResult(null);
    setRunning(f.name);
    try {
      setResult({ name: f.name, r: await window.sweet.browserFlowRun(f.name, vars, selfHeal ? { selfHeal: true } : undefined) });
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="browser-pop bf-panel" role="dialog" aria-label="浏览器脚本">
      <header className="bf-head">
        <b>浏览器脚本</b>
        <span className="bf-hint">把你在网页上的操作录下来，以后一键重放</span>
        <button type="button" className="icon-btn square" onClick={onClose} aria-label="关闭">
          <Icon name="close" />
        </button>
      </header>

      {!recording && (
        <form className="bf-record" onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <button type="submit" className="bf-rec-btn">
            <span className="bf-red" aria-hidden="true" /> 开始录制
          </button>
          <label className="bf-check">
            <input type="checkbox" checked={parameterize} onChange={(e) => setParameterize(e.target.checked)} />
            把填写的内容变成变量（回放时再填，不把你输入的内容存进脚本）
          </label>
          <p className="bf-hint">录完再起名字。密码永远不会录进去，回放到那一步会停下来让你自己填。录制时请别让 AI 同时操作浏览器。</p>
        </form>
      )}

      {flows.length === 0 ? (
        <p className="bf-hint">还没有脚本。</p>
      ) : (
        <ul className="bf-list">
          {flows.map((f) => {
            const names = flowVars(f);
            const isOpen = open === f.name;
            const failed = result?.name === f.name && result.r.failedStep ? result.r.failedStep : null;
            return (
              <li key={f.name} className={"bf-item" + (isOpen ? " open" : "")}>
                <div className="bf-row">
                  <button type="button" className="bf-name" onClick={() => { setOpen(isOpen ? null : f.name); setVars({}); setResult(null); }} aria-expanded={isOpen}>
                    <Icon name={isOpen ? "chevron-down" : "chevron-right"} />
                    {f.name}
                    <span className="bf-hint">{f.steps.length} 步{names.length ? ` · ${names.length} 个变量` : ""}{f.history.length ? ` · 修复过 ${f.history.length} 次` : ""}</span>
                  </button>
                  {renaming?.from === f.name ? (
                    <form
                      className="bf-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setError("");
                        void window.sweet.browserFlowRename(f.name, renaming.to.trim()).then(() => { setRenaming(null); refresh(); }, (err) => setError(errText(err)));
                      }}
                    >
                      <input value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value })} maxLength={80} aria-label="新名字" autoFocus />
                      <button type="submit" className="bf-btn primary" disabled={!renaming.to.trim() || renaming.to.trim() === f.name}>改名</button>
                      <button type="button" className="bf-btn" onClick={() => setRenaming(null)}>取消</button>
                    </form>
                  ) : (
                    <button type="button" className="bf-btn" onClick={() => { setConfirmDel(null); setRenaming({ from: f.name, to: f.name }); }}>改名</button>
                  )}
                  {confirmDel === f.name ? (
                    <>
                      <button type="button" className="bf-btn" onClick={() => setConfirmDel(null)}>取消</button>
                      <button type="button" className="bf-btn danger" onClick={() => void window.sweet.browserFlowDelete(f.name).then(() => { setConfirmDel(null); refresh(); }, (e) => setError(errText(e)))}>确定删除</button>
                    </>
                  ) : (
                    <button type="button" className="icon-btn square" title="删除" aria-label={`删除 ${f.name}`} onClick={() => setConfirmDel(f.name)}>
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="bf-body">
                    <ol className="bf-steps">
                      {f.steps.map((s, i) => (
                        <li key={i} className={failed === i + 1 ? "failed" : failed && i + 1 < failed ? "ok" : undefined}>
                          {stepText(s)}
                        </li>
                      ))}
                    </ol>
                    <VarInputs names={names} values={vars} onChange={setVars} />
                    <label className="bf-check">
                      <input type="checkbox" checked={selfHeal} onChange={(e) => setSelfHeal(e.target.checked)} />
                      这次允许自动修复：找不到按钮或输入框时，会调用 AI 修复失效的步骤（会把当前页面的精简结构发给你设的模型）
                    </label>
                    <div className="bf-actions">
                      <button type="button" className="bf-btn primary" disabled={running !== null || names.some((n) => !vars[n]?.trim())} onClick={() => void run(f)}>
                        <Icon name="play" /> {running === f.name ? "运行中…" : "运行"}
                      </button>
                      {names.some((n) => !vars[n]?.trim()) && <span className="bf-hint">先把变量填好</span>}
                    </div>
                    {result?.name === f.name &&
                      (result.r.failedStep ? (
                        <div className="bf-result bad">
                          <b>第 {result.r.failedStep} 步失败</b>（完成了 {result.r.completed}/{result.r.total} 步）：{result.r.reason ?? "原因不明"}
                          {result.r.snapshot && (
                            <details>
                              <summary>当时的页面结构</summary>
                              <pre>{result.r.snapshot}</pre>
                            </details>
                          )}
                        </div>
                      ) : (
                        <div className="bf-result ok">全部 {result.r.total} 步都做完了。</div>
                      ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="bf-error">{error}</p>}
    </div>
  );
}

/** The automation graph's 「运行浏览器脚本」 step: text is JSON {name, vars?}. */
export function FlowStepConfig({ text, onChange }: { text: string; onChange(text: string): void }) {
  const [flows, setFlows] = useState<BrowserFlow[] | null>(null);
  useEffect(() => {
    void window.sweet.browserFlowList().then(setFlows, () => setFlows([]));
  }, []);
  let cfg: { name: string; vars?: Record<string, string> } = { name: "" };
  try {
    const p = JSON.parse(text || "{}");
    if (p && typeof p.name === "string") cfg = { name: p.name, vars: typeof p.vars === "object" && p.vars ? p.vars : undefined };
  } catch {
    // An old free-text step: start fresh.
  }
  const flow = flows?.find((f) => f.name === cfg.name);
  const write = (c: typeof cfg) => onChange(JSON.stringify(c.vars && Object.keys(c.vars).length ? c : { name: c.name }));
  return (
    <div className="bf-step-config">
      <label>
        <span>脚本</span>
        <select value={cfg.name} onChange={(e) => write({ name: e.target.value })}>
          <option value="">选一个录好的脚本</option>
          {flows?.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}（{f.steps.length} 步）
            </option>
          ))}
          {cfg.name && flows && !flow && <option value={cfg.name}>{cfg.name}（找不到了）</option>}
        </select>
      </label>
      {flows?.length === 0 && <p className="bf-hint">还没有脚本。在内置浏览器右上角「脚本」里录一个。</p>}
      {flow && <VarInputs names={flowVars(flow)} values={cfg.vars ?? {}} onChange={(vars) => write({ ...cfg, vars })} />}
      <p className="bf-hint">按录好的步骤直接回放，不经过 AI。提交表单、付款、上传这类操作照样会等你批准。</p>
    </div>
  );
}

/** One line for the graph view. */
export function flowStepSummary(text: string): string {
  try {
    const p = JSON.parse(text);
    const vars = p.vars && Object.keys(p.vars).length ? ` · ${Object.entries(p.vars).map(([k, v]) => `${k}=${v}`).join("，")}` : "";
    return p.name ? `脚本「${p.name}」${vars}` : "（还没选脚本）";
  } catch {
    return "（还没选脚本）";
  }
}
