# 10 — Windows External Cheat

**外部** = 自己的进程通过 `OpenProcess` + `Read/WriteProcessMemory` 操作游戏，不往游戏里塞代码。好处是侵入性低、不改游戏内存执行流、容易起步；缺点是没法 hook 函数、每一帧延迟高。

## 文件

- `pymem_template.py` — Python 原型最快，适合调通指针链
- `external_cpp/main.cpp` — C++ 版，自动化成品

## 流程

1. 用 Cheat Engine 找出某个数值的指针链（见 `60-cheat-engine/`）
2. 把 `module + base_offset + offsets[]` 抄到模板里
3. 跑起来验证读到的值跟游戏里一致，再加写入逻辑

## 典型目标数值

- `float` 血量、法力、金币
- `int32` 弹药、等级
- `vec3` 坐标（12 字节连续 float）
- `bool`（1 字节）无敌/穿墙 flag

## 常见坑

- 指针链在版本更新后失效 → 用模式扫描（AOB scan）代替写死偏移
- `OpenProcess` 失败 → 以管理员身份跑；某些游戏开了 PP (ProtectedProcess) 需驱动
- 写入立刻被回滚 → 服务端权威数值，改了也白改，改本地显示用
