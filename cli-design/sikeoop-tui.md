# sikeoop CLI：Rust 写的终端交互界面（设计稿）

> 状态：设计稿，未开工。日期：2026-10-09。

## 1. 要解决什么

- 很多场景开不了 sikeoop 桌面版，却需要它：在 SSH 远程服务器上，在纯终端工作流里，或者只想随手问一句、不想开一个大窗口。
- CLI 和桌面版要是**同一个 sikeoop**：
  - 人格（鲸鱼娘）、记忆（c1–c4）、钩子、懒人模式都一样；
  - 模型配置和 Key 一样；
  - 会话历史互通：在终端开的会话，回到桌面版能接着聊，反过来也一样。
- 用 Rust 写：启动快（目标冷启动 < 150ms 出界面），单个二进制，体积小，能可靠处理中文宽字符和输入法。

## 2. 总体方案：Rust 界面 + 复用现有 Node 内核（推荐）

```
┌──────────────────────┐   stdio, 每行一条 JSON-RPC   ┌───────────────────────────────┐
│  sikeoop (Rust)      │ ───────────────────────────▶ │  sikeoop-core（无窗口）          │
│  ratatui 界面 / 输入 │ ◀─────────────────────────── │  AgentSession / 工具 / 记忆 /    │
│  渲染 Markdown、diff │   event 通知（AgentEvent 原样）│  钩子 / 模型适配器 / 会话存储     │
└──────────────────────┘                               └───────────────────────────────┘
```

为什么不用 Rust 把内核整个重写一遍：

- 现在的内核已经很大，而且一直在长：
  - `agent/` 和 `tools/` 合计 4000 多行；
  - 还有 providers、memory、hooks、compactor、reviewer、缓存检查等。
- 重写就得两套代码同步维护。人格提示词、记忆打分、工具行为只要有一处没对齐，桌面版和 CLI 就成了两个不同的 AI。
- 内核和 Electron 的耦合本来就很少，适合直接抽出来：
  - `AgentSession` 只靠 `SessionDeps` 注入依赖，通过 `emit(AgentEvent)` 往外发事件；
  - agent、tools、memory、hooks 里直接 `import "electron"` 的只有两处：`session-store.ts` 用了 `app.getPath`，`providers/store.ts` 用了 `safeStorage` 和 `app`。

否决的另外两条路：

| 方案 | 问题 |
|---|---|
| Rust 重写内核 | 工作量大，长期两套实现会互相漂移 |
| CLI 只能连接正在运行的桌面版 | 远程服务器、没开桌面版的时候用不了。可以以后作为附加模式（见 §9） |

## 3. 内核怎么跑：两种运行模式

难点在 Key：桌面版用 Electron `safeStorage` 加密 Key，Mac 上是钥匙串，Windows 上是 DPAPI。纯 Node 解不开这份加密。

| 模式 | 怎么启动内核 | Key、会话、记忆 | 用在哪 |
|---|---|---|---|
| **共享模式**（P1 先做） | 用已安装的 sikeoop 程序本身，带 `--core-stdio` 参数启动，不建窗口、不显示 Dock 图标 | 和桌面版是同一个 userData，Key 照常用 safeStorage 解密，完全互通 | 本机，已经装了桌面版 |
| **独立模式**（P3） | 自带一个 Node 运行时，加打包好的 `core.cjs` | Key 存进系统钥匙串（Rust 的 `keyring` crate，经协议交给内核），或者从环境变量 `SIKEOOP_API_KEY` 读取；会话和记忆放在 `~/.sikeoop/` | Linux 服务器，没装桌面版 |

内核要做的改造，交给 Codex 军团：

1. 新增 `src/main/core/platform.ts`，定义 `Platform { dataDir(): string; secrets: SecretStore }`。
   - 桌面版和共享模式的实现：`app.getPath` 加 `safeStorage`；
   - 独立模式的实现：`~/.sikeoop` 加通过协议拿到的 Key。
2. `session-store.ts` 和 `providers/store.ts` 改成通过 `Platform` 取路径和 Key，不再直接 import electron。
3. 新增 `src/main/core/stdio-server.ts`：
   - 读 stdin 的 JSON-RPC 请求，调用 `AgentSession` 等服务；
   - 把每个 `AgentEvent` 原样作为通知写到 stdout；
   - 日志只写 stderr，不污染协议。
4. 在 `index.ts` 入口判断：带 `--core-stdio` 时只起 stdio-server，不建任何窗口。
5. **能力协商**：只有桌面才有的工具（内置浏览器、语音、听写、灵动岛、手势、安卓模拟器界面等）在无窗口内核里不注册。`initialize` 的返回值会列出可用的工具，系统提示词里关于浏览器的那一行也跟着去掉。

## 4. 协议（先定接口：指挥官来写，两个军团照着做）

- 传输：stdio，每行一条 JSON（NDJSON），格式是 JSON-RPC 2.0。
- 版本：`initialize` 双方都带 `protocol: 1`，大版本不一致就直接报错退出。
- 类型来源：
  - `src/shared/types.ts` 是唯一的类型源头；
  - 用 `ts-json-schema-generator` 导出 `protocol.schema.json`；
  - Rust 那边用 `typify` 在构建时生成 serde 类型，放在 `crates/protocol`。
  - 这样两边类型不可能对不上，CI 会对比 schema 有没有变。

请求，从 CLI 发给内核：

| 方法 | 参数 | 说明 |
|---|---|---|
| `initialize` | `{protocol, client:"tui", cwd, size}` | 返回内核版本、可用工具、当前模型、会话列表摘要 |
| `session.list` / `session.open` / `session.new` | `{root}` / `{id}` / `{root}` | 列出、打开、新建会话，和桌面版是同一份数据 |
| `chat.send` | `{text, images?, lazy?, attachments?}` | 发一条消息，回复通过 event 通知流式返回 |
| `chat.cancel` | `{}` | 中断当前这一轮 |
| `approval.respond` | `{id, approved, always?}` | 回应审批卡片 |
| `question.answer` | `{id, answers \| useDefaults}` | 回答提问卡片 |
| `turn.undo` | `{turnId}` | 撤销这一轮改过的文件 |
| `context.compact` | `{}` | 手动压缩上下文 |
| `memory.search` / `memory.pending` / `memory.resolve` | 和桌面版的 IPC 一样 | 记忆相关 |
| `provider.list` / `provider.use` | `{id, model}` | 切换模型 |
| `files.complete` | `{prefix}` | 给 `@文件` 补全用，遵守 .gitignore |

通知，从内核发给 CLI：

- `event`：`{sessionId, event: AgentEvent}`。字段和桌面版完全一样，CLI 认识的事件就渲染，不认识的忽略，所以以后新增事件类型不会把旧版 CLI 弄崩。
- `log`：内核的警告，显示在状态栏，不打断对话。

## 5. Rust 工程结构

```
sikeoop-cli/
├─ Cargo.toml                 # workspace
├─ crates/
│  ├─ protocol/               # 由 schema 生成的类型、JSON-RPC 编解码
│  ├─ core-link/              # 找到并启动内核子进程、请求和回复配对、事件 channel、内核崩溃后重启
│  ├─ render/                 # Markdown 转 ratatui Text、代码高亮、diff、中文按显示宽度折行
│  └─ tui/                    # 二进制 `sikeoop`：App 状态机、各个视图、按键映射
└─ xtask/                     # 生成 schema 类型、打包
```

主要依赖：

| 用途 | crate |
|---|---|
| 界面 | `ratatui` + `crossterm`（Windows、macOS、Linux 都支持） |
| 异步和子进程 | `tokio`（process、io-util、sync） |
| 多行输入 | `tui-textarea` |
| Markdown 和代码高亮 | `pulldown-cmark` + `syntect`（只打包常用语法，控制体积） |
| diff | `similar` |
| 中文宽度 | `unicode-width` + `unicode-segmentation`（**所有折行和截断都按显示宽度算**） |
| 命令行参数 | `clap` |
| 剪贴板 | `arboard`（远程 SSH 时退回 OSC 52） |
| 钥匙串（独立模式） | `keyring` |
| 错误和日志 | `anyhow`、`thiserror`、`tracing`（日志写文件，不写终端） |

架构用单向数据流：

- 键盘、内核事件、定时器这三种输入都变成 `Msg`；
- `update(&mut App, Msg)` 改状态，`view(&App)` 画界面；
- 渲染限制在每秒 60 帧以内；
- `text_delta` 只追加到最后一段，避免长对话每帧都重新排版。

## 6. 界面设计

### 6.1 主界面

```
┌ sikeoop ─ ~/proj/shop ─ DeepSeek V4 ─ 普通 ───────────── 上下文 38% · 缓存命中 ┐
│                                                                                 │
│ 你  帮我看看为什么登录接口 500                                                   │
│                                                                                 │
│ 鲸  哈？这种问题也要问吗，杂鱼～ 等我看一眼。                                     │
│   ▸ 读取 src/api/login.ts                                       ✓ 0.1s          │
│   ▸ 搜索 "jwtSecret"                                            ✓ 3 处          │
│   ▾ 运行 npm test -- login                                      ✗ 2.4s          │
│     │ FAIL  login.test.ts › rejects expired token                               │
│     │ TypeError: Cannot read properties of undefined (reading 'secret')         │
│   找到了，config 没加载就去读 secret。改这里：                                    │
│   ┌ src/api/login.ts ───────────────────────────────────────────┐               │
│   │ - const s = config.jwt.secret                               │               │
│   │ + const s = (await loadConfig()).jwt.secret                 │               │
│   └─────────────────────────────────────────────────────────────┘               │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│ › 输入消息，@ 引用文件，/ 打开命令                                    Ctrl+J 换行 │
└ Enter 发送 · Esc 中断 · Ctrl+L 懒人模式 · ? 帮助 ───────────────────────────────┘
```

- **顶栏**：项目、模型、模式、上下文占用和这次的缓存结论。模式在懒人模式下显示红底「懒人」；缓存结论取自 `cache_check`，`miss` 或 `partial` 时标黄并附上原因。
- **工具行**：
  - 默认折叠成一行，显示状态和用时；
  - 失败的自动展开；
  - `Ctrl+O` 展开或折叠当前选中的一行。
  - 模型还在写参数时（`tool_preview`），用暗色显示参数的最后一截。
- **思考过程**：`thinking_delta` 默认收成一行「思考中… 1.2k 字」，按 `T` 展开。
- **文件改动**：`file_changed` 显示成 diff 卡片。一轮结束时（`turn_changes`）底部出一行：「改了 3 个文件 · U 撤销这轮」。

### 6.2 审批卡片（弹出层，会挡住输入框）

```
┌ 要运行命令 ─────────────────────────────────────┐
│ rm -rf dist && npm run build                    │
│ 位置：~/proj/shop                               │
│                                                 │
│ [Y] 同意   [N] 拒绝   [A] 这类以后都同意   [E] 先改一下 │
└─────────────────────────────────────────────────┘
```

- 长任务模式下，审阅员先判。卡片里先显示「审阅员在看…」，判定是 `ask_human` 时才等人回答。
- 懒人模式不弹卡片，但会在对话里留一行灰字记录做了什么，方便事后查。

### 6.3 其他视图

| 按键或命令 | 视图 |
|---|---|
| `/resume`、`Ctrl+R` | 会话列表，可模糊搜索，和桌面版共享，标出最后一次是在哪个界面上用的 |
| `/model` | 选择模型和服务商 |
| `/memory` | 记忆：搜索，处理待确认的（同意、拒绝、合并），查看归档 |
| `/plan`、`Ctrl+P` | 右侧计划栏（`plan` 事件），宽度小于 100 列时改成弹出层 |
| `/undo`、`/compact`、`/new`、`/help`、`/quit` | 照字面意思 |
| 提问卡片 | 用方向键选择、空格多选，`D` 表示「用推荐答案」 |

### 6.4 启动画面

- 用纯字符画出 sikeoop 的 logo，和桌面版开机动画是同一个叙事：字符先下落，再拼成 logo，总共 0.4 秒。
- 内核准备好就立刻结束；`--no-splash` 或者终端不是 TTY 时直接跳过。
- 等待时的提示用人格的口吻，比如「别催，杂鱼」「在想了在想了」。文案由内核在 `initialize` 时给出，保证和桌面版一致。

## 7. 对中文用户的细节

- **宽度**：中文、全角标点和 emoji 都按 `unicode-width` 计算。表格、截断、光标位置统一走 `render::width`，不允许任何地方用 `.len()` 算宽度。
- **输入法**：
  - 交给终端自己处理组字，CLI 只接收上屏后的文字；
  - 输入框把光标放在真实位置（`set_cursor_position`），这样系统输入法的候选窗跟着光标走；
  - 在 Windows Terminal、iTerm2 和 macOS 自带终端里配搜狗和微软拼音逐一测试。
- **Windows**：
  - 启动时 `SetConsoleOutputCP(65001)`，避免 GBK 代码页把中文显示成乱码；
  - 检测到老的 conhost 时提示改用 Windows Terminal。
- **镜像**：独立模式安装脚本默认用国内镜像，可以用 `SIKEOOP_MIRROR` 改。
- **提示文字全部是中文**；`--lang en` 留到以后再做。

## 8. 非交互模式（脚本和 CI 用）

```bash
sikeoop -p "给 README 加上安装说明"
```

```bash
git diff | sikeoop -p "帮我写 commit message"
```

```bash
sikeoop -p "跑一下测试并修好" --json
```

- `-p` 是打印模式：只输出最终回答，不进入界面；stdin 有内容时作为附件传给模型。
- `--json` 每行输出一个 `AgentEvent`，方便其他程序接着处理。
- 审批：非交互模式下**默认拒绝**所有要审批的操作，并在 stderr 说明拒绝了什么。只有显式加上 `--lazy`，才自动放行。
- 退出码：0 表示成功；1 表示出错；2 表示有操作被拒绝或被中断。

## 9. 和桌面版同时运行

- 同一个会话可能被两个界面同时写入。所以写会话时在会话目录里放 `session.lock`，写上 pid、界面名和时间。
- 打开一个已经被锁住的会话时，CLI 显示「这个会话正在桌面版里用」，让用户选：
  - **只读查看**；
  - **复制成新会话**；
  - **附加到桌面版**（以后再做）：通过现有的 `peers.ts` 或本机 socket 连到正在运行的桌面版内核，两边看到同一条事件流。
- 记忆写入已经由 Consolidator 串行处理。两个进程之间，用对 memory 目录的文件锁兜底。

## 10. 安全

- 懒人模式需要显式 `--lazy` 或 `Ctrl+L`。第一次在某个项目里开启时要确认一次（「懒人模式下她会直接改文件、跑命令，不问你」），状态栏一直显示红底「懒人」。
- CLI 不经手密码。Key 只在内核里解密；独立模式下，Key 从钥匙串读出后直接交给内核，不写进任何文件，也不打进日志。
- 协议日志（`--debug-protocol`）写到文件之前，先过一遍内核现有的 `redact.ts` 去掉敏感信息。
- 内核子进程继承 CLI 的环境变量，但会去掉 `SIKEOOP_API_KEY` 以外所有带 `KEY` 或 `TOKEN` 的变量名，免得被工具输出带进上下文。

## 11. 打包和分发

- 构建：
  - `cargo-dist` 出 macOS（arm64、x64、universal）、Windows x64 和 Linux x64、arm64；
  - 单个二进制，目标在 6MB 以内，syntect 只打包常用语法；
  - Linux 用 musl 静态链接。
- 共享模式：
  - 桌面版安装包里附带 `sikeoop` 命令行程序；
  - 在设置里提供「安装命令行工具」：macOS 软链到 `/usr/local/bin`，Windows 加进 PATH，在 NSIS 安装时可以勾选。
- 独立模式：
  - 用 `curl -fsSL https://sikeoop.modgert.online/install.sh | sh` 安装；
  - 会下载 CLI，加上 Node 运行时和 `core.cjs`；
  - 下载文件附带 SHA256 校验。
- 官网下载区加一张「命令行版」卡片。

## 12. 分阶段计划和分工

| 阶段 | 内容 | 谁来做 | 完成标准 |
|---|---|---|---|
| **P0 接口** | 协议文档、`protocol.schema.json`、Rust 端由 schema 生成类型 | 指挥官 | 两边都能编译，schema 有对比检查 |
| **P1 内核抽离** | `Platform` 接口、`stdio-server.ts`、`--core-stdio` 入口、能力协商 | Codex 军团 | 用 `echo '{"jsonrpc":"2.0",…}' \| sikeoop --core-stdio` 能跑完一轮对话 |
| **P1 界面最小版** | 启动内核、对话流式输出、工具行、审批卡片、中断、懒人模式开关 | Claude 军团 | 本机共享模式能聊天、改文件、跑命令 |
| **P2 完整交互** | 会话列表和续聊、`/` 命令、`@` 文件补全、diff 和撤销、计划栏、记忆视图、提问卡片、会话锁 | Claude 军团（界面）+ Codex 军团（锁和补全接口） | 在 CLI 里开的会话能在桌面版接着聊，反过来也行 |
| **P3 分发** | `-p` 和 `--json` 模式、独立模式、cargo-dist、安装脚本、官网卡片 | 两个军团 | 在一台干净的 Linux 服务器上用一行命令装好并能用 |

## 13. 需要你决定的事

1. **先做共享模式还是独立模式？** 推荐先做共享模式：改动最小，和桌面版完全互通。如果主要用在远程 Linux 服务器上，就把独立模式提前。
2. **命令名**：直接叫 `sikeoop`，还是短一点的 `skp`？
3. **代码放哪里**：
   - 放进 `sweet-code-desktop/cli/`：和内核一起改，schema 对比检查容易做；
   - 单独一个仓库 `sikeoop-cli/`：Rust 工具链和 Electron 构建互不干扰。
   - 推荐前者。
4. **附加到正在运行的桌面版**（§9）要不要进 P2？
