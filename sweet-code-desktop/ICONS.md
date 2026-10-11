# sikeoop · 图标清单

给 Codex 的生成任务说明。App 里现在所有图标都是 emoji 或文字符号，在不同电脑上长得不一样，也和粉色二次元拟态风格不统一。这份清单列出要生成的每一个图标、放在哪里、替换哪一处。

## 一、统一规范（所有 UI 图标）

- **格式**：SVG，`viewBox="0 0 24 24"`，不写 `width` / `height`。
- **画法**：线条图标，`stroke="currentColor"`，`stroke-width="1.75"`，`stroke-linecap="round"`，`stroke-linejoin="round"`，`fill="none"`。需要实心的小块（圆点、爱心）用 `fill="currentColor"`。**不要写死颜色**：颜色由 CSS 控制，这样浅色、深色模式和不同伙伴的主题色都能自动适配。
- **风格**：圆润、可爱、线条干净；四角和端点都是圆的；视觉重量统一（主体占 24×24 里大约 18×18，四周留 3px）。和 App 的粉色渐变、拟态卡片、Q 版角色放在一起不突兀。
- **不要**：文字、品牌 logo、渐变、阴影、描边以外的装饰。
- **存放位置**：`src/renderer/src/assets/icons/<名字>.svg`，文件名用下表的「名字」列。

## 二、App 图标（新增，目前没有）

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `build/icon.png` | 1024×1024 PNG，透明背景 | 源文件；也用作 Linux 和 Windows 窗口图标 |
| `build/icon.icns` | 由 icon.png 生成（含 16–1024 各尺寸） | macOS 程序坞 / 应用图标 |
| `build/icon.ico` | 由 icon.png 生成（16、24、32、48、64、128、256） | Windows |
| `src/renderer/public/favicon.png` | 64×64 PNG | 浏览器预览（`npm run dev:web`）的标签页图标 |

**画面描述**：圆角方形底，粉色渐变（左上 `#ff7eb3` → 右下 `#ff9a9e`，再到淡粉 `#fecfef`），柔和的拟态高光和投影。中间是一颗白色圆润爱心，爱心里嵌着代码符号 `</>`，爱心上方或一侧有一点小星光。macOS 版按苹果图标网格：1024 画布里主体约 824×824，四周留安全边距；不要文字。

## 三、UI 图标（替换现有 emoji / 符号）

### 操作类

| 名字 | 现在 | 含义 | 出现位置（文件:行） |
|---|---|---|---|
| `close` | ✕ / × | 关闭、移除 | `components/TerminalPanel.tsx:173` 收起终端；`components/ChatPanel.tsx:321` 移除附件；`components/ChatPanel.tsx:596` 关闭历史列表；`components/PluginCenter.tsx:24` 关闭插件中心；`components/EditorPane.tsx:72` 关闭编辑器标签页 |
| `refresh` | ↻ | 刷新 / 重新连接 / 重开 | `App.tsx:305` 刷新文件树；`components/TerminalPanel.tsx:170` 重开终端；`components/PluginCenter.tsx:359` 重连 MCP 服务 |
| `trash` | 🗑 | 删除 | `components/ChatPanel.tsx:616` 删除历史对话；`components/PluginCenter.tsx:215` 删除技能；`components/PluginCenter.tsx:367` 删除 MCP 服务 |
| `attach` | 📎 | 添加图片 | `components/ChatPanel.tsx:349` 聊天框左下角 |
| `undo` | ↩ | 撤销这一轮的改动 | `components/ChatPanel.tsx:554` |
| `play` | ▶ | 在终端运行 / 安装 | `components/Markdown.tsx:36` 代码块「在终端运行」；`components/ProviderDialog.tsx:302` 「在终端里安装」 |
| `chevron-left` | ‹ | 上一位伙伴 | `home/HomeScreen.tsx:94`（主界面左侧圆形拟态按钮里，可以画大一点、线条粗一点） |
| `chevron-right` | › / ▸ | 下一位伙伴；文件夹收起；展开终端 | `home/HomeScreen.tsx:97`；`components/FileTree.tsx:34`（收起的文件夹）；`App.tsx:365`（「▸ 终端」） |
| `chevron-down` | ▾ | 文件夹展开 | `components/FileTree.tsx:34` |
| `check` | ✓ | 完成、已复制、已保存 | `App.tsx:241` 保存提示；`components/Markdown.tsx:49` 已复制；`components/ProviderDialog.tsx:353` 已保存 |
| `copy` | （现在只有文字「复制」） | 复制代码块 | `components/Markdown.tsx:49`，和 `check` 成对：复制前显示 `copy`，复制后显示 `check` |

### 状态 / 提示类

| 名字 | 现在 | 含义 | 出现位置 |
|---|---|---|---|
| `warning` | ⚠️ | 注意：没设置好、危险命令、含脚本 | `App.tsx:361` 状态栏「还没设置好」；`components/ApprovalCard.tsx:153` 命令风险提醒；`components/PluginCenter.tsx:158` 技能含脚本 |
| `check-circle` | ✅ | 已登录 / 成功 | `components/ProviderDialog.tsx:275` Anthropic 账号已登录 |
| `brain` | 🧠 | 当前使用的模型 | `App.tsx:361` 状态栏左下角 |
| `eye-search` | 🔍 | 识图 | `components/ChatPanel.tsx:493`、`494`、`498` 识图中 / 失败 / 结果；`components/ProviderDialog.tsx:339` 识图模型设置。可以画成放大镜里有一只眼睛或一张小图片 |
| `lock` | 🔒 | 会加密保存 | `components/PluginCenter.tsx:310` |
| `sparkle` | ✨ | AI 代码补全 | `components/ProviderDialog.tsx:394` |
| `bug` | 🐞 | 编辑器里有报错 | `App.tsx:377` 状态栏「N 个报错 · 帮我看看」 |
| `stethoscope` | 🩺 | 让 AI 诊断终端输出 | `components/TerminalPanel.tsx:167` 「帮我看看」 |
| `thought` | 💭 | AI 的思考过程 | `components/ChatPanel.tsx:506` 「想了想」 |
| `file` | 📄 | 当前打开的文件 | `components/ChatPanel.tsx:191` 「AI 能看到：📄 xxx」 |
| `archive` | 📦 | 长对话已整理成摘要 | `components/ChatPanel.tsx:446` |
| `broom` | 🧹 | 清理了旧的工具输出 | `components/ChatPanel.tsx:447` |
| `point-up` | 👆 | 等你确认上面的操作 | `components/ChatPanel.tsx:263` |

### 长任务模式（已先放了临时版，可以重画）

| 名字 | 含义 | 出现位置 |
|---|---|---|
| `rocket` | 长任务模式开关 | `components/ChatPanel.tsx` 聊天框「长任务」按钮 |
| `shield-check` | 审批小助手 | `components/ApprovalCard.tsx` 审批结果行；`components/ProviderDialog.tsx` 审批小助手设置；聊天里「审批小助手正在看…」 |
| `list-check` | 任务计划清单 | `components/ChatPanel.tsx` 计划卡片标题 |

### 新界面用到的（临时版，可以重画）

| 名字 | 含义 | 出现位置 |
|---|---|---|
| `home` | 首页 | 左侧图标栏 |
| `files` | 文件 / 资源管理器 | 左侧图标栏 |
| `folder-plus` | 新建项目 | 启动页 |
| `arrow-up` | 发送 | 聊天输入框右下角的圆形按钮 |

### 品牌装饰

| 名字 | 现在 | 含义 | 出现位置 |
|---|---|---|---|
| `heart` | ♡ / 💗 | sikeoop 的标志 | `App.tsx:264` 标题栏「sikeoop ♡」；`App.tsx:350` 欢迎卡片；`components/ChatPanel.tsx:230` 小助手欢迎语。实心，`fill="currentColor"` |

## 四、新增建议（现在只有文字或没有图标）

### 文字按钮配图标（图标 + 文字一起显示）

| 名字 | 按钮 | 位置 |
|---|---|---|
| `plugin` | 插件 | 标题栏，`App.tsx`「插件」按钮 |
| `partners` | 伙伴 | 标题栏，回到选伙伴主界面 |
| `folder-open` | 打开项目 / 换个项目 | 标题栏 |
| `settings` | 设置 | 主界面信息面板「设置」按钮（`home/HomeScreen.tsx`） |
| `history` | 历史 | 聊天栏顶部 |
| `chat-plus` | 新对话 | 聊天栏顶部 |
| `terminal` | 终端 | 状态栏「▸ 终端」和终端标题栏 |
| `send` | 发送 | 聊天框右下角 |
| `stop` | 停下 | 聊天框右下角（AI 工作时） |
| `key` | API Key | 设置窗口 Key 输入框旁 |

### 文件树的文件类型图标（`components/FileTree.tsx`，每个文件名前）

这一组可以带颜色（不用 `currentColor`），颜色要柔和、偏粉彩，在浅色和深色背景上都清楚：

| 名字 | 用于 |
|---|---|
| `ft-folder` / `ft-folder-open` | 文件夹（收起 / 展开） |
| `ft-js` | `.js` `.mjs` `.cjs` `.jsx` |
| `ft-ts` | `.ts` `.tsx` |
| `ft-html` | `.html` |
| `ft-css` | `.css` `.scss` `.less` |
| `ft-json` | `.json` |
| `ft-md` | `.md` `.mdc` |
| `ft-py` | `.py` |
| `ft-image` | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.svg` |
| `ft-config` | `.env` `.yml` `.yaml` `.toml` 和点开头的配置文件 |
| `ft-file` | 其他所有文件 |
| `ft-c` / `ft-cpp` | `.c` `.h` / `.cpp` `.cc` `.hpp` `.ino` |
| `ft-csharp` `ft-java` `ft-kotlin` `ft-go` `ft-rust` `ft-swift` | 对应语言 |
| `ft-php` `ft-ruby` `ft-lua` `ft-dart` `ft-sql` `ft-xml` | 对应语言 |
| `ft-shell` | `.sh` `.bash` `.zsh` `.ps1` `.bat` |
| `ft-vue` / `ft-svelte` | `.vue` `.nvue` / `.svelte` |

（上面这些新加的文件类型已经在 `components/Icon.tsx` 里对应好了，SVG 放进来就生效；没放之前显示 `ft-file`。）

## 五、保留为文字的符号（不用生成）

这些是键盘按键或说明文字，保持原样：`⌘`（⌘S、⌘Z）、`⌃`（⌃` 打开终端）、`←` `→`（主界面上「←、→ 或拖动来换人」的说明）。

## 六、接入方式（给 Codex）

1. 图标放到 `src/renderer/src/assets/icons/`。
2. 新建 `src/renderer/src/components/Icon.tsx`：用 `import.meta.glob("../assets/icons/*.svg", { eager: true, query: "?raw", import: "default" })` 读入所有 SVG，按名字内联渲染（`<span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />`），默认 `width: 1em; height: 1em; vertical-align: -0.15em`，这样字号多大图标就多大、颜色跟随文字。
3. 按第三节的「出现位置」逐处把 emoji / 符号换成 `<Icon name="..." />`。只有图标、没有文字的按钮（关闭、刷新、删除、附件），保留或补上 `aria-label` / `title`，屏幕阅读器才知道它是干嘛的。
4. App 图标：在 Electron 打包配置里引用 `build/icon.*`；开发模式下在 `src/main/index.ts` 创建窗口时设置 `icon`（Windows / Linux 生效，macOS 用 .icns）。
5. 不要改动任何功能和文案，只换图标。改完运行 `npm run typecheck` 和 `npm run build`。

## 附：还缺的伙伴立绘（如果也要生成）

现在 12 位伙伴里 8 位有立绘。下面 4 位还是 3D 小人，规格和已有的立绘一致：2:3 竖版（1024×1536），上方标题，中间半身插画，下方「三个关键词」一行、三格表情小图、一句台词。放进 `src/renderer/src/home/art/`，文件名如下，放进去就会自动生效（不要在图上画官方 logo）：

| 文件名 | 伙伴 | 人设（来自 `home/characters.ts`） |
|---|---|---|
| `moonshot.webp` | 月见（Kimi） | 夜猫子诗人 · 长文高手；黑色长发、金色眼睛、月亮发饰，夜晚书房；台词「夜深了也没关系，再长的代码我都读得完。」 |
| `openrouter.webp` | 路路（OpenRouter） | 导游少女 · 带你逛遍所有模型；橙色短发、红色棒球帽；台词「想试哪个模型？跟紧我，我来带路～」 |
| `ollama.webp` | 羊驼咩（Ollama，本地） | 本地小羊驼 · 断网也能陪你；奶油色蓬松头发、羊驼耳朵、粉色点缀；台词「不联网也没关系，我就住在你的电脑里。」 |
| `custom.webp` | 神秘嘉宾（自定义） | 自定义 · 等你来介绍；灰紫色短发、头顶漂浮的问号；台词「你想让谁来陪你？告诉我接口地址吧。」 |
