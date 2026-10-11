import type { AgentMobileSnapshot } from "../agent/loop";
import type { MobileView } from "../../shared/types";

/** The main conversation as the phone's home screen shows it (status card, plan progress, last receipt). */
export function mobileView(
  snap: AgentMobileSnapshot,
  computer: { id: string; name: string },
  project: { name: string; path?: string } | undefined,
): MobileView {
  const events = snap.events;
  let lastEnd: (typeof events)[number]["event"] | undefined;
  let lastChanges: { turnId: number; files: number; at: number } | undefined;
  for (let i = events.length - 1; i >= 0 && (!lastEnd || !lastChanges); i--) {
    const e = events[i].event;
    if (!lastEnd && (e.type === "done" || e.type === "error")) lastEnd = e;
    if (!lastChanges && e.type === "turn_changes") lastChanges = { turnId: e.turnId, files: e.files.length, at: 0 };
  }

  const waiting = snap.pendingApprovals.length + snap.pendingQuestions.length;
  const status: MobileView["status"] = snap.busy
    ? waiting
      ? "waiting"
      : "working"
    : lastEnd?.type === "error"
      ? "error"
      : lastEnd?.type === "done"
        ? lastEnd.reason === "end_turn"
          ? "done"
          : "incomplete"
        : "idle";

  const lastUser = [...snap.transcript].reverse().find((t) => t.role === "user");
  const lastAssistant = [...snap.transcript].reverse().find((t) => t.role === "ai");
  const reply =
    lastAssistant && lastAssistant.role === "ai"
      ? lastAssistant.events.map((e) => (e.type === "text_delta" ? e.text : "")).join("").trim()
      : "";
  const done = snap.plan.filter((p) => p.status === "done" || p.status === "skipped").length;
  const current = snap.plan.find((p) => p.status === "in_progress")?.text;

  return {
    status,
    presence: { online: true },
    computer,
    ...(project ? { project } : {}),
    ...(snap.busy || snap.plan.length
      ? {
          turn: {
            id: String(snap.turnId),
            prompt: lastUser && lastUser.role === "user" ? lastUser.text.slice(0, 500) : snap.task,
            startedAt: lastUser?.createdAt ?? 0,
            ...(current ? { currentActivity: current } : {}),
            plan: snap.plan,
            completedSteps: done,
            totalSteps: snap.plan.length,
          },
        }
      : {}),
    pendingApprovals: waiting,
    ...(lastChanges
      ? { lastReceipt: { turnId: lastChanges.turnId, summary: reply.slice(0, 200), changedFiles: lastChanges.files, completedAt: lastAssistant?.createdAt ?? 0 } }
      : {}),
    ...(lastEnd?.type === "error" ? { error: lastEnd.message.slice(0, 300) } : {}),
  };
}
