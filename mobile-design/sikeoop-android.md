# sikeoop 安卓版（设计稿）

> 状态：设计稿，还没开工。日期：2026-10-09。
> 文中的路径默认相对于 `sweet-code-desktop/`。

## 1. 要解决什么

**用户要的三件事**
- 让懒人模式在手机上看得见、用得上。
- 用手机遥控电脑上的 sikeoop。
- 直接在手机上编程。
- 要求高效、实用。

**现在的短板**
- 微信远程（`src/main/remote/wechat.ts`）的局限：
  - 只能收发文字，只回最后一段话；
  - 看不到她做到哪一步，也看不到改了哪些文件；
  - /y /n 只能批最早的那一条。
- 懒人模式只在电脑上起作用。人一离开电脑，进度、回执、撤销都够不着。
- 内核还和 Electron 绑在一起。TUI 设计稿（`cli-design/sikeoop-tui.md`）提的拆分还没做，所以手机上跑不了。

**目标**：把鲸鱼娘装进口袋。
- 说一句话就能派活；
- 随时看得到她在干什么；
- 需要你时，在通知栏点一下就能做决定；
- 做完收到一份说人话的回执。

**同类产品**
- Codex 手机端和 Claude Code Remote Control 都用同一套做法：电脑主动连出去、经中继转发、扫码配对、端到端加密。我们也用这套做法。
- Claude Code Remote Control 只支持订阅账号登录，用 API Key 或国产模型的人用不了。
- 我们的不同之处：
  - 能用国产模型；
  - 有微信兜底；
  - 沿用懒人模式的拦截规则；
  - 能在手机本机编程。

## 2. 已经定下的选择

| 事项 | 结论 | 来源 |
|---|---|---|
| App 用什么写 | 原生 Kotlin + Jetpack Compose | 用户定 |
| 本机编程 | 分两档：先做免安装的轻量档（App 自带 Node），之后接 Termux 做完整档 | 用户定 |
| 怎么联网 | 官方中继（Cloudflare，端到端加密）+ 局域网直连 | 用户定 |
| 推送、发布这类撤不回的操作 | 手机遥控时在手机上一键确认。「全部同意」不能代替这一步，超时就按拒绝处理 | 用户定 |
| 先做中继还是局域网 | 先做中继。电脑只需要主动连出去，在家和在外用法一样，也不用开防火墙。另外，App 的目标系统版本升到 Android 17 后，访问局域网还要用户单独授权 | 建议 |
| 怎么发布 | 第一版放在官网直接下载 APK，不上 Google Play | 建议 |
| 命名 | 新功能统一叫 mobile / 手机。`android:*` 通道、`src/main/android/` 和 `AndroidPanel.tsx` 已经用来在电脑上管理模拟器了 | 侦察发现 |

## 3. 总体架构：一个内核，一套协议，三种连法

```
┌──────────── 安卓 App（Kotlin + Compose）────────────┐
│ ui/   首页「本鲸」· 对话 · 审批/提问 · 改动 · 设置   │
│ link/ 界面和内核层之间的接口（状态流 + 动作）        │
│ core/ JSON-RPC · 加密 · 前台服务 · 通知 · 扫码        │
└───┬──────────────────┬────────────────────┬─────────┘
    │① 中继/局域网       │② Unix socket        │③ 127.0.0.1 + 配对加密
┌───▼──────────────┐ ┌─▼────────────────┐ ┌─▼──────────────────┐
│ 电脑：桌面版      │ │ 手机：App 内置    │ │ 手机：Termux 里的   │
│ 手机网关 → 主会话 │ │ Node + core.cjs   │ │ sikeoop-core        │
└──────────────────┘ │（轻量档）         │ │（完整档）           │
  ▲ Cloudflare 中继   └──────────────────┘ └────────────────────┘
    （只转发密文）
```

- 安卓 App 始终只当客户端，三种连法用的是同一套 JSON-RPC 协议，方法表和 TUI 设计稿 §4 一致。
- 好处：
  - 界面只写一套；
  - 内核只有一份，所以三种连法下人格、记忆、懒人规则完全一样；
  - 以后的 TUI、安卓、鸿蒙都能用这套协议。

## 4. 懒人模式在手机上长什么样

一次完整的任务要走完四步：派活 → 看得到进度 → 做决定 → 收回执。少了哪一步都不行。

### 首页「本鲸」
- **大头像**：鲸鱼娘有 5 种状态：空闲、干活、等你、做完、出错。头像跟着内核发来的 `status` 通知切换。素材情况见下面的「鲸鱼娘素材」。
- **状态行**：比如「在跑测试 · 第 3/7 步」，旁边显示电脑在不在线、当前是哪个项目。
- **输入**：一个输入框，说一句话就行，用输入法自带的语音也可以。
- **快捷指令**：4 个，分别是继续、停下、跑测试修一下、总结改了啥。
- **回执**：最近一张回执卡。

### 鲸鱼娘素材（`whale-girl-svg/`，五种状态都齐了）

| 状态 | 用哪套 |
|---|---|
| 空闲 | `sleepy.svg`：点头打盹，Z 字往上飘 |
| 干活 | `work.svg`：敲键盘、眨眼、发丝轻轻摆 |
| 等你 | `waiting.svg`：看手机，气泡里写着「等你」，轻轻点头 |
| 做完 | `lazy.svg`：懒洋洋地晃，摸鱼玩泡泡 |
| 出错（包括被拒答） | `error.svg`：惊讶的表情、红色警示、慌张地抖 |
| 没做完（步数用完、已停下） | `sleepy.svg`，旁边加「继续」按钮。「已停下」是你自己点的，不算出错 |
| 电脑不在线 | `sleepy.svg` 变灰 |

**安卓上怎么播**
- 五个文件都是 480×480 的透明 SVG。
- 动画写在 SVG 里的 CSS 中：sleepy、work、lazy 各有 9 段 `@keyframes`，waiting、error 各有 13 段。
- 每个文件都带阴影滤镜 `feDropShadow`。
- 带 `<text>` 的文件显示效果要看字体：sleepy（Z z z）、waiting（等你）、lazy（PAUSED）、error（! 和 ERROR）。
- 安卓原生的 VectorDrawable 不支持这种 CSS 动画。可选的做法：
  - 首页大头像用透明 WebView 原样播放；
  - 转成 Lottie；
  - 用静止画面，再用 Compose 加呼吸、晃动的小动画。
- P1 先导出静止画面（各屏幕密度的 PNG/WebP），动画版放到 P3。具体用哪种方法由 architect 定。
- 五个文件用了同一组 id（hair、skin、shadow 等 10 个），动画名也一样：
  - 每个头像单独加载一个文件，没问题；
  - **不要把几个 SVG 内联进同一个页面**，否则会互相覆盖。非要内联，先给 id 加前缀。

**小问题和还缺的**
- `lazy.svg` 的笔记本屏幕上写着 `PAUSED`，拿来表示「做完」意思不对，建议改成 `DONE`。不急：字号只有 8，缩小后基本看不清。
- 通知栏的小图标只能用单色剪影，还要再出一张单色的鲸鱼头。

### 不打开 App 也知道她在干嘛
- **任务进行中**：常驻一条通知，显示一行进度，带【停下】按钮。
- **需要你的时候**：以下情况发高优先级通知，带【同意】【拒绝】。
  - 审批；
  - 提问；
  - 终端里的 Claude Code / Codex 要权限。
- **撤不回的操作**：要先解锁才能点同意（`setAuthenticationRequired`）。锁屏上只显示「本鲸需要你拍板」，不显示命令、代码和文件名。
- **做完了**：发一条回执通知，比如「做完了：改了 3 个文件，测试过了」，带【看改动】【撤销】。
- **语气**：通知和锁屏上只写一句事实，不用嘴毒的语气。嘴毒只出现在 App 里鲸鱼娘的对话气泡中。
- **放到 P3 的**：
  - 桌面小组件（Glance）、快捷设置磁贴；
  - 从别的 App 分享过来直接派活、按住说话；
  - Android 16 的实时通知（Live Updates）；
  - 小米超级岛等厂商的类似功能，先调研再定。

### 其他页面
- **首次打开**：欢迎 → 扫码配对 → 保活引导 → 首页。保活引导检查三项：允许通知、电池不限制、允许后台自启动。
- **底部四个标签**：首页、待办（审批和回执）、项目（本机编程，过了技术验证才显示）、我的。
- **线框**：所有页面的低保真线框见同一目录下的 `sikeoop-android-wireframes.md`。
- **对话页**：照搬桌面版 ChatPanel 的行为，只是改成适合手指点的尺寸。
  - 流式显示 Markdown 回复；
  - 工具调用收成一行「做了 N 件事」，思考过程默认收起；
  - 显示计划进度和撤销条；
  - 审批卡：同意 / 本次都同意 / 拒绝并附意见；
  - 提问卡：带「都按推荐来」。
- **改动页**：这一轮改了哪些文件，每个文件一份统一格式的 diff。
- **电脑上的 AI 们**：终端里 Claude Code / Codex 的状态，以及它们的权限请求。

### 模式
- **默认懒人模式**：危险操作照旧自动拦下；推送、发布改成在手机上确认。
- **长任务模式**：审批小助手把关，它拿不准的推到手机。
- **Agent 模式**：也可以切过去用。
- MVP 要不要提供模式开关还没定，见 §15 第 4 条。

## 5. A 线：遥控电脑

### 5.1 配对
1. **电脑出码**：在电脑上的「手机」页点「添加手机」，弹出二维码。
   - 二维码只能用一次，5 分钟后失效。
   - 里面有：中继地址、电脑 ID、电脑公钥、一次性配对密钥、电脑名字。
2. **手机扫码**：用 ZXing 扫，不依赖谷歌服务。
   - 扫完生成设备密钥，私钥用 Android Keystore 里的密钥加密后保存。
   - 然后经中继和电脑握手。
3. **电脑确认**：电脑弹窗问「允许『小米 14』遥控这台电脑吗？」。
   - 允许后，这台手机记进设备列表，以后自动重连。
   - 电脑上可以随时移除设备，移除后手机立刻断开。

### 5.2 加密和中继

**端到端加密**
- 算法：P-256 ECDH + HKDF-SHA256 + AES-256-GCM。
- 握手参照 Noise IK：双方各用一把长期密钥和一把临时密钥。
- 每一帧带计数器，防止被重放。
- Node 和 Android 都有现成的实现，不用引第三方加密库。
- 具体握手步骤由 architect 在 P0 定下来，同时给出两端都要通过的测试向量。

**中继**
- 用 Cloudflare Worker + Durable Object 搭，WebSocket 空闲时休眠。每台电脑对应一个房间。
- 只转发密文：不存内容，日志里也不记载荷。
- 进房间要凭房间令牌，有限流，单帧最大 1MB。
- 电脑掉线时，中继会告诉手机「电脑不在线」。
- 房间逻辑写成一小段不依赖平台的代码，另配一个 Node 版：
  - 本地开发时用它；
  - 以后要搬到国内服务器自己部署，也直接用它。
- 用 cf CLI 部署（`cloudflare.config.ts` + `cf deploy`）。**部署前先问用户。**

**电脑这边**：只主动往外连，不监听任何端口，也不加新依赖（用 Electron 44 自带的 Node 里的全局 WebSocket）。

**局域网直连（P3）**
- 手机和电脑在同一个 Wi-Fi 下时自动直连，加密方式和中继一样。
- 要在电脑上手动打开。
- 目标版本升到 Android 17 后要申请局域网权限，用户不给就继续走中继。

### 5.3 电脑上的「手机网关」（`src/main/mobile/`、`src/main/core/api.ts`）

**事件广播**：`emit` 里的 `remoteTap`（index.ts:577）现在只能挂一个监听者，要改成能挂多个。微信和手机网关各挂一个。

**中途接入**：手机连上时，用 `session.snapshot` 拿到三样东西：
- 已经完成的对话：先给最近 50 条，可以往前翻；
- 当前这一轮已经发生的事件，重放一遍；
- 还在等人处理的审批和提问。

为此要给 AgentSession 加一个只读的 getter。对话记录和待处理列表目前都是私有字段（loop.ts:198、:234-235）。

**消息来源**
- 在电脑上打字发出的消息，也要补发一条事件，不然手机看不到。
- `remote_message.from` 现在只能是 "wechat"（types.ts:630），要扩展成 "desktop" | "wechat" | "mobile"。来自手机的消息带上设备名。
- 桌面聊天里显示成「📱 小米 14：…」。

**主会话在忙时**：手机派来的任务直接返回 BUSY，并说明在忙什么。现在的 `chat:send` 会把这个错误吞掉（index.ts:1031），网关不能这样。

**撤不回的操作在手机上确认**
- ChatRequest 加一个 `origin` 字段，标明「来自手机」和设备 ID。
- 现在懒人模式会直接拒绝 humanOnly 操作（推送、发布、部署，loop.ts:1098-1103）。改成：如果任务来自手机、而且手机在线，就发出 `approval_request {humanOnly:true}` 等人确认。
  - 手机和电脑都能回应；
  - 10 分钟没人回就按拒绝处理。
- LAZY_STOP 里的硬拦截照旧直接拒绝，比如 sudo、删项目外的文件、改系统设置。
- 微信远程不变。

**任务被打断**：在电脑上切项目、换服务商、删会话都会调 `reset()`，把正在跑的远程任务取消掉（loop.ts:352）。这时手机收到的回执里要写明「被电脑那边打断了」。

**手机不在线时**
- 手机派的任务做完了，如果手机正好不在线、微信远程又开着，回执就改发到微信。
- Claude Code 的权限请求照旧也发到微信。

**手机能做什么**
- P1 能做：
  - 派活、停下；
  - 审批、回答提问；
  - 撤销本轮、看 diff；
  - 看终端里的 AI，批准它们的权限请求。
- 不能做：
  - 改模型和 Key；
  - 装插件、MCP、Mod；
  - 往终端里打字；
  - 读项目以外的文件；
  - 打开「最近打开」以外的文件夹。

**审计**：按设备记录每次操作，写进 `userData/mobile/audit.log`。写之前先用 `memory/redact.ts` 去掉敏感信息。

## 6. B 线：在手机本机编程

### 6.1 轻量档（不用另装东西）

**运行时**：App 里自带 Node（nodejs-mobile）。

**先过一道技术验证**，约 2 天。可以和 P1 同时做，放在独立目录里，不碰主线文件。
- 现状：
  - 官方 nodejs-mobile 最新只到 Node 18.20.4，而 Node 18 已经停止维护。
  - 社区分支（digidem）说支持到 Node 24，也支持 16KB 内存页，但几乎没人用，必须自己试。
- 通过标准：
  - 在 base_arm64 模拟器和一台真机上，用这个分支的 libnode.so 跑起打包好的 core.cjs；
  - 完成一轮「读文件 → 改文件 → 撤销」，中间真的调一次模型；
  - 冷启动不超过 3 秒；
  - 记下 APK 因此大了多少。
- 不通过：轻量档改成 App 只管界面、内核放到 Termux 完整档里跑。先报告，再一起决定。

**把内核拆出来**：和 TUI 设计稿的 P1 合成一项工作，交给 Codex。
- 新增 `src/main/core/platform.ts`，提供数据目录、密钥，以及能力说明：有没有 shell、浏览器、终端里的 AI。
- `agent/session-store.ts` 和 `providers/store.ts` 改成通过 Platform 拿路径和 Key，不再直接 import electron。
- 处理只有 Vite 认得的 import：plugins/builtin.ts:7、background.ts:4、prototypes/protocol.ts:5。
- 新增 `scripts/build-core.mjs`，打包出一个单文件的 core.cjs。只给电脑用的模块不打进去，包括终端、浏览器、灵动岛、语音、微信、终端 AI 总线。
- `src/main/core/api.ts` 在 P1 已经给手机网关用上了，这里直接拿来用。

**能力协商**
- 手机上没有 shell，所以不注册 run_command，也不跑要执行命令的 hook。
- 在 context.ts:91-98 加一个分支，告诉模型「这是手机，没有命令行」。

**新工具 `preview_page`**：内核反过来请求 App，在 WebView 里打开项目页面，把控制台报错和截图交回给模型，让她自己看效果。

**项目**
- 放在 App 的私有目录里。
- 有几个模板：空白网页、计时器、小游戏。
- 可以用 zip 导入导出：导入走系统文件选择器，导出走系统分享。
- git 同步（isomorphic-git）和「发到电脑」以后再做。

**模型 Key**
- 在手机上填，用 Keystore 加密保存。
- 也可以选「从电脑导入模型配置」：走端到端加密通道，手机和电脑两边都要确认。

**内核和 App 怎么通信**：用 App 私有目录里的 Unix socket，每行一条 JSON-RPC，格式和 TUI 的 stdio 一样。别的 App 连不上。

### 6.2 完整档（Termux）
- 用户先从 F-Droid 或 GitHub 装好 Termux。App 给出一行命令，复制到 Termux 里运行，就装好了 Node 和 sikeoop-core。这个包和 TUI 独立模式用的是同一个，下载时校验 SHA256。
- core 在 Termux 里监听 127.0.0.1。手机上的其他 App 也能连本机端口，所以配对和加密照样要做，跟遥控电脑一样。
- 用起来和遥控电脑一样，bash、git、node、python 都能跑，项目放在 Termux 的主目录里。
- **不做**：让 App 自己下载 shell 或系统镜像。Google Play 的政策不允许，Android 10 起的 W^X 限制（App 不能执行自己能写的目录里的文件）也不允许。

## 7. 协议 v1（P0 定稿，唯一来源是 `src/shared/protocol.ts`）

方法基本照搬 TUI 设计稿 §4。手机要用的是下面这些：

| 方法 | 用途 | 接到哪个现成函数 |
|---|---|---|
| `initialize` | 协议版本、设备信息、能力协商 | 新增 |
| `session.snapshot` | 当前对话 + 本轮重放 + 待处理事项 | AgentSession 新加的只读 getter |
| `chat.send {text, mode, images?}` | 派活，默认懒人模式 | `AgentSession.send`（loop.ts:417） |
| `chat.cancel` | 停下 | `cancel`（loop.ts:346） |
| `approval.respond` | 审批，也用来确认撤不回的操作 | `respondApproval`（loop.ts:390） |
| `question.answer` | 回答提问 | `answerQuestion`（loop.ts:382） |
| `turn.undo` / `diff.get` | 撤销本轮 / 看完整 diff | `undoTurn`（loop.ts:400）/ `diffSource`（loop.ts:378） |
| `agents.list` / `agents.respond` | 终端 AI 的状态和权限请求 | `PeerBus.sessionsView`（peers.ts:158）/ `answer`（peers.ts:167） |
| 内核反向调用客户端 | 本机模式下的 `preview_page`、读写 Key | 新增 |

**通知**（内核发给客户端）
- `event`：AgentEvent 原样转发。客户端遇到不认识的类型直接忽略。
- `status`：鲸鱼娘当前的状态。规则沿用灵动岛的映射（island.ts:368-454），抽成一个共享的纯函数。
- `ask`：需要人回应的请求。
- `presence`：电脑在线还是离线。
- `log`：内核的警告。

**契约样例**
- 放在 `protocol/fixtures/`，每种消息一个样例。
- 样例用 TS 类型写，typecheck 能保证它和类型对得上，再导出成 JSON。
- 电脑端和 Kotlin 端的测试都读这些样例。
- Kotlin 端用 kotlinx.serialization 手写模型，不靠代码生成。

## 8. 安全（每个阶段都交给 security-qa 查）

**连接**
1. 默认关闭。没打开「手机遥控」就不连中继。
2. 只认配对过的设备：
   - 二维码只能用一次，5 分钟后失效；
   - 新设备要在电脑上点「允许」才能连。
3. 端到端加密，中继只看得到密文。
4. 设备一移除就立刻断开。App 锁（指纹、面容）放到 P3。

**权限**
1. 手机只能调用白名单里的方法（见 5.3）。电脑端用 zod 检查协议参数，做法和检查工具参数一样。
2. 撤不回的操作只能一条一条确认，「全部同意」管不到它们。硬拦截清单不变。

**数据**
1. Key 不离开电脑。唯一的例外是用户主动「导入模型配置」，而且手机和电脑两边都确认了。
2. 手机上的 Key 用 Keystore 加密，不写进日志，也不进备份（`allowBackup=false`）。
3. 锁屏通知里不显示命令、代码和文件名；确认撤不回的操作前要先解锁。
4. 审计日志先去掉敏感信息再写。
5. 完整档在 127.0.0.1 上开的端口，同样要先配对、再加密通信。

**顺带交给 security-qa 的老问题**：`list_files` 和 `search` 返回的结果没有逐个经过 resolveSafe 检查（fs-tools.ts:44-49、:137）。

## 9. 明确不做

- 远程桌面画面
- 在手机上直接往终端里打字
- iOS 版
- 多人协作
- 让 App 自己下载 shell 或系统镜像
- 在手机上跑本地大模型
- 营销推送
- 在锁屏上显示命令或代码

## 10. 分阶段计划

| 阶段 | 内容 | 谁来做 | 完成标准 |
|---|---|---|---|
| **P0 先定接口** | 见下方说明 | architect 定稿，指挥官落地 | typecheck 不新增错误；`./gradlew assembleDebug` 通过；电脑端和 Kotlin 端都能解析全部契约样例 |
| **P1 遥控 MVP（走中继）** | 见下方说明 | Codex：电脑端后端、中继、App 内核层；Claude：电脑端界面、App 界面 | 验收清单第 1–9 条 |
| **和 P1 同时做：本机技术验证** | 用 nodejs-mobile 的社区分支跑 core.cjs | Codex | 达到 6.1 的通过标准 |
| **P2 本机轻量档** | 拆出内核（和 TUI 的 P1 合并）、App 自带的 Node 运行时、本地项目、WebView 预览、Key | Codex + Claude | 验收清单第 10 条 |
| **P3 加强** | 见下方说明 | 两个军团 | 每项单独验收 |
| **P4 本机完整档** | Termux 里的独立内核和配对 | Codex + Claude | 在 Termux 里跑通一轮要执行命令的任务 |
| **P5 发布** | 正式签名、官网下载区、检查更新 | Codex + Claude | 能从官网下到签好名的 APK |

**P0 先定接口**
- 新增 protocol.ts。
- 扩展 types.ts，加 remote_message 的来源、`ChatRequest.origin`、`approval_request.humanOnly` 和 MobileView。
- 写出加密和配对的规格，以及测试向量。
- 写契约样例。
- 搭好 Android 工程骨架，定下 `link/` 层的 Kotlin 接口。

**P1 遥控 MVP（走中继）**
- **电脑端手机网关**：多监听者广播、快照、消息来源、撤不回操作在手机上确认、微信兜底。
- **中继**：加一个 Node 开发版。
- **电脑上的「手机」页**：和微信放在同一页，分成两个标签。
- **App**：
  - 配对、连接、首页「本鲸」、对话、审批和提问、改动页、回执、通知、保活引导；
  - 从 `whale-girl-svg/` 导出鲸鱼娘的静止画面，做通知栏用的单色剪影（Claude 负责）；
  - 一部手机先只绑一台电脑；
  - 前台服务，类型用 remoteMessaging，默认只在任务进行中保持连接。

**P3 加强**
- **连接**：局域网直连；「一直在线」模式。
- **入口**：小组件、磁贴、从别的 App 分享过来派活、自定义快捷指令。
- **语音**：按住说话，交给电脑上的语音识别（voice.ts）。
- **查看**：
  - 「给我看看」：截一张内置浏览器的图；
  - 终端的最后几行。
- **项目和审批**：
  - 多项目切换，切之前先提醒；
  - 把 approver 的请求也转到手机。
- **调研**：Live Updates 和各厂商类似灵动岛的接口。

**并行安排**：同时干活的代理不超过 4 个。P1 先上 Codex×2（一个做电脑端网关；一个做中继和 App 内核层）和 Claude×2（一个做电脑上的「手机」页；一个做 App 界面）。技术验证等有空位再排。

## 11. 文件归属（P0–P2）

**P0**
| 文件 / 目录 | 负责人 |
|---|---|
| `src/shared/protocol.ts`（新增）、`src/shared/types.ts`（扩展）、`protocol/fixtures/**`、`protocol/crypto-vectors.json` | 指挥官（architect 定稿） |
| `mobile/android/` 的构建脚本、Manifest、wrapper、.gitignore | Codex（Manifest 里的权限改动要先报指挥官） |
| `mobile/android/.../link/**`：界面层和内核层之间的接口 | 指挥官（architect 定稿） |
| `test/protocol/*.test.mjs`（用 `node --test`，不加测试框架）、`mobile/android/app/src/test/**` | test-engineer（P0 和 P1） |

**P1**
| 文件 / 目录 | 负责人 |
|---|---|
| `src/main/mobile/**`（新增：gateway、link、crypto、devices、audit）、`src/main/core/api.ts`、`src/main/core/status.ts` | Codex |
| `src/main/index.ts`：多监听者广播、来源事件、启动网关、微信兜底 | Codex |
| `src/main/agent/loop.ts`：只读快照、撤不回操作在手机上确认 | Codex |
| `src/main/island.ts`：改用 `core/status.ts` | Codex |
| `src/main/remote/wechat.ts`：加一个发回执的方法 | Codex |
| `src/preload/index.ts`、`index.d.ts`：`mobile:*` 方法 | 指挥官定接口，Codex 实现 |
| `relay/**`（新增）：Worker、Durable Object、Node 开发版、`cloudflare.config.ts` | Codex |
| `mobile/android/.../core/**`：传输、加密、协议、事件整理、前台服务、通知、扫码 | Codex |
| `src/renderer/src/components/MobileScreen.tsx`（新增） | Claude |
| `RemoteScreen.tsx`（并进「手机」页）、`ChatPanel.tsx`（显示消息来源）、`App.tsx`、`styles/theme.css`、`dev-mock.ts` | Claude |
| `mobile/android/.../ui/**`、`res/**`：Compose 界面、主题、鲸鱼娘形象和动画、文案 | Claude |

**P2**
| 文件 / 目录 | 负责人 |
|---|---|
| `src/main/core/platform.ts`、`src/main/core/entry-*.ts`、`scripts/build-core.mjs` | Codex |
| `agent/session-store.ts`、`providers/store.ts`、`agent/context.ts`：改成走 Platform | Codex |
| `mobile/android/.../core/node/**`：App 自带的 Node 桥、Keystore 密钥桥 | Codex |

## 12. 能直接复用的现有代码

- **会话**
  - `AgentSession` 的 `send`、`cancel`、`busy`、`respondApproval`、`answerQuestion`、`undoTurn`、`diffSource`（loop.ts:342-417）。
  - session-store 的 `list`（session-store.ts:72）和 `load`（session-store.ts:54）。
- **终端 AI**：PeerBus 的 `sessionsView`、`answer`、`hostList`、`hostSend`（peers.ts:158、167、214、226）。
- **微信远程**：
  - 接入主聊天的写法（index.ts:856-880）；
  - wechat.ts 的三条做法：只认扫码的人；主会话在忙时直接回复；长回复分段发。
- **状态映射**：灵动岛把 AgentEvent 映射成状态的规则（island.ts:368-454）。
- **安全**：
  - 路径检查 `resolveSafe`（workspace.ts:31-39）；
  - 日志脱敏 `memory/redact.ts`；
  - 用 safeStorage 存电脑私钥的写法（providers/store.ts:83-107）。
- **Kotlin 端照着写**：
  - `applyEvent`（ChatPanel.tsx:599-712，11 种显示块）；
  - `fromTranscript`（ChatPanel.tsx:1005）；
  - 审批卡（ApprovalCard.tsx:36-48、239-286）；
  - 提问卡（QuestionCard.tsx:19-133）。
- **设计稿**：TUI 设计稿 §3（Platform）和 §4（协议）。

## 13. 验证

**每个阶段都要过**
- `npm run typecheck`：现在本来就有 2 个错误，在 preload/index.ts:5 和 dev-mock.ts:509，是跨会话功能做到一半留下的。验收标准是不新增错误。
- `npm run build`
- `./gradlew assembleDebug` 和 `./gradlew test`
- 协议契约样例和加密测试向量，电脑端和 Kotlin 端都要跑通。

**按用户的习惯**
- 上面这些跑通就停，交给用户检查。
- 端到端的手动检查（模拟器 base_arm64 + 本地 Node 中继 + 电脑端 dev）写成步骤放进每个阶段的汇报，由用户来跑。

**验收清单**（要用真机的几条，等有设备时再测）
1. **配对**
   - 二维码只能用一次，5 分钟后失效；
   - 扫码后 30 秒内显示已连接；
   - 在电脑上移除设备，手机立刻断开。
2. **响应速度**
   - 手机派活后，电脑 5 秒内开始处理；
   - 状态和计划 3 秒内刷新；
   - 点「停下」后 3 秒内取消。
3. **多个请求**：同时有 2 个权限请求时，每个按钮只管自己那一条；在电脑上先处理掉的，手机上的通知会跟着消失。
4. **锁屏**：锁屏时点撤不回操作的「同意」，要先解锁；锁屏通知里没有命令和代码。
5. **拦截与确认**
   - 懒人任务里有 sudo，照样拦下；
   - 遇到 git push，手机弹出确认，「全部同意」代替不了，10 分钟不回就按拒绝；
   - 回执里写清原因。
6. **断线**：断网 60 秒后恢复，能补上结果；电脑睡眠或退出时，显示「电脑不在线」。
7. **回执与撤销**：做完后 10 秒内收到回执；在手机上撤销，和在电脑上撤销效果一样。
8. **数据安全**：抓包和中继上都只能看到密文；Key 不出现在日志和备份里。
9. **微信兜底**：App 被划掉后，只要微信远程开着，Claude Code 的权限请求和手机任务的回执仍然能发到微信。
10. **本机轻量档**
    - 在 Android 15、16 真机上各跑一轮「读、改、撤销」，不崩溃；
    - 说「做个计时器页面」，能预览，按钮能点；
    - 没有 shell 时，不注册 run_command。
11. **一直在线**：加入电池白名单后，「一直在线」模式连续跑 8 小时不被系统杀掉。
12. **审批卡倒计时**：每张审批卡都显示剩余时间。超时了，或者已经在电脑、微信上处理过的，卡片置灰并写明原因。
13. **电脑不在线**：输入框禁用，只留「重新连接」。

## 14. 风险

- **nodejs-mobile 的版本**：靠技术验证把关。
- **国内访问 Cloudflare 可能慢、不稳**
  - P3 的局域网直连可以兜底；
  - 中继逻辑也能搬到国内服务器，但要先备案。
- **国产手机系统杀后台**
  - 默认只在任务进行中保持连接；
  - 引导用户把 App 加进电池白名单；
  - 有微信兜底；
  - 各厂商的推送通道要分别注册开发者账号，放到以后再接。
- **主会话只有一个**：手机和电脑共用同一段对话，在电脑上切项目会打断手机上的任务。P1 只在回执里说明，P3 再加切换前的提醒。
- **协议要用两种语言维护**：靠契约样例测试兜底。
- **APK 体积**：App 自带 Node 后，预计会大几十 MB，技术验证时记下实际数字。

## 15. 需要你决定的事（不影响 P0、P1 开工）

1. **中继用哪个域名**：默认 relay.sikeoop.modgert.online，前提是这个域名在你的 Cloudflare 账号下。
2. **鲸鱼娘形象**
   - 现状：`whale-girl-svg/` 里五种状态的素材已经齐了。
   - 默认把 `lazy.svg` 当「做完」用，五套正好对上五种状态。如果你想把它留作懒人模式的专属形象，「做完」就得另画一套。
   - 可选：把 `lazy.svg` 屏幕上的 `PAUSED` 改成 `DONE`。
3. **以后要不要上应用商店**：会影响各厂商推送的接入和隐私合规的要求。
4. **远程任务要不要给模式开关**
   - 本方案：默认懒人，可以切到长任务或 Agent。
   - 产品经理建议：MVP 固定用懒人模式，不给开关。这样 P1 更省事，模式切换放到 P3 再做。
   - 两种做法选一个。

## 附：调研出处

由产品调研子代理在 2026-10-09 给出，指挥官没有逐条复核。

- **nodejs-mobile**
  - 官方发布页：https://github.com/nodejs-mobile/nodejs-mobile/releases
  - 社区分支：https://github.com/digidem/nodejs-mobile
- **Android 平台限制**
  - Android 10 禁止执行 App 可写目录里的文件：https://developer.android.com/about/versions/10/behavior-changes-10
  - Termux RUN_COMMAND：https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent
- **前台服务和通知**
  - 前台服务类型：https://developer.android.com/develop/background-work/services/fgs/service-types
  - 前台服务超时：https://developer.android.com/develop/background-work/services/fgs/timeout
  - 从后台启动的豁免：https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
  - Live Updates：https://developer.android.com/develop/ui/views/notifications/live-update
  - Android 17 行为变更（局域网权限）：https://developer.android.com/about/versions/17/behavior-changes-17
- **同类产品**
  - Claude Code Remote Control：https://code.claude.com/docs/en/remote-control
  - Codex 手机端（9to5Mac 报道）：https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/
  - Happy 的加密说明（第三方文档镜像）：https://mintlify.wiki/slopus/happy/features/encryption
- **未核实**：vivo 是否从 2026-01-01 起要求常驻通知报备分类，只见过二手搜索摘要，需要自己确认。
