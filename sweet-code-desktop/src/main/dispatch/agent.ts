import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentPermissionCard, DispatchJob, DispatchProgress } from "../../shared/types.ts";
import { AcpConnector, type AcpOptions } from "../connectors/acp.ts";
import { stopStatus } from "../connectors/acp-protocol.ts";
import { realWriteViolation } from "./guard.ts";
import { fileLocks, type FileLocks } from "../session/locks.ts";
import type { Executor } from "./scheduler.ts";

export interface AgentExecutorOptions extends Omit<AcpOptions, "progress" | "permission"> {
  ref?: string;
  fileLocks?: FileLocks;
  progress(jobId: string, progress: DispatchProgress): void;
  permission(card: AgentPermissionCard, signal: AbortSignal): Promise<string | null>;
  approveStart(job: DispatchJob, signal: AbortSignal): Promise<boolean>;
}
export class AgentExecutor implements Executor {
  readonly kind = "agent" as const;
  readonly name = "opencode";
  readonly ref: string;
  private connector: AcpConnector;
  private opts: AgentExecutorOptions;
  private job: DispatchJob | null = null;
  constructor(opts: AgentExecutorOptions) {
    this.opts = opts;
    this.ref = opts.ref ?? `acp-session:${randomUUID()}`;
    this.connector = new AcpConnector({ ...opts,
      progress: progress => { if (this.job) opts.progress(this.job.id, progress); },
      permission: async (card, signal) => {
        // Structured locations are used only for policy, never parsed into executable commands.
        const kind = card.toolCall.kind;
        if (opts.readOnly && ["edit", "delete", "move", "execute", "switch_mode"].includes(String(kind))) return null;
        if (this.job && ["edit", "delete", "move"].includes(String(kind))) {
          const locations = card.toolCall.locations;
          if (!Array.isArray(locations) || !locations.length) return null;
          const job = this.job;
          const files: string[] = [];
          for (const loc of locations) {
            if (!loc || typeof loc.path !== "string" || await realWriteViolation(job, path.resolve(opts.cwd, loc.path))) return null;
            files.push(path.resolve(opts.cwd, loc.path));
          }
          if (signal.aborted || this.job !== job) return null;
          const locks = opts.fileLocks ?? fileLocks;
          const lock = await locks.acquire(this.ref, files);
          if (signal.aborted || this.job !== job) { locks.release(this.ref); return null; }
          if (!lock.ok) {
            opts.progress(job.id, { type: "status", at: Date.now(), text: `文件被其他 AI 锁定：${lock.path}（owner: ${lock.owner}）` });
            return null;
          }
        }
        return opts.permission(card, signal);
      },
    });
  }
  ready(): boolean { return !this.job && this.connector.ready(); }
  alive(): boolean { return this.connector.alive(); }
  env(): { writableRoots: string[]; network: "ask" } { return { writableRoots: [this.opts.cwd], network: "ask" }; }
  close(): void { this.connector.close(); }
  async run(job: DispatchJob, signal: AbortSignal): Promise<{ text: string; outcome: string }> {
    this.job = job;
    try {
      if (!await this.opts.approveStart(job, signal) || signal.aborted) throw Error("External agent launch denied");
      const result = await this.connector.run(job.id, job.input, signal);
      const status = stopStatus(result.outcome);
      if (status === "failed") throw Error(`ACP stopped: ${result.outcome}`);
      return result;
    } finally { (this.opts.fileLocks ?? fileLocks).release(this.ref); this.job = null; }
  }
}
