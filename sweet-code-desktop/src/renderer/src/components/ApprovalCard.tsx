import { useEffect, useRef, useState } from "react";
import type {
  ApprovalResponse,
  ApprovalSubject,
  CommandProposal,
  FileChangeProposal,
  ReviewDecision,
  ToolCallProposal,
} from "@shared/types";
import { Icon } from "./Icon";
import { DiffBody, DiffStat, FilePath } from "./DiffView";

export type ApprovalState = "pending" | "approved" | "rejected";

/** Output and exit status of an approved command. */
export interface CommandRun {
  output: string;
  exitCode?: number | null;
  timedOut?: boolean;
  done: boolean;
}

interface Props {
  id: string;
  subject: ApprovalSubject;
  state: ApprovalState;
  /** Approved automatically because the user chose "approve all" earlier. */
  auto: boolean;
  /** Long-task mode: the reviewer sub-agent answers before the user is asked. */
  reviewing?: boolean;
  review?: { decision: ReviewDecision; reason: string; model: string };
  run?: CommandRun;
  onRespond(r: ApprovalResponse): void;
}

export function ApprovalCard(props: Props) {
  const s = props.subject;
  // Waiting on the reviewer: no buttons yet, the user isn't being asked.
  const p = props.reviewing && props.state === "pending" && !props.review ? { ...props, state: "reviewing" as const } : props;
  const card =
    s.kind === "file" ? <FileCard {...p} change={s.change} /> : s.kind === "command" ? <CommandCard {...p} command={s.command} /> : <ToolCard {...p} call={s.call} />;
  return (
    <div className="approval-wrap">
      {card}
      {props.review && <ReviewLine review={props.review} />}
    </div>
  );
}

type CardProps = Omit<Props, "state"> & { state: ApprovalState | "reviewing" };

const REVIEW_TEXT: Record<ReviewDecision, string> = {
  approve: "审批小助手同意了",
  reject: "审批小助手没同意，让 AI 换个做法",
  ask_human: "审批小助手拿不准，请你来决定",
};

function ReviewLine({ review }: { review: NonNullable<Props["review"]> }) {
  return (
    <div className={`review-line ${review.decision}`}>
      <Icon name="shield-check" />
      <span>
        <b>{REVIEW_TEXT[review.decision]}</b>
        {review.model && <span className="model"> · {review.model}</span>}
        <span className="reason">{review.reason}</span>
      </span>
    </div>
  );
}

/** The status chip shared by file and plugin cards. */
function chipText(state: CardProps["state"], auto: boolean, review?: Props["review"]): string {
  if (state === "reviewing") return "小助手审核中…";
  if (state === "pending") return "等你确认";
  if (state === "rejected") return "已拒绝";
  if (auto) return "已自动同意";
  return review?.decision === "approve" ? "小助手已同意" : "已同意";
}

/** A call to a tool of an MCP server the user installed. */
function ToolCard({ id, call, state, auto, review, onRespond }: CardProps & { call: ToolCallProposal }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <div className={`approval tool ${state}`}>
      <div className="approval-head">
        <span className="verb">调用插件</span>
        <span className="path">
          {call.server} · {call.tool}
        </span>
        <span className={`chip ${state}`}>{chipText(state, auto, review)}</span>
      </div>
      {call.description && <p className="explain">{call.description.slice(0, 300)}</p>}
      <pre className="cmd-output">{call.args}</pre>
      {state === "pending" && (
        <Actions
          id={id}
          rejecting={rejecting}
          setRejecting={setRejecting}
          feedback={feedback}
          setFeedback={setFeedback}
          onRespond={onRespond}
          allowAll
        />
      )}
    </div>
  );
}

function FileCard({ id, change, state, auto, review, onRespond }: CardProps & { change: FileChangeProposal }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  // Pending cards open, finished ones folded so a long session stays readable.
  const [open, setOpen] = useState(state === "pending");
  // The diff is only built once it has been shown; after that it stays mounted so it can animate.
  const [mounted, setMounted] = useState(state === "pending");
  useEffect(() => {
    if (state !== "pending") setOpen(false);
  }, [state]);
  const showDiff = open || state === "pending";
  useEffect(() => {
    if (showDiff) setMounted(true);
  }, [showDiff]);
  const done = state === "approved";

  return (
    <div className={`approval file ${state}`}>
      <button type="button" className="approval-head" onClick={() => setOpen(!open)} aria-expanded={showDiff}>
        <span className={"fold-chev" + (showDiff ? " open" : "")} aria-hidden="true">
          <Icon name="chevron-right" />
        </span>
        <FilePath path={change.path} />
        {change.created && <span className="badge new">新建</span>}
        <DiffStat added={change.added} removed={change.removed} />
        <span className={`chip ${state}`}>
          {done && <Icon name="check" />}
          {fileChip(state, auto, review)}
        </span>
      </button>
      <p className="explain">{change.explanation}</p>

      <div className={"diff-collapse" + (showDiff ? " open" : "")}>
        <div className="diff-collapse-inner">{mounted && <DiffBody id={id} change={change} />}</div>
      </div>

      {state === "pending" && (
        <Actions
          id={id}
          rejecting={rejecting}
          setRejecting={setRejecting}
          feedback={feedback}
          setFeedback={setFeedback}
          onRespond={onRespond}
          allowAll
        />
      )}
    </div>
  );
}

/** A file change is "applied" once approved, not just "agreed to". */
function fileChip(state: CardProps["state"], auto: boolean, review?: Props["review"]): string {
  if (state !== "approved") return chipText(state, auto, review);
  if (auto) return "已自动应用";
  return review?.decision === "approve" ? "小助手已同意，已应用" : "已应用";
}

function CommandCard({ id, command, state, run, onRespond }: CardProps & { command: CommandProposal }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const outRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.output]);

  const chip =
    state === "reviewing"
      ? { cls: "reviewing", text: "小助手审核中…" }
      : state === "pending"
      ? { cls: "pending", text: "等你确认" }
      : state === "rejected"
        ? { cls: "rejected", text: "已拒绝" }
        : !run?.done
          ? { cls: "running", text: "运行中…" }
          : run.timedOut
            ? { cls: "rejected", text: "超时，已停止" }
            : run.exitCode === 0
              ? { cls: "approved", text: "成功" }
              : { cls: "rejected", text: run.exitCode == null ? "已停止" : `失败（${run.exitCode}）` };

  return (
    <div className={`approval command ${state}`}>
      <div className="approval-head">
        <span className="verb">运行命令</span>
        <span className="spacer" />
        <span className={`chip ${chip.cls}`}>{chip.text}</span>
      </div>
      <pre className="cmd-line">
        <span className="prompt">$ </span>
        {command.command}
      </pre>
      <p className="explain">{command.explanation}</p>
      {command.warning && <p className="warn">
          <Icon name="warning" /> {command.warning}
        </p>}
      {run && run.output && (
        <pre className="cmd-output" ref={outRef}>
          {run.output}
        </pre>
      )}
      {state === "pending" && (
        <Actions
          id={id}
          rejecting={rejecting}
          setRejecting={setRejecting}
          feedback={feedback}
          setFeedback={setFeedback}
          onRespond={onRespond}
          allowAll={false}
        />
      )}
    </div>
  );
}

interface ActionsProps {
  id: string;
  rejecting: boolean;
  setRejecting(v: boolean): void;
  feedback: string;
  setFeedback(v: string): void;
  onRespond(r: ApprovalResponse): void;
  /** Offer "approve all". File edits only: commands are always confirmed one by one. */
  allowAll: boolean;
}

function Actions({ id, rejecting, setRejecting, feedback, setFeedback, onRespond, allowAll }: ActionsProps) {
  if (rejecting) {
    return (
      <form
        className="approval-actions"
        onSubmit={(e) => {
          e.preventDefault();
          onRespond({ id, decision: "reject", feedback });
        }}
      >
        <input
          id={`feedback-${id}`}
          autoFocus
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="告诉 AI 哪里不对（可以不填）"
        />
        <button type="button" className="icon-btn" onClick={() => setRejecting(false)}>
          返回
        </button>
        <button type="submit" className="reject-btn">
          确定拒绝
        </button>
      </form>
    );
  }
  return (
    <div className="approval-actions">
      <button type="button" className="send" onClick={() => onRespond({ id, decision: "approve" })}>
        {allowAll ? "同意" : "运行"}
      </button>
      {allowAll && (
        <button
          type="button"
          className="mini-btn"
          title="这次对话里 AI 之后的文件改动都直接同意，不再一个个问（命令还是每次都会问）"
          onClick={() => onRespond({ id, decision: "approve_all" })}
        >
          本次对话都同意
        </button>
      )}
      <span className="spacer" />
      <button type="button" className="reject-btn" onClick={() => setRejecting(true)}>
        拒绝
      </button>
    </div>
  );
}

