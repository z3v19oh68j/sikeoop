# 甜心代码屋：项目分析

分析日期：2026-10-07

## 1. 结论

这是一个**已经具备实际 Agent 执行链路的本地 AI IDE MVP**，不是只有界面的聊天壳。核心价值是面向新手的可解释文件修改、审批、撤销，以及 HTML 原型画布。当前可以进入内部试用和稳定性整改阶段，但还不能据此认定为可公开分发的生产版本。

主要短板不是功能数量，而是文件边界的一致性、异步会话生命周期、失败时的数据保全，以及缺少保留在仓库里的自动化回归测试与发行流水线。

## 2. 项目范围

- [桌面应用](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/package.json)：`sweet-code-desktop`，版本 0.1.0，是当前主体。
- [独立 HTML 页面](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code.html)：早期教学型编辑器，包含五个课程与空白画布、实时预览、控制台和 localStorage 草稿；不是桌面版的运行入口。
- 桌面版包含 81 个 TS/TSX 文件。TS、TSX、JS、CSS 合计约 16,335 行，包含浏览器 mock、示例与视觉场景代码。
- 没有单独的云后端；文件、会话、配置、记忆和向量缓存主要保存在本地，模型、远程 MCP、技能下载等仍会访问外部服务。

## 3. 技术架构

技术栈：Electron 44.4.5、React 19、TypeScript 6、electron-vite/Vite、Monaco、xterm/node-pty、Three.js；模型接入使用 Anthropic SDK 与 OpenAI SDK，插件使用 MCP SDK。

```text
React / Monaco / xterm / Three.js / 原型画布
                      │
             preload: window.sweet
                      │ IPC
               Electron 主进程
                      │
                AgentSession
       ┌──────────────┼──────────────┐
   ModelAdapter    ToolRegistry    HookBus
       │               │             │
 Anthropic /       文件 / bash /   规则 / 记忆 /
 OpenAI-compatible Skills / MCP    BM25 / 可选向量
                      │
            本地项目、会话、检查点
```

核心入口：[主进程](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/index.ts)、[Agent 循环](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/agent/loop.ts)、[渲染层 App](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/renderer/src/App.tsx)。

设计上的优点：

1. Agent 循环与服务商适配器分离，保留服务商原生历史格式，统一工具执行结果。
2. 文件修改包含先读后改哈希校验、Diff 审批、审批后内容复查与按回合撤销。
3. 会话按项目路径哈希保存，并通过临时文件加 rename 避免半截 JSON。
4. 固定工具列表和系统提示，考虑了缓存、上下文压缩、取消和调用步数上限。
5. Renderer 设置了 contextIsolation、关闭 nodeIntegration、开启 sandbox，并有 CSP 和导航拦截。
6. 原型 iframe 与应用界面隔离，项目 Hook 有内容哈希信任机制。这些是有效设计，但不能抵消下文的实现缺口。

## 4. 功能实现与边界

| 模块 | 本地源码中的实现 | 必须区分的边界 |
|---|---|---|
| 编辑器 | 文件树、多标签、Monaco、保存、语法检查入口 | 不是完整 VS Code 扩展或语言服务器生态 |
| AI Agent | 工具调用、流式文本/思考、取消、计划、审批、撤销 | 真实服务商联调未在本次执行 |
| 多模型 | Anthropic 原生适配与多家 OpenAI-compatible 预设 | 预设存在不等于每家端到端验证通过 |
| 长任务 | 普通 40 步、长任务 200 步；计划未完时有限续跑 | 审批小助手是另一次模型请求，不是 OS 沙箱或确定性安全策略 |
| Skills / MCP | 技能导入转换、安装预览、按需读取；stdio/HTTP/SSE MCP | 本地 MCP 是宿主用户权限进程，不受项目文件路径约束 |
| 上下文工程 | Hooks、全局/项目记忆、BM25、可选 embeddings、RRF 混合检索 | 启用远程 embeddings 后会将选中的代码块发给服务商 |
| 识图 / 补全 | 图片先经识图模型转文字；DeepSeek FIM 有单独链路 | 不是所有聊天模型直接接收原图 |
| 原型工坊 | D1：原型文件、画板平移缩放、新页面、页面跳转演示 | D2 属性编辑、D3 专用设计 Agent、D4 截图自检/变体、D5 组件导出仍是方案 |
| 3D 伙伴 | 服务商对应角色、Three.js 场景、交互动画 | 属于产品表现层，不代表多 Agent 协作 |
| 分发 | 可构建 main/preload/renderer 产物 | 没有完整安装包、签名、公证、更新流程 |

原型阶段边界依据：[设计文档](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/docs/prototype-studio.md)。浏览器 `dev:web` 会安装 [dev-mock](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/renderer/src/dev-mock.ts)，因此浏览器演示不能证明真实 Electron IPC、模型、PTY 或磁盘操作已经运行正确。

## 5. 已复现的问题

以下五项都使用临时目录或模拟模型验证。没有读取用户密钥、调用真实模型、修改现有项目文件，或运行破坏性命令。

### P1：新建文件可以穿过目录软链接写到项目外

位置：[workspace.ts:31–46](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/workspace.ts#L31)、[edit-tools.ts:148–162](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/tools/edit-tools.ts#L148)。

`resolveSafe()` 对不存在的目标执行 realpath 失败后，只检查词法路径。目标的父目录若是指向项目外的软链接，就没有被验证。`create_file` 之后的 mkdir/writeFile 会跟随该软链接。

复现：临时项目中建立 `bridge -> 临时外部目录`；读取已存在的 `bridge/existing.txt` 被拒绝，但审批后新建 `bridge/new.txt` 成功落入外部目录。

修复方向：为不存在的目标解析最近存在的祖先目录，检查真实路径；写入前再次校验，并明确处理检查与写入之间的路径替换竞争。

### P1：原型存储没有统一使用真实路径边界检查

位置：[prototypes/store.ts:54–72](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/prototypes/store.ts#L54)、[112–125](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/prototypes/store.ts#L112)。

`insideDir()` 只做词法检查，原型目录自身也未验证真实路径仍位于项目中。

复现：screen 文件软链接到临时项目外文件时，`load()` 能读到其内容；原型目录软链接到外部目录时，`saveCanvas()` 会在外部目录写入 canvas.json。

修复方向：原型 CRUD、文件服务协议与普通文件工具共用一套 canonical path 策略；同时校验真实项目根、原型根、原型目录和目标路径。协议里的相对原型检查不应代替项目根检查。

### P1：Hook 要求人确认，会被“本次对话全部同意”覆盖

位置：[loop.ts:580–599](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/agent/loop.ts#L580)。

先根据 `autoApprove` 算出的 `auto`，没有在 Hook 返回 `ask` 时清零。后续会直接走自动批准分支。

复现：开启 autoApprove，为同一文件操作设置 Hook `decision: ask`，结果仍是自动批准，没有等待人工回答。

修复方向：确定性地实现权限优先级，例如 deny > ask > allow/会话批准；已信任 MCP 的执行路径也应服从相同策略。

### P2：reset 与旧回合清理存在竞争，旧状态能重新进入新会话

位置：[loop.ts:225–245](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/agent/loop.ts#L225)、[290–302](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/agent/loop.ts#L290)、[340–346](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/agent/loop.ts#L340)。项目切换顺序另见 [index.ts:173–176](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/index.ts#L173)。

reset 发出 abort 后立即重置共享字段，没有等待旧 send 结束。旧 send 的 rollback/finally 仍访问同一个 AgentSession 实例。项目切换还会先替换全局 root，再 reset。

复现：让模拟模型请求保持运行，reset 后切到临时项目 B，再结束旧请求；旧项目的 notes 和 snapshotSent 标志重新进入已经重置的对象。reset 返回时 busy 也仍为 true。

本次确认的是状态污染；没有将其夸大成已经复现的跨项目文件覆盖。

修复方向：采用异步 cancel-and-drain 或每会话独立实例，固定回合所属 root/sessionId，并用 generation token 丢弃过期事件、状态修改和持久化。

### P2：摘要请求失败，仍会清空模型历史

位置：[openai-compatible.ts:88–116](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/main/providers/openai-compatible.ts#L88)。

即使摘要调用因网络错误失败，后续仍执行 `messages = []`，以通用说明替代旧上下文。已有 carry 也不能保证包含之后累积的内容。

复现：导入超过压缩阈值的模拟历史，让摘要调用抛出网络错误，旧 messages 变为零，重要任务内容未保留在 carry 中。

这里丢失的是模型的可续聊上下文；不等于界面 transcript 当场被删除。

修复方向：只有成功产生有效摘要才提交历史替换；失败则保留历史、提示重试，或执行明确可恢复的降级。

## 6. 其他工程问题

- **未保存编辑缺少退出保护。** [App.tsx:252–258](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/renderer/src/App.tsx#L252) 关闭标签直接 dispose 和删除状态；[135–139](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/src/renderer/src/App.tsx#L135) 切项目直接清空文件列表。没有保存/放弃/取消选择。这一项来自静态审查，未做 UI 自动化复现。
- **shell 不是项目沙箱。** `run_command` 仅将 cwd 设为项目根并用正则识别部分危险命令；命令仍继承宿主进程环境与用户权限。正则与 LLM 审批属于提醒/决策层，不能证明文件或网络访问被隔离。
- **IPC 缺少统一入口校验。** 工具输入使用 Zod，但多数 IPC 处理函数仅依赖 TS 参数类型，没有统一运行时 schema 与 sender 校验。
- **没有仓库内回归集。** 未发现 test/spec 文件、test 脚本或 CI 配置。README 描述过往验证，但本仓库没有把这些验证保留成可重复回归集。
- **Git 尚无基线。** 当前 main 没有 commit，git ls-files 为零，源文件全部未追踪。应先建可恢复的基线。
- **打包不等于发行。** [package.json](/Users/sikerhuang/Desktop/untitled%20folder/sweet-code-desktop/package.json) 只配置开发、构建和预览；原生 node-pty 的打包、安装包与平台验证仍需落实。
- **前端启动负载偏大。** 本次构建产物约 34MB，主 renderer JS 约 10.54MB，TS worker 约 13.31MB。是原始构建尺寸，不是测得的下载或启动时间；可进一步拆分首页 3D、编辑器、PDF 等按需入口。

## 7. 本次验证记录

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过，主进程/preload/shared 与 renderer 两套配置均完成 |
| `electron-vite build --outDir /tmp/sweet-code-build.McfNL9` | 通过，输出放在独立临时目录，保留原有 out/ |
| 新建文件软链接边界夹具 | 问题复现；已存在目标的越界控制检查有效 |
| 原型存储软链接夹具 | 项目外读取和写入问题复现 |
| Hook ask / approve_all 夹具 | 自动批准覆盖人工确认问题复现 |
| 模拟模型阻塞 + reset 夹具 | 旧 notes、snapshotSent 回灌问题复现 |
| 模拟摘要网络失败夹具 | 模型历史被清空问题复现 |

未验证：真实 Electron 窗口与完整操作流程、各模型服务商请求、真实 MCP 服务、PTY 交互、Windows 真机、安装包签名/公证。文档内模型名称、能力与价格不作为本次实时验证结论。

## 8. 整改顺序

1. **先建立基线与回归测试，再修边界。** 保存 Git 基线；把以上五项保留为自动化测试，统一文件安全策略与审批优先级。
2. **处理生命周期和数据保全。** 会话 cancel-and-drain、root 固定、过期事件隔离、摘要失败回退、dirty tab 保护。
3. **补真实运行与发行验证。** 用临时 userData 跑 Electron E2E、模型协议夹具、MCP/PTY 测试，再做 macOS/Windows 打包。
4. **之后扩展原型工坊。** 先 D2 元素选中与源码回写，再 D3 专用设计工具，再 D4 自检，最后 D5 导出。不要把设计文档当成已交付功能。

产品层面应继续围绕“新手能理解、改错能恢复、页面能看到效果”建立差异，而不是继续堆伙伴动画或服务商数量来代替可靠性。
