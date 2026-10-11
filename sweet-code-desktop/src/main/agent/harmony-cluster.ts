import fs from "node:fs";
import path from "node:path";

// The Harmony sub-agent cluster (the harmony-agents/ folder). This module only reads the role table
// and the role definitions from that folder. Each role then runs as its own AgentSession
// (index.ts), so nothing a role thinks or does reaches the other roles; only its final envelope
// is returned to the agent that dispatched it.

export interface ClusterRole {
  /** The role name, which is also the subagent_type in registry.md. */
  name: string;
  /** The 能力 column of the registry: what the role is for. */
  description: string;
  /** The role's definition file, without the frontmatter. */
  body: string;
  /** The 写权限 column is 无: the role may not edit project files (it can still run commands). */
  readOnly: boolean;
}

export interface Cluster {
  dir: string;
  roles: ClusterRole[];
  /** shared/contract.md, which every role gets in its system prompt. */
  contract: string;
}

/**
 * Read the cluster from `dir`. Returns null when the folder or its registry is missing, so the
 * dispatch tool is simply not offered. A role whose definition file is missing is skipped.
 */
export function loadCluster(dir: string): Cluster | null {
  const registryFile = path.join(dir, "shared", "registry.md");
  const contractFile = path.join(dir, "shared", "contract.md");
  if (!fs.existsSync(registryFile) || !fs.existsSync(contractFile)) return null;

  const roles: ClusterRole[] = [];
  for (const line of fs.readFileSync(registryFile, "utf8").split("\n")) {
    // | `name` | `agents/file.md` | 能力 | 写权限 | 环境依赖 |
    const cells = line.split("|").map((c) => c.trim());
    const name = cells[1]?.match(/^`([a-z][a-z0-9-]*)`$/)?.[1];
    const file = cells[2]?.match(/^`(agents\/[\w.-]+\.md)`$/)?.[1];
    if (!name || !file) continue;
    const defFile = path.join(dir, file);
    if (!fs.existsSync(defFile)) continue;
    roles.push({
      name,
      description: cells[3] ?? "",
      body: stripFrontmatter(fs.readFileSync(defFile, "utf8")),
      readOnly: cells[4] === "无",
    });
  }
  if (roles.length === 0) return null;
  return { dir, roles, contract: fs.readFileSync(contractFile, "utf8") };
}

/** The system prompt of one role's session: its definition plus the shared contract, nothing else. */
export function rolePrompt(cluster: Cluster, role: ClusterRole): string {
  return [
    `你是鸿蒙开发集群中的独立角色「${role.name}」。你在自己的会话里工作，只能看到调度方传来的输入信封。`,
    role.body,
    "## 输入输出契约\n\n" + cluster.contract,
    "最终回复只输出一个输出信封（YAML），放在一个代码块里，不要附加其他解释。",
  ].join("\n\n");
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}
