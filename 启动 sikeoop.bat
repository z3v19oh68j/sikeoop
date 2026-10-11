@echo off
chcp 65001 >nul
rem 双击打开 sikeoop 开发版（Windows）。关掉这个窗口就会退出 sikeoop。
cd /d "%~dp0sweet-code-desktop" || exit /b 1

where npm >nul 2>nul || (echo 没有找到 npm，请先安装 Node.js：https://nodejs.org & pause & exit /b 1)

if not exist node_modules (
  echo 正在安装依赖，第一次会慢一点…
  call npm install || (echo 安装失败 & pause & exit /b 1)
)

echo 正在启动 sikeoop…
call npm run dev
pause
