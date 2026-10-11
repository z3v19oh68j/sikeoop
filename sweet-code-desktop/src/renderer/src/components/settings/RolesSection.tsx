import { useEffect, useState, type ReactNode } from "react";
import { DECISION_MODELS, type DecisionTestResult, type ModelRef, type ProvidersState } from "@shared/types";
import { Icon } from "../Icon";
import {
  FailoverList,
  MAX_FAILOVER,
  ModelPicker,
  routingDraft,
  routingIncomplete,
  sameRouting,
  slotReady,
  toRouting,
  toSlot,
  type RoutingDraft,
  type Slot,
} from "../RoutingSettings";
import { SectionHead, SettingRow, StatusBadge, Switch, cleanError, isReady } from "./ui";
import { QuotaCard } from "./QuotaCard";

interface Props {
  state: ProvidersState;
  onChange(s: ProvidersState): void;
  /** Jump to 模型服务商 with this provider picked. */
  onOpenProvider(id: string): void;
}

const sameSlot = (a: Slot, b: ModelRef) => a.providerId === b.providerId && a.model.trim() === b.model;

/**
 * 模型分工: which model does which job — chat, images, approvals, summaries, sub-tasks, decisions —
 * plus backups on errors and picking by difficulty. One draft, one 保存 for the whole page.
 */
export function RolesSection({ state, onChange, onOpenProvider }: Props) {
  const [vision, setVision] = useState<Slot>(() => toSlot(state.vision));
  const [reviewer, setReviewer] = useState<Slot>(() => toSlot(state.reviewer));
  const [routing, setRouting] = useState<RoutingDraft>(() => routingDraft(state.routing));
  const [decisionModel, setDecisionModel] = useState(state.decision.model);
  const [decisionKey, setDecisionKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DecisionTestResult | null>(null);

  // When a piece is saved (or changed elsewhere), start that piece again from what is stored.
  const visionKey = `${state.vision.providerId}:${state.vision.model}`;
  const reviewerKey = `${state.reviewer.providerId}:${state.reviewer.model}`;
  const routingKey = JSON.stringify(toRouting(routingDraft(state.routing)));
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => setVision(toSlot(state.vision)), [visionKey]);
  useEffect(() => setReviewer(toSlot(state.reviewer)), [reviewerKey]);
  useEffect(() => setRouting(routingDraft(state.routing)), [routingKey]);
  useEffect(() => setDecisionModel(state.decision.model), [state.decision.model]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const nextRouting = toRouting(routing);
  const dirty = {
    vision: !sameSlot(vision, state.vision),
    reviewer: reviewer.providerId !== state.reviewer.providerId || (reviewer.providerId !== "" && reviewer.model.trim() !== state.reviewer.model),
    routing: !sameRouting(nextRouting, state.routing),
    decision: decisionModel !== state.decision.model || Boolean(decisionKey.trim()),
  };
  const dirtyCount = Object.values(dirty).filter(Boolean).length;
  const problem =
    dirty.vision && (!vision.providerId || !vision.model.trim())
      ? "识图模型要选服务商并填模型名"
      : dirty.reviewer && reviewer.providerId && !reviewer.model.trim()
        ? "审批小助手的模型名没填"
        : routingIncomplete(routing)
          ? "有模型名没填，填好才能保存"
          : dirty.decision && decisionKey.trim() && !state.canEncrypt
            ? "系统钥匙串不可用，没法保存决策模型的 Key"
            : "";

  const setR = (patch: Partial<RoutingDraft>) => setRouting((d) => ({ ...d, ...patch }));

  function reset() {
    setVision(toSlot(state.vision));
    setReviewer(toSlot(state.reviewer));
    setRouting(routingDraft(state.routing));
    setDecisionModel(state.decision.model);
    setDecisionKey("");
    setError("");
  }

  async function save() {
    setSaving(true);
    setError("");
    setTestResult(null);
    let s: ProvidersState | null = null;
    try {
      if (dirty.vision) s = await window.sweet.setVision({ providerId: vision.providerId, model: vision.model });
      if (dirty.reviewer) s = await window.sweet.setReviewer({ providerId: reviewer.providerId, model: reviewer.providerId ? reviewer.model : "" });
      if (dirty.routing) s = await window.sweet.setRouting(nextRouting);
      if (dirty.decision) {
        s = await window.sweet.setDecision({ model: decisionModel, apiKey: decisionKey.trim() || undefined });
        setDecisionKey("");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      if (dirty.decision) {
        // As before: a changed decision model is tried right away.
        if (s) onChange(s);
        s = null;
        setTesting(true);
        setTestResult(await window.sweet.testDecision());
      }
    } catch (e) {
      setError(cleanError(e));
    } finally {
      if (s) onChange(s);
      setSaving(false);
      setTesting(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    setTestResult(await window.sweet.testDecision());
    setTesting(false);
  }

  const active = state.providers.find((p) => p.id === state.activeId)!;
  const nameOf = (id: string) => state.providers.find((p) => p.id === id)?.name ?? id;

  /** Status for a slot: 跟随对话 when empty, else whether its provider has a key. */
  function slotStatus(s: Slot, stored: { ref: ModelRef; ready: boolean } | null, follow = "跟随对话") {
    if (!s.providerId) return <StatusBadge tone="muted">{follow}</StatusBadge>;
    if (!s.model.trim()) return <StatusBadge tone="warn">填模型名</StatusBadge>;
    const ok = stored && sameSlot(s, stored.ref) ? stored.ready : slotReady(state, s);
    return ok ? <StatusBadge tone="ok">可以用</StatusBadge> : <StatusBadge tone="warn">还没填 {nameOf(s.providerId)} 的 Key</StatusBadge>;
  }

  const d = state.decision;
  const decisionStatus = !d.hasKey ? (
    <StatusBadge tone="warn">未设置</StatusBadge>
  ) : d.keySource === "builtin" ? (
    <StatusBadge tone="accent" title="用的是 sikeoop 自带的免费 Key，不用自己填">内置免费</StatusBadge>
  ) : (
    <StatusBadge tone="ok">可以用</StatusBadge>
  );

  return (
    <div className="st-section st-roles">
      <SectionHead title="模型分工" desc="不同的活可以交给不同的模型，比如把幕后小活交给便宜的。选「跟随对话」就和聊天用同一个。" />

      <div className="st-role-table" role="table" aria-label="模型分工">
        <div className="st-role-head" role="row">
          <span role="columnheader">用途</span>
          <span role="columnheader">用哪个模型</span>
          <span role="columnheader">状态</span>
        </div>

        <RoleRow icon="chat-plus" title="对话" desc="和你聊天、改代码的主力模型" status={isReady(active) ? <StatusBadge tone="ok">可以用</StatusBadge> : <StatusBadge tone="warn">还没配好</StatusBadge>}>
          <div className="st-role-fixed">
            <span className="st-role-model">
              {active.name}
              {active.model && <em> · {active.model}</em>}
            </span>
            <button type="button" className="mini-btn" onClick={() => onOpenProvider(active.id)}>
              换服务商
            </button>
          </div>
        </RoleRow>

        <RoleRow
          icon="eye-search"
          title="识图"
          desc="先替不会看图的模型看一遍图片（截图问 AI 也用它）"
          status={slotStatus(vision, { ref: state.vision, ready: state.vision.ready })}
        >
          <ModelPicker state={state} value={vision} onChange={setVision} label="识图" id="role-vision" />
        </RoleRow>

        <RoleRow
          icon="shield-check"
          title="审批小助手"
          desc="「长任务」里代你审批改文件、跑命令；推送和发布仍问你"
          status={slotStatus(reviewer, { ref: state.reviewer, ready: state.reviewer.ready })}
        >
          <ModelPicker state={state} value={reviewer} onChange={setReviewer} label="审批小助手" id="role-reviewer" emptyText="跟随对话" />
        </RoleRow>

        <RoleRow icon="archive" title="压缩摘要" desc="对话太长时，把前面的内容缩成摘要" status={slotStatus(routing.compress, null)}>
          <ModelPicker state={state} value={routing.compress} onChange={(v) => setR({ compress: v })} label="压缩摘要" id="role-compress" emptyText="跟随对话" />
        </RoleRow>

        <RoleRow icon="group" title="子任务" desc="集群里的各个角色、自动化任务用它" status={slotStatus(routing.subtask, null)}>
          <ModelPicker state={state} value={routing.subtask} onChange={(v) => setR({ subtask: v })} label="子任务" id="role-subtask" emptyText="跟随对话" />
        </RoleRow>

        <RoleRow
          icon="list-check"
          title="决策模型"
          desc="批量给工单、邮件分类打分时用，只给结论和概率"
          status={decisionStatus}
          below={
            <details className="st-disclosure st-decision-more">
              <summary>
                <Icon name="chevron-right" /> 关于决策模型 · Key 与测试
              </summary>
              <p className="hint">
                要对很多条内容做同一种判断时，AI 会交给它批量判断：快、便宜，拿不准的交回给 AI 或你。用的是 TokenDance 的 TypeSafe Jev。
                第一次在一个项目里用时，会先问你是否同意把内容发出去。新的对话里生效。
                {d.keySource === "builtin" && " 现在用的是 sikeoop 自带的免费 Key，不用填；想用自己的 Key 再填。"}
              </p>
              <div className="st-inline">
                <input
                  type="password"
                  value={decisionKey}
                  onChange={(e) => setDecisionKey(e.target.value)}
                  placeholder={
                    d.keySource === "saved"
                      ? "已保存 Key（填新的会替换）"
                      : d.keySource === "env"
                        ? "在用环境变量 TOKENDANCE_API_KEY"
                        : d.keySource === "builtin"
                          ? "在用内置的免费 Key，不用填（想用自己的再填）"
                          : "TokenDance 的 Key（sk-…）"
                  }
                  autoComplete="off"
                  aria-label="TokenDance API Key"
                />
                <button type="button" className="mini-btn" disabled={testing || !d.hasKey} onClick={() => void test()}>
                  {testing ? "测试中…" : "测试"}
                </button>
                {d.keySource === "saved" && (
                  <button type="button" className="mini-btn" disabled={testing} onClick={() => void window.sweet.clearDecisionKey().then(onChange)}>
                    删除 Key
                  </button>
                )}
              </div>
              <p className="hint">Key 用系统钥匙串加密保存。填好后点页面底部的「保存」。</p>
            </details>
          }
        >
          <select className="st-select" value={decisionModel} onChange={(e) => setDecisionModel(e.target.value)} aria-label="决策模型">
            {DECISION_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </RoleRow>
        {testResult && (
          <p className={"st-role-note " + (testResult.ok ? "ok-text" : "err-text")}>
            {testResult.ok && <Icon name="check" />} 决策模型测试：{testResult.message}
            {testResult.ok && `（${testResult.ms} ms）`}
          </p>
        )}
      </div>

      <h4 className="st-subhead">自动换模型</h4>
      <p className="hint st-subhead-desc">换模型时，新模型接着之前的进度做，不用重新读文件；聊天里会提示「换了模型：A → B」。</p>

      <SettingRow
        icon="refresh"
        title="出错自动换模型"
        desc={`当前模型被限流、欠费、挂了或断网时，按顺序换下面的备用模型接着做，这条消息不会白发。最多 ${MAX_FAILOVER} 个。`}
        status={
          routing.failover.length ? (
            routing.failover.some((s) => !slotReady(state, s)) ? (
              <StatusBadge tone="warn">有备用还没配好 Key</StatusBadge>
            ) : (
              <StatusBadge tone="ok">{routing.failover.length} 个备用</StatusBadge>
            )
          ) : (
            <StatusBadge tone="muted">没设置</StatusBadge>
          )
        }
      >
        <FailoverList state={state} list={routing.failover} onChange={(failover) => setR({ failover })} />
      </SettingRow>

      <SettingRow
        icon="graph"
        title="按难度自动选"
        desc="简单的（问问题、翻译、打招呼）交给轻量模型，省钱又快；改代码、修 bug 交给主力模型。拿不准的就不换。"
        status={routing.enabled ? <StatusBadge tone="ok">已打开</StatusBadge> : <StatusBadge tone="muted">没开</StatusBadge>}
        control={<Switch checked={routing.enabled} onChange={(enabled) => setR({ enabled })} label="按难度自动选模型" />}
      >
        <div className={"st-slot-grid" + (routing.enabled ? "" : " off")}>
          <div className="st-slot">
            <div className="st-slot-head">
              <span>轻量模型</span>
              {!slotReady(state, routing.light) && <span className="warn-text st-inline-warn">还没配好 Key</span>}
            </div>
            <ModelPicker state={state} value={routing.light} onChange={(v) => setR({ light: v })} label="轻量模型" id="routing-light" emptyText="用当前模型" disabled={!routing.enabled} />
          </div>
          <div className="st-slot">
            <div className="st-slot-head">
              <span>主力模型</span>
              {!slotReady(state, routing.heavy) && <span className="warn-text st-inline-warn">还没配好 Key</span>}
            </div>
            <ModelPicker state={state} value={routing.heavy} onChange={(v) => setR({ heavy: v })} label="主力模型" id="routing-heavy" emptyText="用当前模型" disabled={!routing.enabled} />
          </div>
        </div>
      </SettingRow>

      <h4 className="st-subhead">额度用完时</h4>
      <QuotaCard />

      <div className={"st-savebar" + (dirtyCount || error || saved ? " show" : "")}>
        <span className="st-savebar-text">
          {error ? (
            <span className="err-text">保存失败：{error}</span>
          ) : problem ? (
            <span className="warn-text">{problem}</span>
          ) : saved ? (
            <span className="ok-text">
              <Icon name="check" /> 已保存
            </span>
          ) : dirtyCount ? (
            `有 ${dirtyCount} 处改动还没保存`
          ) : (
            ""
          )}
        </span>
        <span className="spacer" />
        {dirtyCount > 0 && (
          <button type="button" className="link-btn" onClick={reset} disabled={saving}>
            撤销修改
          </button>
        )}
        <button type="button" className="send" disabled={!dirtyCount || !!problem || saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

/** One line of the 分工 table: what the job is, which model, and whether it can run. */
function RoleRow({ icon, title, desc, status, children, below }: { icon: string; title: string; desc: string; status: ReactNode; children: ReactNode; below?: ReactNode }) {
  return (
    <div className="st-role" role="row">
      <div className="st-role-what" role="cell">
        <Icon name={icon} className="st-row-icon" />
        <div>
          <div className="st-role-title">{title}</div>
          <div className="st-role-desc">{desc}</div>
        </div>
      </div>
      <div className="st-role-pick" role="cell">
        {children}
      </div>
      <div className="st-role-status" role="cell">
        {status}
      </div>
      {below && <div className="st-role-below">{below}</div>}
    </div>
  );
}
