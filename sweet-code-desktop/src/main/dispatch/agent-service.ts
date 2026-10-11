import { randomUUID } from "node:crypto";
import type { AgentPermissionCard, DispatchAgentInput } from "../../shared/types.ts";
import { object } from "../connectors/acp-protocol.ts";
import { AgentApprovals } from "../connectors/approval.ts";
import { AgentExecutor } from "./agent.ts";
import type { Dispatcher } from "./scheduler.ts";

export interface AgentDispatchOptions {
  development(): boolean;
  root(): string | null;
  bin(): string | null;
  dispatcher: Dispatcher;
  approvals: AgentApprovals;
}
export class AgentDispatchService {
  private opts: AgentDispatchOptions;
  private executors = new Set<AgentExecutor>();
  constructor(opts: AgentDispatchOptions) { this.opts = opts; }
  submit(value: unknown): { jobId: string } {
    const o = this.opts;
    if (!o.development()) throw Error("External agents are development-only");
    const cwd = o.root(); if (!cwd) throw Error("No workspace open");
    const bin = o.bin(); if (!bin) throw Error("opencode not found; install/login separately");
    if (!object(value) || typeof value.input !== "string" || !value.input.trim() || value.input.length > 100000) throw Error("Invalid agent input");
    if (value.readOnly !== undefined && typeof value.readOnly !== "boolean") throw Error("Invalid readOnly");
    if (value.model !== undefined && (typeof value.model !== "string" || !/^[\w.-]+\/[\w./:-]+$/.test(value.model))) throw Error("Invalid external model id");
    if (value.owns !== undefined && (!Array.isArray(value.owns) || !value.owns.every(p => typeof p === "string" && p.length > 0 && p.length < 1000))) throw Error("Invalid owns");
    if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 1800000)) throw Error("Invalid timeoutMs");
    if (value.verify !== undefined && (!object(value.verify) || typeof value.verify.typecheck !== "string" || !value.verify.typecheck.trim())) throw Error("Invalid verify");
    const input = value as unknown as DispatchAgentInput;
    const readOnly = input.readOnly !== false;
    const executor = new AgentExecutor({ cwd, bin, readOnly, model: input.model,
      progress: (id, progress) => o.dispatcher.progress(id, progress),
      permission: (card, signal) => o.approvals.ask(card, signal),
      approveStart: async (job, signal) => {
        const card: AgentPermissionCard = { id: `acp-start:${randomUUID()}`, jobId: job.id, sessionId: "", title: "启动外部 agent：opencode", toolCall: { cwd, readOnly, model: input.model, input: job.input, verify: input.verify }, options: [
          { optionId: "start", name: "启动本次任务", kind: "allow_once" },
          { optionId: "reject", name: "拒绝", kind: "reject_once" },
        ] };
        o.dispatcher.progress(job.id, { type: "permission", at: Date.now(), permission: card });
        const result = await o.approvals.ask(card, signal);
        o.dispatcher.progress(job.id, { type: "status", at: Date.now(), text: "running" });
        return result === "start";
      },
    });
    const sub = o.dispatcher.submit({ executor, input: input.input, origin: "user", from: "sikeoop", timeoutMs: input.timeoutMs, scope: { roots: [cwd], owns: input.owns }, verify: input.verify });
    if ("error" in sub) { executor.close(); throw Error(sub.error); }
    this.executors.add(executor);
    void sub.done.finally(() => { executor.close(); this.executors.delete(executor); });
    return { jobId: sub.job.id };
  }
  close(): void { for (const executor of this.executors) executor.close(); this.opts.approvals.close(); }
}
