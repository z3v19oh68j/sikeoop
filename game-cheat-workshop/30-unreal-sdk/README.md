# 30 — Unreal Engine 4/5 SDK Dump & ESP

Unreal 把所有运行时对象挂在全局数组 `GObjects` 下，名字在 `GNames` 池里。拿到这两个全局就能枚举世界里所有东西，自然就能画 ESP、读血量、改属性。

## 工具链

| 用途 | 工具 |
|---|---|
| 全自动 SDK dump | [Dumper-7](https://github.com/Encryqed/Dumper-7) （活跃，支持 UE 5.3+） |
| UE4SS 脚本/mod | [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) |
| 老工具 | UnrealFinderTool（UE 4.2x 可用，新版本常挂） |

## Dump 流程

1. 游戏启动到主菜单
2. 把 `Dumper-7.dll` 用 Xenos / Manual Mapper 注入进 `*-Shipping.exe`
3. 输出目录会出现 `SDK/` 文件夹和 `OffsetsInfo.txt`
4. `OffsetsInfo.txt` 里写了 `GObjects`、`GNames`、`AppendString`、`ProcessEvent` 等关键偏移

## 用 SDK

把 `SDK/` 拖进你的工程，`#include "SDK.hpp"`，就能写：

```cpp
#include "SDK.hpp"
using namespace SDK;

UWorld* world = UWorld::GetWorld();
AGameStateBase* gs = world->GameState;
TArray<APlayerState*> players = gs->PlayerArray;

for (int i = 0; i < players.Num(); ++i) {
    APlayerState* ps = players[i];
    APawn* pawn = ps->PawnPrivate;
    if (!pawn) continue;
    FVector pos = pawn->K2_GetActorLocation();
    float hp  = pawn->GetHealth();
    // -> 画 ESP: 把 pos 投影到屏幕 2D, 画框 + 血条
}
```

## ESP 原理

1. 枚举 `GObjects` 或走 `UWorld->Levels->Actors`
2. 每个敌人拿 `WorldLocation`（3D 坐标）
3. 用 `UGameplayStatics::ProjectWorldToScreen` 或自己从 `MinimalViewInfo` 算 2D 投影
4. 把结果交给 overlay（见 `40-dx11-overlay/`）画框

## 常见障碍

- **包加密**：很多新 UE 游戏 `.pak` 用 AES-256，SDK dump 只影响 asset 加载，不影响内存结构 → 直接 dump 内存即可
- **FName 加密** / `AppendString` 虚表换位：Dumper-7 多数能自动适配
- **EAC/BE** 保护进程：注入前要 bypass 内核回调（见 `70-anticheat-notes/`）
