import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashEnv, findOnPath } from "../shell-env";
import { CliNotFound, narrowEnv, type LaunchSpec } from "../workspace-mode/launch";
import { passthrough, planLaunch, type CliDefinition } from "./definition";

// Starts an extension CLI in a terminal tab from its definition (cli-agents/definition.ts).
// Unlike Claude Code and Codex, sikeoop adds no sandbox or permission rules of its own here: what
// the CLI may do is whatever its definition's arguments and its own configuration say.

const isWin = process.platform === "win32";

/** What the agent bus gives a session (PeerBus.register). */
export interface BusLink {
  id: string;
  name: string;
  mcpUrl: string;
  hookUrl: string;
  bridge: { command: string; args: string[]; env: Record<string, string> };
}

export function findExtensionCli(def: CliDefinition): string | null {
  for (const bin of def.bin) {
    const found = findOnPath(bin) ?? (isWin ? (findOnPath(`${bin}.exe`) ?? findOnPath(`${bin}.cmd`)) : null);
    if (found) return found;
  }
  for (const p of def.paths ?? []) {
    const abs = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
    if (path.isAbsolute(abs) && existsSync(abs)) return abs;
  }
  return null;
}

export async function buildExtensionLaunch(def: CliDefinition, source: string, root: string, cacheDir: string, link: BusLink, instructions: string): Promise<LaunchSpec> {
  const file = findExtensionCli(def);
  if (!file) throw new CliNotFound(`没有找到 ${def.name}（找过：${def.bin.join("、")}）。${def.install ? "点下面的「一键安装」，装好后再启动。" : "请先安装它，并确认在终端里能直接运行。"}`);
  const sessionDir = path.join(cacheDir, def.id, link.id);
  const plan = planLaunch(def, {
    root,
    name: link.name,
    sessionDir,
    hookUrl: link.hookUrl,
    mcpUrl: link.mcpUrl,
    mcpCommand: [link.bridge.command, ...link.bridge.args],
    mcpEnv: link.bridge.env,
    instructions,
  });
  await fs.mkdir(sessionDir, { recursive: true });
  for (const f of plan.files) {
    await fs.mkdir(path.dirname(f.path), { recursive: true });
    await fs.writeFile(f.path, f.content, "utf8");
  }
  const pass = passthrough(def);
  return {
    file,
    args: plan.args,
    // The addresses are also in the environment, for a hook script that is a one-line curl.
    env: { ...narrowEnv(process.env, pass.keys, pass.prefixes), ...bashEnv(), SIKEOOP_HOOK_URL: link.hookUrl, SIKEOOP_SESSION: link.name, ...plan.env },
    banner: [
      `扩展 CLI：${def.name}（定义来自 ${source}）。sikeoop 没有给它加沙盒或权限规则，它能做什么由它自己的配置决定。`,
      ...(def.notes ?? []),
      def.turnEnd === "quiet"
        ? `这个会话叫 ${link.name}。它不会自己报告“做完了”，sikeoop 按终端安静下来的时间判断，可能不准。`
        : `这个会话叫 ${link.name}：可以和其他终端里的 AI 互相发消息。`,
    ],
  };
}
