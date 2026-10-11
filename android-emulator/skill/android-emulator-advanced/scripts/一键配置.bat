@echo off
chcp 65001 >nul
title Android 模拟器一键配置
rem 双击运行即可。绕过执行策略，只对本次运行生效。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-android-emulator.ps1" -Launch
echo.
echo 按任意键关闭窗口...
pause >nul
