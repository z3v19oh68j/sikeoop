# 鸿蒙模拟器底座

HarmonyOS 模拟器的基础层。它不安装任何东西，只做三件事：找到 DevEco Studio 自带的工具，封装常用的 hdc 操作，环境不全时明确报告 `blocked`。

和 `android-emulator/` 的区别：鸿蒙模拟器镜像随 DevEco Studio 分发，需要华为开发者账号下载，命令行无法像 Android 那样直接装。所以这里的底座要求先装好 DevEco Studio。

## 第一步：安装 DevEco Studio（手动）

1. 到华为开发者官网下载 DevEco Studio，安装到默认位置。
2. 首次启动时按向导安装 HarmonyOS SDK，并勾选模拟器。
3. 在 Device Manager 中创建并启动一个模拟器。

## 第二步：让底座找到工具

默认会检查这些位置：

- macOS：`/Applications/DevEco-Studio.app/Contents`
- Windows：`%ProgramFiles%\Huawei\DevEco Studio`

安装在别处时，设置环境变量 `DEVECO_HOME` 指向 DevEco Studio 的安装目录。也可以单独指定：

| 变量 | 作用 |
|---|---|
| `DEVECO_HOME` | DevEco Studio 安装目录 |
| `HDC_BIN` | hdc 可执行文件（优先于 DEVECO_HOME） |
| `HVIGORW_BIN` | hvigorw 启动脚本 |
| `OHPM_BIN` | ohpm 可执行文件 |
| `HARMONY_EMULATOR_BIN` | 模拟器可执行文件（不同版本路径不同，找不到时手动指定） |

## 用法

```bash
node harmony-emu.mjs doctor                    # 检查工具和在线设备
node harmony-emu.mjs targets                   # 列出在线设备
node harmony-emu.mjs install app.hap           # 安装 HAP（可选第二个参数指定设备号）
node harmony-emu.mjs launch <bundle> <Ability> # 启动 Ability
node harmony-emu.mjs shot out.jpeg             # 截图并拉回本地
node harmony-emu.mjs logs Error                # 抓最近 300 行 hilog，按关键字过滤
node harmony-emu.mjs uninstall <bundle>
node harmony-emu.mjs hdc <参数…>               # 其它 hdc 命令直接透传
```

## 退出码

- `0`：成功
- `1`：命令执行失败
- `2`：被阻塞（工具缺失、没有在线设备、指定设备不在线）。调用方应该停下并报告，不要假装成功。

## 当前状态

本机（macOS）尚未安装 DevEco Studio，所以目前只验证过 `doctor`、`targets` 的阻塞路径（返回 2 并给出提示）。下面这些还没有在真实设备上验证：

- 模拟器可执行文件的默认路径（不同 DevEco 版本不同）。
- `snapshot_display` 的参数和截图路径。
- `hilog -z` 参数是否在你的 hdc 版本里可用。

安装 DevEco 后运行 `doctor`，有问题把输出发给我，我据此修正路径和参数。

## 与集群的关系

`harmony-agents/` 中的 `harmony-emulator-tester` 角色应通过本 CLI 调用模拟器，而不是直接拼 hdc 命令。这样工具路径只在这一处定义，符合 `shared/environment.md` 的约定。
