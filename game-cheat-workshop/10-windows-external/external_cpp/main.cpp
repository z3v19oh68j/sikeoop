// 外部 cheat (C++) - 不注入, 用 ReadProcessMemory/WriteProcessMemory
// 编译 (MSVC):  cl /std:c++20 /EHsc main.cpp /link
// 编译 (MinGW): g++ -std=c++20 -O2 main.cpp -o cheat.exe -lpsapi

#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>
#include <optional>
#include <thread>
#include <chrono>

namespace mem {

DWORD pid_by_name(const wchar_t* name) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W pe{sizeof(pe)};
    if (Process32FirstW(snap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, name) == 0) {
                CloseHandle(snap);
                return pe.th32ProcessID;
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return 0;
}

std::optional<uintptr_t> module_base(DWORD pid, const wchar_t* mod_name) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    MODULEENTRY32W me{sizeof(me)};
    if (Module32FirstW(snap, &me)) {
        do {
            if (_wcsicmp(me.szModule, mod_name) == 0) {
                CloseHandle(snap);
                return reinterpret_cast<uintptr_t>(me.modBaseAddr);
            }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return std::nullopt;
}

template <typename T>
T read(HANDLE h, uintptr_t addr) {
    T val{};
    ReadProcessMemory(h, reinterpret_cast<LPCVOID>(addr), &val, sizeof(T), nullptr);
    return val;
}

template <typename T>
bool write(HANDLE h, uintptr_t addr, const T& val) {
    return WriteProcessMemory(h, reinterpret_cast<LPVOID>(addr), &val, sizeof(T), nullptr) != 0;
}

uintptr_t walk_chain(HANDLE h, uintptr_t base, const std::vector<uintptr_t>& offsets) {
    uintptr_t addr = base;
    for (size_t i = 0; i + 1 < offsets.size(); ++i) {
        addr = read<uintptr_t>(h, addr + offsets[i]);
        if (!addr) return 0;
    }
    return addr + offsets.back();
}

} // namespace mem

int wmain() {
    const wchar_t* target = L"game.exe";
    DWORD pid = mem::pid_by_name(target);
    if (!pid) { wprintf(L"[!] process not found\n"); return 1; }

    HANDLE h = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
    if (!h) { wprintf(L"[!] OpenProcess failed: %lu\n", GetLastError()); return 1; }

    auto base = mem::module_base(pid, L"UnityPlayer.dll");
    if (!base) { wprintf(L"[!] module not loaded\n"); return 1; }
    wprintf(L"[+] UnityPlayer.dll @ %p\n", (void*)*base);

    // 指针链: [[UnityPlayer+0x01A2B3C0]+0x10]+0x1C8  (float HP)
    uintptr_t static_addr = *base + 0x01A2B3C0;
    std::vector<uintptr_t> chain{0x0, 0x10, 0x1C8};

    while (true) {
        uintptr_t hp_addr = mem::walk_chain(h, static_addr, chain);
        if (hp_addr) {
            float hp = mem::read<float>(h, hp_addr);
            wprintf(L"HP = %.1f\n", hp);
            if (hp < 50.f) mem::write<float>(h, hp_addr, 999.f);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}
