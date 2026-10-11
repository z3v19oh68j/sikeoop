# sikeoop / SYNCHRONIZE_01

**EVA 初号机 × 初音未来**皮肤设计资产套装。深紫机体骨架、初音青交互光、荧光绿运行状态、粉色音频信号、警戒橙工程标记。

## 打开与下载

- 双击 `index.html` 可离线浏览整套设计；UI 图层开关不依赖服务器。
- SVG 主文件可作为分组矢量导入设计工具；Inkscape 可识别具名图层。
- `svg/layers/` 内的 38 个独立 SVG 保留原画布坐标，可以原位叠加。
- SVG 标签是可编辑文字，字体使用系统 fallback，没有转为文字轮廓。

## 交付清单

| 资产 | 文件 | 原生尺寸 / 数量 |
|---|---|---|
| 整窗效果图 | `images/app-effect.png` | 1626 × 967，内置 image_gen 生成 |
| 独立单张主题图 | `images/theme-wallpaper.png` | 1672 × 941，内置 image_gen 生成 |
| UI 分层母版 | `svg/ui-skin-layered.svg` | 1920 × 1140，12 层，包含一个嵌入位图层 |
| 全矢量 UI 母版 | `svg/ui-skin-vector-only.svg` | 1920 × 1140，12 顶层分组，无位图 |
| 全矢量主题母版 | `svg/theme-vector-layered.svg` | 1920 × 1080，14 层，无位图 |
| 独立层导出 | `svg/layers/` | 38 个 SVG，同画布注册 |
| UI 图标 | `icons/ui/` | 72 个，24px viewBox，与现有图标同名 |
| 品牌图标 | `icons/brand/` | 6 个，含应用图标、初号机、初音、AT 立场、同步波形 |
| SVG Sprite | `icons/sprite.svg` | 77 个 symbol；应用图标另交独立 SVG |
| 品牌横排字标 | `svg/wordmark.svg` | 800 × 176，透明底 |
| 图标总览 | `svg/icon-contact-sheet.svg` / `images/icon-contact-sheet.png` | 1600 × 1310 |
| 应用图标 | `icons/brand/app-icon.svg` / `images/app-icon-1024.png` | SVG + 1024px RGBA PNG |
| 平台应用图标 | `icons/app/` | macOS ICNS、Windows ICO、10 个 iconset PNG |
| 配色与适配文件 | `theme/` | CSS、tokens、Monaco、terminal JSON |
| 图层映射 / 检查 | `layers.json`、`manifest.json`、`QA.md` | 图层清单、SHA-256、验证结果 |
| 原始设计提示词 | `prompts.md` | 两个内置 image_gen 请求的完整提示词 |

## 图层说明

### UI 母版 / 12 层

1. 窗口底板
2. 主插画：完整 AI 主视觉，**只是一张嵌入 PNG**
3. 功能面板
4. 面板分隔与边角
5. 标题栏与同步岛
6. 导航图标
7. 资源管理器
8. 欢迎页标题与 HUD
9. 启动按钮
10. 对话内容与结果卡
11. 消息输入与动作
12. 状态栏

### 纯矢量主题 / 14 层

背景、工程网格、AT 立场环、EVA 轮廓、紫色装甲、机体灯光、初音后发与双马尾、驾驶服、脸部表情、刘海与侧发、耳机与麦克风、轮廓光、HUD、主题标题。

**分层边界：**纯矢量插画是手工路径重设计的几何动漫版本，和生成的完整插画并非逐线一致。生成 PNG 没有被伪装成可编辑人物分件。`ui-skin-vector-only.svg` 使用这个矢量版本；`ui-skin-layered.svg` 使用完整 PNG 主视觉。PNG 效果图与 SVG 母版是同一设计方向的不同表现，不是像素级复制。

## 图标与工程对接

- 已逐一比对本项目 `sweet-code-desktop/src/renderer/src/assets/icons/` 的 72 个文件名。
- UI 图标的主体继承 `currentColor`；文件类型使用对应的主题色；小型同步标记可通过 `--eva-icon-accent` 覆盖。
- 每个 SVG 包含 `primary-shape` 与 `sync-accent` 分组，方便单独调整。
- 现有 `Icon.tsx` 采用内联 SVG，因此可保持按文字状态变色。不要使用 `<img>` 来预览依赖 `currentColor` 的 UI 图标：外部 SVG 无法继承宿主文字颜色。预览页面已经改用内联 SVG。
- 安装包图标文件只是独立导出，**没有覆盖当前应用图标**。

### 可选主题 CSS

`theme/sikeoop-eva-miku.css` 按当前 `theme.css` 的变量名编写，并使用 `:root[data-sikeoop-theme="eva-miku"]` 限定作用域。

后续接入时，保留整个资产包目录结构，在现有主题 CSS 之后导入此文件，并设置：

```js
document.documentElement.dataset.sikeoopTheme = 'eva-miku';
```

关闭主题时删除该 attribute。CSS 已覆盖实际的 `.tree-row.active`、`.activitybar button.on`、`.composer-box` 和 `.editor-empty`，并只在空白欢迎页添加插画；**代码正文与聊天内容不铺角色壁纸**。

`monaco-theme.json` 与 `terminal-theme.json` 是分别交付的主题配置，需要调用方注册/加载后才生效。它们尚未写入桌面应用。效果图中的欢迎页标题、三个启动卡和头像属于设计方案；单独加载 CSS 并不会自动创建这些控件。

## 复现与验证

`tools/build_assets.py` 只重建矢量与静态预览页面，不会重新请求图片模型。两个已交付的生成 PNG 是它的输入。

本机已使用 Codex 随附 Python、Node 与 sharp 运行：

```sh
"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3" tools/build_assets.py
"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" tools/render_assets.mjs
"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3" tools/verify_assets.py
```

普通环境：Python 3 + Pillow；Node.js + sharp。`SIKEOOP_NODE_MODULES` 可指向已经安装 sharp 的模块目录。macOS 可用 `iconutil -c icns icons/app/sikeoop-eva-miku.iconset -o icons/app/sikeoop-eva-miku.icns` 重建 ICNS。

## 当前完成状态

完成：图片、真实分层 SVG、完整图标、平台图标、配色文件、离线预览、XML/尺寸/数量/对比度/浏览器开关验证。

未做：替换正式应用文件、修改应用代码、构建安装包、启用实际运行中的皮肤。此交付是设计资产包，不是已上线皮肤。
