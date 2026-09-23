#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"

VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_DIR/manifest.json" | head -1 | sed 's/.*"\(.*\)"/\1/')
OUTPUT="$DIST_DIR/TabExperiment-v${VERSION}.abp"

mkdir -p "$DIST_DIR"

cp "$PROJECT_DIR/manifest.json" "$DIST_DIR/"
cp "$PROJECT_DIR/icon.png" "$DIST_DIR/" 2>/dev/null || echo "(no icon.png)"
cp "$PROJECT_DIR/target/wasm32-wasip2/release/tab_experiment.wasm" "$DIST_DIR/tab-experiment.wasm"

echo "dist contents:"
ls -lh "$DIST_DIR/"

cd "$DIST_DIR"
zip -r "$OUTPUT" . -x "*.abp"

echo ""
echo "ABP built: $OUTPUT"
ls -lh "$OUTPUT"