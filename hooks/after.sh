#!/usr/bin/env bash
# pi-autoresearch hook shim (post-run). Scores the finished trajectory into the dashboard
# and stays silent — RSI-top never interrupts a healthy run.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
exec node "$root/bin/rsi-top.mjs" hook after
