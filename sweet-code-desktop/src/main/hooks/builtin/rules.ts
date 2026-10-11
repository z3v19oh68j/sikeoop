import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuiltinHandler } from "../bus";

// Rule files other AI tools read: following them makes this app fit the project the same way.
const FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"];
const PER_FILE = 6000;
const TOTAL = 12000;

export function create(): BuiltinHandler {
  return async (_event, _input, ctx) => {
    const parts: string[] = [];
    const names: string[] = [];
    let budget = TOTAL;
    for (const name of FILES) {
      if (budget <= 0) break;
      let text: string;
      try {
        text = (await fs.readFile(path.join(ctx.root, name), "utf8")).trim();
      } catch {
        continue;
      }
      if (!text) continue;
      const room = Math.min(PER_FILE, budget);
      const cut = text.length > room ? `\n…（文件太长，后面没有附上；需要时用 read_file 读 ${name}）` : "";
      parts.push(`<project_rules file="${name}">\n${text.slice(0, room)}${cut}\n</project_rules>`);
      names.push(name);
      budget -= Math.min(text.length, room);
    }
    if (!parts.length) return null;
    return { context: parts.join("\n"), notice: { message: `读了项目规则：${names.join("、")}` } };
  };
}
