import type { DispatchJob } from "@shared/types";

// One agent asked another through send_to: when that job ends, its result goes back to the asker
// as a `reply` job, so the receiver never has to call send_to just to answer (and write its
// answer twice). Pure helpers; the wiring is in index.ts.

const ENDED: Partial<Record<DispatchJob["status"], string>> = {
  failed: "没做成",
  cancelled: "被取消了",
  timeout: "超时了",
  exited: "会话已经退出",
};

/** What the asker is told: the receiver's last reply, or one line on why there is none. */
export function replyText(job: DispatchJob, max: number): string {
  if (job.status !== "done") return `（${job.executor.name} ${ENDED[job.status] ?? "没做完"}${job.error ? `：${job.error}` : ""}，没有回复。）`;
  const text = job.result?.text.trim() || "（没有文字回复）";
  return text.length > max ? `${text.slice(0, max)}\n…（回复过长，已截断）` : text;
}

/**
 * Whether the asker already heard back: the receiver messaged it itself during the job (a child
 * job on the asker's executor). A second copy of the same answer would only cost tokens.
 */
export function answered(job: DispatchJob, all: DispatchJob[], askerRef: string): boolean {
  return all.some((j) => j.parentId === job.id && j.executor.ref === askerRef);
}

/** Nothing is sent back for a reply (the two would answer each other for ever), or to nobody. */
export function wantsReply(job: DispatchJob, all: DispatchJob[], askerRef: string): boolean {
  return !job.reply && !answered(job, all, askerRef);
}
