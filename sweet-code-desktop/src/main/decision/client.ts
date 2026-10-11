import { createHash } from "node:crypto";
import { estimateTokens } from "../agent/context-usage";

// Client for TypeSafe Jev (structured decisions) through TokenDance's typesafe:systemone
// endpoint. Facts below were measured against the live API on 2026-10-07 (docs/jev-decision-layer.md §8):
//   - answers come back under `answers`, one per question, typed noul / choice / score;
//   - at most 32 questions, 255 choice options, 10 score levels per request;
//   - the 32768-token budget counts the state once per noul, once per choice option and once
//     per score level ("expanded" tokens), and an oversized request is refused, not truncated;
//   - 10 requests in flight per user, then 429 without Retry-After;
//   - the same input always returns the same numbers, so results are cached.

export const JEV_URL = "https://tokendance.space/gateway/typesafe/v1/systemone";
export const LIMITS = { questions: 32, choiceOptions: 255, scoreLevels: 10, expandedTokens: 32_768, concurrency: 10 } as const;
/** Our estimate is rough; leave room so the service rarely has to refuse a request. */
const BUDGET = 30_000;
/** Measured fixed cost of one expanded copy (prompt template) besides the state and option text. */
const COPY_OVERHEAD = 140;
const TIMEOUT_MS = 30_000;

export type Question =
  | { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions?: string; criteria: Record<string, string> }
  | { type: "score"; instructions?: string; criteria: string[] };

export type Answer =
  | { type: "noul"; p: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number };

export type State = string | Record<string, unknown>;

export interface DecideResult {
  answers: Record<string, Answer>;
  model: string;
  /** Input tokens as counted by the service (0 for cached answers). */
  inputTokens: number;
  /** Requests actually sent (questions that don't fit one budget are split). */
  requests: number;
  cached: boolean;
}

/** A failed call, with a message the agent or the user can act on. */
export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface ClientOptions {
  config(): { apiKey: string; model: string };
  fetch?: Fetcher;
  url?: string;
  concurrency?: number;
  /** Delay before retrying a rate-limited call; tests shorten it. */
  backoffMs?(attempt: number): number;
}

export class JevClient {
  private readonly fetcher: Fetcher;
  private readonly url: string;
  private readonly limit: number;
  private active = 0;
  private queue: Array<() => void> = [];
  private cache = new Map<string, { answers: Record<string, Answer>; model: string }>();

  constructor(private readonly opts: ClientOptions) {
    this.fetcher = opts.fetch ?? ((u, i) => fetch(u, i));
    this.url = opts.url ?? JEV_URL;
    this.limit = Math.min(opts.concurrency ?? 8, LIMITS.concurrency);
  }

  ready(): boolean {
    return Boolean(this.opts.config().apiKey);
  }

  /** Ask every question about one state. Questions are grouped into as few requests as fit. */
  async decide(state: State, questions: Record<string, Question>, signal?: AbortSignal): Promise<DecideResult> {
    const { apiKey, model } = this.opts.config();
    if (!apiKey) throw new JevError("还没有设置决策模型的 Key（设置 → 决策模型，填 TokenDance 的 Key）", 401, "no_key", false);
    validate(questions);
    const groups = planGroups(state, questions);
    const results = await Promise.all(groups.map((g) => this.ask(apiKey, model, state, g, signal)));
    const answers: Record<string, Answer> = {};
    for (const r of results) Object.assign(answers, r.answers);
    return {
      answers,
      model: results[0]?.model ?? model,
      inputTokens: results.reduce((n, r) => n + r.inputTokens, 0),
      requests: results.reduce((n, r) => n + r.requests, 0),
      cached: results.every((r) => r.cached),
    };
  }

  /** One group of questions; split further if the service still finds it over budget. */
  private async ask(apiKey: string, model: string, state: State, questions: Record<string, Question>, signal?: AbortSignal): Promise<DecideResult> {
    const key = createHash("sha256").update(JSON.stringify([model, state, questions])).digest("hex");
    const hit = this.cache.get(key);
    if (hit) return { ...hit, inputTokens: 0, requests: 0, cached: true };
    try {
      const res = await this.post(apiKey, { model, state, questions }, signal);
      this.remember(key, res);
      return { ...res, requests: 1, cached: false };
    } catch (e) {
      const names = Object.keys(questions);
      if (e instanceof JevError && e.code === "token_budget_exceeded" && names.length > 1) {
        const half = Math.ceil(names.length / 2);
        const pick = (ns: string[]) => Object.fromEntries(ns.map((n) => [n, questions[n]]));
        const [a, b] = await Promise.all([
          this.ask(apiKey, model, state, pick(names.slice(0, half)), signal),
          this.ask(apiKey, model, state, pick(names.slice(half)), signal),
        ]);
        return { answers: { ...a.answers, ...b.answers }, model: a.model, inputTokens: a.inputTokens + b.inputTokens, requests: a.requests + b.requests, cached: false };
      }
      throw e;
    }
  }

  private remember(key: string, res: { answers: Record<string, Answer>; model: string }) {
    if (this.cache.size >= 5000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { answers: res.answers, model: res.model });
  }

  private async post(apiKey: string, body: unknown, signal?: AbortSignal): Promise<{ answers: Record<string, Answer>; model: string; inputTokens: number }> {
    for (let attempt = 0; ; attempt++) {
      await this.acquire(signal);
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        res = await this.fetcher(this.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        this.release();
        if (signal?.aborted) throw e;
        const timedOut = (e as Error).name === "TimeoutError";
        if (attempt < 2) {
          await sleep(this.backoff(attempt), signal);
          continue;
        }
        throw new JevError(timedOut ? "决策模型 30 秒没有回应" : `连不上决策模型：${(e as Error).message}`, 0, timedOut ? "timeout" : "network", true);
      }
      const text = await res.text().finally(() => this.release());
      if (res.ok) return parseResponse(text);
      const err = parseError(res.status, text);
      const tries = res.status === 429 ? 6 : 3;
      if (err.retryable && attempt < tries - 1) {
        await sleep(this.backoff(attempt), signal);
        continue;
      }
      throw err;
    }
  }

  private backoff(attempt: number): number {
    return this.opts.backoffMs?.(attempt) ?? 500 + Math.random() * 1500 * (attempt + 1);
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", stop);
        this.active++;
        resolve();
      };
      const stop = () => {
        this.queue = this.queue.filter((f) => f !== go);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", stop, { once: true });
      this.queue.push(go);
    });
  }

  private release() {
    this.active--;
    this.queue.shift()?.();
  }
}

// ---- request planning -------------------------------------------------------

/** How many times the state is counted for this question. */
export function copies(q: Question): number {
  return q.type === "noul" ? 1 : q.type === "choice" ? Object.keys(q.criteria).length : q.criteria.length;
}

/** Estimated expanded tokens of one question about a state of `stateTokens`. */
export function questionTokens(q: Question, stateTokens: number): number {
  const instr = estimateTokens(q.instructions ?? "");
  if (q.type === "noul") return stateTokens + instr + COPY_OVERHEAD + estimateTokens(JSON.stringify(q.criteria ?? ""));
  const options = q.type === "choice" ? Object.entries(q.criteria).map(([k, v]) => `${k} ${v}`) : q.criteria;
  return options.reduce((n, o) => n + stateTokens + instr + COPY_OVERHEAD + estimateTokens(o), 0);
}

export const stateTokens = (state: State) => estimateTokens(typeof state === "string" ? state : JSON.stringify(state));

/** Pack questions into requests under the budget and the per-request question limit. */
export function planGroups(state: State, questions: Record<string, Question>): Record<string, Question>[] {
  const st = stateTokens(state);
  const groups: Record<string, Question>[] = [];
  let current: Record<string, Question> = {};
  let used = 0;
  // Biggest first, so the large ones don't end up alone at the end.
  const sorted = Object.entries(questions).sort(([, a], [, b]) => copies(b) - copies(a));
  for (const [name, q] of sorted) {
    const t = questionTokens(q, st);
    if (t > BUDGET) {
      throw new JevError(
        `问题「${name}」连同内容估算约 ${Math.round(t / 1000)}K token，超过决策模型的上限（32K，内容会按选项数重复计算）。` +
          `内容约 ${Math.round(st / 1000)}K token：把内容缩短或切成几段分别问，或者减少「${name}」的选项。`,
        422,
        "state_too_long",
        false,
      );
    }
    const n = Object.keys(current).length;
    if (n && (used + t > BUDGET || n >= LIMITS.questions)) {
      groups.push(current);
      current = {};
      used = 0;
    }
    current[name] = q;
    used += t;
  }
  if (Object.keys(current).length) groups.push(current);
  return groups;
}

/** Catch mistakes before they cost a request; the service would answer 422 for these. */
export function validate(questions: Record<string, Question>) {
  const names = Object.keys(questions);
  if (!names.length) throw new JevError("至少要有一个问题", 422, "invalid_questions", false);
  for (const name of names) {
    const q = questions[name];
    if (!/^[A-Za-z_][\w-]{0,63}$/.test(name)) {
      throw new JevError(`问题名「${name}」只能用英文字母、数字、下划线和短横线，比如 is_urgent`, 422, "invalid_questions", false);
    }
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2) throw new JevError(`问题「${name}」是 choice，至少要有 2 个选项（criteria 写成 {选项: 说明}）`, 422, "invalid_questions", false);
      if (n > LIMITS.choiceOptions) throw new JevError(`问题「${name}」的选项太多（${n} 个），最多 ${LIMITS.choiceOptions} 个`, 422, "invalid_questions", false);
    } else if (q.type === "score") {
      const n = q.criteria?.length ?? 0;
      if (n < 2 || n > LIMITS.scoreLevels) {
        throw new JevError(`问题「${name}」是 score，要有 2 到 ${LIMITS.scoreLevels} 个等级（criteria 是从低到高的数组），现在是 ${n} 个`, 422, "invalid_questions", false);
      }
    } else if (q.type !== "noul") {
      throw new JevError(`问题「${name}」的类型只能是 noul、choice 或 score`, 422, "invalid_questions", false);
    }
  }
}

// ---- responses --------------------------------------------------------------

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const probs = (v: unknown): Record<string, number> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, p]) => [k, num(p)]).filter(([, p]) => !Number.isNaN(p))) : {};

export function parseResponse(text: string): { answers: Record<string, Answer>; model: string; inputTokens: number } {
  let body: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new JevError("决策模型返回的内容看不懂", 502, "bad_response", true);
  }
  // Measured format: { model, answers: {...}, usage }. Older write-ups show the answers at the top level.
  const raw = (body.answers && typeof body.answers === "object" ? body.answers : body) as Record<string, Record<string, unknown>>;
  const answers: Record<string, Answer> = {};
  for (const [name, a] of Object.entries(raw)) {
    if (!a || typeof a !== "object" || name === "usage" || name === "model") continue;
    const answer = toAnswer(a);
    if (answer) answers[name] = answer;
  }
  if (!Object.keys(answers).length) throw new JevError("决策模型没有返回任何结论", 502, "bad_response", true);
  return { answers, model: typeof body.model === "string" ? body.model : "", inputTokens: num(body.usage?.input_tokens) || 0 };
}

function toAnswer(a: Record<string, unknown>): Answer | null {
  const type = a.type ?? ("noul" in a || "probability" in a ? "noul" : "choice" in a ? "choice" : "score" in a ? "score" : null);
  if (type === "noul") {
    const p = num(a.noul ?? a.probability);
    return Number.isNaN(p) ? null : { type, p };
  }
  if (type === "choice" && typeof a.choice === "string") {
    const probabilities = probs(a.probabilities);
    return { type, choice: a.choice, probabilities, confidence: num(a.confidence) || (probabilities[a.choice] ?? 0) };
  }
  if (type === "score" && !Number.isNaN(num(a.score))) {
    const probabilities = probs(a.probabilities);
    const legend = a.legend && typeof a.legend === "object" ? Object.fromEntries(Object.entries(a.legend).map(([k, v]) => [k, String(v)])) : {};
    return { type, score: num(a.score), probabilities, legend, confidence: num(a.confidence) || Math.max(0, ...Object.values(probabilities)) };
  }
  return null;
}

/** The gateway answers { code, message }; the model service answers FastAPI-style { detail }. */
export function parseError(status: number, text: string): JevError {
  let body: { code?: string; message?: string; detail?: unknown } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON (a proxy page): fall through with the status.
  }
  const retryable = status === 429 || status >= 500;
  if (status === 429) return new JevError("决策模型请求太频繁（同时最多 10 个），稍后重试", 429, body.code ?? "rate_limited", true);
  if (status === 401 || status === 403) return new JevError(`决策模型的 Key 不能用：${body.message ?? "被拒绝了"}`, status, body.code ?? "unauthorized", false);
  if (body.message) return new JevError(`决策模型：${body.message}`, status, body.code ?? "error", retryable);
  const d = body.detail;
  if (d && !Array.isArray(d) && typeof d === "object") {
    const o = d as { code?: string; counted_tokens?: number; message?: string };
    if (o.code === "token_budget_exceeded") {
      return new JevError(`内容太长：展开后约 ${Math.round((o.counted_tokens ?? 0) / 1000)}K token，上限 32K`, status, o.code, false);
    }
    return new JevError(`决策模型：${o.message ?? JSON.stringify(d).slice(0, 200)}`, status, o.code ?? "invalid_request", false);
  }
  if (Array.isArray(d) && d.length) {
    const lines = d.slice(0, 3).map((x: { loc?: unknown[]; msg?: string }) => {
      const where = (x.loc ?? []).filter((p) => p !== "body").join(".");
      return `${where}：${x.msg ?? "格式不对"}`;
    });
    return new JevError(`请求格式不对：${lines.join("；")}`, status, "invalid_request", false);
  }
  return new JevError(`决策模型出错了（HTTP ${status}）`, status, "error", retryable);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
