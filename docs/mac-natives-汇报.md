# mac-natives 汇报：macOS Intel 版补 x64 原生模块

日期：2026-10-11

## 结论

脚本写好并接进了打包流程，但**一次都没有运行过**：运行它要联网从 npm 下载 3 个包，我问了用户，用户选了「先不跑」。所以 Intel 版是否真的修好，要等下一次 `npm run dist:mac` 才知道。

- 改动只有两处：新增 `sweet-code-desktop/scripts/mac-natives.mjs`，改了 `package.json` 里的 `dist:mac` 和 `dist:all` 两条命令。
- 没有重新打包，没有上传，没有 git 提交，没有联网，没有动 `package-lock.json`。
- `npm test`：311 个全过。
- `npm run typecheck`：**没过，1 个错误，不是这次改动引起的**（见「类型检查」一节）。

第二件事（前端写死的「60MB」）：查过了，没有，不需要改。

## 问题确认

在现有的 Intel 版产物（`dist/mac/sikeoop.app`）里逐个看了原生文件的芯片架构：

| 模块 | Intel 版里现有的 | 结论 |
| --- | --- | --- |
| `@arkts/project-detector` | 只有 `darwin-arm64` | 缺 x64 |
| `@ohos-rs/oxk` | 只有 `darwin-arm64` | 缺 x64 |
| `@napi-rs/canvas` | 只有 `darwin-arm64` | 缺 x64 |
| `node-pty` | `darwin-x64` 和 `darwin-arm64` 都有 | 正常 |
| `uiohook-napi` | 两种都有 | 正常 |
| `trash` | 一个文件同时支持两种芯片 | 正常 |

所以缺的确实只有你说的这三个。

## 做了什么

### `scripts/mac-natives.mjs`

做法和 `win-natives.mjs` 一样：用 `npm pack` 从仓库取包，解压到 `node_modules` 里对应的位置。有三处不同：

- **两种芯片都补**：`darwin-arm64` 和 `darwin-x64` 都检查，缺哪个补哪个。在 Apple 芯片的机器上只会补 x64；将来换到 Intel 机器上打包，会补 arm64。
- **版本不写死**：从已安装的父包（比如 `@ohos-rs/oxk`）的 `optionalDependencies` 里读它要求的版本。父包升级后脚本不用跟着改，原生文件和 JS 的版本也不会错开。已有的副本版本不对时会替换。
- **解压后检查**：包名、版本对得上，并且里面确实有 `.node` 文件；不对就删掉并报错，不会留一个半成品让打包器带走。

按现在 `node_modules` 的状态，它会取这三个包（离线算出来的，没有真的去取）：

```
@arkts/project-detector-darwin-x64@1.1.3-alpha.29
@ohos-rs/oxk-darwin-x64@0.2.2
@napi-rs/canvas-darwin-x64@1.0.10
```

三个 arm64 的已经在了，会跳过。

### `package.json`

```
"dist:mac": "node scripts/mac-natives.mjs && electron-vite build && electron-builder --mac",
"dist:all": "node scripts/win-natives.mjs && node scripts/mac-natives.mjs && electron-vite build && electron-builder --win --mac"
```

`dist:win` 没动。

## 为什么认为这样能进安装包

没有实测，依据是现有产物：`win-natives.mjs` 用同样方式解压进去的 `@arkts/project-detector-win32-x64-msvc` 和 `@ohos-rs/oxk-win32-x64-msvc`，在现有的两个 mac 版产物里都能找到。说明打包器会把 `node_modules` 里这类手动解压的包一起带上，放在 `app.asar.unpacked` 下。x64 的包放进去后应该走同一条路。

运行时由这三个包自己的加载代码按当前芯片选择对应的包，这部分不需要改。

## 没有验证的地方

1. **脚本没有运行过。** `node --check` 通过了语法检查，仅此而已。
2. **这三个 x64 包在 npm 上是否存在、版本是否对得上，没有查。** 包名和版本来自父包自己的 `optionalDependencies`，按理是有的。
3. **装进去后 Intel 版的 ArkTS 检查是否真的能用，没有验证。** 需要重新打包后在 Intel Mac 上（或用 Rosetta）试一次。

建议下次打包时留意脚本的输出：正常会打印三行 `mac-natives: <包名>@<版本>`。打包后可以用下面的命令确认 Intel 版里有 x86_64 的文件：

```
find dist/mac/sikeoop.app/Contents/Resources/app.asar.unpacked -name "*darwin-x64*.node" -exec lipo -archs {} \;
```

## 需要知道的两点

- **第一次 `dist:mac` 需要联网**，之后包已经在 `node_modules` 里，脚本直接跳过。但只要再跑一次 `npm install`，npm 会把不属于本机芯片的包清掉，下次打包脚本会重新取。这和 `win-natives.mjs` 的情况一样。
- **每个安装包都会带上别的平台的原生文件。** 现在 mac 版里已经带着 Windows 的 `.node`，Windows 版里带着 mac arm64 的。这次之后，两个 mac 包各自多带对方芯片的三个包，估计每个包多 30 MB 左右（按 arm64 那三个的大小算：1.2 MB、5.4 MB、27 MB）。要按平台剔除得改 electron-builder 的配置，这次没做。

## 类型检查

`npm run typecheck` 退出码 2，1 个错误：

```
src/renderer/src/dev-mock.ts(2256,9): error TS2740: Type '{ mobileState: ...; ... 322 more ...; }' is missing the following properties from type 'SweetApi': pvList, pvCreate, pvGet, pvRunStep, and 10 more.
```

原因：`src/shared/types.ts` 和 `src/preload/index.ts` 在 11:59 加了 `pv*` 这组接口，`dev-mock.ts` 还没有补上对应的模拟实现。这是正在进行的 pv 工作，不是这次改动造成的；你也说了不要动 `src/renderer`，所以我没有改。主进程那一半（`tsconfig.node.json`）单独跑是 0 错误。

`npm test` 末尾：

```
ℹ tests 311
ℹ pass 311
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

## 第二件事：扩展包大小提示

在 `src/renderer`、`src/shared`、`src/preload`、`docs`、`更新公告`、`sikeoop-site` 里搜了「60MB / 60 MB / 60M / 60 兆」，没有任何结果。前端没有写死的大小提示，报错文字来自主进程 `src/main/extensions/service.ts`，那里已经是「超过 512MB」。所以没有需要改的地方。

顺带看到一点，供你判断：下载时整个扩展包是先读进内存再解压的。上限提到 512MB 后，下载一个接近上限的包会占用大约两倍于包大小的内存。我没有改这个文件。
