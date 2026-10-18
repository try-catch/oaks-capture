#!/usr/bin/env bash
set -euo pipefail
ssh -F /run/oaks/config -L "127.0.0.1:27018:${OAKS_MONGO_TUNNEL_HOST}:27017" -MNf oaks-store
if [[ $# -gt 0 ]]; then exec "$@"; fi
until [[ -f /run/oaks/go ]]; do sleep 1; done
exec node -r ts-node/register actions/worker.ts capture
