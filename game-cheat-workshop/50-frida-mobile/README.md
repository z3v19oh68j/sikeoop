# 50 — Frida Mobile (Android/iOS)

手游常用：SSL pinning bypass、改数值、改配置、hook Unity Mono/IL2CPP、绕根检测。

## 环境

```bash
pip install frida-tools
# Android 需要 root 或者把 frida-gadget 塞进 APK 重打包
adb push frida-server /data/local/tmp/
adb shell su -c '/data/local/tmp/frida-server &'
```

## 文件

- `ssl-pinning-bypass.js` — 通用 OkHttp / TrustManager 绕过
- `unity-cheat.js` — 读 libil2cpp.so 偏移改 HP / 金币
- `anti-detect.js` — frida detection bypass
- `inject.sh` — 一键跑

## 常用

```bash
frida -U -f com.target.app -l unity-cheat.js --no-pause
frida -U -n com.target.app -l ssl-pinning-bypass.js   # 挂到已启动进程
```
