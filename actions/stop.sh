#!/usr/bin/env bash
# 停止常驻协调守护进程，并把内存中的队列状态落盘。
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
PIDFILE="$ROOT/output/.actions/coordinator.pid"
SOCKET="$ROOT/output/.actions/coordinator.sock"

if [[ ! -f "$PIDFILE" ]]; then
  echo "协调守护进程未运行"
  exit 0
fi
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  for _ in $(seq 1 50); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$PID" 2>/dev/null && { echo "优雅停止超时，强制结束 $PID" >&2; kill -KILL "$PID"; }
fi
rm -f "$PIDFILE" "$SOCKET"
echo "协调守护进程已停止"
