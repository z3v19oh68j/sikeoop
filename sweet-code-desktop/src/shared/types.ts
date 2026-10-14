// Types shared by the main process, preload bridge and renderer.

export interface FileNode {
  name: string;
  /** Path relative to the workspace root, using "/" separators. */
  path: string;
  kind: "file" | "dir";
  children?: FileNode[];
}

/** A project folder opened before, for the start page. */
export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
  /** False when the folder was moved or deleted since. */
  exists: boolean;
}

export interface EditorContext {
  /** Relative path of the file open in the editor, if any. */
  activeFile?: string;
  /** Text the user has selected in the editor, if any. */
  selection?: string;
}

/** Thinking depth. Only Claude models use it; other providers ignore it. */
export type Effort = "low" | "medium" | "high";
export type EffortPurpose = "chat" | "coding" | "hard" | "subtask" | "compress";
/** Clipboard event provenance, with the exact text still present in the submitted message. */
export interface PastedContentRange {
  source: "clipboard";
  start: number;
  end: number;
  text: string;
}

/** An image the user attached: already resized in the renderer, as base64 without the data: prefix. */
export interface ImageInput {
  mime: string;
  data: string;
}

/** A non-image file the user attached; its text is read in the renderer and handed to the agent. */
export interface FileInput {
  name: string;
  /** The file's text (for a PDF, the extracted text). */
  text: string;
  /** Size of the original file in bytes. */
  size: number;
  /** The text was cut short to fit the context. */
  truncated?: boolean;
}

/** What the chat keeps of an attached file: enough to show a chip, not the contents. */
export interface FileChip {
  name: string;
  size: number;
}

export interface ChatRequest {
  text: string;
  editor: EditorContext;
  effort: Effort;
  /** Explicit Claude override; absent selects effort by purpose and routing settings. */
  effortOverride?: Effort;
  /** Only populated from a known clipboard paste event, never guessed from message length. */
  pastedContent?: PastedContentRange[];
  /** Images to read with the vision model before the agent answers. */
  images?: ImageInput[];
  /** Small data-URL previews of those images, kept in the saved conversation. */
  thumbs?: string[];
  /** Text, code and PDF files, read in full into the message. */
  files?: FileInput[];
  /**
   * Long-task mode: the agent works through the whole task without stopping to ask, and the
   * reviewer sub-agent answers approvals instead of the user (it can still hand one back).
   */
  autopilot?: boolean;
  /**
   * Lazy mode, on top of long-task mode: every action is approved by itself (no reviewer, no
   * user), questions take the recommendations, and a fixed list of dangerous actions is refused.
   */
  lazy?: boolean;
  /**
   * Super-dispatch mode, on top of lazy mode: the agent only coordinates. It splits the task,
   * hands the parts to the online AIs (terminal sessions and configured models) and checks what
   * comes back; it does not edit files or run commands itself.
   */
  orchestrate?: boolean;
  /** Authenticated remote origin. The main process, never the renderer/client payload, sets this. */
  origin?: { kind: "mobile"; deviceId: string; deviceName: string };
}

/** State rendered by the Android remote-control home screen. */
export interface MobileView {
  status: "idle" | "working" | "waiting" | "done" | "error" | "incomplete";
  presence: { online: boolean; lastSeenAt?: number };
  computer: { id: string; name: string };
  project?: { name: string; path?: string };
  turn?: {
    id: string;
    prompt: string;
    startedAt: number;
    currentActivity?: string;
    plan: PlanItem[];
    completedSteps: number;
    totalSteps: number;
  };
  pendingApprovals: number;
  lastReceipt?: { turnId: number; summary: string; changedFiles: number; completedAt: number };
  error?: string;
}

// ---- Editor extensions from Open VSX (main/extensions/) ----
// Only the declarative parts are used: color themes, TextMate grammars, language settings and
// snippets. Extension code (package.json "main"/"browser") is never run.

/** One search hit from open-vsx.org. id = "namespace.name". */
export interface ExtensionSearchItem {
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  iconUrl?: string;
  downloads?: number;
  rating?: number;
  verified?: boolean;
}

/** What an installed extension brings that sikeoop can use, and whether it also has code (ignored). */
export interface ExtensionSummary {
  themes: number;
  grammars: number;
  languages: number;
  snippets: number;
  /** File icon themes: listed but not applied yet. */
  iconThemes: number;
  /** The extension also has a program part, which sikeoop doesn't run. */
  hasCode: boolean;
}

export interface InstalledExtension {
  id: string;
  displayName: string;
  publisher: string;
  version: string;
  description: string;
  license?: string;
  /** The license isn't a plain open-source one: the user should read it (e.g. "SEE LICENSE IN …"). */
  licenseNote?: string;
  enabled: boolean;
  installedAt: number;
  summary: ExtensionSummary;
}

export interface ExtensionThemeRule {
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface ExtensionTheme {
  /** extensionId + "/" + label: stable across updates. */
  id: string;
  label: string;
  extensionId: string;
  uiTheme: "vs" | "vs-dark" | "hc-black" | "hc-light";
  colors: Record<string, string>;
  tokenColors: ExtensionThemeRule[];
}

export interface ExtensionGrammar {
  scopeName: string;
  /** The language this grammar highlights; absent for grammars only injected into others. */
  language?: string;
  /** The grammar file's text; format says how to parse it. */
  content: string;
  format: "json" | "plist";
  embeddedLanguages?: Record<string, string>;
  injectTo?: string[];
}

export interface ExtensionLanguage {
  id: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
  aliases?: string[];
  /** language-configuration.json, parsed (comments, brackets, auto-closing pairs…). */
  configuration?: Record<string, unknown>;
}

export interface ExtensionSnippetSet {
  language: string;
  extensionId: string;
  snippets: Record<string, { prefix: string | string[]; body: string | string[]; description?: string }>;
}

/** Everything the enabled extensions contribute, ready for the editor. */
export interface ExtensionContributions {
  themes: ExtensionTheme[];
  grammars: ExtensionGrammar[];
  languages: ExtensionLanguage[];
  snippets: ExtensionSnippetSet[];
}

/**
 * App updates (main/updater.ts). Windows installs download in the background and install on restart;
 * macOS (not notarized) and the Windows portable build can't replace themselves, so they get a
 * download link instead.
 */
export interface UpdateState {
  /** installing: restarting into the new version (the app is about to quit). */
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "none" | "error";
  current: string;
  /** The newer version found, if any. */
  version?: string;
  /** Download progress 0–100 while downloading. */
  percent?: number;
  /** True when this build installs updates itself; false = show the download page. */
  canInstall: boolean;
  /** The release notes (plain text) for the new version, when the server has them. */
  notes?: string;
  error?: string;
  /** Download new versions by themselves (installer builds). Off: "available" until updateDownload(). */
  autoDownload: boolean;
}

/** A phone enrolled with the desktop's phone gateway (public info only). */
export interface MobileDeviceInfo {
  id: string;
  name: string;
  addedAt: number;
  lastSeenAt?: number;
}

/** What the desktop's「手机」page shows (main/mobile/gateway.ts). */
export interface MobileGatewayState {
  enabled: boolean;
  /** False when the OS keychain can't hold the gateway's keys: the feature can't be turned on. */
  secretsAvailable: boolean;
  relay: {
    /** Where this computer connects. */
    url: string;
    /** Where the phone connects, as put in the QR code (the same relay seen from the phone). */
    phoneUrl: string;
    status: "off" | "connecting" | "connected" | "error";
    error?: string;
  };
  computer: { id: string; name: string };
  devices: MobileDeviceInfo[];
  /** The phone connected right now (one at a time). approved false = waiting for the person at the desktop. */
  phone?: { deviceId: string; deviceName: string; since: number; approved: boolean };
  /** A QR code is showing; it can be used once until expiresAt. */
  pairing?: { pairId: string; expiresAt: number };
  /** A phone scanned the code and proved it: the desktop must allow or deny it (auto-denied at expiresAt). */
  pendingDevice?: { id: string; name: string; at: number; expiresAt: number };
}

/** A new QR code: payload is the string to draw (sikeoop://pair/…). Shown once, never stored. */
export interface MobilePairingQr {
  payload: string;
  expiresAt: number;
}

export interface Balance {
  available: boolean;
  items: { currency: string; total: string; granted: string; toppedUp: string }[];
}

/**
 * Which model reviews actions in long-task mode. providerId "" = the conversation's own provider
 * and model, which needs no extra setup.
 */
/** One model of one provider. */
export interface ModelRef {
  providerId: string;
  model: string;
}

/**
 * Which model does what (docs: 动态模型路由). Every switch hands the conversation over with its
 * work so far, so the next model doesn't read the project again.
 */
export interface RoutingSettings {
  /** Backups tried in order when the conversation's model fails (rate limit, quota, outage, bad key). */
  failover: ModelRef[];
  /** Pick the model per message by how hard it looks. Off: always the active model. */
  difficulty: { enabled: boolean; light?: ModelRef; heavy?: ModelRef };
  /** Side jobs on their own model. Absent: the conversation's own. */
  purposes: { compress?: ModelRef; subtask?: ModelRef };
  /** Optional purpose overrides for effort-capable Claude models; other providers are unchanged. */
  effort?: Partial<Record<EffortPurpose, Effort>>;
  /** Per-purpose built-in free provider ids, highest priority first; omitted ids follow build order. */
  builtinFreeOrder?: Partial<Record<EffortPurpose, string[]>>;
}

export interface ReviewerSetting {
  providerId: string;
  model: string;
}

/** The reviewer sub-agent's answer to one approval request. */
export type ReviewDecision = "approve" | "reject" | "ask_human";

// ---- Auto-resume after a usage limit (quota/) ---------------------------------------------

/** A session that stopped on a usage limit and will be told to continue later. */
export interface ResumePlan {
  id: string;
  /** cli: a Claude Code / Codex terminal session (PeerBus id). chat: sikeoop's own conversation. */
  target: { kind: "cli"; sessionId: string; name: string } | { kind: "chat"; sessionId: string; title: string };
  /** What was seen, in plain words (e.g. "Claude Code 5 小时额度用完"). */
  reason: string;
  detectedAt: number;
  resumeAt: number;
  /** reset_time: read from the message; retry_after: from the API; default: no time found, the default delay. */
  source: "reset_time" | "retry_after" | "default";
  status: "waiting" | "done" | "skipped" | "cancelled";
  /** What will be sent to continue. */
  message: string;
  /** Why it was skipped (session gone, the user took over…) or what happened. */
  note?: string;
  taskId?: string;
  autoResumeCount?: number;
  needsReview?: boolean;
}

export interface QuotaSettings {
  /** Schedule a resume when a usage limit is detected. */
  autoResume: boolean;
  /** Used when no reset time can be read. */
  defaultDelayHours: number;
  /** Sent to continue. */
  message: string;
}

// ---- Super-resident mode (resident/) -------------------------------------------------------

/** A subscription account a resident round runs on: the Claude login or the ChatGPT (Codex) login. */
export type ResidentAccount = "claude" | "codex";

export interface ResidentSettings {
  /** What to learn, in order; when the list is used up (or empty) the agent picks by itself if selfDirected. */
  topics: string[];
  selfDirected: boolean;
  /** What a round may change. knowledge: memories and skills. project: the open project. self: sikeoop's own source. */
  targets: { knowledge: boolean; project: boolean; self: boolean };
  /** Accounts in the order they are tried; when one hits its limit the next takes over. */
  accounts: ResidentAccount[];
  /** Rounds per local day; 0 means no cap. */
  dailyRounds: number;
  /** Wait this long when every account is out of quota and no reset time can be read. */
  defaultDelayHours: number;
}

export interface ResidentRound {
  id: string;
  startedAt: number;
  endedAt?: number;
  account: ResidentAccount;
  topic: string;
  /** quota: stopped on a usage limit, to be continued. */
  status: "running" | "ok" | "failed" | "quota" | "stopped";
  /** What was learned, in the agent's words. */
  summary: string;
  /** What it left behind: memories, skill files, branches. */
  outputs: string[];
}

export interface ResidentView {
  /** The user's switch. It survives a restart: the loop picks up where it was. */
  on: boolean;
  /** cooldown: between two rounds. waiting_quota: every account is used up, resumeAt says when it goes on. paused: stopped itself, note says why. */
  phase: "off" | "running" | "cooldown" | "waiting_quota" | "paused";
  note?: string;
  resumeAt?: number;
  /** When the switch was last turned on. */
  startedAt?: number;
  roundsToday: number;
  current?: ResidentRound;
  /** Finished rounds, newest first. */
  rounds: ResidentRound[];
  settings: ResidentSettings;
  /** Which accounts are logged in, and when a used-up one resets. */
  accounts: { id: ResidentAccount; ready: boolean; limitedUntil?: number }[];
}

// ---- Paper workshop (docs/方案-论文工坊.md) -------------------------------------------------

export interface ArxivEntry {
  /** With version, e.g. "2401.12345v2". */
  id: string;
  title: string;
  authors: string[];
  summary: string;
  categories: string[];
  published: string;
  updated: string;
  absUrl: string;
  pdfUrl: string;
}

export type PaperSource = { kind: "file"; path: string } | { kind: "arxiv"; id: string };

/** A paper read into the workshop: its text split into sections (pdfjs). */
export interface PaperDoc {
  id: string;
  title: string;
  authors: string[];
  source: PaperSource;
  arxiv?: ArxivEntry;
  /** Imported from Zotero: its Better BibTeX citation key, used as the evidence `ref`. */
  citekey?: string;
  pages: number;
  sections: { id: string; title: string; page: number; text: string }[];
  addedAt: number;
}

export interface PaperSummary {
  oneLine: string;
  problem: string;
  method: string;
  results: string;
  experiments: string;
  limitations: string;
  related: string;
}

export interface PaperTranslation {
  /** Target language. */
  lang: "zh" | "en";
  chunks: { sectionId: string; source: string; text?: string; status: "queued" | "running" | "done" | "failed"; error?: string }[];
}

/** One evidence record as Chain-Centric's -r reads it (title ≤200, detail ≤500 characters). */
export interface EvidenceRecord {
  ref: string;
  title: string;
  detail: string;
  source: string;
  claims: {
    title: string;
    detail: string;
    /** Where in the paper it comes from (not written to the repository file Chain-Centric reads). */
    quote?: { paperId: string; sectionId: string; page: number; excerpt: string };
  }[];
}

export interface EvidenceRepoFile {
  /** Relative to the project, e.g. research/foo.repository.json */
  path: string;
  name: string;
  records: number;
  updatedAt: number;
}

export type PaperTaskKind = "summarize" | "translate" | "extract";

/** Long work on papers; each model call inside is a dispatch-core job. */
export interface PaperTask {
  id: string;
  kind: PaperTaskKind;
  paperIds: string[];
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  error?: string;
  /** extract: the drafted records, ready for review. */
  records?: EvidenceRecord[];
}

export type WritingAction =
  | "polish_zh"
  | "polish_en"
  | "proofread"
  | "translate_zh_en"
  | "translate_en_zh"
  | "shorten"
  | "expand"
  | "title_abstract";

export interface WritingRequest {
  action: WritingAction;
  text: string;
  /** Keep LaTeX commands, math and citation keys / Markdown syntax intact. */
  format: "plain" | "markdown" | "latex";
  /** A prompt preset to use instead of the built-in one for this action. */
  presetId?: string;
  /** An extra requirement for this run, e.g. the reviewer's comment the rewrite should answer. */
  note?: string;
}

export interface WritingResult {
  text: string;
  /** Short explanation of what changed (proofread lists the main fixes). */
  notes?: string;
}

export interface PromptPreset {
  id: string;
  name: string;
  /** Which writing button it can stand in for; absent = shown as an extra button. */
  action?: WritingAction;
  prefix: string;
  suffix: string;
  origin: "sikeoop" | "gpt_academic" | "user";
}

/** The optional gpt_academic prompt pack: fetched by the user from its repository, never shipped. */
export interface PromptPackState {
  installed: boolean;
  count: number;
  repo: string;
  license: "GPL-3.0";
  fetchedAt?: number;
}

export type PaperEvent =
  | { type: "paper"; paper: PaperDoc }
  | { type: "paperRemoved"; id: string }
  | { type: "task"; task: PaperTask }
  | { type: "translation"; paperId: string; translation: PaperTranslation };

// ---- Paper workshop, second batch (docs/方案-论文工坊.md §7): simulated review, topic ideas, AI-use statement

/** A provider × model that can act as a reviewer (the same list group chat offers). */
export interface ReviewerModel {
  providerId: string;
  providerName: string;
  model: string;
}

export type PaperReviewDecision = "accept" | "minor" | "major" | "reject";

export interface ReviewWeakness {
  text: string;
  /** The section it is about, or a short passage quoted from the paper. */
  where?: string;
}

/** One reviewer's report, in the shape of a conference review form. */
export interface ReviewReport {
  reviewer: ReviewerModel;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
  /** Rounds of looking again at its own report that it has finished. */
  reflected: number;
  /** 1–10. */
  overall?: number;
  decision?: PaperReviewDecision;
  /** Each 1–4. */
  scores?: { originality: number; quality: number; clarity: number; significance: number };
  /** 1–5: how sure the reviewer is. */
  confidence?: number;
  summary?: string;
  strengths?: string[];
  weaknesses?: ReviewWeakness[];
  questions?: string[];
  suggestions?: string[];
}

/** A weakness after merging what several reviewers said about the same thing. */
export interface ReviewMergedWeakness {
  text: string;
  where?: string;
  /** Indexes into ReviewRun.reports of the reviewers who raised it. */
  reviewers: number[];
  /** The other wordings that were merged into it. */
  variants: string[];
}

/** Something the reviewers disagree on, worth an adversarial look in deep research. */
export interface ReviewDispute {
  id: string;
  topic: string;
  detail: string;
}

export interface ReviewSummary {
  /** Reports that came back usable. */
  reports: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** max − min of the overall scores. */
  spread: number | null;
  decisions: Record<PaperReviewDecision, number>;
  scores: { originality: number | null; quality: number | null; clarity: number | null; significance: number | null };
  weaknesses: ReviewMergedWeakness[];
  disputes: ReviewDispute[];
}

export type ReviewSource = { kind: "paper"; paperId: string } | { kind: "file"; path: string } | { kind: "text"; text: string; title?: string };

export interface ReviewRequest {
  source: ReviewSource;
  /** 2–5 reviewers. */
  reviewers: ReviewerModel[];
  /** 0–3 rounds in which each reviewer checks and corrects its own report. */
  reflections: number;
}

/** One simulated review of one manuscript; kept per project. */
export interface ReviewRun {
  id: string;
  title: string;
  /** Where the text came from (a pasted text is not repeated here). */
  source: { kind: "paper"; paperId: string } | { kind: "file"; path: string } | { kind: "text" };
  /** Characters of manuscript the reviewers were given. */
  chars: number;
  /** The manuscript was longer than reviewers are given and was cut. */
  truncated: boolean;
  reflections: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** Model calls finished / planned. */
  done: number;
  total: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  reports: ReviewReport[];
  summary?: ReviewSummary;
}

export type ReviewEvent = { type: "run"; run: ReviewRun } | { type: "removed"; id: string };

/** What a weakness or a dispute is handed to deep research as. */
export interface ResearchHandoff {
  /** research/<name>.repository.json, relative to the project. */
  path: string;
  /** The question to ask there. */
  question: string;
}

/** A paper OpenAlex (or Semantic Scholar) found close to an idea. */
export interface NoveltyWork {
  title: string;
  year: number | null;
  url: string;
  authors: string[];
  venue?: string;
  citedBy?: number;
  /** The start of its abstract, when the index has one. */
  abstract?: string;
  source: "openalex" | "semantic_scholar";
}

/** done: someone has done this; overlap: partly; unseen: nothing close was found. */
export type NoveltyVerdict = "done" | "overlap" | "unseen";

export interface IdeaNovelty {
  status: "checking" | "done" | "failed";
  verdict?: NoveltyVerdict;
  reason?: string;
  /** The closest works, at most five. */
  works: NoveltyWork[];
  /** What was searched for. */
  queries: string[];
  checkedAt?: number;
  error?: string;
}

export interface ResearchIdea {
  id: string;
  title: string;
  oneLine: string;
  motivation: string;
  /** A first sketch of the experiments. */
  plan: string;
  /** Each 1–10, the model's own estimate. */
  scores: { interest: number; feasibility: number; novelty: number };
  rationale: string;
  /** Search phrases for the novelty check. */
  keywords: string[];
  novelty?: IdeaNovelty;
}

export interface IdeaRequest {
  direction: string;
  /** Papers in the workshop to use as background. */
  paperIds: string[];
  /** 1–10 ideas. */
  count: number;
}

export interface IdeaRun {
  id: string;
  direction: string;
  paperIds: string[];
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  error?: string;
  ideas: ResearchIdea[];
}

export type IdeaEvent = { type: "run"; run: IdeaRun } | { type: "removed"; id: string };

/** What the novelty check needs from the user. */
export interface IdeaSettings {
  /** Optional e-mail sent to OpenAlex as `mailto` (their polite pool); empty = not sent. */
  mailto: string;
  /** A Semantic Scholar key is available, so it is searched too. */
  semanticScholar: boolean;
}

/** What this project has used AI for in the workshop and in deep research, counted from what is stored. */
export interface DisclosureFacts {
  translatedPapers: number;
  summarizedPapers: number;
  evidenceRepositories: number;
  /** Runs of each writing button since this build started counting. */
  writing: Partial<Record<WritingAction, number>>;
  reviews: number;
  ideaRuns: number;
  noveltyChecks: number;
  researchRuns: number;
  /** Model names seen in those records. */
  models: string[];
}

export interface DisclosureDraft {
  facts: DisclosureFacts;
  zh: string;
  en: string;
}

// ---- Paper workshop, third batch (docs/方案-论文工坊.md §8): citations (Zotero Better BibTeX) and typesetting (Quarto).
// Both tools are installed by the user; sikeoop only calls what they expose.

/** How a citation is written: Pandoc / Quarto Markdown (`[@key]`) or LaTeX (`\cite{key}`). */
export type CiteStyle = "pandoc" | "latex";

/** Whether Zotero with Better BibTeX can be reached on 127.0.0.1:23119, and what to do when not. */
export interface ZoteroStatus {
  state: "ready" | "not_running" | "no_bbt" | "outdated";
  zotero?: string;
  betterBibtex?: string;
  /** What is wrong, in plain words; empty when ready. */
  message: string;
  /** What to do about it, in order. */
  steps: string[];
}

/** One reference in a citation. */
export interface CiteRef {
  citekey: string;
  /** "p. 12", "chap. 3". */
  locator?: string;
  prefix?: string;
  suffix?: string;
  suppressAuthor?: boolean;
}

/** What Zotero's picker gave back: the citation as text, and the keys in it. */
export interface CitePick {
  text: string;
  keys: string[];
  style: CiteStyle;
}

/** An item in the Zotero library, as the search lists it. */
export interface ZoteroItem {
  citekey: string;
  title: string;
  authors: string[];
  year: number | null;
  /** CSL type: "article-journal", "book", … */
  type: string;
  venue?: string;
}

export interface ZoteroCollection {
  libraryId: number;
  library: string;
  key: string;
  name: string;
  /** With its parents: "博士论文 / 第二章". */
  path: string;
}

/** `biblatex` is what Pandoc, Quarto and Typst read best; `bibtex` is for a LaTeX setup that uses BibTeX. */
export type BibFormat = "biblatex" | "bibtex";

export interface BibSettings {
  /** The .bib file, relative to the project. */
  file: string;
  format: BibFormat;
  /** The collection the file was last filled from. */
  collection?: { libraryId: number; key: string; path: string };
}

export interface BibState {
  settings: BibSettings;
  exists: boolean;
  /** Entries in the file now. */
  entries: number;
  updatedAt?: number;
}

export type BibSyncRequest =
  | { mode: "collection"; file: string; format: BibFormat; libraryId: number; key: string; path: string }
  /** The keys cited in these documents (relative paths). */
  | { mode: "used"; file: string; format: BibFormat; documents: string[] };

export interface BibSyncResult {
  file: string;
  added: string[];
  updated: string[];
  /** Entries only the file has (added by hand): left as they are. */
  kept: number;
  unchanged: number;
  /** Cited in the documents but not found in Zotero. */
  missing: string[];
  total: number;
}

/** Whether Quarto was found, and what to do when not. */
export interface QuartoStatus {
  found: boolean;
  path?: string;
  version?: string;
  /** PDF through Typst needs Quarto 1.4 or newer. */
  typst: boolean;
  message: string;
  steps: string[];
  /** The one found is the copy sikeoop downloaded (userData/tools/quarto), not the user's own. */
  managed?: boolean;
}

export type QuartoFormat = "pdf" | "docx" | "html";

export interface QuartoRenderRequest {
  /** A .qmd or .md file, relative to the project. */
  file: string;
  format: QuartoFormat;
  /** Run the document's code cells. Off unless asked for. */
  execute?: boolean;
}

/** One rendering: a dispatch-core job. */
export interface QuartoRun {
  id: string;
  file: string;
  format: QuartoFormat;
  /** Started by the user, or by the document being saved while it is watched. */
  trigger: "manual" | "save";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  /** The file Quarto wrote, relative to the project. */
  output?: string;
  /** On failure (and for warnings): what matters from Quarto's output. */
  points: string[];
  /** The end of Quarto's output. */
  log: string;
}

/** A document rendered again every time it is saved. */
export interface QuartoWatch {
  file: string;
  format: QuartoFormat;
  execute: boolean;
}

export type QuartoEvent = { type: "run"; run: QuartoRun } | { type: "watch"; watch: QuartoWatch | null };

export type CslStyleId = "gbt7714" | "apa";

/** A citation style file from the official CSL repository: not shipped, downloaded once when first used. */
export interface CslStyle {
  id: CslStyleId;
  title: string;
  /** The file's name, in the repository and in the project. */
  file: string;
  url: string;
  license: string;
  /** Already downloaded: using it again needs no network. */
  cached: boolean;
}

export interface PaperTemplateRequest {
  /** The folder for the new paper, relative to the project. */
  dir: string;
  /** The document's file name without extension. */
  name: string;
  title: string;
  authors: string[];
  abstract: string;
  lang: "zh" | "en";
  csl: CslStyleId;
  /** The user read where the style file comes from and agreed to fetch it. */
  downloadCsl: boolean;
}

export interface PaperTemplateResult {
  /** The new document, relative to the project. */
  document: string;
  /** Files added. */
  files: string[];
  /** Already there, left alone (an existing references.bib). */
  skipped: string[];
  /** The style file could not be fetched; the paper uses the built-in fallback. */
  cslError?: string;
}

// ---- Paper workshop, fourth batch: Quarto / Zotero downloaded when the user asks (docs/方案-论文工坊.md §9) ----

/** quarto: unpacked into sikeoop's own data folder. zotero: its installer. bbt: the Better BibTeX plugin file (.xpi). */
export type PaperToolId = "quarto" | "zotero" | "bbt";

/** What a download would fetch and from where: shown to the user before anything is downloaded. */
export interface ToolOffer {
  tool: PaperToolId;
  version: string;
  /** The file's name as published. */
  file: string;
  /** Bytes. */
  size: number;
  /** Who publishes it, in words ("GitHub quarto-dev/quarto-cli Releases"). */
  source: string;
  /** The address the download starts from. */
  url: string;
  license: string;
  /** A published SHA-256 is checked after downloading. Without one only the size is. */
  checksum: boolean;
  /** Where it will be put, in words. */
  where: string;
  /** The publisher's own note worth showing (which Zotero the plugin works with). */
  note?: string;
  /** Quarto: this version is already unpacked here. */
  have?: boolean;
}

export type ToolPhase = "downloading" | "verifying" | "extracting" | "done" | "failed" | "cancelled";

/** One download, from the click to the file being ready. */
export interface ToolTask {
  tool: PaperToolId;
  phase: ToolPhase;
  version: string;
  file: string;
  received: number;
  total: number;
  /** Failed: what went wrong. */
  error?: string;
  /** Failed with part of the file kept: trying again continues from there. */
  resumable?: boolean;
  /** Done: the downloaded file, or the folder Quarto was unpacked into. */
  path?: string;
  /** Done: the installer was handed to the system to open. */
  opened?: boolean;
}

export interface ManagedQuarto {
  version: string;
  /** The folder it is in. */
  dir: string;
  /** The program itself. */
  bin: string;
}

export interface PaperToolsState {
  /** Copies of Quarto sikeoop downloaded, newest first. */
  quarto: ManagedQuarto[];
  /** Where those copies are kept. */
  quartoDir: string;
  /** Zotero was found in one of the usual places (it may be installed somewhere else). */
  zoteroInstalled: boolean;
  /** Where installers and the plugin file are saved. */
  downloads: string;
  /** The latest download of each tool since sikeoop started. */
  tasks: ToolTask[];
}

export type ToolEvent = { type: "task"; task: ToolTask };

// ---- Deep research: Chain-Centric run as a separate process (docs/方案-深度科研.md) -----------

/** Chain-Centric's own provider names (its config.py). */
export type CcProvider = "anthropic" | "openai" | "deepseek" | "minimax" | "kimi" | "glm" | "mimo" | "doubao" | "qwen";

/** A sikeoop provider/model that Chain-Centric can use (official endpoints only). */
export interface ResearchCandidate {
  providerId: string;
  providerName: string;
  model: string;
  cc: CcProvider;
  /** The key is set. */
  ready: boolean;
}

/** One of Chain-Centric's bundled examples (examples/presets/<id>). */
export interface ResearchPreset {
  id: string;
  title: string;
  question: string;
  /** Records in repository.json (0 = question only). */
  records: number;
  language: "zh" | "en";
}

export interface ResearchEnv {
  /** Python ≥ 3.10 found (through uv or python3). */
  python: { found: boolean; version?: string; via?: "uv" | "python3"; hint?: string };
  /** Chain-Centric installed in sikeoop's own virtual environment. */
  installed: boolean;
  installing: boolean;
  /** Bundled package version (pyproject). */
  packageVersion: string;
}

export interface ResearchRequest {
  question: string;
  /** In order: they become agent_0, agent_1… */
  agents: { providerId: string; model: string }[];
  /** CHAIN_CENTRIC_EVIDENCE_LLM. */
  evidence: { providerId: string; model: string };
  repository?: { kind: "preset"; id: string } | { kind: "file"; path: string };
  /** Passed as --max-rounds (the environment variable is ignored by `run`). */
  maxRounds: number;
}

// The JSON `chain-centric run -o` writes (session.py _build_summary), field names as they are.
export interface CcClaim {
  claim_id: string;
  description: string;
  alpha: number;
  U: number;
  state: "RICH_DISAGREEMENT" | "EVIDENCE_STARVED" | "TRUE_CONSENSUS" | "FRAGILE_CONSENSUS" | string;
  /** Number of chains. */
  chains: number;
  /** Times attacked. */
  attacks: number;
  evidence_count: number;
}
export interface CcChain {
  chain_id: string;
  agent: string;
  version: number;
  steps: number;
  attacks_received: number;
}
export interface CcAttack {
  attack_id: string;
  attacker: string;
  /** "<agent>/<chain_id>/step<n>" */
  target: string;
  claim_preview: string;
}
export interface CcChainDetail {
  chain_id: string;
  agent: string;
  version: number;
  claim_id: string;
  status: "active" | "broken" | "superseded" | "archived" | string;
  steps: { step_id: string; assertion: string; evidence: string[]; depends_on: unknown }[];
}
export interface CcResult {
  question: string;
  task_type: string;
  total_rounds: number;
  terminated: boolean;
  termination_reason: string;
  token_estimates: { input: number; output: number; calls: number };
  claims: CcClaim[];
  chains: CcChain[];
  attacks: CcAttack[];
  chain_details: CcChainDetail[];
  entropy_trajectory: Record<string, number | string>[];
  evidence_pool_size: number;
  /** Rendered text; the zones are recomputed by sikeoop (shared/research.ts). */
  divergence_map: string;
  natural_summary: string;
}

/** Live progress, parsed from its unbuffered stdout. */
export interface ResearchProgress {
  /** Rounds started (its "-- Round N --" counts from 0). */
  round: number;
  maxRounds: number;
  claims: number;
  chains: number;
  attacks: number;
  /** Agents waiting on their model right now. */
  calling: string[];
  /** "call failed" lines, with anything key-like removed. */
  failures: { agent: string; message: string; at: number }[];
  /** Plain-language line for the status bar. */
  activity: string;
}

export interface ResearchRun {
  id: string;
  createdAt: number;
  endedAt?: number;
  status: "preparing" | "running" | "done" | "failed" | "cancelled";
  request: ResearchRequest;
  /** agent_0… → which model it was (the output only has agent_N). */
  agents: { agent: string; providerId: string; providerName: string; model: string }[];
  /** The dispatch core job it runs as. */
  jobId?: string;
  progress?: ResearchProgress;
  termination?: string;
  error?: string;
  hasResult: boolean;
  /** Refs of the evidence repository it ran with (claims expanded to "<ref>/claim_<n>", as Chain-Centric does). */
  repositoryRefs?: string[];
}

export type ResearchEvent =
  | { type: "run"; run: ResearchRun }
  | { type: "env"; env: ResearchEnv };

// ---- Dispatch core (docs/调度核心-收拢方案.md) ---------------------------------------------

/** cli: a Claude Code / Codex terminal session. session: sikeoop's own AgentSession. model: one streamed call.
 * process: another program sikeoop runs (Quarto rendering). */
export type DispatchExecutorKind = "cli" | "session" | "model" | "process" | "agent";

export type DispatchJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "timeout"
  | "exited";

/** Who started the job tree. "agent": one AI messaging another (send_to). */
export type DispatchOrigin = "user" | "chat" | "agent" | "automation" | "cluster" | "session" | "wechat";

/** One piece of work handed to one executor. Jobs form trees: a job an agent starts while working is its child. */
export interface DispatchJob {
  id: string;
  parentId?: string;
  rootId: string;
  origin: DispatchOrigin;
  /** Who handed it over: an executor's name (Claude-1) or "sikeoop". */
  from: string;
  executor: { kind: DispatchExecutorKind; ref: string; name: string };
  input: string;
  /**
   * Where it may write. owns: the files it is responsible for (paths relative to the first root;
   * "dir/" for a folder, * and ** globs). Set = writes elsewhere are refused (or flagged, for Codex).
   */
  scope?: { roots: string[]; owns?: string[]; readOnly?: boolean };
  /** What it needs to run; checked before it starts. deps: folders whose node_modules must exist. */
  needs?: { network?: boolean; deps?: string[] };
  /** Acceptance run when it ends. typecheck: a command whose new errors (vs. before) are reported. */
  verify?: { typecheck?: string };
  limits: { timeoutMs: number };
  status: DispatchJobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  progress?: DispatchProgress[];
  result?: { text: string; outcome?: string; files?: DispatchFiles };
  error?: string;
  /** Pre-flight and acceptance results, in the order they ran. */
  checks?: DispatchCheck[];
  autoResumeCount?: number;
  needsReview?: boolean;
  /** It carries another job's result back to whoever asked for it. Costs no budget, and nothing is sent back for it. */
  reply?: boolean;
  /** Times it was sent back to the same executor to fix what the acceptance found (at most once). */
  reworks?: number;
  /**
   * Why a queued job hasn't started. executor: the executor itself isn't available (only this
   * counts toward the queue timeout); own: the executor is running another dispatched job;
   * lane: its lane is busy; conflict: overlapping write scope; cap: no free slot; paused.
   */
  waiting?: { reason: "executor" | "own" | "lane" | "conflict" | "cap" | "paused"; detail?: string };
  /** It was let past a full cap because its parent is active (at most one per parent). */
  overCap?: boolean;
}

/** Locally measured, relative to the first scope root. Never taken from agent prose. */
export interface DispatchFiles { changed: string[]; created: string[]; deleted: string[] }
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
  [key: string]: unknown;
}
export interface AgentPermissionCard {
  id: string;
  jobId: string;
  sessionId: string;
  title: string;
  toolCall: Record<string, unknown>;
  options: AcpPermissionOption[];
}
export interface DispatchProgress {
  type: "status" | "text" | "tool" | "permission" | "file";
  at: number;
  text?: string;
  toolCallId?: string;
  status?: string;
  title?: string;
  tool?: Record<string, unknown>;
  permission?: AgentPermissionCard;
}
export interface DispatchAgentInput {
  input: string;
  readOnly?: boolean;
  /** External provider/model id; no sikeoop credentials are forwarded. */
  model?: string;
  owns?: string[];
  timeoutMs?: number;
  verify?: { typecheck?: string };
}

export interface DispatchCheck {
  kind: "preflight" | "files" | "owns" | "typecheck" | "claims";
  /** pass; warn: worth a look, didn't stop anything; fail: refused, or the acceptance didn't hold. */
  level: "pass" | "warn" | "fail";
  summary: string;
  details?: string[];
}

/** Jobs left in a tree before it stops and waits for the user. */
export interface DispatchBudget {
  rootId: string;
  left: number;
  total: number;
}

/** What the dispatch console shows: live jobs first, then finished ones (newest first). */
export interface DispatchView {
  jobs: DispatchJob[];
  /** Budgets of the trees still listed. */
  budgets: DispatchBudget[];
  running: number;
  queued: number;
  maxRunning: number;
}

export type DispatchEvent =
  | { type: "progress"; jobId: string; progress: DispatchProgress }
  | { type: "job"; job: DispatchJob }
  /** A job was refused because its tree used up its budget; the user has to step in. */
  | { type: "budget_exhausted"; rootId: string; refused: { from: string; to: string; input: string } };

// ---- One-click publish ------------------------------------------------------------------

/** Where a site is hosted. Only sikeoop's own hosting for now. */
export type PublishTarget = "sikeoop";

/** What to publish: a prototype in prototypes/<name>/, or a folder inside the project. */
export type PublishSource = { kind: "proto"; name: string } | { kind: "dir"; path: string };

export interface PublishRequest {
  source: PublishSource;
}

/** Saved per project in .sikeoop/publish.json; siteId keeps the link stable across updates. */
export interface PublishRecord {
  siteId: string;
  url: string;
  target: PublishTarget;
  source: PublishSource;
  lastPublishedAt: number;
  fileCount: number;
  bytes: number;
}

/** A problem found before upload. "secret" and "too_big" block publishing; the rest only warn. */
export interface PublishWarning {
  file: string;
  reason: "secret" | "absolute_path" | "missing_asset" | "too_big" | "blocked_type";
  /** Plain-language explanation for beginners. */
  message: string;
  blocking: boolean;
}

export interface PublishScanResult {
  files: number;
  bytes: number;
  warnings: PublishWarning[];
}

export type PublishErrorCode = "too_big" | "quota" | "network" | "blocked_file" | "server" | "cancelled";

/** Progress of publishStart, pushed on "publish:event". */
export type PublishEvent =
  | { type: "scan"; result: PublishScanResult }
  | { type: "upload"; done: number; total: number }
  | { type: "done"; record: PublishRecord }
  | { type: "error"; code: PublishErrorCode; message: string };

// ---- Prototype studio ------------------------------------------------------------------

export type ProtoDevice = "phone" | "tablet" | "desktop";

/** One page of a prototype: an HTML file, placed on the canvas at device size. */
export interface ProtoScreen {
  id: string;
  title: string;
  /** Relative to the prototype folder, e.g. screens/home.html. */
  file: string;
  device: ProtoDevice;
  width: number;
  height: number;
  x: number;
  y: number;
}

/** prototypes/<name>/canvas.json */
export interface ProtoCanvas {
  version: 1;
  /** The screen the demo starts on. */
  start?: string;
  screens: ProtoScreen[];
}

export interface ProtoSummary {
  name: string;
  screens: number;
  updatedAt: number;
}

export interface ProtoDoc {
  name: string;
  canvas: ProtoCanvas;
  /** Screen id → its HTML source (for the link lines and the layer list). */
  sources: Record<string, string>;
  /** canvas.json problems that were repaired on load. */
  warnings: string[];
}

// ---- Hooks, memory and the code index ----------------------------------------------------

/** Points in the agent's work where hooks run (names as in Claude Code, so its hooks carry over). */
export type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

/** What a hook did, as shown in the chat. */
export type HookOutcomeKind = "context" | "blocked" | "denied" | "allowed" | "ask" | "continue" | "error";

export interface HookEntryView {
  event: HookEventName;
  /** Tool name pattern (regex) for PreToolUse / PostToolUse; "" = every tool. */
  matcher: string;
  command: string;
  timeout: number;
}

/** One hooks file: the user's own, or one inside the project (which must be trusted first). */
export interface HookSourceView {
  kind: "user" | "project";
  label: string;
  path: string;
  exists: boolean;
  /** User hooks are always trusted; project hooks only after the user approved this exact content. */
  trusted: boolean;
  hooks: HookEntryView[];
  error?: string;
}

/** Features built on the hook system itself; each loads only when its event first fires. */
export interface BuiltinHookView {
  id: "rules" | "memory" | "recent-session" | "recall" | "rag";
  name: string;
  description: string;
  events: HookEventName[];
  enabled: boolean;
}

export interface HooksState {
  sources: HookSourceView[];
  builtins: BuiltinHookView[];
  /** False until a project folder is open (project hooks are listed then). */
  hasProject: boolean;
}

/** lesson: written after a failed long task, for the project it happened in (agent/lessons.ts). */
export type MemoryKind = "preference" | "fact" | "decision" | "note" | "lesson";

/** Something the agent (or the user) chose to remember across conversations. */
export interface MemoryItem {
  id: string;
  text: string;
  kind: MemoryKind;
  /** project: only in this project folder. global: in every project. */
  scope: "project" | "global";
  createdAt: number;
  updatedAt: number;
  /** Times it was recalled into a conversation. */
  uses: number;
  /** Conversations it came up in (consolidation counts recurrences). Absent means 1. */
  evidence?: number;
  /** Last time it was brought into a conversation. */
  lastUsedAt?: number;
  /** The conversation it was learned from, when consolidation added it. */
  source?: { sessionId: string };
  /**
   * c3 (absent): in the index new conversations start with, and recalled automatically. c4: archived
   * after a long time unused; found only when the agent searches with recall, which brings it back.
   */
  tier?: "c4";
}

/**
 * A memory consolidation wants the user to decide on: one for every project (global memories are
 * never written without a yes), or one that contradicts a memory already kept.
 */
export interface MemoryPending {
  id: string;
  text: string;
  kind: MemoryKind;
  scope: "project" | "global";
  reason: "global" | "conflict";
  /** For a conflict: the memory it contradicts and why. */
  conflict?: { id: string; text: string; reason: string };
  createdAt: number;
}

/** What one consolidation run did (memory/consolidate.ts). */
export interface ConsolidateReport {
  /** Conversations whose summaries were read. */
  sessions: number;
  added: string[];
  merged: string[];
  /** New candidates, and candidates seen again but still once. */
  candidates: number;
  /** Candidates that passed their 14 days without coming up again. */
  expired: number;
  /** Memories archived (c3 → c4) for going unused. */
  archived: number;
  pending: MemoryPending[];
  /** Why nothing ran (memory off, no project, no model…). */
  skipped?: string;
}

export interface ContextSettings {
  /** Read AGENTS.md / CLAUDE.md / .cursorrules… into new conversations. */
  rules: boolean;
  /** Put remembered facts into new conversations, and let the agent remember. */
  memory: boolean;
  /** Add memories related to each message. */
  autoRecall: boolean;
  /** Add code related to each message, found in the project index. */
  autoContext: boolean;
  /** Semantic search: an embeddings model next to keyword search. null = keywords only. */
  embedding: { providerId: string; model: string } | null;
}

export interface RagStatus {
  state: "empty" | "indexing" | "ready";
  files: number;
  chunks: number;
  indexedAt?: number;
  semantic: { enabled: boolean; model?: string; embedded: number; total: number; running: boolean; error?: string };
}

/** What the context window holds, for the status bar's breakdown. */
export type ContextPartKey = "system" | "tools" | "context" | "messages" | "toolResults" | "thinking";

export interface ContextUsage {
  /** Prompt tokens of the conversation (measured by the provider, or estimated before the first reply). */
  used: number;
  /** The working window: at this size the compression sub-agent summarizes. */
  budget: number;
  /** The model's own context window. */
  window: number;
  /** No measurement yet (a reopened conversation): the numbers are estimates. */
  estimated: boolean;
  parts: { key: ContextPartKey; tokens: number }[];
}

/** One step of the agent's plan for a long task. */
export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "done" | "skipped";
}

/** Which model reads images. Any configured provider; DeepSeek's vision model by default. */
export interface VisionSetting {
  providerId: string;
  model: string;
}

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  /** Line number in the old file (ctx, del). */
  oldNo?: number;
  /** Line number in the new file (ctx, add). */
  newNo?: number;
  /** Changed character ranges [start, end) within a modified line, for word-level highlighting. */
  marks?: [number, number][];
  /** Only whitespace (indentation) differs from its paired line. */
  ws?: boolean;
}

/** Unchanged lines folded away; `lines` is kept when there are few enough to expand in place. */
export interface DiffFold {
  count: number;
  lines?: DiffLine[];
}

export interface DiffHunk {
  lines: DiffLine[];
  /** Unchanged lines between the previous hunk (or the file start) and this one. */
  before?: DiffFold;
}

/** A file change the agent wants to make, shown to the user for approval. */
export interface FileChangeProposal {
  path: string;
  /** True when the file does not exist yet. */
  created: boolean;
  /** One plain-language sentence from the model saying what the change does. */
  explanation: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the diff was too long and only the start is shown. */
  truncated: boolean;
  /** Unchanged lines after the last hunk. */
  after?: DiffFold;
}

/** A shell command the agent wants to run, shown to the user for approval. */
export interface CommandProposal {
  command: string;
  /** One plain-language sentence from the model saying what the command does. */
  explanation: string;
  /** Set when the command can delete files or throw away work. */
  warning?: string;
}

/** An MCP tool call the agent wants to make, shown to the user for approval. */
export interface ToolCallProposal {
  server: string;
  tool: string;
  description: string;
  /** Arguments as pretty-printed JSON. */
  args: string;
}

/** What an approval card shows: a file change, a command to run, or an MCP tool call. */
export type ApprovalSubject =
  | { kind: "file"; change: FileChangeProposal }
  | { kind: "command"; command: CommandProposal }
  | { kind: "tool"; call: ToolCallProposal };

// ---- plugins: skills ------------------------------------------------------

/**
 * "standard": an Agent Skill folder with SKILL.md (name + description frontmatter).
 * "converted": something else (a Markdown file, Cursor rules, a Claude Code command…)
 * turned into a standard skill on install.
 */
export type SkillFormat = "standard" | "converted";

export interface SkillInfo {
  name: string;
  description: string;
  format: SkillFormat;
  /** Where it came from, in words: "标准 Skill", "Cursor 规则"… */
  origin: string;
  /** URL, path or "粘贴的文本". */
  source: string;
  enabled: boolean;
  /** Ships with the app (installed automatically, can be restored after deleting). */
  builtin: boolean;
  /** 强制预设 · hack专用：永远启用，不能关闭、不能删除，对话开头置顶。 */
  forced: boolean;
  files: number;
  hasScripts: boolean;
}

export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
  format: SkillFormat;
  origin: string;
  files: string[];
  hasScripts: boolean;
  /** A skill with this name is already installed and would be replaced. */
  exists: boolean;
  warnings: string[];
  /** Security review of every file in the skill, done before anything is installed. */
  audit: SkillAudit;
}

/** What a finding is about. */
export type AuditCategory =
  | "injection" // instructions aimed at the agent: ignore rules, hide things from the user
  | "approval-bypass" // turning off confirmations or sandboxes
  | "exfiltration" // sending data out
  | "credentials" // reading keys, passwords, cookies
  | "destructive" // deleting or wiping data
  | "remote-code" // downloading and running code
  | "persistence" // starting itself on login / editing shell profiles
  | "obfuscation" // hidden characters, encoded payloads
  | "binary" // bundled executables
  | "network"; // talks to the internet (informational)

export interface AuditFinding {
  severity: "high" | "medium" | "low";
  category: AuditCategory;
  /** One short Chinese line: what was found. */
  title: string;
  file: string;
  line?: number;
  /** The matching text, shortened. */
  excerpt: string;
}

/** pass: nothing found; notice: low only; warn: medium; danger: high, or the AI review says malicious. */
export type AuditLevel = "pass" | "notice" | "warn" | "danger";

export interface AiSkillReview {
  verdict: "safe" | "suspicious" | "malicious";
  /** One or two Chinese sentences. */
  summary: string;
  concerns: { file: string; why: string }[];
  model: string;
  /** Some files were too long and only partly read. */
  truncated: boolean;
}

export interface SkillAudit {
  level: AuditLevel;
  findings: AuditFinding[];
  /** Files read by the rule scan. */
  scanned: number;
  /** The AI review, once it has run (or why it couldn't). */
  ai?: AiSkillReview | { error: string };
}

export interface SkillPreview {
  previewId: string;
  source: string;
  candidates: SkillCandidate[];
}

export type SkillSource =
  | { kind: "url"; url: string; /** For very large repos: fetch only these skills. */ only?: string[] }
  | { kind: "local"; path: string }
  | { kind: "text"; text: string; name?: string }
  /** A skill from the SkillHub store (skillhub.cn), by its slug. */
  | { kind: "skillhub"; slug: string };

/** One search result from the SkillHub store. */
export interface SkillHubItem {
  slug: string;
  name: string;
  /** Chinese summary when the store has one. */
  summary: string;
  version: string;
  category: string;
  /** "community" (uploaded to SkillHub) or "clawhub" (mirrored from ClawHub). */
  source: string;
  owner: string;
  downloads: number;
  installs: number;
  stars: number;
  requiresApiKey: boolean;
  homepage: string;
}

// ---- plugins: MCP servers --------------------------------------------------

export type McpTransport = "stdio" | "http" | "sse";

/** A server as written in a config (before it is saved). Secrets are included here only. */
export interface McpServerInput {
  name: string;
  type: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerView {
  name: string;
  type: McpTransport;
  /** Command line or URL, for display. */
  summary: string;
  enabled: boolean;
  /** Trusted servers' tools run without asking each time. */
  trusted: boolean;
  status: "off" | "connecting" | "connected" | "error";
  error?: string;
  tools: { name: string; description: string }[];
  /** Names of the env vars / headers stored (values stay encrypted in the main process). */
  secretKeys: string[];
}

/** What a mod may use, declared in its mod.json and shown to the user before install. */
export type ModPermission = "tools" | "hooks" | "model" | "notify" | "network" | "fs" | "shell";

export interface ModManifest {
  /** [a-z0-9-], unique. */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  /** Entry file, relative to the mod folder (default index.js). */
  main?: string;
  permissions: ModPermission[];
  /** Lowest sikeoop version it works with, e.g. "0.3.0". */
  minAppVersion?: string;
}

export interface ModView extends ModManifest {
  enabled: boolean;
  /** Loaded from a folder in place (development), reloadable. */
  dev: boolean;
  dir: string;
  /** running: activated. changed: files edited since install, needs the user's OK again. */
  status: "off" | "running" | "error" | "changed";
  error?: string;
  /** Tools and hooks it registered while running. */
  tools: string[];
  hooks: string[];
}

export interface ModPreview {
  id: string;
  manifest: ModManifest;
  /** Already installed: installing replaces it. */
  exists: boolean;
  files: number;
  /** Problems that block the install (bad manifest, too new for this app). */
  errors: string[];
}

export interface ApprovalResponse {
  id: string;
  /** approve_all approves this and every later file change in the same conversation. Commands always ask. */
  decision: "approve" | "approve_all" | "reject";
  /** Optional note for the model when rejecting. */
  feedback?: string;
}

export interface UndoResult {
  restored: string[];
  /** Files left as they are, with the reason. */
  skipped: { path: string; reason: string }[];
}

export interface AskOption {
  label: string;
  /** What choosing it means, in plain words; the trade-off. */
  description?: string;
  /** The agent's suggestion; at most one per question. */
  recommended?: boolean;
}

export interface AskQuestion {
  id: string;
  question: string;
  /** A short chip label, e.g. "框架". */
  header?: string;
  options: AskOption[];
  /** Several options may be picked. */
  multi?: boolean;
}

export interface AskAnswer {
  id: string;
  /** Labels of the picked options. */
  choices: string[];
  /** What the user typed under "其他". */
  other?: string;
}

export interface QuestionResponse {
  id: string;
  answers: AskAnswer[];
  /** "都按推荐来": take the recommended option of every question. */
  usedDefaults: boolean;
}

/** Events the agent loop streams to the renderer, one turn at a time. */
export type AgentEvent =
  /** compacting: the context window is full and the compression sub-agent is summarizing it. */
  | { type: "status"; state: "thinking" | "running_tools" | "compacting" | "idle" }
  /** How full the context window is after a request, and what it is filled with. */
  | ({ type: "context_usage" } & ContextUsage)
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; summary: string }
  /** The model is still writing a tool call's arguments: the latest part of the JSON, throttled. Transient, not saved. */
  | { type: "tool_preview"; id: string; name: string; partial: string }
  | { type: "tool_end"; id: string; ok: boolean; preview: string }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
  /**
   * How one request used the prompt cache (memory-design/c-tier-memory.md, stage 4).
   * first: nothing cached yet. hit: the earlier prompt was read back. expired: a miss after the
   * cache lifetime, expected. partial / miss: the cache broke when it shouldn't have; cause says why
   * when known (e.g. which history entry was rewritten). unknown: the provider reports no cache use.
   */
  | { type: "cache_check"; verdict: "first" | "hit" | "expired" | "partial" | "miss" | "unknown"; read: number; previous: number; cause?: string }
  /**
   * autoApproved: the user chose "approve all" earlier, so no answer is awaited.
   * reviewing: long-task mode, the reviewer sub-agent answers first (a "review" event follows).
   */
  | { type: "approval_request"; id: string; subject: ApprovalSubject; autoApproved: boolean; reviewing?: boolean; humanOnly?: boolean }
  /** The reviewer's verdict. ask_human: the card now waits for the user, as without long-task mode. */
  | { type: "review"; id: string; decision: ReviewDecision; reason: string; model: string }
  /** A hook acted: added context, blocked something, or failed. */
  | { type: "hook"; event: HookEventName; name: string; outcome: HookOutcomeKind; message: string; detail?: string }
  /** The agent saved a memory (updated: an existing, similar one was replaced; lesson: learned from a failed long task). */
  | { type: "memory_saved"; id: string; text: string; scope: "project" | "global"; updated: boolean; lesson?: boolean }
  /** The agent's current plan, replaced as a whole each time it changes. */
  | { type: "plan"; items: PlanItem[] }
  | { type: "approval_result"; id: string; approved: boolean }
  /** The agent asks the user before starting (new project, new feature): a card of clickable questions. */
  | { type: "question"; id: string; intro?: string; questions: AskQuestion[] }
  /** The user answered (or chose "use the recommendations"). */
  | { type: "question_answered"; id: string; answers: AskAnswer[]; usedDefaults: boolean }
  /** A file on disk was written by the agent or restored by an undo. content null = deleted. */
  | { type: "file_changed"; path: string; content: string | null; created: boolean }
  /** Files the agent changed during this turn, which the user can undo together. */
  | { type: "turn_changes"; turnId: number; files: { path: string; created: boolean }[] }
  /** Live output of an approved command. */
  | { type: "command_output"; id: string; chunk: string }
  | { type: "command_done"; id: string; exitCode: number | null; timedOut: boolean }
  /** A command ran, so any file may have changed: refresh the tree and open files. */
  | { type: "workspace_changed" }
  /** A message to the main chat that came from elsewhere (WeChat remote control): shown as the user's. */
  | { type: "remote_message"; text: string; from: "desktop" | "wechat" | "mobile"; deviceName?: string }
  /** Earlier context was shortened to fit: summarized (compacted) or old tool output cleared. */
  | { type: "context_trimmed"; how: "compacted" | "cleared"; tokens?: number }
  /**
   * The conversation moved to another model with its work so far (agent/handoff.ts).
   * kept / omitted: tool results (file contents) passed on whole / left out to fit.
   */
  | { type: "model_switched"; from: string; to: string; reason: "manual" | "failover" | "route" | "reopen"; kept: number; omitted: number; detail?: string }
  | { type: "turn_undone"; turnId: number; result: UndoResult }
  /** The vision model reading the user's images: started, finished with its analysis, or failed. */
  | { type: "vision"; state: "start" | "done" | "error"; model: string; count: number; text?: string }
  /** autopilot: the turn ran in long-task mode (the window notifies when it ends unseen). */
  | { type: "done"; reason: "end_turn" | "cancelled" | "step_limit" | "refusal"; autopilot?: boolean }
  | { type: "error"; message: string };

/**
 * How the app talks to a provider.
 * "anthropic" uses the official Anthropic SDK (Claude: adaptive thinking, prompt caching, fallbacks).
 * "openai" uses the OpenAI Chat Completions format, which most other providers also accept.
 */
export type ProviderKind = "anthropic" | "openai";

/** Which OpenAI format a provider is called with, for providers that offer both. */
export type OpenAIApi = "responses" | "chat";

/** State of "log in with an Anthropic account" (the official `ant` CLI's OAuth profile, or the app's built-in OAuth). */
export interface ClaudeOAuthGenerateResult { auth_url: string; session_id: string }
export interface ClaudeOAuthExchangeInput { session_id: string; code: string }

/** Built-in ChatGPT subscription OAuth. Tokens remain encrypted in the main process. */
export interface OpenAIOAuthGenerateResult { auth_url: string; session_id: string }
export interface OpenAIOAuthExchangeInput { session_id: string; code: string }
export interface OpenAILogin {
  loggedIn: boolean;
  expired?: boolean;
  email?: string;
  chatgpt_account_id?: string;
  plan_type?: string;
  error?: string;
}

export interface AnthropicLogin {
  loggedIn: boolean;
  /** Logged in once, but the token ran out and can't be refreshed: log in again. */
  expired?: boolean;
  /** The `ant` command is installed and on PATH. */
  antInstalled: boolean;
  /** Organization name (or email) of the logged-in Console account, for display. */
  account?: string;
  email?: string;
  error?: string;
}

/** Scope preset for the app's built-in Claude OAuth. "full" serves login mode; "inference" is the setup-token variant. */
export type ClaudeOAuthScope = "full" | "inference";

/** Authorization link generated by the main process for the built-in Claude OAuth flow. */
export interface ClaudeOAuthAuthUrl {
  auth_url: string;
  session_id: string;
}

/** Single subscription usage window: percent used and the ISO reset timestamp. */
export interface ClaudeUsageWindow {
  utilization: number;
  resets_at: string;
}

/** The four windows the Claude subscription usage endpoint reports. */
export interface ClaudeUsage {
  five_hour: ClaudeUsageWindow;
  seven_day: ClaudeUsageWindow;
  seven_day_sonnet: ClaudeUsageWindow;
  seven_day_overage_included: ClaudeUsageWindow;
}

/** IPC return shape for subscription usage: either the four windows, or a short error message. */
export type ClaudeUsageResult = ClaudeUsage | { error: string };

/** One logged-in Claude subscription account. Several can be kept; one is in use. Never includes a token. */
export interface ClaudeAccount {
  /** The account's uuid from the login. */
  id: string;
  email?: string;
  /** The account requests are sent with right now. */
  active: boolean;
  /** Its usage windows, read just now; `{ error }` when that account's query failed. */
  usage: ClaudeUsageResult;
}

/** Usage-limit resets the subscription can still redeem (mirrors main/providers/claude-usage.ts). */
export interface ClaudeResetCredit {
  label: string;
  resets_left: number;
  starts_at?: string;
  expires_at?: string;
  /** The usage windows one reset clears. */
  clears: string[];
  percent_used: Record<string, number>;
  blocking: string[] | null;
  use_requires_limit: boolean;
  redeemable: boolean;
}
export interface ClaudeResetCredits {
  eligible: boolean;
  available_count: number;
  credits: ClaudeResetCredit[];
  cooldown_until?: string;
  weekly_resets_at?: string;
  fetched_at: string;
}
export type ClaudeResetCreditsResult = ClaudeResetCredits | { error: string };

/** ChatGPT subscription quota (mirrors main/providers/openai-codex.ts). */
export interface CodexQuotaWindow {
  /** 0–100. */
  used_percent: number;
  resets_at?: string;
  /** Length of the window in seconds (18000 = 5 hours, 604800 = 7 days). */
  window_seconds?: number;
}
export interface CodexQuotaLimit {
  limit_reached: boolean;
  primary?: CodexQuotaWindow;
  secondary?: CodexQuotaWindow;
}
export interface CodexQuota extends CodexQuotaLimit {
  plan_type?: string;
  additional: ({ name: string } & CodexQuotaLimit)[];
  fetched_at: string;
}
export type CodexQuotaResult = CodexQuota | { error: string };

/** One logged-in ChatGPT subscription account. Several can be kept; one is in use. Never includes a token. */
export interface OpenAIAccount {
  /** The ChatGPT account id from the login. */
  id: string;
  email?: string;
  plan_type?: string;
  /** The account requests are sent with right now. */
  active: boolean;
  /** Its quota, read just now; `{ error }` when that account's query failed. */
  usage: CodexQuotaResult;
}

/** How a provider authenticates. "login" exists for Claude only. */
export type AuthMode = "api_key" | "login";

/** The last outcome of a provider's model calls since the app started. */
export interface ProviderHealth {
  status: "ok" | "rate_limited" | "quota" | "error";
  /** When it was recorded (ms since epoch). */
  at: number;
  /** Plain-words reason for a failure. */
  message?: string;
}

/** A provider as the settings screen sees it. The API key itself never leaves the main process. */
export interface ProviderView {
  /** Optional build-injected free provider; enabled defaults to true. */
  builtinFree?: boolean;
  enabled?: boolean;
  /** Absent until the provider has been called. */
  health?: ProviderHealth;
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  model: string;
  /** Example model ids to pick from. The user can type any other id. */
  suggestedModels: string[];
  /** Where to create an API key, shown as a hint. */
  keyHint: string;
  /** Local servers such as Ollama work without a key. */
  needsKey: boolean;
  hasKey: boolean;
  /** "env": from an environment variable instead of the app. */
  keySource: "saved" | "env" | "none";
  authMode: AuthMode;
  /** The chat's thinking-depth selector does something for this provider. */
  supportsEffort: boolean;
  /** Can report the account balance (DeepSeek). */
  hasBalance: boolean;
  /** Claude only: whether an Anthropic account login is available. */
  login?: AnthropicLogin;
  /** ChatGPT subscription sign-in status; independent of API-key inference readiness. */
  openaiLogin?: OpenAILogin;
  /** More models this key can use, offered as group-chat members. */
  models: string[];
  /** Added by the user (can be renamed and removed). */
  custom: boolean;
  /** Set when the provider offers both OpenAI formats: the one in use. */
  openaiApi?: OpenAIApi;
}

export interface ProvidersState {
  providers: ProviderView[];
  activeId: string;
  vision: VisionSetting & { ready: boolean };
  /** ready: the chosen provider has what it needs (always true when following the conversation). */
  reviewer: ReviewerSetting & { ready: boolean };
  /** Editor autocomplete with DeepSeek FIM; ready when a DeepSeek key is set. */
  completion: { enabled: boolean; ready: boolean };
  /** False when the OS keychain is unavailable, so keys cannot be saved encrypted. */
  canEncrypt: boolean;
  /** The decision model (TypeSafe Jev through TokenDance) behind the decide tool. */
  decision: DecisionState;
  /** Failover, routing by difficulty and models per purpose; each ModelRef says whether it can run. */
  routing: RoutingSettings & { ready: Record<string, boolean> };
}

/** Jev models served by TokenDance's typesafe:systemone protocol. */
export const DECISION_MODELS = [
  { id: "bocha-jev-v1", name: "Bocha Jev V1（博查，限时免费）" },
  { id: "ateve-jev-v1", name: "Ateve Jev V1" },
] as const;

export interface DecisionState {
  model: string;
  hasKey: boolean;
  /** builtin: the free key shipped with the app (used when the user hasn't set their own). */
  keySource: "saved" | "env" | "builtin" | "none";
}

export interface DecisionUpdate {
  model?: string;
  /** A new TokenDance key to save. Omit to keep the current one. */
  apiKey?: string;
}

export interface DecisionTestResult {
  ok: boolean;
  /** Round trip in milliseconds. */
  ms: number;
  message: string;
}

/** One saved conversation: what the chat shows, rebuilt from the recorded events. */
export type TranscriptItem =
  | { role: "user"; text: string; images?: string[]; files?: FileChip[]; createdAt?: number; source?: { kind: "desktop" | "wechat" | "mobile"; deviceName?: string } }
  | { role: "ai"; events: AgentEvent[]; createdAt?: number };

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  providerId: string;
  providerName: string;
  model: string;
}

export interface LoadedSession {
  id: string;
  transcript: TranscriptItem[];
  /**
   * Set when the conversation can be read but not continued yet: it used another provider
   * (switch to continue), or its provider is not set up (fix the settings to continue).
   */
  locked?: { providerId: string; providerName: string; reason: "other_provider" | "not_ready"; message?: string };
}

export interface ProviderUpdate {
  /** Only applies to built-in free providers. False removes it from all model routing. */
  enabled?: boolean;
  id: string;
  baseURL?: string;
  model?: string;
  /** A new key to save. Omit to keep the current one. */
  apiKey?: string;
  authMode?: AuthMode;
  /** More models this key can use (group-chat members). */
  models?: string[];
  openaiApi?: OpenAIApi;
  /** Custom providers only. */
  name?: string;
  kind?: "openai" | "anthropic";
}

/** One page of the project wiki (an AI-written guide to the open project). */
export interface WikiPage {
  id: string;
  title: string;
  /** What the page covers, from the plan. */
  description: string;
  /** Project files the page explains (relative paths). */
  files: string[];
  /** Markdown with Mermaid diagrams; absent until written. */
  content?: string;
  /** One of its files changed since it was written. */
  stale?: boolean;
  error?: string;
}

export interface WikiState {
  title: string;
  summary: string;
  pages: WikiPage[];
  generatedAt?: number;
  /** "provider · model" that wrote it. */
  model?: string;
  running: boolean;
  /** While running: what is happening now. */
  progress?: { done: number; total: number; label: string };
  error?: string;
}

/** A question asked from the wiki, about one page and optionally a passage selected in it. */
export interface WikiAskRequest {
  pageId?: string;
  question: string;
  /** Text the user selected in the page. */
  quote?: string;
  /** Which configured provider answers (its current model). */
  providerId: string;
  /** Earlier questions and answers on this page, oldest first. */
  history: { question: string; answer: string }[];
}

export interface WikiAnswer {
  answer: string;
  /** "provider · model" that answered. */
  model: string;
}

/**
 * 知识图谱: a project or a document broken into flat, typed nodes and the relations between
 * them. Layers are fixed by node kind, not chosen by the model, so the same input lays out the
 * same way every time.
 */
export type GraphNodeKind =
  // From code
  | "entry" | "feature" | "module" | "data"
  // From documents ("feature" is shared)
  | "goal" | "requirement" | "interface" | "constraint";

export type GraphEdgeKind = "contains" | "depends" | "calls" | "implements" | "constrains" | "produces" | "uses";

/** Where a node comes from: a project file (and line), or a passage of a document. */
export interface GraphSource {
  file?: string;
  line?: number;
  section?: string;
  /** Words copied from the document, checked to really be in it. */
  quote?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** Column in the layered view, from the kind. */
  layer: number;
  summary: string;
  sources: GraphSource[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** Imports between two modules: how many. */
  weight?: number;
}

export type GraphOrigin = { type: "code" } | { type: "doc"; name: string; path: string; external: boolean };

export interface KnowledgeGraph {
  id: string;
  title: string;
  summary: string;
  origin: GraphOrigin;
  /** Layer names, left to right. */
  layers: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt: number;
  /** "provider · model" that built it. */
  model: string;
  /** The code or the document changed since it was built. */
  stale?: boolean;
}

export interface GraphListItem {
  id: string;
  title: string;
  origin: GraphOrigin;
  nodes: number;
  generatedAt: number;
  stale?: boolean;
}

export interface GraphState {
  graphs: GraphListItem[];
  /** The graph being built, and how far along. */
  running: { id: string; label: string; done: number; total: number } | null;
  error?: string;
}

/** The ArkTS language server for .ets files (needs an OpenHarmony SDK from DevEco Studio). */
export interface ArktsStatus {
  state: "idle" | "starting" | "ready" | "no-sdk" | "error";
  sdkPath?: string;
  message?: string;
}

export type ArktsFeature = "completion" | "resolve" | "hover" | "definition" | "signatureHelp";

export interface ArchiveProgress {
  phase: "scan" | "zip" | "done" | "error";
  /** Bytes done and in all (zip), or 0 while scanning. */
  done: number;
  total: number;
  /** The file being added, the finished archive's path, or the error. */
  label: string;
}

export interface ArchiveResult {
  file: string;
  files: number;
  bytes: number;
  /** Left out: symlinks and very large files. */
  skipped: { path: string; reason: string }[];
}

/** A recent project whose latest conversation still has open plan steps. */
export interface UnfinishedTask {
  root: string;
  project: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  providerId: string;
  providerName: string;
  done: number;
  total: number;
  remaining: string[];
}

/** One process on the computer, for the island's process card. mem in bytes, cpu in percent. */
export interface ProcInfo {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
}

/** Voice input's transcription service (OpenAI-compatible /audio/transcriptions). */
export interface VoiceSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** No key of its own, but the MiMo provider's key covers this address. */
  sharedKey: boolean;
}

/** Which key is held to talk (the choices differ on Mac and Windows). */
export type DictationKey = "right-alt" | "right-meta" | "right-shift" | "right-ctrl" | "menu";

/** Dictation anywhere: hold a key, talk, the text is typed where the cursor is. */
export interface DictationView {
  enabled: boolean;
  /** Listening for the key right now (permissions in place). */
  running: boolean;
  /** The key to hold, and the ones this system offers. */
  key: DictationKey;
  keys: { id: DictationKey; label: string }[];
  /** The system's microphone switch for sikeoop. */
  mic: "granted" | "denied" | "unknown";
  /** Why it can't run (permission, native module). */
  error?: string;
}

/** The dictation bubble: listening (holds the microphone), handing over the audio, transcribing, or a short error. */
export interface DictationState {
  phase: "idle" | "listening" | "sending" | "thinking" | "error";
  message?: string;
}

/** The dictation bubble window's API (window.dictation). */
export interface DictationApi {
  onState(cb: (s: DictationState) => void): () => void;
  /** The recording as WAV once listening stops (empty with `error` when the microphone failed). */
  audio(wav: ArrayBuffer, error?: string): void;
}

/** A Claude Code / Codex session in a terminal tab, as the island and the agent bus see it. */
export interface AgentSessionView {
  id: string;
  /** Claude-1, Codex-2… also its address for send_to. */
  name: string;
  /** "claude", "codex", or the id of an extension CLI. */
  cli: AgentCliId;
  /** What the CLI is called, for an extension CLI (the built-in two are named by the interface). */
  cliName?: string;
  status: "starting" | "working" | "waiting" | "idle";
  /** What it is doing, or its last words. */
  detail: string;
  /** When the status last changed. */
  since: number;
  /** Set for a member of a cross-project session: that session's id. */
  group?: string;
}

/**
 * The `code` of term:exit for a cross-project session member's tab (s:<sessionId>:<agentId>) that
 * sikeoop ended itself: -101 the user removed the member, -102 the session ended. A program that
 * exits on its own reports its real exit code, which is never negative.
 */
export type MemberExitCode = -101 | -102;

/** Regression panel: which side of the app an item checks. */
export type RegressOwner = "frontend" | "backend" | "both";
/** pending = the reply had no RESULT line, waiting for the user. */
export type RegressVerdict = "pass" | "fail" | "pending";

/** One check in the regression panel, stored in .sikeoop/regress/items.json. */
export interface RegressItem {
  id: string;
  title: string;
  /** How to verify it. */
  detail: string;
  owner: RegressOwner;
  /** A pass condition that can be judged objectively. */
  criteria: string;
  createdAt: number;
  updatedAt: number;
}

/** An item as a session proposes it, before the user adds it. */
export interface RegressCandidate {
  title: string;
  detail: string;
  owner: RegressOwner;
  criteria: string;
}

/** One run of one item on one session, a line of .sikeoop/regress/runs.jsonl. */
export interface RegressRun {
  id: string;
  itemId: string;
  /** Session name, e.g. Codex-1. */
  session: string;
  cli: AgentCli;
  startedAt: number;
  endedAt: number | null;
  status: "queued" | "running" | "done" | "timeout" | "gone" | "cancelled" | "error";
  /** Verdict parsed from the RESULT line. */
  auto: RegressVerdict;
  /** Effective verdict: auto unless the user overrode it. */
  verdict: RegressVerdict;
  overridden: boolean;
  /** The reason after RESULT, at most 500 chars. */
  reason: string;
  /** The last 2KB of the reply; the full reply is read with regressReply. */
  excerpt: string;
  error?: string;
}

/** A named snapshot of the latest verdicts, per item and per CLI. */
export interface RegressBaseline {
  id: string;
  name: string;
  createdAt: number;
  results: Record<string, Partial<Record<AgentCli, { runId: string; verdict: RegressVerdict }>>>;
}

/** One row of comparing the latest verdicts against a baseline (same CLI on both sides). */
export interface RegressDiffRow {
  itemId: string;
  cli: AgentCli;
  base: RegressVerdict | null;
  now: RegressVerdict | null;
  kind: "regressed" | "fixed" | "same" | "new" | "missing";
}

/** User-tunable limits, stored in .sikeoop/regress/settings.json. */
export interface RegressSettings {
  /** Seconds to wait for one item's reply (30–3600). */
  runTimeoutSec: number;
  /** Seconds to wait for a generate reply (60–3600). */
  generateTimeoutSec: number;
  /** Most items one run request may queue (1–200). */
  maxPerBatch: number;
  /** Most candidates one generate may return (1–100). */
  maxCandidates: number;
}

/** Everything the regression panel shows. */
export interface RegressView {
  /** The open project, or null when none is open (all actions then fail). */
  root: string | null;
  items: RegressItem[];
  /** Latest run of each item, per CLI. */
  latest: Record<string, Partial<Record<AgentCli, RegressRun>>>;
  /** Items whose latest Claude and Codex verdicts are both decided and differ. */
  conflicts: string[];
  baselines: { id: string; name: string; createdAt: number }[];
  /** Sessions currently used by the panel, and run ids queued or running. */
  busy: { generate?: { session: string; startedAt: number }; sessions: string[]; runs: string[] };
  settings: RegressSettings;
}

/** What the Dynamic Island shows: the most important thing happening now. */
export type IslandState = (
  | { kind: "idle"; providerId: string; usage?: { today: string; total: string } }
  | { kind: "working"; providerId: string; text: string }
  | { kind: "done"; providerId: string; text: string; detail: string }
  /** An action waits for approval: the island has approve / reject buttons. */
  | { kind: "ask"; providerId: string; id: string; title: string; detail: string; warning?: string; options?: AcpPermissionOption[] }
  /** The AI asked a question: answering happens in the window. */
  | { kind: "question"; providerId: string; title: string }
  | { kind: "error"; providerId: string; text: string }
  /** A long background job (archive, wiki). pct 0–100, or null when unknown. */
  | { kind: "progress"; providerId: string; label: string; pct: number | null }
  /** Claude Code / Codex sessions running in the terminal tabs. */
  | { kind: "cli"; providerId: string; sessions: AgentSessionView[] }
  /** A screenshot was taken: thumbnail (data URL) and a box for the question. */
  | { kind: "shot"; providerId: string; image: string; /** The image is also on the clipboard. */ copied?: boolean }
  /** The vision model is reading the screenshot. */
  | { kind: "shotThinking"; providerId: string; image: string; question: string }
  /** Its answer. */
  | { kind: "shotAnswer"; providerId: string; image: string; question: string; answer: string; model: string }
  /** Every running process (opened from the idle island), sorted by `sort`. */
  /** Voice input: recording (the island holds the microphone), uploading, or being transcribed. */
  | { kind: "voice"; providerId: string; phase: "listening" | "sending" | "thinking"; startedAt: number }
  | { kind: "procs"; providerId: string; procs: ProcInfo[]; total: number; sort: "cpu" | "mem" }
) & {
  /** How many other things are going on behind the one shown. */
  badge?: number;
};

/**
 * How the island sits on this screen. "notch": a Mac with a camera notch: the island hangs from
 * the top edge around the notch (flat top, rounded bottom) and grows downward as a rectangle;
 * `top` is the notch / menu-bar height in px. "pill": a floating capsule below the top edge.
 */
export interface IslandLayout {
  mode: "notch" | "pill";
  top: number;
}

/** The narrow API the island window gets (window.island). */
export interface IslandApi {
  onState(cb: (s: IslandState) => void): () => void;
  onLayout(cb: (l: IslandLayout) => void): () => void;
  /** The pointer is over the island (it takes clicks) or not (clicks pass through). */
  hover(over: boolean): void;
  /** Clicked: bring sikeoop's window to the front. */
  open(): void;
  /** The island finished showing "done" / "error" and went back on its own. */
  settled(): void;
  /** Approve or reject the action shown in the "ask" state. */
  decide(id: string, approve: boolean): void;
  /** ACP cards return the original optionId, never an approve/reject translation. */
  selectAgentPermission(id: string, optionId: string | null): void;
  /** Screenshot flow: ask about it (empty = describe it), close it, copy the answer, continue in the chat. */
  shotAsk(question: string): void;
  shotClose(): void;
  shotCopy(): void;
  shotToChat(): void;
  /** Open / close the process card, or change its sort. */
  procs(open: boolean, sort?: "cpu" | "mem"): void;
  /** Bring sikeoop forward on this agent session's terminal tab. */
  focusAgent(id: string): void;
  /** Voice input: start listening, stop and send, or cancel. */
  voice(action: "start" | "stop" | "cancel"): void;
  /** The recording, once stopped (empty when the microphone could not be used; `error` says why). */
  voiceAudio(audio: ArrayBuffer, mime: string, error?: string): void;
}

/** The screenshot overlay's API (window.snip): the frozen screen, then the chosen area. */
export interface SnipApi {
  onImage(cb: (dataUrl: string) => void): () => void;
  /** CSS px of the overlay; null = cancelled. Whole screen when width/height are 0. */
  done(rect: { x: number; y: number; width: number; height: number } | null): void;
}

/** Tokens one provider × model used on one day. */
export interface UsageModelRow {
  providerId: string;
  providerName: string;
  model: string;
  /** Input not read from the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

export interface UsageDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** Keyed by "providerId::model". */
  models: Record<string, UsageModelRow>;
}

/** Everything the token ledger holds, oldest day first (days without use are absent). */
export interface UsageSummary {
  firstDay: string | null;
  today: string;
  days: UsageDay[];
}

/** Group chat needs at least this many available members (provider × model). */
export const GROUP_MIN_CANDIDATES = 5;

/** A provider × model that can join a group chat. */
export interface GroupCandidate {
  providerId: string;
  providerName: string;
  model: string;
}

export interface GroupMember extends GroupCandidate {
  id: string;
  /** Shown name in the chat (the partner's name, or one the user picked). */
  name: string;
}

export interface GroupMessage {
  id: string;
  /** "user" = the person; "member" = one of the AIs. */
  from: "user" | "member";
  memberId?: string;
  text: string;
  at: number;
  /** The member's reply failed (network, quota…). */
  error?: string;
}

export interface GroupSummary {
  id: string;
  title: string;
  members: GroupMember[];
  updatedAt: number;
}

export interface GroupChat extends GroupSummary {
  messages: GroupMessage[];
  /** The division of work the group last settled on (main/group/plan.ts). */
  plan?: GroupPlan;
}

/** One piece of a group's plan: who does what. */
export interface GroupPlanTask {
  id: string;
  title: string;
  /** Who does it, as send_to_agent names them: a model ("provider/model") or a terminal session (Claude-1). */
  assignee: string;
  /** What to do, written for someone who has not read the discussion. */
  what: string;
  /** Files or folders it may change (relative to the project); empty for read-only work. */
  owns: string[];
  /** Ids of the tasks that must finish first. */
  after: string[];
  /** How to tell it is done. */
  accept: string;
}

/**
 * What a group discussion settled: whether the idea works, and the division of work. Handed to the
 * main conversation, which only hands the tasks out as written.
 */
export interface GroupPlan {
  goal: string;
  feasible: boolean;
  /** The conclusion in a few sentences, with the reason when it is not feasible. */
  summary: string;
  tasks: GroupPlanTask[];
  /** What the group did not agree on: the user decides these before any work starts. */
  open: string[];
  /** The member who wrote it up. */
  by: string;
  at: number;
}

/** Live updates while members reply. */
export type GroupEvent =
  | { type: "speaking"; groupId: string; memberId: string; messageId: string }
  | { type: "delta"; groupId: string; messageId: string; text: string }
  | { type: "message"; groupId: string; message: GroupMessage }
  | { type: "plan"; groupId: string; plan: GroupPlan }
  | { type: "idle"; groupId: string };

// ---- Automations: a state machine of steps, started by a schedule ----

/** When an automation starts on its own. Times are the computer's local time. */
export type AutomationSchedule =
  | { kind: "manual" }
  | { kind: "interval"; minutes: number }
  /** "HH:MM"; days 0 (Sunday) … 6, empty = every day. */
  | { kind: "daily"; time: string; days: number[] }
  | { kind: "once"; at: number };

/** Built-in outcomes every step can end with; agent steps may add their own. */
export const AUTOMATION_OK = "ok";
export const AUTOMATION_FAIL = "fail";
/** A transition target that ends the run. */
export const AUTOMATION_END = "end";

/** Where the run goes when a step ends with `on`. Outcomes without a transition end the run. */
export interface AutomationTransition {
  on: string;
  /** A state id, or AUTOMATION_END. */
  to: string;
}

/** One state of the machine. agent: a message to the AI; command: a bash command, no AI. */
export interface AutomationState {
  id: string;
  name: string;
  kind: "agent" | "command" | "browser_flow";
  text: string;
  next: AutomationTransition[];
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  /** The state a run starts in. */
  start: string;
  states: AutomationState[];
  effort: Effort;
  createdAt: number;
  updatedAt: number;
  /** null: no scheduled run (manual, finished one-off, or switched off). */
  nextRunAt: number | null;
}

export type AutomationInput = Omit<Automation, "id" | "createdAt" | "updatedAt" | "nextRunAt"> & { id?: string };

export interface AutomationStep {
  stateId: string;
  name: string;
  kind: AutomationState["kind"];
  startedAt: number;
  endedAt?: number;
  outcome?: string;
  /** The AI's summary, or the end of a command's output. */
  summary?: string;
  /** What the step is doing right now (the AI's latest tool), while it runs. */
  activity?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  name: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "failed" | "cancelled" | "missed";
  startedAt: number;
  endedAt?: number;
  steps: AutomationStep[];
  /** The conversation the agent steps ran in; it can be opened in the chat afterwards. */
  sessionId?: string;
  note?: string;
}

/** One dispatch to a Harmony cluster role (dispatch_agent), as the cluster console shows it. */
export interface ClusterRun {
  id: string;
  role: string;
  goal: string;
  status: "running" | "ok" | "fail" | "blocked" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  /** What the role is doing right now (its latest tool call), while it runs. */
  activity: string;
  /** From the role's output envelope, once it has finished. */
  summary: string;
  /** route.role of the envelope: the role the envelope asks to run next. */
  routeRole: string | null;
  errors: string[];
}

/** The cluster console. A "batch" runs from the first dispatch until nothing is running. */
export interface ClusterView {
  runs: ClusterRun[];
  running: number;
  batchTotal: number;
  batchDone: number;
  batchFailed: number;
}

/** The current project's automations and their recent runs (newest first). */
export interface AutomationView {
  automations: Automation[];
  runs: AutomationRun[];
  /** The automation running right now, if any. */
  runningId: string | null;
}

/** WeChat remote control (main/remote/wechat.ts). */
export interface RemoteView {
  /** qr: waiting for a scan of qrUrl; scanned: waiting for the confirmation on the phone; verify: waiting for the code shown there. */
  status: "off" | "connecting" | "qr" | "scanned" | "verify" | "online";
  qrUrl: string | null;
  /** The code typed last time was wrong. */
  verifyRetry: boolean;
  /** A message from WeChat is being worked on. */
  busy: boolean;
  error: string;
}

export interface SnipGestureState {
  /** "quadClick" on macOS (trackpad), "sideButton" on Windows (mouse). */
  kind: "quadClick" | "sideButton";
  enabled: boolean;
  /** Windows: 4 = back button, 5 = forward button. */
  sideButton: 4 | 5;
  /** Why it isn't running (a permission, a missing component). */
  error?: string;
}

/** The web_search engine setting. */
export interface WebSearchState {
  engine: "auto" | "duckduckgo" | "tavily" | "brave";
  /** What "auto" (or a choice without its key) resolves to right now. */
  using: "duckduckgo" | "tavily" | "brave";
  hasKey: { tavily: boolean; brave: boolean };
}

/** Sound effects the main process asks the window to play. */
export type SoundName = "done" | "ask" | "question" | "error" | "job" | "group";

/** Coding CLIs the terminal can start in workspace mode. */
export type AgentCli = "claude" | "codex";

/**
 * Any CLI a terminal tab can run as an agent session: the built-in two, or an extension CLI's id
 * (a definition file in the user's extension folder, docs/cli-扩展开发文档.md).
 */
export type AgentCliId = AgentCli | (string & {});

/** One entry of the "new tab" menu. */
export interface AgentKindInfo {
  id: AgentCliId;
  name: string;
  description?: string;
  /** False for an extension CLI. */
  builtin: boolean;
  /** Whether its executable was found. */
  installed: boolean;
  /** It has a one-click install command. */
  canInstall: boolean;
  /** Its executable names, to notice it being started by hand in a shell tab. */
  bins?: string[];
}

/** The CLIs a tab can start, and the extension files that couldn't be used. */
export interface AgentKinds {
  kinds: AgentKindInfo[];
  problems: { file: string; problems: string[] }[];
  /** The folder extension definitions are read from. */
  dir: string;
}

/** The API exposed on window.sweet by the preload script. */
/** One device or emulator that adb can see. state is "device", "offline", "unauthorized" and so on. */
export interface AndroidDevice {
  serial: string;
  state: string;
}

/** What the Android panel shows: the local SDK, its AVDs (virtual devices) and the connected devices. */
export interface AndroidState {
  /** The Android SDK folder found on this computer, or null. */
  sdkRoot: string | null;
  adb: boolean;
  emulator: boolean;
  avds: string[];
  devices: AndroidDevice[];
}

/** One visit in the built-in browser's history. */
export interface BrowserHistoryItem {
  url: string;
  title: string;
  at: number;
}

/** A saved login of the built-in browser. The password itself never leaves the main process. */
export interface BrowserLogin {
  id: string;
  origin: string;
  username: string;
  updatedAt: number;
}

export interface BrowserFlowSelector {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
  frameUrl?: string;
}
export interface BrowserFlowStep {
  action: "click" | "fill" | "select" | "check" | "press" | "navigate" | "upload";
  selector?: BrowserFlowSelector;
  text?: string;
  url?: string;
  key?: string;
  checked?: boolean;
  files?: string[];
  password?: boolean;
  description?: string;
}
export interface BrowserFlow {
  version: 1;
  name: string;
  createdAt: number;
  updatedAt: number;
  steps: BrowserFlowStep[];
  history: { step: number; at: number; before: BrowserFlowSelector; after: BrowserFlowSelector }[];
}
export interface BrowserFlowRecordingOptions {
  /** Default: parameterize all non-password values. */
  values?: "record" | "parameterize";
}
export interface BrowserFlowRunOptions { selfHeal?: boolean }
export interface BrowserFlowRunResult {
  completed: number;
  total: number;
  failedStep: number | null;
  reason: string | null;
  snapshot: string | null;
}

export interface BrowserAutomationState {
  status: "running" | "paused" | "done" | "error";
  /** 1-based current step; zero before the first step. */
  step: number;
  total: number;
  description: string;
  reason: string | null;
  pauseReason?: "user" | "manual" | "approval" | "error";
}

export interface BrowserSettings {
  /** Omitted by older clients: retain current speed; default normal. */
  automationSpeed?: "demo" | "normal" | "fast";
  /** What the address bar searches with. */
  engine: "bing" | "baidu" | "google";
}

export interface BrowserState {
  settings: BrowserSettings;
  logins: BrowserLogin[];
  /** The page in front has a login form, on this origin. */
  loginFormOrigin: string | null;
}

/** From the main process to the browser pane. */
export type BrowserEvent =
  /** The agent wants the browser (the pane opens). */
  | { type: "open" }
  /** A dev server printed its address in the terminal. */
  | { type: "suggest"; url: string }
  | { type: "login-form"; origin: string; present: boolean; logins: BrowserLogin[] }
  /** The page submitted a login: ask whether to save it. update: one for this account exists. */
  | { type: "offer-login"; origin: string; username: string; update: boolean };

export type PvKind = "promo" | "music";
export type PvStep = "brief" | "script" | "storyboard" | "beats" | "assets" | "compose" | "render";
export interface PvShot { id: string; seconds: number; framing: string; camera: string; visual: string; caption?: string; transition?: string; source: "code" | "file" | "screen" | "ai"; asset?: string }
export interface PvProject { id: string; name: string; kind: PvKind; ratio: "16:9" | "9:16" | "1:1"; seconds: number; dir: string; steps: Record<PvStep, "todo" | "running" | "done" | "error">; updatedAt: number; music?: string }
export interface PvAsset { file: string; kind: "image" | "video" | "audio"; bytes: number; seconds?: number }
export interface PvBeats { file: string; bpm: number; offset: number; beatsPerBar: number; duration: number; beats: number[]; bars: number[]; confidence: number }
export interface PvStoryboard { shots: PvShot[] }
export interface PvPack { id: string; name: string; kind: PvKind | "common"; entries: { id: string; title: string; body: string; steps: PvStep[] }[] }
export interface PvFfmpegState { hint?: string; status: "missing" | "downloading" | "ready" | "error"; progress?: number; path?: string; error?: string }

export interface SweetApi {
  pvList(root: string): Promise<PvProject[]>;
  pvAssets(root: string, id: string): Promise<PvAsset[]>;
  pvImportAssets(root: string, id: string): Promise<PvAsset[]>;
  pvRemoveAsset(root: string, id: string, file: string): Promise<void>;
  pvAssetUrl(root: string, id: string, file: string): Promise<string>;
  pvSetMusic(root: string, id: string, file: string | null): Promise<PvProject>;
  pvBeats(root: string, id: string): Promise<PvBeats | null>;
  pvSetBeatGrid(root: string, id: string, grid: { bpm: number; offset: number; beatsPerBar: number }): Promise<PvBeats>;
  pvSnapStoryboard(root: string, id: string, unit: "bar" | "beat"): Promise<PvStoryboard>;
  pvCreate(root: string, input: Pick<PvProject, "name" | "kind" | "ratio" | "seconds">): Promise<PvProject>;
  pvGet(root: string, id: string): Promise<PvProject | null>;
  pvRunStep(root: string, id: string, step: PvStep, note?: string): Promise<string>;
  pvCancel(root: string, id: string): Promise<void>;
  pvReadFile(root: string, id: string, file: string): Promise<string>;
  pvWriteFile(root: string, id: string, file: string, text: string): Promise<void>;
  pvStoryboard(root: string, id: string): Promise<PvStoryboard>;
  pvSaveStoryboard(root: string, id: string, sb: PvStoryboard): Promise<void>;
  pvPacks(): Promise<PvPack[]>;
  pvFfmpeg(): Promise<PvFfmpegState>;
  pvFfmpegDownload(): Promise<PvFfmpegState>;
  pvPreviewUrl(root: string, id: string, file: string): Promise<string>;
  pvRenderPreview(root: string, id: string): Promise<string>;
  onPvProgress(cb: (event: { id: string; step: PvStep; status: PvProject["steps"][PvStep]; message?: string }) => void): () => void;

  session: CrossSessionApi;
  /** Pick a folder to open. "new" lets the user create an empty folder in the dialog. */
  openFolder(kind?: "open" | "new"): Promise<{ root: string; tree: FileNode[] } | null>;
  /** Reopen a folder from the recent list. */
  openRecent(path: string): Promise<{ root: string; tree: FileNode[] }>;
  /** Create ~/sikeoop 作品/<title> with a starter prototype and open it as the project. */
  createWebStarter(title: string): Promise<{ root: string; tree: FileNode[] }>;
  listRecent(): Promise<RecentProject[]>;
  removeRecent(path: string): Promise<RecentProject[]>;
  refreshTree(): Promise<FileNode[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  getProviders(): Promise<ProvidersState>;
  updateProvider(update: ProviderUpdate): Promise<ProvidersState>;
  clearProviderKey(id: string): Promise<ProvidersState>;
  /** Switching provider starts a new conversation. */
  setActiveProvider(id: string): Promise<ProvidersState>;
  /** Ask the provider which models this key can use. */
  listModels(id: string): Promise<string[]>;
  /** Cached generic discovery, falling back to static preset ids on failure. */
  providerDiscoverModels(providerId: string): Promise<string[]>;
  /** Built-in Claude OAuth: build the browser authorization link (PKCE, 30min session). */
  claudeOAuthGenerate(scope: ClaudeOAuthScope): Promise<ClaudeOAuthAuthUrl>;
  /** Built-in Claude OAuth: exchange the pasted code for tokens and persist them. */
  claudeOAuthExchange(input: { session_id: string; code: string }): Promise<ProvidersState>;
  /** Built-in Claude OAuth: drop the stored OAuth token. */
  claudeOAuthLogout(): Promise<ProvidersState>;
  /** ChatGPT OAuth: PKCE browser link, manual paste only; no local callback listener. */
  openaiOAuthGenerate(): Promise<OpenAIOAuthGenerateResult>;
  /** Paste a code, code#state or the complete localhost callback URL. */
  openaiOAuthExchange(input: OpenAIOAuthExchangeInput): Promise<ProvidersState>;
  openaiOAuthLogout(): Promise<ProvidersState>;
  /** Query the Claude subscription usage (four windows). Returns `{ error }` on failure, never throws. */
  claudeUsage(): Promise<ClaudeUsageResult>;
  /**
   * Every logged-in Claude account with its usage. Adding one is the normal login
   * (claudeOAuthGenerate / claudeOAuthExchange): the new account is kept beside the others and becomes active.
   */
  claudeAccounts(): Promise<ClaudeAccount[]>;
  /** Use this account from now on. Throws while a chat turn is running. */
  claudeAccountSwitch(id: string): Promise<ClaudeAccount[]>;
  /** Log one account out. Removing the active one makes another active, if any is left. */
  claudeAccountRemove(id: string): Promise<ClaudeAccount[]>;
  claudeResetCredits(): Promise<ClaudeResetCreditsResult>;
  openaiUsage(): Promise<CodexQuotaResult>;
  /**
   * Every logged-in ChatGPT account with its quota. Adding one is the normal login
   * (openaiOAuthGenerate / openaiOAuthExchange): the new account is kept beside the others and becomes active.
   */
  openaiAccounts(): Promise<OpenAIAccount[]>;
  /** Use this account from now on. Throws while a chat turn is running. */
  openaiAccountSwitch(id: string): Promise<OpenAIAccount[]>;
  /** Log one account out. Removing the active one makes another active, if any is left. */
  openaiAccountRemove(id: string): Promise<OpenAIAccount[]>;
  /** Persist an individual built-in free provider switch. */
  setBuiltinFreeProviderEnabled(providerId: string, enabled: boolean): Promise<ProvidersState>;
  setVision(v: VisionSetting): Promise<ProvidersState>;
  setReviewer(r: ReviewerSetting): Promise<ProvidersState>;
  setRouting(r: RoutingSettings): Promise<ProvidersState>;
  setDecision(u: DecisionUpdate): Promise<ProvidersState>;
  clearDecisionKey(): Promise<ProvidersState>;
  /** One small real call with the saved key and model. */
  testDecision(): Promise<DecisionTestResult>;
  setCompletion(enabled: boolean): Promise<ProvidersState>;
  /** Account balance, for providers that report it. */
  getBalance(id: string): Promise<Balance>;
  /** Fill-in-the-middle completion at the cursor. Returns "" when there is nothing to suggest. */
  fimComplete(req: { prefix: string; suffix: string }): Promise<string>;
  sendChat(req: ChatRequest): Promise<void>;
  cancelChat(): Promise<void>;
  respondApproval(r: ApprovalResponse): Promise<void>;
  /** Put back every file the agent changed in that turn. */
  undoTurn(turnId: number): Promise<UndoResult>;
  /** What the current conversation's context holds (null before it started). */
  contextUsage(): Promise<ContextUsage | null>;
  /** Have the compression sub-agent summarize the conversation now. */
  compactNow(): Promise<ContextUsage | null>;
  /** Start a new conversation. The current one is already saved. */
  resetChat(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<LoadedSession>;
  deleteSession(id: string): Promise<void>;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;

  /** Start (or restart) the terminal in the project folder. ok false: show message instead (e.g. no Git Bash). */
  termStart(tab: string, cols: number, rows: number): Promise<{ ok: boolean; message?: string }>;
  /**
   * Starts Claude Code or Codex in workspace mode in the terminal panel; banner lines explain the
   * rules. missing = the CLI isn't installed (offer termInstallCommand).
   */
  termStartAgent(tab: string, cli: AgentCliId, cols: number, rows: number): Promise<{ ok: boolean; message?: string; banner?: string[]; missing?: boolean; name?: string }>;
  /** The official install command for a CLI, to run in the terminal. */
  termInstallCommand(cli: AgentCliId): Promise<string>;
  /** Claude Code, Codex and the extension CLIs; read again on every call. */
  termAgentKinds(): Promise<AgentKinds>;
  /** Opens the extension folder in the file manager (created with a README on first use). */
  termOpenAgentKindsDir(): Promise<void>;
  termWrite(tab: string, data: string): void;
  termResize(tab: string, cols: number, rows: number): void;
  /** Ends a tab's program (the tab was closed). */
  termClose(tab: string): void;
  /** The Claude Code / Codex sessions in the tabs, and changes to them. */
  termAgents(): Promise<AgentSessionView[]>;
  onTermAgents(cb: (sessions: AgentSessionView[]) => void): () => void;
  /** The island asked to show a tab. */
  onTermFocus(cb: (tab: string) => void): () => void;
  onTermData(cb: (tab: string, data: string) => void): () => void;
  onTermExit(cb: (tab: string, code: number) => void): () => void;

  /** Plugins. New skills and MCP tools take effect in the next new conversation. */
  listSkills(): Promise<SkillInfo[]>;
  previewSkills(source: SkillSource): Promise<SkillPreview>;
  /** Pick a file / .zip or a folder, then preview it. null when the dialog was cancelled. */
  pickLocalSkills(kind: "file" | "folder"): Promise<SkillPreview | null>;
  answerQuestion(r: QuestionResponse): Promise<void>;
  /** Full before/after of a file change card (null once the session no longer has it). */
  diffSource(id: string): Promise<{ path: string; before: string; after: string } | null>;
  /** acceptRisk: the user ticked "install anyway" for candidates whose audit is danger. */
  installSkills(previewId: string, candidateIds: string[], acceptRisk?: boolean): Promise<SkillInfo[]>;
  /** Have a model read the previewed skills for malicious instructions; returns the updated preview. */
  aiReviewSkills(previewId: string): Promise<SkillPreview>;
  searchSkillHub(query: string): Promise<SkillHubItem[]>;
  removeSkill(name: string): Promise<SkillInfo[]>;
  setSkillEnabled(name: string, enabled: boolean): Promise<SkillInfo[]>;
  /** Reinstall any built-in skills the user deleted. */
  restoreBuiltinSkills(): Promise<SkillInfo[]>;
  listMcp(): Promise<McpServerView[]>;
  /** Android panel: SDK status, AVDs and connected devices. */
  /** Editor extensions from Open VSX (themes, syntax highlighting, language settings, snippets). */
  extSearch(query: string, offset?: number): Promise<{ total: number; items: ExtensionSearchItem[] }>;
  extInstalled(): Promise<InstalledExtension[]>;
  extInstall(id: string): Promise<InstalledExtension[]>;
  extUninstall(id: string): Promise<InstalledExtension[]>;
  extSetEnabled(id: string, on: boolean): Promise<InstalledExtension[]>;
  extContributions(): Promise<ExtensionContributions>;
  /** Fires after an install, removal or enable/disable: reload contributions. */
  onExtChanged(cb: () => void): () => void;
  /** App updates: current state, check now, restart to install, open the download page. */
  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  /** Start downloading a found version (when automatic download is off). */
  updateDownload(): Promise<UpdateState>;
  setUpdateAutoDownload(on: boolean): Promise<UpdateState>;
  updateInstall(): Promise<void>;
  updateOpenDownload(): Promise<void>;
  /** Asks, then removes the app (and the user's data if they say so). Resolves with why nothing happened, or "". */
  uninstallApp(): Promise<string>;
  onUpdateChanged(cb: (s: UpdateState) => void): () => void;
  /** The phone gateway (remote control from the sikeoop Android app). */
  mobileState(): Promise<MobileGatewayState>;
  /** Turns the gateway on (connects to the relay) or off (disconnects, devices kept). */
  mobileSetEnabled(on: boolean): Promise<MobileGatewayState>;
  /** ws:// only for this computer and private networks; anything else must be wss://. */
  mobileSetRelay(url: string, phoneUrl?: string): Promise<MobileGatewayState>;
  /** A fresh one-time QR code (replaces any showing). Needs the gateway on. */
  mobileCreatePairing(): Promise<MobilePairingQr>;
  mobileCancelPairing(): Promise<void>;
  /** Allow or deny the phone waiting in pendingDevice. */
  mobileApproveDevice(deviceId: string, allow: boolean): Promise<MobileGatewayState>;
  /** Removes a phone: its key stops working at once and its connection is dropped. */
  mobileRevoke(deviceId: string): Promise<MobileGatewayState>;
  onMobileChanged(cb: (s: MobileGatewayState) => void): () => void;
  androidState(): Promise<AndroidState>;
  androidStartAvd(name: string): Promise<void>;
  androidStop(serial: string): Promise<void>;
  androidInstall(serial: string, apkPath: string): Promise<string>;
  /** PNG of the device screen, as a data URL. */
  androidScreenshot(serial: string): Promise<string>;
  /** Asks the user for an .apk file; null when cancelled. */
  androidPickApk(): Promise<string | null>;
  /** Read a pasted MCP config (Claude Desktop, Cursor, VS Code or a single server). */
  parseMcpConfig(text: string): Promise<McpServerInput[]>;
  addMcpServers(servers: McpServerInput[]): Promise<McpServerView[]>;
  removeMcpServer(name: string): Promise<McpServerView[]>;
  setMcpEnabled(name: string, enabled: boolean): Promise<McpServerView[]>;
  setMcpTrusted(name: string, trusted: boolean): Promise<McpServerView[]>;
  reconnectMcp(name: string): Promise<McpServerView[]>;
  onMcpChanged(cb: (servers: McpServerView[]) => void): () => void;
  listMods(): Promise<ModView[]>;
  /** Asks for a mod folder or .zip and reads it; null when cancelled. */
  pickMod(kind: "folder" | "zip"): Promise<ModPreview | null>;
  /** Installs a previewed mod (copied into sikeoop), or links the folder in place when dev. */
  installMod(previewId: string, dev: boolean): Promise<ModView[]>;
  removeMod(id: string): Promise<ModView[]>;
  setModEnabled(id: string, enabled: boolean): Promise<ModView[]>;
  reloadMod(id: string): Promise<ModView[]>;

  /** Live GitHub stars of the resource library's repos, by card id (missing when offline). */
  resourceStars(): Promise<Record<string, number>>;
  /** Skills were installed or removed outside the plugin center (e.g. by the agent). */
  onSkillsChanged(cb: (skills: SkillInfo[]) => void): () => void;

  /** Prototype studio: prototypes/<name>/ in the open project. */
  protoList(): Promise<ProtoSummary[]>;
  protoLoad(name: string): Promise<ProtoDoc>;
  protoCreate(name: string): Promise<ProtoDoc>;
  protoAddScreen(name: string, screen: { title: string; device: ProtoDevice }): Promise<ProtoDoc>;
  /** Save positions, titles and the start screen. */
  protoSaveCanvas(name: string, canvas: ProtoCanvas): Promise<void>;
  /** The URL an artboard loads; version busts the cache after a change. */
  protoScreenUrl(name: string, file: string, version: number): string;

  /** One-click publish (see docs/方向A-一键发布-任务清单.md). */
  publishScan(req: PublishRequest): Promise<PublishScanResult>;
  /** Resolves when finished; progress and the result also arrive through onPublishEvent. */
  publishStart(req: PublishRequest): Promise<PublishRecord>;
  publishCancel(): Promise<void>;
  publishList(): Promise<PublishRecord[]>;
  /** Take a site offline; the record is removed. */
  publishUnpublish(siteId: string): Promise<void>;
  onPublishEvent(cb: (ev: PublishEvent) => void): () => void;

  /** The dispatch console (docs/调度核心-收拢方案.md P5). Jobs are kept per project. */
  dispatchAgentSubmit(input: DispatchAgentInput): Promise<{ jobId: string }>;
  dispatchAgentPermission(id: string, optionId: string | null): Promise<void>;
  onDispatchEvent(cb: (event: DispatchEvent) => void): () => void;
  /** The console list: each job without all of its progress and with long texts cut (see dispatchJob). */
  dispatchView(): Promise<DispatchView>;
  /** One job in full, for its expanded row. Null once it has dropped out of the history. */
  dispatchJob(jobId: string): Promise<DispatchJob | null>;
  /** The console is on screen (true) or not: dispatch:changed and dispatch:event are sent only while it is. */
  dispatchWatch(on: boolean): Promise<void>;
  /** Cancel a job and everything it started. */
  dispatchCancel(jobId: string): Promise<void>;
  onDispatchChanged(cb: (view: DispatchView) => void): () => void;

  /** Deep research (docs/方案-深度科研.md): Chain-Centric run as a separate process. */
  researchEnv(): Promise<ResearchEnv>;
  /** Create sikeoop's virtual environment and install the bundled package (asks nothing; the UI asks first). */
  researchInstall(): Promise<ResearchEnv>;
  researchPresets(): Promise<ResearchPreset[]>;
  /** Models of providers Chain-Centric supports, with whether their key is set. */
  researchCandidates(): Promise<ResearchCandidate[]>;
  /** Pick an evidence repository JSON file; null when cancelled. */
  researchPickRepository(): Promise<string | null>;
  researchStart(req: ResearchRequest): Promise<ResearchRun>;
  researchCancel(runId: string): Promise<void>;
  /** This project's runs, newest first. */
  researchList(): Promise<ResearchRun[]>;
  researchResult(runId: string): Promise<CcResult | null>;
  researchDelete(runId: string): Promise<void>;
  onResearchEvent(cb: (e: ResearchEvent) => void): () => void;

  /** Paper workshop (docs/方案-论文工坊.md). Papers and tasks are kept per project. */
  paperList(): Promise<PaperDoc[]>;
  /** Choose PDF files; each is read into the workshop. */
  paperPickPdf(): Promise<PaperDoc[]>;
  paperImport(source: PaperSource): Promise<PaperDoc>;
  paperGet(id: string): Promise<{ paper: PaperDoc; summary?: PaperSummary; translation?: PaperTranslation } | null>;
  paperDelete(id: string): Promise<void>;
  paperSummarize(id: string): Promise<PaperTask>;
  paperTranslate(id: string, lang: "zh" | "en"): Promise<PaperTask>;
  /** Draft evidence records from papers; the task ends with records for review. */
  paperExtract(ids: string[]): Promise<PaperTask>;
  paperCancel(taskId: string): Promise<void>;
  paperTasks(): Promise<PaperTask[]>;
  /** Save reviewed records as research/<name>.repository.json (quotes kept in a side file). */
  evidenceSave(name: string, records: EvidenceRecord[]): Promise<EvidenceRepoFile>;
  evidenceList(): Promise<EvidenceRepoFile[]>;
  evidenceLoad(path: string): Promise<EvidenceRecord[]>;
  /** Export a paper's summary and translation as Markdown into the project. */
  paperExport(id: string): Promise<string>;
  writingRun(req: WritingRequest): Promise<WritingResult>;
  arxivLookup(idOrUrl: string): Promise<ArxivEntry>;
  arxivSearch(query: string, start?: number): Promise<{ entries: ArxivEntry[]; total: number }>;
  /** Shown once before the first arXiv request; true after the user agreed. */
  arxivConsent(): Promise<boolean>;
  grantArxivConsent(): Promise<void>;
  promptPresets(): Promise<PromptPreset[]>;
  savePromptPreset(p: PromptPreset): Promise<PromptPreset[]>;
  deletePromptPreset(id: string): Promise<PromptPreset[]>;
  promptPackState(): Promise<PromptPackState>;
  /** Download gpt_academic's prompt definitions from its repository and parse them (the user asked). */
  promptPackImport(): Promise<PromptPackState>;
  promptPackRemove(): Promise<PromptPackState>;
  onPaperEvent(cb: (e: PaperEvent) => void): () => void;

  /** Auto-resume after a usage limit. */
  quotaSettings(): Promise<QuotaSettings>;
  setQuotaSettings(s: QuotaSettings): Promise<QuotaSettings>;
  /** Waiting plans first, then recent finished ones. */
  resumePlans(): Promise<ResumePlan[]>;
  cancelResumePlan(id: string): Promise<ResumePlan[]>;
  /** Continue now instead of waiting. */
  resumeNow(id: string): Promise<ResumePlan[]>;
  onResumePlans(cb: (plans: ResumePlan[]) => void): () => void;

  /** Super-resident mode: an endless learn-and-iterate loop on the subscription accounts. */
  residentView(): Promise<ResidentView>;
  setResidentSettings(s: ResidentSettings): Promise<ResidentView>;
  residentStart(): Promise<ResidentView>;
  residentStop(): Promise<ResidentView>;
  /** Skip the cooldown or the quota wait and start a round now. */
  residentRunNow(): Promise<ResidentView>;
  onResident(cb: (v: ResidentView) => void): () => void;

  /** Simulated peer review (论文工坊 · 模拟审稿). Runs are kept per project. */
  reviewCandidates(): Promise<ReviewerModel[]>;
  reviewStart(req: ReviewRequest): Promise<ReviewRun>;
  reviewCancel(runId: string): Promise<void>;
  reviewList(): Promise<ReviewRun[]>;
  reviewGet(runId: string): Promise<ReviewRun | null>;
  reviewDelete(runId: string): Promise<void>;
  /** The passage a merged weakness is about and the request to rewrite it, for 写作与润色. */
  reviewPolishSeed(runId: string, weakness: number): Promise<{ text: string; note: string }>;
  /** A question plus a small evidence repository made from the reviewers' positions, saved under research/. */
  reviewToResearch(runId: string, target: { kind: "weakness"; index: number } | { kind: "dispute"; id: string }): Promise<ResearchHandoff>;
  onReviewEvent(cb: (e: ReviewEvent) => void): () => void;

  /** Topic ideas and the novelty check (论文工坊 · 选题). */
  ideasStart(req: IdeaRequest): Promise<IdeaRun>;
  ideasCancel(runId: string): Promise<void>;
  ideasList(): Promise<IdeaRun[]>;
  ideasDelete(runId: string): Promise<void>;
  /** Search OpenAlex for works close to one idea (or every idea of the run) and judge the overlap. */
  ideasCheck(runId: string, ideaId?: string): Promise<IdeaRun>;
  /** Shown once before the first novelty check: it searches api.openalex.org. */
  ideasConsent(): Promise<boolean>;
  grantIdeasConsent(): Promise<void>;
  ideasSettings(): Promise<IdeaSettings>;
  ideasSetSettings(patch: { mailto?: string }): Promise<IdeaSettings>;
  /** Append ideas to research/<name>.repository.json as draft evidence records. */
  ideasToEvidence(runId: string, ideaIds: string[], name: string): Promise<EvidenceRepoFile>;
  ideasToResearch(runId: string, ideaId: string): Promise<ResearchHandoff>;
  /** Export a run's ideas as Markdown into the project (asks first; never overwrites). */
  ideasExport(runId: string): Promise<string>;
  onIdeaEvent(cb: (e: IdeaEvent) => void): () => void;

  /** A draft AI-use statement for the paper, from what this project actually used. */
  paperDisclosure(): Promise<DisclosureDraft>;

  /** Paper workshop, third batch: citations from Zotero (Better BibTeX, 127.0.0.1 only) and typesetting with Quarto. */
  zoteroStatus(): Promise<ZoteroStatus>;
  /** Opens Zotero's own citation picker and waits for the choice. Null when nothing was picked. */
  zoteroPick(style: CiteStyle): Promise<CitePick | null>;
  /** Stops waiting for the picker (Zotero's window has to be closed there). */
  zoteroCancelPick(): Promise<void>;
  zoteroSearch(terms: string): Promise<ZoteroItem[]>;
  zoteroCollections(): Promise<ZoteroCollection[]>;
  /** Reads the item's PDF attachment into the workshop; its evidence is then referred to by citekey. */
  zoteroImport(item: ZoteroItem): Promise<PaperDoc>;
  /** `[@a; @b]` or `\cite{a,b}`. */
  citeFormat(refs: CiteRef[], style: CiteStyle): Promise<string>;
  /** The .bib file and what it was last filled from. Without a path: the one used last. */
  bibState(file?: string): Promise<BibState>;
  /** Pulls entries from Zotero into the .bib file (asks before writing). Entries only the file has are kept. */
  bibSync(req: BibSyncRequest): Promise<BibSyncResult>;
  quartoStatus(): Promise<QuartoStatus>;
  /** The project's .qmd and .md files. */
  quartoDocuments(): Promise<string[]>;
  quartoRender(req: QuartoRenderRequest): Promise<QuartoRun>;
  quartoCancel(runId: string): Promise<void>;
  quartoRuns(): Promise<QuartoRun[]>;
  /** Renders the document again whenever it is saved; null stops. */
  quartoWatch(watch: QuartoWatch | null): Promise<QuartoWatch | null>;
  quartoWatching(): Promise<QuartoWatch | null>;
  /** Shows a rendered file: HTML in the built-in browser, PDF and Word with the system's program. */
  quartoOpen(file: string): Promise<void>;
  cslStyles(): Promise<CslStyle[]>;
  /** A new paper from the template (asks before adding the files). */
  quartoNewPaper(req: PaperTemplateRequest): Promise<PaperTemplateResult>;
  onQuartoEvent(cb: (e: QuartoEvent) => void): () => void;

  /** Paper workshop, fourth batch: Quarto / Zotero / Better BibTeX fetched from their official sources when the user asks. */
  toolsState(): Promise<PaperToolsState>;
  /** Asks the official source what the latest version is and how big (a small request; nothing is downloaded yet). */
  toolOffer(tool: PaperToolId): Promise<ToolOffer>;
  /** Starts downloading the version the user was shown. Progress arrives as tool events. */
  toolDownload(tool: PaperToolId, version: string): Promise<ToolTask>;
  toolCancel(tool: PaperToolId): Promise<void>;
  /** Hands the downloaded Zotero installer to the system to open. */
  toolOpen(tool: PaperToolId): Promise<void>;
  /** Shows the downloaded file (or Quarto's folder) in the system's file manager. */
  toolReveal(tool: PaperToolId): Promise<void>;
  /** Deletes one copy of Quarto that sikeoop downloaded. */
  toolRemoveQuarto(version: string): Promise<PaperToolsState>;
  onToolEvent(cb: (e: ToolEvent) => void): () => void;

  /** Hooks, memory and the code index. */
  getHooks(): Promise<HooksState>;
  /** Approve (or revoke) a project's hooks file; approval covers its current content only. */
  trustHooks(path: string, trusted: boolean): Promise<HooksState>;
  /** Create the hooks file if needed and open it (project: in the editor; user: in the system editor). */
  openHooksFile(kind: "user" | "project"): Promise<{ state: HooksState; projectPath?: string }>;
  getContextSettings(): Promise<ContextSettings>;
  setContextSettings(change: Partial<ContextSettings>): Promise<ContextSettings>;
  listMemories(): Promise<MemoryItem[]>;
  addMemory(text: string, scope: "project" | "global"): Promise<MemoryItem[]>;
  deleteMemory(id: string): Promise<MemoryItem[]>;
  /** The built-in browser (browser/service.ts). */
  browserState(): Promise<BrowserState>;
  browserAutomationState(): Promise<BrowserAutomationState>;
  browserAutomationPause(): Promise<BrowserAutomationState>;
  browserFlowList(): Promise<BrowserFlow[]>;
  /** Omitted name creates a temporary name; stop may supply the final name. */
  browserFlowStartRecording(name?: string, options?: BrowserFlowRecordingOptions): Promise<void>;
  browserFlowStopRecording(name?: string): Promise<BrowserFlow>;
  browserFlowRename(oldName: string, newName: string): Promise<void>;
  browserFlowRun(name: string, vars?: Record<string, string>, options?: BrowserFlowRunOptions): Promise<BrowserFlowRunResult>;
  browserFlowDelete(name: string): Promise<void>;
  browserAutomationResume(): Promise<BrowserAutomationState>;
  browserAutomationStop(): Promise<BrowserAutomationState>;
  onBrowserAutomation(cb: (state: BrowserAutomationState) => void): () => void;
  /** An address, or a search URL for words typed in the address bar. */
  browserToUrl(input: string): Promise<string>;
  browserHistory(query?: string): Promise<BrowserHistoryItem[]>;
  browserClearHistory(): Promise<void>;
  /** History, cookies, site storage and cache (saved logins stay). */
  browserClearData(): Promise<void>;
  browserAnswerOffer(save: boolean): Promise<void>;
  browserFillLogin(id: string): Promise<void>;
  browserRemoveLogin(id: string): Promise<BrowserLogin[]>;
  browserSetSettings(s: BrowserSettings): Promise<BrowserSettings>;
  browserDevTools(): Promise<void>;
  onBrowser(cb: (e: BrowserEvent) => void): () => void;
  /** Run memory consolidation now (it also runs by itself after 10 idle minutes). */
  consolidateMemory(): Promise<ConsolidateReport>;
  /** Memories waiting for the user's yes or no. */
  pendingMemories(): Promise<MemoryPending[]>;
  /** accept: keep it (a conflict replaces the old memory); otherwise drop it. Returns the memory list. */
  resolvePendingMemory(id: string, accept: boolean): Promise<MemoryItem[]>;
  ragStatus(): Promise<RagStatus>;
  ragRebuild(): Promise<RagStatus>;
  onRagStatus(cb: (s: RagStatus) => void): () => void;
  /** The open project's wiki (null when none was generated yet). */
  wikiGet(): Promise<WikiState | null>;
  /** Write the wiki: "all" plans and writes it from scratch, "stale" rewrites only pages whose files changed. */
  wikiGenerate(mode: "all" | "stale"): Promise<void>;
  wikiCancel(): Promise<void>;
  /** Ask about the wiki with a chosen model; the answer cites project files. */
  wikiAsk(req: WikiAskRequest): Promise<WikiAnswer>;
  wikiAskCancel(): Promise<void>;
  /** The open project's knowledge graphs, and the one being built. */
  graphState(): Promise<GraphState>;
  graphGet(id: string): Promise<KnowledgeGraph | null>;
  /** Builds the project's code graph in the background; progress arrives through onGraphState. */
  graphBuildCode(): Promise<void>;
  /** Builds a graph from a document: a project path, or an absolute path from graphPickDoc. */
  graphBuildDoc(file: string): Promise<void>;
  /** Documents in the project that can become a graph (.md .txt .pdf .docx). */
  graphProjectDocs(): Promise<string[]>;
  /** A document chosen from the computer; null when cancelled. */
  graphPickDoc(): Promise<string | null>;
  graphDelete(id: string): Promise<void>;
  graphCancel(): Promise<void>;
  arktsStatus(): Promise<ArktsStatus>;
  /** An .ets file opened in the editor; starts the language server on first use. */
  arktsOpen(file: string, text: string): Promise<void>;
  arktsChange(file: string, text: string): void;
  arktsClose(file: string): void;
  /** An LSP request about a file; positions are 0-based like LSP. */
  arktsRequest(feature: ArktsFeature, file: string, payload: unknown): Promise<unknown>;
  /** Asks for the DevEco Studio / OpenHarmony SDK folder; null when cancelled. */
  arktsPickSdk(): Promise<ArktsStatus | null>;
  /** Zip the open project and its work records into the archive folder. */
  archiveProject(note?: string): Promise<ArchiveResult>;
  archiveCancel(): Promise<void>;
  onArchiveProgress(cb: (p: ArchiveProgress) => void): () => void;
  archiveDir(): Promise<string>;
  /** Pick another archive folder; null when cancelled. */
  chooseArchiveDir(): Promise<string | null>;
  /** Show a file in Finder / Explorer. */
  showInFolder(file: string): Promise<void>;
  /** Add an empty custom provider (OpenAI- or Anthropic-compatible). */
  addCustomProvider(kind?: "openai" | "anthropic"): Promise<{ id: string; state: ProvidersState }>;
  removeCustomProvider(id: string): Promise<ProvidersState>;
  /** Every configured provider × model: who can join a group chat. */
  groupCandidates(): Promise<GroupCandidate[]>;
  groupList(): Promise<GroupSummary[]>;
  groupLoad(id: string): Promise<GroupChat>;
  groupCreate(title: string, members: Omit<GroupMember, "id">[]): Promise<GroupChat>;
  groupDelete(id: string): Promise<void>;
  /** Post a message; mentioned members reply, or everyone in turn when none is mentioned. */
  groupSend(id: string, text: string, mentions: string[]): Promise<void>;
  /** Stop a group's replies; no id = every group that is talking. */
  groupStop(id?: string): Promise<void>;
  /** A member writes up what the group settled as a plan with a division of work. */
  groupFinalize(id: string, memberId?: string): Promise<GroupPlan>;
  /** The settled plan as the message for the main conversation, which hands the tasks out as written. */
  groupHandoff(id: string): Promise<{ text: string }>;
  /** The open project's automations (empty without a project). */
  automations(): Promise<AutomationView>;
  saveAutomation(a: AutomationInput): Promise<AutomationView>;
  deleteAutomation(id: string): Promise<AutomationView>;
  setAutomationEnabled(id: string, on: boolean): Promise<AutomationView>;
  /** Start a run now, whatever the schedule says. */
  runAutomation(id: string): Promise<void>;
  /** Stop the run in progress. */
  stopAutomation(): Promise<void>;
  onAutomations(cb: (v: AutomationView) => void): () => void;
  /** The main agent asks for a new Claude Code / Codex tab (start_agent). */
  onTermOpenAgent(cb: (cli: AgentCli) => void): () => void;
  remoteState(): Promise<RemoteView>;
  remoteEnable(): Promise<RemoteView>;
  remoteDisable(): Promise<RemoteView>;
  remoteRelogin(): Promise<RemoteView>;
  remoteVerify(code: string): Promise<void>;
  onRemote(cb: (v: RemoteView) => void): () => void;
  /** The Harmony cluster console: every dispatch to a cluster role, newest first. */
  clusterView(): Promise<ClusterView>;
  /** Remove the finished dispatches from the console (running ones stay). */
  clearCluster(): Promise<ClusterView>;
  onClusterChanged(cb: (v: ClusterView) => void): () => void;
  /** The regression panel. Every action works on the open project's .sikeoop/regress. */
  regressView(): Promise<RegressView>;
  /** Ask a session to read the code and propose items; resolves when it replies. */
  regressGenerate(session: string, focus?: string): Promise<{ candidates: RegressCandidate[]; rawExcerpt: string } | { error: string; rawExcerpt?: string }>;
  regressAddItems(candidates: RegressCandidate[]): Promise<RegressView | { error: string }>;
  regressUpdateItem(id: string, patch: Partial<RegressCandidate>): Promise<RegressView | { error: string }>;
  regressDeleteItem(id: string): Promise<RegressView | { error: string }>;
  /** Queue items on a session; returns at once, progress arrives through onRegressChanged. */
  regressRun(itemIds: string[], session: string): Promise<{ runIds: string[] } | { error: string }>;
  /** Stop waiting for one run, or every queued and running one. The session itself is not interrupted. */
  regressCancel(runId?: string): Promise<void>;
  regressOverride(runId: string, verdict: RegressVerdict): Promise<RegressView | { error: string }>;
  regressSnapshot(name: string): Promise<RegressView | { error: string }>;
  regressDiff(baselineId: string): Promise<RegressDiffRow[] | { error: string }>;
  regressDeleteBaseline(id: string): Promise<RegressView | { error: string }>;
  /** The full reply of a run. */
  regressReply(runId: string): Promise<string | { error: string }>;
  regressSetSettings(patch: Partial<RegressSettings>): Promise<RegressView | { error: string }>;
  onRegressChanged(cb: (v: RegressView) => void): () => void;
  onGroupEvent(cb: (e: GroupEvent) => void): () => void;
  /** The screenshot shortcut: its key combo and whether it is registered. */
  snipShortcut(): Promise<{ accelerator: string; enabled: boolean; error?: string }>;
  setSnipShortcut(enabled: boolean): Promise<{ accelerator: string; enabled: boolean; error?: string }>;
  /** Whether a screenshot is also copied to the clipboard as an image. */
  snipCopy(): Promise<boolean>;
  setSnipCopy(on: boolean): Promise<boolean>;
  /** Which engine the AI's web search uses, and its keys (write-only). */
  webSearch(): Promise<WebSearchState>;
  setWebSearch(u: { engine?: WebSearchState["engine"]; tavilyKey?: string; braveKey?: string; clear?: "tavily" | "brave" }): Promise<WebSearchState>;
  /** The screenshot mouse gesture: four clicks (macOS) or a side button (Windows). */
  snipGesture(): Promise<SnipGestureState>;
  setSnipGesture(change: { enabled?: boolean; sideButton?: 4 | 5 }): Promise<SnipGestureState>;
  /** Text to send in the chat (from the island's "continue in chat"). */
  onChatInject(cb: (text: string) => void): () => void;
  /** Something happened that deserves a sound (the window plays it). */
  onSound(cb: (name: SoundName) => void): () => void;
  /** Dynamic Island on/off (off by default). */
  islandEnabled(): Promise<boolean>;
  setIslandEnabled(on: boolean): Promise<boolean>;
  /** Voice input on the island: where the audio is transcribed. */
  voiceSettings(): Promise<VoiceSettings>;
  dictation(): Promise<DictationView>;
  setDictation(on: boolean): Promise<DictationView>;
  /** Request the microphone / Accessibility permissions (opens System Settings where only the user can allow). */
  grantDictation(): Promise<DictationView>;
  setDictationKey(key: DictationKey): Promise<DictationView>;
  onDictationChange(cb: (v: DictationView) => void): () => void;
  setVoiceSettings(change: { baseUrl?: string; model?: string; key?: string; clearKey?: boolean }): Promise<VoiceSettings>;
  /** The token ledger: every model's use per day since sikeoop started recording. */
  usageSummary(): Promise<UsageSummary>;
  /** Unfinished tasks of recent projects, newest first. */
  resumePending(): Promise<UnfinishedTask[]>;
  /** Don't ask about this conversation again (until it changes). */
  resumeDismiss(sessionId: string, updatedAt: number): Promise<void>;
  onWikiState(cb: (s: WikiState | null) => void): () => void;
  onGraphState(cb: (s: GraphState) => void): () => void;
  onArktsStatus(cb: (s: ArktsStatus) => void): () => void;
  /** Problems the ArkTS server found in a project file (LSP diagnostics). */
  onArktsDiagnostics(cb: (file: string, diagnostics: unknown[]) => void): () => void;
}

export type CrossSessionState = "active" | "ended";
export type SessionAgentStatus = "starting" | "idle" | "busy" | "queued" | "exited";
export interface SessionAgent { id: string; cli: AgentCli; name: string; status: SessionAgentStatus; tab: string }
export interface CrossSession { id: string; title: string; roots: string[]; agents: SessionAgent[]; state: CrossSessionState; createdAt: number; endedAt?: number }
export type TimelineEventKind = "user" | "agent" | "system" | "outOfScope" | "lockDenied" | "hopLimit" | "agentJoined" | "agentExited";
export interface TimelineEvent { seq: number; at: number; kind: TimelineEventKind; from?: string; to?: string[]; text?: string; path?: string; dir?: string }
export type SessionResult<T = void> = { ok: true; data: T } | { ok: false; message: string };
export interface CrossSessionApi {
  list(): Promise<SessionResult<CrossSession[]>>;
  get(id: string, before?: number): Promise<SessionResult<{ meta: CrossSession; events: TimelineEvent[] }>>;
  create(input: { title: string; roots: string[] }): Promise<SessionResult<CrossSession>>;
  addAgent(id: string, cli: AgentCli): Promise<SessionResult<SessionAgent>>;
  removeAgent(id: string, agentId: string): Promise<SessionResult>;
  send(id: string, text: string, mentions: string[]): Promise<SessionResult>;
  addRoot(id: string, dir: string): Promise<SessionResult>;
  end(id: string): Promise<SessionResult>;
  openTerminal(id: string, agentId: string): Promise<SessionResult>;
  stop(id: string, agentId?: string): Promise<SessionResult>;
  onEvent(cb: (id: string, event: TimelineEvent) => void): () => void;
  onChanged(cb: (meta: CrossSession) => void): () => void;
}

export type AiSiteCategory = "cn-search" | "cn-assistant" | "global" | "academic" | "dev" | "custom";
export interface AiSite { id: string; name: string; category: AiSiteCategory; home: string; query?: string; note?: string; login: "none" | "optional" | "required"; cnDirect?: boolean }
export interface AiToolboxPrefs { favorites: string[]; order: string[]; hidden: string[]; custom: AiSite[]; groups: { id: string; name: string; sites: string[] }[] }
export interface SweetApi {
  toolboxSites(): Promise<AiSite[]>;
  toolboxPrefs(): Promise<AiToolboxPrefs>;
  toolboxSavePrefs(p: AiToolboxPrefs): Promise<void>;
  toolboxOpenUrl(siteId: string, q?: string): Promise<{ url: string; copied: boolean }>;
}

// ---- 图片提示词精选库 (main: image-prompts/service.ts) ----
export type ImagePromptCategory = "portrait" | "poster" | "product" | "ui" | "infographic" | "illustration" | "character" | "photo" | "brand" | "space" | "edit" | "fun" | "other";
export type ImagePromptLang = "zh" | "en" | "other";
export type ImagePromptModel = "gpt-image-2" | "gpt-image-2.5" | "other";
/** none: 来源库没有许可证；unclear: 许可声明自相矛盾；reserved: 来源明确不授权正文。 */
export type ImagePromptLicense = "MIT" | "CC-BY-4.0" | "none" | "unclear" | "reserved";
export type ImagePromptFlag = "real-person" | "ip" | "brand" | "suggestive";
export interface ImagePromptStep { label?: string; text: string }
/** 单步提示词就是 steps 长度为 1。 */
export interface ImagePromptVariant { lang: ImagePromptLang; steps: ImagePromptStep[] }
export interface ImagePromptCard {
  id: string;
  /** 展示标题：有中文用中文，否则英文。 */
  title: string;
  titleEn?: string;
  /** 正文前 140 字，纯文本。 */
  excerpt: string;
  category: ImagePromptCategory;
  tags: string[];
  langs: ImagePromptLang[];
  models: ImagePromptModel[];
  /** 如 "3:4"。 */
  ratio?: string;
  needsReference: boolean;
  multiStep: boolean;
  author?: string;
  /** ImagePromptSource.id */
  source: string;
  license: ImagePromptLicense;
  /** 来源库转载或聚合的他人内容。 */
  thirdParty: boolean;
  flags: ImagePromptFlag[];
  featured: boolean;
  hasThumb: boolean;
  thumbW?: number;
  thumbH?: number;
  favorite: boolean;
}
export interface ImagePromptDetail extends ImagePromptCard {
  variants: ImagePromptVariant[];
  /** 来源给出的精确模型名，如 "gpt-image-2.5-flare"。 */
  modelExact?: string;
  /** 像素尺寸，如 "1024x1536"。 */
  size?: string;
  /** 原帖链接，只会是 http/https。 */
  sourceUrl?: string;
  /** 许可要求的署名文字。 */
  attribution?: string;
  /** 去重时并入的其他来源 id。 */
  alsoIn: string[];
  /** 正文里有方括号占位内容，可以替换。 */
  hasVars: boolean;
}
export interface ImagePromptSource { id: string; name: string; repoUrl: string; license: ImagePromptLicense; licenseNote?: string; attribution?: string; count: number }
export interface ImagePromptQuery {
  /** 搜标题、标签、作者、正文；最长 200 字。 */
  q?: string;
  category?: ImagePromptCategory;
  model?: ImagePromptModel;
  lang?: ImagePromptLang;
  favoritesOnly?: boolean;
  withImage?: boolean;
  /** 默认 0。 */
  offset?: number;
  /** 默认 48，最大 96。 */
  limit?: number;
}
export interface ImagePromptPage { items: ImagePromptCard[]; total: number; offset: number; nextOffset: number | null; dataset: string }
export interface ImagePromptFacet<T extends string> { id: T; label: string; count: number }
export interface ImagePromptMeta {
  /** missing: 没有数据文件；invalid: 文件损坏、校验不过，或打包版遇到未筛选的数据集。 */
  state: "ready" | "missing" | "invalid";
  reason?: string;
  dataset: string;
  profile: "dev" | "release";
  generatedAt: number;
  total: number;
  favorites: number;
  categories: ImagePromptFacet<ImagePromptCategory>[];
  models: ImagePromptFacet<ImagePromptModel>[];
  langs: ImagePromptFacet<ImagePromptLang>[];
  sources: ImagePromptSource[];
}
export interface ImagePromptCopyRequest { id: string; lang?: ImagePromptLang; /** 从 0 起；省略则复制全部步骤。 */ step?: number }
export interface SweetApi {
  imagePromptMeta(): Promise<ImagePromptMeta>;
  imagePromptQuery(query: ImagePromptQuery): Promise<ImagePromptPage>;
  imagePromptGet(id: string): Promise<ImagePromptDetail | null>;
  /** 一次最多 24 个 id；返回 id → data:image/jpeg;base64,…，没有图的 id 不出现。 */
  imagePromptThumbs(ids: string[]): Promise<Record<string, string>>;
  imagePromptSetFavorite(id: string, on: boolean): Promise<{ id: string; favorite: boolean; count: number }>;
  imagePromptCopy(request: ImagePromptCopyRequest): Promise<{ chars: number }>;
}

// ---- 外挂工坊 (game-cheat-workshop) ----
// 面向游戏逆向 / 自建 lab / CTF / 学术复现的学习模板集合。
// 主进程把 workshop 目录当只读资源：开发时读 workspace 下 `game-cheat-workshop/`，打包后读 `process.resourcesPath/cheatshop/`。
export interface CheatshopFile {
  /** 相对 workshop 根的 POSIX 路径，形如 "20-unity-il2cpp/hook_template.cpp"。 */
  path: string;
  /** basename，形如 "hook_template.cpp"。 */
  name: string;
  /** 扩展名小写，带点，形如 ".cpp" / ".md" / ".js"；没有扩展名时为空串。 */
  ext: string;
  /** 字节数。 */
  size: number;
}
export interface CheatshopSection {
  /** 相对 workshop 根的目录名，形如 "20-unity-il2cpp"。 */
  dir: string;
  /** 从目录名提取出的编号前缀，形如 "20"；没有编号则为空串。 */
  order: string;
  /** 展示标题：优先取该目录 README 的第一个 h1，缺省回落到目录名。 */
  title: string;
  /** 该目录（第一层）里的文件；不递归。 */
  files: CheatshopFile[];
}
export interface CheatshopTree {
  /** 开发模式下的 workshop 根绝对路径；打包后为 process.resourcesPath 子目录。给调试用，不要在界面上长期展示。 */
  rootPath: string;
  /** 根目录下的 README.md 相对路径，若不存在则为 null。 */
  readme: string | null;
  /** 根目录下的 INDEX.md 相对路径，若不存在则为 null。 */
  index: string | null;
  sections: CheatshopSection[];
}
export type CheatshopResult<T> = { ok: true; data: T } | { ok: false; message: string };
export interface SweetApi {
  /** 一次性拉取外挂工坊的目录结构。前端缓存首次结果即可。 */
  cheatshopTree(): Promise<CheatshopResult<CheatshopTree>>;
  /** 读取 workshop 根下的某个文件（文本）；拒绝越界路径。 */
  cheatshopRead(path: string): Promise<CheatshopResult<{ text: string; ext: string; size: number }>>;
}
