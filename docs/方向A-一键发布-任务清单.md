# 方向 A：说一句话 → 做出网页 → 一键发布

日期：2026-10-10　状态：已开工（10-10 用户同意 D1–D4 按建议执行；D2 域名暂用 sikeoop.site 占位，部署前再确认）

> **2026-10-10 暂停**：用户决定先收拢多智能体调度核心。暂停时进度：
> - 已完成：B1 打包、B2 扫描、B3 发布客户端、B4 IPC、B6 新建网页模板、F1–F5；`hosting/` 代码完成且 `tsc` 通过。
> - 未完成：本地 `wrangler dev` 未跑（需用户 `npm install-scripts approve workerd`）；Q1 E2E、Q2 安全审查、Q3 试用；F4 中“AI 建议发布”。
> - 待议：断网导致的孤儿站点（协议无幂等）、blob GC、pending deploy 配额、站点续期接口、建项目中途失败的半成品目录、资源静态提取局限、TOCTOU。

## 目标与验收

一个没碰过终端的新手，从打开 sikeoop 到拿到一个别人能打开的链接，**全程不超过 5 分钟**，不需要碰终端、不需要注册别的网站。

演示脚本（也就是最终验收用例）：
1. 打开 App，选“新建网页”模板（不用先建文件夹）。
2. 输入“帮我做一个奶茶店的介绍页，有菜单和地址”。
3. AI 写出页面，在原型画布里看到效果，再说一句“标题换成粉色”并确认改动。
4. 点“发布”，30 秒内拿到 `https://xxx.<域名>` 链接和二维码，手机扫码能打开。
5. 改一处再点“更新发布”，链接不变，内容更新。

## 0. 先要用户拍板的决策点

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 页面托管在哪 | ① sikeoop 自建托管（Cloudflare Worker + R2，统一域名，用户零注册）② 用户自己的 Cloudflare / Vercel 账号 | **①**，新手零门槛；接口按“发布目标”抽象，以后再加 ② |
| D2 | 域名 | 需要一个专用域名（如 `xxx.sikeoop.site`），不要和官网同域 | 用户提供 |
| D3 | 防滥用 | 匿名发布 / 设备 ID 限额 / 登录 | 先用**设备 ID + 限额**（每台 20 个站、单站 10MB），带“举报”入口 |
| D4 | 站点有效期 | 永久 / 30 天未更新回收 | 30 天未访问回收，App 内可续期 |

> 托管服务上线属于对外部署，按 relay README 的约定，部署前需要用户明确批准。

## 1. 接口约定（指挥官落地，两边开工前定稿）

已落地在 `src/shared/types.ts`（以代码为准）：`PublishTarget`、`PublishSource`、`PublishRequest`、`PublishRecord`（含 `source`）、`PublishWarning`（含 `message`、`blocking`）、`PublishScanResult`、`PublishErrorCode`（含 `cancelled`）、`PublishEvent`（scan 事件为 `{ type: "scan"; result }`）。

preload `window.sweet`：`publishScan`、`publishStart`、`publishCancel`、`publishList`、`publishUnpublish`、`onPublishEvent`、`createWebStarter`。IPC 通道前缀 `publish:`、`templates:`。

## 2. 任务清单

### 后端（Codex 军团）

| ID | 任务 | 文件归属 | 验收 |
|---|---|---|---|
| B1 | 打包器：把原型（`prototypes/<name>/`）导出成静态站。第一屏作为 `index.html`，`data-goto` 改成真实页面跳转，内联 `tokens.css` | 新建 `src/main/publish/bundle.ts` | 导出目录直接双击打开，页面之间能互相跳转 |
| B2 | 发布前扫描：文件大小、疑似密钥（`sk-`、`AKIA` 等）、`file://` 和绝对路径、丢失的资源。只允许发布白名单后缀 | 新建 `src/main/publish/scan.ts` | 放一个带假 Key 的文件，会返回 `secret` 警告并阻止发布 |
| B3 | 发布客户端：按内容哈希增量上传、进度事件、失败重试，`siteId` 存在项目 `.sikeoop/publish.json` 里 | 新建 `src/main/publish/client.ts`、`store.ts` | 第二次发布只上传改过的文件，链接不变 |
| B4 | IPC 注册 | `src/main/index.ts`（只加注册）、`src/preload/index.ts` | `npm run typecheck` 通过 |
| B5 | 托管服务：Worker 收上传 + R2 存文件 + 子域名路由 + 设备限额 + 举报接口 | 新建 `hosting/`（独立于 relay） | 本地 `wrangler dev` 跑通上传→访问；**部署要等用户批准** |
| B6 | “新建网页”模板：不选文件夹，直接在 `~/sikeoop 作品/<名字>` 建项目并带一个原型 | `src/main/workspace.ts` 附近新建 `templates.ts` | 首次启动三步内进入可对话状态 |

### 前端（Claude 军团）

| ID | 任务 | 文件归属 | 验收 |
|---|---|---|---|
| F1 | 欢迎页加“做一个网页”大入口，以及 3 个示例提示词（店铺页、个人主页、活动邀请函） | `renderer/src/` 欢迎页组件 | 新手不读说明也知道点哪 |
| F2 | 原型画布右上角“发布”按钮，再加发布面板：扫描结果 → 进度条 → 链接、复制、二维码 | `renderer/src/studio/Studio.tsx`、新建 `studio/PublishPanel.tsx` | 警告用大白话写（“这个文件里好像有密钥，发布后谁都能看到”） |
| F3 | “我的发布”列表：打开、更新、下线 | 新建 `renderer/src/publish/` | 下线前二次确认 |
| F4 | AI 侧：发布成功后，聊天里出现一张分享卡片；AI 能建议“要不要发布看看” | `ChatPanel` 卡片渲染 | 卡片不自动发布，只给按钮 |
| F5 | dev-mock 补发布接口的假数据 | `renderer/src/dev-mock.ts` | `npm run dev:web` 能完整走一遍 |

### 收尾

| ID | 任务 | 负责 |
|---|---|---|
| Q1 | 按第 1 节的演示脚本写 E2E 用例 | test-engineer |
| Q2 | 安全审查：发布扫描能不能被绕过、托管服务会不会被拿去放钓鱼页、上传接口限额 | security-qa |
| Q3 | 打出能安装的包，找 3～5 个新手试用，记录卡在哪一步 | 指挥官 + 用户 |

## 3. 顺序

```
第 1 周：D1–D4 拍板 → 接口定稿 → B1 B2 B6 ∥ F1 F2(用 mock) F5
第 2 周：B3 B4 B5(本地) ∥ F3 F4 → 联调 → Q1 Q2 → 用户批准部署 → Q3
```

## 4. 这两周不做

- 移动端、鸿蒙、relay、游戏引擎
- 归档模块剩余的两个极端情况（第四轮复审 A、B），记入待办
- 自定义域名、多人协作、后端 / 数据库类网站

## 5. 托管服务 HTTP 协议（第 2 周，指挥官定稿；B3 与 B5 唯一交界）

基础地址：环境变量 `SIKEOOP_PUBLISH_API`，默认 `https://api.sikeoop.site`（占位，部署前确认）；本地开发 `http://127.0.0.1:8787`。
设备身份：客户端首次运行生成随机 `deviceId`（32 字节 base64url），存 userData，所有请求带 `X-Sikeoop-Device`。
站点凭证：创建时返回 `siteToken`，只存在本机（加密，同 Key 存储方式），后续请求带 `Authorization: Bearer <siteToken>`。
所有错误统一返回 `{ "error": { "code": PublishErrorCode, "message": "给新手看的中文" } }`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/v1/sites` | `{}` | `{ siteId, siteToken, url }`；超过每设备 20 个站 → 429 `quota` |
| POST | `/v1/sites/:id/deploy` | `{ files: [{ path, sha256, size }] }` | `{ deployId, missing: [sha256] }`；总量 >10MB 或单文件 >5MB → 413 `too_big`；非白名单后缀 → 400 `blocked_file` |
| PUT | `/v1/sites/:id/blobs/:sha256` | 原始字节 | 204；服务端校验哈希与大小 |
| POST | `/v1/sites/:id/deploy/:deployId/commit` | `{}` | `{ url, fileCount, bytes }`；缺 blob → 400 `server` |
| DELETE | `/v1/sites/:id` | — | 204 |
| POST | `/v1/report` | `{ siteId, reason }` | 204（不需凭证，按 IP 限流） |

访问：线上 `https://<siteId>.sikeoop.site/<path>`；本地开发 `http://127.0.0.1:8787/s/<siteId>/<path>`。`/` → `index.html`。
响应头：`Content-Security-Policy` 禁止表单提交到外站（`form-action 'self'`），`X-Content-Type-Options: nosniff`，HTML 统一注入页脚“用 sikeoop 制作 · 举报”。
回收：30 天未访问的站点删除（cron）。siteId：10 位小写字母数字。
