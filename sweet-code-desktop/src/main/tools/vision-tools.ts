import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ImageInput } from "@shared/types";
import { resolveSafe } from "../workspace";
import { defineTool, type ToolSpec } from "./registry";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const MAX_BYTES = 8 * 1024 * 1024;

export type Analyze = (images: ImageInput[], question: string, signal: AbortSignal) => Promise<string>;

/** Lets the agent look at image files in the project (screenshots, mockups) through the vision model. */
export function visionTools(analyze: Analyze): ToolSpec[] {
  const viewImage = defineTool({
    name: "view_image",
    description:
      "Look at an image file in the project (png, jpg, webp, gif) and get a written description from a vision model, " +
      "including any text in it transcribed exactly. Ask a specific question to get a focused answer.",
    schema: z.object({ path: z.string().min(1), question: z.string().optional() }),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Image path relative to the project root." },
        question: { type: "string", description: "What you want to know about the image." },
      },
      required: ["path"],
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `看图 ${i.path}`,
    async run({ path: rel, question }, { signal }) {
      const abs = await resolveSafe(rel);
      const mime = MIME[path.extname(abs).toLowerCase()];
      if (!mime) throw new Error(`${rel} is not a supported image (png, jpg, webp, gif).`);
      const st = await fs.stat(abs);
      if (st.size > MAX_BYTES) throw new Error(`${rel} is too large to look at (over 8 MB).`);
      const data = (await fs.readFile(abs)).toString("base64");
      return analyze([{ mime, data }], question ?? "", signal);
    },
  });
  return [viewImage] as ToolSpec[];
}
