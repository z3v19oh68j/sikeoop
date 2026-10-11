import { z } from "zod";
import { defineTool, type ToolSpec } from "../tools/registry.ts";

/**
 * report_outcome: how an agent step tells the state machine where to go next. Only automation
 * conversations have it. The allowed outcomes change from step to step, so they are checked here
 * (by `accept`) rather than in the schema, which stays fixed for the prompt cache.
 */
export function reportOutcomeTool(accept: (outcome: string, summary: string) => string | null): ToolSpec {
  return defineTool({
    name: "report_outcome",
    description:
      "Only in automation runs: report how the current step ended, so the automation knows which step comes next. " +
      "Call it once, when the step's work is finished, with one of the outcomes listed in the step's <automation> block. " +
      "Then end your reply with a short summary; do not start other work.",
    schema: z.object({ outcome: z.string().min(1), summary: z.string().min(1) }),
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", description: "Exactly one of the outcomes listed for this step." },
        summary: { type: "string", description: "One or two sentences, in the user's language: what happened in this step." },
      },
      required: ["outcome", "summary"],
    },
    permission: "auto",
    parallelSafe: false,
    summarize: (i) => `报告结果：${i.outcome}`,
    async run({ outcome, summary }) {
      const problem = accept(outcome.trim(), summary.trim());
      if (problem) throw new Error(problem);
      return "Recorded. Finish your reply with a short summary now.";
    },
  }) as ToolSpec;
}
