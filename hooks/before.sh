#!/usr/bin/env bash
# pi-autoresearch hook shim (pre-run). Reads the JSON payload on stdin and prints a steer
# message on stdout (<= 8 KB); empty stdout means "nothing to say".
#
# Install: `rsi-top init` copies this into <workDir>/.auto/hooks/before.sh (chmod +x).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
exec node "$root/bin/rsi-top.mjs" hook before
