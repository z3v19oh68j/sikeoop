# 环境约定

所有路径和工具位置只在这里定义，代理内部不写死任何本机路径。

## 环境变量

| 变量 | 含义 | 示例 |
|---|---|---|
| `DEVECO_HOME` | DevEco Studio 安装目录 | `/Applications/DevEco-Studio.app/Contents` |
| `HDC_BIN` | hdc 可执行文件 | `$DEVECO_HOME/sdk/default/openharmony/toolchains/hdc` |
| `HVIGORW_BIN` | hvigorw 启动脚本 | `$DEVECO_HOME/tools/hvigor/bin/hvigorw` |
| `OHPM_BIN` | ohpm 可执行文件 | `$DEVECO_HOME/tools/ohpm/bin/ohpm` |
| `HARMONY_PROJECT_ROOT` | 鸿蒙项目根目录 | 由调度方在任务中指定 |

## 解析规则

1. 若对应的 `*_BIN` 变量已设置且文件存在，直接使用。
2. 否则若 `DEVECO_HOME` 已设置，按上表拼接路径。
3. 否则输出 `status: blocked`，`summary` 写明缺少哪个变量。不要猜测路径，也不要搜索全盘。

## 检查命令

代理在执行前用以下命令确认可用，失败即 `blocked`：

- `"$HVIGORW_BIN" --version`
- `"$OHPM_BIN" --version`
- `"$HDC_BIN" version`

## 不依赖的内容

- 不依赖 Android SDK 或 Android 模拟器。
- 不依赖任何特定的项目目录名。
