#!/usr/bin/env bash
# 启动常驻协调守护进程。同一时刻只允许一个实例（重复启动会先退出旧的）。
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
PIDFILE="$ROOT/output/.actions/coordinator.pid"
SOCKET="$ROOT/output/.actions/coordinator.sock"
LOG="$ROOT/output/.actions/coordinator.log"

mkdir -p "$(dirname "$PIDFILE")"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "协调守护进程已在运行 (pid $(cat "$PIDFILE"))"
  exit 0
fi

rm -f "$SOCKET"
nohup python3 -u coordinator_daemon.py --root "$ROOT" --socket "$SOCKET" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 50); do
  [[ -S "$SOCKET" ]] && { echo "协调守护进程已启动 (pid $(cat "$PIDFILE"))"; exit 0; }
  sleep 0.1
done
echo "协调守护进程启动失败，请查看 $LOG" >&2
exit 1
