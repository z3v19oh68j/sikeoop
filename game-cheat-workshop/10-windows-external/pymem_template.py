"""
Windows 外部内存读写模板 (external cheat)
依赖: pip install pymem

外部作弊的套路:
1. 以调试权限打开目标进程 (pymem 自动申请 SeDebugPrivilege)
2. 定位模块基址
3. 顺着指针链走到当前值的真实地址
4. ReadProcessMemory / WriteProcessMemory 读或改

指针链示例 (在 Cheat Engine 里找出来后抄进来):
    UnityPlayer.dll + 0x01A2B3C0  -> player_ptr
        + 0x10                    -> stats_ptr
            + 0x1C8               -> hp (float)
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import pymem
import pymem.process


@dataclass
class PointerChain:
    module: str
    base_offset: int
    offsets: list[int]  # 最后一个是最终字段的 offset


def resolve(pm: pymem.Pymem, chain: PointerChain) -> int:
    mod = pymem.process.module_from_name(pm.process_handle, chain.module)
    addr = mod.lpBaseOfDll + chain.base_offset
    # 走指针链: 每一级除最后一个都要先 deref
    for off in chain.offsets[:-1]:
        addr = pm.read_ulonglong(addr) + off
    return addr + chain.offsets[-1]


def main(process_name: str = "game.exe"):
    pm = pymem.Pymem(process_name)
    print(f"[+] attached to {process_name} (pid={pm.process_id})")

    hp_chain = PointerChain(
        module="UnityPlayer.dll",
        base_offset=0x01A2B3C0,
        offsets=[0x10, 0x1C8],
    )

    while True:
        try:
            hp_addr = resolve(pm, hp_chain)
            hp = pm.read_float(hp_addr)
            print(f"HP @ {hp_addr:#x} = {hp:.1f}")

            # 血量低于 50 自动补满 (阈值触发, 比每帧写更不易被检测)
            if hp < 50.0:
                pm.write_float(hp_addr, 999.0)
                print("    -> refilled")
        except Exception as e:
            print(f"[!] read failed: {e}")

        time.sleep(0.1)


if __name__ == "__main__":
    main()
