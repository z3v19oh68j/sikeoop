#!/bin/bash
# Publishes sikeoop 4.1.56 (Windows) and the author pages to the official site.
#
#   1. installer + blockmap        -> /var/www/sikeoop/download/
#   2. author page, the two papers and the home page (new download links, "作者" entry)
#   3. SHA256SUMS.txt
#   4. latest.yml                  -> last: from then on installed copies are offered the update
#
# Every file goes up under a temporary name, is checked against its local SHA-256 on the server,
# and only then takes its real name. The files being replaced are kept next to them as *.bak-413.
# Safe to run again: what is already there with the right checksum is left alone.
set -euo pipefail

HOST=root@162.251.95.124
KEY="$HOME/.ssh/panktanke_ed25519"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/sweet-code-desktop/dist"
SITE="$ROOT/sikeoop-site"
WWW=/var/www/sikeoop
SSH=(ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15)
SCP=(scp -q -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15)

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
keep() { "${SSH[@]}" "$HOST" "[ -e '$1' ] && [ ! -e '$1.bak-413' ] && cp -p '$1' '$1.bak-413' || true"; }

for f in "$DIST/sikeoop-4.1.56-setup.exe" "$DIST/sikeoop-4.1.56-setup.exe.blockmap" "$DIST/sikeoop-4.1.56-portable.exe" "$DIST/latest.yml" \
         "$SITE/index.html" "$SITE/liwang.html" "$SITE/papers/chain-centric-v8.html" "$SITE/papers/mhpa.html"; do
  [ -f "$f" ] || { echo "缺文件：$f" >&2; exit 1; }
done
grep -q '^version: 4.1.56$' "$DIST/latest.yml" || { echo "latest.yml 不是 4.1.56" >&2; exit 1; }
# The feed must describe the installer that is actually uploaded.
[ "$(openssl dgst -sha512 -binary "$DIST/sikeoop-4.1.56-setup.exe" | base64 | tr -d '\n')" = "$(grep -m1 'sha512:' "$DIST/latest.yml" | awk '{print $2}')" ] \
  || { echo "latest.yml 里的 sha512 和安装包对不上" >&2; exit 1; }

echo "1/4 安装包"
put "$DIST/sikeoop-4.1.56-setup.exe" "$WWW/download/sikeoop-4.1.56-setup.exe"
put "$DIST/sikeoop-4.1.56-setup.exe.blockmap" "$WWW/download/sikeoop-4.1.56-setup.exe.blockmap"
put "$DIST/sikeoop-4.1.56-portable.exe" "$WWW/download/sikeoop-4.1.56-portable.exe"

echo "2/4 网页"
"${SSH[@]}" "$HOST" "mkdir -p '$WWW/papers'"
put "$SITE/liwang.html" "$WWW/liwang.html"
put "$SITE/papers/chain-centric-v8.html" "$WWW/papers/chain-centric-v8.html"
put "$SITE/papers/mhpa.html" "$WWW/papers/mhpa.html"
keep "$WWW/index.html"
put "$SITE/index.html" "$WWW/index.html"

echo "3/4 校验码"
SUMS="$(mktemp)"
trap 'rm -f "$SUMS"' EXIT
{
  echo "$(sum "$DIST/sikeoop-4.1.56-setup.exe")  sikeoop-4.1.56-setup.exe"
  echo "$(sum "$DIST/sikeoop-4.1.56-portable.exe")  sikeoop-4.1.56-portable.exe"
  # The macOS builds stay at 4.1.2: their lines are carried over from the server.
  "${SSH[@]}" "$HOST" "grep -E 'sikeoop-4\.1\.2-(arm64|x64)\.dmg\$' '$WWW/download/SHA256SUMS.txt'"
} > "$SUMS"
keep "$WWW/download/SHA256SUMS.txt"
put "$SUMS" "$WWW/download/SHA256SUMS.txt"

echo "4/4 自动更新（latest.yml）"
keep "$WWW/download/latest.yml"
put "$DIST/latest.yml" "$WWW/download/latest.yml"

echo
echo "线上现在是："
curl -fsS -m 20 https://sikeoop.modgert.online/download/latest.yml | head -1
curl -fsS -m 20 https://sikeoop.modgert.online/ | grep -o '当前版本 Windows <b>[0-9.]*</b>'
for u in liwang.html papers/chain-centric-v8.html papers/mhpa.html download/sikeoop-4.1.56-setup.exe download/sikeoop-4.1.56-portable.exe download/SHA256SUMS.txt; do
  echo "$(curl -s -o /dev/null -m 20 -I -w '%{http_code}' "https://sikeoop.modgert.online/$u")  $u"
done
