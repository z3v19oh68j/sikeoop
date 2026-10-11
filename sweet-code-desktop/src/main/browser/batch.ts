/** Sequential execution; a denial is a failure, never a skipped successful action. */
export async function runBrowserBatch<T>(actions: readonly T[], execute: (action: T, index: number) => Promise<void>, signal?: AbortSignal): Promise<{ completed: number; failedStep: number | null; reason: string | null }> {
  let completed = 0;
  for (let index = 0; index < actions.length; index++) {
    try {
      if (signal?.aborted) throw new Error("Browser action cancelled.");
      await execute(actions[index]!, index);
      completed++;
    } catch (error) {
      return { completed, failedStep: index + 1, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { completed, failedStep: null, reason: null };
}
