# 80 — Kernel Reflective DLL Injection

绕过用户态 anti-cheat 的注入方式：**用户态 Loader 不调 `OpenProcess` / `WriteProcessMemory`**，所有内存操作走内核驱动完成（通过 IOCTL）。EAC/BE 的 user 层拦不住，kernel 层只要你不在 `PspCreateProcessNotifyRoutine` 系黑名单里也不触发签名/HVCI 问题就行。

## 项目里已经有的东西

用户放在 `../../内核开发/内核驱动级反射式注入(源码版 解压后看说明)/` 下，关键文件：

| 文件 | 作用 |
|---|---|
| `AFSS.sys` | 已签名的内核驱动（提供内核态内存读写 / 分配 / 释放 IOCTL） |
| `ReflectInjection/Loader/Main.cpp` | 用户态入口，`FindWindowA("UnrealWindow", NULL)` 定位目标进程 |
| `ReflectInjection/Loader/Injector.cpp` (232 行) | Manual map 实现：解析 PE、分配内核内存、重定位、通过 shellcode 调 DllMain |
| `ReflectInjection/Loader/Interface.hpp` | 抽象层：`Interfaces` 接口，`InterfacesR0` 是走驱动的实现 |
| `ReflectInjection/Loader/Driver.cpp/.h` | 用户态和 `AFSS.sys` 通信（CreateFile 到 `\\.\<devicename>` + DeviceIoControl） |
| `ReflectInjection/Loader/Loader.vcxproj` | VS 工程 (x64 Release) |

**说明文件原话**：
> 如果只想要成品，只需要安装 AFSS 这个驱动，打开源码，更改 dll 路径，更改类名，随后直接编译即可使用。

## Manual Map 流程（Injector.cpp 实现的）

```
用户态 Loader                       内核 (AFSS.sys)
    │
    ├─ 读目标 DLL 文件 → pSrcData
    ├─ 解析 PE 头（NT/File/Opt/Sections）
    ├─ Memory->MmAlloc(ImageSize)  ──IOCTL──▶ ExAllocatePool / 跨进程 CR3 分配
    ├─ 本地重定位 / 填 IAT（在 Loader 内存里完成）
    ├─ Memory->MmCopy(target, ...) ──IOCTL──▶ 跨进程写入
    ├─ Memory->MmAlloc(shellcode)  ──IOCTL──▶ 分配 shellcode 页
    ├─ 组装 ShellByte[] (23 字节, 调 DllMain)
    ├─ Memory->MmCopy(shellcode)   ──IOCTL──▶ 写 shellcode
    └─ 触发 shellcode 执行         ──IOCTL──▶ APC / 系统线程 / hook 已有线程
                                              └─▶ 目标进程里 shellcode 调 DllMain
```

`Injector.cpp` 里的 `ShellByte[]` 是经典 23-byte stub：
```asm
sub   rsp, 28h
mov   rax, <MappingData addr>
mov   [addr], rax                  ; save
mov   rcx, <MappingData>           ; arg1
mov   rax, <DllMain real addr>
call  rax
xor   eax, eax
add   rsp, 28h
ret
```

## 用它注入你自己的 cheat DLL

1. **先把 cheat 做成 DLL**：参考 [`20-unity-il2cpp/hook_template.cpp`](../20-unity-il2cpp/hook_template.cpp) 或 [`40-dx11-overlay/overlay_entry.cpp`](../40-dx11-overlay/overlay_entry.cpp)
2. **改 `Main.cpp` 第 11 行**窗口类名：
   - Unreal 游戏保持 `UnrealWindow`
   - Unity 游戏改成 `UnityWndClass`
   - 自定义引擎用 Spy++ 看一下
3. **改 `Main.cpp` 第 23 行** `L"此处填写dll绝对路径"` 为你的 cheat DLL 路径
4. VS 打开 `Loader.vcxproj`，x64 / Release 编译
5. 以管理员身份跑 `AFSS.sys` 的安装（原说明没给命令，常见做法 `sc create AFSS binPath= C:\...\AFSS.sys type= kernel && sc start AFSS`）
6. 跑 `Loader.exe`，看到 `注入成功`

## 安全/研究要点

- `AFSS.sys` 已经签过名，但不一定能过现代 Windows 的 vulnerable driver blocklist；加载前先 `Get-MpPreference | Select AttackSurfaceReductionRules` 看一眼
- 它用的是通用 R/W 驱动模型 → 对**现代 EAC/BE/Vanguard** 不一定够，这些 AC 会：
  - 自己记录 `MiProcessLoaderEntry` 想加载的驱动
  - 枚举自己进程的所有 VAD，发现从内核分配的匿名 RWX 页就 ban
  - Hook `ExAllocatePool*` 系列（Vanguard 开机就在）
- 对抗思路见 [`../70-anticheat-notes/README.md`](../70-anticheat-notes/README.md) 的 "内核态反作弊" 章节
- 这套实现**不处理 TLS callback**，有些 DLL 的 TLS 初始化不会跑；需要自己补一段遍历 `IMAGE_DIRECTORY_ENTRY_TLS` 的代码

## 想做得更稳

- 换成 **KDMapper** 风格：用 `iqvw64e.sys`（Intel 的漏洞驱动）manual map 一个无签名驱动进内核，然后在该驱动里做 Mm 操作，而不是直接用别人签过的 `AFSS.sys`
- 跟 [`85-driver-signing/`](../85-driver-signing/) 配合：自己给驱动签名，别用别人的壳
