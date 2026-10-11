# 代理交接契约

所有代理只通过本契约交换信息。每个角色运行在独立会话中，互相看不到对方的上下文，只能看到调度方传入的输入信封，以及它引用的文件路径。

## 隔离规则

1. **每个角色独立会话。** 每次分派都是新的子代理，不复用、不继承其他角色的会话。
2. **只共享最终结果。** 角色对外只输出一份输出信封，中间推理、试错、完整日志都不对外。
3. **大内容走文件。** 日志、截图、报告写入 `artifacts`，信封里只放路径。
4. **角色不得读取其他角色的会话或内部笔记**，只能使用输入信封和信封中列出的文件。

## 输入信封（调度方 → 代理）

```yaml
task_id: string          # 本次任务编号，由调度方生成
role: string             # 目标角色，取值见 registry.md
goal: string             # 一句话目标
inputs:
  files: [string]        # 相关文件路径（相对项目根）
  context: string        # 必要背景，不超过 300 字，只包含事实
  upstream: string       # 前序角色的 summary，可为空
acceptance: [string]     # 验收标准，逐条可检查
```

## 输出信封（代理 → 调度方）

```yaml
task_id: string
role: string
status: ok | fail | blocked
summary: string          # 不超过 200 字，唯一会被共享的文字内容
changed_files: [string]  # 实际修改过的文件；只读角色为空
artifacts: [string]      # 日志、截图、报告等产物路径
errors:                  # status 为 fail 时必填，取第一个根因
  - file: string
    line: number
    message: string      # 原文，不改写
route:                   # 建议的下一步；无则为 null
  role: string
  reason: string
```

## 状态含义

- `ok`：目标完成，验收标准全部满足。
- `fail`：执行过但未满足验收，`errors` 必须给出原因。
- `blocked`：缺少环境或前置条件，无法执行。不得伪装成 `ok`。

## 约束

- `summary` 不超过 200 字，不粘贴完整日志。
- 不确定的结论标注“未验证”。
