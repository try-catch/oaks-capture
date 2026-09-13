#!/usr/bin/env bash
# 重启常驻协调守护进程（先落盘再拉起，避免丢失队列状态）。
set -euo pipefail
cd "$(dirname "$0")"
./stop.sh
./start.sh
