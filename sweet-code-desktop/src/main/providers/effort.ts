import type { Effort } from "../../shared/types.ts";

/** Conservative capability list from the bundled SDK and the existing model configuration. */
export function supportsClaudeEffort(model: string): boolean {
  return /^claude-(?:opus-(?:4-[5678]|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|(?:fable|mythos)-5(?:-1)?|mythos-preview)(?:-\d{8}|-latest)?(?:\[1m\])?$/.test(model);
}

export function supportsMessageEffort(model: string): boolean {
  return /^claude-(?:opus-5(?:-5)?|sonnet-5-5|(?:fable|mythos)-5-1)(?:-\d{8}|-latest)?(?:\[1m\])?$/.test(model);
}

export function isEffort(value: unknown): value is Effort {
  return value === "low" || value === "medium" || value === "high";
}

/** Helper requests have no history/cache to pin; compatible vendors get no new fields. */
export function claudeEffortParams(kind: string, model: string, compat: boolean | undefined, effort: Effort): { output_config?: { effort: Effort } } {
  return kind === "anthropic" && !compat && supportsClaudeEffort(model) ? { output_config: { effort } } : {};
}
