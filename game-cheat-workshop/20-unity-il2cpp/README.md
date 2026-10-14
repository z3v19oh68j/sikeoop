# 20 — Unity IL2CPP

IL2CPP 把 C# 编译成 C++ 再编译成原生，`GameAssembly.dll` 里是导出函数，`global-metadata.dat` 里是类名/方法名/字段。

## 工具链

| 用途 | 工具 |
|---|---|
| 导出所有类/方法/偏移 | [Il2CppDumper](https://github.com/Perfare/Il2CppDumper) |
| 交互式分析 + IDA 脚本 | [Il2CppInspector](https://github.com/djkaty/Il2CppInspector) |
| Mono 版（有 `Managed/`） | dnSpy / ILSpy |
| Inline hook | [Dobby](https://github.com/jmpews/Dobby) / MinHook / Detours |

## Dump 流程

```powershell
# 1. 把 GameAssembly.dll 和 global-metadata.dat 拖到 Il2CppDumper
# 2. 产出：
#    - dump.cs           可读的 C# 伪代码（含每个方法的 RVA）
#    - script.json       IDA Python 脚本（恢复符号用）
#    - il2cpp.h          完整 C 头
#    - DummyDll\*.dll    可导入 dnSpy 看结构的壳 DLL
```

在 `dump.cs` 里找目标方法，比如：

```csharp
// RVA: 0x1A2B3C0 Offset: 0x1A2A7C0  VA: 0x1801A2B3C0
public bool CanTakeDamage() { }
```

目标进程里真实地址 = `GameAssembly.dll base + RVA`。

## Hook：改返回值（Dobby）

见 `hook_template.cpp`。核心套路：

1. DLL 注入目标进程（Manual Map / LoadLibrary）
2. 等 `GameAssembly.dll` 加载完
3. `GetModuleHandle("GameAssembly.dll") + RVA` 拿到目标函数
4. `DobbyHook(target, &MyHook, (void**)&orig)` 替换
5. 在 `MyHook` 里改参数/返回值

## 常见目标

| 做法 | 目标方法示例 |
|---|---|
| 无敌 | `TakeDamage` 直接 return / 把 damage 改成 0 |
| 一击必杀 | 自身调 `TakeDamage` 时把 damage 改成 999999 |
| 无限弹药 | `Reload` 或 `OnBulletFired` 跳过 `--ammo` |
| 透视 | `Camera.cullingMask` 置满 / `Material.renderQueue` 改层 |
| 加速 | `Time.timeScale` set |
