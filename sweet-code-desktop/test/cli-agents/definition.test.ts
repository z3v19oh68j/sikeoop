// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { BUNDLED } from "../../src/main/cli-agents/bundled.ts";
import { expand, parseDefinition, passthrough, placeholders, planLaunch, type LaunchContext } from "../../src/main/cli-agents/definition.ts";

const ctx: LaunchContext = {
  root: "/work/app",
  name: "OpenCode-1",
  sessionDir: "/cache/opencode/abc123",
  hookUrl: "http://127.0.0.1:5000/hook/tok",
  mcpUrl: "http://127.0.0.1:5000/rpc/tok",
  mcpCommand: ["/Applications/sikeoop", "/data/bridge.cjs", "http://127.0.0.1:5000/rpc/tok"],
  mcpEnv: { ELECTRON_RUN_AS_NODE: "1" },
  instructions: '你是 OpenCode-1，用 "send_to" 联系别人。',
};
const minimal = { id: "mycli", name: "My CLI", label: "MyCli", bin: ["mycli"], turnEnd: "quiet" };

test("the smallest definition is accepted; args default to none", () => {
  const r = parseDefinition(minimal);
  assert.ok(r.ok);
  assert.deepEqual(r.def.args, []);
  assert.deepEqual(planLaunch(r.def, ctx), { args: [], env: {}, files: [] });
});

test("every problem in a definition is reported, in the author's terms", () => {
  const r = parseDefinition({ id: "Claude", name: "", label: "My-Cli", bin: ["/usr/bin/x"], args: [1], env: { A: 1 }, files: [{ path: "../x", content: "" }], quietMs: 5 });
  assert.ok(!r.ok);
  for (const field of ["id", "name", "label", "bin", "args", "env", "files[0].path", "turnEnd", "quietMs"]) {
    assert.ok(r.problems.some((p) => p.startsWith(`${field}：`)), `missing a problem for ${field}: ${r.problems.join(" | ")}`);
  }
  assert.ok(!parseDefinition([]).ok);
  assert.ok(!parseDefinition(null).ok);
});

test("built-in ids and names can't be taken", () => {
  for (const id of ["claude", "codex", "shell"]) {
    const r = parseDefinition({ ...minimal, id });
    assert.ok(!r.ok && r.problems[0].includes("内置"));
  }
  assert.ok(!parseDefinition({ ...minimal, label: "codex" }).ok, "its sessions would be called Codex-1");
});

test("files stay inside the session's folder", () => {
  for (const p of ["/etc/passwd", "../../.zshrc", "a/../../b", "C:\\Users\\x", "..\\x"]) {
    assert.ok(!parseDefinition({ ...minimal, files: [{ path: p, content: "x" }] }).ok, p);
  }
  assert.ok(parseDefinition({ ...minimal, files: [{ path: "plugins/a.js", content: "x" }] }).ok);
  // A placeholder can't smuggle a path out either.
  const r = parseDefinition({ ...minimal, files: [{ path: "{root}/x", content: "x" }] });
  assert.ok(r.ok);
  assert.throws(() => planLaunch(r.def, ctx), /跑出了会话目录/);
});

test("placeholders: text inside a string, the value itself when alone, JSON on request", () => {
  const vars = placeholders(ctx);
  assert.equal(expand("--cd={root}", vars), "--cd=/work/app");
  assert.deepEqual(expand("{mcpCommand}", vars), ctx.mcpCommand);
  assert.deepEqual(expand("{mcpEnv}", vars), { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(expand("cmd={mcpArgs}", vars), `cmd=${JSON.stringify(ctx.mcpCommand.slice(1))}`);
  assert.equal(expand("const WHO = {json:instructions};", vars), `const WHO = ${JSON.stringify(ctx.instructions)};`);
  assert.equal(expand("{sessionDirUrl}/p.js", vars), "file:///cache/opencode/abc123/p.js");
  // Code keeps its own braces.
  assert.equal(expand("async ({ event }) => { return {unknown}; }", vars), "async ({ event }) => { return {unknown}; }");
  assert.deepEqual(expand({ a: ["{name}", 1, { b: "{hookUrl}" }] }, vars), { a: ["OpenCode-1", 1, { b: ctx.hookUrl }] });
});

test("a launch plan: array placeholders spread into arguments, { json } values are serialized", () => {
  const r = parseDefinition({
    ...minimal,
    args: ["--workspace", "{root}", "--mcp", "{mcpBin}", "{mcpArgs}"],
    env: { PLAIN: "x-{name}", CONFIG: { json: { mcp: { command: "{mcpCommand}", env: "{mcpEnv}" } } } },
    envPassthrough: ["MYCLI_*", "HTTP_TOKEN"],
    files: [{ path: "conf/settings.json", content: { json: { hook: "{hookUrl}" } } }, { path: "who.md", content: "{instructions}" }],
  });
  assert.ok(r.ok);
  const plan = planLaunch(r.def, ctx);
  assert.deepEqual(plan.args, ["--workspace", "/work/app", "--mcp", ctx.mcpCommand[0], ...ctx.mcpCommand.slice(1)]);
  assert.equal(plan.env.PLAIN, "x-OpenCode-1");
  assert.deepEqual(JSON.parse(plan.env.CONFIG), { mcp: { command: ctx.mcpCommand, env: ctx.mcpEnv } });
  assert.equal(plan.files[0].path, path.join(ctx.sessionDir, "conf/settings.json"));
  assert.deepEqual(JSON.parse(plan.files[0].content), { hook: ctx.hookUrl });
  assert.equal(plan.files[1].content, ctx.instructions);
  assert.deepEqual(passthrough(r.def), { keys: ["HTTP_TOKEN"], prefixes: ["MYCLI_"] });
});

test("the bundled opencode definition is valid and produces opencode's config", () => {
  const r = parseDefinition(BUNDLED[0]);
  assert.ok(r.ok, r.ok ? "" : r.problems.join(" | "));
  const plan = planLaunch(r.def, ctx);
  assert.deepEqual(plan.args, ["/work/app"]);
  const config = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.mcp.sikeoop, { type: "local", command: ctx.mcpCommand, environment: ctx.mcpEnv, enabled: true });
  assert.deepEqual(config.instructions, ["/cache/opencode/abc123/sikeoop.md"]);
  assert.deepEqual(config.plugin, ["file:///cache/opencode/abc123/sikeoop-plugin.js"]);
  const plugin = plan.files.find((f) => f.path.endsWith("sikeoop-plugin.js"))!.content;
  assert.ok(plugin.includes(`const HOOK = "${ctx.hookUrl}";`), "the hook address is filled in as a string literal");
  assert.ok(!/\{json:/.test(plugin), "no placeholder is left");
  assert.ok(plugin.includes("async ({ directory })"), "its own code is untouched");
});
