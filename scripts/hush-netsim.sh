#!/bin/bash
# Launch a Hush build with its Signal traffic routed through scripts/netsim.mjs,
# so network conditions can be degraded for Hush alone. Starts the proxy if it
# isn't already running.
#
#   scripts/hush-netsim.sh [path/to/Hush.app]
#   node scripts/netsim.mjs set blackhole
#   node scripts/netsim.mjs set normal
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default: the Debug build ./build.sh produces
APP="${1:-$(ls -td ~/Library/Developer/Xcode/DerivedData/signal-app-*/Build/Products/Debug/Hush.app 2>/dev/null | head -1)}"
[ -d "$APP" ] || { echo "No Hush.app found; build with ./build.sh or pass a path" >&2; exit 1; }
PORT="${NETSIM_PORT:-8899}"
LOG=/tmp/hush-netsim.log

if ! curl -s "http://127.0.0.1:$((PORT + 1))/" >/dev/null; then
    NETSIM_PORT=$PORT nohup node "$SCRIPT_DIR/netsim.mjs" serve >"$LOG" 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        curl -s "http://127.0.0.1:$((PORT + 1))/" >/dev/null && break
        sleep 0.2
    done
    echo "netsim started (log: $LOG)"
fi

pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
sleep 1
# -n: a fresh instance, so the environment actually applies.
open -n --env "HTTPS_PROXY=http://127.0.0.1:$PORT" --env "HTTP_PROXY=http://127.0.0.1:$PORT" "$APP"
echo "Hush launched through netsim on :$PORT"
