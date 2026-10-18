#!/usr/bin/env bash
set -euo pipefail
# 同一容器重启后旧 master 已退出，清理遗留 socket，避免退化为重复连接。
if ! ssh -F /run/oaks/config -O check oaks-store >/dev/null 2>&1; then rm -f /tmp/oaks-ssh-master; fi
ssh -F /run/oaks/config -L "127.0.0.1:27018:${OAKS_MONGO_TUNNEL_HOST}:27017" -MNf oaks-store
if [[ $# -gt 0 ]]; then exec "$@"; fi
until [[ -f /run/oaks/go ]]; do sleep 1; done
exec node -r ts-node/register actions/worker.ts capture
