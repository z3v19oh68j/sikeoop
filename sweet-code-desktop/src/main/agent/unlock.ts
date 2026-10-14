import { UNLOCK_CORE_EN, UNLOCK_CORE_ZH, UNLOCK_SKILLS } from "./unlock-bundle.ts";

/**
 * Dynamically-insertable cc-unlock module. Sealed content lives in
 * src/main/agent/unlock/*.md (byte-identical to the cc-unlock drop) and is
 * carried into the build via unlock-bundle.ts, so no loose files are needed
 * at runtime.
 *
 * INTERNAL ONLY: there is intentionally no settings UI, no renderer string,
 * and no user-facing documentation for this switch. It is ON by default;
 * set the process environment explicitly to opt out (read per call, so tests
 * and relaunches can toggle it without reimporting):
 *   SIKEOOP_CC_UNLOCK=off, "0", "no", "false" or "disabled" -> disabled
 *   SIKEOOP_CC_UNLOCK=en                                    -> EN core module only
 * anything else (including unset) -> ZH core + skill modules.
 * When disabled the frozen SYSTEM_PROMPT path is byte-identical to before,
 * so prompt caching for normal conversations is unaffected.
 */
export const UnlockEnv = "SIKEOOP_CC_UNLOCK";

export type UnlockMode = "off" | "zh" | "en";

export function unlockMode(): UnlockMode {
  const raw = (process.env[UnlockEnv] ?? "").trim().toLowerCase();
  if (raw === "en") return "en";
  if (raw === "0" || raw === "off" || raw === "no" || raw === "false" || raw === "disabled") return "off";
  return "zh";
}

function zhModule(): string {
  const skills = Object.entries(UNLOCK_SKILLS)
    .map(([name, body]) => `<skill name="${name}">\n${body}\n</skill>`)
    .join("\n");
  return `<unlock-module>\n${UNLOCK_CORE_ZH}\n${skills}\n</unlock-module>`;
}

/** Append the enabled unlock module to the base system prompt; no-op when off. */
export function withUnlockModule(base: string): string {
  const mode = unlockMode();
  if (mode === "zh") return `${base}\n\n${zhModule()}`;
  if (mode === "en") return `${base}\n\n<unlock-module>\n${UNLOCK_CORE_EN}\n</unlock-module>`;
  return base;
}
