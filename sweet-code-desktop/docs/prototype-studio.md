# 原型工坊（Prototype Studio）设计方案

给 AI 用的前端原型画布：像 Figma 一样在无限画布上排页面、选元素、调属性，但每个页面都是**真的 HTML/CSS**，由设计 Agent 生成和修改，最后能导出成项目里的组件代码。

设计稿：https://claude.ai/artifact/9Pb45a1oDb5DDhffshpMA9（画布 / 设计 Agent / 令牌和导出 三屏）

## 核心决定

1. **代码就是设计稿。** 不画矢量图形。每个页面是一个 HTML 文件，画布上看到的就是浏览器渲染出的样子，所以「做出来的」和「设计的」永远一致，导出时没有还原损耗。AI 最擅长写 HTML/CSS，比操作图形 API 稳得多。
2. **文件放在项目里，可以用 git 管。** `prototypes/<原型名>/`：
   - `canvas.json`：画板位置、尺寸、设备、跳转连线
   - `tokens.css`：设计令牌（CSS 变量）
   - `components/*.html`：可复用组件片段
   - `screens/*.html`：每个页面一个文件，引用 tokens.css
   - `.history/`：每次 AI 改动前的快照（复用现有的 CheckpointStore 撤销）
3. **每个元素有一个稳定编号。** 保存时给每个元素补上 `data-sid` 属性（AI 被要求保留它）。图层树、选中、属性面板、AI 的「只改选中的」都靠这个编号对上源码。
4. **双向编辑都落到源码上。** 在属性面板里拖数值，main 进程用 HTML 解析器找到 `data-sid` 对应的元素，改它的 class 或 style，再写回文件；AI 用现有的 edit_file 改同一个文件。两边都触发 file_changed，画布热更新。
5. **画布用 DOM，不用 WebGL。** 画板是放在 CSS transform 平移和缩放容器里的沙箱 iframe（`sandbox="allow-scripts"`、srcdoc、CSP 禁网）。iframe 里注入一个小的检查脚本，用 postMessage 回报悬停和选中元素的位置、计算后的样式和 DOM 树；选框、手柄、尺寸标签都画在父页面的覆盖层上。

## 界面（见设计稿第 1 屏）

- **顶栏**：工具（选择 V、画板 F、文字 T、批注 C）、「AI 生成页面」、缩放、演示（可点击的原型）、导出到项目。
- **左栏**：页面列表（设备尺寸）和当前页面的图层树（来自 iframe 的 DOM），组件用紫色标出。
- **画布**：
  - 无限平移和缩放、点阵背景。画板上方标名字和尺寸。
  - 画板之间画出跳转连线（来自 `canvas.json` 的 links）。
  - 选中元素后，旁边浮出「只改这个」的 AI 输入框，带快捷建议（更醒目、加悬停效果、做 3 个变体）。
- **右栏**：
  - **设计**：自动布局（flex 方向、间距、宽高的填满或固定）、外观（填充、圆角、阴影，优先显示绑定的令牌）、文字、交互（点击跳到哪个页面）。
  - **原型**：页面之间的跳转。
  - **代码**：选中元素在源文件里的位置和片段，点一下在编辑器里打开。

## 设计 Agent（见设计稿第 2 屏）

用现有的 AgentSession，换一套系统提示补充和工具。工具列表在每段对话里固定，所以「设计对话」是单独的会话类型。

| 工具 | 作用 |
|---|---|
| `design_brief` | 先定风格：配色、字体、圆角、间距，写进 tokens.css，在对话里显示色板卡片 |
| `create_screen` / `update_screen` | 新建页面或整体改页面（HTML 片段，自动补 data-sid、引用令牌） |
| `edit_element` | 按 sid 只改一个元素的结构、样式或文字，「只改选中的」就用它 |
| `get_selection` | 读用户当前选中的元素：sid、源码片段、计算后的样式 |
| `render_screen` | **AI 看自己做的东西**：在隐藏的 BrowserWindow 里按设备尺寸渲染，capturePage 截图，交给识图模型。工具返回的文字里有对齐、层级、对比度（脚本算 WCAG 对比度）、溢出（脚本检测横向滚动和文字截断）的检查结果 |
| `make_variants` | 给一个元素或页面出 N 个变体，并排放在画布上，用户选一个，其余删掉 |
| `link_screens` | 设置跳转：某个元素点击后打开某个页面 |
| `extract_component` | 把重复出现的结构提成组件，所有用到的地方改成引用 |
| `export_to_project` | 识别项目框架（package.json：Vue / React / 原生），按项目现有写法生成组件、页面和令牌文件，走正常的 diff 审批 |

默认流程：定风格 → 搭页面 → **render_screen 自检一遍并自己修好** → 汇报。长任务模式和审批小助手照常可用。参考截图可以直接贴进来，复用识图模块，先拆出结构和配色，再还原。

## 令牌和导出（见设计稿第 3 屏）

- **令牌**：颜色、文字层级、圆角、间距，显示每个用了多少处。检查脚本会找出写死的、和令牌值很接近的颜色，提示一键换成变量。
- **导出**：按框架生成 `tokens.css`、组件和页面，必要时改路由。改动照常一份份确认，也能「撤销这一轮」。

## 和现有模块的关系

| 现有模块 | 在原型工坊里的用法 |
|---|---|
| Agent loop、审批、撤销、长任务 | 原样复用，设计会话只是换一套工具和提示 |
| 识图（vision.ts） | render_screen 截图自检；参考图还原 |
| Hooks | 设计会话也走同一条 Hook 总线，比如 PostToolUse 时自动跑对比度检查 |
| 代码索引（RAG） | 导出时找项目里现成的组件和写法 |
| 记忆 | 记住用户偏好的风格（「喜欢圆角大一点」） |
| 语法高亮 | 代码页签、选中元素的源码片段 |

## 安全

- 画板 iframe：`sandbox="allow-scripts"`（不给 allow-same-origin）、srcdoc，CSP 禁止网络（默认只能用本地资源，以后可以加一个允许的 CDN 名单）。原型里的脚本碰不到 app 和 Node。
- render_screen 用的离屏窗口：同样关掉 nodeIntegration，开 sandbox，拦截一切网络请求和导航。
- 导出只通过现有的文件工具，走审批。

## 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| D1 画布 ✅ | 原型文件格式、画布平移缩放、画板 iframe 实时渲染、页面列表、演示模式（点击跳转） | 手写两个 screen 能在画布上看到，演示能跳转 |
| D2 选中和属性 | 注入检查脚本、悬停和选中覆盖层、图层树、属性面板读取，改布局、颜色、圆角和文字写回源码 | 选中按钮改圆角，源文件随之变化，支持撤销 |
| D3 设计 Agent | 设计会话、create/update_screen、edit_element、get_selection、浮动的「只改这个」输入框 | 一句话生成 3 个页面；选中元素让 AI 改 |
| D4 自检和变体 | render_screen 截图加识图、对比度和溢出检查、make_variants 并排展示 | AI 能发现并修复对比度问题；变体选一个能替换原元素 |
| D5 令牌、组件、导出 | 令牌面板、写死颜色检查、extract_component、导出到 Vue / React / 原生 HTML | 导出的组件在项目里能直接跑 |

## D1 完成情况（已实现）

- **文件格式**：`main/prototypes/store.ts`。
  - `prototypes/<名字>/canvas.json`、`tokens.css`、`screens/*.html`。
  - canvas.json 被 AI 或手动改坏时，加载会尽量修复（补齐 id、尺寸、位置），修了什么在页面面板里提示。
  - 新建原型时带两个连好跳转的示例页面。
- **独立协议**：`main/prototypes/protocol.ts`。
  - `sweetproto://p/<原型>/<文件>`，只能读当前项目 `prototypes/<原型>/` 里的文件。符号链接要解析到真实路径再检查一次，越界返回 403。
  - 每个响应都带禁网的 CSP（`connect-src 'none'`）。
  - HTML 的 `<head>` 开头会注入页面运行时 `public/proto-runtime.js`：处理 `data-goto` 跳转、拦截普通链接、上报脚本错误。
- **画布**：`renderer/src/studio/Studio.tsx`。
  - 无限平移和缩放：滚轮平移；双指捏合、⌘/Ctrl+滚轮缩放；空格拖动；Shift+1 适应窗口。
  - 画板是 `sandbox="allow-scripts"` 的 iframe，实时渲染。拖标题移动画板，位置防抖后写回 canvas.json。
  - 按 `data-goto` 自动画出页面之间的连线。页面脚本出错时，画板和页面列表上会标出来。
  - AI 改了原型文件，或者在编辑器里保存了原型文件，只重新渲染改到的页面；改 tokens.css 或 canvas.json 时全部重新渲染。
- **页面面板**：页面列表、新建页面（手机、平板、电脑）、设为起始页、看代码（在编辑器打开源文件）。
- **演示**：按设备尺寸缩放到适合窗口，点 `data-goto` 跳转，支持返回、从头开始、Esc 退出，坏链接会提示。
- **普通聊天也能做原型**：内置技能 `prototype-studio` 说明了文件格式，专门的设计 Agent 在 D3 做。
- **验证情况**：
  - 用真实 Electron 跑了协议测试：沙箱 iframe 能渲染、运行时能上报，路径越界返回 403/404，每个响应都有 CSP。
  - 画布交互、演示跳转、新建页面在浏览器里用 mock 验证过。浏览器预览靠 `vite.web.config.ts` 里的中间件提供 `src/renderer/dev-proto/` 下的示例原型。

