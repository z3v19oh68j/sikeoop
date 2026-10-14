import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { FORCED_SKILL_NAMES, type SkillStore } from "./skills.ts";

/** opencode 技能目录：只读，不写外部。 */
export function zhenxinSourceDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "skills");
}

/**
 * 开机自检：把 opencode 侧的 zhenxin-* 链导入为 sikeoop 强制预设。
 * 返回实际装好的名字。外部目录不存在时静默返回 []（只剩内置 hack-preset）。
 */
export async function ensureHackPreset(store: SkillStore): Promise<string[]> {
  const installed: string[] = [];
  const src = zhenxinSourceDir();
  for (const name of FORCED_SKILL_NAMES) {
    if (name === "hack-preset") continue;
    let ok = false;
    try {
      ok = await store.importForced(path.join(src, name), name);
    } catch (err) {
      console.error(`[skills] forced import ${name} failed:`, (err as Error).message);
    }
    if (ok) installed.push(name);
  }
  try {
    await fs.stat(path.join(src, "zhenxin-recon"));
  } catch {
    // 外部目录整个不存在：不报错，hack-preset 照常工作。
  }
  return installed;
}
