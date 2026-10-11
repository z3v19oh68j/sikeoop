import { z } from "zod";
import { defineTool, type ToolSpec } from "./registry.ts";

// dispatch_agent: hands one step of work to a Harmony cluster role. The role runs in its own
// session (see index.ts); this tool only builds the input envelope and returns the role's final
// envelope. Each dispatch asks the user first, because the role may edit files or run commands.

export interface DispatchDeps {
  /** readOnly: the role may not edit project files, so several of them can work at once. */
  roles: { name: string; description: string; readOnly?: boolean }[];
  /** Runs one role in a fresh session and resolves with its final envelope text. parentJobId: the dispatch job the caller is on. */
  run(
    role: string,
    envelope: string,
    signal: AbortSignal,
    goal: string,
    parentJobId?: string,
    limits?: { owns?: string[]; typecheck?: string },
  ): Promise<string>;
}

const MAX_RESULT = 8000;
export const OWNS_DESCRIPTION =
  "它负责的文件（相对项目根；以 / 结尾表示整个文件夹，支持 * 和 **）。填了以后它只能改这些，改到别处会被拒绝或在验收里标红。";
export const TYPECHECK_DESCRIPTION = "做完后跑的类型检查命令（如 npm run typecheck），只报告比开始前新增的错误。";

const schema = z.object({
  role: z.string(),
  goal: z.string(),
  files: z.array(z.string()).optional(),
  context: z.string().optional(),
  upstream: z.string().optional(),
  acceptance: z.array(z.string()),
  owns: z.array(z.string()).optional(),
  typecheck: z.string().optional(),
});

export function dispatchTools(deps: DispatchDeps): ToolSpec[] {
  const names = deps.roles.map((r) => r.name);
  return [
    defineTool({
      name: "dispatch_agent",
      description:
        "把一步工作交给鸿蒙开发集群中的独立子代理执行。每个角色在自己的会话里运行，你只拿到它最终的输出信封（status、summary、changed_files、errors、route）。" +
        "按流水线推进：根据返回的 status 与 route.role 决定下一步；blocked 时直接报告用户，不要继续分派。" +
        "标了「只读」的角色互不影响，可以在同一轮里同时分派多个。\n可用角色：\n" +
        deps.roles.map((r) => `- ${r.name}${r.readOnly ? "（只读）" : ""}：${r.description}`).join("\n"),
      schema,
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string", enum: names, description: "要分派的角色名" },
          goal: { type: "string", description: "一句话目标" },
          files: { type: "array", items: { type: "string" }, description: "相关文件路径（相对项目根）" },
          context: { type: "string", description: "必要背景，只写事实，不超过 300 字" },
          upstream: { type: "string", description: "前一个角色输出信封中的 summary，没有则留空" },
          acceptance: { type: "array", items: { type: "string" }, description: "验收标准，逐条可检查" },
          owns: { type: "array", items: { type: "string" }, description: OWNS_DESCRIPTION },
          typecheck: { type: "string", description: TYPECHECK_DESCRIPTION },
        },
        required: ["role", "goal", "acceptance"],
      },
      permission: "confirm",
      // Roles that cannot edit project files don't get in each other's way.
      parallelSafe: (i) => !!deps.roles.find((r) => r.name === i.role)?.readOnly,
      summarize: (i) => `分派给 ${i.role}：${i.goal.slice(0, 40)}`,
      async run(input, ctx) {
        const role = deps.roles.find((r) => r.name === input.role);
        if (!role) return `Error: 没有这个角色「${input.role}」。可用角色：${names.join("、")}`;

        const envelope = buildEnvelope(input);
        const outcome = await ctx.requestApproval({
          kind: "tool",
          server: "harmony-cluster",
          tool: role.name,
          description: input.goal,
          args: envelope,
        });
        if (!outcome.approved) return `用户没有同意分派给 ${role.name}。${outcome.feedback ?? ""}`.trim();

        const result = await deps.run(role.name, envelope, ctx.signal, input.goal, ctx.dispatchJobId, { owns: input.owns, typecheck: input.typecheck });
        return result.length > MAX_RESULT ? result.slice(0, MAX_RESULT) + "\n…（输出过长，已截断）" : result;
      },
    }),
  ];
}

/** The input envelope from contract.md, written as YAML. Strings go through JSON so quoting is always valid. */
export function buildEnvelope(input: z.infer<typeof schema>): string {
  const q = (s: string) => JSON.stringify(s);
  const list = (items: string[] | undefined, indent: string) =>
    items && items.length > 0 ? "\n" + items.map((i) => `${indent}- ${q(i)}`).join("\n") : " []";
  return [
    `role: ${q(input.role)}`,
    `goal: ${q(input.goal)}`,
    "inputs:",
    `  files:${list(input.files, "    ")}`,
    `  context: ${q(input.context ?? "")}`,
    `  upstream: ${q(input.upstream ?? "")}`,
    "acceptance:" + list(input.acceptance, "  "),
  ].join("\n");
}
