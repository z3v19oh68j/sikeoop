#!/bin/bash
# Publishes sikeoop 4.1.61 (Windows and macOS) to the official site.
#
#   1. installers, blockmap, release notes -> /var/www/sikeoop/download/
#   2. SHA256SUMS.txt
#   3. home page (download links)
#   4. latest.yml                          -> only with --feed: from then on every installed
#                                             Windows copy is offered the update
#
# Every file goes up under a temporary name, is checked against its local SHA-256 on the server,
# and only then takes its real name. The files being replaced are kept next to them as *.bak-4158.
# Safe to run again: what is already there with the right checksum is left alone.
set -euo pipefail

V=4.1.61
FEED=0
[ "${1:-}" = "--feed" ] && FEED=1

HOST=root@162.251.95.124
KEY="$HOME/.ssh/panktanke_ed25519"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/sweet-code-desktop/dist"
SITE="$ROOT/sikeoop-site"
NOTES="$ROOT/更新公告/sikeoop-$V.md"
WWW=/var/www/sikeoop
SSH=(ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15)
SCP=(scp -q -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15)
INSTALLERS=("sikeoop-$V-setup.exe" "sikeoop-$V-portable.exe" "sikeoop-$V-arm64.dmg" "sikeoop-$V-x64.dmg")

sum() { shasum -a 256 "$1" | cut -d' ' -f1; }

# put <local file> <remote path>: upload, verify, move into place.
put() {
  local src="$1" dst="$2" want tmp
  want="$(sum "$src")"
  tmp="$(dirname "$dst")/.$(basename "$dst").uploading"
  if [ "$("${SSH[@]}" "$HOST" "sha256sum '$dst' 2>/dev/null | cut -d' ' -f1")" = "$want" ]; then
    echo "  已经在了，跳过：$dst"
    return
  fi
  echo "  上传：$dst"
  "${SCP[@]}" "$src" "$HOST:$tmp"
  "${SSH[@]}" "$HOST" "[ \"\$(sha256sum '$tmp' | cut -d' ' -f1)\" = '$want' ] && chmod 644 '$tmp' && mv '$tmp' '$dst'" \
    || { echo "  校验不一致，已停下：$dst" >&2; exit 1; }
}

# keep <remote path>: a copy of what is about to be replaced, made once.
keep() { "${SSH[@]}" "$HOST" "[ -e '$1' ] && [ ! -e '$1.bak-4158' ] && cp -p '$1' '$1.bak-4158' || true"; }

for f in "${INSTALLERS[@]}" "sikeoop-$V-setup.exe.blockmap" latest.yml; do
  [ -f "$DIST/$f" ] || { echo "缺文件：$DIST/$f" >&2; exit 1; }
done
[ -f "$NOTES" ] || { echo "缺文件：$NOTES" >&2; exit 1; }
grep -q "^version: $V\$" "$DIST/latest.yml" || { echo "latest.yml 不是 $V" >&2; exit 1; }
# The feed must describe the installer that is actually uploaded.
[ "$(openssl dgst -sha512 -binary "$DIST/sikeoop-$V-setup.exe" | base64 | tr -d '\n')" = "$(grep -m1 'sha512:' "$DIST/latest.yml" | awk '{print $2}')" ] \
  || { echo "latest.yml 里的 sha512 和安装包对不上" >&2; exit 1; }
# The home page must link to exactly what is uploaded.
for f in "${INSTALLERS[@]}"; do
  grep -q "href=\"download/$f\"" "$SITE/index.html" || { echo "首页没有链接到 $f" >&2; exit 1; }
done

echo "1/4 安装包"
for f in "${INSTALLERS[@]}" "sikeoop-$V-setup.exe.blockmap"; do put "$DIST/$f" "$WWW/download/$f"; done
put "$NOTES" "$WWW/download/sikeoop-$V.md"

echo "2/4 校验码"
SUMS="$(mktemp)"
trap 'rm -f "$SUMS"' EXIT
for f in "${INSTALLERS[@]}"; do echo "$(sum "$DIST/$f")  $f"; done > "$SUMS"
keep "$WWW/download/SHA256SUMS.txt"
put "$SUMS" "$WWW/download/SHA256SUMS.txt"

echo "3/4 首页"
keep "$WWW/index.html"
put "$SITE/index.html" "$WWW/index.html"

if [ "$FEED" = 1 ]; then
  echo "4/4 自动更新（latest.yml）"
  keep "$WWW/download/latest.yml"
  put "$DIST/latest.yml" "$WWW/download/latest.yml"
else
  echo "4/4 自动更新（latest.yml）：没有动。加 --feed 再跑一次才会推给已安装的用户"
fi

echo
echo "线上现在是："
echo "自动更新：$(curl -fsS -m 20 https://sikeoop.modgert.online/download/latest.yml | head -1)"
curl -fsS -m 20 https://sikeoop.modgert.online/ | grep -o '当前版本 Windows <b>[0-9.]*</b> · macOS <b>[0-9.]*</b>'
for f in "${INSTALLERS[@]}" SHA256SUMS.txt; do
  echo "$(curl -s -o /dev/null -m 20 -I -w '%{http_code}' "https://sikeoop.modgert.online/download/$f")  download/$f"
done
