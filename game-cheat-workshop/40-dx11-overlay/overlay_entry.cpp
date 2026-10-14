// DX11 ImGui overlay 最小模板
// 依赖: kiero, MinHook, ImGui (加上 backends/imgui_impl_dx11.cpp + imgui_impl_win32.cpp)
// 编译为 DLL 注入目标进程.

#include <windows.h>
#include <d3d11.h>
#include <kiero.h>
#include <MinHook.h>
#include <imgui.h>
#include <imgui_impl_dx11.h>
#include <imgui_impl_win32.h>

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND, UINT, WPARAM, LPARAM);

using FnPresent      = HRESULT(__stdcall*)(IDXGISwapChain*, UINT, UINT);
using FnResizeBuf    = HRESULT(__stdcall*)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);
static FnPresent   o_Present   = nullptr;
static FnResizeBuf o_ResizeBuf = nullptr;

static bool                     g_init = false;
static ID3D11Device*            g_dev  = nullptr;
static ID3D11DeviceContext*     g_ctx  = nullptr;
static ID3D11RenderTargetView*  g_rtv  = nullptr;
static HWND                     g_wnd  = nullptr;
static WNDPROC                  g_oWndProc = nullptr;

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM w, LPARAM l) {
    ImGui_ImplWin32_WndProcHandler(h, msg, w, l);
    return CallWindowProc(g_oWndProc, h, msg, w, l);
}

static void InitImGui(IDXGISwapChain* sc) {
    sc->GetDevice(__uuidof(ID3D11Device), (void**)&g_dev);
    g_dev->GetImmediateContext(&g_ctx);
    DXGI_SWAP_CHAIN_DESC desc; sc->GetDesc(&desc);
    g_wnd = desc.OutputWindow;

    ID3D11Texture2D* bb = nullptr;
    sc->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb);
    g_dev->CreateRenderTargetView(bb, nullptr, &g_rtv);
    bb->Release();

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::StyleColorsDark();
    ImGui_ImplWin32_Init(g_wnd);
    ImGui_ImplDX11_Init(g_dev, g_ctx);

    g_oWndProc = (WNDPROC)SetWindowLongPtr(g_wnd, GWLP_WNDPROC, (LONG_PTR)WndProc);
}

static bool g_menu_open = true;
static bool g_esp       = false;
static bool g_godmode   = false;

static void DrawUI() {
    if (GetAsyncKeyState(VK_INSERT) & 1) g_menu_open = !g_menu_open;
    if (!g_menu_open) return;

    ImGui::SetNextWindowSize({280, 180}, ImGuiCond_Once);
    ImGui::Begin("Cheat");
    ImGui::Checkbox("ESP",      &g_esp);
    ImGui::Checkbox("God Mode", &g_godmode);
    ImGui::Text("FPS: %.0f", ImGui::GetIO().Framerate);
    ImGui::End();

    // if (g_esp) DrawESP(ImGui::GetBackgroundDrawList(), {io.DisplaySize.x, io.DisplaySize.y});
}

static HRESULT __stdcall h_Present(IDXGISwapChain* sc, UINT sync, UINT flags) {
    if (!g_init) { InitImGui(sc); g_init = true; }

    ImGui_ImplDX11_NewFrame();
    ImGui_ImplWin32_NewFrame();
    ImGui::NewFrame();
    DrawUI();
    ImGui::Render();

    g_ctx->OMSetRenderTargets(1, &g_rtv, nullptr);
    ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());

    return o_Present(sc, sync, flags);
}

static HRESULT __stdcall h_ResizeBuffers(IDXGISwapChain* sc, UINT bc, UINT w, UINT h, DXGI_FORMAT f, UINT flags) {
    if (g_rtv) { g_rtv->Release(); g_rtv = nullptr; }
    HRESULT hr = o_ResizeBuf(sc, bc, w, h, f, flags);
    ID3D11Texture2D* bb = nullptr;
    sc->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb);
    g_dev->CreateRenderTargetView(bb, nullptr, &g_rtv);
    bb->Release();
    return hr;
}

static DWORD WINAPI mainThread(LPVOID) {
    if (kiero::init(kiero::RenderType::D3D11) != kiero::Status::Success) return 1;
    kiero::bind(8,  (void**)&o_Present,   (void*)h_Present);        // Present
    kiero::bind(13, (void**)&o_ResizeBuf, (void*)h_ResizeBuffers);  // ResizeBuffers
    return 0;
}

BOOL APIENTRY DllMain(HMODULE hMod, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hMod);
        CreateThread(nullptr, 0, mainThread, nullptr, 0, nullptr);
    }
    return TRUE;
}
