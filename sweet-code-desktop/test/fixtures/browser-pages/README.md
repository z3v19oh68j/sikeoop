# 自动化浏览器 · 测试页面集

给自动化浏览器（CDP 底层，见 `docs/方案-自动化浏览器.md`、`docs/自动化浏览器-第一批任务书.md`）做单测和回归用的本地页面。每一页只针对一个容易出错的场景，全部是**纯静态 HTML，无任何外部资源**（内联 CSS/JS，不连网、不引 CDN、不用字体）。

## 怎么跑

```sh
cd sweet-code-desktop/test/fixtures/browser-pages
node server.mjs
```

- 默认同时监听 `http://127.0.0.1:7331/`（主）和 `http://127.0.0.1:7332/`（副），两个端口服务的是同一个目录。
- **为什么要两个端口**：`iframe.html` 需要一个跨源子帧。同机不同端口即不同源，所以主页面走主端口、跨源子帧从副端口加载。
- 自定义端口：`PORT=8080 PORT2=8081 node server.mjs`。注意 `iframe.html` 里跨源帧按「7331↔7332 互相翻转」推算副端口地址，换了端口要么用默认对，要么相应改页面里那段推算。
- 只起一个端口：`node server.mjs --once`（此时 `iframe.html` 的跨源帧会加载失败，属预期）。
- 零依赖，只用 Node 内置模块；用项目自带的 Node 即可，不用 `npm install`。
- 服务只读本目录、挡掉路径穿越、不设 `X-Frame-Options`（好让页面能被 iframe 内嵌）。

打开 `/` 是索引页，列出全部测试页。

## 各页期望行为

### `form.html` — 普通表单
文本、邮箱、密码、下拉、多行、勾选框、单选、提交。每个控件都有关联 `<label>`，提交按钮文字「提交」。提交走 `preventDefault`，把表单值以 JSON 填进 `#result`，不跳转。
**期望**：精简树能列出全部可交互控件并带正确名字；`fill` / `select` / `check` 后点「提交」，`#result` 出现对应 JSON。密码字段用于验证现有密码填充逻辑不受影响。

### `spa.html` — SPA 路由
三个按钮用 `history.pushState` + 改 `innerHTML` 切换「路由」，**不发生真实导航**，`load` / `did-stop-loading` 都不触发。「慢加载」路由的内容延迟 800ms 出现（`#slow-done`）。
**期望**：点击后地址栏 `pathname` 变了、视图内容变了，但不能靠加载事件判完成——要靠 DOM 变更 / 目标文字出现来等。靠固定加载事件的实现会在这页干等或误判。

### `iframe.html` + `frame-inner.html` — 同源 + 跨源 iframe
上面是同源子帧（父页同端口），下面是跨源子帧（副端口，不同源）。两个子帧都是 `frame-inner.html`，各有一个输入框和一个按钮，点按钮回显输入值。
**期望**：同源帧普通方式即可读写；跨源帧普通预加载脚本进不去，CDP 要靠 `Target.setAutoAttach(flatten)` 穿透后，同样能列出并操作帧内元素。两个帧里的元素都应出现在精简树里，并可分别定位。

### `shadow-dom.html` — open / closed 影子根
`<open-widget>` 用 open 影子根，`<closed-widget>` 用 closed。两者内部结构相同（输入框 + 按钮 + 回显）。closed 的内容页面脚本拿不到（`el.shadowRoot` 为 `null`）。
**期望**：CDP `DOM.getDocument(pierce)` 两种影子根都能看见；精简树里 open 和 closed 内的按钮、输入框都应列出并可操作。只靠页面注入脚本的实现看不到 closed 的内容。

### `overlay.html` — 遮挡弹窗
「目标按钮」一直在页面上。点「打开遮罩」后弹出 `z-index:1000` 的模态层盖住它；「关闭遮罩」撤下。
**期望**：遮罩打开时，对目标按钮做命中检测应落在遮罩上，自动化要报「被遮罩挡住」而**不是**照点（点了也只会点到遮罩）。关掉遮罩后目标按钮可点，`#status` 显示被点到。

### `animating-button.html` — 动画中的按钮
`#mover` 用 CSS 动画左右无限移动，位置每帧都在变。「停下动画」把它固定。
**期望**：点击前的稳定性检查应发现「连续两帧位置不变」不成立，于是等待（动画停或超时）。停下动画后位置固定，点击命中，`#status` 显示被点到。

### `disabled-button.html` — disabled 按钮
提交按钮初始 `disabled`，勾选「我已阅读并同意」后才启用（`#btn-state` 同步显示禁用/可用）。
**期望**：可操作性检查里的「可用」一项应识别 disabled，不去硬点；流程应先勾选使其启用再点。启用后点击，`#status` 显示提交成功。

### `virtual-list.html` — 虚拟长列表
共 10000 行，但用 windowing，DOM 里同时只有可见的约 20 行（每行一个「选择」按钮），其余随滚动回收重建。
**期望**：快照只能看到当前渲染的子集；要操作靠后的行（如第 5000 行）必须先滚动使其进入 DOM 再定位。直接找不在 DOM 里的行应报「元素不存在」，提示需要滚动。

### `contenteditable.html` — 富文本编辑器
可编辑的 `<div contenteditable>`（不是 `<input>`），带加粗/斜体工具栏，`#len` 实时显示纯文本字数。
**期望**：逐键模拟容易出错；应走 `Input.insertText` 把整段文字插到光标处，`#len` 随之更新。能保留已有的富文本结构。

### `chinese-input.html` — 中文输入框
单行 `<input>` 和多行 `<textarea>`，各自回显当前值和字数，并监听 `compositionstart/end` 显示合成状态。
**期望**：逐键 `keydown` 进不了中文（要走输入法合成）；应用 `Input.insertText` 整段写入，回显里出现完整中文、字数正确。

### `delayed-element.html` — 延迟出现的元素
两种延迟：页面加载 1.5s 后自动出现 `#auto-btn`；点「加载内容」后 1s 才出现 `#async-btn`。
**期望**：不该靠固定睡眠；应「等元素出现 / 文字出现」再操作。在元素出现前尝试定位应得到「尚未出现」，等待逻辑应在其出现后立刻继续。

## 给单测的建议

- 这些页面不依赖网络，适合在单测里用假 debugger 回放，或在集成测试里用真 `webContents` 加载 `http://127.0.0.1:7331/<page>` 后驱动 CDP。
- 页面里的 `id`、`aria-label`、按钮文字都刻意保持稳定，可作为断言锚点。
- 所有「被点到 / 已提交 / 字数」等结果都写进可见的 `#status` / `#result` / `.echo` 节点，便于断言副作用。
