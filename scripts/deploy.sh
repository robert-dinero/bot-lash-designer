#!/usr/bin/env bash
# deploy.sh — run as deploy user on the VM to build and restart the bot
# Usage: bash scripts/deploy.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "=== [1/5] Pull latest code ==="
git pull --ff-only

echo "=== [2/5] Install dependencies ==="
npm ci --omit=dev

echo "=== [3/5] Type check ==="
npx tsc --noEmit

echo "=== [4/5] Build ==="
npm run build

echo "=== [5/5] Restart bot (PM2) ==="
if pm2 list | grep -q "bot"; then
  pm2 reload bot --update-env
else
  pm2 start dist/server.js --name bot \
    --max-memory-restart 300M \
    --log ~/.pm2/logs/bot.log \
    --time
  pm2 save
fi

echo ""
echo "✅ Deploy complete!"
pm2 status bot
