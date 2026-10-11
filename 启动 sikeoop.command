#!/bin/zsh -l
# 双击打开 sikeoop 开发版（Mac）。关掉这个终端窗口就会退出 sikeoop。
cd "$(dirname "$0")/sweet-code-desktop" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "没有找到 npm，请先安装 Node.js：https://nodejs.org"
  read -k1 "?按任意键关闭…"; exit 1
fi

# 第一次运行，或依赖有变化时，先安装依赖。
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "正在安装依赖，第一次会慢一点…"
  npm install || { read -k1 "?安装失败，按任意键关闭…"; exit 1; }
fi

echo "正在启动 sikeoop…"
npm run dev
