#!/bin/bash
# Deploy script — run on the server inside ~/bot-lash-designer
set -e

echo "==> Installing dependencies..."
npm ci --omit=dev

echo "==> Building TypeScript..."
npm run build

echo "==> Creating data directory..."
mkdir -p data

echo "==> Starting with PM2..."
pm2 start ecosystem.config.cjs || pm2 restart bot-lash-designer

echo "==> Saving PM2 process list..."
pm2 save

echo "==> Done. Status:"
pm2 show bot-lash-designer
