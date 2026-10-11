# 任务书：sikeoop 安卓版（Codex 全权负责）

> 2026-10-09 交接。**这个任务从现在起由 Codex 全权负责**：技术细节、先后顺序、文件怎么分工，都由你定，不用再等用户一步步确认（用户不在电脑前）。

## 要做什么

按需求文档实现 **sikeoop 安卓版**，先做 A 线（手机遥控电脑）的 MVP。一次会话做不完没关系，按下面的顺序推进，做完多少如实写多少报告。

## 先读这些依据（按顺序）

1. `mobile-design/sikeoop-android-prd.md` —— 需求，只写「要做什么」
2. `mobile-design/sikeoop-android.md` —— 技术方案：架构、协议、安全、分期、验收清单（§13）。**注意：文中的路径默认相对于 `sweet-code-desktop/`**
3. `mobile-design/sikeoop-android-wireframes.md` —— 全部页面的线框
4. `sweet-code-desktop/README.md` —— 现有桌面版的结构

## 推进顺序

1. **P0 定接口**：`src/shared/protocol.ts`、`types.ts` 扩展（消息来源、`ChatRequest.origin`、`approval_request.humanOnly`、MobileView）、契约样例、加密规格与测试向量、Android 工程骨架（`mobile/android/`）。
2. **P1 遥控 MVP（走中继）**：电脑端手机网关（`src/main/mobile/`）、中继 Worker + Node 开发版（`relay/`）、电脑上的「手机」页、App 的界面与内核层。
3. **B 线本机技术验证**放在这两步之后，别抢主线。

每一步做完先验证再往下走；做不完就在断点处写报告。

## 红线（任何情况都不做）

- 不 git push、不发布、不部署线上（中继部署到 Cloudflare 也要等用户点头，本地 Node 中继开发版可以做）。
- 不改这个项目文件夹以外的文件；不动系统设置、密钥、`~/.codex`。
- 不删除、覆盖现有文件来腾地方；要大改现有代码，先在报告里写清楚为什么。
- 危险操作照懒人模式的规矩：拦下并写进报告，不要自己绕过去。

## 验证要求（没验证不许写「完成」）

- 桌面端：`cd sweet-code-desktop && npm run typecheck`、`npm run build`。
  （typecheck 现在本来有 2 个错误，在 `preload/index.ts:5` 和 `dev-mock.ts:509`，标准是**不新增**错误。）
- Android：工程建好后 `./gradlew assembleDebug`、`./gradlew test`。
- 每个阶段的报告里如实写：跑了什么命令、结果如何。

## 汇报

- 进度随手写进 `mobile-design/codex-report.md`（会话结束时必须有内容）。
- 最后写清楚：做了什么、改了哪些文件、怎么验证的、下一步是什么、哪些必须用户自己来（部署、推送、真机测试）。
