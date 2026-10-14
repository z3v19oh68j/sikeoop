# Game Cheat Workshop

游戏逆向 / 外挂开发学习与模板工坊。面向单机游戏、公开 CTF、自建 lab、游戏 modding、以及游戏 internals 学术研究复现。

## 目录

```
game-cheat-workshop/
├─ README.md                  本文件：学习路径 + 索引
├─ 00-primer/                 入门：进程内存、游戏引擎识别、PE/ELF 基础
├─ 10-windows-external/       外部读写内存（ReadProcessMemory / pymem）
├─ 20-unity-il2cpp/           Unity IL2CPP dump + inline hook
├─ 30-unreal-sdk/             Unreal UE4/5 SDK dump + ESP
├─ 40-dx11-overlay/           DirectX 11 ImGui 覆盖层（画 ESP / menu）
├─ 50-frida-mobile/           Android/iOS 手游 Frida hook
├─ 60-cheat-engine/           Cheat Engine 自动汇编（AA）脚本
├─ 70-anticheat-notes/        反作弊机制对抗笔记（VAC / EAC / BE / Vanguard）
├─ 80-kernel-reflect-inject/  内核驱动反射式 DLL 注入（AFSS.sys + Loader，用户现成源码）
├─ 85-driver-signing/         驱动签名 & HookSigntool 时间戳伪造（用户现成素材）
└─ 90-build/                  各模板的编译 / 运行脚本
```

## 推荐学习路径

| 顺序 | 模块 | 产出能力 |
|---|---|---|
| 1 | 00-primer | 看懂进程内存布局、识别游戏引擎 |
| 2 | 60-cheat-engine | 找基址 / 偏移 / 指针链 |
| 3 | 10-windows-external | 用代码读写数值（血量/金币/坐标） |
| 4 | 40-dx11-overlay | 画自己的 UI 和 ESP |
| 5 | 20-unity-il2cpp 或 30-unreal-sdk | 根据目标引擎做 inline hook / SDK dump |
| 6 | 50-frida-mobile | 迁移到手游 |
| 7 | 70-anticheat-notes | 对抗检测 |

## 技术栈默认值

| 场景 | 工具 |
|---|---|
| PC 内存分析 | Cheat Engine 7.5+、x64dbg、ReClass.NET |
| 静态逆向 | IDA Pro 9 / Ghidra 11 / Binary Ninja |
| Unity 游戏 | Il2CppDumper、Il2CppInspector、dnSpy（Mono）|
| Unreal 游戏 | Dumper-7、UE4SS、UnrealFinderTool |
| Hook 库 | MinHook、Detours、Dobby、Frida |
| Overlay | Dear ImGui + Kiero (D3D11 hook) |
| 手游 | Frida、LIEF、jadx、apktool、Zygisk |
| 驱动级 (研究) | KDMapper + 漏洞驱动（BYOVD） |

## 法律与范围

本工坊的所有模板只在以下场景使用：
- 自己拥有副本的单机游戏 / 自建私服 / 游戏 modding
- 公开 CTF 挑战、CVE 复现、学术研究复现
- 自己写的目标程序

不要用于联机竞技游戏的实时作弊。
