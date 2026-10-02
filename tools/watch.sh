#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:-}"

if [ -z "$REMOTE" ]; then
  echo "Usage: $0 <remote>"
  exit 1
fi

ssh "$REMOTE" <<'EOF'
set -euo pipefail
SERVICE="qbosync"
journalctl -u "$SERVICE" -e -f
EOF
