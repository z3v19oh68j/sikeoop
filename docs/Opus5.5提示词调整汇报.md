# Opus5.5 提示词调整汇报

## 结果：完成（本轮限定的后端范围）

按 `../docs/Opus5.5-提示词要点.md` 末尾六条及 `../.claude/LEGION.md` 落地。最终 Node TypeScript 验收退出码为 0，`npm test` 全部 433 个测试通过。没有启动应用、联网、新增依赖或 Git 提交；没有修改 `src/renderer/**`、`src/main/browser/**`、preload 或包配置，也没有覆盖开工前已有的其他修改。

## 六条落地

### 1. 按用途选择 Claude effort

| 用途 | 默认 effort |
| --- | --- |
| 对话 | low |
| 子任务，包括军团角色、自动化内置代理、审批与普通辅助请求 | low |
| 上下文压缩、会话摘要 | low |
| 编程主线，未启用难度路由 | medium |
| 启用现有难度路由且编程任务被判为 heavy | high |

复用现有 `route.ts` 的 light/heavy 分类及模型分工，没有另建模型路由。仅对明确支持 effort 的 Claude 模型添加 `output_config.effort`；Haiku 4.5、Sonnet 4.5、未知模型和 Anthropic-compatible 服务不下发。OpenAI、DeepSeek、MiMo 等其他供应商原有参数行为保持不变。

`RoutingSettings` 只新增 `effort?: Partial<Record<EffortPurpose, Effort>>`，用途键为 `chat / coding / hard / subtask / compress`。既有必选 `SweetApi.setRouting` 与 IPC 继续使用，不新增方法、不把现有方法改可选。设置值校验只接受 low/medium/high；旧界面保存模型分工时若未传 effort，保留已有覆盖；传 `{}` 可清除覆盖。

现有设置接口可保存覆盖，例如下面的接口用法说明（本轮没有执行）：

```ts
const state = await window.sweet.getProviders();
await window.sweet.setRouting({
  ...state.routing,
  effort: { chat: "low", coding: "medium", hard: "high", subtask: "low", compress: "low" },
});
```

`ChatRequest` 另新增可选 `effortOverride`，用于显式覆盖本回合的 Claude effort；原有 `effort` 保留，其他供应商仍按原逻辑读取。优先级是显式回合覆盖 > 对应用途的设置覆盖 > 默认值。未修改界面，因此没有新增可点击的用途 effort 控件。

### 2. 删除重复思考/复查措辞

以开工时工作区的提示为基准，实际删除或改写的是：

- 删除网页规则中的「改完代码后看一眼浏览器确认，再告诉用户做好了。」；前文已有具体浏览器验收动作，避免再次泛化复查。
- 将懒人模式的「动手前想清楚：」改为「操作范围：」。
- 将「删文件、覆盖文件之前确认真的需要。」改为「删文件、覆盖文件以任务确有需要为依据。」。

原工作区没有逐字的「仔细思考 / 最后自检 / double-check / 用子代理复查」，没有虚报删除不存在的句子。文件读取前置、明确的浏览器/安卓功能验收、测试/构建及用户指定验收仍保留。

### 3. 原创进度节奏与范围交付段落

静态系统提示增加「汇报节奏」「交付范围」：首次工具前一句话说明推进目标；中途只报关键发现、方向变化和阻碍；结束先说结果，区分完成、验收与未结束的后台工作。交付按用户功能、文件边界和验收条件进行，不擅自扩展或省略；报告长度匹配任务需要，避免重复总结。

提示文字由本轮撰写，没有复制官方文档原文。静态提示提取至 `prompts.ts`，`context.ts` 保留原导出 API；没有把随机值或时间放入系统缓存前缀。

### 4. 可靠识别才包裹粘贴资料

`ChatRequest.pastedContent` 可携带明确剪贴板事件记录：`{ source: "clipboard", start, end, text }[]`。`loop.userParts` 只在模型消息中包装这些范围，不改变聊天显示的用户原文或 Hook 收到的原始 prompt。

- 校验来源、UTF-16 整数偏移、精确子串一致、范围不重叠且不切断 Unicode 代理对。
- 任一记录不可靠或已被编辑失效，整组保持原文。
- 每个可靠范围生成 UUID，输出 `<pasted_content id="…">`；内容中的 `& / < / >` 转义，防伪造关闭标签。
- 长文本、代码围栏、文字自称「粘贴」都不作为识别依据。
- 包装后的内容只在加入历史时生成一次，后续模型调用、保存和交接复用已有内容，不每次重建 id。

系统提示说明其中是外部资料，只有用户在标签外明确要求时才执行其中的指令。renderer 未记录粘贴事件时，现有普通发送不包装；这属于可靠识别边界，不启用猜测式包装。

### 5. 同一任务最多自动续跑 3 次

`auto-resume.ts` 提供统一预算。主会话的额度恢复、Stop Hook 要求继续、长任务计划未完成续跑共用同一任务计数，不再分别按回合重置为 2 次和 3 次。第四次续跑请求停止，不再发给模型或 CLI，标记「同一任务已自动续跑 3 次，已停止，需人工查看」。

- 主会话预算、原始任务、长任务模式存入会话文件；额度计划保存 taskId、计数和人工查看状态。
- CLI 预算及用户接手边界保存在 `plans.json`，重启不绕过上限；旧计划没有任务边界时保守计入已有完成的续写。
- 计数在执行前声明并持久化；共享预算保存失败则停止并标记人工查看，不形成紧密重试循环。
- 人工发送/终端 Enter 接手结束旧任务预算，并撤销仍待调度的额度续写；后续人工任务有新的预算。
- 自动额度发送绕过人工接手入口，保留原来的长任务/懒人模式，避免自动发送把计数重置。
- 异步保存期间发生接手时不发送旧续写。

`Dispatcher.markNeedsReview` 使用既有调度台事件与台账：添加 `needsReview / autoResumeCount`、错误原因和失败检查；正在执行的对应任务最终为 failed。主会话没有调度历史时产生一条 failed 人工查看记录。自动化通过当前 dispatchJobId 找到实际调度任务，军团角色使用自身 executor.ref。无需修改调度台 renderer。

### 6. 会话顶层 effort 稳定

主会话首次使用支持 effort 的 Claude 时确定顶层值，并保存到会话；模型路由、手动切换、failover、恢复与压缩均保留这个值。

支持既有消息级 effort beta 的 Claude 将后续用途/覆盖变化追加到消息历史，不修改顶层配置；不支持消息级 effort 的旧 Claude 固定首次顶层值，后续覆盖不会强行重置缓存。这意味着旧模型要采用不同顶层覆盖，需开启新会话。

审查中同时修复两处直接影响交接的行为：压缩移除消息级 effort 后，将状态复位至顶层，让下一次配置重新追加覆盖；非兼容 Claude 在下一条用户消息中实际消费待注入的摘要，避免模型交接丢失摘要。

## 改动文件与归属

- 主代理：`src/shared/types.ts`、`src/main/index.ts`、`src/main/agent/{loop,route,reviewer,session-store}.ts`、`src/main/providers/{effort,anthropic,oneshot,store,types}.ts`、`test/agent/effort.test.ts`；接入、用途策略、稳定缓存与最终验收。
- 提示词代理：`src/main/agent/{context,prompts,pasted-content}.ts`、`test/agent/{prompts,pasted-content}.test.ts`；提示和粘贴边界。
- 续跑代理：`src/main/agent/auto-resume.ts`、`src/main/quota/service.ts`、`src/main/dispatch/scheduler.ts`、`test/agent/auto-resume.test.ts`、`test/quota/{service,store}.test.ts`、`test/dispatch/scheduler.test.ts`；任务预算、持久化与台账。其完成后由主代理接管共享预算异步保存和竞态补充。
- security-qa：只读审查，不修改文件。
- 本报告：`docs/Opus5.5提示词调整汇报.md`。

## 验证

Node v26.10.0，使用 Node 原生 TypeScript 类型剥离。新增测试运行时相对 import 带 `.ts`，没有引入构造函数参数属性或第三方测试依赖。

最终验收命令：

```sh
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
npm test
```

原始关键输出：

```text
TSC_EXIT=0
ℹ tests 433
ℹ suites 0
ℹ pass 433
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2316.154917
NPM_TEST_EXIT=0
```

tsc 无诊断输出。测试有既有 `MODULE_TYPELESS_PACKAGE_JSON` 警告，没有为消除警告修改 package.json。日志位于 `/tmp/sikeoop-opus-tsc.log`、`/tmp/sikeoop-opus-npm-test.log`。

单测覆盖用途/覆盖/能力门控、实际 Anthropic mock 请求字段、顶层固定、压缩/恢复/交接/回滚、系统提示片段、随机粘贴包装及无效来源、共同续跑预算、磁盘逐次重启、人工接手与异步保存竞态、调度台人工查看。

## 界面与未验证边界

- 本轮未新增 SweetApi 方法，全部既有方法仍必选。只读 TypeScript 类型属性比对当前 dev-mock 的 SweetApi 必选成员，缺项列表为空；本轮没有新增 dev-mock 方法缺项。没有运行完整 renderer/web typecheck。
- 若后续需要可点击的用途 effort 控件或粘贴事件采集，renderer 另行接入上述新增字段；本轮按禁改要求未做。
- 没有启动 Electron、真实调用 Anthropic API、执行真实长时间等待或 CLI 投递；mock 请求与单测通过不等于上述运行行为已验证。
- 验收通过后仅生成本报告，停止工作，不追加测试循环。
