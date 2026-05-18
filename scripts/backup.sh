#!/usr/bin/env bash
# backup.sh — daily SQLite backup, keeps last 7 days
# Add to crontab: 0 3 * * * bash /home/user/bot/scripts/backup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$APP_DIR/backups"
DB_PATH="${DB_PATH:-$APP_DIR/data/bot.sqlite}"
DATE=$(date +%Y-%m-%d)

mkdir -p "$BACKUP_DIR"

# SQLite online backup (safe while bot is running)
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/bot-$DATE.sqlite'"

# Compress
gzip -f "$BACKUP_DIR/bot-$DATE.sqlite"

# Remove backups older than 7 days
find "$BACKUP_DIR" -name "*.sqlite.gz" -mtime +7 -delete

echo "✅ Backup saved: $BACKUP_DIR/bot-$DATE.sqlite.gz"
