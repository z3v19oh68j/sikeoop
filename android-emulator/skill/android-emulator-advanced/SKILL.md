---
name: android-emulator-advanced
description: "[高级] 为 app 自身的扩展工具搭建 Android 模拟器底座：检查/安装 JDK、SDK 组件、系统镜像，创建 AVD，并支持把自定义系统镜像替换进去运行。仅 Windows 优先，macOS 为备用。"
metadata:
  level: advanced
  platform: windows-first
---

# Android 模拟器（高级）

用于为 app 的扩展工具准备一个可用的 Android 模拟器环境。目前底座已经搭好，后续只需要把系统文件放进去即可运行。

## 何时使用

- 用户要在新机器上（优先 Windows）从零配置模拟器。
- 用户要替换或测试自定义系统镜像（system.img 等）。
- 模拟器启动失败、AVD 创建失败、`adb` / `emulator` 找不到，需要排查环境。

## 前置条件

- Windows 10/11，x86_64 或 ARM64。
- 已开启虚拟化（BIOS 中 VT-x / AMD-V）。
- 网络可访问 dl.google.com，并且可以使用 winget。
- 磁盘剩余至少 10 GB（系统镜像约 1–2 GB，随 API 版本增加）。

## 一键配置（Windows）

1. 双击 `scripts/一键配置.bat`。
2. 脚本会依次完成：虚拟化检查 → JDK 21 → SDK 命令行工具 → 组件与系统镜像 → 用户环境变量 → AVD `base_x86` → 启动模拟器。
3. 完成后新开终端，`adb devices` 应能看到设备。

脚本可重复运行，已存在的组件会跳过。

直接调用脚本（可指定参数）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-android-emulator.ps1 `
  -SdkRoot "D:\Android\Sdk" -AvdName "ext_test" -ApiLevel 34 -Launch
```

## 替换自定义系统文件

1. 在 AVD 目录（`%USERPROFILE%\.android\avd\<AVD名>.avd\`）中找到 `config.ini`，确认 `image.sysdir.1` 指向的镜像目录。
2. 把自定义的 `system.img`、`vendor.img`、`ramdisk.img`、`kernel-ranchu` 等文件覆盖到该目录。
3. 删除 AVD 目录下的 `userdata-qemu.img` 和 `*.lock`，避免旧数据干扰。
4. 启动：`emulator -avd <AVD名>`。

注意：自定义镜像必须与 `hw.cpu.arch`、`tag.id` 一致（例如 x86_64 镜像对应 x86_64 的 AVD）。

## 常见问题

| 现象 | 处理 |
|---|---|
| `java` 报 “Unable to locate a Java Runtime” | 安装 JDK 17+，并设置 `JAVA_HOME`。 |
| `emulator` 提示 “HAXM / WHPX 不可用” | 在“启用或关闭 Windows 功能”中开启“虚拟机平台”和“Windows 虚拟机监控程序平台”，重启。 |
| sdkmanager 报告完成但镜像目录为空 | 重新运行安装命令；若仍为空，删除残缺的 `system-images\<版本>` 目录后重试。 |
| AVD 创建时报 “Could not load devices” | 镜像目录缺少 `devices.xml`，通常可忽略，但需在启动后验证。 |
| 下载命令行工具返回 404 | 更新 `setup-android-emulator.ps1` 中的 `$CmdlineToolsVersion`。 |
| 磁盘空间不足 | 清理旧的系统镜像与 AVD，或用 `-SdkRoot` 指向空间更大的盘。 |

## macOS 说明

脚本仅支持 Windows。macOS 上可使用 Homebrew 的 `android-commandlinetools` cask，并手动设置 `JAVA_HOME` 与 `ANDROID_HOME`。

## 注意事项

- 本 skill 不负责 APK 安装、应用测试或框架开发，只负责模拟器底座。
- 脚本修改用户级环境变量，请在知情的情况下运行。
- 此 skill 的 Windows 脚本尚未在真实 Windows 环境中验证，首次使用请留意输出。
