#!/bin/bash
# Restores the backed-up Signal database
BACKUP="/tmp/signal-app-data/signal.db.backup"
TARGET="/tmp/signal-app-data/signal.db"

if [ ! -f "$BACKUP" ]; then
  echo "Error: Backup not found at $BACKUP"
  exit 1
fi

if [ -f "$TARGET" ]; then
  echo "Removing current database..."
  rm "$TARGET"
fi

cp "$BACKUP" "$TARGET"
echo "Restored $BACKUP -> $TARGET"
