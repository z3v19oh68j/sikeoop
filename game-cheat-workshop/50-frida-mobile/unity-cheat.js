/*
 * Unity IL2CPP Android 游戏数值 hook (Frida)
 * 1. 先用 Il2CppDumper 跑一次 APK, 从 dump.cs 查目标方法的 RVA
 * 2. 本脚本在 libil2cpp.so 基址 + RVA 处 Interceptor.replace
 *
 * frida -U -f com.target.game -l unity-cheat.js --no-pause
 */

const OFFSETS = {
    Player_TakeDamage: 0x01A2B3C0,   // void Player::TakeDamage(float)
    Weapon_GetAmmo:    0x01B40120,   // int  Weapon::GetAmmo()
    Shop_GetCoins:     0x02101A80,   // int  Shop::GetCoins()
};

function waitForModule(name, cb) {
    var m = Process.findModuleByName(name);
    if (m) return cb(m);
    var iv = setInterval(function () {
        m = Process.findModuleByName(name);
        if (m) { clearInterval(iv); cb(m); }
    }, 200);
}

waitForModule('libil2cpp.so', function (il2cpp) {
    console.log('[+] libil2cpp.so @ ' + il2cpp.base);

    // 无敌: TakeDamage 直接 return
    Interceptor.replace(il2cpp.base.add(OFFSETS.Player_TakeDamage),
        new NativeCallback(function (self, dmg) {
            // 什么都不做
        }, 'void', ['pointer', 'float']));

    // 无限弹药: 返回 999
    Interceptor.replace(il2cpp.base.add(OFFSETS.Weapon_GetAmmo),
        new NativeCallback(function (self) { return 999; }, 'int', ['pointer']));

    // 无限金币
    Interceptor.replace(il2cpp.base.add(OFFSETS.Shop_GetCoins),
        new NativeCallback(function (self) { return 9999999; }, 'int', ['pointer']));

    console.log('[+] hooks installed');
});
