import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

// Workspace mode keeps its project config in <project>/.sikeoop/, not in .claude/:
//   .sikeoop/workspace.json   permission rules, starting mode, extra environment variables
//   .sikeoop/agents/*.md      the agent team, one Markdown file per role (frontmatter + prompt)
// sikeoop turns these into command-line flags for Claude Code (--settings, --agents), so the
// project needs no .claude/ files. A user's own .claude/ settings still load and still apply.

export const CONFIG_DIR = ".sikeoop";

const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  /**
   * The mode a session starts in. auto is opt-in: Claude Code's own classifier reviews each action
   * instead of asking the user; deny and ask rules still apply. Bypass is never offered.
   */
  permissionMode: z.enum(["default", "acceptEdits", "plan", "auto"]).default("default"),
  /** Load the agent team from .sikeoop/agents. */
  team: z.boolean().default(true),
  /** Claude Code permission rules (deny > ask > allow). */
  deny: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  allow: z.array(z.string()).default([]),
  /** Environment variables passed on beyond the built-in safe list (names, not values). */
  envPassthrough: z.array(z.string()).default([]),
});
export type WorkspaceConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: WorkspaceConfig = {
  version: 1,
  permissionMode: "default",
  team: true,
  deny: [
    // Credentials outside the project.
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.config/gh/**)",
    "Read(~/.claude/.credentials.json)",
    // Commands that reach far beyond the workspace.
    "Bash(sudo *)",
    "Bash(su *)",
    "Bash(shutdown *)",
    "Bash(reboot *)",
    "Bash(format *)",
    "Bash(diskpart *)",
    "Bash(reg *)",
    "Bash(npm publish *)",
  ],
  ask: [
    // Always confirm, even when an allow rule or acceptEdits would let them through.
    "Bash(git push *)",
    "Bash(curl *)",
    "Bash(wget *)",
    "Bash(ssh *)",
    "Bash(scp *)",
    "Bash(rm *)",
    "Bash(npm install -g *)",
    "Bash(pip install *)",
  ],
  allow: [],
  envPassthrough: [],
};

export interface TeamAgent {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
}

const AgentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "name 只能用小写字母、数字和 -"),
  description: z.string().min(1),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
  disallowedTools: z.union([z.string(), z.array(z.string())]).optional(),
  model: z.string().optional(),
});

const list = (v?: string | string[]) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean));

/** The default team, written to .sikeoop/agents the first time workspace mode starts. */
export const DEFAULT_TEAM: TeamAgent[] = [
  {
    name: "product-manager",
    description: "产品经理。新功能开工前使用：把需求整理成用户故事、范围和验收清单。",
    tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    model: "sonnet",
    prompt: `你是产品经理。把用户的想法整理成可以开工的需求：
1. 一句话目标，以及它为谁解决什么问题（本产品面向编程新手）。
2. 用户故事和范围：这次做什么、明确不做什么。
3. 验收清单：每条都能被测试或手动检查验证。
先读项目里已有的文档和代码再写，不要编造已有功能。你不写代码。`,
  },
  {
    name: "architect",
    description: "架构师。需求明确后使用：出技术方案、接口和安全边界，把工作拆成任务；也负责评审改动。",
    tools: ["Read", "Grep", "Glob"],
    model: "opus",
    prompt: `你是架构师。根据需求和现有代码给出技术方案：
- 涉及哪些模块、要新增或修改哪些文件、进程间接口（IPC）长什么样。
- 安全边界：路径要用真实路径校验、IPC 入参要做运行时校验、不扩大权限。
- 拆成可以独立完成和验证的任务，标出哪些可以并行。
评审时只指出真实问题，并给出文件和行号。你不直接改代码。`,
  },
  {
    name: "main-engineer",
    description: "主进程工程师。实现 Electron 主进程、Node、文件系统、进程管理相关的任务。",
    model: "opus",
    prompt: `你是 Electron 主进程工程师。按架构师的任务实现，代码风格和周围保持一致。
Windows 是首要平台：路径分隔符、.cmd 启动、Git Bash 都要考虑到。
改完运行类型检查（npm run typecheck），说明你验证了什么、没验证什么。`,
  },
  {
    name: "ui-engineer",
    description: "界面工程师。实现 React 渲染层的界面、交互和样式任务。",
    model: "sonnet",
    prompt: `你是 React 界面工程师。复用现有组件和 theme.css 里的颜色变量，不引入新的 UI 库。
文案用中文大白话，面向新手。改完运行类型检查（npm run typecheck）。`,
  },
  {
    name: "security-qa",
    description: "安全与测试。每个任务完成后使用：找越界、泄露和回归问题，出报告。只读，不修改代码。",
    tools: ["Read", "Grep", "Glob", "Bash"],
    disallowedTools: ["Edit", "Write"],
    model: "opus",
    prompt: `你是安全与测试工程师，只负责找问题和验证，不修改代码。
重点检查：路径越界（含软链接）、IPC 入参、环境变量和密钥泄露、权限被绕过、Windows 下的差异。
能复现的问题要给出复现步骤；只是怀疑的要说明是推测。按严重程度排序输出报告。`,
  },
];

/** Workflow notes added to the main session's system prompt when the team is on. */
export const LEAD_PROMPT = `你在 sikeoop 的「工作区模式」里运行：只在当前项目文件夹内工作，项目外的文件不要修改。
你是团队负责人，可以把工作交给这些子代理：product-manager（需求）、architect（方案和评审）、main-engineer（主进程）、ui-engineer（界面）、security-qa（安全与测试，只读）。
较大的功能按这个顺序推进：需求 → 方案（请用户确认）→ 实现（主进程和界面可以并行）→ 安全与测试 → 向用户汇报。
小改动可以直接做，不必走完整流程。每一步完成后都要如实说明验证了什么。`;

/** Reads .sikeoop/workspace.json, or the defaults when it doesn't exist. Throws on invalid JSON. */
export async function loadConfig(root: string): Promise<{ config: WorkspaceConfig; exists: boolean }> {
  const file = path.join(await configDir(root), "workspace.json");
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { config: DEFAULT_CONFIG, exists: false };
  }
  try {
    return { config: ConfigSchema.parse(JSON.parse(text)), exists: true };
  } catch (err) {
    throw new Error(`${CONFIG_DIR}/workspace.json 格式不对：${(err as Error).message}`);
  }
}

/** The team from .sikeoop/agents/*.md. Files that don't parse are reported, not fatal. */
export async function loadTeam(root: string): Promise<{ agents: TeamAgent[]; problems: string[] }> {
  const dir = path.join(await configDir(root), "agents");
  const agents: TeamAgent[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return { agents, problems };
  }
  for (const n of names) {
    const file = path.join(dir, n);
    // Only regular files: a symlink could point the team at a file outside the project.
    const st = await fs.lstat(file);
    if (!st.isFile()) continue;
    try {
      agents.push(parseAgent(await fs.readFile(file, "utf8")));
    } catch (err) {
      problems.push(`${CONFIG_DIR}/agents/${n}：${(err as Error).message}`);
    }
  }
  return { agents, problems };
}

export function parseAgent(text: string): TeamAgent {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("开头缺少 --- 包起来的 YAML 信息");
  const meta = AgentSchema.parse(YAML.parse(m[1]) ?? {});
  return {
    name: meta.name,
    description: meta.description,
    prompt: m[2].trim(),
    tools: list(meta.tools),
    disallowedTools: list(meta.disallowedTools),
    model: meta.model,
  };
}

export function formatAgent(a: TeamAgent): string {
  const meta: Record<string, unknown> = { name: a.name, description: a.description };
  if (a.tools) meta.tools = a.tools.join(", ");
  if (a.disallowedTools) meta.disallowedTools = a.disallowedTools.join(", ");
  if (a.model) meta.model = a.model;
  return `---\n${YAML.stringify(meta).trim()}\n---\n\n${a.prompt}\n`;
}

/** Writes the default workspace.json and team into .sikeoop/, keeping any file already there. */
export async function initConfig(root: string): Promise<string[]> {
  const dir = await configDir(root);
  await fs.mkdir(path.join(dir, "agents"), { recursive: true });
  await configDir(root); // re-check now that it exists
  const created: string[] = [];
  const write = async (rel: string, content: string) => {
    try {
      await fs.writeFile(path.join(dir, rel), content, { encoding: "utf8", flag: "wx" });
      created.push(`${CONFIG_DIR}/${rel.replace(/\\/g, "/")}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  };
  await write("workspace.json", JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  for (const a of DEFAULT_TEAM) await write(path.join("agents", `${a.name}.md`), formatAgent(a));
  return created;
}

/** <root>/.sikeoop, refusing one that resolves outside the project (a symlink). */
async function configDir(root: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const dir = path.join(realRoot, CONFIG_DIR);
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return dir; // doesn't exist yet
  }
  if (real !== dir) throw new Error(`${CONFIG_DIR} 指向了项目外面，已拒绝使用`);
  return dir;
}
