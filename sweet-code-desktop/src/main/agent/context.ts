import type { EditorContext } from "@shared/types";
import { findBash } from "../shell-env";
import { buildTree, getRoot, treeToText } from "../workspace";

export { SYSTEM_PROMPT, AUTOPILOT_NOTE, LAZY_NOTE, ORCHESTRATE_NOTE } from "./prompts.ts";

/** Project overview sent once, at the start of a conversation. */
export async function projectSnapshot(skills: { name: string; description: string; forced?: boolean }[] = []): Promise<string> {
  const tree = treeToText(await buildTree(4));
  const project = `<project>\n项目文件夹：${getRoot()}\n${environmentLine()}\n文件结构（部分）：\n${tree}\n</project>`;
  if (!skills.length) return project;
  // 强制预设 · hack 专用模块永远置顶，和普通技能分开列。
  const forced = skills.filter((s) => s.forced);
  const rest = skills.filter((s) => !s.forced);
  const parts = [project];
  if (forced.length) {
    const list = forced.map((s) => `- ${s.name}：${s.description}`).join("\n");
    parts.push(`<hack_preset>\n强制预设 · hack 专用模块（常驻，不能关闭）。任务和其中某条链相关时，先用 use_skill 读取它的完整说明再动手，总入口是 hack-preset：\n${list}\n</hack_preset>`);
  }
  if (rest.length) {
    // Only names and descriptions here; the full instructions load on demand with use_skill.
    const list = rest.map((s) => `- ${s.name}：${s.description}`).join("\n");
    parts.push(`<skills>\n用户安装了这些技能。任务和某个技能相关时，先用 use_skill 读取它的完整说明再动手：\n${list}\n</skills>`);
  }
  return parts.join("\n");
}

/** Which system the commands run on, so the model picks the right paths and tools. */
function environmentLine(): string {
  if (process.platform === "win32") {
    return findBash()
      ? "运行环境：Windows。命令在 Git Bash 里运行：用 bash 语法，盘符路径写成 /c/Users/…，不要用 PowerShell 或 cmd。"
      : "运行环境：Windows，但没有安装 Git for Windows，暂时不能运行命令。";
  }
  return `运行环境：${process.platform === "darwin" ? "macOS" : "Linux"}。命令在 bash 里运行。`;
}

/** What the user is looking at right now, attached to every user message. */
export function editorContextText(ctx: EditorContext): string {
  const parts: string[] = [];
  if (ctx.activeFile) parts.push(`当前打开的文件：${ctx.activeFile}`);
  if (ctx.selection && ctx.selection.trim()) {
    const sel = ctx.selection.length > 8000 ? ctx.selection.slice(0, 8000) + "\n…（选中内容太长，已截断）" : ctx.selection;
    parts.push(`用户选中的代码：\n\`\`\`\n${sel}\n\`\`\``);
  }
  return parts.length ? `<editor>\n${parts.join("\n")}\n</editor>` : "";
}
