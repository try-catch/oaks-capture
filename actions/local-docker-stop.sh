#!/usr/bin/env bash
# 优雅停止指定本地采集容器，让完整局缓冲写入 Mongo，保留全部历史。
set -euo pipefail
for name in "$@"; do
  [[ "$name" =~ ^oaks-official-[0-9]{2}$ ]] || { echo '非法容器名' >&2; exit 1; }
done
docker stop --time 120 "$@"
