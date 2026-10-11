#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
base=http://127.0.0.1:8787
mkdir -p .local
node -e 'require("fs").writeFileSync(".local/index.html","<!doctype html><html><body><h1>B5 smoke</h1></body></html>")'
device=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
sha=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(".local/index.html")).digest("hex"))')
size=$(wc -c < .local/index.html | tr -d ' ')
curl --fail-with-body -sS -D .local/create.headers "$base/v1/sites" -H "X-Sikeoop-Device: $device" -H 'Content-Type: application/json' --data '{}' > .local/create.json
cat .local/create.headers .local/create.json; echo
id=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".local/create.json")).siteId)')
token=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".local/create.json")).siteToken)')
curl --fail-with-body -sS -D .local/deploy.headers "$base/v1/sites/$id/deploy" -H "X-Sikeoop-Device: $device" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data "{\"files\":[{\"path\":\"index.html\",\"sha256\":\"$sha\",\"size\":$size}]}" > .local/deploy.json
cat .local/deploy.headers .local/deploy.json; echo
dep=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".local/deploy.json")).deployId)')
curl --fail-with-body -sS -i -X PUT "$base/v1/sites/$id/blobs/$sha" -H "X-Sikeoop-Device: $device" -H "Authorization: Bearer $token" --data-binary @.local/index.html
curl --fail-with-body -sS -i "$base/v1/sites/$id/deploy/$dep/commit" -H "X-Sikeoop-Device: $device" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data '{}'
printf '\n'
curl --fail-with-body -sS -i "$base/s/$id/"
printf '\n'
