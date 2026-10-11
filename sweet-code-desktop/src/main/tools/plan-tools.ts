import { z } from "zod";
import { defineTool, type ToolSpec } from "./registry";

const STATUS = ["pending", "in_progress", "done", "skipped"] as const;
const LABEL = { pending: "待做", in_progress: "进行中", done: "完成", skipped: "跳过" } as const;

/** A checklist the agent keeps for multi-step work; shown to the user and to the reviewer. */
export const updatePlan = defineTool({
  name: "update_plan",
  description:
    "Write or update your step-by-step plan for a multi-step task. Send the whole list every time (it replaces the previous one). " +
    "Use short Chinese steps a beginner understands, keep exactly one step in_progress while you work, " +
    "and mark steps done as soon as they are finished. Skip this for small one-step requests.",
  schema: z.object({
    items: z.array(z.object({ text: z.string().min(1), status: z.enum(STATUS) })).min(1).max(30),
  }),
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "The full plan, in order.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "One step, a short sentence." },
            status: { type: "string", enum: [...STATUS] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["items"],
  },
  permission: "auto",
  parallelSafe: false,
  summarize: (i) => {
    const done = i.items.filter((x) => x.status === "done").length;
    return `更新计划（${done}/${i.items.length} 完成）`;
  },
  async run({ items }, ctx) {
    ctx.updatePlan(items);
    return "计划已更新：\n" + items.map((x, n) => `${n + 1}. [${LABEL[x.status]}] ${x.text}`).join("\n");
  },
});

export const PLAN_TOOLS = [updatePlan] as ToolSpec[];
