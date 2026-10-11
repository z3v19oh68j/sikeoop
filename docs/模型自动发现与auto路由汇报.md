# 模型自动发现与 auto 路由汇报

## 结果：完成

本次实现通用 OpenAI / Anthropic 协议模型发现、服务商级缓存、auto 动态选模和按列表顺序 failover。主进程类型检查通过，全部 501 个单测通过。没有启动应用或调用真实服务商；编译及离线单测不代表 Electron / 真实服务商运行验证。

## 文件归属与改动

本次可写文件均由主会话负责；scout 子代理仅只读侦察。仓库已有大量未提交改动，本次保留它们，没有重置或提交。

| 文件 | 本次改动 |
| --- | --- |
| `src/main/providers/discovery.ts` | 新增协议请求、解析、分页、10 秒截止、single-flight 与缓存。 |
| `src/main/providers/model-routing.ts` | 新增发现接入、缓存选模、auto 异步解析与辅助请求 failover。 |
| `src/main/providers/presets.ts` | 仅新增预设字段 `discoverModels?` / `builtinKey?`；新增条件式内置免费预设工厂。保留旧预设配置。 |
| `src/main/providers/store.ts` | 构建注入 Key 兜底、所有服务商建议列表提供 auto、配置变更使缓存失效、群聊候选排除 auto 哨兵。 |
| `src/main/providers/index.ts` | 旧 `listModels` 复用通用发现；adapter 禁止直接使用未解析的 auto。 |
| `src/main/providers/oneshot.ts` | 摘要、子任务等 complete / stream 请求解析 auto 并顺序 failover。 |
| `src/main/providers/vision.ts` | 识图请求使用真实选模结果，不把 auto 发给 SDK。 |
| `src/main/agent/route.ts` | 新增纯函数 `autoPurpose` / `selectAutoModel`。 |
| `src/main/agent/failover.ts` | 新增纯函数 `orderedFailover`，沿用现有错误资格判断。 |
| `src/main/agent/loop.ts` | 请求前异步准备模型，接入既有路由 / handoff / tried-set，保留 auto 意图。 |
| `src/main/agent/session-store.ts` | 会话 provider 可持久化 auto 意图；model 仍是实际模型 ID。 |
| `src/main/agent/reviewer.ts` | 审批子任务解析 auto，并返回实际模型名称。 |
| `src/main/index.ts` | 通用 IPC、主会话/子会话准备、auto 备选展开、摘要/审批/经验提炼保留 auto 意图。 |
| `src/shared/types.ts` | SweetApi 只新增一个必选方法，既有方法不改签名、不降为可选。 |
| `src/preload/index.ts` | 新方法对应 IPC bridge。 |
| `src/main/env.d.ts` | 新增两个构建常量声明。 |
| `electron.vite.config.ts` | 新增两个主进程构建注入常量，默认空字符串。 |
| `test/providers/discovery.test.ts` | 协议解析、兜底、认证头、缓存、超时、分页单测。 |
| `test/agent/auto-model.test.ts` | auto 所有选模分支、failover、空常量、取消与空列表单测。 |
| `docs/模型自动发现与auto路由汇报.md` | 本汇报。 |

未修改 `src/renderer/**`、`src/main/browser/**`、`src/main/automation/**`；未新增依赖，未安装依赖，未联网操作、启动应用或 git 提交。

## 模型发现与缓存

- 任一已配置服务商均可通过发现 IPC 或原来的 `listModels` 获取列表；配置模型为 auto 时，请求前自动发现。`discoverModels: true` 也会在固定模型请求前预热列表，但不改变固定模型。
- OpenAI：`GET {base}/v1/models`，`Authorization: Bearer <主进程 Key>`。
- Anthropic：同一路径，`x-api-key` 和 `anthropic-version: 2023-06-01`。发现接口不复用现有 compat Messages SDK 的 Bearer 认证。
- base 已以 `/v1` 结尾时只追加 `/models`，保留网关路径前缀；拒绝非 HTTP(S) 和 URL userinfo。禁止自动重定向，避免把认证头转发到其他地址。
- 两种协议解析 `data[].id`；去空白、去重、保留服务商返回顺序，排除大小写形式的 auto 哨兵。支持 `has_more` / `last_id` / `after_id` 分页，并限制重复 cursor 和页数。
- 整个发现操作，包括分页和 JSON 读取，截止时间 10 秒；超时 abort，并回退预设静态列表。
- 失败、HTTP 错误、非法 JSON、错误结构、空列表：回退 `suggestedModels`，再补充非 auto 的 `defaultModel`。不把过期的成功列表当成当前可用列表；静态列表也为空时返回 `[]`，auto 明确报“没有可用模型”，不发送字符串 auto。
- 成功结果按 provider ID 在主进程内存缓存 6 小时；失败后的静态结果短缓存 60 秒以避免连续超时，之后重试。重启后缓存重新建立。
- 配置指纹包含协议、base、Key、静态列表，使用 SHA-256；不同服务商隔离，配置/Key 更新或清除时失效。同一配置并发发现合并为一个请求；返回副本防止调用方污染缓存。
- 发现逻辑不打印 Key、请求头、响应错误体或底层传输错误，不把 Key 或其指纹返回 renderer。

## auto 匹配规则（纯函数）

所有名字匹配均不区分大小写，使用子串；同档多个命中时，选服务商列表中最先出现者。不硬编码服务商 ID、地址或 Key。

### 用途判定：`autoPurpose`

1. 子会话显式 `purpose: subtask` 优先，始终按轻量子任务选择。
2. 文本含 `难题 / 复杂 / 推理 / 证明 / 算法 / 架构`，或单词 `reason / reasoning / prove / complex / architecture`，按 `hard`。
3. 其余复用现有 `classify`：清晰的轻量消息按 `chat`，heavy 或不明确消息按 `coding`。已有文件、开放计划、autopilot 等 heavy 信号保留。
4. 摘要请求显式使用 `compress`；辅助请求默认 `subtask`。

原有 `RoutingSettings.difficulty` 仍决定是否使用显式 light/heavy 的服务商/模型配置；`purposes.compress/subtask` 和已有 failover 配置继续生效。显式指定固定模型保持固定；选中 auto 后才在该服务商列表中按用途选择。即使 difficulty 开关关闭，auto 自身仍可动态选择。现有 heavy 同时包含普通编码与难题，因此没有简单地把所有 heavy 都升级成最强模型。

### 名称选择：`selectAutoModel`

| 用途 | 选择规则 |
| --- | --- |
| `chat / compress / subtask` | 第一项名字含 `flash / mini / lite / chat / haiku`。 |
| `hard` | 第一项名字含 `reasoner / pro / opus / max / thinking`。 |
| `coding` | 优先第一项含 `sonnet / coder / code / instruct` 且不含上述轻量/强力词的模型；其次第一项既不含轻量词也不含强力词的通用模型。 |
| 任一用途无匹配 | 选列表第一项有效 ID。 |
| 没有有效 ID | 返回 undefined，由请求层给出明确错误。 |

这些是名称启发式，不宣称知道真实价格、上下文、工具调用或视觉能力。混合能力列表可能需要用户显式指定模型；没有伪造能力探测。

### Failover：`orderedFailover` + 现有 `failoverReason`

先请求选中的模型；失败后从发现列表首项开始顺序尝试其余 ID，跳过已尝试模型，不排序、不循环。例如列表 `[first, mini, last]` 选中 mini 后，顺序为 `mini → first → last`。

主会话先用当前 auto 服务商列表，再接原来的 `RoutingSettings.failover`；auto 备选服务商展开为其原始列表。沿用现有 handoff 保留工作记录与 tried-set。429 / 402 / 401 / 403 / 404 / 408 / 5xx、连接/超时错误等沿用现有 failover 资格规则；取消及现有不具备切换资格的错误不重试。

complete、审批和识图辅助请求也采用相同资格及列表顺序；stream 辅助请求只在尚未输出文本时 failover，已经向调用方输出文本后直接报错，避免重放造成重复内容。主会话继续使用其原有流式 handoff 行为。

## 内置免费预设接口

仅在主进程构建注入：

```text
__SIKEOOP_BUILTIN_FREE_BASE_URL__ ← process.env.SIKEOOP_BUILTIN_FREE_BASE_URL ?? ""
__SIKEOOP_BUILTIN_FREE_KEY__      ← process.env.SIKEOOP_BUILTIN_FREE_KEY ?? ""
```

`builtinFreePresets(baseURL, apiKey)` 仅当两个值均非空时产生 `builtin-free` 预设；任一为空或仅空白时不出现。启用时 `defaultModel: "auto"`、`discoverModels: true`，协议为 OpenAI 兼容。保存的用户 Key 优先，其次预设 envKey，最后构建注入 Key。ProviderView 不包含 builtinKey；构建注入来源沿用现有 `keySource: "env"` 展示，不扩展 renderer 枚举。

源码没有新增实际第三方网址或真实 Key 值；测试使用 `.invalid` 地址和仅测试占位字符串，所有网络响应均注入 mock 或在无效配置阶段直接兜底。构建产物包含注入值，不将客户端内置 Key 视为不可提取的秘密。

## SweetApi 与 dev-mock 缺项

新增方法保持必选：

```ts
providerDiscoverModels(providerId: string): Promise<string[]>;
```

IPC：`providers:discoverModels`。原 `listModels(id)` 签名保留并复用相同缓存/兜底行为；IPC 不返回任何 Key。

当前 `src/renderer/src/dev-mock.ts:2500` 的 `const api: SweetApi` 对象没有 **providerDiscoverModels**（已有 `listModels` 约在 2764 行）。这是本次新增接口带来的明确缺项，按边界没有修改 renderer。前端需补同名 mock 方法；不得把 SweetApi 方法改成可选以绕过该缺项。行号可能受并行任务影响。

未运行 web 类型检查；本次验收要求为 node 类型检查及 npm test，不能把 node tsc 通过解释成 dev-mock / renderer 已通过。

## 验证（原始关键输出）

### 主进程类型检查

```text
$ node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
tsc exit=0
```

tsc 无诊断输出。使用 noEmit，避免向源目录写编译产物。

### 新增离线单测

```text
$ node --test --test-timeout=10000 test/providers/discovery.test.ts test/agent/auto-model.test.ts
ℹ tests 45
ℹ suites 0
ℹ pass 45
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 129.836083
```

### 全量验收

```text
$ npm test
> sikeoop@4.1.58 test
> node --test --test-timeout=10000 "test/**/*.test.ts"

npm test exit=0
ℹ tests 501
ℹ suites 0
ℹ pass 501
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2443.004292
```

Node 原生类型剥离执行；新增文件无构造函数参数属性，新增运行时相对 import 带 `.ts`。覆盖两种协议解析与多种失败兜底、缓存到期/隔离/失效、single-flight、10 秒超时、分页、所有轻量/强力关键词与编程主线/首项/空列表分支、failover 顺序、取消、固定模型和空构建常量。

运行中出现 Node `MODULE_TYPELESS_PACKAGE_JSON` 与 MockTimers 实验性提示，不影响通过；没有为了消除警告改 package.json。对本次文件执行 `git diff --check`，无输出、exit 0。

## 遗留问题 / 需要决定的事

- renderer 的新增必选 mock 方法由前端任务补齐；本任务没有扩展 UI。
- 真实服务商、账号登录模式模型列表、Electron IPC/handoff 和构建产物尚未实机验证；无 API Key 的登录配置发现失败时使用静态预设列表。
- 名称启发式不能证明模型实际价格或工具/视觉能力，用户可继续显式选模。

完成以上验收及本汇报后停止，不启动应用、不继续测试循环。
