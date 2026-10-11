// Release notes (the markdown of 更新公告/sikeoop-x.y.z.md, HTML tags already stripped by main/updater.ts)
// → the three 「本次更新」 rows of the EVA update card, plus a plain version for 「查看全部更新说明」.

export type NoteIcon = "folder" | "ai-network" | "wrench" | "release-notes" | "activity";

export interface NoteRow {
  title: string;
  icon: NoteIcon;
}

type Section = "new" | "better" | "fix" | "other";

const SECTION_ORDER: Section[] = ["new", "better", "fix", "other"];

function sectionOf(heading: string): Section {
  if (/新增|新功能|new|feature/i.test(heading)) return "new";
  if (/改进|优化|improve|change/i.test(heading)) return "better";
  if (/修复|fix|bug/i.test(heading)) return "fix";
  return "other";
}

/** The bold lead of a bullet, else its first sentence; inline markdown removed. */
function titleOf(text: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  const raw = bold ? bold[1] : text.split(/[。！？；：:!?]/)[0];
  const clean = plain(raw).replace(/[：:，,\s]+$/, "").trim();
  return clean.length > 26 ? `${clean.slice(0, 25)}…` : clean;
}

function iconOf(title: string, section: Section): NoteIcon {
  if (section === "fix" || /修复|修好|bug/i.test(title)) return "wrench";
  if (/模型|AI|对话|CLI|派活|调度|路由|集群|智能|审批/i.test(title)) return "ai-network";
  if (/文件|项目|目录|工作区|侧栏|欢迎页|页面|设置|插件/.test(title)) return "folder";
  return section === "new" ? "release-notes" : "activity";
}

/** Markdown emphasis, code and links → plain text. */
export function plain(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s*/gm, "");
}

export function noteRows(notes: string | undefined, max = 3): NoteRow[] {
  if (!notes?.trim()) return [];
  const buckets: Record<Section, NoteRow[]> = { new: [], better: [], fix: [], other: [] };
  let section: Section = "other";
  for (const line of notes.split(/\r?\n/)) {
    const h = /^#{2,3}\s+(.+)/.exec(line);
    if (h) {
      section = sectionOf(h[1]);
      continue;
    }
    // Top-level bullets only; nested ones are details of the bullet above.
    const b = /^[-*+]\s+(.+)/.exec(line);
    if (!b) continue;
    const title = titleOf(b[1]);
    if (title) buckets[section].push({ title, icon: iconOf(title, section) });
  }
  return SECTION_ORDER.flatMap((s) => buckets[s]).slice(0, max);
}

/** The whole notes, readable without markdown marks. */
export const notesText = (notes: string) => plain(notes).trim();
