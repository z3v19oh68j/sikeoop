/// <reference types="vite/types/importMeta.d.ts" />
import type { BuiltinSkill } from "./skills";

// The skills that ship with the app: a set that works together for planning, testing,
// debugging, verifying and checkpointing. Bundled into the main process at build time,
// so there's nothing to download. SkillStore.syncBuiltin() copies them into userData.
const raw = import.meta.glob<string>("./builtin-skills/*/**", { eager: true, query: "?raw", import: "default" });

export const BUILTIN_SKILLS: BuiltinSkill[] = (() => {
  const byName = new Map<string, Map<string, Uint8Array>>();
  for (const [p, text] of Object.entries(raw)) {
    const [name, ...rest] = p.slice("./builtin-skills/".length).split("/");
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name)!.set(rest.join("/"), new TextEncoder().encode(text));
  }
  return [...byName].map(([name, files]) => ({ name, files }));
})();
