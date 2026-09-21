#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"

VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_DIR/manifest.json" | head -1 | sed 's/.*"\(.*\)"/\1/')
OUTPUT="$DIST_DIR/EV-Schedule-Sync-v${VERSION}.abp"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp "$PROJECT_DIR/manifest.json" "$DIST_DIR/"
cp "$PROJECT_DIR/icon.png" "$DIST_DIR/"
cp "$PROJECT_DIR/target/wasm32-wasip2/release/ev_schedule_sync.wasm" "$DIST_DIR/ev-schedule-sync.wasm"

echo "dist contents:"
ls -lh "$DIST_DIR/"

cd "$DIST_DIR"
zip -r "$OUTPUT" . -x "*.abp"

echo ""
echo "ABP built: $OUTPUT"
ls -lh "$OUTPUT"