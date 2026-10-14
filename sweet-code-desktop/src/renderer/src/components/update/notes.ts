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

// The same notes in full, for the release-notes view (ReleaseNotes.tsx): a tagline, then sections of bullets.

export type NoteTone = "new" | "better" | "fix" | "warn" | "plain";

export interface NoteItem {
  /** The bold lead of the bullet, "" when it has none. */
  lead: string;
  /** The rest of the bullet. */
  text: string;
  /** Nested bullets under it. */
  details: string[];
}

export interface NoteSection {
  heading: string;
  tone: NoteTone;
  items: NoteItem[];
  /** Lines of the section that are not bullets. */
  paragraphs: string[];
}

export interface ParsedNotes {
  /** The quoted line under the title. */
  tagline: string;
  sections: NoteSection[];
}

function toneOf(heading: string): NoteTone {
  if (/注意|警告|须知|warning|breaking/i.test(heading)) return "warn";
  const s = sectionOf(heading);
  return s === "other" ? "plain" : s;
}

function itemOf(text: string): NoteItem {
  const bold = /^\*\*(.+?)\*\*\s*[：:]?\s*(.*)$/.exec(text);
  return bold ? { lead: plain(bold[1]).replace(/[：:]\s*$/, ""), text: plain(bold[2]), details: [] } : { lead: "", text: plain(text), details: [] };
}

export function parseNotes(notes: string | undefined): ParsedNotes {
  const out: ParsedNotes = { tagline: "", sections: [] };
  if (!notes?.trim()) return out;
  let section: NoteSection | null = null;
  // Text before the first heading goes in a section without one.
  const current = () => (section ??= out.sections[out.sections.push({ heading: "", tone: "plain", items: [], paragraphs: [] }) - 1]);
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^#\s+/.test(line)) continue; // the title: the card already says which version this is
    const h = /^#{2,6}\s+(.+)/.exec(line);
    if (h) {
      const heading = plain(h[1]).trim();
      section = { heading, tone: toneOf(heading), items: [], paragraphs: [] };
      out.sections.push(section);
      continue;
    }
    const quote = /^>\s?(.*)/.exec(line);
    if (quote && !section && !out.tagline) {
      out.tagline = plain(quote[1]).trim();
      continue;
    }
    const nested = /^\s+[-*+]\s+(.+)/.exec(line);
    const last = section?.items[section.items.length - 1];
    if (nested && last) {
      last.details.push(plain(nested[1]).trim());
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)/.exec(line);
    if (bullet) current().items.push(itemOf(bullet[1].trim()));
    else current().paragraphs.push(plain(line).trim());
  }
  out.sections = out.sections.filter((s) => s.items.length || s.paragraphs.length);
  return out;
}
