import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserPane } from "./components/BrowserPane";
import { HelpCenter } from "./components/HelpCenter";
import { Tour } from "./components/Tour";
import { Splash } from "./splash/Splash";
import type { AgentEvent, ContextUsage, FileNode, LoadedSession, ProvidersState, UnfinishedTask } from "@shared/types";
import { ChatPanel } from "./components/ChatPanel";
import { EditorPane, type OpenFile } from "./components/EditorPane";
import { FileTree } from "./components/FileTree";
import { ProviderDialog, isReady } from "./components/ProviderDialog";
import { TerminalPanel } from "./components/TerminalPanel";
import { HomeScreen } from "./home/HomeScreen";
import { PluginCenter } from "./components/PluginCenter";
import { Sidebar } from "./components/Sidebar";
import { ResearchScreen } from "./components/research/ResearchScreen";
import { PapersScreen } from "./components/papers/PapersScreen";
import { PvScreen } from "./components/pv/PvScreen";
import { ToolboxScreen } from "./components/toolbox/ToolboxScreen";
import { AndroidPanel } from "./components/AndroidPanel";
import { disposeModel, monaco, setInlineCompletion, syncModel } from "./monaco";
import { deepseekCost } from "./pricing";
import { fileLanguageLabel } from "./languages";
import { Icon } from "./components/Icon";
import { Avatar } from "./components/Avatar";
import { StartPage } from "./components/StartPage";
import { ContextCenter } from "./components/ContextCenter";
import { Studio } from "./studio/Studio";
import { WikiScreen } from "./components/WikiScreen";
import { GraphScreen } from "./graph/GraphScreen";
import { ArchiveDialog, ResumeDialog } from "./components/ArchiveDialogs";
import { GroupScreen } from "./components/GroupScreen";
import { UsageScreen } from "./components/UsageScreen";
import { AutomationScreen } from "./components/AutomationScreen";
import { RemoteScreen } from "./components/RemoteScreen";
import { ClusterConsole } from "./components/ClusterConsole";
import { DispatchConsole } from "./components/DispatchConsole";
import { RegressConsole } from "./components/RegressConsole";
import { MobileScreen } from "./components/MobileScreen";
import { ExtensionsScreen } from "./components/ExtensionsScreen";
import { UpdateBanner } from "./components/UpdateBanner";
import { CommandPalette, MOD, type PaletteCommand } from "./components/CommandPalette";
import { TOUR_EVENT } from "./components/Tour";
import { SKINS, setSkin } from "./skin";
import { SHOW_UNFINISHED } from "./unfinished";
import { playSound } from "./sounds";
import { DEFAULT_LAYOUT, type Layout, Splitter, loadLayout, saveLayout } from "./components/Splitter";
import { ResourceLibrary } from "./components/ResourceLibrary";
import { ContextMeter } from "./components/ContextMeter";
import { OPEN_FILE, type OpenFileDetail } from "./components/Markdown";
import { characterFor } from "./home/characters";

type Usage = Extract<AgentEvent, { type: "usage" }>;
type Totals = { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number | null };
const NO_TOTALS: Totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: null };
/** The cache checks of this conversation (agent/loop.ts checkCache): breaks are misses that shouldn't have happened. */
type CacheHealth = { checks: number; hits: number; breaks: number; lastCause?: string };
const NO_HEALTH: CacheHealth = { checks: 0, hits: 0, breaks: 0 };

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Scroll the editor showing `path` to `line` once it has mounted the file. */
function revealLine(path: string, line: number, tries = 20) {
  const editor = monaco.editor.getEditors().find((ed) => ed.getModel()?.uri.toString() === monaco.Uri.parse(path).toString());
  if (!editor) {
    if (tries > 0) setTimeout(() => revealLine(path, line, tries - 1), 50);
    return;
  }
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.focus();
}

export function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [selection, setSelection] = useState("");
  /** 论文工坊 →「用它开始深度研判」: the evidence repository to prefill (at: so the same file can be sent again). */
  const [researchRepo, setResearchRepo] = useState<{ path: string; question?: string; at: number } | null>(null);
  const [providers, setProviders] = useState<ProvidersState | null>(null);
  /** The archive dialog: offered when the AI's plan is all done, or opened by hand. */
  const [archiving, setArchiving] = useState<{ finished: boolean } | null>(null);
  /** Offered once per conversation, so a re-sent finished plan doesn't ask again. */
  const archiveOffered = useRef(false);
  const [resumeTasks, setResumeTasks] = useState<UnfinishedTask[]>([]);
  const [showProviders, setShowProviders] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showAndroid, setShowAndroid] = useState(false);
  const [showContext, setShowContext] = useState(false);
  /** Which provider the settings dialog opens on (default: the active one). */
  const [dialogFor, setDialogFor] = useState<string>();
  /** Start page, the 3D all-partners screen, or the editor workbench. */
  const [showHelp, setShowHelp] = useState(false);
  // The built-in browser: open as an editor tab, in front of the code or beside it.
  const [browserOn, setBrowserOn] = useState(false);
  const [browserFront, setBrowserFront] = useState(false);
  const [browserSplit, setBrowserSplit] = useState(false);
  const [browserReq, setBrowserReq] = useState<{ url: string; n: number } | null>(null);
  const browserOnRef = useRef(false);
  browserOnRef.current = browserOn;
  const [screen, setScreen] = useState<"start" | "partners" | "work" | "studio" | "resources" | "wiki" | "graph" | "group" | "usage" | "automation" | "remote" | "cluster" | "dispatch" | "regress" | "mobile" | "extensions" | "research" | "papers" | "pv" | "toolbox">("start");
  /** The group chat mounts on its first visit. */
  const [groupOpened, setGroupOpened] = useState(false);
  /** The wiki mounts on its first visit, like the studio. */
  const [wikiOpened, setWikiOpened] = useState(false);
  const [graphOpened, setGraphOpened] = useState(false);
  /** The studio mounts on its first visit, then keeps its canvas while hidden. */
  const [studioOpened, setStudioOpened] = useState(false);
  /** Bumped when a prototype file is saved from the editor, so the studio re-renders it. */
  const [protoSaved, setProtoSaved] = useState(0);
  const [filesOpen, setFilesOpen] = useState(true);
  /** Pane widths and whether the chat is shown, remembered across launches. */
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const updateLayout = (change: Partial<Layout>, save = true) =>
    setLayout((l) => {
      const next = { ...l, ...change };
      if (save) saveLayout(next);
      return next;
    });
  /** One pane filling the whole work area, or null for the normal layout. */
  const [maxPane, setMaxPane] = useState<"editor" | "chat" | "terminal" | null>(null);
  const toggleMax = (pane: "editor" | "chat" | "terminal") => setMaxPane((p) => (p === pane ? null : pane));
  /** A partner was chosen but needed setup first: carry on once it is ready. */
  const enterAfterSetup = useRef(false);
  /** Bumped whenever the main process starts a new conversation, so the chat view clears too. */
  /** The chat panel remounts for each conversation (new epoch); loaded = a saved one being shown. */
  const [chat, setChat] = useState<{ epoch: number; loaded?: LoadedSession }>({ epoch: 0 });
  /** Token use of the current conversation since it was opened, for the cache hit rate. */
  const [totals, setTotals] = useState<Totals>(NO_TOTALS);
  const [cacheHealth, setCacheHealth] = useState<CacheHealth>(NO_HEALTH);
  /** How full the conversation's working window is (from the latest request). */
  const [ctx, setCtx] = useState<ContextUsage | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [toast, setToast] = useState<ReactNode>("");
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** A message to send to the AI on the user's behalf ("帮我看看"). */
  const [injected, setInjected] = useState<{ text: string; nonce: number }>();
  /** Errors Monaco found in the file being edited. */
  const [problems, setProblems] = useState<string[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;

  const flash = useCallback((msg: ReactNode) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }, []);

  // Sound effects the main process asks for (played here, also while the window is hidden).
  useEffect(() => window.sweet.onSound((name) => playSound(name)), []);
  // The agent asks for the browser; a dev server printed its address in the terminal.
  useEffect(
    () =>
      window.sweet.onBrowser((e) => {
        if (e.type === "open") {
          setBrowserOn(true);
          setBrowserFront(true);
          setScreen("work");
        } else if (e.type === "suggest" && !browserOnRef.current) {
          // Beside the code, so the editor stays in view.
          setBrowserOn(true);
          setBrowserSplit(true);
          setBrowserReq({ url: e.url, n: Date.now() });
        }
      }),
    [],
  );

  useEffect(() => {
    void window.sweet.getProviders().then(setProviders);
    // Tasks left unfinished last time: ask once per launch whether to pick one up.
    void window.sweet.resumePending().then((t) => t.length && setResumeTasks(t), () => {});
  }, []);

  // Files the AI wrote (or an undo restored) show up in the editor and file tree right away.
  useEffect(
    () =>
      window.sweet.onAgentEvent((e) => {
        if (e.type === "workspace_changed") return void reloadFromDisk();
        if (e.type === "status") return setAgentBusy(e.state !== "idle");
        if (e.type === "plan") {
          const finished = e.items.length > 0 && e.items.every((i) => i.status === "done" || i.status === "skipped");
          if (finished && !archiveOffered.current) {
            archiveOffered.current = true;
            setArchiving({ finished: true });
          }
          return;
        }
        if (e.type === "cache_check") {
          if (e.verdict === "first" || e.verdict === "unknown") return;
          return setCacheHealth((h) => ({
            checks: h.checks + 1,
            hits: h.hits + (e.verdict === "hit" ? 1 : 0),
            breaks: h.breaks + (e.verdict === "partial" || e.verdict === "miss" ? 1 : 0),
            lastCause: e.cause ?? h.lastCause,
          }));
        }
        if (e.type === "context_usage") {
          const { type: _t, ...u } = e;
          return setCtx(u);
        }
        // After a compaction the next request measures again; meanwhile show the estimate.
        if (e.type === "context_trimmed" && e.how === "compacted") return void window.sweet.contextUsage().then(setCtx);
        if (e.type !== "file_changed") return;
        if (e.created || e.content === null) void window.sweet.refreshTree().then(setTree);
        if (e.content === null) {
          disposeModel(e.path);
          setFiles((fs) => fs.filter((f) => f.path !== e.path));
          setActivePath((p) => (p === e.path ? undefined : p));
          return;
        }
        const content = e.content;
        setFiles((fs) => {
          const open = fs.find((f) => f.path === e.path);
          if (!open) return fs;
          if (open.content !== open.savedContent) flash(`AI 改了 ${e.path}，你没保存的改动可以按 ⌘Z 找回`);
          return fs.map((f) => (f.path === e.path ? { ...f, content, savedContent: content } : f));
        });
        syncModel(e.path, content);
      }),
    [flash],
  );

  function openSettings(id?: string) {
    setDialogFor(id);
    setShowProviders(true);
  }

  /** After picking a partner: into the project, or back to the start page to pick one. */
  function enterWork() {
    setScreen(root ? "work" : "start");
  }

  async function choosePartner(id: string) {
    let state = providers;
    // Re-picking the current partner keeps the conversation; a new one starts fresh.
    if (state && id !== state.activeId) {
      state = await window.sweet.setActiveProvider(id);
      setProviders(state);
      showChat();
    }
    const p = state?.providers.find((x) => x.id === id);
    if (p && isReady(p)) return void enterWork();
    enterAfterSetup.current = true;
    openSettings(id);
  }

  async function openFolder(kind: "open" | "new" = "open"): Promise<boolean> {
    // Before the main process switches projects, while these tabs can still be saved.
    if (!(await settleUnsaved())) return false;
    const res = await window.sweet.openFolder(kind);
    if (!res) return false;
    await enterProject(res);
    return true;
  }

  async function startWeb(title: string, prompt: string) {
    if (!(await settleUnsaved())) return;
    try {
      await enterProject(await window.sweet.createWebStarter(title));
      setScreen("work");
      askAI(prompt);
    } catch (e) {
      flash(cleanError(e));
    }
  }

  async function openRecent(path: string) {
    if (!(await settleUnsaved())) return;
    try {
      await enterProject(await window.sweet.openRecent(path));
    } catch (e) {
      flash(cleanError(e));
    }
  }

  async function enterProject(res: { root: string; tree: FileNode[] }) {
    setRoot(res.root);
    setTree(res.tree);
    setFiles([]);
    setActivePath(undefined);
    // Pick up the last conversation with the current partner; other partners' chats stay in 历史.
    const [sessions, state] = await Promise.all([window.sweet.listSessions(), window.sweet.getProviders()]);
    const latest = sessions.find((x) => x.providerId === state.activeId);
    if (latest) await openSession(latest.id);
    else showChat();
    setScreen("work");
  }

  function showChat(loaded?: LoadedSession) {
    archiveOffered.current = false;
    setChat((c) => ({ epoch: c.epoch + 1, loaded }));
    setTotals(NO_TOTALS);
    setCacheHealth(NO_HEALTH);
    // A reopened conversation shows its estimated size right away.
    void window.sweet.contextUsage().then(setCtx, () => setCtx(null));
  }

  async function openSession(id: string) {
    try {
      showChat(await window.sweet.loadSession(id));
    } catch (e) {
      flash(cleanError(e));
    }
  }

  /** Open the task's project and conversation, and ask the AI to carry on where it stopped. */
  async function continueTask(t: UnfinishedTask) {
    setResumeTasks([]);
    if (!(await settleUnsaved())) return;
    try {
      await enterProject(await window.sweet.openRecent(t.root));
      const loaded = await window.sweet.loadSession(t.sessionId);
      showChat(loaded);
      if (!loaded.locked) {
        askAI(`我们继续上次没做完的任务。计划里还剩这些：\n${t.remaining.map((r) => `- ${r}`).join("\n")}\n先简单确认一下当前进度，然后接着做。`);
      }
    } catch (e) {
      flash(cleanError(e));
    }
  }

  async function newChat() {
    await window.sweet.resetChat();
    showChat();
  }

  async function unlock(locked: NonNullable<LoadedSession["locked"]>) {
    if (locked.reason === "not_ready") return openSettings(locked.providerId);
    setProviders(await window.sweet.setActiveProvider(locked.providerId));
    if (chat.loaded) await openSession(chat.loaded.id);
  }

  // Priced per request at the moment it happens, so peak and off-peak hours add up correctly.
  const activeModel = providers?.providers.find((p) => p.id === providers.activeId)?.model ?? "";
  const modelRef = useRef(activeModel);
  modelRef.current = activeModel;
  const addUsage = useCallback((u: Usage) => {
    const cost = deepseekCost(modelRef.current, u);
    setTotals((t) => ({
      input: t.input + u.input,
      cacheRead: t.cacheRead + u.cacheRead,
      cacheWrite: t.cacheWrite + u.cacheWrite,
      output: t.output + u.output,
      cost: cost === null ? t.cost : (t.cost ?? 0) + cost,
    }));
  }, []);

  // Editor autocomplete follows the setting.
  useEffect(() => setInlineCompletion(Boolean(providers?.completion.enabled && providers.completion.ready)), [providers]);

  async function openFile(path: string) {
    if (!files.some((f) => f.path === path)) {
      try {
        const content = await window.sweet.readFile(path);
        setFiles((fs) => [...fs, { path, content, savedContent: content }]);
      } catch (e) {
        return flash(cleanError(e));
      }
    }
    setActivePath(path);
    setSelection("");
  }

  /** After a command ran: refresh the tree and any open file that changed on disk. */
  async function reloadFromDisk() {
    setTree(await window.sweet.refreshTree());
    for (const f of filesRef.current) {
      if (f.content !== f.savedContent) continue;
      let content: string;
      try {
        content = await window.sweet.readFile(f.path);
      } catch {
        continue;
      }
      if (content === f.savedContent) continue;
      setFiles((fs) => fs.map((x) => (x.path === f.path ? { ...x, content, savedContent: content } : x)));
      syncModel(f.path, content);
    }
  }

  // Track Monaco's errors for the open file, for the "帮我看看" button in the status bar.
  useEffect(() => {
    const collect = () => {
      if (!activePath) return setProblems([]);
      const markers = monaco.editor.getModelMarkers({ resource: monaco.Uri.parse(activePath) });
      setProblems(
        markers
          .filter((m) => m.severity === monaco.MarkerSeverity.Error)
          .map((m) => `${activePath}:${m.startLineNumber}: ${m.message}`),
      );
    };
    collect();
    const sub = monaco.editor.onDidChangeMarkers(collect);
    return () => sub.dispose();
  }, [activePath]);

  // File links in chat answers ([App.tsx:42](src/App.tsx:42)) open the file in the editor.
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { path, line } = (e as CustomEvent<OpenFileDetail>).detail;
      setScreen("work");
      void openFileRef.current(path).then(() => line && revealLine(path, line));
    };
    window.addEventListener(OPEN_FILE, onOpen);
    return () => window.removeEventListener(OPEN_FILE, onOpen);
  }, []);

  // ⌘P / Ctrl+P: quick open; ⌘⇧P / Ctrl+Shift+P: commands. Capture phase, so the editor doesn't take them.
  const [palette, setPalette] = useState<"files" | "commands" | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = navigator.platform.toLowerCase().includes("mac") ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey || e.key.toLowerCase() !== "p") return;
      e.preventDefault();
      e.stopPropagation();
      setPalette(e.shiftKey ? "commands" : "files");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Recently opened files of this project, newest first, for quick open.
  const recentKey = root ? `sweet.recentFiles:${root}` : "";
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  useEffect(() => {
    try {
      setRecentFiles(recentKey ? JSON.parse(localStorage.getItem(recentKey) ?? "[]") : []);
    } catch {
      setRecentFiles([]);
    }
  }, [recentKey]);
  useEffect(() => {
    if (!activePath || !recentKey) return;
    setRecentFiles((r) => {
      const next = [activePath, ...r.filter((p) => p !== activePath)].slice(0, 30);
      try {
        localStorage.setItem(recentKey, JSON.stringify(next));
      } catch {
        // Storage full or blocked: recent files just aren't remembered.
      }
      return next;
    });
  }, [activePath, recentKey]);

  /** Everything the command palette offers; pinyin in keys so 「sj」finds 手机. Built only while it's open. */
  function paletteCommands(): PaletteCommand[] {
    const go = (screenName: typeof screen) => () => setScreen(screenName);
    const cmds: PaletteCommand[] = [
      { id: "file.save", group: "文件", title: "保存当前文件", keys: "baocun bc save", shortcut: `${MOD}S`, run: () => activePath && void saveFile(activePath) },
      { id: "file.saveAll", group: "文件", title: "全部保存", keys: "quanbubaocun qbbc save all", run: () => void saveAllDirty() },
      { id: "file.close", group: "文件", title: "关闭当前文件", keys: "guanbi gb close", run: () => activePath && void closeFile(activePath) },
      { id: "file.open", group: "文件", title: "打开文件夹…", keys: "dakaiwenjianjia dkwjj open folder xiangmu", run: () => void openFolder("open") },
      { id: "file.new", group: "文件", title: "新建项目…", keys: "xinjianxiangmu xjxm new project", run: () => void openFolder("new") },
      { id: "file.refresh", group: "文件", title: "刷新文件树", keys: "shuaxin sx refresh tree", run: () => void window.sweet.refreshTree().then(setTree) },
      { id: "view.terminal", group: "切换", title: terminalOpen ? "关闭终端" : "打开终端", keys: "zhongduan zd terminal", shortcut: "⌃`", run: () => setTerminalOpen((v) => !v) },
      { id: "go.start", group: "打开", title: "首页", keys: "shouye sy home start", run: go("start") },
      { id: "go.work", group: "打开", title: "文件和编辑器", keys: "wenjian wj bianjiqi bjq editor files work", run: go("work") },
      { id: "go.studio", group: "打开", title: "原型工坊", keys: "yuanxinggongfang yxgf prototype studio", run: go("studio") },
      { id: "go.wiki", group: "打开", title: "项目百科", keys: "xiangmubaike xmbk wiki", run: go("wiki") },
      { id: "go.graph", group: "打开", title: "知识图谱", keys: "zhishitupu zstp graph", run: go("graph") },
      { id: "go.group", group: "打开", title: "Agent 群聊", keys: "qunliao ql group chat", run: () => (setGroupOpened(true), setScreen("group")) },
      { id: "go.automation", group: "打开", title: "自动化", keys: "zidonghua zdh automation schedule dingshi", run: go("automation") },
      { id: "go.extensions", group: "打开", title: "扩展（主题、语法高亮）", keys: "kuozhan kz zhuti zt extensions themes openvsx", run: go("extensions") },
      { id: "go.mobile", group: "打开", title: "手机", keys: "shouji sj phone mobile anzhuo", run: go("mobile") },
      { id: "go.remote", group: "打开", title: "微信远程控制", keys: "weixin wx yuancheng yc wechat remote", run: go("remote") },
      { id: "go.cluster", group: "打开", title: "鸿蒙集群控制台", keys: "hongmeng hm jiqun jq harmony cluster", run: go("cluster") },
      { id: "go.toolbox", group: "打开", title: "百宝箱：同时问几家 AI 搜索", keys: "baibaoxiang bbx sousuo ss ai search toolbox duibi", run: go("toolbox") },
      { id: "go.dispatch", group: "打开", title: "调度台", keys: "diaodutai ddt renwu rw dispatch jobs", run: go("dispatch") },
      { id: "go.usage", group: "打开", title: "用量统计", keys: "yongliang yl tongji tj usage token", run: go("usage") },
      { id: "go.partners", group: "打开", title: "全部伙伴", keys: "huoban hb partners", run: go("partners") },
      { id: "go.resources", group: "打开", title: "资源库", keys: "ziyuanku zyk jineng jn resources skills", run: go("resources") },
      { id: "panel.plugins", group: "打开", title: "插件：技能和 MCP", keys: "chajian cj plugins mcp jineng", run: () => setShowPlugins(true) },
      { id: "panel.android", group: "打开", title: "Android 模拟器", keys: "anzhuo az moniqi mnq android emulator", run: () => setShowAndroid(true) },
      { id: "panel.context", group: "打开", title: "记忆与代码索引", keys: "jiyi jy suoyin sy memory index", run: () => setShowContext(true) },
      { id: "panel.settings", group: "打开", title: "设置：模型与 Key", keys: "shezhi sz moxing mx settings model key", run: () => openSettings() },
      ...SKINS.map((k) => ({ id: `skin.${k.id}`, group: "皮肤", title: `换成 ${k.label}`, keys: `pifu pf waiguan wg skin theme ${k.id}`, run: () => setSkin(k.id) })),
      { id: "help.manual", group: "帮助", title: "新手手册", keys: "bangzhu bz shouce sc help manual", run: () => setShowHelp(true) },
      { id: "help.tour", group: "帮助", title: "重看新手教程", keys: "jiaocheng jc yindao yd tour", run: () => (setScreen("start"), setTimeout(() => window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: "start" })), 300)) },
      { id: "help.update", group: "帮助", title: "检查更新", keys: "gengxin gx update", run: () => void window.sweet.updateCheck() },
      { id: "help.uninstall", group: "帮助", title: "卸载 sikeoop", keys: "xiezai xz shanchu sc uninstall remove", run: () => void window.sweet.uninstallApp().then((why) => why && window.alert(why)) },
    ];
    // Deep research ships once it has had a real run (docs/方案-深度科研.md: testing is the user's).
    if (SHOW_UNFINISHED) cmds.push({ id: "go.pv", group: "打开", title: "PV 工坊", keys: "pvgongfang pv xuanchuanpian xcp shipin sp video promo", run: go("pv") });
    if (SHOW_UNFINISHED) cmds.push({ id: "go.papers", group: "打开", title: "论文工坊", keys: "lunwengongfang lwgf lunwen lw fanyi fy runse rs arxiv paper", run: go("papers") });
    if (SHOW_UNFINISHED) cmds.push({ id: "go.research", group: "打开", title: "深度科研", keys: "shendukeyan sdky keyan ky yanjiu yj research debate", run: go("research") });
    if (SHOW_UNFINISHED) cmds.push({ id: "go.regress", group: "打开", title: "测试与回归", keys: "ceshi cs huigui hg test regress", run: go("regress") });
    return cmds;
  }

  const allFiles = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.kind === "file") out.push(n.path);
        else if (n.children) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  // ⌃` opens and closes the terminal, like VS Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setTerminalOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const askAI = useCallback((text: string) => setInjected({ text, nonce: Date.now() }), []);

  // "Continue in the chat" from the island's screenshot answer.
  const rootRef = useRef(root);
  rootRef.current = root;
  useEffect(
    () =>
      window.sweet.onChatInject((text) => {
        if (!rootRef.current) return flash("先打开一个项目，再把截图或语音的问题带到对话里");
        setScreen("work");
        askAI(text);
      }),
    [askAI, flash],
  );
  const showTerminal = useCallback(() => setTerminalOpen(true), []);
  const hideTerminal = useCallback(() => setTerminalOpen(false), []);

  /**
   * Before tabs go away (closing one, switching project): offer to save unsaved changes.
   * false = the user chose to stay, or saving failed.
   */
  async function settleUnsaved(paths?: string[]): Promise<boolean> {
    const inScope = (f: OpenFile) => !paths || paths.includes(f.path);
    const dirty = filesRef.current.filter((f) => inScope(f) && f.content !== f.savedContent);
    if (!dirty.length) return true;
    const names = dirty.map((f) => f.path.split("/").pop()).join("、");
    if (window.confirm(`${names} 还没保存。\n点「确定」保存后继续，点「取消」再选是否放弃修改。`)) {
      try {
        const written = new Map(dirty.map((f) => [f.path, f.content]));
        for (const [p, content] of written) await window.sweet.writeFile(p, content);
        setFiles((fs) => fs.map((f) => (written.has(f.path) ? { ...f, savedContent: written.get(f.path)! } : f)));
        // Anything in scope changed during the save (more typing, another tab edited): stay.
        if (filesRef.current.some((f) => inScope(f) && f.content !== (written.get(f.path) ?? f.savedContent))) {
          flash("保存的时候又有新修改，先留在这里");
          return false;
        }
        return true;
      } catch (e) {
        flash(cleanError(e));
        return false;
      }
    }
    return window.confirm(`不保存，直接放弃 ${names} 的修改？\n点「取消」留在这里。`);
  }

  async function closeFile(path: string) {
    if (!(await settleUnsaved([path]))) return;
    disposeModel(path);
    setFiles((fs) => {
      const next = fs.filter((f) => f.path !== path);
      if (path === activePath) setActivePath(next[next.length - 1]?.path);
      return next;
    });
  }

  async function saveFile(path: string) {
    const f = files.find((x) => x.path === path);
    if (!f) return;
    // What reaches the disk is this snapshot; typing during the write stays unsaved.
    const written = f.content;
    try {
      await window.sweet.writeFile(path, written);
      setFiles((fs) => fs.map((x) => (x.path === path ? { ...x, savedContent: written } : x)));
      if (path.startsWith("prototypes/")) setProtoSaved((n) => n + 1);
      flash(<>保存好啦 <Icon name="check" /></>);
    } catch (e) {
      flash(cleanError(e));
    }
  }

  async function saveAllDirty() {
    const dirty = files.filter((f) => f.content !== f.savedContent);
    for (const f of dirty) await window.sweet.writeFile(f.path, f.content);
    if (dirty.length) {
      const saved = new Map(dirty.map((f) => [f.path, f.content]));
      setFiles((fs) => fs.map((f) => (saved.has(f.path) ? { ...f, savedContent: saved.get(f.path)! } : f)));
      flash(`发送前帮你保存了 ${dirty.length} 个文件`);
    }
  }

  const projectName = root?.split(/[\\/]/).pop();
  const active = providers?.providers.find((p) => p.id === providers.activeId);
  const ready = active ? isReady(active) : false;

  const character = active ? characterFor(active.id) : undefined;

  return (
    <div className="shell">
      <Splash />
      <Tour screen={screen} hasProject={!!root} />
      <UpdateBanner />
      {palette && (
        <CommandPalette
          mode={palette}
          files={allFiles}
          recent={recentFiles}
          commands={paletteCommands()}
          hasFile={!!activePath}
          onOpenFile={(p) => {
            setScreen("work");
            void openFile(p);
          }}
          onGotoLine={(line) => {
            if (!activePath) return;
            setScreen("work");
            revealLine(activePath, line);
          }}
          onClose={() => setPalette(null)}
        />
      )}
      {showHelp && <HelpCenter onClose={() => setShowHelp(false)} />}
      <header className="titlebar">
        <span className="brand">
          <Icon name="heart" /> sikeoop
        </span>
        {projectName && screen === "work" && (
          <>
            <span className="sep">/</span>
            <span className="project" title={root ?? undefined}>
              {projectName}
            </span>
          </>
        )}
        <span className="spacer" />
        {active && (
          <button type="button" className="partner-pill" onClick={() => openSettings()} title="换模型、填 Key">
            <Avatar providerId={active.id} />
            <span>{character?.name ?? active.name}</span>
            {ready ? <span className="model">{active.model}</span> : <span className="warn-text">还没设置好</span>}
          </button>
        )}
      </header>

      <div className="body">
        <Sidebar
          entries={{
            home: { on: screen === "start", run: () => setScreen("start") },
            files: { on: screen === "work" && filesOpen, disabled: !root, run: () => (screen === "work" ? setFilesOpen((v) => !v) : setScreen("work")) },
            studio: {
              on: screen === "studio",
              disabled: !root,
              run: () => {
                setStudioOpened(true);
                setScreen("studio");
              },
            },
            wiki: {
              on: screen === "wiki",
              disabled: !root,
              run: () => {
                setWikiOpened(true);
                setScreen("wiki");
              },
            },
            graph: {
              on: screen === "graph",
              disabled: !root,
              run: () => {
                setGraphOpened(true);
                setScreen("graph");
              },
            },
            archive: { on: !!archiving, disabled: !root, run: () => setArchiving({ finished: false }) },
            group: {
              on: screen === "group",
              run: () => {
                setGroupOpened(true);
                setScreen("group");
              },
            },
            automation: { on: screen === "automation", run: () => setScreen("automation") },
            extensions: { on: screen === "extensions", run: () => setScreen("extensions") },
            mobile: { on: screen === "mobile", run: () => setScreen("mobile") },
            remote: { on: screen === "remote", run: () => setScreen("remote") },
            cluster: { on: screen === "cluster", run: () => setScreen("cluster") },
            dispatch: { on: screen === "dispatch", run: () => setScreen("dispatch") },
            research: { on: screen === "research", hidden: !SHOW_UNFINISHED, run: () => setScreen("research") },
            papers: { on: screen === "papers", hidden: !SHOW_UNFINISHED, run: () => setScreen("papers") },
            pv: { on: screen === "pv", hidden: !SHOW_UNFINISHED, run: () => setScreen("pv") },
            toolbox: { on: screen === "toolbox", run: () => setScreen("toolbox") },
            regress: { on: screen === "regress", hidden: !SHOW_UNFINISHED, run: () => setScreen("regress") },
            usage: { on: screen === "usage", run: () => setScreen("usage") },
            partners: { on: screen === "partners", run: () => setScreen("partners") },
            resources: { on: screen === "resources", run: () => setScreen("resources") },
            plugins: { on: showPlugins, run: () => setShowPlugins(true) },
            android: { on: showAndroid, run: () => setShowAndroid(true) },
            context: { on: showContext, run: () => setShowContext(true) },
            help: { on: showHelp, run: () => setShowHelp(true) },
            settings: { on: showProviders, run: () => openSettings() },
          }}
        />

        {screen === "partners" && providers && (
          <HomeScreen
            providers={providers.providers}
            activeId={providers.activeId}
            interactive={!showProviders && !showPlugins}
            onChoose={(id) => void choosePartner(id)}
            onSettings={(id) => openSettings(id)}
          />
        )}
        {screen === "resources" && (
          <ResourceLibrary
            canAskAI={!!root && ready}
            onAskAI={(text) => {
              setScreen("work");
              askAI(text);
            }}
          />
        )}
        {screen === "start" && providers && (
          <StartPage
            providers={providers.providers}
            activeId={providers.activeId}
            onOpenFolder={(kind) => void openFolder(kind)}
            onOpenRecent={(p) => void openRecent(p)}
            onChoosePartner={(id) => void choosePartner(id)}
            onAllPartners={() => setScreen("partners")}
            onAskAI={(text) => {
              setScreen("work");
              askAI(text);
            }}
            onStartWeb={startWeb}
          />
        )}
        {root && studioOpened && (
          <Studio
            key={`studio:${root}`}
            hidden={screen !== "studio"}
            externalChange={protoSaved}
            onOpenFile={(p) => {
              setScreen("work");
              void window.sweet.refreshTree().then(setTree);
              void openFile(p);
            }}
          />
        )}
        <UsageScreen hidden={screen !== "usage"} />
        <RemoteScreen hidden={screen !== "remote"} />
        <MobileScreen hidden={screen !== "mobile"} />
        <ExtensionsScreen hidden={screen !== "extensions"} />
        <ClusterConsole hidden={screen !== "cluster"} />
        <DispatchConsole hidden={screen !== "dispatch"} />
        <ResearchScreen
          hidden={screen !== "research"}
          onSettings={(id) => openSettings(id)}
          onOpenDispatch={() => setScreen("dispatch")}
          initialRepository={researchRepo ?? undefined}
        />
        <ToolboxScreen hidden={screen !== "toolbox"} />
        {SHOW_UNFINISHED && <PvScreen hidden={screen !== "pv"} root={root} />}
        {SHOW_UNFINISHED && (
          <PapersScreen
            hidden={screen !== "papers"}
            editorSelection={selection}
            // 论文工坊第三批：引用插到编辑器当前文件的光标处；新建的论文、要排版的文稿在编辑器里打开。
            editorFile={activePath}
            onOpenFile={(p) => {
              setScreen("work");
              void window.sweet.refreshTree().then(setTree);
              void openFile(p);
            }}
            onStartResearch={(path, question) => {
              setResearchRepo({ path, question, at: Date.now() });
              setScreen("research");
            }}
          />
        )}
        <RegressConsole hidden={screen !== "regress"} />
        <AutomationScreen
          hidden={screen !== "automation"}
          hasProject={!!root}
          onOpenSession={(id) => {
            setScreen("work");
            void openSession(id);
          }}
        />
        {groupOpened && (
          <GroupScreen
            key={`group:${root ?? "none"}`}
            hidden={screen !== "group"}
            onSettings={() => openSettings()}
            onHandOff={(text) => {
              if (!root) return flash("先打开一个项目，Agent 才能动手");
              setScreen("work");
              askAI(text);
            }}
          />
        )}
        {root && wikiOpened && <WikiScreen key={`wiki:${root}`} hidden={screen !== "wiki"} canWrite={ready} providers={providers?.providers ?? []} activeId={providers?.activeId ?? ""} />}
        {root && graphOpened && (
          <GraphScreen
            key={`graph:${root}`}
            hidden={screen !== "graph"}
            canWrite={ready}
            onAsk={(text) => {
              setScreen("work");
              askAI(text);
            }}
            onHandOff={(text) => {
              setScreen("work");
              askAI(text);
            }}
          />
        )}
        {/* Stays mounted while another screen is shown, so the chat, terminal and open files survive. */}
        {root && (
          <main
            className={"workbench" + (maxPane ? ` max-${maxPane}` : "") + (layout.chatOpen ? "" : " chat-hidden")}
            hidden={screen !== "work"}
            style={{ "--files-w": `${layout.filesWidth}px`, "--chat-w": `${layout.chatWidth}px` } as React.CSSProperties}
          >
            <nav className="sidebar" aria-label="文件" hidden={!filesOpen}>
              <div className="section-head">
                资源管理器
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn square"
                  title="刷新"
                  aria-label="刷新"
                  onClick={() => void window.sweet.refreshTree().then(setTree)}
                >
                  <Icon name="refresh" />
                </button>
              </div>
              <FileTree nodes={tree} activePath={activePath} onOpen={(p) => void openFile(p)} />
            </nav>
            {filesOpen && (
              <Splitter
                side="left"
                label="拖动调整文件栏宽度"
                width={layout.filesWidth}
                min={160}
                max={() => Math.min(600, window.innerWidth * 0.4)}
                defaultWidth={DEFAULT_LAYOUT.filesWidth}
                onChange={(w) => updateLayout({ filesWidth: w }, false)}
                onCommit={(w) => updateLayout({ filesWidth: w })}
              />
            )}

            <div className="center">
              <EditorPane
                launch={{ openFolder: () => void openFolder("open"), newChat: () => void newChat(), terminal: () => setTerminalOpen(true) }}
                files={files}
                activePath={activePath}
                projectName={projectName ?? ""}
                onActivate={(p) => {
                  setActivePath(p);
                  setBrowserFront(false);
                }}
                browser={
                  browserOn
                    ? {
                        front: browserFront,
                        split: browserSplit,
                        onFront: () => setBrowserFront(true),
                        onClose: () => {
                          setBrowserOn(false);
                          setBrowserFront(false);
                          setBrowserSplit(false);
                        },
                        node: (
                          <BrowserPane
                            request={browserReq}
                            split={browserSplit}
                            onToggleSplit={() => setBrowserSplit((v) => !v)}
                            onClose={() => {
                              setBrowserOn(false);
                              setBrowserFront(false);
                              setBrowserSplit(false);
                            }}
                          />
                        ),
                      }
                    : undefined
                }
                onOpenBrowser={() => {
                  setBrowserOn(true);
                  setBrowserFront(true);
                }}
                onClose={closeFile}
                onChange={(p, c) => {
                  const edit = (fs: OpenFile[]) => fs.map((f) => (f.path === p ? { ...f, content: c } : f));
                  // Right away, not at the next render: settleUnsaved reads it across an await.
                  filesRef.current = edit(filesRef.current);
                  setFiles(edit);
                }}
                onSave={(p) => void saveFile(p)}
                onSelection={setSelection}
                maximized={maxPane === "editor"}
                onMaximize={() => toggleMax("editor")}
                onShowChat={layout.chatOpen ? undefined : () => updateLayout({ chatOpen: true })}
              />
              <TerminalPanel
                key={root}
                cwd={root}
                visible={terminalOpen || maxPane === "terminal"}
                maximized={maxPane === "terminal"}
                onMaximize={() => toggleMax("terminal")}
                onShow={showTerminal}
                onHide={hideTerminal}
                onAskAI={(out) =>
                  askAI(`终端里出现了下面这些输出，帮我看看是什么意思、有没有出错、我该怎么办：\n\n\`\`\`\n${out}\n\`\`\``)
                }
              />
            </div>

            {layout.chatOpen && (
              <Splitter
                side="right"
                label="拖动调整对话栏宽度"
                width={layout.chatWidth}
                min={300}
                max={() => window.innerWidth * 0.6}
                defaultWidth={DEFAULT_LAYOUT.chatWidth}
                onChange={(w) => updateLayout({ chatWidth: w }, false)}
                onCommit={(w) => updateLayout({ chatWidth: w })}
              />
            )}
            <ChatPanel
              key={chat.epoch}
              maximized={maxPane === "chat"}
              onMaximize={() => toggleMax("chat")}
              onHide={() => {
                setMaxPane((p) => (p === "chat" ? null : p));
                updateLayout({ chatOpen: false });
              }}
              loaded={chat.loaded}
              onLoadSession={(id) => void openSession(id)}
              onNewChat={() => void newChat()}
              onUnlock={(l) => void unlock(l)}
              ready={ready}
              supportsEffort={active?.supportsEffort ?? false}
              partnerId={active?.id}
              editor={{ activeFile: activePath, selection }}
              onNeedSetup={() => openSettings()}
              beforeSend={saveAllDirty}
              injected={injected}
              onUsage={addUsage}
            />
          </main>
        )}
      </div>

      <footer className="statusbar">
        <button type="button" onClick={() => openSettings()} title="切换 AI 服务商和模型">
          {active ? (
            ready ? (
              <>
                {active.name} · {active.model}
              </>
            ) : (
              <span className="warn-text">
                <Icon name="warning" /> {active.name} 还没设置好，点这里
              </span>
            )
          ) : (
            "…"
          )}
        </button>
        {root && screen === "work" && (
          <button
            type="button"
            onClick={() => {
              setMaxPane((p) => (p === "chat" ? null : p));
              updateLayout({ chatOpen: !layout.chatOpen });
            }}
            title="显示或收起右边的对话栏"
          >
            <Icon name="panel-right" /> {layout.chatOpen ? "收起对话" : "对话"}
          </button>
        )}
        {maxPane && screen === "work" && (
          <button type="button" onClick={() => setMaxPane(null)} title="退出全屏，恢复原来的布局">
            <Icon name="minimize" /> 恢复布局
          </button>
        )}
        {root && screen === "work" && (
          <button type="button" onClick={() => setTerminalOpen((v) => !v)} title="打开或收起终端（⌃`）">
            <Icon name="terminal" /> {terminalOpen ? "收起终端" : "终端"}
          </button>
        )}
        {problems.length > 0 && screen === "work" && (
          <button
            type="button"
            className="problems"
            title={problems.join("\n")}
            onClick={() =>
              askAI(`编辑器在当前文件里标出了这些错误，帮我看看是什么意思、怎么改：\n\n${problems.slice(0, 30).join("\n")}`)
            }
          >
            <Icon name="bug" /> {problems.length} 个报错 · 让 AI 看看
          </button>
        )}
        <span className="spacer" />
        {toast && <span className="toast">{toast}</span>}
        {screen === "work" && activePath && <span className="lang">{fileLanguageLabel(activePath)}</span>}
        {ctx && screen === "work" && <ContextMeter usage={ctx} busy={agentBusy} onCompacted={(u) => u && setCtx(u)} />}
        {totals.input + totals.cacheRead + totals.cacheWrite > 0 && <CacheMeter t={totals} health={cacheHealth} />}
      </footer>

      {showAndroid && <AndroidPanel onClose={() => setShowAndroid(false)} />}

      {showPlugins && (
        <PluginCenter
          onClose={() => setShowPlugins(false)}
          onOpenFile={(p) => {
            setScreen("work");
            void window.sweet.refreshTree().then(setTree);
            void openFile(p);
          }}
        />
      )}
      {archiving && root && (
        <ArchiveDialog project={root.split(/[\\/]/).filter(Boolean).pop() ?? ""} finished={archiving.finished} onClose={() => setArchiving(null)} />
      )}
      {resumeTasks.length > 0 && <ResumeDialog tasks={resumeTasks} onContinue={(t) => void continueTask(t)} onClose={() => setResumeTasks([])} />}
      {showContext && providers && (
        <ContextCenter providers={providers.providers} hasProject={!!root} onClose={() => setShowContext(false)} />
      )}
      {showProviders && providers && (
        <ProviderDialog
          state={providers}
          initialId={dialogFor}
          onClose={() => {
            setShowProviders(false);
            enterAfterSetup.current = false;
          }}
          onChange={(s, switched) => {
            setProviders(s);
            if (!switched) return;
            // Chosen on the home screen and now set up: go on into the project.
            const active = s.providers.find((x) => x.id === s.activeId);
            if (enterAfterSetup.current && active && isReady(active)) {
              enterAfterSetup.current = false;
              void enterWork();
            }
            // Settings fixed for a read-only conversation: reopen it so it can continue.
            // Otherwise the conversation carries on with the new model (it says so in the chat).
            if (chat.loaded?.locked) void openSession(chat.loaded.id);
          }}
        />
      )}
    </div>
  );
}

/** This conversation's share of prompt tokens read from cache, which are billed at a fraction of the price. */
function CacheMeter({ t, health }: { t: Totals; health: CacheHealth }) {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const rate = Math.round((t.cacheRead / prompt) * 100);
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : n.toLocaleString());
  return (
    <span
      className={"cache-meter" + (health.breaks ? " broken" : rate >= 60 ? " good" : "")}
      title={
        `这段对话目前：输入 ${t.input.toLocaleString()}，缓存读取 ${t.cacheRead.toLocaleString()}，` +
        `缓存写入 ${t.cacheWrite.toLocaleString()}，输出 ${t.output.toLocaleString()} tokens。\n` +
        "缓存命中的部分按很低的价格计费，命中率越高越省钱。" +
        (health.checks
          ? `\n缓存检查：${health.checks} 次请求里 ${health.hits} 次接上了缓存` +
            (health.breaks ? `，${health.breaks} 次不该断却断了。最近一次的原因：${health.lastCause ?? "不明"}` : "，没有不该断的。")
          : "")
      }
    >
      缓存命中 {rate}% · 输入 {k(prompt)} · 输出 {k(t.output)}
      {t.cost !== null && ` · 本次对话 ¥${t.cost < 0.01 ? t.cost.toFixed(4) : t.cost.toFixed(2)}`}
      {health.breaks > 0 && ` · 缓存断了 ${health.breaks} 次`}
    </span>
  );
}
