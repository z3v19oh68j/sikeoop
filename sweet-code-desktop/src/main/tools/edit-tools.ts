import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { z } from "zod";
import { IGNORED_DIRS, resolveSafe, toRel } from "../workspace";
import { hashText } from "./fs-tools";
import { defineTool, type ToolContext } from "./registry";
import { fileLocks } from "../session/locks";

const MAX_FILE_CHARS = 512 * 1024;

const EXPLANATION_SCHEMA = {
  type: "string",
  description:
    "One short sentence, in the user's language, telling a beginner what this change does and why. " +
    "Shown above the diff when the user decides whether to accept it.",
};

/** Agent writes stay out of dependency, build and git folders. */
function assertWritable(rel: string) {
  const parts = rel.split("/");
  const hit = parts.find((p) => IGNORED_DIRS.has(p));
  if (hit) throw new Error(`Refusing to write inside ${hit}/. Those files are generated or managed by tools.`);
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function rejected(outcome: { feedback?: string }): string {
  const note = outcome.feedback?.trim();
  return note
    ? `The user rejected this change and said: "${note}". Do not retry the same change; adjust to the feedback.`
    : "The user rejected this change. Do not retry the same change; ask what they would like instead.";
}

/** Claim the file for this session so a terminal Claude/Codex session can't write it at the same time. */
async function lockFile(ctx: ToolContext, abs: string, rel: string): Promise<void> {
  const refused = await ctx.guardWrite?.(abs);
  if (refused) throw new Error(`Not allowed to write ${rel}: ${refused}`);
  const lock = await fileLocks.acquire(ctx.lockOwner, [abs]);
  if (!lock.ok) throw new Error(`${rel} is being edited by ${lock.owner} right now. Wait for it to finish, then read the file again.`);
}

async function writeApproved(
  ctx: ToolContext,
  abs: string,
  rel: string,
  before: string | null,
  after: string,
): Promise<void> {
  // The user may have edited or created the file while the approval card was open.
  let now: string | null = null;
  try {
    now = await fs.readFile(abs, "utf8");
  } catch {
    now = null;
  }
  if (now !== before) {
    throw new Error(`${rel} changed while waiting for approval. Read it again and redo the edit.`);
  }
  // Check the boundary again before creating folders and before writing: a folder on the way
  // may have been swapped for a link while the card was open.
  const recheck = async () => {
    if ((await resolveSafe(rel)) !== abs) throw new Error(`${rel} moved while waiting for approval. Read it again and redo the edit.`);
  };
  await recheck();
  await fs.mkdir(nodePath.dirname(abs), { recursive: true });
  await recheck();
  await fs.writeFile(abs, after, "utf8");
  ctx.readTracker.set(rel, hashText(after));
  ctx.recordWrite(rel, before, after);
}

export const editFile = defineTool({
  name: "edit_file",
  description:
    "Change an existing file by replacing an exact piece of text. Read the file with read_file first; " +
    "the edit is refused if the file changed since. old_string must match the file exactly, including " +
    "indentation, and must be unique unless replace_all is true. Include enough surrounding lines to make it unique. " +
    "Keep each edit small and focused. The user reviews every edit as a diff before it is written.",
  schema: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
    explanation: z.string().min(1),
  }),
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project root." },
      old_string: { type: "string", description: "Exact text to replace, copied from the file without line numbers." },
      new_string: { type: "string", description: "Text to put in its place." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one." },
      explanation: EXPLANATION_SCHEMA,
    },
    required: ["path", "old_string", "new_string", "explanation"],
  },
  permission: "confirm",
  parallelSafe: false,
  summarize: (i) => `修改 ${i.path}`,
  async run({ path, old_string, new_string, replace_all, explanation }, ctx) {
    const abs = await resolveSafe(path);
    const rel = toRel(abs);
    assertWritable(rel);

    let before: string;
    try {
      before = await fs.readFile(abs, "utf8");
    } catch {
      throw new Error(`${rel} does not exist. Use create_file to make a new file.`);
    }
    const seen = ctx.readTracker.get(rel);
    if (!seen) throw new Error(`Read ${rel} with read_file before editing it.`);
    if (seen !== hashText(before)) throw new Error(`${rel} changed since you last read it. Read it again before editing.`);

    if (old_string === new_string) throw new Error("old_string and new_string are the same; nothing to change.");
    const n = count(before, old_string);
    if (n === 0) {
      throw new Error(
        `old_string was not found in ${rel}. It must match exactly, including spaces and indentation, ` +
          "without the line numbers that read_file adds.",
      );
    }
    if (n > 1 && !replace_all) {
      throw new Error(`old_string appears ${n} times in ${rel}. Include more surrounding lines, or set replace_all.`);
    }
    const after = replace_all ? before.split(old_string).join(new_string) : before.replace(old_string, () => new_string);
    if (after.length > MAX_FILE_CHARS) throw new Error("The edited file would be too large.");

    await lockFile(ctx, abs, rel);
    const outcome = await ctx.requestApproval({ kind: "file", path: rel, before, after, created: false, explanation });
    if (!outcome.approved) return rejected(outcome);

    await writeApproved(ctx, abs, rel, before, after);
    return `Edited ${rel}${replace_all && n > 1 ? ` (${n} replacements)` : ""}. The user approved the change.`;
  },
});

export const createFile = defineTool({
  name: "create_file",
  description:
    "Create a new file with the given content. Folders in the path are created as needed. " +
    "Fails if the file already exists; use edit_file to change existing files. " +
    "The user reviews the new file before it is written.",
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
    explanation: z.string().min(1),
  }),
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "New file path relative to the project root." },
      content: { type: "string", description: "Full content of the new file." },
      explanation: EXPLANATION_SCHEMA,
    },
    required: ["path", "content", "explanation"],
  },
  permission: "confirm",
  parallelSafe: false,
  summarize: (i) => `新建 ${i.path}`,
  async run({ path, content, explanation }, ctx) {
    const abs = await resolveSafe(path);
    const rel = toRel(abs);
    assertWritable(rel);
    const exists = await fs.stat(abs).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`${rel} already exists. Read it and use edit_file instead.`);
    if (content.length > MAX_FILE_CHARS) throw new Error("The file content is too large.");

    await lockFile(ctx, abs, rel);
    const outcome = await ctx.requestApproval({ kind: "file", path: rel, before: "", after: content, created: true, explanation });
    if (!outcome.approved) return rejected(outcome);

    await writeApproved(ctx, abs, rel, null, content);
    return `Created ${rel}. The user approved the change.`;
  },
});

export const EDIT_TOOLS = [editFile, createFile];
