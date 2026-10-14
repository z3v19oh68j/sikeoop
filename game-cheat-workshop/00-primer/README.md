# 00 — Primer：进程内存与游戏引擎识别

## 进程内存速查

Windows 下一个进程的虚拟地址空间（x64）：

| 区段 | 典型地址 | 内容 |
|---|---|---|
| PE Image | 游戏主模块 base，如 `0x7FF6_xxxx_0000` | 代码（.text）/ 全局（.data/.rdata） |
| Heap | 多段 | `new` / `malloc` 分配的对象（玩家、实体） |
| Stack | 每线程 ~1MB | 局部变量 |
| 其他模块 | `kernel32.dll`、`UnityPlayer.dll`、`GameAssembly.dll` | 引擎导出 |

**基址（static address）** 写法：`UnityPlayer.dll+0x1A2B3C0`。重启不变，升级可能变。
**动态地址**：通过基址 + 一串偏移（指针链）走到。

## 识别游戏引擎

在游戏目录 `grep` 一下文件名：

| 看到这个文件 | 引擎 |
|---|---|
| `UnityPlayer.dll` + `GameAssembly.dll` | Unity (IL2CPP) |
| `UnityPlayer.dll` + `*Managed/*.dll` | Unity (Mono) |
| `UE4Game-Win64-Shipping.exe` / `*-Shipping.exe` 大于 100MB | Unreal 4/5 |
| `.pak` + `oo2core_*.dll` | Unreal 或 Decima |
| `source\**\*.vpk` | Source |
| `data\**\*.big` | 自研（通常是育碧/EA） |
| `*.rpf` | RAGE（GTA/RDR） |

## 快速基址扫描（Python）

```python
# pip install pymem
import pymem
pm = pymem.Pymem("game.exe")
mod = pymem.process.module_from_name(pm.process_handle, "UnityPlayer.dll")
print(hex(mod.lpBaseOfDll), hex(mod.SizeOfImage))
```

## 下一步

- 想找数值 → `60-cheat-engine/`
- 想画框 → `40-dx11-overlay/`
- 想 hook 函数 → 看引擎选 20 或 30
