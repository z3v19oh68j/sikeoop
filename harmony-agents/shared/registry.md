# 角色注册表

调度方只通过本表分派任务。每个角色都以独立子代理（独立会话）运行，`subagent_type` 与下表的角色名一致。

| 角色（subagent_type） | 定义文件 | 能力 | 写权限 | 环境依赖 |
|---|---|---|---|---|
| `harmony-architect` | `agents/harmony-architect.md` | 模块、路由、权限设计 | 仅配置文件 | 无 |
| `arkts-developer` | `agents/arkts-developer.md` | 编写 ArkTS / ArkUI 代码 | 业务源码 | 无 |
| `hvigor-builder` | `agents/hvigor-builder.md` | 构建、依赖安装、错误定位 | 仅配置与依赖 | `HVIGORW_BIN`、`OHPM_BIN` |
| `harmony-emulator-tester` | `agents/harmony-emulator-tester.md` | 安装、启动、截图、日志、冒烟测试 | 无 | `HDC_BIN` |
| `harmony-reviewer` | `agents/harmony-reviewer.md` | 只读评审 | 无 | 无 |

`role` 字段使用上表的 `subagent_type` 值（例如 `arkts-developer`）。

## 标准流水线

```
harmony-architect（可选，仅新模块）→ arkts-developer → hvigor-builder → harmony-emulator-tester → harmony-reviewer
```

每一步都是新的独立会话。下一步由上一步输出信封中的 `route.role` 决定。

## 回退规则

- `hvigor-builder` 返回 `fail` 且属于代码问题 → 路由到 `arkts-developer`。
- `harmony-emulator-tester` 返回 `fail` 且属于运行时问题 → 路由到 `arkts-developer`。
- `harmony-reviewer` 返回有严重问题 → 路由到 `arkts-developer`。
- 同一任务回退超过 2 次 → 调度方停止，报告给用户。
- 任何角色返回 `blocked` → 调度方直接报告，不继续分派。

回退时，`arkts-developer` 是新的独立会话，只接收新的输入信封（包含上一步的 `errors` 原文和 `summary`），不接收之前的会话内容。
