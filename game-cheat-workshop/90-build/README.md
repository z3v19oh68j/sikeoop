# 90 — 构建脚本

各模板的编译命令集合。CI 不需要，手动跑即可。

## Windows external C++ (10-windows-external/external_cpp)

```powershell
# MSVC (推荐)
cl /std:c++20 /EHsc /O2 main.cpp /link
# 产出: main.exe
```

## Unity hook DLL (20-unity-il2cpp)

```powershell
# 先编译 Dobby 为静态库 (clone + cmake), 得到 Dobby.lib
cl /std:c++20 /LD /EHsc /O2 hook_template.cpp /I<dobby_include> /link Dobby.lib
# 产出: hook_template.dll, 用 Xenos 注入目标进程
```

## DX11 overlay DLL (40-dx11-overlay)

```powershell
# 需要先把 kiero/, MinHook/, imgui/, imgui/backends/ 的源码加进来
cl /std:c++20 /LD /EHsc /O2 overlay_entry.cpp ^
   kiero.cpp ^
   minhook\src\*.c ^
   imgui\*.cpp imgui\backends\imgui_impl_dx11.cpp imgui\backends\imgui_impl_win32.cpp ^
   /I kiero /I minhook\include /I imgui /I imgui\backends ^
   /link d3d11.lib dxgi.lib d3dcompiler.lib user32.lib gdi32.lib
```

## 注入器

推荐现成工具：
- [Xenos](https://github.com/DarthTon/Xenos) — manual map 友好
- Process Hacker + "Inject DLL"
- 或者写 10 行 `CreateRemoteThread + LoadLibraryA` 的小程序

## Frida (50-frida-mobile)

无需编译，`frida -U -f pkg -l script.js --no-pause` 直接跑。
