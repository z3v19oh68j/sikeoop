import { reportUsage } from "../usage/ledger";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ApprovalResponse,
  ApprovalSubject,
  AskQuestion,
  ChatRequest,
  ImageInput,
  PlanItem,
  TranscriptItem,
  UndoResult,
  QuestionResponse,
  Effort,
  RoutingSettings,
  EffortPurpose,
} from "@shared/types";
import { diffLines } from "@shared/diff";
import type { HistoryEntry, ModelAdapter, ToolCall, ToolDef, ToolResult } from "../providers/types";
import {
  ReadTracker,
  type ApprovalOutcome,
  type ApprovalRequest,
  type Permission,
  type ToolContext,
  type ToolRegistry,
} from "../tools/registry";
import { CheckpointStore } from "./checkpoints";
import { AUTOPILOT_NOTE, LAZY_NOTE, ORCHESTRATE_NOTE, editorContextText, projectSnapshot } from "./context";
import type { ReviewInput, ReviewVerdict } from "./reviewer";
import type { HookContext, HookInput, HookResult } from "../hooks/bus";
import type { HookEventName } from "@shared/types";
import { COMPACTOR_SYSTEM, type CompactInput, SESSION_SUMMARY_SYSTEM, compressorPrompt, fallbackSummary, stateBlock } from "./compactor";
import { contextUsage } from "./context-usage";
import type { ContextUsage } from "@shared/types";
import type { SessionFile } from "./session-store";
import { fileLocks } from "../session/locks";
import { handoffRecord } from "./handoff";
import { failoverReason } from "./failover";
import { recordFailure, recordSuccess } from "../providers/health.ts";
import { providerWideFailure } from "../providers/model-routing.ts";
import { classify, autoPurpose, effortPurpose, selectEffort, type Difficulty } from "./route.ts";
import { supportsClaudeEffort, isEffort } from "../providers/effort.ts";
import { wrapPastedContent } from "./pasted-content.ts";
import { createAutoResumeState, claimAutoResume, normalizeAutoResumeState, AUTO_RESUME_REVIEW_REASON, type AutoResumeState } from "./auto-resume.ts";
import path from "node:path";
import type { LessonInput, SavedLesson } from "./lessons";

/** Model round-trips allowed per user message before the loop stops itself. */
const MAX_STEPS = 40;
/** The same limit in long-task mode, where the agent is expected to keep going on its own. */
const AUTOPILOT_STEPS = 200;
/** What the agent does not do itself in super-dispatch mode. */
const HANDS_ON = new Set(["edit_file", "create_file", "run_command"]);
/** Failures kept per turn for the lessons of an autonomous run, and the length of each. */
const MAX_FAILURES = 30;
const MAX_FAILURE_CHARS = 800;
/**
 * Commands only the user can approve, even in long-task mode: they reach other people
 * (push, publish, deploy) and can't be taken back.
 */
/**
 * Lazy mode approves everything by itself, so these are refused on the spot instead: they reach
 * beyond the project into the system, the disk or the user's secrets, and can't be undone.
 */
const LAZY_STOP: { re: RegExp; reason: string }[] = [
  { re: /\bsudo\b|\bsu\s+-?\s*\w*\s*$|\bdoas\b/, reason: "要管理员权限" },
  { re: /\brm\s+(?:-[a-zA-Z]+\s+)*["']?(?:\/|~|\$HOME|\.\.)/, reason: "要删除项目文件夹外面的东西" },
  { re: /\b(mkfs|fdisk|newfs)\b|\bdiskutil\s+(erase|partition|zero|unmount)|\bdd\b[^|]*\bof=\/dev\/|>\s*\/dev\/(disk|sd|nvme)/, reason: "会动到磁盘" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b|\blaunchctl\b|\bdefaults\s+(write|delete)\b|\bcsrutil\b|\bnvram\b|\bsystemsetup\b|\bspctl\b/, reason: "会改系统设置或关机" },
  { re: /\bsecurity\s+(find|dump|export|delete)-|\bKeychains?\b|\.ssh\/|\.aws\/|\.gnupg\//, reason: "会碰到钥匙串、SSH 密钥这类机密" },
  { re: /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/, reason: "会直接运行从网上下载的脚本" },
  { re: /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+["']?(\/|~)|:\(\)\s*\{/, reason: "可能破坏系统" },
];

const HUMAN_ONLY = /\bgit\s+push\b|\b(npm|pnpm|yarn|bun)\s+publish\b|\b(vercel|netlify|wrangler|firebase|fly)\b.*\bdeploy\b|\bdeploy\b.*--prod/;
/** Tool output beyond this is cut so one huge file can't flood the context. */
const MAX_TOOL_RESULT_CHARS = 100_000;

type Emit = (e: AgentEvent) => void;

/** The provider a conversation was started with. Its history only makes sense with that provider. */
export interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  model: string;
  compat?: boolean;
  builtinFree?: boolean;
  /** Persist auto intent while model records the concrete id used. */
  auto?: boolean;
}

/** A model to run on other than the active provider's (failover, routing, a reopened conversation). */
export interface ModelTarget {
  providerId: string;
  model?: string;
  auto?: boolean;
}

/** Why the conversation moved to another model. */
export type SwitchReason = "manual" | "failover" | "route" | "reopen";

/** Rough characters per token for sizing a handoff record (mixed Chinese and code). */
const CHARS_PER_TOKEN = 2.5;

export interface MadeAdapter {
  adapter: ModelAdapter;
  provider: ProviderInfo;
  /** Tools this conversation can call: built-ins plus the skills and MCP servers active right now. */
  registry: ToolRegistry;
  /** The tool definitions sent to the model. Fixed for the conversation, and saved with it. */
  toolDefs: ToolDef[];
  /** Installed skills to list at the start of the conversation. */
  skills: { name: string; description: string }[];
  /** Tokens the conversation may fill before it is compressed (presets.contextBudget). */
  contextBudget: number;
  /** The model's context window, and the system prompt (both for the usage breakdown). */
  contextWindow: number;
  systemPrompt: string;
}

export interface SessionDeps {
  onTurnError?(err: unknown): void;
  /**
   * Build the adapter for the active provider. A restored conversation passes the tool list it
   * was started with: changing tools mid-conversation would reset the cache and Claude's thinking.
   */
  /** target: another provider/model than the active one. */
  makeAdapter(savedToolDefs?: ToolDef[], target?: ModelTarget): MadeAdapter;
  /** Backup models, in order, for when the conversation's model fails mid-turn. Only ones that can run. */
  failover?(current?: ProviderInfo, target?: ModelTarget, err?: unknown, purpose?: EffortPurpose): ModelTarget[];
  /** Discover before synchronous adapter construction; returns a concrete auto selection. */
  prepareModel?(target: ModelTarget | undefined, purpose: import("../../shared/types.ts").EffortPurpose, signal: AbortSignal): Promise<ModelTarget | undefined>;
  /** Routing by difficulty is on: the model for a light or a heavy message, if one is set and can run. */
  route?(level: Difficulty): ModelTarget | undefined;
  routingSettings?(): RoutingSettings;
  purpose?: "subtask";
  onNeedsReview?(reason: string, count: number, sessionId: string, dispatchJobId?: string): void;
  emit: Emit;
  /** Project folder this conversation belongs to. */
  root(): string;
  /** Save the conversation. Called after every turn and every undo. */
  persist(file: SessionFile): Promise<void>;
  /** Read images with the vision model; returns its written analysis and the model's name. */
  analyzeImages(images: ImageInput[], question: string, signal: AbortSignal): Promise<{ text: string; model: string }>;
  /** Long-task mode: have the reviewer sub-agent judge one action. Throws on provider errors. */
  review(input: ReviewInput, provider: ProviderInfo, signal: AbortSignal): Promise<ReviewVerdict & { model: string }>;
  /**
   * The compression sub-agent: one request with its own instructions (COMPACTOR_SYSTEM) to the
   * conversation's provider, separate from the conversation itself.
   */
  compress(system: string, prompt: string, provider: ProviderInfo, signal: AbortSignal): Promise<string>;
  /**
   * The lessons sub-agent: after a long task with failures, turns them into lessons for the project,
   * saves them to memory and returns what was saved. Throws on provider errors.
   */
  learn(input: LessonInput, provider: ProviderInfo, signal: AbortSignal): Promise<SavedLesson[]>;
  /** The hook bus: built-in context features and the user's command hooks. */
  hooks: { run(event: HookEventName, input: HookInput, ctx: HookContext): Promise<HookResult> };
  /**
   * Keep a c2 session summary (memory/session-summary.ts). Absent for sub-agents, and returns
   * false (without saving) while long-term memory is off.
   */
  saveSummary?(root: string, s: { id: string; title: string; turn: number; source: "compact" | "periodic" | "leave"; text: string }): Promise<boolean>;
  /** True while an authenticated phone is connected; only it may receive human-only lazy approvals. */
  mobileOnline?(): boolean;
}

export interface AgentMobileSnapshot {
  sessionId: string;
  eventCursor: number;
  title: string;
  busy: boolean;
  turnId: number;
  task: string;
  plan: PlanItem[];
  transcript: TranscriptItem[];
  events: { cursor: number; event: AgentEvent }[];
  pendingApprovals: { id: string; subject: ApprovalSubject; humanOnly: boolean; createdAt: number }[];
  pendingQuestions: { id: string; intro?: string; questions: AskQuestion[]; createdAt: number }[];
}

/** Write a c2 summary after this many turns without one, and on leaving after at least LEAVE_TURNS. */
const SUMMARY_EVERY = 8;
const LEAVE_TURNS = 3;
const SUMMARY_TIMEOUT = 90_000;

/** Events that rebuild the chat view when a conversation is reopened. Side effects (file_changed…) are left out. */
const RECORDED = new Set<AgentEvent["type"]>([
  "thinking_delta",
  "text_delta",
  "tool_start",
  "tool_end",
  "approval_request",
  "approval_result",
  "question",
  "question_answered",
  "command_output",
  "command_done",
  "turn_changes",
  "context_trimmed",
  "model_switched",
  "vision",
  "review",
  "plan",
  "hook",
  "memory_saved",
  "done",
  "error",
]);
/** Below this many prompt tokens a request is too small to be cached, so no cache read is expected. */
const MIN_CACHEABLE = 4096;
/** Prompt caches live about 5 minutes since last use (Anthropic, DeepSeek); a miss after that is expected. */
const CACHE_TTL_MS = 5 * 60_000;
/** A hit should read back most of the previous prompt; less means the prefix broke partway. */
const HIT_SHARE = 0.6;
/** One history entry, for telling whether the conversation's earlier part was rewritten. */
const entryHash = (e: HistoryEntry) => createHash("sha1").update(JSON.stringify(e)).digest("hex").slice(0, 16);
/** How often a tool call being written updates its card, and how much of its arguments the card keeps. */
const PREVIEW_INTERVAL_MS = 120;
const PREVIEW_CHARS = 1500;

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * One conversation with the agent, independent of the model provider.
 *
 * State machine per user message (a "turn"):
 *   STREAMING → (tool_use) → RUNNING_TOOLS ⇄ AWAITING_APPROVAL → STREAMING → … → DONE
 * with exits for refusal, max_tokens, cancel, error and the step limit.
 *
 * History is append-only. A turn that fails or is cancelled is rolled back to
 * where it started, so the history always ends in a valid state and the
 * cached prefix of earlier turns is never edited. File writes are not rolled
 * back with it: they stay on disk, the user can undo them per turn, and the
 * model is told about either case in a note on the next message.
 */
export class AgentSession {
  /** Set while the session works on a dispatch job (dispatch/), so the jobs it starts become its children. */
  dispatchJobId: string | undefined;
  /** The model this conversation runs on when it isn't the active provider's (see switchModel). */
  private target: ModelTarget | undefined;
  /** A switch asked for while a turn was running: done when the turn ends. */
  private pendingSwitch: { reason: SwitchReason; target?: ModelTarget } | null = null;
  /** Set with dispatchJobId when the job limits what it may write (dispatch/guard.ts). */
  writeGuard: ((abs: string) => Promise<string | null> | string | null) | undefined;
  /** Created on the first message, so a provider change only takes effect in a new conversation. */
  private adapter: ModelAdapter | null = null;
  private provider: ProviderInfo | null = null;
  /** Set together with the adapter, when the conversation starts. */
  private registry: ToolRegistry | null = null;
  private toolDefs: ToolDef[] = [];
  private skills: { name: string; description: string }[] = [];
  private id: string = randomUUID();
  private title = "";
  private createdAt = Date.now();
  /** What the chat shows, for reopening the conversation later. */
  private transcript: TranscriptItem[] = [];
  private mobileEventCursor = 0;
  private mobileEventHistory: { cursor: number; event: AgentEvent }[] = [];
  /** Previous request's prompt size, to notice a cache that should have hit but didn't. */
  private lastPromptTokens = 0;
  private snapshotSent = false;
  private controller: AbortController | null = null;
  private turnCounter = 0;
  /** turnCounter when the last c2 summary was written. */
  private summaryTurn = 0;
  /** The user chose "approve all" for this conversation. */
  private autoRoutePurpose: EffortPurpose = "coding";
  private autoApprove = false;
  /** The current message runs in long-task mode (reviewer answers approvals). */
  private autopilot = false;
  /** Lazy mode (on top of long-task mode): nothing waits for the user at all. */
  private lazy = false;
  /** The current message runs in super-dispatch mode (the agent hands work out and does none itself). */
  private orchestrate = false;
  /** The message that started the current turn, for the reviewer. */
  private task = "";
  private mobileOrigin: ChatRequest["origin"];
  /** The agent's checklist (update_plan); kept across turns so "继续" picks it up. */
  private plan: PlanItem[] = [];
  /** Tool summaries of the current turn, for the reviewer. */
  private recent: string[] = [];
  /** What went wrong in the current turn (tool errors, failed commands, refusals, unfinished steps): the lessons' input. */
  private failures: string[] = [];
  /** Scratch space of the built-in hooks for this conversation (what they already added). */
  private hookState = new Map<string, unknown>();
  /** Why the next SessionStart runs: a new conversation, or context rebuilt after compaction. */
  private sessionSource: "startup" | "compact" = "startup";
  /** allow / ask decisions of PreToolUse hooks, by tool call id, read by requestApproval. */
  private hookPermission = new Map<string, NonNullable<HookResult["permission"]>>();
  /** Calls whose hook "ask" the user already approved; their own cards don't ask again. */
  private hookApproved = new Set<string>();
  /** Working window of this conversation, in tokens. */
  private budget = 200_000;
  private window = 200_000;
  private systemPrompt = "";
  /** Fixed across model handoffs and restored sessions; only message-level effort may change. */
  private topEffort: Effort | null = null;
  private turnEffort: Effort = "low";
  private resumeBudget: AutoResumeState = createAutoResumeState(randomUUID());
  private originalTask = "";
  /** History length the current turn rolls back to (moved after a mid-task compaction). */
  private turnStart: number | null = null;
  private pendingApprovals = new Map<string, { resolve: (o: ApprovalOutcome) => void; subject: ApprovalSubject; humanOnly: boolean; createdAt: number }>();
  private pendingQuestions = new Map<string, { resolve: (r: QuestionResponse) => void; intro?: string; questions: AskQuestion[]; createdAt: number }>();
  /** Full before/after of recent file changes, for "compare in the editor" (newest 100). */
  private diffSources = new Map<string, { path: string; before: string; after: string }>();
  /** Facts the model must learn on the next message (undos, interrupted turns). */
  private notes: string[] = [];
  private readonly readTracker = new ReadTracker();
  private readonly checkpoints = new CheckpointStore();

  private readonly deps: SessionDeps;
  constructor(deps: SessionDeps) { this.deps = deps; }

  /** Called at the human-send boundary, not for quota or internal continuation messages. */
  beginTask(): void {
    this.resumeBudget = createAutoResumeState(randomUUID());
    this.originalTask = "";
  }

  autoResumeState(): AutoResumeState { return { ...this.resumeBudget }; }

  async claimAutoResume(): Promise<boolean> {
    const claimed = claimAutoResume(this.resumeBudget);
    if (!claimed) this.markNeedsReview();
    // Persist before another model call; reload cannot silently reset the task budget.
    await this.save(true);
    return claimed;
  }

  private markNeedsReview(): void {
    this.resumeBudget.needsReview = true;
    this.emit({ type: "error", message: AUTO_RESUME_REVIEW_REASON });
    this.deps.onNeedsReview?.(AUTO_RESUME_REVIEW_REASON, this.resumeBudget.count, this.id, this.dispatchJobId);
  }

  automaticResumeRequest(text: string): ChatRequest {
    return { text, editor: {}, effort: "medium", autopilot: this.autopilot, lazy: this.lazy, orchestrate: this.orchestrate };
  }

  get sessionId(): string {
    return this.id;
  }

  /** The cursor of the last event sent, without cloning anything (mobileSnapshot's eventCursor). */
  get mobileCursor(): number {
    return this.mobileEventCursor;
  }

  /** Send an event to the window, and remember it for the saved transcript. */
  private emit(e: AgentEvent): void {
    const cursor = ++this.mobileEventCursor;
    this.mobileEventHistory.push({ cursor, event: structuredClone(e) });
    if (this.mobileEventHistory.length > 5000) this.mobileEventHistory.shift();
    this.deps.emit(e);
    this.record(e);
  }

  private record(e: AgentEvent): void {
    if (e.type === "turn_undone") {
      // Belongs to the reply that made those changes, wherever it is in the conversation.
      const item = this.transcript.find(
        (t) => t.role === "ai" && t.events.some((x) => x.type === "turn_changes" && x.turnId === e.turnId),
      );
      if (item?.role === "ai") item.events.push(e);
      return;
    }
    if (!RECORDED.has(e.type)) return;
    const item = this.transcript[this.transcript.length - 1];
    if (item?.role !== "ai") return;
    const last = item.events[item.events.length - 1];
    // Merge streamed pieces so a saved conversation stays small.
    if (last && last.type === e.type && (e.type === "text_delta" || e.type === "thinking_delta")) {
      (last as { text: string }).text += e.text;
    } else if (last?.type === "command_output" && e.type === "command_output" && last.id === e.id) {
      last.chunk = (last.chunk + e.chunk).slice(-20_000);
    } else {
      item.events.push({ ...e });
    }
  }

  /** Warn in the log when a request that should have reused the cache did not. */
  /** History hashes sent with the last request, when it was sent, and whether the provider ever reported a cache read. */
  private prefixHashes: string[] = [];
  private lastRequestAt = 0;
  private cacheSeen = false;
  /** Where the history was rewritten before this request (-1: it wasn't), for checkCache to explain a miss. */
  private prefixBreak = -1;

  /** The history was replaced on purpose (new conversation, compaction): nothing is cached to compare with. */
  private forgetCache(): void {
    this.lastPromptTokens = 0;
    this.prefixHashes = [];
    this.prefixBreak = -1;
  }

  /**
   * Before a request: the history sent last time must still be the start of this one. Memory and
   * other context are only appended (memory-design/c-tier-memory.md, section 2); an entry changed
   * in place would break the cache from that point on.
   */
  private checkPrefix(history: HistoryEntry[]): void {
    const hashes = history.map(entryHash);
    const n = Math.min(this.prefixHashes.length, hashes.length);
    this.prefixBreak = -1;
    for (let i = 0; i < n; i++) {
      if (this.prefixHashes[i] !== hashes[i]) {
        this.prefixBreak = i;
        console.warn(`[cache] history entry ${i + 1} (${history[i].role}) changed since the last request in session ${this.id}`);
        break;
      }
    }
    this.prefixHashes = hashes;
  }

  /** After a request: did it read the cache as it should have? Reported to the status bar. */
  private checkCache(u: { input: number; cacheRead: number; cacheWrite: number }): void {
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    const now = Date.now();
    const previous = this.lastPromptTokens;
    const idle = this.lastRequestAt ? now - this.lastRequestAt : 0;
    this.lastRequestAt = now;
    // Some providers report no usage at all; nothing to judge then.
    if (prompt === 0) return;
    if (u.cacheRead > 0) this.cacheSeen = true;
    this.lastPromptTokens = prompt;
    let verdict: "first" | "hit" | "expired" | "partial" | "miss" | "unknown";
    if (previous < MIN_CACHEABLE) verdict = "first";
    else if (u.cacheRead >= previous * HIT_SHARE) verdict = "hit";
    else if (idle > CACHE_TTL_MS) verdict = "expired";
    // A provider that has never reported a cache read may simply not report it.
    else if (!this.cacheSeen) verdict = "unknown";
    else verdict = u.cacheRead === 0 ? "miss" : "partial";
    let cause: string | undefined;
    if (verdict === "partial" || verdict === "miss") {
      cause =
        this.prefixBreak >= 0
          ? `对话历史第 ${this.prefixBreak + 1} 条在发出后被改动了`
          : "历史没有被改动；可能是系统提示词或工具变了、换了模型或思考深度，或者服务商这次没有命中缓存";
      console.warn(`[cache] ${verdict} in session ${this.id}: previous prompt ${previous} tokens, read ${u.cacheRead}. ${cause}`);
    }
    this.emit({ type: "cache_check", verdict, read: u.cacheRead, previous, ...(cause ? { cause } : {}) });
  }


  get busy(): boolean {
    return this.controller !== null;
  }

  /** A cloned read-only view for authenticated mobile clients; private session objects never escape. */
  mobileSnapshot(): AgentMobileSnapshot {
    const transcript = structuredClone(this.transcript.slice(-50));
    return {
      sessionId: this.id,
      eventCursor: this.mobileEventCursor,
      title: this.title,
      busy: this.busy,
      turnId: this.turnCounter,
      task: this.task,
      plan: structuredClone(this.plan),
      transcript,
      events: structuredClone(this.mobileEventHistory),
      pendingApprovals: [...this.pendingApprovals].map(([id, pending]) => ({ id, subject: structuredClone(pending.subject), humanOnly: pending.humanOnly, createdAt: pending.createdAt })),
      pendingQuestions: [...this.pendingQuestions].map(([id, pending]) => ({ id, ...(pending.intro ? { intro: pending.intro } : {}), questions: structuredClone(pending.questions), createdAt: pending.createdAt })),
    };
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** leave: the user moves on from this conversation, so its c2 summary is brought up to date. */
  reset(leave = true): void {
    this.cancel();
    if (leave) this.summarizeLater("leave", LEAVE_TURNS);
    this.adapter = null;
    this.provider = null;
    this.registry = null;
    this.toolDefs = [];
    this.target = undefined;
    this.pendingSwitch = null;
    this.id = randomUUID();
    this.title = "";
    this.createdAt = Date.now();
    this.transcript = [];
    this.mobileEventCursor = 0;
    this.mobileEventHistory = [];
    this.forgetCache();
    this.turnCounter = 0;
    this.summaryTurn = 0;
    this.snapshotSent = false;
    this.autoApprove = false;
    this.autopilot = false;
    this.lazy = false;
    this.orchestrate = false;
    this.plan = [];
    this.topEffort = null;
    this.turnEffort = "low";
    this.beginTask();
    this.hookState = new Map();
    this.sessionSource = "startup";
    this.notes = [];
    this.mobileOrigin = undefined;
    this.readTracker.clear();
    this.checkpoints.clear();
  }

  /** The full texts behind a file change card, while this session still has them. */
  diffSource(id: string): { path: string; before: string; after: string } | null {
    return this.diffSources.get(id) ?? null;
  }

  answerQuestion(r: QuestionResponse): void {
    const pending = this.pendingQuestions.get(r.id);
    if (!pending) return;
    this.pendingQuestions.delete(r.id);
    this.emit({ type: "question_answered", id: r.id, answers: r.answers, usedDefaults: r.usedDefaults });
    pending.resolve(r);
  }

  respondApproval(r: ApprovalResponse): void {
    const pending = this.pendingApprovals.get(r.id);
    if (!pending) return;
    this.pendingApprovals.delete(r.id);
    const invalidBulkApproval = pending.humanOnly && r.decision === "approve_all";
    if (r.decision === "approve_all" && !pending.humanOnly) this.autoApprove = true;
    const approved = r.decision !== "reject" && !invalidBulkApproval;
    this.emit({ type: "approval_result", id: r.id, approved });
    pending.resolve(approved ? { approved: true } : { approved: false, feedback: invalidBulkApproval ? "这类撤不回的操作必须逐条确认；本次按拒绝处理。" : r.feedback });
  }

  async undoTurn(turnId: number): Promise<UndoResult> {
    if (this.busy) throw new Error("AI 还在工作，等它停下再撤销");
    const result = await this.checkpoints.undo(turnId, (path, content) => {
      // The model's view of this file is out of date now; make it read again before editing.
      this.readTracker.forget(path);
      this.emit({ type: "file_changed", path, content, created: false });
    });
    if (result.restored.length) {
      this.notes.push(
        `用户撤销了你之前对这些文件的修改，它们已恢复到修改前的样子：${result.restored.join("、")}。再改这些文件之前请重新读取。`,
      );
    }
    this.emit({ type: "turn_undone", turnId, result });
    await this.save();
    return result;
  }

  async send(req: ChatRequest): Promise<void> {
    if (this.busy) throw new Error("上一条消息还在处理中");
    this.mobileEventHistory = [];
    const controller = new AbortController();
    this.controller = controller;
    const turnId = ++this.turnCounter;
    let adapter: ModelAdapter | null = null;
    // null until the user message is about to go in: an earlier failure has nothing to roll back.
    this.turnStart = null;
    let snapshotWasSent = this.snapshotSent;
    const notesUsed = this.notes;
    this.notes = [];
    this.orchestrate = !!req.orchestrate;
    this.lazy = !!req.lazy || this.orchestrate;
    this.autopilot = !!req.autopilot || this.lazy;
    this.originalTask ||= req.text;
    this.task = this.originalTask;
    this.mobileOrigin = req.origin;
    this.recent = [];
    this.failures = [];

    // Undo the turn in the conversation history only; files stay as they are.
    const rollback = () => {
      // this.adapter, not the one the turn started on: a failover may have replaced it.
      if (this.turnStart !== null) this.adapter?.rollback(this.turnStart);
      this.snapshotSent = snapshotWasSent;
      this.notes = [...notesUsed, ...this.notes];
      const files = this.checkpoints.files(turnId);
      if (files.length) {
        this.notes.push(
          `上一条消息没有处理完就中断了，但其中这些文件已经按你的修改写入了：${files.map((f) => f.path).join("、")}。` +
            "如果要接着改，先重新读取它们。",
        );
        files.forEach((f) => this.readTracker.forget(f.path));
      }
    };

    if (!this.title) this.title = (req.text.trim().split("\n")[0] || req.files?.[0]?.name || "").slice(0, 40);
    this.transcript.push(
      {
        role: "user",
        text: req.text,
        createdAt: Date.now(),
        ...(req.origin ? { source: { kind: "mobile" as const, deviceName: req.origin.deviceName } } : {}),
        ...(req.thumbs?.length ? { images: req.thumbs } : {}),
        ...(req.files?.length ? { files: req.files.map((f) => ({ name: f.name, size: f.size })) } : {}),
      },
      { role: "ai", events: [], createdAt: Date.now() },
    );

    try {
      await this.routeFor(req, controller.signal);
      if (!this.adapter) this.adopt(this.deps.makeAdapter(undefined, this.target));
      adapter = this.adapter!; // set by adopt() just above
      const input = this.routeInput(req);
      const settings = this.deps.routingSettings?.();
      this.turnEffort = selectEffort(this.deps.purpose ?? effortPurpose(input), settings?.effort,
        settings?.difficulty.enabled ? classify(input) : null, req.effortOverride);
      // The window filled up during the last turn: compress before the new message goes in.
      if (!adapter.nativeCompaction && adapter.promptTokens() >= this.budget) {
        await this.compactNow(adapter, false, req.text, controller.signal);
        snapshotWasSent = this.snapshotSent;
      }
      const vision = req.images?.length ? await this.readImages(req, controller.signal) : "";
      this.turnStart = adapter.checkpoint();
      adapter.addUserText(await this.userParts(req, notesUsed, vision, controller.signal), this.applyEffort(adapter, req.effort));
      await this.loop(adapter, req, turnId, controller.signal, rollback);
    } catch (err) {
      rollback();
      if (controller.signal.aborted || err instanceof Cancelled || this.adapter?.isAbort(err)) {
        this.emit({ type: "done", reason: "cancelled", autopilot: this.autopilot });
      } else {
        this.deps.onTurnError?.(err);
        const message = this.adapter?.describeError(err) ?? (err instanceof Error ? err.message : String(err));
        this.emit({ type: "error", message });
      }
    } finally {
      fileLocks.release(`app:${this.id}`);
      this.pendingApprovals.clear();
      this.pendingQuestions.clear();
      this.controller = null;
      this.mobileOrigin = undefined;
      const files = this.checkpoints.files(turnId);
      if (files.length) this.emit({ type: "turn_changes", turnId, files });
      this.emit({ type: "status", state: "idle" });
      if (this.pendingSwitch) {
        const { reason, target } = this.pendingSwitch;
        this.pendingSwitch = null;
        try {
          this.handoff(reason, target);
        } catch (err) {
          this.emit({ type: "error", message: `换模型没成功，还在用原来的模型：${(err as Error).message}` });
        }
      }
      await this.save();
      this.summarizeLater("periodic", SUMMARY_EVERY);
    }
  }

  /**
   * In the background, summarize the conversation as it is now into its c2 summary, if at least
   * `after` turns went by since the last one. Uses a snapshot, so the conversation can move on (or be
   * reset) meanwhile; failures are only logged.
   */
  private summarizeLater(source: "periodic" | "leave", after: number): void {
    const save = this.deps.saveSummary;
    const adapter = this.adapter;
    const provider = this.provider;
    if (!save || !adapter || !provider || this.turnCounter - this.summaryTurn < after) return;
    const entries = adapter.history();
    if (entries.length < 2) return;
    const snap = { id: this.id, title: this.title || "新对话", turn: this.turnCounter, task: this.task, plan: this.plan, root: this.deps.root() };
    const changed = [...new Set(this.checkpoints.export().flatMap(([, files]) => files.map(([p]) => p)))];
    this.summaryTurn = this.turnCounter;
    void (async () => {
      try {
        const signal = AbortSignal.timeout(SUMMARY_TIMEOUT);
        const prompt = compressorPrompt({ entries, task: snap.task, plan: snap.plan, changedFiles: changed }, 60_000);
        const text = await this.deps.compress(SESSION_SUMMARY_SYSTEM, prompt, provider, signal);
        await save(snap.root, { id: snap.id, title: snap.title, turn: snap.turn, source, text });
      } catch (err) {
        console.warn("[c2] session summary failed:", (err as Error).message);
      }
    })();
  }

  /**
   * The history was summarized: the project overview, rules and memories that came with the first
   * message are gone. Send them again with the next message, plus the plan.
   */
  private contextLost(): void {
    this.snapshotSent = false;
    this.sessionSource = "compact";
    this.hookState.clear();
    if (this.plan.length) {
      const mark = { pending: "待做", in_progress: "进行中", done: "完成", skipped: "跳过" } as const;
      this.notes.push(`对话整理成摘要之前，你的计划是：\n${this.plan.map((i, n) => `${n + 1}. [${mark[i.status]}] ${i.text}`).join("\n")}`);
    }
  }

  /**
   * The window is full: the compression sub-agent summarizes the history, and it restarts from
   * that summary plus what the code knows for sure (task, plan, changed files).
   * midTurn: in the middle of a multi-step task, so the summary goes in right away together with
   * the project overview, rules and memories, and the next step carries on with the task.
   * Otherwise it goes with the next user message (which also brings the overview back).
   */
  private async compactNow(adapter: ModelAdapter, midTurn: boolean, task: string, signal: AbortSignal): Promise<void> {
    const before = adapter.promptTokens();
    this.emit({ type: "status", state: "compacting" });
    const changed = [...new Set(this.checkpoints.export().flatMap(([, files]) => files.map(([p]) => p)))];
    const input: CompactInput = { entries: adapter.history(), task: midTurn ? task : this.task, plan: this.plan, changedFiles: changed };
    let summary = "";
    try {
      // Fits any model whose window is at least the budget: even CJK text is about a token per character.
      summary = await this.deps.compress(COMPACTOR_SYSTEM, compressorPrompt(input, Math.floor(this.budget * 0.6)), this.provider!, signal);
    } catch (err) {
      if (signal.aborted) throw new Cancelled();
      console.warn("[compact] the compression sub-agent failed:", (err as Error).message);
    }
    // The compressor's summary doubles as this conversation's c2 summary, at no extra cost.
    if (summary && this.deps.saveSummary) {
      this.summaryTurn = this.turnCounter;
      void this.deps
        .saveSummary(this.deps.root(), { id: this.id, title: this.title || "新对话", turn: this.turnCounter, source: "compact", text: summary })
        .catch((err) => console.warn("[c2] could not save summary:", (err as Error).message));
    }
    const parts = [
      `<conversation_summary>\n上下文窗口用满了（约 ${Math.round(before / 1000)}K tokens），压缩助手把之前的工作整理成了这份摘要：\n${summary || fallbackSummary(input)}\n</conversation_summary>`,
      stateBlock(input),
    ];
    // Whatever the model had read is gone from its context: edits must read the file again.
    this.readTracker.clear();
    this.hookState.clear();
    if (midTurn) {
      const start = await this.hook("SessionStart", { source: "compact" }, signal);
      parts.push(
        await projectSnapshot(this.skills),
        ...start.context,
        `<note>\n刚才的任务还没做完，只是上下文被压缩了。根据上面的摘要和状态接着做，不要重复已经完成的步骤；要改文件之前先重新 read_file。\n</note>`,
      );
      adapter.restart(parts, true);
    } else {
      adapter.restart(parts, false);
      this.snapshotSent = false;
      this.sessionSource = "compact";
    }
    this.emit({ type: "context_trimmed", how: "compacted", tokens: before });
    // A fresh history can't be in the cache yet; don't report that as a miss.
    this.forgetCache();
    this.emit({ type: "status", state: midTurn ? "thinking" : "idle" });
  }

  /** Run the hooks of one event and show what they did in the chat. */
  private async hook(event: HookEventName, input: HookInput, signal: AbortSignal, activeFile?: string): Promise<HookResult> {
    const r = await this.deps.hooks.run(event, input, {
      root: this.deps.root(),
      sessionId: this.id,
      state: this.hookState,
      autopilot: this.autopilot,
      activeFile,
      signal,
    });
    for (const n of r.notices) this.emit({ type: "hook", event, ...n });
    return r;
  }

  private async save(strict = false): Promise<void> {
    // Nothing worth keeping until the provider was reached at least once.
    if (!this.adapter || !this.provider || this.transcript.length === 0) return;
    try {
      await this.deps.persist({
        version: 1,
        id: this.id,
        root: this.deps.root(),
        title: this.title || "新对话",
        createdAt: this.createdAt,
        updatedAt: Date.now(),
        provider: this.provider,
        adapterState: this.adapter.exportState(),
        toolDefs: this.toolDefs,
        snapshotSent: this.snapshotSent,
        turnCounter: this.turnCounter,
        notes: this.notes,
        readTracker: this.readTracker.export(),
        checkpoints: this.checkpoints.export(),
        plan: this.plan,
        topEffort: this.topEffort,
        autoResume: this.autoResumeState(),
        originalTask: this.originalTask,
        taskMode: { autopilot: this.autopilot, lazy: this.lazy, orchestrate: this.orchestrate },
        summaryTurn: this.summaryTurn,
        transcript: this.transcript,
      });
    } catch (err) {
      console.error("[session] could not save conversation:", err);
      if (strict) throw err;
    }
  }

  /** Routing by difficulty: move to the light or heavy model before the message goes out, when it's clear which. */
  private async routeFor(req: ChatRequest, signal: AbortSignal): Promise<void> {
    const input = this.routeInput(req);
    const level = classify(input);
    const explicit = level ? this.deps.route?.(level) : undefined;
    // Once a conversation exists, do not silently follow a different active provider.
    const current = this.target ?? (this.provider ? { providerId: this.provider.id, model: this.provider.model, auto: this.provider.auto } : undefined);
    const desired = explicit ?? current;
    this.autoRoutePurpose = autoPurpose(input, this.deps.purpose);
    const prepared = await this.deps.prepareModel?.(desired, this.autoRoutePurpose, signal);
    signal.throwIfAborted();
    const target = prepared ?? explicit;
    if (!target) return;
    if (this.provider && `${this.provider.id}:${this.provider.model}` === `${target.providerId}:${target.model ?? ""}`) {
      this.target = target;
      this.provider.auto = target.auto;
      return;
    }
    // Auto failures must surface instead of silently keeping an unresolved sentinel.
    if (prepared) { this.handoff("route", target); return; }
    try { this.handoff("route", target); }
    catch (err) { console.warn("[route] staying on the current model:", (err as Error).message); }
  }

  private routeInput(req: ChatRequest) {
    return {
      text: req.text,
      hasFiles: !!req.files?.length,
      hasImages: !!req.images?.length,
      planOpen: this.plan.some((p) => p.status === "pending" || p.status === "in_progress"),
      autopilot: this.autopilot,
    };
  }

  private applyEffort(adapter: ModelAdapter, fallback: Effort): Effort {
    const p = this.provider;
    if (!p || p.kind !== "anthropic" || p.compat || !supportsClaudeEffort(p.model)) return fallback;
    this.topEffort ??= this.turnEffort;
    adapter.setEffort?.(this.turnEffort, this.topEffort);
    return this.turnEffort;
  }

  /**
   * Continue this conversation on another model (target; none = the active provider's). Mid-turn
   * it happens when the turn ends. "fresh": nothing to hand over yet, the next message starts there.
   */
  switchModel(reason: SwitchReason, target?: ModelTarget): "now" | "later" | "fresh" {
    if (this.busy) {
      this.pendingSwitch = { reason, target };
      return "later";
    }
    const r = this.handoff(reason, target);
    if (r === "now") void this.save();
    return r;
  }

  /**
   * Hand the work so far to a new adapter as one record (agent/handoff.ts). Files whose content
   * made it into the record stay "read", so the new model can edit them without reading again.
   * midTurn: the record goes in as a user message right away and the turn carries on.
   */
  private handoff(reason: SwitchReason, target: ModelTarget | undefined, midTurn?: { why: string }): "now" | "fresh" {
    const old = this.adapter;
    const from = this.provider;
    const entries = old?.history() ?? [];
    if (!old || !from || entries.length === 0) {
      this.adapter = null;
      this.provider = null;
      this.registry = null;
      this.target = target;
      return "fresh";
    }
    const made = this.deps.makeAdapter(this.toolDefs, target);
    const record = handoffRecord(entries, Math.floor(made.contextBudget * 0.6 * CHARS_PER_TOKEN));
    const changed = [...new Set(this.checkpoints.export().flatMap(([, files]) => files.map(([p]) => p)))];
    const to = made.provider;
    const parts = [
      `<handoff>\n这段对话原来由 ${from.name}（${from.model}）在做，现在交给你（${to.name} · ${to.model}）接着做。` +
        "下面是到目前为止的完整工作记录。读过的文件内容都在里面：没有标“省略”的可以直接引用和修改，不用重新读取；标了省略的，要用时再 read_file。\n\n" +
        `${record.text}\n</handoff>`,
      stateBlock({ entries, task: this.task, plan: this.plan, changedFiles: changed }),
    ];
    if (midTurn) parts.push(`<note>\n上一个模型做到一半出了问题（${midTurn.why}），由你接着把当前任务做完，不要重复已经完成的步骤。\n</note>`);
    made.adapter.restart(parts, !!midTurn);
    this.adopt(made);
    this.target = target;
    const root = this.deps.root();
    for (const f of record.dropped) this.readTracker.forget(path.relative(root, path.resolve(root, f)).split(path.sep).join("/"));
    this.forgetCache();
    this.emit({
      type: "model_switched",
      from: `${from.name} · ${from.model}`,
      to: `${to.name} · ${to.model}`,
      reason,
      kept: record.kept,
      omitted: record.omitted,
      ...(midTurn ? { detail: midTurn.why } : {}),
    });
    return "now";
  }

  private adopt(made: MadeAdapter): void {
    this.adapter = made.adapter;
    this.provider = made.provider;
    this.registry = made.registry;
    this.toolDefs = made.toolDefs;
    this.skills = made.skills;
    this.budget = made.contextBudget;
    this.window = made.contextWindow;
    this.systemPrompt = made.systemPrompt;
  }

  /** What the context holds right now; null before the conversation started. */
  usage(): ContextUsage | null {
    const a = this.adapter;
    if (!a) return null;
    return contextUsage({
      system: this.systemPrompt,
      tools: this.toolDefs,
      history: a.history(),
      measured: a.promptTokens(),
      budget: this.budget,
      window: this.window,
    });
  }

  /** The user asked to compress now (status bar). Not while a turn runs. */
  async compactManually(): Promise<ContextUsage | null> {
    if (this.busy) throw new Error("AI 还在工作，等它停下再压缩");
    const adapter = this.adapter;
    if (!adapter || adapter.history().length < 2) throw new Error("对话还很短，不用压缩");
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.compactNow(adapter, false, this.task, controller.signal);
    } finally {
      this.controller = null;
      this.emit({ type: "status", state: "idle" });
    }
    await this.save();
    const u = this.usage();
    if (u) this.emit({ type: "context_usage", ...u });
    return u;
  }

  /**
   * Continue a saved conversation. Its history is in its own provider's format, so the adapter is
   * made for that provider (target, when it isn't the active one); switchModel can then move it.
   */
  restore(file: SessionFile, target?: ModelTarget): void {
    this.reset();
    this.summaryTurn = file.summaryTurn ?? 0;
    target = target ? { ...target, auto: file.provider.auto } : target;
    const made = this.deps.makeAdapter(file.toolDefs, target);
    this.target = target;
    made.adapter.importState(file.adapterState);
    this.adopt(made);
    this.id = file.id;
    this.title = file.title;
    this.createdAt = file.createdAt;
    this.snapshotSent = file.snapshotSent;
    this.turnCounter = file.turnCounter;
    this.notes = file.notes;
    this.readTracker.import(file.readTracker);
    this.checkpoints.import(file.checkpoints);
    this.plan = file.plan ?? [];
    const savedEffort = file.topEffort ?? (file.adapterState as { topEffort?: unknown } | null)?.topEffort;
    this.topEffort = isEffort(savedEffort) ? savedEffort : null;
    this.resumeBudget = normalizeAutoResumeState(file.autoResume, file.id);
    this.originalTask = file.originalTask ?? "";
    this.autopilot = !!file.taskMode?.autopilot;
    this.lazy = !!file.taskMode?.lazy;
    this.orchestrate = !!file.taskMode?.orchestrate;
    this.transcript = file.transcript;
  }

  /**
   * Have the vision model read the attached images. The agent gets the analysis as text; if
   * reading fails it is told that too, so it doesn't answer as if there were no images.
   */
  private async readImages(req: ChatRequest, signal: AbortSignal): Promise<string> {
    const count = req.images!.length;
    this.emit({ type: "vision", state: "start", model: "", count });
    try {
      const { text, model } = await this.deps.analyzeImages(req.images!, req.text, signal);
      this.emit({ type: "vision", state: "done", model, count, text });
      return `<image_analysis>\n用户发了 ${count} 张图片。你看不到图片本身，下面是识图模型（${model}）对它们的分析：\n${text}\n</image_analysis>`;
    } catch (err) {
      if (signal.aborted) throw err;
      const message = (err as Error).message;
      this.emit({ type: "vision", state: "error", model: "", count, text: message });
      return `<image_analysis>\n用户发了 ${count} 张图片，但识图失败了：${message}\n告诉用户你没能看到图片，并说明原因。\n</image_analysis>`;
    }
  }

  private async userParts(req: ChatRequest, notes: string[], vision: string, signal: AbortSignal): Promise<string[]> {
    const parts: string[] = [];
    if (!this.snapshotSent) {
      const start = await this.hook("SessionStart", { source: this.sessionSource }, signal);
      parts.push(await projectSnapshot(this.skills), ...start.context);
      this.snapshotSent = true;
      this.sessionSource = "startup";
    }
    const submit = await this.hook("UserPromptSubmit", { prompt: req.text }, signal, req.editor.activeFile);
    if (submit.block) throw new Error(`这条消息被 Hook 拦下了：${submit.block.reason}`);
    if (notes.length) parts.push(`<note>\n${notes.join("\n")}\n</note>`);
    if (this.autopilot) parts.push(AUTOPILOT_NOTE);
    if (this.lazy) parts.push(LAZY_NOTE);
    if (this.orchestrate) parts.push(ORCHESTRATE_NOTE);
    const editor = editorContextText(req.editor);
    if (editor) parts.push(editor);
    parts.push(...submit.context);
    if (vision) parts.push(vision);
    for (const f of req.files ?? []) {
      const cut = f.truncated ? "\n（文件太长，后面的部分没有附上。需要的话请用户分段发送。）" : "";
      parts.push(`<attached_file name="${f.name.replace(/"/g, "'")}">\n${f.text}${cut}\n</attached_file>`);
    }
    parts.push(wrapPastedContent(req.text, req.pastedContent) || (req.files?.length ? "（用户只发了文件）" : "（用户只发了图片）"));
    return parts;
  }

  private async loop(
    adapter: ModelAdapter,
    req: ChatRequest,
    turnId: number,
    signal: AbortSignal,
    rollback: () => void,
  ) {
    let stopContinues = 0;
    const maxSteps = this.autopilot ? AUTOPILOT_STEPS : MAX_STEPS;
    // Models this turn has run on: a failover never goes back to one of them.
    const unavailableAutoProviders = new Set<string>();
    const tried = new Set(this.provider ? [`${this.provider.id}:${this.provider.model}`] : []);
    for (let step = 0; step < maxSteps; step++) {
      this.emit({ type: "status", state: "thinking" });
      // Tool calls being written in this step, by id (see onToolStart / onToolInput).
      const previews = new Map<string, { name: string; args: string; at: number }>();

      this.checkPrefix(adapter.history());
      const call = (a: ModelAdapter) => a.step(
        { effort: this.applyEffort(a, req.effort), signal },
        {
          onText: (text) => this.emit({ type: "text_delta", text }),
          onThinking: (text) => this.emit({ type: "thinking_delta", text }),
          onToolStart: (id, name) => {
            previews.set(id, { name, args: "", at: 0 });
            this.emit({ type: "tool_preview", id, name, partial: "" });
          },
          onToolInput: (id, chunk) => {
            const p = previews.get(id);
            if (!p) return;
            p.args += chunk;
            // Throttled: a long edit streams hundreds of pieces; the card needs only a few updates a second.
            const now = Date.now();
            if (now - p.at < PREVIEW_INTERVAL_MS) return;
            p.at = now;
            this.emit({ type: "tool_preview", id, name: p.name, partial: p.args.slice(-PREVIEW_CHARS) });
          },
        },
      );
      let res: Awaited<ReturnType<ModelAdapter["step"]>>;
      for (;;) {
        try {
          res = await call(adapter);
          if (this.provider) recordSuccess(this.provider.id);
          break;
        } catch (err) {
          // The model failed in a way another one wouldn't (rate limit, quota, outage, bad key):
          // hand the turn to the next backup and redo this step there.
          const why = signal.aborted ? null : failoverReason(err);
          if (why && this.provider) recordFailure(this.provider.id, err);
          if (why && this.provider?.builtinFree && this.provider.auto && providerWideFailure(err))
            unavailableAutoProviders.add(this.provider.id);
          const next = why ? this.deps.failover?.(this.provider ?? undefined, this.target, err, this.autoRoutePurpose).find((t) => !unavailableAutoProviders.has(t.providerId) && !tried.has(`${t.providerId}:${t.model ?? ""}`)) : undefined;
          if (!why || !next || !this.provider) throw err;
          tried.add(`${next.providerId}:${next.model ?? ""}`);
          this.handoff("failover", next, { why: `${this.provider.name} · ${this.provider.model}：${why}` });
          adapter = this.adapter!;
          this.turnStart = adapter.checkpoint();
        }
      }
      this.emit({ type: "usage", ...res.usage });
      if (this.provider) reportUsage({ providerId: this.provider.id, providerName: this.provider.name, model: this.provider.model }, res.usage);
      const u = this.usage();
      if (u) this.emit({ type: "context_usage", ...u });
      this.checkCache(res.usage);
      if (res.trimmed) {
        this.emit({ type: "context_trimmed", ...res.trimmed });
        this.forgetCache();
        if (res.trimmed.how === "compacted") this.contextLost();
      }

      switch (res.stop) {
        case "refusal":
          rollback();
          this.emit({ type: "done", reason: "refusal" });
          return;
        case "max_tokens":
          // A tool call cut off mid-input never runs; the adapter did not keep it.
          if (res.toolCalls.length) throw new Error("这次回答太长，被截断了。换个更小的问题再试一次吧。");
          this.emit({ type: "error", message: "回答太长，后面被截断了。可以说「继续」让我接着讲。" });
          return;
        case "continue":
          continue;
        case "end_turn": {
          // A Stop hook can send the agent back to work (e.g. "tests still fail").
          const stop = await this.hook("Stop", { stop_hook_active: stopContinues > 0 }, signal);
          if (stop.block) {
            if (!await this.claimAutoResume()) return;
            stopContinues++;
            this.noteFailure(`收工时 Hook 要求继续：${stop.block.reason}`);
            adapter.addUserText([`<hook_feedback>\n用户配置的 Hook 要求你继续：${stop.block.reason}\n</hook_feedback>`], this.applyEffort(adapter, req.effort));
            continue;
          }
          // A long task that stops with steps still open is sent back to finish them, a couple of times at most.
          const open = this.plan.filter((i) => i.status === "pending" || i.status === "in_progress");
          if (this.autopilot && open.length) {
            if (!await this.claimAutoResume()) return;
            this.noteFailure(`收工时计划里还有没做完的步骤：${open.map((i) => i.text).join("；")}`);
            adapter.addUserText(
              [
                `<note>\n计划里还有没做完的步骤：${open.map((i) => i.text).join("；")}。用户开了长任务模式，不在电脑前，` +
                  "继续处理剩余步骤；卡住时说明具体阻碍，并用 update_plan 标成 skipped。\n</note>",
              ],
              this.applyEffort(adapter, req.effort),
            );
            continue;
          }
          await this.learn(signal);
          this.emit({ type: "done", reason: "end_turn", autopilot: this.autopilot });
          return;
        }
        case "tool_use":
          break;
      }

      this.emit({ type: "status", state: "running_tools" });
      const results = await this.runTools(res.toolCalls, turnId, signal);
      if (signal.aborted) throw new Cancelled();
      adapter.addToolResults(results);
      // Many steps in one task: check the window after every tool round, not only between messages.
      if (!adapter.nativeCompaction) {
        const added = Math.ceil(results.reduce((n, r) => n + r.content.length, 0) / 3);
        if (adapter.promptTokens() + added >= this.budget) {
          await this.compactNow(adapter, true, req.text, signal);
          this.turnStart = adapter.checkpoint();
        }
      }
    }

    this.noteFailure(`用完了 ${maxSteps} 步，任务还没做完`);
    await this.learn(signal);
    this.emit({ type: "done", reason: "step_limit", autopilot: this.autopilot });
  }

  /** Note something that went wrong in this turn. Only the autonomous run's lessons read these. */
  private noteFailure(text: string): void {
    if (this.failures.length < MAX_FAILURES) this.failures.push(text.trim().slice(0, MAX_FAILURE_CHARS));
  }

  /**
   * A long task submitted its result (or ran out of steps) after failures along the way: they become
   * lessons for this project, so the next conversation here starts knowing them. Never fails the turn.
   */
  private async learn(signal: AbortSignal): Promise<void> {
    const root = this.deps.root();
    if (!this.autopilot || this.failures.length === 0 || !root || !this.provider) return;
    try {
      const saved = await this.deps.learn(
        { root, task: this.task, plan: this.plan, failures: this.failures, answer: this.turnAnswer() },
        this.provider,
        signal,
      );
      for (const { item, updated } of saved) {
        this.emit({ type: "memory_saved", id: item.id, text: item.text, scope: item.scope, updated, lesson: true });
      }
    } catch (err) {
      if (signal.aborted) return;
      console.warn("[lessons] could not learn from this run:", (err as Error).message);
    }
  }

  /** The reply of this turn so far. Its end is the final summary. */
  private turnAnswer(): string {
    const item = this.transcript[this.transcript.length - 1];
    if (item?.role !== "ai") return "";
    return item.events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("").slice(-1500);
  }

  private context(callId: string, permission: Permission, turnId: number, signal: AbortSignal): ToolContext {
    return {
      callId,
      signal,
      readTracker: this.readTracker,
      lockOwner: `app:${this.id}`,
      dispatchJobId: this.dispatchJobId,
      guardWrite: (abs) => this.writeGuard?.(abs) ?? null,
      requestApproval: (req) => this.requestApproval(callId, permission, req, signal),
      commandOutput: (chunk) => this.emit({ type: "command_output", id: callId, chunk }),
      commandDone: (exitCode, timedOut) => {
        this.emit({ type: "command_done", id: callId, exitCode, timedOut });
        this.emit({ type: "workspace_changed" });
      },
      recordWrite: (path, before, after) => {
        this.checkpoints.record(turnId, path, before, after);
        this.emit({ type: "file_changed", path, content: after, created: before === null });
      },
      updatePlan: (items) => {
        this.plan = items;
        this.emit({ type: "plan", items });
      },
      emit: (e) => this.emit(e),
      noteFailure: (text) => this.noteFailure(text),
      askUser: (intro, questions) => {
        if (signal.aborted) return Promise.reject(new Cancelled());
        // Long-task mode too: these are the user's choices to make, not the reviewer's.
        this.emit({ type: "question", id: callId, ...(intro ? { intro } : {}), questions });
        // Lazy mode: nobody is there to answer, so the recommendations stand.
        if (this.lazy) {
          const answers = questions.map((q) => ({ id: q.id, choices: [(q.options.find((o) => o.recommended) ?? q.options[0]).label] }));
          this.emit({ type: "question_answered", id: callId, answers, usedDefaults: true });
          return Promise.resolve({ answers, usedDefaults: true });
        }
        return new Promise((resolve, reject) => {
          this.pendingQuestions.set(callId, { resolve: (r) => resolve({ answers: r.answers, usedDefaults: r.usedDefaults }), ...(intro ? { intro } : {}), questions: structuredClone(questions), createdAt: Date.now() });
          signal.addEventListener(
            "abort",
            () => {
              this.pendingQuestions.delete(callId);
              reject(new Cancelled());
            },
            { once: true },
          );
        });
      },
    };
  }

  private async requestApproval(
    id: string,
    permission: Permission,
    req: ApprovalRequest,
    signal: AbortSignal,
    /** The card's own id, when one tool call shows more than one card (a hook's, then its own). */
    card = id,
  ): Promise<ApprovalOutcome> {
    const humanOnly = (req.kind === "command" && HUMAN_ONLY.test(req.command)) || (req.kind === "tool" && !!req.humanOnly);
    // A PreToolUse hook may approve (never for push/publish) or insist that the user decides.
    const byHook = this.hookPermission.get(id);
    // The user already said yes to this very call on the hook's card.
    if (this.hookApproved.has(id) && !humanOnly) return { approved: true };
    // "Approve all" covers file edits only; always_confirm tools (commands) ask every time.
    // It never overrides a human-only action or a hook that asks for the user.
    let auto = this.autoApprove && permission === "confirm" && !humanOnly && byHook?.decision !== "ask";
    if (byHook?.decision === "allow" && !humanOnly) auto = true;
    // Lazy mode: everything goes through by itself, except what it refuses outright.
    const remoteApproval = this.mobileOrigin?.kind === "mobile" && !!this.deps.mobileOnline?.();
    const remoteHumanApproval = humanOnly && remoteApproval;
    const lazyStop = this.lazy ? lazyRefusal(req, humanOnly && !remoteHumanApproval) : "";
    if (this.lazy && !lazyStop && byHook?.decision !== "ask" && !remoteHumanApproval) auto = true;
    const reviewing = this.autopilot && !auto && byHook?.decision !== "ask" && !remoteHumanApproval;
    if (req.kind === "file") {
      if (this.diffSources.size >= 100) this.diffSources.delete(this.diffSources.keys().next().value!);
      this.diffSources.set(card, { path: req.path, before: req.before, after: req.after });
    }
    const subject: ApprovalSubject =
      req.kind === "file"
        ? {
            kind: "file",
            change: { path: req.path, created: req.created, explanation: req.explanation, ...diffLines(req.before, req.after) },
          }
        : req.kind === "command"
          ? { kind: "command", command: { command: req.command, explanation: req.explanation, warning: req.warning } }
          : { kind: "tool", call: { server: req.server, tool: req.tool, description: req.description, args: req.args } };
    this.emit({ type: "approval_request", id: card, autoApproved: auto, subject, ...(reviewing ? { reviewing: true } : {}), ...(humanOnly ? { humanOnly: true } : {}) });
    if (auto) {
      this.emit({ type: "approval_result", id: card, approved: true });
      return { approved: true };
    }
    if (signal.aborted) throw new Cancelled();
    if (reviewing) {
      const verdict = lazyStop
        ? { decision: "reject" as const, reason: lazyStop, model: "" }
        : humanOnly
        ? {
            decision: "ask_human" as const,
            reason: (req.kind === "tool" && req.humanOnly) || "推送、发布和部署会让别人看到，撤不回来，这种操作要你亲自点头。",
            model: "",
          }
        : await this.review(req, signal);
      this.emit({ type: "review", id: card, ...verdict });
      if (verdict.decision === "approve") {
        this.emit({ type: "approval_result", id: card, approved: true });
        return { approved: true };
      }
      if (verdict.decision === "reject") {
        this.emit({ type: "approval_result", id: card, approved: false });
        this.noteFailure(`审批小助手拦下了${actionName(req)}：${verdict.reason}`);
        return {
          approved: false,
          feedback: lazyStop
            ? `（懒人模式自动拦下的，用户不在）${lazyStop}。不要换个写法绕过去：能用只在项目文件夹里的做法就换一种，不能就跳过这一步，在总结里告诉用户需要他自己做。`
            : `（这是审批小助手代替用户给的意见）${verdict.reason}`,
        };
      }
      // ask_human: the card waits for the user like any other.
    }
    const outcome = await this.waitForUser(card, signal, subject, humanOnly, remoteApproval ? 10 * 60_000 : 0);
    if (!outcome.approved) this.noteFailure(`用户拒绝了${actionName(req)}${outcome.feedback ? `：${outcome.feedback}` : ""}`);
    return outcome;
  }

  /** The reviewer's verdict; when it fails, the action goes to the user instead. */
  private async review(request: ApprovalRequest, signal: AbortSignal): Promise<ReviewVerdict & { model: string }> {
    try {
      return await this.deps.review({ task: this.task, plan: this.plan, recent: this.recent, request }, this.provider!, signal);
    } catch (err) {
      if (signal.aborted) throw new Cancelled();
      const message = this.adapter?.describeError(err) ?? (err as Error).message;
      return { decision: "ask_human", reason: `审批小助手出错了（${message}），这一步请你来决定。`, model: "" };
    }
  }

  private waitForUser(id: string, signal: AbortSignal, subject: ApprovalSubject, humanOnly: boolean, timeoutMs = 0): Promise<ApprovalOutcome> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        if (!this.pendingApprovals.has(id)) return;
        this.pendingApprovals.delete(id);
        this.emit({ type: "approval_result", id, approved: false });
        resolve({ approved: false, feedback: "手机确认超时，已按拒绝处理。" });
      }, timeoutMs) : undefined;
      this.pendingApprovals.set(id, { resolve: (outcome) => { if (timer) clearTimeout(timer); resolve(outcome); }, subject, humanOnly, createdAt: Date.now() });
      signal.addEventListener(
        "abort",
        () => {
          if (timer) clearTimeout(timer);
          this.pendingApprovals.delete(id);
          reject(new Cancelled());
        },
        { once: true },
      );
    });
  }

  private async runTools(calls: ToolCall[], turnId: number, signal: AbortSignal): Promise<ToolResult[]> {
    const runOne = async (call: ToolCall): Promise<ToolResult> => {
      const tool = this.registry?.get(call.name);
      const fail = (message: string): ToolResult => {
        this.emit({ type: "tool_end", id: call.id, ok: false, preview: message });
        if (!signal.aborted) this.noteFailure(`${call.name}：${message}`);
        return { id: call.id, content: message, isError: true };
      };
      if (!tool) {
        this.emit({ type: "tool_start", id: call.id, name: call.name, summary: call.name });
        return fail(`Unknown tool: ${call.name}`);
      }
      const parsed = tool.schema.safeParse(call.input);
      const summary = parsed.success ? tool.summarize(parsed.data) : call.name;
      this.emit({ type: "tool_start", id: call.id, name: call.name, summary });
      this.recent.push(summary);
      if (call.input === undefined) return fail(`The arguments for ${call.name} were not valid JSON. Try the call again.`);
      if (!parsed.success) return fail(`Invalid input for ${call.name}: ${parsed.error.message}`);
      if (signal.aborted) return fail("Cancelled by the user.");
      // The coordinator's context is for coordinating: what it would do itself goes to a sub-agent.
      if (this.orchestrate && HANDS_ON.has(call.name)) return fail("超级调度模式下你只调度不动手：把这一步写成任务，用 send_to_agent 派给子代理。");
      try {
        const pre = await this.hook("PreToolUse", { tool_name: call.name, tool_input: parsed.data }, signal);
        if (pre.permission?.decision === "deny") {
          return fail(`A hook configured by the user blocked this call: ${pre.permission.reason || "no reason given"}. Do not retry it as is.`);
        }
        if (pre.permission) this.hookPermission.set(call.id, pre.permission);
        // A hook that asks is answered here, once, before the tool runs: whether the tool would
        // show a card itself can change at run time (an MCP server trusted mid-session, a fetch
        // that only sometimes asks). The tool's own cards then pass, except human-only ones.
        if (pre.permission?.decision === "ask") {
          const outcome = await this.requestApproval(
            call.id,
            "always_confirm",
            { kind: "tool", server: "Hook", tool: call.name, description: pre.permission.reason || summary, args: JSON.stringify(parsed.data, null, 2) },
            signal,
            `${call.id}:hook`,
          );
          if (!outcome.approved) {
            return fail(outcome.feedback?.trim() ? `The user declined this call and said: "${outcome.feedback.trim()}".` : "The user declined this call.");
          }
          this.hookApproved.add(call.id);
        }
        let out = await tool.run(parsed.data, this.context(call.id, tool.permission, turnId, signal));
        if (out.length > MAX_TOOL_RESULT_CHARS) out = out.slice(0, MAX_TOOL_RESULT_CHARS) + "\n…（输出太长，已截断）";
        const post = await this.hook("PostToolUse", { tool_name: call.name, tool_input: parsed.data, tool_response: out.slice(0, 20_000), is_error: false }, signal);
        if (post.context.length) out += `\n\n${post.context.join("\n")}`;
        // A hook may have changed files (a formatter after an edit): refresh the editor.
        if (post.commands) this.emit({ type: "workspace_changed" });
        this.emit({ type: "tool_end", id: call.id, ok: true, preview: out.slice(0, 400) });
        return { id: call.id, content: out, isError: false };
      } catch (err) {
        return fail(err instanceof Cancelled ? "Cancelled by the user." : (err as Error).message);
      } finally {
        this.hookPermission.delete(call.id);
        this.hookApproved.delete(call.id);
      }
    };

    // Read-only tools run together; anything else (edits) runs one at a time, in order.
    const results = new Array<ToolResult>(calls.length);
    const parallelSafe = (c: ToolCall): boolean => {
      const safe = this.registry?.get(c.name)?.parallelSafe;
      if (typeof safe !== "function") return !!safe;
      const parsed = this.registry!.get(c.name)!.schema.safeParse(c.input);
      return parsed.success && safe(parsed.data);
    };
    const parallel = calls.map((c, i) => ({ c, i })).filter(({ c }) => parallelSafe(c));
    await Promise.all(parallel.map(async ({ c, i }) => (results[i] = await runOne(c))));
    for (let i = 0; i < calls.length; i++) {
      if (!results[i]) results[i] = await runOne(calls[i]);
    }
    return results;
  }
}

/** A short name for an action, for the failure notes. */
function actionName(req: ApprovalRequest): string {
  if (req.kind === "file") return `${req.created ? "新建" : "修改"}文件 ${req.path}`;
  if (req.kind === "command") return `运行 ${req.command.slice(0, 120)}`;
  return `调用 ${req.server}/${req.tool}`;
}

/** Why lazy mode refuses this action by itself, or "" to let it through. */
function lazyRefusal(req: ApprovalRequest, humanOnly: boolean): string {
  if (humanOnly) return req.kind === "tool" && req.humanOnly ? `懒人模式不替你做这个决定：${req.humanOnly}` : "懒人模式不会推送、发布或部署，这些会让别人看到，撤不回来";
  if (req.kind !== "command") return "";
  const hit = LAZY_STOP.find((r) => r.re.test(req.command));
  return hit ? `懒人模式不会运行这条命令：它${hit.reason}` : "";
}
