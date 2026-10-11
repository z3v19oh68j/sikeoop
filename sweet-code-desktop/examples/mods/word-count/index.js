// A sikeoop mod: CommonJS, exports activate(api). See docs/mod-dev.md.
const fs = require("node:fs/promises");
const path = require("node:path");

/** @param {import("../../../docs/sikeoop-mod").SikeoopModApi} api */
exports.activate = (api) => {
  // A read-only tool: "auto" runs it without asking.
  api.tools.register({
    name: "count_words",
    description: "Count the characters, words and lines of a text file in the project.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path, relative to the project folder." } },
      required: ["path"],
    },
    permission: "auto",
    summary: (input) => `统计 ${input.path} 的字数`,
    async run(input, ctx) {
      const file = path.resolve(ctx.root, String(input.path));
      if (!file.startsWith(ctx.root + path.sep)) throw new Error("Only files inside the project.");
      const text = await fs.readFile(file, "utf8");
      const count = (api.storage.get("count") ?? 0) + 1;
      await api.storage.set("count", count);
      return `chars: ${text.length}, words: ${text.split(/\s+/).filter(Boolean).length}, lines: ${text.split("\n").length}`;
    },
  });

  // A hook: before a command that deletes files runs, leave the decision to the user.
  api.hooks.on("PreToolUse", (input) => {
    const cmd = String((input.tool_input && input.tool_input.command) || "");
    if (/\brm\s/.test(cmd)) {
      api.notify("字数统计 mod", `AI 想删除文件：${cmd.slice(0, 80)}`);
      return { permission: { decision: "ask", reason: "删除文件前请你确认" } };
    }
  });

  api.log("activated");
  api.onDispose(() => api.log("stopped"));
};
