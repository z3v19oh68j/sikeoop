import { contextBridge, ipcRenderer } from "electron";
import type { AgentCli, AgentEvent, BrowserEvent, AgentSessionView, AutomationView, RemoteView, MobileGatewayState, UpdateState, ClusterView, RegressView, DictationView, ArchiveProgress, GroupEvent, SoundName, McpServerView, SweetApi, RagStatus, SkillInfo, WikiState, GraphState, ArktsStatus, PublishEvent, DispatchView, DispatchEvent, CrossSession, TimelineEvent, ResearchEvent, PaperEvent, ReviewEvent, IdeaEvent, QuartoEvent, ToolEvent, ResumePlan, ResidentView } from "@shared/types";

// The renderer's only door to the system. Each method maps to one ipcMain handler.
const api: SweetApi = {
  toolboxSites: () => ipcRenderer.invoke("toolbox:sites"),
  toolboxPrefs: () => ipcRenderer.invoke("toolbox:prefs"),
  toolboxSavePrefs: (p) => ipcRenderer.invoke("toolbox:savePrefs", p),
  toolboxOpenUrl: (id, q) => ipcRenderer.invoke("toolbox:openUrl", id, q),
  imagePromptMeta: () => ipcRenderer.invoke("imgprompt:meta"),
  imagePromptQuery: (query) => ipcRenderer.invoke("imgprompt:query", query),
  imagePromptGet: (id) => ipcRenderer.invoke("imgprompt:get", id),
  imagePromptThumbs: (ids) => ipcRenderer.invoke("imgprompt:thumbs", ids),
  imagePromptSetFavorite: (id, on) => ipcRenderer.invoke("imgprompt:favorite", id, on),
  imagePromptCopy: (request) => ipcRenderer.invoke("imgprompt:copy", request),
  cheatshopTree: () => ipcRenderer.invoke("cheatshop:tree"),
  cheatshopRead: (path) => ipcRenderer.invoke("cheatshop:read", path),
  pvList: (root) => ipcRenderer.invoke("pv:list", root),
  pvAssets: (root, id) => ipcRenderer.invoke("pv:assets", root, id),
  pvImportAssets: (root, id) => ipcRenderer.invoke("pv:importAssets", root, id),
  pvRemoveAsset: (root, id, file) => ipcRenderer.invoke("pv:removeAsset", root, id, file),
  pvAssetUrl: (root, id, file) => ipcRenderer.invoke("pv:assetUrl", root, id, file),
  pvSetMusic: (root, id, file) => ipcRenderer.invoke("pv:setMusic", root, id, file),
  pvBeats: (root, id) => ipcRenderer.invoke("pv:beats", root, id),
  pvSetBeatGrid: (root, id, grid) => ipcRenderer.invoke("pv:setBeatGrid", root, id, grid),
  pvSnapStoryboard: (root, id, unit) => ipcRenderer.invoke("pv:snapStoryboard", root, id, unit),
  pvCreate: (root, input) => ipcRenderer.invoke("pv:create", root, input),
  pvGet: (root, id) => ipcRenderer.invoke("pv:get", root, id),
  pvRunStep: (root, id, step, note) => ipcRenderer.invoke("pv:runStep", root, id, step, note),
  pvCancel: (root, id) => ipcRenderer.invoke("pv:cancel", root, id),
  pvReadFile: (root, id, file) => ipcRenderer.invoke("pv:readFile", root, id, file),
  pvWriteFile: (root, id, file, text) => ipcRenderer.invoke("pv:writeFile", root, id, file, text),
  pvStoryboard: (root, id) => ipcRenderer.invoke("pv:storyboard", root, id),
  pvSaveStoryboard: (root, id, sb) => ipcRenderer.invoke("pv:saveStoryboard", root, id, sb),
  pvPacks: () => ipcRenderer.invoke("pv:packs"),
  pvFfmpeg: () => ipcRenderer.invoke("pv:ffmpeg"),
  pvFfmpegDownload: () => ipcRenderer.invoke("pv:ffmpegDownload"),
  pvPreviewUrl: (root, id, file) => ipcRenderer.invoke("pv:previewUrl", root, id, file),
  pvRenderPreview: (root, id) => ipcRenderer.invoke("pv:renderPreview", root, id),
  onPvProgress: (cb) => {
    const listener = (_e: unknown, event: Parameters<Parameters<SweetApi["onPvProgress"]>[0]>[0]) => cb(event);
    ipcRenderer.on("pv:progress", listener);
    return () => ipcRenderer.removeListener("pv:progress", listener);
  },
  // Cross-project sessions (main: session/service.ts). Every call answers { ok, data | message }.
  session: {
    list: () => ipcRenderer.invoke("session:list"),
    get: (id, before) => ipcRenderer.invoke("session:get", id, before),
    create: (input) => ipcRenderer.invoke("session:create", input),
    addAgent: (id, cli) => ipcRenderer.invoke("session:addAgent", id, cli),
    removeAgent: (id, agentId) => ipcRenderer.invoke("session:removeAgent", id, agentId),
    send: (id, text, mentions) => ipcRenderer.invoke("session:send", id, text, mentions),
    addRoot: (id, dir) => ipcRenderer.invoke("session:addRoot", id, dir),
    end: (id) => ipcRenderer.invoke("session:end", id),
    openTerminal: (id, agentId) => ipcRenderer.invoke("session:openTerminal", id, agentId),
    stop: (id, agentId) => ipcRenderer.invoke("session:stop", id, agentId),
    onEvent: (cb) => {
      const listener = (_e: unknown, id: string, event: TimelineEvent) => cb(id, event);
      ipcRenderer.on("session:event", listener);
      return () => ipcRenderer.removeListener("session:event", listener);
    },
    onChanged: (cb) => {
      const listener = (_e: unknown, meta: CrossSession) => cb(meta);
      ipcRenderer.on("session:changed", listener);
      return () => ipcRenderer.removeListener("session:changed", listener);
    },
  },
  openFolder: (kind) => ipcRenderer.invoke("workspace:open", kind),
  openRecent: (p) => ipcRenderer.invoke("workspace:openRecent", p),
  createWebStarter: (title) => ipcRenderer.invoke("templates:createWebStarter", title),
  listRecent: () => ipcRenderer.invoke("workspace:recent"),
  removeRecent: (p) => ipcRenderer.invoke("workspace:removeRecent", p),
  refreshTree: () => ipcRenderer.invoke("workspace:tree"),
  readFile: (p) => ipcRenderer.invoke("workspace:read", p),
  writeFile: (p, c) => ipcRenderer.invoke("workspace:write", p, c),
  getProviders: () => ipcRenderer.invoke("providers:get"),
  updateProvider: (u) => ipcRenderer.invoke("providers:update", u),
  clearProviderKey: (id) => ipcRenderer.invoke("providers:clearKey", id),
  setActiveProvider: (id) => ipcRenderer.invoke("providers:setActive", id),
  listModels: (id) => ipcRenderer.invoke("providers:models", id),
  setBuiltinFreeProviderEnabled: (id, enabled) => ipcRenderer.invoke("providers:setBuiltinFreeEnabled", id, enabled),
  providerDiscoverModels: (id) => ipcRenderer.invoke("providers:discoverModels", id),
  claudeOAuthGenerate: (scope) => ipcRenderer.invoke("providers:claudeOAuthGenerate", scope),
  claudeOAuthExchange: (input) => ipcRenderer.invoke("providers:claudeOAuthExchange", input),
  claudeOAuthLogout: () => ipcRenderer.invoke("providers:claudeOAuthLogout"),
  openaiOAuthGenerate: () => ipcRenderer.invoke("providers:openaiOAuthGenerate"),
  openaiOAuthExchange: (input) => ipcRenderer.invoke("providers:openaiOAuthExchange", input),
  openaiOAuthLogout: () => ipcRenderer.invoke("providers:openaiOAuthLogout"),
  claudeUsage: () => ipcRenderer.invoke("providers:claudeUsage"),
  claudeAccounts: () => ipcRenderer.invoke("providers:claudeAccounts"),
  claudeAccountSwitch: (id) => ipcRenderer.invoke("providers:claudeAccountSwitch", id),
  claudeAccountRemove: (id) => ipcRenderer.invoke("providers:claudeAccountRemove", id),
  claudeResetCredits: () => ipcRenderer.invoke("providers:claudeResetCredits"),
  openaiUsage: () => ipcRenderer.invoke("providers:openaiUsage"),
  openaiAccounts: () => ipcRenderer.invoke("providers:openaiAccounts"),
  openaiAccountSwitch: (id) => ipcRenderer.invoke("providers:openaiAccountSwitch", id),
  openaiAccountRemove: (id) => ipcRenderer.invoke("providers:openaiAccountRemove", id),
  setVision: (v) => ipcRenderer.invoke("providers:setVision", v),
  setReviewer: (r) => ipcRenderer.invoke("providers:setReviewer", r),
  setRouting: (r) => ipcRenderer.invoke("providers:setRouting", r),
  setDecision: (u) => ipcRenderer.invoke("decision:set", u),
  clearDecisionKey: () => ipcRenderer.invoke("decision:clearKey"),
  testDecision: () => ipcRenderer.invoke("decision:test"),
  setCompletion: (on) => ipcRenderer.invoke("providers:setCompletion", on),
  getBalance: (id) => ipcRenderer.invoke("providers:balance", id),
  fimComplete: (req) => ipcRenderer.invoke("fim:complete", req),
  sendChat: (req) => ipcRenderer.invoke("chat:send", req),
  cancelChat: () => ipcRenderer.invoke("chat:cancel"),
  respondApproval: (r) => ipcRenderer.invoke("chat:approval", r),
  answerQuestion: (r) => ipcRenderer.invoke("chat:answer", r),
  diffSource: (id) => ipcRenderer.invoke("chat:diffSource", id),
  undoTurn: (id) => ipcRenderer.invoke("chat:undo", id),
  resetChat: () => ipcRenderer.invoke("chat:reset"),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  loadSession: (id) => ipcRenderer.invoke("sessions:load", id),
  deleteSession: (id) => ipcRenderer.invoke("sessions:delete", id),
  onAgentEvent: (cb) => {
    const listener = (_e: unknown, ev: AgentEvent) => cb(ev);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  listSkills: () => ipcRenderer.invoke("skills:list"),
  previewSkills: (source) => ipcRenderer.invoke("skills:preview", source),
  pickLocalSkills: (kind) => ipcRenderer.invoke("skills:pickLocal", kind),
  installSkills: (previewId, ids, acceptRisk) => ipcRenderer.invoke("skills:install", previewId, ids, acceptRisk),
  aiReviewSkills: (previewId) => ipcRenderer.invoke("skills:aiReview", previewId),
  searchSkillHub: (query) => ipcRenderer.invoke("skillhub:search", query),
  removeSkill: (name) => ipcRenderer.invoke("skills:remove", name),
  setSkillEnabled: (name, enabled) => ipcRenderer.invoke("skills:setEnabled", name, enabled),
  restoreBuiltinSkills: () => ipcRenderer.invoke("skills:restoreBuiltin"),
  listMcp: () => ipcRenderer.invoke("mcp:list"),
  androidState: () => ipcRenderer.invoke("android:state"),
  androidStartAvd: (name) => ipcRenderer.invoke("android:startAvd", name),
  androidStop: (serial) => ipcRenderer.invoke("android:stop", serial),
  androidInstall: (serial, apkPath) => ipcRenderer.invoke("android:install", serial, apkPath),
  androidScreenshot: (serial) => ipcRenderer.invoke("android:screenshot", serial),
  androidPickApk: () => ipcRenderer.invoke("android:pickApk"),
  parseMcpConfig: (text) => ipcRenderer.invoke("mcp:parse", text),
  addMcpServers: (servers) => ipcRenderer.invoke("mcp:add", servers),
  removeMcpServer: (name) => ipcRenderer.invoke("mcp:remove", name),
  setMcpEnabled: (name, on) => ipcRenderer.invoke("mcp:setEnabled", name, on),
  setMcpTrusted: (name, on) => ipcRenderer.invoke("mcp:setTrusted", name, on),
  reconnectMcp: (name) => ipcRenderer.invoke("mcp:reconnect", name),
  listMods: () => ipcRenderer.invoke("mods:list"),
  pickMod: (kind) => ipcRenderer.invoke("mods:pick", kind),
  installMod: (previewId, dev) => ipcRenderer.invoke("mods:install", previewId, dev),
  removeMod: (id) => ipcRenderer.invoke("mods:remove", id),
  setModEnabled: (id, on) => ipcRenderer.invoke("mods:setEnabled", id, on),
  reloadMod: (id) => ipcRenderer.invoke("mods:reload", id),
  resourceStars: () => ipcRenderer.invoke("resources:stars"),
  onSkillsChanged: (cb) => {
    const listener = (_e: unknown, list: SkillInfo[]) => cb(list);
    ipcRenderer.on("skills:changed", listener);
    return () => ipcRenderer.removeListener("skills:changed", listener);
  },
  contextUsage: () => ipcRenderer.invoke("chat:contextUsage"),
  compactNow: () => ipcRenderer.invoke("chat:compact"),
  protoList: () => ipcRenderer.invoke("proto:list"),
  protoLoad: (name) => ipcRenderer.invoke("proto:load", name),
  protoCreate: (name) => ipcRenderer.invoke("proto:create", name),
  protoAddScreen: (name, screen) => ipcRenderer.invoke("proto:addScreen", name, screen),
  protoSaveCanvas: (name, canvas) => ipcRenderer.invoke("proto:saveCanvas", name, canvas),
  protoScreenUrl: (name, file, version) =>
    `sweetproto://p/${encodeURIComponent(name)}/${file.split("/").map(encodeURIComponent).join("/")}?v=${version}`,
  publishScan: (req) => ipcRenderer.invoke("publish:scan", req),
  publishStart: (req) => ipcRenderer.invoke("publish:start", req),
  publishCancel: () => ipcRenderer.invoke("publish:cancel"),
  publishList: () => ipcRenderer.invoke("publish:list"),
  publishUnpublish: (siteId) => ipcRenderer.invoke("publish:unpublish", siteId),
  paperList: () => ipcRenderer.invoke("paper:list"),
  paperPickPdf: () => ipcRenderer.invoke("paper:pickPdf"),
  paperImport: (source) => ipcRenderer.invoke("paper:import", source),
  paperGet: (id) => ipcRenderer.invoke("paper:get", id),
  paperDelete: (id) => ipcRenderer.invoke("paper:delete", id),
  paperSummarize: (id) => ipcRenderer.invoke("paper:summarize", id),
  paperTranslate: (id, lang) => ipcRenderer.invoke("paper:translate", id, lang),
  paperExtract: (ids) => ipcRenderer.invoke("paper:extract", ids),
  paperCancel: (taskId) => ipcRenderer.invoke("paper:cancel", taskId),
  paperTasks: () => ipcRenderer.invoke("paper:tasks"),
  evidenceSave: (name, records) => ipcRenderer.invoke("evidence:save", name, records),
  evidenceList: () => ipcRenderer.invoke("evidence:list"),
  evidenceLoad: (path) => ipcRenderer.invoke("evidence:load", path),
  paperExport: (id) => ipcRenderer.invoke("paper:export", id),
  writingRun: (req) => ipcRenderer.invoke("writing:run", req),
  arxivLookup: (idOrUrl) => ipcRenderer.invoke("arxiv:lookup", idOrUrl),
  arxivSearch: (query, start) => ipcRenderer.invoke("arxiv:search", query, start),
  arxivConsent: () => ipcRenderer.invoke("arxiv:consent"),
  grantArxivConsent: () => ipcRenderer.invoke("arxiv:grantConsent"),
  promptPresets: () => ipcRenderer.invoke("prompts:list"),
  savePromptPreset: (p) => ipcRenderer.invoke("prompts:save", p),
  deletePromptPreset: (id) => ipcRenderer.invoke("prompts:delete", id),
  promptPackState: () => ipcRenderer.invoke("prompts:packState"),
  promptPackImport: () => ipcRenderer.invoke("prompts:packImport"),
  promptPackRemove: () => ipcRenderer.invoke("prompts:packRemove"),
  reviewCandidates: () => ipcRenderer.invoke("review:candidates"),
  reviewStart: (req) => ipcRenderer.invoke("review:start", req),
  reviewCancel: (runId) => ipcRenderer.invoke("review:cancel", runId),
  reviewList: () => ipcRenderer.invoke("review:list"),
  reviewGet: (runId) => ipcRenderer.invoke("review:get", runId),
  reviewDelete: (runId) => ipcRenderer.invoke("review:delete", runId),
  reviewPolishSeed: (runId, weakness) => ipcRenderer.invoke("review:polishSeed", runId, weakness),
  reviewToResearch: (runId, target) => ipcRenderer.invoke("review:toResearch", runId, target),
  onReviewEvent: (cb) => {
    const listener = (_e: unknown, event: ReviewEvent) => cb(event);
    ipcRenderer.on("review:event", listener);
    return () => ipcRenderer.removeListener("review:event", listener);
  },
  ideasStart: (req) => ipcRenderer.invoke("ideas:start", req),
  ideasCancel: (runId) => ipcRenderer.invoke("ideas:cancel", runId),
  ideasList: () => ipcRenderer.invoke("ideas:list"),
  ideasDelete: (runId) => ipcRenderer.invoke("ideas:delete", runId),
  ideasCheck: (runId, ideaId) => ipcRenderer.invoke("ideas:check", runId, ideaId),
  ideasConsent: () => ipcRenderer.invoke("ideas:consent"),
  grantIdeasConsent: () => ipcRenderer.invoke("ideas:grantConsent"),
  ideasSettings: () => ipcRenderer.invoke("ideas:settings"),
  ideasSetSettings: (patch) => ipcRenderer.invoke("ideas:setSettings", patch),
  ideasToEvidence: (runId, ideaIds, name) => ipcRenderer.invoke("ideas:toEvidence", runId, ideaIds, name),
  ideasToResearch: (runId, ideaId) => ipcRenderer.invoke("ideas:toResearch", runId, ideaId),
  ideasExport: (runId) => ipcRenderer.invoke("ideas:export", runId),
  onIdeaEvent: (cb) => {
    const listener = (_e: unknown, event: IdeaEvent) => cb(event);
    ipcRenderer.on("ideas:event", listener);
    return () => ipcRenderer.removeListener("ideas:event", listener);
  },
  paperDisclosure: () => ipcRenderer.invoke("paper:disclosure"),
  zoteroStatus: () => ipcRenderer.invoke("zotero:status"),
  zoteroPick: (style) => ipcRenderer.invoke("zotero:pick", style),
  zoteroCancelPick: () => ipcRenderer.invoke("zotero:cancelPick"),
  zoteroSearch: (terms) => ipcRenderer.invoke("zotero:search", terms),
  zoteroCollections: () => ipcRenderer.invoke("zotero:collections"),
  zoteroImport: (item) => ipcRenderer.invoke("zotero:import", item),
  citeFormat: (refs, style) => ipcRenderer.invoke("cite:format", refs, style),
  bibState: (file) => ipcRenderer.invoke("bib:state", file),
  bibSync: (req) => ipcRenderer.invoke("bib:sync", req),
  quartoStatus: () => ipcRenderer.invoke("quarto:status"),
  quartoDocuments: () => ipcRenderer.invoke("quarto:documents"),
  quartoRender: (req) => ipcRenderer.invoke("quarto:render", req),
  quartoCancel: (runId) => ipcRenderer.invoke("quarto:cancel", runId),
  quartoRuns: () => ipcRenderer.invoke("quarto:runs"),
  quartoWatch: (watch) => ipcRenderer.invoke("quarto:watch", watch),
  quartoWatching: () => ipcRenderer.invoke("quarto:watching"),
  quartoOpen: (file) => ipcRenderer.invoke("quarto:open", file),
  cslStyles: () => ipcRenderer.invoke("quarto:cslStyles"),
  quartoNewPaper: (req) => ipcRenderer.invoke("quarto:newPaper", req),
  onQuartoEvent: (cb) => {
    const listener = (_e: unknown, event: QuartoEvent) => cb(event);
    ipcRenderer.on("quarto:event", listener);
    return () => ipcRenderer.removeListener("quarto:event", listener);
  },
  toolsState: () => ipcRenderer.invoke("tools:state"),
  toolOffer: (tool) => ipcRenderer.invoke("tools:offer", tool),
  toolDownload: (tool, version) => ipcRenderer.invoke("tools:download", tool, version),
  toolCancel: (tool) => ipcRenderer.invoke("tools:cancel", tool),
  toolOpen: (tool) => ipcRenderer.invoke("tools:open", tool),
  toolReveal: (tool) => ipcRenderer.invoke("tools:reveal", tool),
  toolRemoveQuarto: (version) => ipcRenderer.invoke("tools:removeQuarto", version),
  onToolEvent: (cb) => {
    const listener = (_e: unknown, event: ToolEvent) => cb(event);
    ipcRenderer.on("tools:event", listener);
    return () => ipcRenderer.removeListener("tools:event", listener);
  },
  onPaperEvent: (cb) => {
    const listener = (_e: unknown, ev: PaperEvent) => cb(ev);
    ipcRenderer.on("paper:event", listener);
    return () => ipcRenderer.removeListener("paper:event", listener);
  },
  quotaSettings: () => ipcRenderer.invoke("quota:settings"),
  setQuotaSettings: (q) => ipcRenderer.invoke("quota:setSettings", q),
  resumePlans: () => ipcRenderer.invoke("quota:plans"),
  cancelResumePlan: (id) => ipcRenderer.invoke("quota:cancel", id),
  resumeNow: (id) => ipcRenderer.invoke("quota:resumeNow", id),
  onResumePlans: (cb) => {
    const listener = (_e: unknown, plans: ResumePlan[]) => cb(plans);
    ipcRenderer.on("quota:plans", listener);
    return () => ipcRenderer.removeListener("quota:plans", listener);
  },
  residentView: () => ipcRenderer.invoke("resident:view"),
  setResidentSettings: (r) => ipcRenderer.invoke("resident:setSettings", r),
  residentStart: () => ipcRenderer.invoke("resident:start"),
  residentStop: () => ipcRenderer.invoke("resident:stop"),
  residentRunNow: () => ipcRenderer.invoke("resident:runNow"),
  onResident: (cb) => {
    const listener = (_e: unknown, v: ResidentView) => cb(v);
    ipcRenderer.on("resident:changed", listener);
    return () => ipcRenderer.removeListener("resident:changed", listener);
  },
  researchEnv: () => ipcRenderer.invoke("research:env"),
  researchInstall: () => ipcRenderer.invoke("research:install"),
  researchPresets: () => ipcRenderer.invoke("research:presets"),
  researchCandidates: () => ipcRenderer.invoke("research:candidates"),
  researchPickRepository: () => ipcRenderer.invoke("research:pickRepository"),
  researchStart: (req) => ipcRenderer.invoke("research:start", req),
  researchCancel: (runId) => ipcRenderer.invoke("research:cancel", runId),
  researchList: () => ipcRenderer.invoke("research:list"),
  researchResult: (runId) => ipcRenderer.invoke("research:result", runId),
  researchDelete: (runId) => ipcRenderer.invoke("research:delete", runId),
  onResearchEvent: (cb) => {
    const listener = (_e: unknown, ev: ResearchEvent) => cb(ev);
    ipcRenderer.on("research:event", listener);
    return () => ipcRenderer.removeListener("research:event", listener);
  },
  dispatchAgentSubmit: (input) => ipcRenderer.invoke("dispatch:agent:submit", input),
  dispatchAgentPermission: (id, optionId) => ipcRenderer.invoke("dispatch:agent:permission", id, optionId),
  onDispatchEvent: (cb) => {
    const listener = (_e: unknown, event: DispatchEvent) => cb(event);
    ipcRenderer.on("dispatch:event", listener);
    return () => ipcRenderer.removeListener("dispatch:event", listener);
  },
  dispatchView: () => ipcRenderer.invoke("dispatch:view"),
  dispatchCancel: (jobId) => ipcRenderer.invoke("dispatch:cancel", jobId),
  onDispatchChanged: (cb) => {
    const listener = (_e: unknown, v: DispatchView) => cb(v);
    ipcRenderer.on("dispatch:changed", listener);
    return () => ipcRenderer.removeListener("dispatch:changed", listener);
  },
  onPublishEvent: (cb) => {
    const listener = (_e: unknown, ev: PublishEvent) => cb(ev);
    ipcRenderer.on("publish:event", listener);
    return () => ipcRenderer.removeListener("publish:event", listener);
  },
  getHooks: () => ipcRenderer.invoke("hooks:get"),
  trustHooks: (path, trusted) => ipcRenderer.invoke("hooks:trust", path, trusted),
  openHooksFile: (kind) => ipcRenderer.invoke("hooks:open", kind),
  getContextSettings: () => ipcRenderer.invoke("context:get"),
  setContextSettings: (change) => ipcRenderer.invoke("context:set", change),
  listMemories: () => ipcRenderer.invoke("memory:list"),
  addMemory: (text, scope) => ipcRenderer.invoke("memory:add", text, scope),
  deleteMemory: (id) => ipcRenderer.invoke("memory:delete", id),
  browserState: () => ipcRenderer.invoke("browser:state"),
  browserAutomationState: () => ipcRenderer.invoke("browser:automationState"),
  browserAutomationPause: () => ipcRenderer.invoke("browser:automationPause"),
  browserFlowList: () => ipcRenderer.invoke("browser:flowList"),
  browserFlowStartRecording: (name, options) => ipcRenderer.invoke("browser:flowStartRecording", name, options),
  browserFlowStopRecording: (name) => ipcRenderer.invoke("browser:flowStopRecording", name),
  browserFlowRename: (oldName, newName) => ipcRenderer.invoke("browser:flowRename", oldName, newName),
  browserFlowRun: (name, vars, options) => ipcRenderer.invoke("browser:flowRun", name, vars, options),
  browserFlowDelete: (name) => ipcRenderer.invoke("browser:flowDelete", name),
  browserAutomationResume: () => ipcRenderer.invoke("browser:automationResume"),
  browserAutomationStop: () => ipcRenderer.invoke("browser:automationStop"),
  onBrowserAutomation: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
    ipcRenderer.on("browser:automation", listener);
    return () => ipcRenderer.removeListener("browser:automation", listener);
  },
  browserToUrl: (input) => ipcRenderer.invoke("browser:toUrl", input),
  browserHistory: (query) => ipcRenderer.invoke("browser:history", query),
  browserClearHistory: () => ipcRenderer.invoke("browser:clearHistory"),
  browserClearData: () => ipcRenderer.invoke("browser:clearData"),
  browserAnswerOffer: (save) => ipcRenderer.invoke("browser:answerOffer", save),
  browserFillLogin: (id) => ipcRenderer.invoke("browser:fillLogin", id),
  browserRemoveLogin: (id) => ipcRenderer.invoke("browser:removeLogin", id),
  browserSetSettings: (s) => ipcRenderer.invoke("browser:setSettings", s),
  browserDevTools: () => ipcRenderer.invoke("browser:devtools"),
  onBrowser: (cb) => {
    const listener = (_e: unknown, ev: BrowserEvent) => cb(ev);
    ipcRenderer.on("browser:event", listener);
    return () => ipcRenderer.removeListener("browser:event", listener);
  },
  consolidateMemory: () => ipcRenderer.invoke("memory:consolidate"),
  pendingMemories: () => ipcRenderer.invoke("memory:pending"),
  resolvePendingMemory: (id, accept) => ipcRenderer.invoke("memory:resolvePending", id, accept),
  ragStatus: () => ipcRenderer.invoke("rag:status"),
  ragRebuild: () => ipcRenderer.invoke("rag:rebuild"),
  onRagStatus: (cb) => {
    const listener = (_e: unknown, s: RagStatus) => cb(s);
    ipcRenderer.on("rag:status", listener);
    return () => ipcRenderer.removeListener("rag:status", listener);
  },
  wikiGet: () => ipcRenderer.invoke("wiki:get"),
  wikiGenerate: (mode) => ipcRenderer.invoke("wiki:generate", mode),
  wikiCancel: () => ipcRenderer.invoke("wiki:cancel"),
  wikiAsk: (req) => ipcRenderer.invoke("wiki:ask", req),
  wikiAskCancel: () => ipcRenderer.invoke("wiki:askCancel"),
  graphState: () => ipcRenderer.invoke("graph:state"),
  graphGet: (id) => ipcRenderer.invoke("graph:get", id),
  graphBuildCode: () => ipcRenderer.invoke("graph:buildCode"),
  graphBuildDoc: (file) => ipcRenderer.invoke("graph:buildDoc", file),
  graphProjectDocs: () => ipcRenderer.invoke("graph:projectDocs"),
  graphPickDoc: () => ipcRenderer.invoke("graph:pickDoc"),
  graphDelete: (id) => ipcRenderer.invoke("graph:delete", id),
  graphCancel: () => ipcRenderer.invoke("graph:cancel"),
  arktsStatus: () => ipcRenderer.invoke("arkts:status"),
  arktsOpen: (file, text) => ipcRenderer.invoke("arkts:open", file, text),
  arktsChange: (file, text) => ipcRenderer.send("arkts:change", file, text),
  arktsClose: (file) => ipcRenderer.send("arkts:close", file),
  arktsRequest: (feature, file, payload) => ipcRenderer.invoke("arkts:request", feature, file, payload),
  arktsPickSdk: () => ipcRenderer.invoke("arkts:pickSdk"),
  archiveProject: (note) => ipcRenderer.invoke("archive:run", note),
  archiveCancel: () => ipcRenderer.invoke("archive:cancel"),
  onArchiveProgress: (cb) => {
    const listener = (_e: unknown, p: ArchiveProgress) => cb(p);
    ipcRenderer.on("archive:progress", listener);
    return () => ipcRenderer.removeListener("archive:progress", listener);
  },
  archiveDir: () => ipcRenderer.invoke("archive:dir"),
  chooseArchiveDir: () => ipcRenderer.invoke("archive:chooseDir"),
  showInFolder: (file) => ipcRenderer.invoke("archive:showInFolder", file),
  addCustomProvider: (kind) => ipcRenderer.invoke("providers:addCustom", kind),
  removeCustomProvider: (id) => ipcRenderer.invoke("providers:removeCustom", id),
  usageSummary: () => ipcRenderer.invoke("usage:summary"),
  snipShortcut: () => ipcRenderer.invoke("snip:get"),
  setSnipShortcut: (on) => ipcRenderer.invoke("snip:set", on),
  snipCopy: () => ipcRenderer.invoke("snip:copy"),
  setSnipCopy: (on) => ipcRenderer.invoke("snip:setCopy", on),
  webSearch: () => ipcRenderer.invoke("websearch:get"),
  setWebSearch: (u) => ipcRenderer.invoke("websearch:set", u),
  snipGesture: () => ipcRenderer.invoke("snip:gesture"),
  setSnipGesture: (change) => ipcRenderer.invoke("snip:setGesture", change),
  onChatInject: (cb) => {
    const listener = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on("chat:inject", listener);
    return () => ipcRenderer.removeListener("chat:inject", listener);
  },
  onSound: (cb) => {
    const listener = (_e: unknown, name: SoundName) => cb(name);
    ipcRenderer.on("sound:play", listener);
    return () => ipcRenderer.removeListener("sound:play", listener);
  },
  islandEnabled: () => ipcRenderer.invoke("island:get"),
  setIslandEnabled: (on) => ipcRenderer.invoke("island:set", on),
  voiceSettings: () => ipcRenderer.invoke("voice:get"),
  dictation: () => ipcRenderer.invoke("dict:get"),
  setDictation: (on) => ipcRenderer.invoke("dict:set", on),
  grantDictation: () => ipcRenderer.invoke("dict:grant"),
  setDictationKey: (key) => ipcRenderer.invoke("dict:key", key),
  onDictationChange: (cb) => {
    const listener = (_e: unknown, v: DictationView) => cb(v);
    ipcRenderer.on("dict:changed", listener);
    return () => ipcRenderer.removeListener("dict:changed", listener);
  },
  setVoiceSettings: (change) => ipcRenderer.invoke("voice:set", change),
  groupCandidates: () => ipcRenderer.invoke("group:candidates"),
  groupList: () => ipcRenderer.invoke("group:list"),
  groupLoad: (id) => ipcRenderer.invoke("group:load", id),
  groupCreate: (title, members) => ipcRenderer.invoke("group:create", title, members),
  groupDelete: (id) => ipcRenderer.invoke("group:delete", id),
  groupSend: (id, text, mentions) => ipcRenderer.invoke("group:send", id, text, mentions),
  groupStop: (id) => ipcRenderer.invoke("group:stop", id),
  groupFinalize: (id, memberId) => ipcRenderer.invoke("group:finalize", id, memberId),
  groupHandoff: (id) => ipcRenderer.invoke("group:handoff", id),
  automations: () => ipcRenderer.invoke("automation:list"),
  saveAutomation: (a) => ipcRenderer.invoke("automation:save", a),
  deleteAutomation: (id) => ipcRenderer.invoke("automation:delete", id),
  setAutomationEnabled: (id, on) => ipcRenderer.invoke("automation:setEnabled", id, on),
  runAutomation: (id) => ipcRenderer.invoke("automation:run", id),
  stopAutomation: () => ipcRenderer.invoke("automation:stop"),
  onAutomations: (cb) => {
    const listener = (_e: unknown, v: AutomationView) => cb(v);
    ipcRenderer.on("automation:changed", listener);
    return () => ipcRenderer.removeListener("automation:changed", listener);
  },
  extSearch: (q, offset) => ipcRenderer.invoke("ext:search", q, offset),
  extInstalled: () => ipcRenderer.invoke("ext:installed"),
  extInstall: (id) => ipcRenderer.invoke("ext:install", id),
  extUninstall: (id) => ipcRenderer.invoke("ext:uninstall", id),
  extSetEnabled: (id, on) => ipcRenderer.invoke("ext:setEnabled", id, on),
  extContributions: () => ipcRenderer.invoke("ext:contributions"),
  onExtChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("ext:changed", listener);
    return () => ipcRenderer.removeListener("ext:changed", listener);
  },
  updateState: () => ipcRenderer.invoke("update:state"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateDownload: () => ipcRenderer.invoke("update:download"),
  setUpdateAutoDownload: (on) => ipcRenderer.invoke("update:setAutoDownload", on),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  updateOpenDownload: () => ipcRenderer.invoke("update:openDownload"),
  uninstallApp: () => ipcRenderer.invoke("app:uninstall"),
  onUpdateChanged: (cb) => {
    const listener = (_e: unknown, v: UpdateState) => cb(v);
    ipcRenderer.on("update:changed", listener);
    return () => ipcRenderer.removeListener("update:changed", listener);
  },
  mobileState: () => ipcRenderer.invoke("mobile:state"),
  mobileSetEnabled: (on) => ipcRenderer.invoke("mobile:setEnabled", on),
  mobileSetRelay: (url, phoneUrl) => ipcRenderer.invoke("mobile:setRelay", url, phoneUrl),
  mobileCreatePairing: () => ipcRenderer.invoke("mobile:createPairing"),
  mobileCancelPairing: () => ipcRenderer.invoke("mobile:cancelPairing"),
  mobileApproveDevice: (id, allow) => ipcRenderer.invoke("mobile:approveDevice", id, allow),
  mobileRevoke: (id) => ipcRenderer.invoke("mobile:revoke", id),
  onMobileChanged: (cb) => {
    const listener = (_e: unknown, v: MobileGatewayState) => cb(v);
    ipcRenderer.on("mobile:changed", listener);
    return () => ipcRenderer.removeListener("mobile:changed", listener);
  },
  remoteState: () => ipcRenderer.invoke("remote:state"),
  remoteEnable: () => ipcRenderer.invoke("remote:enable"),
  remoteDisable: () => ipcRenderer.invoke("remote:disable"),
  remoteRelogin: () => ipcRenderer.invoke("remote:relogin"),
  remoteVerify: (code) => ipcRenderer.invoke("remote:verify", code),
  onRemote: (cb) => {
    const listener = (_e: unknown, v: RemoteView) => cb(v);
    ipcRenderer.on("remote:changed", listener);
    return () => ipcRenderer.removeListener("remote:changed", listener);
  },
  clusterView: () => ipcRenderer.invoke("cluster:view"),
  clearCluster: () => ipcRenderer.invoke("cluster:clear"),
  onClusterChanged: (cb) => {
    const listener = (_e: unknown, v: ClusterView) => cb(v);
    ipcRenderer.on("cluster:changed", listener);
    return () => ipcRenderer.removeListener("cluster:changed", listener);
  },
  regressView: () => ipcRenderer.invoke("regress:view"),
  regressGenerate: (session, focus) => ipcRenderer.invoke("regress:generate", session, focus),
  regressAddItems: (candidates) => ipcRenderer.invoke("regress:addItems", candidates),
  regressUpdateItem: (id, patch) => ipcRenderer.invoke("regress:updateItem", id, patch),
  regressDeleteItem: (id) => ipcRenderer.invoke("regress:deleteItem", id),
  regressRun: (itemIds, session) => ipcRenderer.invoke("regress:run", itemIds, session),
  regressCancel: (runId) => ipcRenderer.invoke("regress:cancel", runId),
  regressOverride: (runId, verdict) => ipcRenderer.invoke("regress:override", runId, verdict),
  regressSnapshot: (name) => ipcRenderer.invoke("regress:snapshot", name),
  regressDiff: (baselineId) => ipcRenderer.invoke("regress:diff", baselineId),
  regressDeleteBaseline: (id) => ipcRenderer.invoke("regress:deleteBaseline", id),
  regressReply: (runId) => ipcRenderer.invoke("regress:reply", runId),
  regressSetSettings: (patch) => ipcRenderer.invoke("regress:setSettings", patch),
  onRegressChanged: (cb) => {
    const listener = (_e: unknown, v: RegressView) => cb(v);
    ipcRenderer.on("regress:changed", listener);
    return () => ipcRenderer.removeListener("regress:changed", listener);
  },
  onGroupEvent: (cb) => {
    const listener = (_e: unknown, ev: GroupEvent) => cb(ev);
    ipcRenderer.on("group:event", listener);
    return () => ipcRenderer.removeListener("group:event", listener);
  },
  resumePending: () => ipcRenderer.invoke("resume:pending"),
  resumeDismiss: (id, updatedAt) => ipcRenderer.invoke("resume:dismiss", id, updatedAt),
  onWikiState: (cb) => {
    const listener = (_e: unknown, s: WikiState | null) => cb(s);
    ipcRenderer.on("wiki:state", listener);
    return () => ipcRenderer.removeListener("wiki:state", listener);
  },
  onArktsStatus: (cb) => {
    const listener = (_e: unknown, s: ArktsStatus) => cb(s);
    ipcRenderer.on("arkts:status", listener);
    return () => ipcRenderer.removeListener("arkts:status", listener);
  },
  onArktsDiagnostics: (cb) => {
    const listener = (_e: unknown, file: string, diagnostics: unknown[]) => cb(file, diagnostics);
    ipcRenderer.on("arkts:diagnostics", listener);
    return () => ipcRenderer.removeListener("arkts:diagnostics", listener);
  },
  onGraphState: (cb) => {
    const listener = (_e: unknown, s: GraphState) => cb(s);
    ipcRenderer.on("graph:state", listener);
    return () => ipcRenderer.removeListener("graph:state", listener);
  },
  onMcpChanged: (cb) => {
    const listener = (_e: unknown, servers: McpServerView[]) => cb(servers);
    ipcRenderer.on("mcp:changed", listener);
    return () => ipcRenderer.removeListener("mcp:changed", listener);
  },
  termStart: (tab, cols, rows) => ipcRenderer.invoke("term:start", tab, cols, rows),
  onTermOpenAgent: (cb) => {
    const listener = (_e: unknown, cli: AgentCli) => cb(cli);
    ipcRenderer.on("term:openAgent", listener);
    return () => ipcRenderer.removeListener("term:openAgent", listener);
  },
  termStartAgent: (tab, cli, cols, rows) => ipcRenderer.invoke("term:startAgent", tab, cli, cols, rows),
  termInstallCommand: (cli) => ipcRenderer.invoke("term:installCommand", cli),
  termAgentKinds: () => ipcRenderer.invoke("term:agentKinds"),
  termOpenAgentKindsDir: () => ipcRenderer.invoke("term:openAgentKindsDir"),
  termWrite: (tab, data) => ipcRenderer.send("term:write", tab, data),
  termResize: (tab, cols, rows) => ipcRenderer.send("term:resize", tab, cols, rows),
  termClose: (tab) => ipcRenderer.send("term:close", tab),
  termAgents: () => ipcRenderer.invoke("term:agents"),
  onTermAgents: (cb) => {
    const listener = (_e: unknown, s: AgentSessionView[]) => cb(s);
    ipcRenderer.on("term:agents", listener);
    return () => ipcRenderer.removeListener("term:agents", listener);
  },
  onTermFocus: (cb) => {
    const listener = (_e: unknown, tab: string) => cb(tab);
    ipcRenderer.on("term:focus", listener);
    return () => ipcRenderer.removeListener("term:focus", listener);
  },
  onTermData: (cb) => {
    const listener = (_e: unknown, tab: string, data: string) => cb(tab, data);
    ipcRenderer.on("term:data", listener);
    return () => ipcRenderer.removeListener("term:data", listener);
  },
  onTermExit: (cb) => {
    const listener = (_e: unknown, tab: string, code: number) => cb(tab, code);
    ipcRenderer.on("term:exit", listener);
    return () => ipcRenderer.removeListener("term:exit", listener);
  },
};

contextBridge.exposeInMainWorld("sweet", api);
