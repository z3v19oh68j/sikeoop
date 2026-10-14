# 40 — DirectX 11 ImGui Overlay

游戏内画自己的菜单和 ESP 的标准做法：hook `IDXGISwapChain::Present`，在它调用原始 Present 之前，用 ImGui 画一帧。

## 工具

- [kiero](https://github.com/Rebzzel/kiero) — 一行拿到 D3D11/12/9/10/OpenGL/Vulkan 的 vtable
- [MinHook](https://github.com/TsudaKageyu/minhook) — inline hook
- [Dear ImGui](https://github.com/ocornut/imgui) — UI 库

## 流程

1. 用 kiero 定位 `Present` 和 `ResizeBuffers` 的虚函数
2. MinHook 替换它们
3. 在 hook 里首次调用时初始化 ImGui + DX11 后端
4. 每帧：`ImGui_ImplDX11_NewFrame` → `ImGui::NewFrame` → 画 UI / ESP → `Render` → 调原始 Present

见 `overlay_entry.cpp` 的最小可用版本。

## 组合

- UI 菜单：`ImGui::Begin("Cheat")` 里放 Checkbox 控制各功能开关
- ESP：拿到敌人屏幕坐标后用 `ImGui::GetBackgroundDrawList()->AddRect()`
- 画面不显示 → 你 hook 对了 `IDXGISwapChain` 但游戏用的是 `IDXGISwapChain1`，kiero 已经处理，确认 kiero 返回 `kiero::Status::Success`

## 调试建议

先在**非保护游戏**（如 Minecraft Bedrock、单机沙盒）里调通 overlay，再移植到目标游戏。
