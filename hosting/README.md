# sikeoop hosting — B5

独立 TypeScript Worker；D1 保存设备归属、站点 token 哈希、deploy、manifest、最后访问时间、举报和 IP 限流计数；R2 key 为文件 SHA-256。

## 仅本地运行

```sh
npm install
npm run typecheck
npm run db:local
npm run dev -- --ip 127.0.0.1 --port 8787
# 另开终端，仍在 hosting 内：
npm run smoke
```

配置只有本地占位资源，不配置 remote bindings，不执行登录、部署或创建线上资源。Wrangler 的本地 D1/R2 默认在 `.wrangler/` 持久化。npm 缓存和日志也限定在本目录。可参考 Cloudflare 本地说明：https://developers.cloudflare.com/workers/local-development/local-data/ 。

## 协议

实现任务清单第 5 节的六个接口，不增加必需字段。所有管理请求需要 43 位 base64url 设备 ID；站点管理另需 Bearer siteToken。创建仅返回一次原 token，数据库保存 SHA-256，不记录请求头。创建站点的限额用单条条件 INSERT 原子执行。

- POST `/v1/sites`：20 站/设备，超限 429 quota。
- POST `/v1/sites/:id/deploy`：验证 manifest；10MiB/站、5MiB/文件、指定后缀白名单；返回去重 missing。
- PUT `/v1/sites/:id/blobs/:sha256`：只允许上传该站 manifest 声明的 blob；流式读取有上限，校验真实长度和 SHA-256。
- POST `/v1/sites/:id/deploy/:deployId/commit`：验证全部 blob，再原子切换 active deploy；缺文件 400 server。
- DELETE `/v1/sites/:id`：立即下线，级联删除 deploy/manifest；不删除其他站点可能共享的 R2 blob。
- POST `/v1/report`：不需设备和 token；IP 哈希，固定小时窗口 5 次；reason 最多 2000 字符。

静态 GET/HEAD：线上 `<siteId>.<BASE_DOMAIN>`；LOCAL_DEV=true 时同时开放 `/s/<siteId>/`。不对上传站点开放 API 路由，API 应绑定独立 api 子域。`/` 对应 index.html。HTMLRewriter 在 body 尾部注入“用 sikeoop 制作 · 举报”，举报页面位于 API 主机 `/report`，不会把用户输入拼进 HTML。静态 MIME 不从上传头信任，统一 nosniff、form-action self、base-uri self、禁用 object、限制权限、禁止 iframe 嵌入。无缓存保证访问计时经过 Worker。

每日 cron 删除 30 天未访问站点及非活跃旧 deploy，清理过期限流行。成功 commit 更新计时，未发布站点从创建开始计时。删除站点后共享 R2 内容保留：未实现独立、并发安全的 blob GC；上线前需制定存储预算/清理机制。举报记录保留待人工处理，不自动下线。

## 约束与待确认

- 协议 MB 解释为 MiB；额外要求 index.html、manifest 1–10000 文件、JSON 最多 2MiB，拒绝不安全路径、重复路径、同哈希不同长度。
- 未规定鉴权/校验错误的专用 PublishErrorCode，统一使用 server；后缀/路径使用 blocked_file。
- 协议没有续期接口；目前成功访问及 commit 都更新计时，未擅自新增接口。
- 无 body 元素的 HTML 在文档末尾注入页脚；已有 body 的文档在 body 内尾部注入。
- 匿名 deviceId 可自行换值，20 站不是可信身份强限制。协议未规定 pending deploy 数量/频率和累计历史 blob 配额；线上需另外设计 API 防滥用。
- 生产 LOCAL_DEV 必须为 false，确认专用域名、API/通配子域 DNS 与 Worker 路由、账号/R2 bucket/D1 database IDs、迁移和 cron；任何线上操作都需用户明确批准。
- CORS 未开放：面向桌面主进程 HTTP 客户端；若要浏览器跨域发布，需要先定稿 Origin 策略。
