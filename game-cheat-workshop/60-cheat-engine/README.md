# 60 — Cheat Engine 工作流 & Auto Assembler 模板

Cheat Engine (CE) 是找基址/指针链/值的瑞士军刀。

## 核心流程

### 1. 找一个变量的地址

| 步骤 | 操作 |
|---|---|
| 1 | File → Open Process → 选游戏 |
| 2 | Value Type 选对（HP 常是 Float，弹药常是 4 bytes） |
| 3 | 游戏里看当前值，CE 搜 → First Scan |
| 4 | 让值变化，CE 回车 → Next Scan |
| 5 | 两三次后清单剩 1~5 个，拖到下方表格 |

### 2. 找到基址（指针扫描）

| 步骤 | 操作 |
|---|---|
| 1 | 右键地址 → Pointer scan for this address |
| 2 | 保存结果，让值变化（比如重新开游戏或切地图） |
| 3 | 回到 Pointer scanner → Pointer scanner → Rescan，选新地址 |
| 4 | 反复 2~3 次筛掉动态偏移，剩下的就是稳定基址 + 偏移链 |

### 3. 找修改它的代码（Code Finder）

- 右键 → Find out what writes to this address
- 让游戏改这个值（打一枪、吃个血包）
- 列表里的指令就是写入点
- 右键 → Replace with code that does nothing（NOP）→ 做无敌的最快路

## Auto Assembler (AA) 模板

见 `godmode.ct.aa` — 一个用 code injection 做无敌的脚本雏形。CE 的 Table 里 `Add Address Manually → Script` 粘贴即可。

## 常用快捷键

- `Ctrl+A`：Add address manually
- `Ctrl+Alt+A`：Open Auto Assembler
- `Ctrl+G`：跳到地址
- 内存查看器里 `Ctrl+B`：切换字节/反汇编
