# Game Cheat Workshop — 索引

| 路径 | 文件 | 作用 |
|---|---|---|
| `README.md` | | 总览 + 学习路径 |
| `00-primer/` | `README.md` | 进程内存、识别引擎 |
| `10-windows-external/` | `pymem_template.py` | Python 外部读写 (走指针链) |
| | `external_cpp/main.cpp` | C++ 外部读写 (RPM/WPM + Toolhelp) |
| | `README.md` | 外部 cheat 流程 |
| `20-unity-il2cpp/` | `hook_template.cpp` | Dobby inline hook DLL (无敌/无限弹药) |
| | `README.md` | IL2CPP dump 流程 |
| `30-unreal-sdk/` | `esp_core.cpp` | 枚举 GObjects + WorldToScreen + ImGui ESP |
| | `README.md` | Dumper-7 流程 |
| `40-dx11-overlay/` | `overlay_entry.cpp` | kiero + MinHook + ImGui overlay DLL |
| | `README.md` | Present hook 原理 |
| `50-frida-mobile/` | `ssl-pinning-bypass.js` | 覆盖 OkHttp/TrustManager/WebView |
| | `unity-cheat.js` | libil2cpp.so + Interceptor.replace |
| | `anti-detect.js` | /proc/self/maps 过滤 + ptrace |
| | `README.md` | Frida 环境说明 |
| `60-cheat-engine/` | `godmode.ct.aa` | AutoAssembler 拦截扣血写入 |
| | `README.md` | CE 搜索 / 指针扫 / codefinder |
| `70-anticheat-notes/` | `README.md` | VAC/EAC/BE/Vanguard/mhyProt 对抗笔记 |
| `80-kernel-reflect-inject/` | `README.md` | 用户的 AFSS.sys + Loader 工程说明，manual map 流程与改造 |
| `85-driver-signing/` | `README.md` | HookSigntool + hook.ini 时间戳伪造，50 张 pfx 盘点 |
| `90-build/` | `README.md` | 每份模板的编译/注入命令 |

## 推荐做的第一个项目

**单机 Unity 游戏做无敌 + ESP**：

1. `00-primer/` 识别引擎（看到 `GameAssembly.dll`）
2. `60-cheat-engine/` 找 HP 的指针链，确认偏移
3. `20-unity-il2cpp/` 跑 Il2CppDumper，查 `TakeDamage` RVA
4. 编译 `hook_template.cpp` 成 DLL，Xenos 注入 → 无敌
5. 编译 `overlay_entry.cpp` + `esp_core.cpp` 成 DLL 注入 → ESP
