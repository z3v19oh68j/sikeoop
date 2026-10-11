# sikeoop · 桌面版

给新手的粉色 AI 代码编辑器。Electron + React + Monaco，底层是自己写的 Agent Loop，支持多个模型服务商。

当前进度：**M4 省钱又稳定**。AI 能读文件、搜索代码、修改和新建文件、运行命令；每个改动和每条命令都先给用户确认，每一轮的文件改动可以一键撤销。编辑器下方有终端（⌃` 打开），报错可以一键发给 AI。长对话会自动整理，不会超出模型的上下文；对话按项目自动保存，重开 App 能接着聊。

## 运行

```bash
npm install
npm run dev        # 开发模式，带热更新
npm run dev:web    # 只在浏览器里跑界面（用假数据，不需要 Electron 和 Key）
npm run build      # 打包到 out/
npm start          # 运行打包后的版本
npm run typecheck
```

打包时可以带上内置的 TokenDance（Jev 决策模型）Key，所有用户不填 Key 就能免费用决策模型：`SIKEOOP_BUILTIN_JEV_KEY=你的key npm run build`（或 `dist:mac` / `dist:win`）。Key 只在构建时注入，不要写进源码或提交到仓库；用户自己填了 Key 会优先用自己的。注意：打进安装包的 Key 可以被人从安装包里取出，额度被刷或要换 Key 时只能发新版本。

第一次打开后，点左下角的模型名称，选一个服务商、填 Key、选模型。Key 用系统钥匙串加密保存在本机，界面里不会显示。也可以用环境变量提供 Key，比如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`、`MOONSHOT_API_KEY`、`ZHIPUAI_API_KEY`、`GEMINI_API_KEY`、`ARK_API_KEY`（豆包）、`MINIMAX_API_KEY`、`OPENROUTER_API_KEY`。

## 支持的服务商

| 服务商 | 接入方式 |
|---|---|
| Claude | Anthropic 官方 SDK：自适应思考、思考深度三档、Prompt Caching、拒答兜底 |
| OpenAI、Gemini、DeepSeek、通义千问、Kimi、智谱 GLM、豆包（火山方舟）、MiniMax、OpenRouter、Ollama（本地） | OpenAI 兼容格式（Chat Completions + function calling） |
| 其他 | 「其他（OpenAI 兼容）」，自己填接口地址 |

- 设置里的「获取模型列表」会直接问服务商这个 Key 能用哪些模型，不用记模型名。
- 非 Claude 的模型必须支持工具调用（function calling），AI 才能读文件。
- 切换服务商、改模型或改 Key 都会开始新对话。每家的历史消息格式不同，不能混用。
- 新增服务商：OpenAI 兼容的，在 `src/main/providers/presets.ts` 加一项就行；格式不同的，实现 `ModelAdapter` 接口（`src/main/providers/types.ts`）。

## 结构

```
src/
  shared/types.ts          主进程和界面共用的类型（IPC 事件、AgentEvent）
  main/
    index.ts               窗口、IPC 注册
    workspace.ts           项目根目录、文件树、路径安全检查 resolveSafe()
    shell-env.ts           启动时读取用户 shell 的环境变量（PATH 等）
    terminal.ts            用户的终端：node-pty 伪终端
    agent/loop.ts          Agent Loop 状态机，和服务商无关 ← 核心
    agent/context.ts       固定的 system prompt、项目快照、编辑器上下文
    agent/checkpoints.ts   每轮改动前的快照，用于「撤销这一轮」
    agent/session-store.ts 对话按项目保存到 userData/sessions/
    providers/types.ts     ModelAdapter 接口：每家服务商要实现的部分
    providers/anthropic.ts           Claude 适配器（官方 SDK）
    providers/openai-compatible.ts   OpenAI 兼容适配器（流式拼接工具调用）
    providers/presets.ts   服务商列表：地址、推荐模型、Key 的环境变量
    providers/store.ts     服务商设置和加密 Key 的存取（只在主进程）
    providers/index.ts     按设置创建适配器、获取模型列表
    tools/registry.ts      工具定义、权限等级、能否并行
    tools/fs-tools.ts      list_files / read_file / search
    tools/edit-tools.ts    edit_file / create_file（需要用户确认）
    tools/command-tools.ts run_command（每次都要确认）、危险命令拦截
  shared/diff.ts           行级 Diff，生成审批卡片里的改动
  preload/index.ts         window.sweet：界面能调用的全部接口
  renderer/src/
    App.tsx                三栏布局
    components/            FileTree、EditorPane(Monaco)、TerminalPanel(xterm)、ChatPanel、ApprovalCard、Markdown、ProviderDialog
    dev-mock.ts            浏览器调试用的假接口
    styles/theme.css       粉色主题（跟随系统深浅色）
```

## Agent Loop 要点

- 循环只认识 `ModelAdapter` 接口。每个适配器用自家原生格式保存历史，Claude 的思考块、OpenAI 的 tool_calls 都原样传回，不做转换。
- 每一步的结果统一成五种：`tool_use`（执行工具后继续）、`end_turn`（回答完成）、`max_tokens`（被截断；截断的工具调用不执行）、`refusal`（拒答）、`continue`（Claude 的 `pause_turn`，原样再跑一次）。
- Claude：默认 `claude-opus-5-5`，自适应思考，思考摘要显示在对话里。开启了服务端兜底 `fallbacks: "default"`，模型因安全原因拒答时会自动换备用模型重跑；不想要的话，删掉 `providers/anthropic.ts` 里的 `betas` 和 `fallbacks` 两行。
- OpenAI 兼容：工具调用是分片流式发来的，按 index 拼接后再解析。DeepSeek、Kimi 这类思考模型的 `reasoning_content` 会显示出来，在工具调用过程中也会原样传回给它们。
- 历史只追加不修改。出错或点「停下」时，这一轮整体回滚，保证下次请求的历史始终合法，缓存前缀也不会被改动。
- 工具输入先用 zod 校验再执行。所有路径都要经过 `resolveSafe()`，项目外的路径（`..`、绝对路径、软链接）一律拒绝。
- 只读工具并行执行，结果按调用顺序传回（Claude 放在同一条 user 消息里，OpenAI 格式是每个调用一条 tool 消息）。
- Prompt Caching：system 内容固定。Claude 额外打了缓存断点，对话尾部开自动缓存；OpenAI 兼容的服务商一般自动缓存。状态栏会显示每次请求的缓存命中量。
- 每条用户消息最多 40 轮模型调用，防止死循环。

## 改文件（M2）

- `edit_file` 用「精确替换一段文字」的方式改文件：`old_string` 必须在文件里只出现一次（或者设置 `replace_all`）。
- **先读后改**：`read_file` 会记下文件内容的哈希。文件没读过、或者读完以后被改过（包括用户自己在编辑器里保存），编辑都会被拒绝，AI 必须重新读一遍。
- `create_file` 只能新建文件，已存在的文件要用 `edit_file`。两个工具都不能写 `node_modules`、`.git`、`dist` 这类文件夹。
- **审批**：工具算出改动后，循环暂停，对话里出现 Diff 卡片。用户可以选同意、本次对话都同意、拒绝（可以附一句意见）。拒绝的意见会原样告诉 AI。等待确认时点「停下」会取消整轮。
- 同意以后、写入之前会再检查一次文件，确认在等待确认期间没有被改过。
- **撤销这一轮**：CheckpointStore 记下每个文件在这一轮第一次被改之前的内容。撤销时，如果某个文件之后又被改过，就跳过它，不覆盖新的改动。撤销后，下一条消息会附一条 `<note>` 告诉 AI。
- 一轮中途出错或被取消时，对话历史会回滚，但已经写进磁盘的改动保留，并通过 `<note>` 告诉 AI；用户也可以撤销。
- AI 改的文件如果正在编辑器里打开，会立刻刷新，并且可以按 ⌘Z 找回改动前的内容。发消息前会自动保存所有没保存的标签页，保证 AI 看到的和用户看到的一致。

## 终端和命令（M3）

- **用户的终端**：编辑器下方，⌃` 或状态栏按钮打开。用 node-pty 跑用户自己的 shell，工作目录是项目文件夹。换项目时会重新打开。
- **AI 的命令**：`run_command` 不进用户的终端，而是单独起一个进程，这样两边互不干扰，也能拿到干净的输出和退出码。
  - 权限是 `always_confirm`：每条命令都要用户点「运行」，「本次对话都同意」对命令无效。
  - 超时默认 120 秒，最长 600 秒。超时或点「停下」时，会结束整个进程组，包括命令启动的子进程。
  - 命令拿不到键盘输入；环境里设置了 `CI=1`，让 npm 之类的工具跳过交互提问。
  - 输出实时显示在对话卡片里。返回给 AI 的输出保留开头 16K 和结尾 24K 字符，中间省略。
  - 直接拦截：`sudo`、删除根目录或家目录、`git push --force`、格式化磁盘、`curl … | sh` 等。会删文件、丢改动、推送、发布的命令可以运行，但卡片上会用红字提醒。
  - 命令做的改动不在「撤销这一轮」的范围内。命令结束后，文件树和打开的文件会从磁盘刷新。
- **开发服务器这类一直运行的命令**：AI 不会自己跑，而是写进 bash 代码块。代码块上有「▶ 在终端运行」按钮，点一下就发到用户的终端里执行。
- **帮我看看**：终端标题栏的按钮会把最近 80 行输出发给 AI；编辑器检测到当前文件有错误时，状态栏会出现「🐞 N 个报错 · 帮我看看」。
- **PATH**：从 Dock 或 Finder 打开的 App 拿不到用户 shell 里的 PATH。启动时会用 `$SHELL -ilc env` 读一次，所以 nvm、Homebrew 装的 node 和 npm 都能找到。

## 统一用 bash（包括 Windows）

模型写 bash 命令最熟练、最简短；PowerShell 的命令和输出都更长，更费额度，也更容易写错。所以：

- **AI 的命令在所有系统上都用 bash 运行**：macOS 和 Linux 用系统的 bash，Windows 用 Git Bash。工具说明里写明「只用 bash 语法」，项目快照里也会告诉模型当前是什么系统。
- **PowerShell 完全不用**：AI 调用 `powershell` / `pwsh` 会被拦截。
- **Windows 的终端面板也用 Git Bash**，这样 AI 给的命令点「在终端运行」也能直接跑。macOS 和 Linux 的终端还是用户自己的 shell。
- **找 Git Bash 的顺序**：环境变量 `SWEET_BASH` → Program Files / 用户目录 / Scoop 里的 Git → PATH 上 `git.exe` 旁边的 `bin\bash.exe` → MSYS2。`System32\bash.exe` 是 WSL，不会用。
- **没装 Git for Windows 时**不会退回 PowerShell：终端里显示安装提示，AI 也会用大白话告诉用户先装 Git。
- **Windows 上的细节**：设置 `CHERE_INVOKING=1`，让 Git Bash 留在项目文件夹而不是跳回家目录；`windowsHide` 不弹黑色控制台窗口；超时用 `taskkill /T` 结束整个进程树；没有设置语言时补上 UTF-8，避免中文乱码。
- 命令输出按流解码，一个中文字被拆在两段输出里也不会乱码。

Windows 上的这些行为还没有在真机上跑过，只在 macOS 上模拟测试了查找 Git Bash 的逻辑。

## 成本和长对话（M4）

**Prompt 缓存**
- system prompt、工具列表从头到尾不变；每轮的编辑器信息、`<note>` 都追加在用户消息里，历史只追加不修改。
- 切换「思考深度」不再让缓存失效：在支持的 Claude 模型上（Opus 5.5 / 5、Sonnet 5.5、Fable 5.1），新的深度作为一条 `role: "system"` 的 effort 消息追加进对话，顶层 `effort` 保持对话开始时的值。
- 状态栏显示这段对话的缓存命中率（缓存读取 ÷ 全部输入）。一次本该命中却没读到缓存的请求，会在主进程日志里打一条 `[cache] miss` 和可能的原因。
- OpenAI 兼容的服务商：`prompt_tokens` 里包含缓存部分，已经拆开统计，和 Claude 的口径一致。

**长对话**
- Claude：用服务端的两个 context management 功能，都不算修改历史，缓存和思考块都保持有效。
  - 输入超过 8 万 tokens 时，清理旧的工具结果（文件内容、命令输出），保留最近 5 个；每次至少清 2 万 tokens 才动手，值得那一次缓存重建。
  - 还是超过 15 万 tokens 时，服务端把之前的内容压缩成摘要（compaction 块原样存回历史）。摘要指令要求保留：用户目标、改过的文件、跑过的命令、失败的尝试、下一步。
  - Haiku 4.5 不支持这些功能，就不开启。
- OpenAI 兼容的服务商没有服务端压缩，用「简单压缩」：
  - 只在两轮之间做，不会在工具调用中途做。输入超过 5.6 万 tokens 时，让模型写一份摘要（`tool_choice: none`），清空历史，下一条消息带着 `<conversation_summary>` 重新开始。
  - 一轮中途服务商报「上下文太长」时，把旧的工具结果换成一句「已清理」（保留最近 4 个）再重试一次。
- 整理发生时，对话里会出现一条提示（📦 整理成摘要 / 🧹 清理了旧内容）。

**对话保存**
- 每个项目一个文件夹：`userData/sessions/<项目路径哈希>/<对话 id>.json`。每轮结束和每次撤销后保存，先写临时文件再改名，崩溃不会留下半个文件。
- 保存的内容：服务商原生格式的历史（Claude 的思考块、压缩块原样保留）、撤销用的快照（重开后「撤销这一轮」照样能用）、「先读后改」的文件哈希、界面要显示的对话记录。「本次对话都同意」不会保存，重开后会重新询问。
- 打开项目时自动接上最近的一段对话。聊天栏的「历史」可以切换、删除。
- 每家模型的历史格式不一样：用别的服务商聊的对话只能看，下方有「切换到 X 继续」；服务商没设置好时是「去设置」，设置好后自动重新打开那段对话。
- 应用关闭时还在等确认的卡片，重开后显示为「已拒绝」（那个改动没有执行）。

## 用 Anthropic 账号登录（Claude）

除了填 API Key，Claude 还可以用 Anthropic 官方命令行工具 `ant` 登录，不用复制粘贴 Key：

- 设置里选「Anthropic 账号登录」→「在终端里登录」，会在下方终端运行 `ant auth login`：浏览器打开，登录 Console 账号并选工作区。登录信息由 `ant` 保存在 `~/.config/anthropic/`（Windows：`%APPDATA%\Anthropic`），**App 不接触密码，也不保存 token**。
- 设置窗口每 2 秒检查一次登录状态（用 SDK 的 `loadConfig` / `loadCredentials`），登录完成后自动显示「已登录：组织名」。过期且无法刷新时提示重新登录。
- 请求时创建 `new Anthropic({ apiKey: null, authToken: null })`：显式置空，防止环境里残留的 `ANTHROPIC_API_KEY` 悄悄顶替登录；SDK 自己读取当前 profile、刷新 token、加上 OAuth 需要的请求头。
- 没装 `ant` 时：macOS 给出 `brew install anthropics/tap/ant` 并可一键在终端安装；Windows 指向 GitHub Releases 下载。
- 计费：这是 Console 账号，按 API 用量计费。**Claude Pro / Max 订阅不能在第三方应用里使用**（Anthropic 的规定），所以不支持用 claude.ai 账号登录，也不做订阅账号转 API 的「中转」。
- 登录文件权限不是 600 时，SDK 会拒绝使用（防止别的用户读取），App 会提示运行 `chmod 600 …`。

## 界面（深色，参考 Cursor）

- **配色**：只有深色。中性灰分几层，用 1px 细线分区，粉色只做点缀（爱心、发送按钮、当前标签、进度条、需要你决定的卡片）。所有颜色都在 `styles/theme.css` 开头的变量里。
- **字体**：界面用 Geist，代码和终端用 Geist Mono，从 `@fontsource-variable` 打包进应用，不联网也能用；中文用系统字体。
- **布局**：
  - 最左边是图标栏：首页、文件、全部伙伴、插件、设置。
  - 启动页：打开或新建项目、四张伙伴卡、最近的项目（主进程 `src/main/recent.ts`）。3D 选伙伴挪到了「全部伙伴」。
  - 工作台在切到别的页面时保持挂载，聊天、终端和打开的文件都不会丢。
- **聊天**：
  - 输入框底部切换 Agent / 长任务，旁边选思考深度。
  - 连续 3 步以上做完的操作折叠成「做了 N 件事」。
  - 改好的文件 diff 同意后自动收起。

## 上下文窗口：200K + 压缩子 agent

每段对话有一个固定的工作窗口：200K tokens，模型窗口更小时取窗口的 85%。窗口大小由 `presets.ts` 里的 `contextWindow` 和 `contextBudget()` 决定。

- **什么时候压缩**：不只在两条消息之间检查。多步任务里，每一轮工具调用之后都估算一次（当前提示长度 + 新工具输出约 3 字符 1 token）。到了预算就当场压缩，任务接着做，不用等下一条消息。
- **压缩子 agent**（`agent/compactor.ts`）：
  - 用独立的一次请求和独立的系统提示，不在主对话里进行。
  - 读的是精简过的记录：最近 4 个工具结果保留 3000 字，更早的只留 400 字，大的工具参数（文件内容）截短；还超长就保留开头和最近的部分，删掉中间。
  - 输出固定格式的摘要：目标、已完成、改过的文件、关键信息、失败的尝试、下一步、用户偏好。
- **由代码补上的确定信息**：当前任务、计划、改过的文件（来自撤销记录）放在 `<state>` 里。任务中途压缩时，还会重新带上项目概况、规则和记忆（SessionStart Hook，source 为 compact），并清掉读文件记录，让 AI 改文件前重新读。
- **出错时**：子 agent 失败就用只含确定信息的兜底摘要。压缩后这一轮失败，回滚到摘要那条消息，下一条消息并进去，不会出现两条连续的用户消息。
- **Claude**：保留官方的服务端压缩（效果更好、能保住缓存），触发点也改到 200K，清理旧工具输出的触发点改到 120K。
- **状态栏**：显示「上下文 62.3K / 200K」，超过 80% 变黄。点开是上下文分配面板（参考 Claude Code），计算在 `agent/context-usage.ts`：
  - 一条分段彩条，分成对话、工具结果、项目和记忆、思考、系统提示、工具定义六部分。
  - 每部分的 token 数和占比，以及距离自动压缩还剩多少。
  - 「立即压缩」按钮。
  - 每部分先按文字估算，再按比例缩放到服务商实际测得的 token 数，所以加起来正好等于真实值。重新打开的对话在第一次回复之前显示估算值。

## 小米 MiMo（Token Plan）

单独的服务商预设（`presets.ts` 里的 `mimo`），走 Anthropic 兼容协议，按 [MiMo Anthropic API 文档](https://mimo.mi.com/docs/zh-CN/api/chat/anthropic-api) 做了专门适配。

- **地址和 Key**：默认地址 `https://token-plan-cn.xiaomimimo.com/anthropic`，海外订阅把 cn 换成 sgp 或 ams。Key 是 Token Plan 的专属 Key（个人 tp-、团队 ttp- 开头），按 `Authorization: Bearer` 发送。
- **模型**：`mimo-v2.6-pro`（默认）、`mimo-v2.6-flash`、`mimo-v2.6-pro-ultraspeed`、`mimo-v2.5-pro`、`mimo-v2.5`。模型名后加 `[1m]` 开 1M 上下文。
- **兼容模式**（预设的 `compat` 标志，适配器里的 `stepCompat`）：
  - 只发文档列出的参数：model、max_tokens、system、messages、tools、thinking、stream。
  - 不发 betas、context_management、fallbacks、cache_control，也不显示账号登录。
- **思考**：`thinking: {type}` 只有开和关。思考深度选「快速」时关掉，「正常」和「深入思考」时打开。思考块原样回传。
- **输出上限**：max_tokens 默认 65536，`mimo-v2.5` 用 32768。
- **长对话**：服务端不支持压缩，所以由压缩子 agent 处理（见上一节），任务中途满了也能接着做。
- **停止原因**：`content_filter` 当作拒绝；`repetition_truncation`（复读截断）当作被截断。
- **审批小助手**：用 MiMo 审批时关掉思考，回答更快。
- **伙伴**：米朵（小米橙，3D Q 版，没有立绘）。

## 资源库

左侧的礼物图标。挑好的动效技能做成卡片，分三类：网页动效、动效原则、动效视频。卡片数据在 `src/shared/resources.ts`，星数会联网刷新（6 小时缓存）。

- **「让 AI 帮我装」**：把安装任务发到聊天里，AI 用 `install_skills` 工具从 GitHub 拉取。装之前先出一张确认卡，列出要装的技能，带脚本的、会覆盖旧版本的都会标出来。装好后在新对话里生效。
- **「让 AI 一键全装」**：一次装推荐的 3 组（Emil Kowalski、GSAP 官方、LottieFiles）。
- **「直接装」**：不经过 AI，直接拉取安装。还没打开项目、或者伙伴没设置好时用这个。
- **Lemo-Opuscar（动效视频）**：只装一个引导技能（SKILL.md + setup.sh）。第一次做片时，AI 运行 setup.sh 把约 100MB 的风格库下载到 `~/lemo-opuscar`，再装依赖；这一步要经过审批。
- **大仓库的处理**：仓库超过约 30MB 时（比如 HyperFrames、Lemo-Opuscar），只按名字逐个下载要装的那几个技能文件夹，不下载整个压缩包。整包下载按流读取，超过 40MB 立即停下。
- **SkillHub 商店**：资源库里的「SkillHub 商店」标签页，搜 skillhub.cn 上的技能（中文简介、下载量、是否要额外的 API Key），点「检查并安装」或「让 AI 装」。直接调用它的 HTTP 接口（`src/main/plugins/skillhub.ts`），不装它的 Python 命令行，也不发它那套客户端 ID 和调用方识别。AI 也能用 `search_skillhub` 搜、用 `install_skills` 的 `skillhub:<slug>` 来装。

## 技能安全审核

不管从哪里装技能（精选卡片、SkillHub、GitHub 链接、本地文件、粘贴的文本），装之前都会先审核，结果显示在安装面板（`components/SkillReview.tsx`）和 AI 的审批卡片上。

- **规则扫描**（`src/main/plugins/skill-audit.ts`，预览时自动做）：
  - 针对 AI 的指令注入：忽略原有规则、瞒着用户、越狱、泄露系统提示词、关闭确认 / 权限 / 沙箱；
  - 偷数据：读 SSH 密钥、云服务凭证、浏览器 cookie、sikeoop 自己的 Key 文件、全部环境变量，往 webhook.site、Discord webhook、ngrok 之类的地址发东西；既读密钥又联网的组合直接算高风险；
  - 破坏和远程控制：`rm -rf ~`、格式化磁盘、反向连接、`curl | bash`、解码后直接运行；
  - 开机自启、改 shell 配置、`sudo`；
  - 隐藏内容：双向控制字符和 Unicode tag 字符（能把整段话藏起来给 AI 看）、零宽字符、大段编码内容、Markdown 注释里写给 AI 的话；
  - 带可执行程序（ELF / Mach-O / exe）。
- **减少误报**：文档里“不要这样做”“如果文件里出现 'ignore previous instructions' 就标出来”这种提醒防范的写法降一级；emoji 里的零宽连接符、Chrome 的 `--no-sandbox` 不算。精选的 34 个技能和 SkillHub 上 8 个常用 PDF 技能，规则扫描没有一个被判成高风险。
- **AI 审核**（`src/main/plugins/skill-review.ts`）：打开安装面板就开始，用审批小助手的模型（没设就用聊天模型）通读 SKILL.md 和脚本，判断「安全 / 可疑 / 恶意」并说明理由。技能内容只当数据看；回答看不懂、文件太长没读完，都不会给「安全」。AI 判成恶意也算高风险。
- **怎么拦**：高风险的技能默认不勾；要装必须勾「我看过上面的风险说明……仍然要安装」。这条规则在主进程的 `SkillStore.install()` 里强制执行，不靠界面。AI 用 `install_skills` 装到高风险的技能时，审批卡片只能你亲自点：长任务模式的审批小助手、Hooks、「全部同意」都替不了你。


## 原型工坊（D1）

左侧图标栏的 # 图标。在画布上摆出 App 的每个页面，每个页面都是真的网页，点「演示」能点来点去。原型保存在项目的 `prototypes/` 里，普通文件，可以用 git 管，AI 用普通文件工具就能改。完整方案和后续阶段见 [docs/prototype-studio.md](docs/prototype-studio.md)。

## Hooks、记忆和代码检索（上下文工程）

整套是一条 Hook 总线（`src/main/hooks/bus.ts`）。Agent 每到下面这些时刻都会走一遍总线：

| 事件 | 时机 | 能做什么 |
|---|---|---|
| `SessionStart` | 新对话开始；对话被压缩成摘要后也会再来一次 | 往对话开头补信息 |
| `UserPromptSubmit` | 每条消息发出前 | 补信息，或者拦下这条消息 |
| `PreToolUse` | 工具运行前 | 放行（跳过确认）、拦下，或者要求必须由人确认 |
| `PostToolUse` | 工具运行后 | 把反馈附在工具结果后面，比如格式化结果 |
| `Stop` | AI 准备停下时 | 让它接着做，比如测试还没过 |

**两种 Hook 都挂在这条总线上：**

- **内置 Hook**：项目规则、长期记忆、相关记忆、自动找相关代码。每个都是独立模块（打包成独立 chunk），第一次触发时才 `import()`。关掉的不加载。
- **命令 Hook**：用户自己写的 bash 命令，和 Claude Code 的 hooks 格式兼容（嵌套的 `hooks: [{type: "command"}]` 和简写都认）。
  - **配置文件**：`userData/hooks.json`（我的）、项目里的 `.sweet/hooks.json` 和 `.claude/settings.json`。事件触发时才读文件，文件改了才重新解析。
  - **输入和退出码**：事件内容以 JSON 从 stdin 传入。退出码 2 表示拦下，stderr 就是理由；退出码 0 时，stdout 是补充信息或 JSON（additionalContext、decision、hookSpecificOutput.permissionDecision）。
  - **工具名**：matcher 既认本地工具名，也认 Claude Code 的名字（Bash、Edit、Write）。
  - **项目 Hook 要信任**：项目里的 Hook 文件跟着项目一起下载下来，必须在插件中心点「信任并启用」才会运行。信任绑定的是文件内容的哈希，改动后要重新信任。推送和发布命令不能被 Hook 放行。

**长期记忆**（`src/main/memory/`）：

- **存放**：全局记忆和每个项目各一个 JSON。
- **工具**：AI 用 `remember`、`recall`、`forget` 管理记忆。相似度高的新记忆会替换旧的，不会重复堆积。
- **怎么带进对话**：新对话按预算带上最常用、最新的记忆，其余的发消息时按相关度召回。同一段对话里不会重复带同一条。
- **在聊天里**：记住的内容会显示一行，旁边有「忘掉」按钮。

**代码检索 RAG**（`src/main/rag/`）：

- **建立和更新**：第一次检索时才建立索引，之后每次检索前按文件大小和修改时间增量更新。本仓库 91 个文件建索引约 50ms，没有改动时重扫约 2ms。
- **切块和排序**：按顶层代码块切块，用 BM25 排序。分词能拆开驼峰和下划线命名，中文按二元组。
- **语义检索（可选）**：配置向量模型（OpenAI、通义、智谱、Gemini、Ollama 等）后，在后台向量化，和关键词检索做 RRF 融合。向量按内容哈希缓存在磁盘上，没改的代码不会重复计费。
- **不会被索引的文件**：.env、密钥、lock 文件和压缩过的文件。
- **自动附代码**：用「覆盖度」判断要不要给消息附代码，也就是代码段解释了这条消息多大比例的关键词。阈值不随项目大小变，闲聊不附代码。

**压缩后恢复**：对话被压缩成摘要后，下一条消息会重新带上项目概况、规则、记忆和当前计划。

设置入口：左侧「记忆与代码索引」（大脑图标）；插件中心的 Hooks 页。

## 新项目、新功能：先调研，再提问，再动手

新建项目、或者加一个不小的新功能时，AI 不会马上写代码，而是按顺序来（写在系统提示词里，`src/main/agent/context.ts`）：

1. **看现状**：项目已经用了什么技术，能沿用就沿用。
2. **调研**：有几种都说得过去的做法时，用 `lookup_packages`（`src/main/tools/research-tools.ts`）查 npm / PyPI 上候选库的最新版本、最近一次发布时间、每周下载量、许可证、有没有被废弃，也能按关键词在 npm 上搜候选。只读，不用审批。
3. **提问**：用 `ask_user`（`src/main/tools/ask-tools.ts`）在聊天里弹一张问题卡（`components/QuestionCard.tsx`），一次最多 4 个问题：做给谁用、要哪些功能、技术选哪个。每个选项写清好处和代价，AI 推荐的排第一、标「推荐」、默认选中；可以多选、可以自己写；懒得选就点「都按推荐来」。
4. **列计划再做**：回答以后 AI 用计划清单列出步骤，然后开工。

问题卡由用户本人回答：长任务模式下审批小助手也不会替你答，窗口不在前台时会发系统通知。用户已经说清楚的、项目已经决定了的不会再问；改 bug、改文案这种小事直接做。

## 决策模型（Jev，J1）

AI 要对很多条内容做同一种判断时（工单分到哪个团队、邮件要不要回、反馈影响多大），用 `decide` 工具交给 TypeSafe Jev 批量判断。Jev 不写文字，只返回结构化的结论和概率，一条大约 0.1–0.4 秒。设计和接口实测记录见 [docs/jev-decision-layer.md](docs/jev-decision-layer.md)。

- **设置**：设置 → 决策模型，选 `bocha-jev-v1`（博查，限时免费）或 `ateve-jev-v1`，填 TokenDance 的 Key（加密保存，也可以用环境变量 `TOKENDANCE_API_KEY`），点「测试」用一次真实调用验证。有 Key 之后，新对话里 AI 才会有 `decide` 工具。
- **三种问题**：`noul` 是 / 否的概率；`choice` 从命名的选项里选一个（2–255 个）；`score` 按从低到高的等级打分（2–10 级）。一次调用最多 50 条、32 个问题，共同的背景放 `background`。
- **自动拆请求**：服务按「展开后」的 token 计上限（32K）：choice 和 score 的每个选项都会把内容重复算一遍。客户端先估算，放不下就把问题分到几次请求里；服务端仍然说超了，就继续对半拆。单个问题都放不下时，直接告诉 AI 把内容缩短或切开。
- **并发和重试**：全 app 共用一个客户端，同时最多 8 个请求（服务端每个用户上限 10）。429 随机等一会儿再重试；同样的输入结果完全一样，所以有缓存。
- **拿不准的会标出来**：noul 的概率在 10%–90% 之间、choice 前两名差不到 30% 或选了「都不合适」、score 的置信度低于 60% 或在两个等级之间犹豫，都会标「拿不准」，让 AI 自己看原文或交给你。
- **数据出门要你同意**：每个项目第一次用时，弹一张确认卡，说明内容会发给 TokenDance。这张卡只能你自己点，长任务模式的审批小助手、Hooks、「全部同意」都不能代你点。

## 改动对比（diff）

AI 每次改文件都会出一张改动卡片（`components/ApprovalCard.tsx` + `components/DiffView.tsx`，算法在 `src/shared/diff.ts`）。

- **卡片头**：文件图标、目录（暗）+ 文件名（亮）、「新建」标记、`+6 −6` 和 GitHub 那样的 5 格增删比例条、状态（同意后变成「✓ 已应用」）。下面是 AI 用大白话写的这次改了什么。
- **逐词高亮**：改了一部分的行，除了整行淡淡的底色，真正改动的字词再深一层标出来（`qty` → `quantity`）。按词切分，中文按字；整行几乎重写时不标，免得一片花。
- **只改缩进的行**：灰掉，只显示新的那一行，工具栏会写「N 行只改了缩进或空格」。
- **配色**：左边 2px 色条加很淡的底色，代码保留语法高亮，删掉的行稍微变暗。行号只留一列。长行自动换行（聊天栏窄，不用左右滚）。
- **折叠**：改动前后各留 3 行，中间没改的折成一行「展开中间 N 行没改动的代码」，点一下展开；不到 4 行的直接显示，超过 100 行的只显示行数。
- **左右对比**：工具栏的「左右对比」打开大窗口，用 Monaco 的对比编辑器左右（或上下）看整个文件，没改的大段自动收起。完整内容只在当前会话里有，重新打开的旧对话只保留片段。
- **动效**：卡片出现时轻微上浮淡入，同意后代码区收起（0.18 秒），展开折叠时淡入；系统开了「减少动态效果」时全部关掉。

## 回答的 Markdown 渲染

AI 的回答按 GitHub 风格的 Markdown 渲染（`components/Markdown.tsx`，react-markdown + remark-gfm + remark-breaks），边输出边渲染。

- **支持**：各级标题、加粗 / 斜体 / 删除线、有序 / 无序 / 嵌套列表、任务列表（✓ 方框）、表格（左中右对齐，太宽可以横向滚动）、引用、分割线、链接、行内代码、带高亮的代码块。没写完的代码块在输出过程中也按代码块显示。
- **换行**：单个换行保留成换行，因为模型写中文时习惯这样分行。
- **安全**：模型写的 HTML 标签会被丢掉，不会执行。危险协议（`javascript:` 等）的链接不能点。远程图片不加载，显示成链接。
- **文件链接**：`[App.tsx:42](src/App.tsx:42)` 这类相对路径链接用粉色显示，点一下在编辑器里打开那个文件并跳到第 42 行（也认 `#L42`）。系统提示词要求 AI 提到文件时这样写。`http(s)` 链接在系统浏览器里打开。

## 语法高亮

一套高亮用在三个地方：编辑器、聊天里的代码块、审批卡片里的 diff。都用 Monaco 自带的分词器（约 80 种语言）加同一个 `sweet-dark` 配色，同样的代码在哪里看颜色都一样。代码在 `src/renderer/src/languages.ts`。

- **覆盖的语言**：HTML / CSS / JS / TS、C、C++、C#、Java、Kotlin、Go、Rust、Python、Swift、PHP、Ruby、Lua、Dart、SQL、Shell、PowerShell、YAML、JSON、Markdown、Dockerfile 等。
- **借用相近语法的格式**：Vue / Svelte / 小程序 WXML 当 HTML，WXSS 当 CSS，ArkTS（`.ets`）当 TypeScript，TOML / `.env` 当 INI，Makefile 当 Shell，Arduino（`.ino`）和 CUDA 当 C++。状态栏和代码块标题仍然显示它们自己的名字。
- **代码块标签**：聊天里的标签可以是常见写法，比如 `c++`、`py`、`h5`、`sh`、`ts`、`yml`、`c#`、`golang`。
- **diff 着色**：审批卡片的 diff 按修改前、修改后两边分别着色。
- **状态栏**：右下角显示当前文件是什么语言。
- **配色**：在 `monaco.ts` 的 `rules` 里，一条规则覆盖所有语言的同类 token（比如 `keyword` 也管 `keyword.cpp`）。

## 全部伙伴（Three.js）

打开 App 先看到选伙伴的主界面：每个模型服务商是一位 Q 版二次元伙伴，各有一张角色卡，站在柔和的「拟态」（neumorphism）舞台上围成一圈。

- 角色全部用代码生成（`src/renderer/src/home/chibi.ts`）：球体、胶囊、挤出形状拼出身体、头发和配饰；卡通渲染（3 阶 toon 渐变）加反向外壳描边；眼睛是贴在脸上的平面圆片（虹膜、瞳孔、两个高光、睫毛线）。没有模型文件和贴图需要下载。
- **立绘卡**：把 2:3 竖版插画放进 `src/renderer/src/home/art/`，文件名用服务商 id（`anthropic`、`openai`、`gemini`、`deepseek`、`qwen`、`moonshot`、`zhipu`、`doubao`、`minimax`、`openrouter`、`ollama`、`custom`），支持 webp / png / jpg，那位伙伴就会自动换成立绘卡（不用改代码）。立绘卡在正前方时会稍微放大、跟着鼠标轻轻倾斜（像收藏卡），并定期有一道光扫过。现在有 anthropic、openai、gemini、deepseek、qwen、zhipu、doubao、minimax 八张。
- 每位伙伴的人设在 `home/characters.ts`：名字、身份、台词、配色、发型（长发 / 短发 / 波波头 / 双丸子 / 蓬松）和一个标志配饰（星星发夹、耳机、鲸鱼尾发夹、月亮、眼镜、帽子、羊驼耳朵、问号）。新增服务商时在这里加一项即可。
- 动作：呼吸起伏、头部轻晃、眨眼、头发摆动；转到正前方时跳一下并挥手，之后隔几秒再打一次招呼；鼠标移上去会抬手。系统开启「减少动态效果」时关掉花瓣和视差。
- 操作：← → 键、拖动、点侧边的卡或底部圆点切换；点正前方的卡、按回车或「就选你了！」选择。
- 选择后：换了伙伴会切换服务商并开始新对话（选回当前伙伴不会打断对话）；没设置好会先打开设置，保存后自动继续去打开项目。打开项目时接上**和当前伙伴**的最近一段对话。
- 背景是新海诚风格的天空（`home/sky.ts`）：浅色模式是夏日晴空，深色模式是黄昏和星星。
  - 体积云用 ray marching 渲染：沿视线在云层里步进采样 3D 噪声（启动时生成一张 64³ 的可平铺 Perlin-Worley 噪声纹理，约 0.1 秒），每个采样点再朝太阳方向走 3 步算自阴影。明暗交界压成清晰的色带，阴影偏蓝紫、逆光边缘泛金，是动画的画法而不是写实。
  - 另外有高空卷云、地平线以下的云海、太阳光晕；云随风慢慢飘，鼠标视差也会带动天空。
  - 天空以半分辨率渲染到纹理再当背景，云本来就柔和，看不出差别。系统开启「减少动态效果」时云停住不动。
  - 天空相对舞台镜头额外上仰（`SKY_PITCH`），把地平线压到画面约三分之二处，留出大片天空。
- 标题栏「伙伴」按钮随时回到主界面。浅色 / 深色模式都有对应的拟态配色（`--neu-*` 变量），3D 场景的背景色从 CSS 变量读取，切换系统主题时同步。

## 识图

- 聊天框可以加图片：点 📎、直接粘贴截图（⌘V）、或者把图片拖进来，一次最多 6 张。发送前在界面里缩到长边 1568 像素：小图保持 PNG（文字更清楚），大图转 JPEG。
- 图片由**识图模型**先看一遍（默认 DeepSeek 的 `deepseek-flash`，用 DeepSeek 的 Key），它的文字分析放进 `<image_analysis>` 交给当前伙伴，所以不支持看图的模型也能「看」图。识图提示词要求逐字照抄图里的代码和报错、描述界面布局。
- 识图模型在设置窗口底部「🔍 识图模型」里换，任何已配置的服务商都可以（OpenAI 兼容的用 `image_url`，Claude 用图片块）。
- 识图失败时这一轮照常继续：AI 会被告知用户发了图但没看到、原因是什么，由它告诉用户。
- AI 还有 `view_image` 工具，可以看项目里的图片文件（截图、设计稿，最大 8MB）。
- 对话记录里保存的是缩略图，原图不保存。

## DeepSeek（按官方文档 api-docs.deepseek.com 对齐）

- 模型：默认 `deepseek-flash`（1M 上下文、思考模式、工具调用、识图、FIM），可选 `deepseek-v4-pro`（更强，不支持识图）。旧名字 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 官方仍可用，会路由到 flash。识图默认模型也改成 `deepseek-flash`。
- 思考模式：请求带 `thinking: {type: "enabled"}` 和顶层 `reasoning_effort`；聊天框的思考深度对 DeepSeek 也生效（随便聊聊 → low，正常 → high，认真模式 → max）。
- **`reasoning_content` 一律原样传回**：文档要求带 `tools` 的请求必须传回所有历史 `reasoning_content`（包括没有调用工具的那几轮），否则 400。之前只在调用工具的回合传回，已修复。
- 长对话：DeepSeek 上下文 1M、缓存命中价格只有未命中的 1/50，所以 30 万 tokens 才开始整理（其他兼容服务商仍是 5.6 万）。
- 缓存统计兼容 `prompt_cache_hit_tokens`（顶层或 `prompt_tokens_details` 里）。
- 错误提示：402 余额不足、422 参数错误、503 服务器繁忙、`finish_reason: insufficient_system_resource`（这一轮回滚，可以重试）。排队时的 `: keep-alive` 注释不影响解析。
- 余额：设置里选中 DeepSeek 时显示 `GET /user/balance` 的余额（含赠送部分）。
- 费用：用 DeepSeek 时状态栏显示这段对话的大约花费（¥），按官方价格表，工作日 9–12 点、14–18 点（北京时间）按高峰价翻倍计。
- `user_id`：发送一个匿名、固定的安装 ID，用于官方的缓存和限流隔离。
- **AI 代码补全**（设置里「✨ AI 代码补全」打开）：编辑器里打字停顿时，把光标前后的代码发给 DeepSeek 的 FIM 接口（`/beta` + `completions`，`deepseek-flash`），灰色建议按 Tab 接受。新请求会取消上一个，最多 128 tokens，在空行处停。
- 没有接入的：JSON Output、对话前缀续写、Files API、Responses API、Anthropic 兼容接口——这个 App 用不上它们。

## 插件：技能（Skills）和 MCP

标题栏「插件」打开插件中心。装好的插件在**新对话**里生效：一段对话的工具列表从开始到结束不变（中途改工具会让 Claude 的缓存和思考块失效），保存的对话重开时也沿用它开始时的工具列表。

**技能**（`src/main/plugins/skills.ts`）
- **内置技能**（`src/main/plugins/builtin-skills/`）：一套配合使用的高效开发技能，构建时打包进主进程，启动时自动装进 `userData/skills/`，插件中心里标「内置」。
  - `dev-workflow` 总入口，按任务大小决定用哪些：`plan-first` 先规划 → `task-board` 拆任务写进 `TASKS.md` → `test-first` 先写测试 → `debug-systematically` 系统化调试 → `verify-before-done` 跑检查再说完成 → `self-review` 自查 diff → `git-checkpoint` 小步存档。
  - 用户删掉的不会再自动装回（插件中心「恢复内置技能」可以装回）；用户改过的不会被新版本覆盖；用户自己装的同名技能不会被动。`userData/skills/.builtin.json` 记着每个内置技能上次装的内容哈希。
  - 新增内置技能：在 `builtin-skills/` 下建一个文件夹放 `SKILL.md`（和参考文件），不用改代码。
- 安装在 `userData/skills/<名字>/`，统一是标准 Agent Skill 格式：`SKILL.md`（frontmatter 里有 `name`、`description`）加参考文件、脚本。
- 来源：GitHub 仓库 / 文件夹（`/tree/...`）/ 单个文件（`/blob/...`）链接、任意 .md / .zip 网址、本地文件 / 压缩包 / 文件夹、粘贴文本。下载走 Electron 的网络栈，跟随系统代理。
- 标准技能：找出所有带 `SKILL.md` 的文件夹（嵌套技能的文件不会混进父技能），名字不合规会自动修正并提示。
- 非标准技能自动转换成标准格式：Cursor 规则（`.mdc`、`.cursorrules`，globs 写进描述）、Claude Code 命令和子代理、Copilot 提示词、Windsurf 规则、AGENTS.md / CLAUDE.md / GEMINI.md、单个 Markdown 或粘贴的文本。
- 安装前先预览：名字、描述、文件、是否含脚本、是否会覆盖已装的。压缩包里试图跳出目录的路径会被丢掉；有大小和数量上限。
- AI 怎么用：已启用技能的名字和描述写在每段对话的第一条消息里；任务相关时 AI 调 `use_skill` 读完整说明，用 `read_skill_file` 读参考文件。技能里的脚本不会自动运行，AI 要跑时照样走 `run_command` 的确认。

**MCP**（`src/main/plugins/mcp.ts`）
- 粘贴 JSON 配置即可添加：`{"mcpServers": …}`（Claude Desktop / Cursor / Windsurf）、`{"servers": …}`（VS Code，允许注释和尾逗号）、裸的服务器表，或单个服务器对象。
- 本地命令（stdio）和远程服务（Streamable HTTP，失败时退回 SSE）。env 和 headers 里的值（密钥、token）用系统钥匙串加密，单独存在 `mcp-secrets.bin`，`mcp.json` 里没有明文。
- App 启动时在后台连接已启用的服务；连接失败会显示原因（找不到 npx / uvx 时提示安装 Node.js / uv，并附上服务器 stderr 的最后几行）。
- 每个工具变成 AI 的一个工具，名字 `mcp__<服务器>__<工具>`。默认每次调用都弹出卡片（显示参数），「本次对话都同意」对它有效；把服务器设为「信任」后直接运行。
- 工具结果里的文字原样给 AI，图片、音频只标注类型，资源给出文字或链接；服务器报错时作为工具错误返回。

## 长任务模式 + 审批小助手

给不想一步步点「同意」的人：聊天框里点亮「长任务」，把整件事交给 AI，做完会弹系统通知。

- **一口气做完**：这条消息带上 `<autopilot>` 说明（放在用户消息里，不动系统提示词，开关不影响缓存），步数上限从 40 提到 200。AI 先用 `update_plan` 列计划，聊天里显示成带进度条的清单；如果它停下时计划里还有没做完的步骤，会被自动叫回去接着做（最多 2 次），做不了的要标成「跳过」并在总结里说明。
- **审批小助手（子 agent）**：AI 想改文件、跑命令、调插件时，先交给另一个模型审批（`src/main/agent/reviewer.ts`）。它能看到用户的任务、计划、之前做过的操作和这一步的 diff / 命令，回答三种结果：
  - 同意：直接执行，卡片上显示理由。
  - 不同意：理由作为反馈交给 AI，让它换个做法。
  - 拿不准：卡片照常等用户点；窗口不在前台时弹系统通知。
- **始终留给人的**：`git push`、`npm publish`、部署这类会让别人看到、撤不回的命令不经过小助手，直接问用户。原来的命令黑名单照样生效。小助手出错（断网、没 Key）或回答看不懂时，也交给用户。改的文件照样可以「撤销这一轮」。
- **用哪个模型**：设置 →「审批小助手」，默认和聊天用同一个模型；可以换成便宜又快的（比如 DeepSeek，会关掉思考以加快速度）。
- **失败经验**（`src/main/agent/lessons.ts`）：长任务做完、或者步数用完时，如果中途出过错（命令失败、工具报错、审批小助手或用户拒绝、Hook 要求继续、计划没做完），会复盘一次，把能避免重犯的事记成最多 3 条「经验」，存进这个项目的长期记忆（需要开着「长期记忆」）。以后在同一个项目里开新对话，经验排在记忆的最前面带给 AI；相似的经验会替换旧的。

## 接下来

- 打包成安装包（macOS / Windows），node-pty 放进 asar unpack
- 在 Windows 真机上测试 Git Bash 终端和命令

## 备注

- Electron 固定为 44.4.5，因为本机缓存里已经有这个版本。直接下载最新版的速度很慢。
- `package.json` 的 `allowScripts` 允许了 esbuild 和 node-pty 的安装脚本。node-pty 自带 macOS 和 Windows 的预编译文件，不需要编译。
- node-pty 的 macOS `spawn-helper` 安装后没有可执行权限，会导致终端打不开（`posix_spawnp failed`）。`postinstall` 里的 `scripts/fix-node-pty.mjs` 会补上。
- 以后打包成安装包时，node-pty 是原生模块，要放进 asar 的 unpack 列表。

## 自动化任务（状态机 + 定时）

左侧栏的时钟按钮。一个自动化任务 = 几个步骤组成的状态机 + 一个时间表，代码在 `src/main/automation/`。

- **步骤**：「交给 AI」发一条消息给 Agent；「运行命令」直接跑一条 bash 命令，不经过 AI（成功 = 退出码 0）。
- **转移**：每一步结束时有一个结果：`ok`（成功）、`fail`（失败），AI 步骤还能加自定义结果（比如「有问题」）。AI 用 `report_outcome` 工具报告结果；没报告的话，正常答完算成功，出错、步数用完、超时算失败。每个结果指向下一步或「结束」；没指定的结果直接结束。最后停在 `fail` 上的运行算「没成功」。
- **上下文**：一次运行里的 AI 步骤共用一段对话（会和其他对话一起保存，可以「在对话里查看」）；上一步的结果和命令输出末尾会附在下一条 AI 消息里。
- **时间表**：手动、每隔 N 分钟（至少 5）、每天 / 每周几的某个时间、某个时间运行一次。每 20 秒检查一次，电脑睡醒后马上检查。
- **无人值守**：AI 步骤用懒人模式（推送、发布、危险命令会被拦下，提问按推荐选项走）；单个 AI 步骤最长 30 分钟，命令 10 分钟，一次运行最多走 30 步，防止两个步骤互相来回跳。
- **限制**：自动化跟着项目保存（`userData/automations/<项目路径哈希>/`），只在这个项目打开时运行；同一时间只跑一个；对话里的 AI 在工作时，到点的任务会等它停下。超过 1 小时没赶上（App 没开、电脑睡眠、开的是别的项目）记为「错过了」，不补跑。切换项目会停下正在运行的任务。
