#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.jsが必要です（https://nodejs.org）"
  read -r -p "Enterキーで閉じます..." _
  exit 0
fi

if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8977/api/health | grep -q "^200$"; then
  open "http://127.0.0.1:8977/"
  exit 0
fi

(
  for i in {1..20}; do
    curl -s -o /dev/null http://127.0.0.1:8977/api/health && break
    sleep 0.5
  done
  open "http://127.0.0.1:8977/"
) &

exec node local-bridge/server.mjs
