# 鸿蒙开发子代理集群

用于 HarmonyOS（ArkTS / ArkUI）开发的一组子代理。每个角色运行在独立会话中，角色之间只共享最终的输出信封。

## 目录结构

```
harmony-agents/
├── README.md
├── shared/                     # 共享契约
│   ├── contract.md             # 隔离规则、输入/输出信封、状态含义
│   ├── environment.md          # 环境变量与工具路径解析
│   └── registry.md             # 角色表、标准流水线、回退规则
└── agents/                     # 各角色定义，互不引用
    ├── harmony-coordinator.md
    ├── harmony-architect.md
    ├── arkts-developer.md
    ├── hvigor-builder.md
    ├── harmony-emulator-tester.md
    └── harmony-reviewer.md
```

## 会话隔离

1. **每个角色是独立子代理。** 调度方通过 Agent 工具、以角色名作为 `subagent_type` 新建会话，不使用 fork。
2. **只共享输出信封。** 其他角色能看到的只有 `summary`、`changed_files`、`artifacts` 路径和 `errors`。推理过程和完整日志不共享。
3. **大内容走文件。** 日志、截图写入 `artifacts`，信封里只放路径。
4. **回退也是新会话。** 修复角色不继承之前的对话，只收到新的输入信封。

## 角色

| 角色 | 职责 | 写权限 |
|---|---|---|
| `harmony-architect` | 模块、路由、权限、Ability 设计 | 仅配置文件 |
| `arkts-developer` | ArkTS / ArkUI 代码 | 业务源码 |
| `hvigor-builder` | 依赖安装、构建、错误定位 | 仅配置与依赖 |
| `harmony-emulator-tester` | hdc 安装、启动、截图、日志、冒烟测试 | 无 |
| `harmony-reviewer` | 只读评审 | 无 |

标准流水线：`harmony-architect`（可选）→ `arkts-developer` → `hvigor-builder` → `harmony-emulator-tester` → `harmony-reviewer`。

## 前置环境

- DevEco Studio，提供 `hvigorw`、`ohpm`、`hdc` 与 HarmonyOS 模拟器。
- 设置 `DEVECO_HOME`，或直接设置 `HVIGORW_BIN`、`OHPM_BIN`、`HDC_BIN`。
- 缺少时，依赖环境的角色返回 `blocked`。

## 安装

把 `agents/*.md` 复制到项目的 `.claude/agents/`，并把 `shared/` 放在可访问的路径下，代理通过相对路径读取契约文件。用户级安装则复制到 `~/.claude/agents/`。

## 注意

- 这些定义尚未在真实鸿蒙项目中运行过。
- 独立会话依赖 Claude Code 的子代理机制。我没有实际验证每个子代理在运行时是否确实拿不到调度方的上下文，首次使用时请留意。
- `harmony-coordinator` 需要在主会话中使用。
- 与 Android 模拟器底座（`android-emulator/`）无直接依赖，鸿蒙测试只用 HarmonyOS 模拟器。
