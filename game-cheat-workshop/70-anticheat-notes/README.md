# 70 — Anti-cheat 对抗笔记

把常见反作弊的检测面列出来，再给对应的研究方向。**本节只用于单机 / lab / 公开 CVE 复现 / 自己写的目标**。

## 用户态反作弊

| 产品 | 典型游戏 | 关键检测 |
|---|---|---|
| VAC | Steam 大多数 | 签名扫 DLL、CRC32 代码段、挂钩检测 |
| BattlEye (user) | PUBG、R6 | 远程配置脚本、模块黑白名单 |
| FairFight | COD 系列 | 行为学分析（服务器端） |
| nProtect / HackShield | 韩系 MMO | API hook 检测、调试器检测 |

典型绕法（都是通用研究方向）：

- Manual map (不用 LoadLibrary，PE loader 自己写) → 不在模块链表里
- Thread hiding (`NtSetInformationThread + ThreadHideFromDebugger`)
- 不改任何 .text（避免代码段 CRC） → 用 trampoline 放在自己分的 RWX 页
- 把 `GetAsyncKeyState` 换成 `GetRawInputData` 或 raw hooking

## 内核态反作弊

| 产品 | 典型游戏 | 技术 |
|---|---|---|
| EAC (kernel) | Fortnite、Apex、Rust | 内核回调、系统线程扫描、DSE、`PsSetCreateProcessNotifyRoutine` |
| BattlEye (kernel) | PUBG、R6 | 类似 EAC |
| Vanguard | Valorant | 开机启动驱动、HVCI 友好、系统深度监控 |
| ACE (Tencent) | WZRY、Delta Force | 内核 + 用户态组合 |
| mhyProt (Genshin) | 原神 | 签名内核驱动, 读 EPROCESS |

常见研究方向：

- **BYOVD (Bring Your Own Vulnerable Driver)**：加载有签名的漏洞驱动（dbutil、RTCore64、kprocesshacker 老版），获得任意内核 R/W。Microsoft 的 vulnerable driver blocklist 会挡掉已知的，需要找未封的或自己写 1day。
- **KDMapper**：用 iqvw64e.sys 把一个未签名驱动映射进内核（manual map）。入门标配，但很多 blocklist 已包含。
- **内核回调清理**：遍历 `PspCreateProcessNotifyRoutine` / `PsSetLoadImageNotifyRoutine`，置零目标 AC 的回调。注意 PatchGuard。
- **CR3 trick**：在 DPC 里切换到目标进程的 CR3 做跨进程读写，不触发用户态 `OpenProcess` 拦截。
- **HVCI / VBS**：开启后 kernel R/W 必须额外绕 HVCI；一般靠不改 .text、不分配 RWX 页做到。

## 虚拟机 / 调试检测

- `IsDebuggerPresent` / `CheckRemoteDebuggerPresent` / `NtQueryInformationProcess(ProcessDebugPort)`
- `KUSER_SHARED_DATA->KdDebuggerEnabled`
- CPUID 的 `hypervisor present` 位 (ECX bit 31)
- 时间差 (`rdtsc` 前后差异) 检测 single-step
- 枚举 Hyper-V / VBox 服务、注册表、MAC OUI

绕法：

- VMProtect/Themida 本身自带 anti-anti-debug，可参考
- ScyllaHide (x64dbg 插件) 一键
- 自写 kernel driver patch `PEB->BeingDebugged`、`NtGlobalFlag`、`HeapFlags`

## 行为检测（服务器）

- 命中率、爆头率、转头速度、路径熵
- 服务器重放玩家 input 看物理一致性
- 鼠标轨迹的傅立叶特征

绕法：加人味儿（人类抖动、反应时间分布、偶尔 miss），技术上归机器学习对抗样本。

## 本仓已有的实物

- **内核反射注入 Loader + AFSS.sys 驱动** → [`../80-kernel-reflect-inject/`](../80-kernel-reflect-inject/)
- **驱动签名 (HookSigntool + 50 pfx)** → [`../85-driver-signing/`](../85-driver-signing/)

## 推荐阅读

- UnknownCheats 论坛（技术层面最活跃）
- Secret Club 博客
- back.engineering / Daax Rynd 的 EAC/BE 系列
- Niemand - Cyber 的 kernel anti-cheat 系列
