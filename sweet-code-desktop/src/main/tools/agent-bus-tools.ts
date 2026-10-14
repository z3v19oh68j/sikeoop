import { z } from "zod";
import type { AgentCli, AgentSessionView, DispatchJob } from "@shared/types";
import { defineTool, type ToolSpec } from "./registry.ts";
import { OWNS_DESCRIPTION, TYPECHECK_DESCRIPTION } from "./dispatch-tools.ts";
import { checksText } from "../dispatch/verify.ts";
import { hostMessagesText } from "../peer-host.ts";

// The main agent as the coordinator of the Claude Code and Codex sessions in sikeoop's terminal
// tabs (peers.ts): open one, give it a task, and get its final reply back. This is how a task sent
// from WeChat reaches them. Tasks go through the dispatch core, so a busy session gets them queued.

export interface AgentBusDeps {
  list(): string;
  /** missing: no session of that kind is running, so one can be opened for the task. */
  find(name: string): AgentSessionView | { error: string; missing?: AgentCli };
  /** Hand a task to a session through the dispatch core; queued while it is busy. */
  send(
    to: string,
    message: string,
    parentJobId?: string,
    limits?: { owns?: string[]; network?: boolean; deps?: string[]; typecheck?: string },
  ): { session: AgentSessionView; queued: boolean; done: Promise<DispatchJob> } | { error: string };
  /** The dispatched job a session is on (or the newest one waiting for it). */
  job(id: string): Promise<DispatchJob> | null;
  pending(id: string): Promise<DispatchJob> | null;
  /** The dispatched job a session finished last, as long as nothing else has happened in its terminal since. */
  last(s: AgentSessionView): DispatchJob | null;
  /** For work the user started in the terminal themselves: the end of the current turn. */
  waitTurn(id: string, ms: number, signal: AbortSignal): Promise<string | null>;
  ids(): Set<string>;
  waitStarted(cli: AgentCli, known: Set<string>, ms: number, signal: AbortSignal): Promise<AgentSessionView | null>;
  /** Asks the window to open a terminal tab running the CLI; false when there's no window. */
  open(cli: AgentCli): boolean;
  /**
   * The configured models that can work as sub-agents. Unlike a terminal session a model keeps
   * nothing between tasks: each task gets a fresh session of its own, so one model can take several
   * at once. Named "provider/model", which no session name can look like.
   */
  workers?: {
    list(): string;
    /** The worker's name as listed, or null when `name` is not one of them. */
    find(name: string): string | null;
    /** Starts a sub-agent on the task through the dispatch core. Cancelled together with the caller's turn. */
    run(
      name: string,
      message: string,
      signal: AbortSignal,
      parentJobId?: string,
      limits?: { owns?: string[]; network?: boolean; deps?: string[]; typecheck?: string },
    ): { job?: DispatchJob; done: Promise<DispatchJob> } | { error: string };
  };
}

const MAX_RESULT = 8000;
const DEFAULT_WAIT_MIN = 20;
const WORKER_WAIT_MIN = 32;
const MAX_WAIT_MIN = 60;

/** All the replies of one call together stay under this, so a batch costs no more context than two single tasks. */
const MAX_BATCH_RESULT = 16_000;
const START_MS = 90_000;
const CLI_NAME: Record<AgentCli, string> = { claude: "Claude Code", codex: "Codex" };

const cut = (s: string, max = MAX_RESULT) => (s.length > max ? s.slice(0, max) + "\n…（回复过长，已截断）" : s);
/** How long each of `n` replies returned together may be. */
const share = (n: number) => (n > 1 ? Math.max(2000, Math.floor(MAX_BATCH_RESULT / n)) : MAX_RESULT);
/** Several sessions' results in one tool result. */
const merge = (parts: string[]) => parts.join("\n\n---\n\n");

const NOT_STARTED = "90 秒内没启动好。可能没安装这个 CLI，或者需要先在终端里登录。";

const STATUS_TEXT: Partial<Record<DispatchJob["status"], string>> = {
  failed: "没做成",
  cancelled: "被取消了",
  timeout: "超时了",
  exited: "会话已经退出",
};

/** Waits for a dispatched job up to `minutes`; the job itself keeps going after that. */
async function waitJob(s: { name: string; jobId?: string }, done: Promise<DispatchJob>, minutes: number | undefined, signal: AbortSignal, max = MAX_RESULT): Promise<string> {
  const min = Math.min(Math.max(minutes ?? DEFAULT_WAIT_MIN, 1), MAX_WAIT_MIN);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const job = await Promise.race([
    done,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), min * 60_000);
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  clearTimeout(timer);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (!job) return s.jobId
    ? `${s.name} 在 ${min} 分钟内还没做完（任务 #${s.jobId.slice(0, 8)}）。之后用 wait_agent（job="${s.jobId}"）取结果。`
    : `${s.name} 在 ${min} 分钟内还没做完。可以之后用 wait_agent（to="${s.name}"）继续等，或用 list_agents 看状态。`;
  const checks = checksText(job.checks);
  // What it sent up while working (peer-host.ts): short, and worth reading even when the task failed.
  const sent = hostMessagesText(s.name, job.progress);
  if (job.status !== "done") return [`${s.name} ${STATUS_TEXT[job.status] ?? "没做完"}${job.error ? `：${job.error}` : ""}。`, checks, sent].filter(Boolean).join("\n\n");
  // The checks go first: the reply may be cut, they must not be.
  return [checks, sent, cut(`${s.name} 做完了这一轮，它的最后回复：\n\n${job.result?.text || "（没有文字回复）"}`, max)].filter(Boolean).join("\n\n");
}

/** The end of a turn the user started in the terminal (no dispatched job to follow). */
async function waitTurn(deps: AgentBusDeps, s: AgentSessionView, minutes: number | undefined, signal: AbortSignal, max = MAX_RESULT): Promise<string> {
  const min = Math.min(Math.max(minutes ?? DEFAULT_WAIT_MIN, 1), MAX_WAIT_MIN);
  const last = await deps.waitTurn(s.id, min * 60_000, signal);
  if (last === null) return `${s.name} 在 ${min} 分钟内还没做完（或者会话已关闭）。可以之后用 wait_agent 继续等，或用 list_agents 看状态。`;
  return cut(`${s.name} 做完了这一轮，它的最后回复：\n\n${last || "（没有文字回复）"}`, max);
}

const taskSchema = z.object({
  to: z.string().optional(),
  message: z.string(),
  owns: z.array(z.string()).optional(),
  needs_network: z.boolean().optional(),
  needs_deps: z.array(z.string()).optional(),
  typecheck: z.string().optional(),
});
type Task = z.infer<typeof taskSchema>;

/** One task of a send_to_agent call: who gets it, or why nobody does. */
interface Plan {
  task: Task;
  message: string;
  /** How the target reads on the approval card and in the result. */
  label: string;
  /** The session's name, once there is one. */
  to?: string;
  /** No session of this kind is running: one is opened after the user agrees. */
  open?: AgentCli;
  /** A model, not a terminal session: the task runs in a sub-agent of its own. */
  worker?: boolean;
  error?: string;
}

const LIMIT_PROPERTIES = {
  owns: { type: "array", items: { type: "string" }, description: OWNS_DESCRIPTION },
  needs_network: { type: "boolean", description: "任务要联网（装依赖、访问接口）。派活前会检查对方能不能联网" },
  needs_deps: { type: "array", items: { type: "string" }, description: "必须已经装好依赖的文件夹（相对项目根），派活前检查 node_modules" },
  typecheck: { type: "string", description: TYPECHECK_DESCRIPTION },
};

/** wait_agent's `to`: one name, several separated by commas, or a list. */
const targets = (to: string | string[]): string[] => [...new Set((Array.isArray(to) ? to : to.split(/[,，、]/)).map((n) => n.trim()).filter(Boolean))];

export function agentBusTools(deps: AgentBusDeps): ToolSpec[] {
  return [
    defineTool({
      name: "list_agents",
      description: "列出现在能派活的 AI：终端里的 Claude Code 和 Codex 会话（以及每个在做什么），和已配置好、可以当子代理用的模型。",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {} },
      permission: "auto",
      parallelSafe: true,
      summarize: () => "查看能派活的 AI",
      run: async () => [deps.list(), deps.workers?.list()].filter(Boolean).join("\n\n"),
    }),
    defineTool({
      name: "start_agent",
      description: "在 sikeoop 的终端里新开一个 Claude Code 或 Codex 会话（工作目录是当前项目），等它启动好后返回它的名字（如 Claude-1）。只为派活不用先调它：send_to_agent 会自己开。",
      schema: z.object({ cli: z.enum(["claude", "codex"]) }),
      inputSchema: {
        type: "object",
        properties: { cli: { type: "string", enum: ["claude", "codex"], description: "claude = Claude Code，codex = Codex" } },
        required: ["cli"],
      },
      permission: "confirm",
      parallelSafe: false,
      summarize: (i) => `新开 ${i.cli === "codex" ? "Codex" : "Claude Code"} 会话`,
      async run(input, ctx) {
        const name = input.cli === "codex" ? "Codex" : "Claude Code";
        const outcome = await ctx.requestApproval({ kind: "tool", server: "agent-bus", tool: "start_agent", description: `新开一个 ${name} 会话`, args: input.cli });
        if (!outcome.approved) return `用户没有同意新开 ${name} 会话。${outcome.feedback ?? ""}`.trim();
        const known = deps.ids();
        if (!deps.open(input.cli)) return "Error: sikeoop 窗口没开，没法新开终端。";
        const s = await deps.waitStarted(input.cli, known, START_MS, ctx.signal);
        return s ? `已开好 ${s.name}。用 send_to_agent 给它布置任务。` : `Error: ${NOT_STARTED}`;
      },
    }),
    defineTool({
      name: "send_to_agent",
      description:
        "给终端里的 Claude Code 或 Codex 会话布置任务（像用户在它的终端里输入一样）。默认会等它做完这一轮，返回它的最后回复。" +
        "to 也可以是 list_agents 列出的模型（供应商/模型）：它会开一个独立子代理做这个任务，看不到这段对话，做完才返回。" +
        "任务要写清目标、相关文件和验收标准；代码给文件路径，不要贴大段代码。" +
        "要派给几个会话时用 tasks 一次派完：只问用户一次，一起等，结果合并返回。to 写 claude / codex 而没有该类会话时会自动新开一个。",
      schema: z.object({
        to: z.string().optional(),
        message: z.string().optional(),
        tasks: z.array(taskSchema.extend({ message: z.string().min(1) })).min(1).optional(),
        wait: z.boolean().optional(),
        wait_minutes: z.number().optional(),
        owns: z.array(z.string()).optional(),
        needs_network: z.boolean().optional(),
        needs_deps: z.array(z.string()).optional(),
        typecheck: z.string().optional(),
      }),
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "会话名（Claude-1 / Codex-1），只有一个该类会话时写 claude / codex 即可；只有一个会话时可省略。或者模型名（供应商/模型）" },
          message: { type: "string", description: "要它做的事" },
          tasks: {
            type: "array",
            description: "一次派给多个会话时用它代替 to / message，每项是一个任务",
            items: {
              type: "object",
              properties: { to: { type: "string" }, message: { type: "string" }, ...LIMIT_PROPERTIES },
              required: ["to", "message"],
            },
          },
          wait: { type: "boolean", description: "等它做完再返回（默认 true）。false 时立刻返回，之后用 wait_agent 取结果" },
          wait_minutes: { type: "number", description: `最多等几分钟（终端默认 ${DEFAULT_WAIT_MIN}，子代理默认 ${WORKER_WAIT_MIN}，上限 ${MAX_WAIT_MIN}）` },
          ...LIMIT_PROPERTIES,
        },
      },
      permission: "confirm",
      parallelSafe: false,
      summarize: (i) =>
        i.tasks ? `交给 ${[...new Set(i.tasks.map((t) => t.to || "Claude/Codex"))].join("、")}：${i.tasks.length} 个任务` : `交给 ${i.to || "Claude/Codex"}：${(i.message ?? "").slice(0, 40)}`,
      async run(input, ctx) {
        const batch = !!input.tasks;
        const tasks: Task[] = input.tasks ?? [{ ...input, message: input.message ?? "" }];
        if (!batch && !tasks[0].message.trim()) return "Error: message 和 tasks 至少要给一个。";

        // Every target is settled before the user is asked, so one card covers the whole batch.
        const plans = tasks.map((t): Plan => {
          const message = t.message.trim();
          const worker = t.to?.includes("/") ? deps.workers?.find(t.to) : null;
          if (worker) return { task: t, message, label: worker, to: worker, worker: true };
          const found = deps.find(t.to ?? "");
          if (!("error" in found)) return { task: t, message, label: found.name, to: found.name };
          // "claude" / "codex" with none running: the task brings its own session.
          if (found.missing) return { task: t, message, label: `新开的 ${CLI_NAME[found.missing]}`, open: found.missing };
          return { task: t, message, label: t.to || "（没写发给谁）", error: found.error };
        });
        const ready = plans.filter((p) => !p.error);
        if (!ready.length) return batch ? merge(plans.map((p) => `${p.label}：Error: ${p.error}`)) : `Error: ${plans[0].error}`;

        const opening = [...new Set(ready.flatMap((p) => (p.open ? [p.open] : [])))];
        const names = [...new Set(ready.map((p) => p.label))].join("、");
        const opens = opening.length ? `（会新开一个 ${opening.map((c) => CLI_NAME[c]).join("和一个 ")} 会话）` : "";
        const outcome = await ctx.requestApproval({
          kind: "tool",
          server: "agent-bus",
          tool: "send_to_agent",
          description: (batch ? `一次交给 ${names} 共 ${ready.length} 个任务` : `交给 ${names} 一个任务`) + opens,
          args: batch ? ready.map((p) => `【${p.label}】${p.message}`).join("\n\n") : ready[0].message,
        });
        if (!outcome.approved) return `用户没有同意交给 ${names}。${outcome.feedback ?? ""}`.trim();

        // One new session per kind, shared by every task of the batch that asked for that kind.
        for (const cli of opening) {
          const known = deps.ids();
          const s = deps.open(cli) ? await deps.waitStarted(cli, known, START_MS, ctx.signal) : undefined;
          for (const p of ready) {
            if (p.open !== cli) continue;
            if (s) p.to = p.label = s.name;
            else p.error = s === undefined ? "sikeoop 窗口没开，没法新开终端。" : NOT_STARTED;
          }
        }

        const max = share(ready.length);
        const results = await Promise.all(
          plans.map(async (p) => {
            if (p.error || !p.to) return `${batch ? `${p.label}：` : ""}Error: ${p.error}`;
            const t = p.task;
            const limits = { owns: t.owns, network: t.needs_network, deps: t.needs_deps, typecheck: t.typecheck };
            if (p.worker) {
              // Preserve its task id so a shorter wait can be resumed later.
              const started = deps.workers!.run(p.to, p.message, ctx.signal, ctx.dispatchJobId, limits);
              if ("error" in started) return `${batch ? `${p.label}：` : ""}Error: ${started.error}`;
              return waitJob({ name: p.to, jobId: started.job?.id }, started.done, input.wait_minutes ?? WORKER_WAIT_MIN, ctx.signal, max);
            }
            const sent = deps.send(p.to, p.message, ctx.dispatchJobId, limits);
            if ("error" in sent) return `${batch ? `${p.label}：` : ""}Error: ${sent.error}`;
            const s = sent.session;
            if (input.wait === false) {
              const state = sent.queued ? "它现在在忙，任务已排队，空下来就开始" : "它在干活";
              return `已交给 ${s.name}，${state}。用 wait_agent（to="${s.name}"）取结果。`;
            }
            return waitJob(s, sent.done, input.wait_minutes, ctx.signal, max);
          }),
        );
        return merge(results);
      },
    }),
    defineTool({
      name: "wait_agent",
      description: "按 to 等终端会话，或按 job 任务编号取子代理结果。可以一次等多个。to 和 job 至少给一个。",
      schema: z.object({ to: z.union([z.string(), z.array(z.string())]).optional(), job: z.union([z.string(), z.array(z.string())]).optional(), wait_minutes: z.number().optional() }),
      inputSchema: {
        type: "object",
        properties: {
          to: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "终端会话名；子代理请用 job 参数等" },
          job: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "完整任务编号，可以一次给多个" },
          wait_minutes: { type: "number", description: `最多等几分钟（默认 ${DEFAULT_WAIT_MIN}，上限 ${MAX_WAIT_MIN}）` },
        },
      },
      permission: "auto",
      parallelSafe: true,
      summarize: (i) => `等 ${ [...targets(i.to ?? []), ...targets(i.job ?? [])].join("、")} 做完`,
      async run(input, ctx) {
        const names = targets(input.to ?? []);
        const ids = targets(input.job ?? []);
        if (!names.length && !ids.length) return "Error: to 和 job 至少要给一个，且不能是空的。";
        const max = share(names.length + ids.length);
        const one = async (name: string): Promise<string> => {
          if (name.includes("/")) return `${name}：Error: 子代理请用 job 参数等（完整任务编号）。`;
          const s = deps.find(name);
          if ("error" in s) return `${names.length > 1 ? `${name}：` : ""}Error: ${s.error}`;
          const job = deps.pending(s.id);
          if (job) return waitJob(s, job, input.wait_minutes, ctx.signal, max);
          // A task sent without waiting may be done before anyone asks: its result is still handed over.
          const finished = deps.last(s);
          if (finished) return waitJob(s, Promise.resolve(finished), input.wait_minutes, ctx.signal, max);
          if (s.status === "idle") return `${s.name} 现在是空闲的，没有在做的事。最近一条：${s.detail}`;
          return waitTurn(deps, s, input.wait_minutes, ctx.signal, max);
        };
        return merge(await Promise.all([
          ...names.map(one),
          ...ids.map(async (id) => {
            const done = deps.job(id);
            if (!done) return `Error: 没有任务 #${id}，可能已经不在历史里。`;
            return waitJob({ name: `任务 #${id.slice(0, 8)}`, jobId: id }, done, input.wait_minutes, ctx.signal, max);
          }),
        ]));
      },
    }),
  ];
}
