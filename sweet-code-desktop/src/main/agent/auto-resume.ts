/** One budget shared by quota recovery, Stop hooks and unattended checklist continuation. */
export const MAX_AUTO_RESUMES = 3;
export const AUTO_RESUME_REVIEW_REASON = '同一任务已自动续跑 3 次，已停止，需人工查看';

export interface AutoResumeState {
  taskId: string;
  count: number;
  needsReview?: boolean;
}

export function createAutoResumeState(taskId: string): AutoResumeState {
  return { taskId, count: 0 };
}

export function normalizeAutoResumeState(value: unknown, taskId: string): AutoResumeState {
  const state = value as Partial<AutoResumeState> | null;
  if (!state || typeof state.taskId !== 'string' || !state.taskId ||
      !Number.isSafeInteger(state.count) || Number(state.count) < 0) return createAutoResumeState(taskId);
  return { taskId: state.taskId, count: Math.min(Number(state.count), MAX_AUTO_RESUMES),
    ...(state.needsReview === true ? { needsReview: true } : {}) };
}

/** Claim before sending/adding a continuation, and persist before executing it. */
export function claimAutoResume(state: AutoResumeState): boolean {
  if (state.needsReview || state.count >= MAX_AUTO_RESUMES) {
    state.needsReview = true;
    return false;
  }
  state.count++;
  return true;
}
