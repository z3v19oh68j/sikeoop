// Unity IL2CPP inline hook 模板
// 依赖: Dobby (https://github.com/jmpews/Dobby)
// 编译为 DLL, 用注入器加载进游戏进程.

#include <windows.h>
#include <dobby.h>
#include <cstdio>
#include <cstdint>
#include <thread>
#include <chrono>

// ============ 从 Il2CppDumper 的 dump.cs 抄过来的 RVA ============
constexpr uintptr_t RVA_Player_TakeDamage      = 0x01A2B3C0; // void Player::TakeDamage(float dmg)
constexpr uintptr_t RVA_Weapon_GetAmmo         = 0x01B40120; // int Weapon::GetAmmo()
constexpr uintptr_t RVA_TimeScale_set          = 0x00C12340; // Time.timeScale setter
// =================================================================

static HMODULE g_game = nullptr;

template <typename Fn> Fn resolve(uintptr_t rva) {
    return reinterpret_cast<Fn>(reinterpret_cast<uintptr_t>(g_game) + rva);
}

// --- hooks ----------------------------------------------------------

using FnTakeDamage = void(__fastcall*)(void* self, float dmg);
static FnTakeDamage o_TakeDamage = nullptr;
static void __fastcall h_TakeDamage(void* self, float dmg) {
    // 无敌: 把伤害吞掉
    (void)dmg;
    // 想保留受击动画但不扣血: o_TakeDamage(self, 0.0f);
}

using FnGetAmmo = int(__fastcall*)(void* self);
static FnGetAmmo o_GetAmmo = nullptr;
static int __fastcall h_GetAmmo(void* self) {
    (void)self;
    return 999;   // 永远返回 999 发
}

// --- entry ----------------------------------------------------------

static DWORD WINAPI mainThread(LPVOID) {
    AllocConsole(); freopen_s((FILE**)stdout, "CONOUT$", "w", stdout);
    puts("[cheat] waiting for GameAssembly.dll ...");

    while (!(g_game = GetModuleHandleA("GameAssembly.dll")))
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    printf("[cheat] GameAssembly.dll @ %p\n", (void*)g_game);

    DobbyHook(resolve<void*>(RVA_Player_TakeDamage), (void*)h_TakeDamage, (void**)&o_TakeDamage);
    DobbyHook(resolve<void*>(RVA_Weapon_GetAmmo),    (void*)h_GetAmmo,    (void**)&o_GetAmmo);
    puts("[cheat] hooks installed.");
    return 0;
}

BOOL APIENTRY DllMain(HMODULE hMod, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hMod);
        CreateThread(nullptr, 0, mainThread, nullptr, 0, nullptr);
    }
    return TRUE;
}
