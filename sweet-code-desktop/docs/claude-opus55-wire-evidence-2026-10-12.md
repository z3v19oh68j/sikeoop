# Claude Opus 5.5 真机 wire 证据（2026-10-12）

抓包对象：本机 `claude` 2.1.296，`claude -p "say hi" --model opus`，实际发出 `model: claude-opus-5-5`。
方法：本地假上游只记不转发（`ANTHROPIC_BASE_URL=http://127.0.0.1:8444`，现有 OAuth 登录态），零上游消耗。
原始完整请求见同目录 `opus55-capture-2026-10-12.jsonl`（1 条记录，Authorization 已脱敏）。

## 请求行

`POST /v1/messages?beta=true`

## 请求头（原文）

```
Accept: application/json
Authorization: Bearer sk-ant-oat0…(已脱敏)
Content-Type: application/json
User-Agent: claude-cli/2.1.296 (external, sdk-cli, agent-sdk/0.3.295)
X-Claude-Code-Session-Id: 9278b4a3-2ed2-43cd-b421-98b135d2f344
X-Stainless-Arch: arm64
X-Stainless-Lang: js
X-Stainless-OS: MacOS
X-Stainless-Package-Version: 0.128.0
X-Stainless-Retry-Count: 0
X-Stainless-Runtime: node
X-Stainless-Runtime-Version: v26.3.0
X-Stainless-Timeout: 600
anthropic-beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,advisor-tool-2026-03-01,effort-2025-11-24,extended-cache-ttl-2025-04-11
anthropic-dangerous-direct-browser-access: true
anthropic-version: 2023-06-01
x-app: cli
```

注意：beta 共 13 个，与早前 haiku 抓包集合相同但顺序不同（本次 `claude-code` 打头，上次 `oauth` 打头）——顺序不敏感；`--model haiku` 那次发出的是 `claude-haiku-5-5`。

## 请求体（顶层，原文结构）

- 顶层 keys（仅此 10 个）：`context_management, max_tokens, messages, metadata, model, output_config, stream, system, thinking, tools`
- `model`: `claude-opus-5-5`（无日期后缀）
- `max_tokens`: `128000`
- `stream`: `true`
- `thinking`: `{"type":"adaptive","display":"omitted"}`
- `output_config`: `{"effort":"low"}`
- `context_management`: `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`
- `metadata`: 仅 `user_id`（内含 device_id / account_uuid / session_id 三件套 JSON 字符串）
- `messages`: 2 条（user + system）；`tools`: 214 个
- `system[0]`: `x-anthropic-billing-header: cc_version=2.1.296.cf4; cc_entrypoint=sdk-cli;`
- 体内**没有** `fallbacks`、`cache_control`、`temperature`、`service_tier` 顶层字段

## 与 sikeoop 当前发送的差异（站内 OAuth 登录分支）

| # | 真机 | sikeoop 现状 | 位置 | 可疑度 |
|---|------|--------------|------|--------|
| 1 | `thinking.display: "omitted"` | `"summarized"` | `src/main/providers/anthropic.ts:364` | 高 |
| 2 | 无 `fallbacks` 字段 | `fallbacks: "default"` | `anthropic.ts:375` | 高 |
| 3 | `context_management.edits: [{type:"clear_thinking_20251015", keep:"all"}]` | `clear_tool_uses_20250919` + trigger/keep/clear_at_least | `anthropic.ts:160-169` | 高 |
| 4 | 无顶层 `cache_control` | `cache_control: {type:"ephemeral"}` | `anthropic.ts:372` | 中 |
| 5 | `max_tokens: 128000` | `64000`（`MAX_TOKENS`） | `anthropic.ts:8` | 低（只影响长度） |
| 6 | 有 `metadata.user_id` | 无 | — | 低 |
| 7 | UA 尾带 `, agent-sdk/0.3.295` | 无后缀 | `claude-mimic.ts:51` | 低（版本会漂，不建议跟） |
| — | `model` 无日期后缀 | `NormalizeModelID` 原样透传 `claude-opus-5-5` | `claude-mimic.ts:92-99` | 无（已对） |

## 修复建议（给 Codex 的后端单，已备好未派）

只动主进程、仅 login 分支、仅 5.5 系（复用 `anthropic.ts:21-30` 的 `isClaude55SignedThinkingModel` 判定，覆盖 `claude-opus-5-5` / `claude-sonnet-5-5`）：thinking display 切 omitted、context_management 切 clear_thinking_20251015、去掉 fallbacks 与顶层 cache_control、max_tokens 提到 128000；4-5 系行为不动；补 `test/providers/` 断言；`npm run typecheck` + providers 全测通过；mock 验证，不打真实上游。
