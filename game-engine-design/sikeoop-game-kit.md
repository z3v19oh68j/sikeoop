# sikeoop 游戏开发套件：用聊天做网页游戏（总方案）

> 2026-10-10，第 1 版。**方向再调整**：不做可视化编辑器，也不先自研引擎。游戏靠聊天做出来；sikeoop 把需要的库、插件、模板和测试工具准备好，AI 在需要的时候自己装、自己用。
> 本文取代 `jingxuan-engine.md` 成为总方案。鲸渲的渲染设计（`webgpu-engine.md`）保留，变成以后的一个可选「特效库」（见第 8 节）。

## 1. 一句话定位

**在 sikeoop 里说一句话，AI 就挑合适的游戏库、自己装好、写出能玩的游戏，再自己试玩、截图、修 bug，最后发布成一个链接。**

人负责提需求、玩、说哪里不对；选库、装库、写代码、测试都由 AI 完成。

## 2. 为什么这样更对

- 可视化编辑器是给「人亲手做游戏」准备的。现在主力已经是 AI，人只需要描述和反馈，编辑器反而成了中间多出来的一层。
- 现成的库已经很成熟（Three.js、PixiJS、Phaser、Babylon.js……）。AI 做游戏真正卡在三个地方，都不在引擎上：
  1. **选错库或用错 API**：AI 凭印象写，版本对不上，接口是编出来的。
  2. **装不上**：国内网络、版本冲突、原生依赖编译失败。
  3. **看不见画面**：写完不知道好不好玩、卡不卡、有没有报错。
- 所以 sikeoop 要做的是**把这三件事替 AI 兜底**，而不是再造一个引擎。

## 3. 套件由哪几部分组成

```
你：「做个躲弹幕的小游戏，爆炸要炫」
            │
            ▼
  ① 游戏库目录（选型）──→ ② 自主安装（固定版本、国内镜像）
            │                         │
            ▼                         ▼
  ③ 项目模板（带试玩接口）──→ AI 写代码
            │
            ▼
  ④ 试玩与检查工具（截图、按键、帧率、报错、inspect）──→ 发现问题 → 改
            │
            ▼
  ⑤ 素材工具（图片、音效、修图） ⑥ 一键发布（你的服务器）
```

### ① 游戏库目录（内置在 sikeoop 里）

一份经过挑选的库清单，随 sikeoop 一起发布、一起更新。每一条都写清楚：

| 字段 | 内容 |
|---|---|
| 用途和适用场景 | 比如「2D 动作、平台跳跃 → Phaser」「大量 2D 精灵和特效 → PixiJS v8」「3D 场景 → Three.js WebGPU」 |
| 固定版本 | 我们测过的版本，带完整性校验值。AI 装的永远是这个版本，不会自己挑一个 `latest` |
| 地址 | 国际 · 官方 npm 页面、国际源码仓库（GitHub）；见第 3.1 节 |
| 使用说明（技能） | 给 AI 看的简明用法：初始化写法、常用 API、常见坑。保证 AI 写的代码和装的版本对得上 |
| 协议 | MIT / Apache 等，装之前就显示出来 |
| 渲染后端 | WebGPU / WebGL，以及在 M4 Mac 上测过没有 |

第一批收录（第一阶段只做 ★ 的）：

| 类别 | 库 |
|---|---|
| 2D 框架 | ★ Phaser、★ PixiJS v8、Excalibur、Kaplay |
| 3D | ★ Three.js（WebGPU）、Babylon.js、PlayCanvas 引擎 |
| 物理 | ★ Rapier、matter.js |
| 声音 | ★ Howler.js、Tone.js |
| 其他 | GSAP（补间动画）、bitECS（ECS）、Colyseus 客户端（联机）、lil-gui（调参面板） |

### ② 自主安装

- AI 调用 `game_kit_install`，装的是目录里登记的库和固定版本，用的是项目自己的包管理器（npm 或 pnpm）。
- **下载源默认是国际官方源**：`https://registry.npmjs.org/`（标为「国际 · 官方」）。目录里每个库的地址都写的是国际地址，见第 3.1 节。
- 国内镜像只作为**可选项**：`https://registry.npmmirror.com/`（标为「国内镜像 · 可选」）。要在设置里手动打开才会用；打开后，界面上和安装记录里都会写明这次是从哪个源装的。
- 不管从哪个源装，都用目录里记录的完整性校验值（`integrity`）核对；对不上就拒绝安装。所以换成镜像源也不会装到被改过的包。
- 安全规矩：
  - **只有目录里的库可以由 AI 自主安装**，目录之外的包照常要你审批；
  - 默认不执行安装脚本（`--ignore-scripts`），确实需要脚本的库在目录里单独标出来；
  - 懒人模式下，目录里的库直接装；普通模式下，同一个项目只问你一次。
- 装完自动跑一次最小示例，确认能用再往下写。

### 3.1 库地址一览（全部是国际地址）

2026-10-10 从国际官方 npm 源核实：包名都存在，下面写的是当时的最新版本和协议。目录里最终锁定哪个版本，以我们在 M4 上测过的为准。

| 库 | npm 包名 | 最新版本 | 协议 | 国际 · 官方 npm 页面 | 国际 · 源码（GitHub） |
|---|---|---|---|---|---|
| ★ Phaser | `phaser` | 4.2.1 | MIT | https://www.npmjs.com/package/phaser | https://github.com/phaserjs/phaser |
| ★ PixiJS | `pixi.js` | 8.22.0 | MIT | https://www.npmjs.com/package/pixi.js | https://github.com/pixijs/pixijs |
| ★ Three.js | `three` | 0.186.1 | MIT | https://www.npmjs.com/package/three | https://github.com/mrdoob/three.js |
| ★ Rapier 2D | `@dimforge/rapier2d` | 0.21.0 | Apache-2.0 | https://www.npmjs.com/package/@dimforge/rapier2d | https://github.com/dimforge/rapier.js |
| ★ Rapier 3D | `@dimforge/rapier3d` | 0.21.0 | Apache-2.0 | https://www.npmjs.com/package/@dimforge/rapier3d | https://github.com/dimforge/rapier.js |
| ★ Howler.js | `howler` | 2.2.4 | MIT | https://www.npmjs.com/package/howler | https://github.com/goldfire/howler.js |
| Excalibur | `excalibur` | 0.32.0 | BSD-2-Clause | https://www.npmjs.com/package/excalibur | https://github.com/excaliburjs/Excalibur |
| Kaplay | `kaplay` | 3001.0.19 | MIT | https://www.npmjs.com/package/kaplay | https://github.com/kaplayjs/kaplay |
| Babylon.js | `@babylonjs/core` | 9.30.0 | Apache-2.0 | https://www.npmjs.com/package/@babylonjs/core | https://github.com/BabylonJS/Babylon.js |
| PlayCanvas 引擎 | `playcanvas` | 2.23.2 | MIT | https://www.npmjs.com/package/playcanvas | https://github.com/playcanvas/engine |
| matter.js | `matter-js` | 0.20.0 | MIT | https://www.npmjs.com/package/matter-js | https://github.com/liabru/matter-js |
| Tone.js | `tone` | 15.1.22 | MIT | https://www.npmjs.com/package/tone | https://github.com/Tonejs/Tone.js |
| GSAP | `gsap` | 3.15.0 | ⚠️ GSAP 标准许可（免费，但**不是开源协议**） | https://www.npmjs.com/package/gsap | https://github.com/greensock/GSAP |
| bitECS | `bitecs` | 0.4.0 | ⚠️ MPL-2.0（修改它本身的文件要开源） | https://www.npmjs.com/package/bitecs | https://github.com/NateTheGreatt/bitECS |
| Colyseus 客户端 | `colyseus.js` | 0.16.22 | MIT | https://www.npmjs.com/package/colyseus.js | https://github.com/colyseus/colyseus.js |
| lil-gui | `lil-gui` | 0.21.0 | MIT | https://www.npmjs.com/package/lil-gui | https://github.com/georgealways/lil-gui |

- 安装地址统一是国际官方源 `https://registry.npmjs.org/<包名>`。
- 标 ⚠️ 的两个，安装前要把协议的意思告诉你。GSAP 的许可条款要另外看清楚，所以默认推荐用不受限制的补间写法代替它。
- 目录文件里每条都存这些字段：`name`、`npm`、`version`、`integrity`、`license`、`registry`（国际 · 官方）、`homepage`、`repository`。

### ③ 项目模板

AI 调用 `game_new` 新建项目，可以选：
- Phaser 2D；
- PixiJS v8 + Rapier；
- Three.js WebGPU；
- 空白 Vite + TypeScript。

每个模板都自带：
- Vite 开发服务器，sikeoop 会自动在内置浏览器里打开它；
- **试玩接口 `window.__game`**：
  - `inspect()`：帧率、实体数、报错、当前关卡和分数；
  - `seed(n)`：固定随机数；
  - `step(帧数)`：让游戏走若干帧后停下；
  - `pause()`：暂停。
  - AI 读这些就知道游戏现在是什么状态；
- 固定时间步长的主循环：同样的输入每次跑出同样的结果，可以用来复现 bug。

### ④ 试玩与检查工具（在现有内置浏览器工具上扩展）

| 工具 | 做什么 |
|---|---|
| `game_play` | 按住或连按按键、移动和点击鼠标，可以写成一串带时间的操作，比如「按住右键 2 秒，同时每 0.3 秒按一次空格」 |
| `game_frames` | 连续截几帧，一次交给看图模型，看动画对不对、有没有闪烁 |
| `game_perf` | 采样 5 秒帧率和最长的卡顿帧，读取 WebGPU 和 WebGL 的报错 |
| `game_inspect` | 读 `window.__game.inspect()` |
| `game_replay` | 用固定种子和录下的操作重放一遍，验证 bug 修好了没有；可以存成「测试与回归」里的检查项 |

### ⑤ 素材工具（第二阶段）

- 图片：接一个画图服务（需要你选服务商和 Key），生成角色、背景、图标。
- 修图：PhotoCraft，负责裁切、抠图、切精灵图、压缩。
- 音效：接一个音效生成服务，或者用内置的程序化音效生成器（类似 sfxr，不用 Key）。
- 素材生成好之后，AI 自己放进 `assets/`，并改好引用。

### ⑥ 一键发布（第二阶段）

- `game_publish`：打包成静态网页，传到你的服务器，比如 `play.sikeoop.modgert.online/<名字>`，返回一个可以分享的链接。
- 每次发布前都要你确认。

## 4. 一次完整的对话

> 你：做一个躲弹幕的小游戏，爆炸要炫。
>
> AI：
> 1. 选 PixiJS v8（大量精灵）+ 一个粒子库；新建项目，装好库。
> 2. 写玩家移动、弹幕生成、碰撞、计分。
> 3. 自己试玩：按住方向键 10 秒，截 4 帧，读 `inspect`。发现弹幕穿过玩家没有判定，修好。
> 4. 测帧率：同屏 2000 颗弹幕时掉到 45 帧，改成对象池复用，回到 60 帧。
> 5. 告诉你：「好了，在右边浏览器里能玩。」
>
> 你：爆炸再大一点，加个屏幕震动。
>
> AI：改完，用同一段操作重放，截图给你看前后对比。

## 5. 不做什么

- 不做可视化编辑器，不做事件表或节点图。
- 现阶段不自研游戏引擎。鲸渲以后作为可选的特效库，见第 8 节。
- 不把所有库都塞进 sikeoop 安装包：目录随 sikeoop 发布，库本身按需下载，安装包不会变大。
- 暂不做微信和抖音小游戏平台。

## 6. 开发初期的平台

和之前一样，只针对 macOS M4 以上芯片；游戏跑在 sikeoop 内置浏览器和 Chrome 里。

## 7. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **G0 目录和安装**（约 3–4 天） | 游戏库目录（先做 ★ 的 7 个）、`game_kit_install`（镜像、固定版本、不执行安装脚本、审批规则）、每个库的使用说明技能 | AI 能根据一句需求选对库、装好，并跑通最小示例 |
| **G1 模板和试玩**（约 1 周） | `game_new` 的 4 个模板（带 `window.__game`）、`game_play` / `game_frames` / `game_perf` / `game_inspect` / `game_replay` | 一句话做出一个能玩的小游戏；AI 能自己发现并修好一个故意埋进去的 bug |
| **G2 素材和发布** | 画图和音效接入、PhotoCraft、程序化音效、`game_publish` | 游戏有像样的素材，并能发布出一个链接 |
| **G3 鲸渲特效库（可选）** | 按 `webgpu-engine.md` 做 WebGPU 粒子和 shader 特效，作为目录里的一个库 | 用 PixiJS 或 Three.js 做的游戏也能加上百万粒子特效 |

## 8. 鲸渲还做不做

- 不作为主线。先用套件把「聊天做游戏」跑通；跑通以后，再看用户最想要的炫酷特效，现有库能不能满足。
- 如果满足不了（最可能的就是 GPU 百万粒子），就按渲染设计稿做鲸渲 P0 + P1，做成一个**能接进 Three.js 和 PixiJS 的特效库**，收进目录。之前写的互通设计正好用得上。

## 9. 需要你决定的事

1. **第一批库**：就按 ★ 的 7 个（Phaser、PixiJS、Three.js、Rapier、Howler 等），还是你想加减？
2. **第一个验收游戏**：比如「躲弹幕」或「打砖块」。
3. **素材生成服务**（G2 才需要）：画图和音效用哪家，需要你提供 Key。
4. **谁来做**：工具和安装逻辑是后端（Codex 军团），模板和使用说明可以由我来写。
