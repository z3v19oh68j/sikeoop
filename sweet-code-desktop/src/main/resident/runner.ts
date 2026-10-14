import type { AgentEvent, ChatRequest, ResidentAccount } from '../../shared/types.ts';
import type { ToolSpec } from '../tools/registry.ts';
import { roundPrompt } from './prompts.ts';
import type { RoundRequest, RoundResult } from './service.ts';
import { residentReportTool, type ResidentReport } from './tools.ts';

/** The part of AgentSession a round uses. */
export interface RoundSession {
  send(req: ChatRequest): Promise<void>;
  cancel(): void;
}

export interface RunnerDeps {
  root(): string | null;
  /** The folder is sikeoop's own source. */
  isSelf(root: string): boolean;
  /**
   * A separate conversation for one round, on exactly this account's login, with the extra tools.
   * Its events don't go to the chat; `onTurnError` gets the raw error a turn ended on.
   */
  createSession(account: ResidentAccount, emit: (e: AgentEvent) => void, tools: ToolSpec[], onTurnError: (err: unknown) => void): RoundSession;
  /** Files may have changed: refresh the file tree and open files. */
  workspaceChanged?(): void;
  now?: () => number;
}

const DONE_TEXT: Record<string, string> = { step_limit: '步数用完了，还没做完', refusal: '模型拒绝了这个请求', cancelled: '停下了' };

/** One learning round as a background conversation in lazy mode (nobody is at the computer). */
export function roundRunner(deps: RunnerDeps): (req: RoundRequest) => Promise<RoundResult> {
  return async (req) => {
    const root = deps.root();
    if (!root) return { ok: false, summary: '没有打开项目', outputs: [] };
    if (req.signal.aborted) return { ok: false, summary: '停下了', outputs: [] };
    const live: { text: string; done: string | null; error: string; raw: unknown; reported: ResidentReport | null } = { text: '', done: null, error: '', raw: undefined, reported: null };
    const session = deps.createSession(
      req.account,
      (e) => {
        if (e.type === 'status' && e.state === 'thinking') live.text = '';
        else if (e.type === 'text_delta') live.text = (live.text + e.text).slice(-4000);
        else if (e.type === 'done') live.done = e.reason;
        else if (e.type === 'error') live.error = e.message;
        else if (e.type === 'file_changed' || e.type === 'workspace_changed') deps.workspaceChanged?.();
      },
      [residentReportTool((r) => { live.reported = r; })],
      (err) => { live.raw = err; },
    );
    const onAbort = () => session.cancel();
    req.signal.addEventListener('abort', onAbort, { once: true });
    const d = new Date(deps.now?.() ?? Date.now());
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      await session.send({
        text: roundPrompt({ topic: req.topic, targets: req.settings.targets, recent: req.recent, date, isSelf: deps.isSelf(root) }),
        editor: {},
        effort: 'high',
        autopilot: true,
        lazy: true,
      });
    } catch (err) {
      live.raw ??= err;
      live.error ||= err instanceof Error ? err.message : String(err);
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
    // Reported: the work is in, whatever happened to the last sentence after it.
    if (live.reported) return { ok: true, topic: live.reported.topic, summary: live.reported.summary, outputs: live.reported.outputs };
    if (live.done === 'end_turn') return { ok: true, summary: live.text.trim().slice(-600) || '（做完了，但没有上报结果）', outputs: [] };
    const error = live.raw ?? (live.error || undefined);
    return { ok: false, summary: live.error || DONE_TEXT[live.done ?? 'cancelled'] || '停下了', outputs: [], ...(error !== undefined ? { error } : {}) };
  };
}
