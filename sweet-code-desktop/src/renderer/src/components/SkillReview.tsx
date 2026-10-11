import { useEffect, useRef, useState } from "react";
import type { AuditLevel, SkillCandidate, SkillInfo, SkillPreview } from "@shared/types";
import { Icon } from "./Icon";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const LEVEL: Record<AuditLevel, { label: string; cls: string; icon: string }> = {
  pass: { label: "审核通过", cls: "pass", icon: "shield-check" },
  notice: { label: "有提示", cls: "notice", icon: "shield-check" },
  warn: { label: "需要注意", cls: "warn", icon: "warning" },
  danger: { label: "高风险", cls: "danger", icon: "warning" },
};
const VERDICT = { safe: "看起来安全", suspicious: "有可疑之处", malicious: "判断为恶意" } as const;

interface Props {
  preview: SkillPreview;
  /** Candidates to pre-select by name (a resource card's picks); default: all not yet installed. */
  preselect?: string[];
  onInstalled(skills: SkillInfo[]): void;
  onCancel(): void;
}

/**
 * The install step for skills from anywhere: what's in each one and what the security review
 * found. The rule scan comes with the preview; the AI review starts right away. High-risk skills
 * are left unticked and need "install anyway" ticked before the install button works (main
 * enforces the same rule).
 */
export function SkillReview({ preview: initial, preselect, onInstalled, onCancel }: Props) {
  const [preview, setPreview] = useState(initial);
  const [picked, setPicked] = useState<Set<string>>(() => {
    const want = preselect?.length ? new Set(preselect) : null;
    return new Set(initial.candidates.filter((c) => (want ? want.has(c.name) : !c.exists) && c.audit.level !== "danger").map((c) => c.id));
  });
  const [ai, setAi] = useState<"running" | "done" | "skipped" | "error">("running");
  const [aiError, setAiError] = useState("");
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const started = useRef("");

  useEffect(() => {
    if (started.current === initial.previewId) return;
    started.current = initial.previewId;
    setPreview(initial);
    setAi("running");
    window.sweet.aiReviewSkills(initial.previewId).then(
      (p) => {
        setPreview(p);
        // Untick anything the AI review just found to be high-risk.
        setPicked((prev) => new Set([...prev].filter((id) => p.candidates.find((c) => c.id === id)?.audit.level !== "danger")));
        setAi("done");
      },
      (e) => {
        setAiError(cleanError(e));
        setAi("error");
      },
    );
  }, [initial]);

  const chosen = preview.candidates.filter((c) => picked.has(c.id));
  const risky = chosen.filter((c) => c.audit.level === "danger");
  const waiting = ai === "running";

  async function install() {
    setBusy(true);
    setError("");
    try {
      onInstalled(await window.sweet.installSkills(preview.previewId, [...picked], risky.length > 0 && accept));
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="preview-box skill-review" aria-label="安装前的安全审核">
      <div className="preview-head">
        <b>找到 {preview.candidates.length} 个技能</b>
        <span className="hint">{preview.source}</span>
        <span className="spacer" />
        <span className={"ai-state " + ai}>
          {ai === "running" && (
            <>
              <span className="spin" aria-hidden="true" /> AI 正在审核…
            </>
          )}
          {ai === "done" && (
            <>
              <Icon name="shield-check" /> 规则扫描 + AI 审核完成
            </>
          )}
          {ai === "skipped" && "只做了规则扫描"}
          {ai === "error" && <span className="warn-text">AI 审核没做成，只有规则扫描结果</span>}
        </span>
      </div>
      {ai === "error" && aiError && <p className="hint warn-text">{aiError}</p>}

      <ul className="plugin-list">
        {preview.candidates.map((c) => (
          <Candidate
            key={c.id}
            c={c}
            checked={picked.has(c.id)}
            onToggle={(on) => {
              const next = new Set(picked);
              if (on) next.add(c.id);
              else next.delete(c.id);
              setPicked(next);
            }}
          />
        ))}
      </ul>

      {risky.length > 0 && (
        <label className="risk-accept">
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>
            我看过上面的风险说明，确定 <b>{risky.map((c) => c.name).join("、")}</b> 是我信任的来源，仍然要安装。
          </span>
        </label>
      )}
      {error && <div className="err">{error}</div>}

      <div className="row">
        <span className="hint">安装前会先检查技能里有没有恶意指令。脚本不会自动运行，AI 要运行时还是会先问你。</span>
        <span className="spacer" />
        {waiting && (
          <button type="button" className="link-btn" onClick={() => setAi("skipped")} title="不等 AI 审核，只看规则扫描的结果">
            不等了
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className={"send" + (risky.length ? " danger" : "")}
          disabled={!picked.size || busy || waiting || (risky.length > 0 && !accept)}
          onClick={() => void install()}
        >
          {busy ? "安装中…" : waiting ? "等 AI 审核完…" : risky.length ? `仍然安装 ${picked.size} 个` : `安装选中的 ${picked.size} 个`}
        </button>
      </div>
    </section>
  );
}

function Candidate({ c, checked, onToggle }: { c: SkillCandidate; checked: boolean; onToggle(on: boolean): void }) {
  const lv = LEVEL[c.audit.level];
  const serious = c.audit.findings.filter((f) => f.severity !== "low");
  const minor = c.audit.findings.filter((f) => f.severity === "low");
  const ai = c.audit.ai;
  return (
    <li className={"review-item " + lv.cls}>
      <label className="plugin-item">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        <span className="main">
          <span className="title">
            {c.name}
            <span className={"badge audit " + lv.cls}>
              <Icon name={lv.icon} /> {lv.label}
            </span>
            <span className={"badge" + (c.format === "standard" ? " std" : "")}>{c.format === "standard" ? "标准 Skill" : `由${c.origin}转换`}</span>
            {c.hasScripts && (
              <span className="badge warn">
                <Icon name="warning" /> 含脚本
              </span>
            )}
            {c.exists && <span className="badge warn">已安装，会覆盖</span>}
          </span>
          <span className="desc">{c.description || "（没有描述）"}</span>
          <span className="hint">
            {c.files.length} 个文件{c.files.length <= 4 ? `：${c.files.join("、")}` : ""}，扫描了 {c.audit.scanned} 个
          </span>
          {c.warnings.map((w) => (
            <span key={w} className="hint warn-text">
              {w}
            </span>
          ))}
        </span>
      </label>

      {ai && "verdict" in ai && (
        <div className={"ai-verdict " + ai.verdict}>
          <b>AI 审核：{VERDICT[ai.verdict]}</b> {ai.summary}
          {ai.concerns.length > 0 && (
            <ul>
              {ai.concerns.map((x, i) => (
                <li key={i}>
                  {x.file && <code>{x.file}</code>} {x.why}
                </li>
              ))}
            </ul>
          )}
          <span className="hint">{ai.model}</span>
        </div>
      )}
      {ai && "error" in ai && <p className="hint warn-text">AI 审核没做成：{ai.error}</p>}

      {serious.length > 0 && (
        <details className="findings" open={c.audit.level === "danger" || c.audit.level === "warn"}>
          <summary>规则扫描发现 {serious.length} 处需要看一下</summary>
          <ul>
            {serious.map((f, i) => (
              <li key={i} className={f.severity}>
                <span className="sev">{f.severity === "high" ? "高风险" : "注意"}</span>
                <span className="what">{f.title}</span>
                <span className="where">
                  {f.file}
                  {f.line ? `:${f.line}` : ""}
                </span>
                {f.excerpt && <code className="excerpt">{f.excerpt}</code>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {minor.length > 0 && <p className="hint">提示：{[...new Set(minor.map((f) => f.title))].join("、")}</p>}
    </li>
  );
}
