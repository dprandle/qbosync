#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:-}"

if [ -z "$REMOTE" ]; then
  echo "Usage: $0 <remote>"
  exit 1
fi

ssh "$REMOTE" <<'EOF'
set -euo pipefail

APP_DIR="$HOME/qbosync"
SERVICE="qbosync"
BRANCH="main"
WAIT_SECONDS=30

echo "==> Deploying in $APP_DIR"
cd "$APP_DIR"

echo "==> Pulling latest code"
git fetch origin "$BRANCH" --force --tags --prune-tags
git switch "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> Installing dependencies"
npm ci

echo "==> Building"
npm run build
npm cache clean --force >/dev/null 2>&1 || true

echo "==> Restarting $SERVICE"
systemctl restart "$SERVICE"

echo "==> Watching $SERVICE for ${WAIT_SECONDS}s..."
for ((i=1; i<=WAIT_SECONDS; i++)); do
  if ! systemctl is-active --quiet "$SERVICE"; then
    echo
    echo "❌ Deploy failed: $SERVICE stopped during startup"
    echo
    echo "==> systemctl status"
    systemctl status "$SERVICE" --no-pager || true
    echo
    echo "==> Recent logs"
    journalctl -u "$SERVICE" -n 30 --no-pager || true
    systemctl stop "$SERVICE"
    echo "STOPPED SERVICE -- FIX THE ISSUE!!!"
    exit 1
  fi
  sleep 1
done

echo
echo "✅ $SERVICE stayed up for ${WAIT_SECONDS}s"
echo
echo "==> Following logs (Ctrl-C to stop)"
journalctl -u "$SERVICE" -f
EOF
