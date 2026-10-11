# sikeoop Android implementation progress

更新时间：2026-10-09（Asia/Seoul）

## 开工检查

- 已按任务书顺序读取 PRD、技术设计 §1–15、全部页面线框和 `sweet-code-desktop/README.md`。
- 桌面仓库 `sweet-code-desktop/` 开工前已有大量未提交修改/新增/删除；没有还原、清理或覆盖这些改动。本次改动仅在 Mobile/Protocol 新路径以及协议类型的增量行内。
- 未 git push、未发布、未部署，也未修改项目目录外文件或系统设置。

## P0：协议与工程骨架

已实现：

- 桌面共享 JSON-RPC v1：请求/响应/事件、十个移动端 RPC、移动端视图、审批/快照/差异类型与错误码。
- 扩展 `ChatRequest.origin`、`approval_request.humanOnly`、`remote_message.from` (`desktop|wechat|mobile`)。
- 26 个类型约束的协议样例和 JSON 导出器；Node、Kotlin 都读取同一批 JSON 样例。
- `protocol/CRYPTO.md` 定义 P-256 ECDH、握手 transcript、HKDF、AES-GCM nonce/AAD、计数器、配对过期与撤销规则；`crypto-vectors.json` 含 ECDH 中间值、HKDF key 和 AES-GCM 帧。
- Node 与 Kotlin AES-GCM/HKDF 实现；Android 端还实现 PKCS#8/SPKI P-256 ECDH。添加原生 Kotlin/Compose 工程、Gradle wrapper、link 状态/动作接口、协议帧模型与测试。
- Manifest 目前只增加正常权限 `INTERNET`（远程连接所需）；没有添加相机、通知、前台服务等运行时权限。`allowBackup=false`、明文流量关闭。

验证：

- `node --test test/protocol/*.test.mjs`：5/5 通过（协议契约覆盖、Node ECDH/HKDF/AES-GCM 向量、错误方向/重放/篡改拒绝）。
- `mobile/android`: `./gradlew assembleDebug test` 首次受沙箱限制，Gradle 默认尝试写入只读的 `~/.android/debug.keystore`。改用项目内 `GRADLE_USER_HOME` 和 `ANDROID_USER_HOME` 后通过；Kotlin 单测 5/5、debug APK 打包成功。只写入项目目录，没有动 `~/.android`。SDK 仍提示本机命令行工具不认识 SDK XML v4，构建不受影响。
- `sweet-code-desktop`: `npm run build` 通过；`npm run typecheck` 仍报开工前已存在的两个 `SweetApi.session` 错误：`src/preload/index.ts:5` 和 `src/renderer/src/dev-mock.ts:509`，没有新增错误。
- Node 的 JSON/加密测试全部通过；Android 用同一测试向量通过。

补充验证：`sweet-code-desktop/node_modules/typescript/bin/tsc --noEmit -p ../protocol/tsconfig.json` 通过，协议 fixture 源码现在有独立、可重复的严格类型检查配置。

P0 状态：**实现并通过构建/测试**。

## P1：进行中（本轮已落地的底座）

本轮新增：

- `relay/src/room-hub.mjs` + `relay/src/node-server.mjs`：本地 Node WebSocket 中继、房间令牌校验、最多一台桌面/一台手机、presence、1 MiB 上限、速率限制、不缓存/不记录应用帧。默认只监听 `127.0.0.1`；没有 Cloudflare 配置，也没有部署。
- `src/main/mobile/event-broadcaster.ts`：替换 index.ts 里的单一 `remoteTap`，微信和未来手机网关可独立订阅；微信现已迁移到该总线。
- `AgentSession.mobileSnapshot()`：提供克隆后的最近对话、本轮事件 cursor、计划、待审批/提问；待审批保存 humanOnly 和创建时间。
- `src/main/mobile/rpc-dispatcher.ts`：认证之后使用的 RPC allowlist dispatcher；远程任务强制 lazy、检查 BUSY、操作逐条响应、不暴露任意文件/终端方法。用户 IPC 的 `chat:send` 会去掉 renderer 传来的伪造 `origin`，只有 gateway dispatcher 可注入手机身份。
- 手机来源的撤不回操作可走 human-only 审批路径：单项确认、10 分钟超时拒绝、`approve_all` 不得批准 humanOnly；Lazy stop 硬拦截仍优先。
- `relay/README.md` 写了本地启动、安全边界与测试方式。

验证：

- `node --test test/protocol/*.test.mjs test/relay/*.test.mjs`：16/16 通过，覆盖 fixture、跨端加密向量、事件广播、RPC allowlist/lazy/BUSY/审批、relay WebSocket 路由/尺寸/权限。
- `npm run build`：通过。
- `npm run typecheck`：仍只有基线的两条 `SweetApi.session` 错误；分别单独跑 node/web tsc 确认，Mobile 相关文件没有新增错误。
- Android 构建/测试仍是 P0 那次通过，本轮没有改 Android 源码。

**P1 还不能端到端使用**：尚无桌面 `MobileGateway` 实例把 Relay、crypto handshake、RPC dispatcher 和 AgentSession 接起来；设备密钥持久化/二维码一次性配对/桌面允许弹窗、桌面「手机」页、Android 扫码/WebSocket/Keystore/前台服务/通知和实际首页/待办/回执 UI 还未完成。当前 Android Compose Activity 只是 P0 占位页。Relay 当前仅是本地开发服务，不是 Cloudflare/线上中继。终端 Agent、微信兜底、撤销 diff 和真机体验也未端到端验收。

## 下一步

1. 写桌面 `MobileGateway`：安全设备注册/撤销、二维码与五分钟一次性配对、P-256 握手与签名验证、加密收发/重放窗口、只在用户启用后连中继。
2. 接 `MobileRpcDispatcher`、`AgentSession.mobileSnapshot` 和 `remoteEvents` 到 `index.ts`/preload；接 terminal approvals/diff/微信离线兜底；桌面端增加「手机」页和设备批准弹窗。
3. Android 实现同一握手、WebSocket、Keystore、扫码配对、真实 Compose 首页/对话/待办/改动/设置、通知和仅任务期间的前台服务。
4. 本地 Node relay + 桌面 + 模拟器完整联调；最后由用户做真机验收。Cloudflare 部署、git push、发布都必须等用户明确点头。

## P1：电脑端手机网关（2026-10-10，主会话破例直接实现，不是 Codex）

已实现「下一步」第 1、2 条的后端部分：

- `src/main/mobile/handshake.ts`：CRYPTO.md 握手的电脑端（纯函数）。
- `src/main/mobile/store.ts`：电脑身份密钥和房间令牌用 safeStorage 加密存放（`userData/mobile/secrets.bin`，权限 600），已登记设备只存公钥。
- `src/main/mobile/gateway.ts`：
  - 连接中继，断线后退避重连；
  - 一次性二维码，5 分钟内有效；
  - 设备待确认 5 分钟，超时按拒绝处理；
  - 加密收发，坏帧直接断开会话；
  - 推送 `mobile.event` / `mobile.status`；撤销设备。
- `src/main/mobile/view.ts`：根据会话快照生成手机端用的 MobileView。
- 接进 `index.ts`：
  - `mobile:*` IPC；
  - `sessionDeps.mobileOnline`；
  - 启动和退出时开关网关；
  - 有手机等确认时，播放提示音并把窗口拉到前台。
- 接进 preload 和 dev-mock。
- `MobileGatewayState`、`MobilePairingQr` 和 SweetApi 方法写在 `src/shared/types.ts`。
- `protocol.ts` 增加了 `mobile.pairing` 通知和 `PAIRING_PENDING` 错误码。
- `protocol/PAIRING.md`：二维码、握手消息和握手后规则的准确格式。二维码里**新增了 `roomToken`**，原规范漏了它，手机进不了中继房间。

验证：

- `node --test test/mobile/gateway.test.mjs test/protocol/*.test.mjs test/relay/*.test.mjs`：19 项全部通过。新加的端到端测试会起真的本地中继，再模拟一台手机走完整个流程。
- `npm run build` 通过。
- 两个 tsc 都只剩原有的 `SweetApi.session` 报错。

还没做：

- 电脑上的「手机」页界面（IPC 已经可以直接调用）；
- 安卓端连接层：握手、WebSocket、Keystore；
- 两个安卓工程合并；
- 「终端 AI 待审批」列表（`agents.list` 的 `pending` 目前为空）；
- 吊销设备时不轮换房间令牌，被吊销的手机还能占住中继里唯一的手机位，直到它断开。
