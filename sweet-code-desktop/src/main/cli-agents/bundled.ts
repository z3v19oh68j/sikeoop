// Definitions that ship with sikeoop, in the same format a user writes (docs/cli-扩展开发文档.md).
// A user's file with the same id replaces the one here.

/**
 * opencode's plugin for one session: reports turns to sikeoop and asks before each tool call.
 * Plain JavaScript in a string; {json:hookUrl} is filled when the session starts.
 */
const OPENCODE_PLUGIN = `// Written by sikeoop for this session. Do not edit: it is rewritten on every start.
const HOOK = {json:hookUrl};
const post = (body) =>
  fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch(() => ({}));
const WRITES = new Set(["write", "edit", "patch", "multiedit"]);

export const Sikeoop = async ({ directory }) => {
  const assistant = new Set();
  const children = new Set();
  let last = "";
  let busy = false;
  return {
    event: async ({ event }) => {
      const p = event.properties || {};
      if (event.type === "session.created" && p.info && p.info.parentID) children.add(p.info.id);
      if (event.type === "message.updated" && p.info && p.info.role === "assistant" && !children.has(p.info.sessionID)) {
        assistant.add(p.info.id);
        if (!busy) {
          busy = true;
          await post({ event: "turn-start" });
        }
      }
      if (event.type === "message.part.updated" && p.part && p.part.type === "text" && assistant.has(p.part.messageID)) last = p.part.text || last;
      if (event.type === "permission.asked") await post({ event: "waiting", text: "等你在终端里批准" });
      // A subagent going idle is not the end of the turn.
      if (event.type === "session.idle" && !children.has(p.sessionID)) {
        busy = false;
        assistant.clear();
        await post({ event: "turn-end", text: last });
        last = "";
      }
    },
    "tool.execute.before": async (input, output) => {
      const args = (output && output.args) || {};
      const file = args.filePath || args.path;
      const answer = await post({
        event: "tool",
        tool: input.tool,
        write: WRITES.has(input.tool) && typeof file === "string",
        file: typeof file === "string" ? file : undefined,
        command: typeof args.command === "string" ? args.command : undefined,
        cwd: directory,
      });
      if (answer && answer.decision === "deny") throw new Error(answer.reason || "sikeoop 拒绝了这次操作");
    },
  };
};
`;

/**
 * CodeBuddy Code's hooks are Claude Code's (same events, same stdin JSON, same hookSpecificOutput
 * answers, exit 2 to block), so it reports in PeerBus's own dialect, as peers.claudeSettings() does.
 * SessionStart marks it ready. Timeouts match claudeSettings(); PermissionRequest waits for the island.
 */
const codebuddyHook = (timeout: number) => ({
  type: "command",
  command: `curl -fsS -m ${timeout} -X POST -H 'Content-Type: application/json' --data-binary @- '{hookUrl}' || { echo 'sikeoop hook 超时或不可用，拒绝执行' >&2; exit 2; }`,
  timeout: timeout + 5,
});
const CODEBUDDY_QUICK = [{ hooks: [codebuddyHook(5)] }];

export const BUNDLED: unknown[] = [
  {
    id: "opencode",
    name: "opencode",
    label: "OpenCode",
    description: "开源的终端编程助手；改文件和运行命令前会先问你",
    bin: ["opencode"],
    paths: ["~/.opencode/bin/opencode"],
    install: "curl -fsSL https://opencode.ai/install | bash",
    args: ["{root}"],
    env: {
      // Merged over the user's own opencode config for this session only; nothing global is touched.
      OPENCODE_CONFIG_CONTENT: {
        json: {
          mcp: { sikeoop: { type: "local", command: "{mcpCommand}", environment: "{mcpEnv}", enabled: true } },
          instructions: ["{sessionDir}/sikeoop.md"],
          plugin: ["{sessionDirUrl}/sikeoop-plugin.js"],
          permission: { edit: "ask", bash: "ask" },
        },
      },
    },
    envPassthrough: ["OPENCODE_*", "ANTHROPIC_*", "OPENAI_*", "GEMINI_*", "GOOGLE_*", "OPENROUTER_*", "AWS_*", "AZURE_*"],
    files: [
      { path: "sikeoop.md", content: "{instructions}\n" },
      { path: "sikeoop-plugin.js", content: OPENCODE_PLUGIN },
    ],
    turnEnd: "hook",
    notes: ["opencode 用的是你自己的 opencode 配置和模型；这次会话额外设了：改文件、运行命令前先问你。"],
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    label: "CodeBuddy",
    description: "腾讯的终端编程助手（CodeBuddy Code）；钩子和 Claude Code 同一套，写文件受文件锁和归属约束",
    bin: ["codebuddy", "cbc"],
    install: "npm i -g @tencent-ai/codebuddy-code",
    args: ["--settings", "{sessionDir}/settings.json", "--mcp-config", "{sessionDir}/mcp.json", "--append-system-prompt", "{instructions}"],
    envPassthrough: ["CODEBUDDY_*"],
    files: [
      {
        path: "settings.json",
        content: {
          json: {
            hooks: {
              SessionStart: CODEBUDDY_QUICK,
              UserPromptSubmit: CODEBUDDY_QUICK,
              PreToolUse: [{ matcher: "*", hooks: [codebuddyHook(5)] }],
              Notification: CODEBUDDY_QUICK,
              Stop: CODEBUDDY_QUICK,
              PermissionRequest: [{ matcher: "*", hooks: [codebuddyHook(115)] }],
            },
            permissions: { allow: ["mcp__sikeoop__list_peers", "mcp__sikeoop__send_to"] },
          },
        },
      },
      { path: "mcp.json", content: { json: { mcpServers: { sikeoop: { command: "{mcpBin}", args: "{mcpArgs}", env: "{mcpEnv}" } } } } },
    ],
    turnEnd: "hook",
    notes: ["CodeBuddy 用的是你自己的 CodeBuddy 登录和模型；这次会话额外加了上报给 sikeoop 的钩子和 sikeoop 的 MCP。"],
  },
];
