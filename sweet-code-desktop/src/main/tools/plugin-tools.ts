import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpManager } from "../plugins/mcp";
import { type SkillStore, splitFrontmatter } from "../plugins/skills";
import { defineTool, type ToolSpec } from "./registry";

const MAX_SKILL_FILE_CHARS = 120_000;

/** Tools that let the agent open an installed skill once it decides the skill is relevant. */
export function skillTools(store: SkillStore): ToolSpec[] {
  const useSkill = defineTool({
    name: "use_skill",
    description:
      "Load the full instructions of an installed skill. The available skills are listed at the start of the " +
      "conversation; call this as soon as a task matches one, then follow its instructions. The result also lists " +
      "the skill's other files, which you can open with read_skill_file.",
    schema: z.object({ name: z.string().min(1) }),
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The skill name, exactly as listed." } },
      required: ["name"],
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `使用技能 ${i.name}`,
    async run({ name }) {
      const dir = store.dirOf(name);
      let md: string;
      try {
        md = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
      } catch {
        throw new Error(`No installed skill named "${name}". Use one of the skills listed at the start of the conversation.`);
      }
      const files = (await listFiles(dir)).filter((f) => f !== "SKILL.md" && f !== ".sweet.json");
      const { body } = splitFrontmatter(md);
      return [
        `Skill "${name}" (folder: ${dir})`,
        files.length ? `Other files in this skill:\n${files.map((f) => `- ${f}`).join("\n")}` : "",
        "Scripts in the skill folder can be run with run_command using their full path.",
        "",
        body.trim(),
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const readSkillFile = defineTool({
    name: "read_skill_file",
    description: "Read a reference file inside an installed skill's folder, by its path relative to that folder.",
    schema: z.object({ name: z.string().min(1), path: z.string().min(1) }),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name." },
        path: { type: "string", description: "File path relative to the skill folder, e.g. reference/forms.md" },
      },
      required: ["name", "path"],
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `阅读技能文件 ${i.name}/${i.path}`,
    async run({ name, path: rel }) {
      const dir = store.dirOf(name);
      const target = path.resolve(dir, rel);
      if (!target.startsWith(dir + path.sep)) throw new Error("That path is outside the skill folder.");
      const text = await fs.readFile(target, "utf8");
      return text.length > MAX_SKILL_FILE_CHARS ? text.slice(0, MAX_SKILL_FILE_CHARS) + "\n…（文件太长，已截断）" : text;
    },
  });

  return [useSkill, readSkillFile] as ToolSpec[];
}

/** One tool per tool of each connected MCP server, named mcp__<server>__<tool>. */
export function mcpTools(mcp: McpManager): ToolSpec[] {
  const out: ToolSpec[] = [];
  for (const { server, trusted, tools } of mcp.connected()) {
    for (const t of tools) {
      out.push(
        defineTool({
          name: toolName(server, t.name),
          description: `[MCP · ${server}] ${t.description}`.slice(0, 1024),
          schema: z.record(z.string(), z.unknown()),
          inputSchema: cleanSchema(t.inputSchema),
          // Trusted servers run straight away; otherwise each call is shown first ("approve all" applies).
          permission: trusted ? "auto" : "confirm",
          parallelSafe: trusted && t.readOnly,
          summarize: () => `${server} · ${t.name}`,
          async run(args, ctx) {
            if (!mcp.isTrusted(server)) {
              const outcome = await ctx.requestApproval({
                kind: "tool",
                server,
                tool: t.name,
                description: t.description,
                args: JSON.stringify(args, null, 2),
              });
              if (!outcome.approved) {
                return outcome.feedback?.trim()
                  ? `The user declined this tool call and said: "${outcome.feedback.trim()}".`
                  : "The user declined this tool call. Ask what they would like instead.";
              }
            }
            const res = await mcp.call(server, t.name, args, ctx.signal);
            const text = formatResult(res);
            if (res.isError) throw new Error(text || "The MCP tool reported an error.");
            return text || "(no output)";
          },
        }),
      );
    }
  }
  return out;
}

/** Both Claude and OpenAI accept [A-Za-z0-9_-]{1,64} as a tool name. */
function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length <= 64) return name;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 6);
  return `${name.slice(0, 57)}_${hash}`;
}

/** Tool parameters must be a JSON-schema object; drop the meta keys some servers include. */
function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema ?? {};
  return rest.type === "object" ? rest : { properties: {}, ...rest, type: "object" };
}

type CallResult = Awaited<ReturnType<McpManager["call"]>>;

/** MCP results are content blocks; the agent gets their text, with images and resources named. */
function formatResult(res: CallResult): string {
  const parts: string[] = [];
  for (const c of (res.content ?? []) as Record<string, unknown>[]) {
    if (c.type === "text") parts.push(String(c.text));
    else if (c.type === "image" || c.type === "audio") parts.push(`[${c.type}：${String(c.mimeType ?? "")}，已省略]`);
    else if (c.type === "resource") {
      const r = c.resource as Record<string, unknown>;
      parts.push(typeof r?.text === "string" ? r.text : `[资源 ${String(r?.uri ?? "")}]`);
    } else if (c.type === "resource_link") parts.push(`[资源链接 ${String(c.uri)}]`);
  }
  if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent, null, 2));
  return parts.join("\n").slice(0, 100_000);
}

async function listFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
    if (out.length > 200) break;
  }
  return out;
}
