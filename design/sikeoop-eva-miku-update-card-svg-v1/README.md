# sikeoop 自动更新卡 / EVA × 初音未来

按已生成的自动更新卡准备的 **90 个 SVG 文件**。所有 SVG 均不包含 PNG、JPEG、`<image>`、外部图片链接或 SVG 脚本。

## 先用这两个文件

- `auto-update-card.svg`：1360×912，整卡矢量母版，文字已转换为字形路径。接收端不需要安装字体。
- `auto-update-card-editable.svg`：1360×912，同构母版，标题、文案和按钮文字仍为可编辑 `<text>`。

`auto-update-card-on-canvas.svg` 是 1536×1024 的带展示背景版本。整卡之外的素材按本地坐标导出，便于直接使用。

双击 `index.html` 可离线浏览、下载素材、切换状态、开关图层；不需要服务器。`previews/asset-overview.svg` 是图标和核心控件的矢量总览。

## 文件分类

| 目录 / 文件 | 数量 | 内容 |
|---|---:|---|
| 整卡母版 | 3 | 字形轮廓版、可编辑文字版、展示画布版 |
| `layers/` | 14 | 同一 1360×912 画布注册的独立图层 |
| `icons/` | 21 + 1 Sprite | 关闭、文件夹、AI 网络、扳手、下载、重启、暂停、箭头、校验、警告、失败、时钟等 |
| `frames/` | 6 | 卡片底板、外框、标题栏、内容区、操作区、更新列表底板 |
| `components/` | 27 | 按钮状态、开关状态、进度条状态、徽章、三条更新项、自动下载设置行 |
| `decorations/` | 6 | AT 立场标、警戒短斜纹、同步支架、工程线、分隔线、标题条纹 |
| `typography/` | 5 | 字标、主标题、副标题、重启文字、英文更新标签，均已转轮廓 |
| `illustrations/` | 1 | 初音 × EVA 横幅，7004 个真实彩色路径 |
| `states/` | 5 | 已就绪、下载中、检查中、安装中、失败的完整 SVG |
| `previews/asset-overview.svg` | 1 | 核心控件与图标总览 |

PNG 文件仅位于 `previews/`，用于渲染检查与预览；并非 SVG 内嵌图片，也不是用来替代 SVG 的实际资产。

## 14 个图层

1. 卡片底板
2. 标题栏底板
3. 初音 × EVA 路径插画
4. 工程装饰与标题条纹
5. 品牌标题与关闭图标
6. 主标题与副标题
7. 版本与状态徽章
8. 内容面板与列表底板
9. 更新项文字与图标
10. 进度与完整性状态
11. 操作区底板
12. 自动更新设置与开关
13. 操作按钮
14. 外框、警戒标与序列号

母版中的图层采用具名 `<g>` 和 Inkscape 的 `groupmode="layer"`。独立导出的 `layers/*.svg` 不裁切到内容边界，全部维持原始注册画布，可原位叠加。

## 控件尺寸与状态

- 主按钮：360×76；常态、悬停、按下、禁用各一份。
- 次按钮：160×76；常态、悬停、禁用各一份。
- 另有两份不带文字的按钮底板，方便程序绘制本地化文字。
- 开关：72×36；开、关、禁用。
- 进度条：1054×14；背景轨道、64% 下载、100% 完成、37% 失败、检查中。
- 图标：20 个 24×24 小图标，以及一个 40×40 品牌晶体。
- 插画横幅：796×314，自带横幅背景，不是人物透明抠图。
- 完整状态卡：1360×912，示例进度和文字只属于设计状态，不是应用的实际更新结果。

`tokens.json` 提供配色、卡片尺寸和各控件在母版中的坐标。`assets.json` 提供文件、分类、尺寸、标签和图层 ID。

## 真实矢量与可编辑边界

UI 底板、边框、控件、图标和装饰是原生 SVG 几何。字体轮廓版使用真实字形路径，未在包内分发字体文件。

插画使用 [VTracer](https://github.com/visioncortex/vtracer) 将上一版生成图的横幅区域转换为彩色 SVG 路径。这不是把 PNG 包在 SVG 中，但也不是无损转码：渐变、发丝和面部细节会有路径近似。7004 个路径可以调整颜色和形状；它们按色块形成，而非手工按脸、发、衣服语义分件。整卡插画层可以独立隐藏或替换。

若要修改文案，用 `auto-update-card-editable.svg`；最终发布可再转为轮廓。独立静态控件、状态卡、字标和图层导出均已转轮廓，不依赖系统字体。编辑母版优先使用 PingFang SC，其他系统会按字体栈回退，文字外观可能不同。

## 接入方式

静态使用：按文件尺寸直接载入 SVG。程序控制进度、文案和点击行为时，建议使用空白按钮底板、进度轨道、图标与 `tokens.json`，由程序填充内容；不要把整张设计卡当成已经实现的交互逻辑。

Sprite 包含 21 个 symbol，图标 ID 与 SVG 文件名一致。静态图标使用主题青色；需要单色适配时，在内联 SVG 中调整 `stroke`。主按钮、状态色与装饰的颜色都是真实矢量属性。

## 重建与检查

已测试环境：Python 3.12 + `tools/requirements.txt` 内版本；Node.js + sharp。

```sh
python3 -m pip install -r tools/requirements.txt
python3 tools/build_assets.py
node tools/render_assets.mjs
python3 tools/verify_assets.py
```

本机 Python 环境位于 `$HOME/.cache/sikeoop-svg-tools/bin/python3`。Node 渲染器可使用 Codex 随附 sharp，或者通过 `SIKEOOP_NODE_MODULES` 指定已有模块目录。

重新描摹插画时：

```sh
python3 tools/retrace_header.py --source /absolute/path/to/auto-update-card.png
```

输入必须是此前交付的 1536×1024 自动更新卡概念图。`build_assets.py` 直接使用已交付的插画 SVG，不需要原始 PNG。字体查找默认兼容本机 macOS；其他系统可用 `--font-regular`、`--font-bold`、`--regular-index`、`--bold-index` 指定本地字体文件及 TTC 字体索引。

## 当前状态

已准备、实际渲染并检查 SVG 素材。未替换正式程序资源，未编写或执行自动更新流程。
