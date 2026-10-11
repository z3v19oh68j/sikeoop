# 跨项目 session 规格（M0 接口约定）

## 已定决策
- 项目窗口内的特殊标签页；用户 + 最多 4 个 AI（Claude Code / Codex）共用一条时间线。
- session 绑定 ≥2 个用户勾选的工作区目录（主进程 realpath 校验，必须在最近项目/已授权列表中）。
- 必须 @ 点名才派给 AI；无 @ 只记录并提示。同一时刻只一个 AI 发言，其余排队：每次 @ 和每次 AI 互呼都是调度核心的一个 job，同一 session 的 job 共用一条 lane（`Dispatcher.submit` 的 `lane` = sessionId），由调度核心的队列串行。
- AI 为 session 专用新开会话；“在终端里查看”为只读附着，禁止输入。
- AI 互呼走时间线，是发送方当前 job 的子任务，消耗调度核心的“任务树预算”（origin `session`，默认每棵树 20 个 job；不再有单独的 MAX_HOPS）。预算用完插 hopLimit 事件（沿用类型名）；用户在时间线发言即开新的根任务，预算重新计。（2026-10-10 按 D4 改写）
- 越界：Claude 由 PreToolUse hook 直接 deny，并产生 outOfScope 事件（界面给“加入此目录”按钮）；Codex 只限写（--sandbox workspace-write + 多可写目录，--ask-for-approval never），事后用 fs.watch/回复扫描补事件，界面注明。
- hook 判定超时 = 拒绝（session 会话及文件锁判定）。
- 文件锁：全局按 realpath 互斥，普通终端标签里的 Claude 也受约束；Stop/会话结束释放，10 分钟兜底。
- 新增目录后，已运行 AI 需重启生效（界面提示）。
- 持久化：userData/sessions/<id>/{meta.json(原子写), timeline.jsonl(追加), agents.json}；ended 后只读；重启后 AI 标记 exited，可手动重新拉起。

## 共享类型（src/shared/types.ts）
```ts
export type CrossSessionState = "active" | "ended";
export type SessionAgentStatus = "starting" | "idle" | "busy" | "queued" | "exited";
export interface SessionAgent { id: string; cli: AgentCli; name: string; status: SessionAgentStatus; tab: string }
export interface CrossSession { id: string; title: string; roots: string[]; agents: SessionAgent[]; state: CrossSessionState; createdAt: number; endedAt?: number }
export type TimelineEventKind = "user" | "agent" | "system" | "outOfScope" | "lockDenied" | "hopLimit" | "agentJoined" | "agentExited";
export interface TimelineEvent { seq: number; at: number; kind: TimelineEventKind; from?: string; to?: string[]; text?: string; path?: string; dir?: string }
export type SessionResult<T = void> = { ok: true; data: T } | { ok: false; message: string };
```

## IPC（invoke，均做运行时校验，错误返回 { ok:false, message 中文 }）
| 通道 | 入参 | 返回 |
|---|---|---|
| session:list | — | CrossSession[] |
| session:get | id, before?: number | { meta: CrossSession; events: TimelineEvent[] }（最近 200 条） |
| session:create | { title, roots: string[] } | CrossSession |
| session:addAgent | id, cli | SessionAgent（上限 4） |
| session:removeAgent | id, agentId | void |
| session:send | id, text, mentions: string[]（agentId） | void；ended 拒绝 |
| session:addRoot | id, dir | void；主进程弹原生确认框 |
| session:end | id | void |
| session:openTerminal | id, agentId | void（只读附着） |
| session:stop | id, agentId? | void（停当前发言并清队列） |

推送：`session:event`(id, TimelineEvent)、`session:changed`(CrossSession)。

## preload
`window.sweet.session.{list,get,create,addAgent,removeAgent,send,addRoot,end,openTerminal,stop,onEvent,onChanged}`（类型 `CrossSessionApi`），on* 返回取消订阅函数。（按 D4：不是 `window.api`）

## 命名与隔离
- PeerBus 加 group（sessionId | null）；listPeers/resolve 只在组内；计数器按组；hostSend/hostList 排除 group≠null。
- session 会话 tab = `s:${sessionId}:${agentId}`，名字 `Claude-1`（组内编号），界面/灵动岛显示时加 session 名前缀。渲染层的面板标签 id 是 `cs:${sessionId}`，只在界面里用，不发给主进程，两者不冲突。
- 时间线事件的 `from` / `to`：用户写 `user`，AI 写成员名（`Claude-1`），成员被移出后历史仍然读得出是谁。

## 任务
主进程（Codex）：M1 scope.ts → M2 PeerBus 分组 → M3 buildSessionLaunch(+实测 --add-dir) → M4 locks + PreToolUse deny → M5 store → M6 service + IPC + preload。
界面（ui-engineer）：U1 新建对话框，U2 时间线 + @ 补全，U3 事件卡片，U4 成员条，U5 只读与历史列表；先用 dev-mock。
