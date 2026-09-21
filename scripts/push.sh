#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if [ -z "$1" ]; then
  echo "Usage: ./scripts/push.sh \"commit message\""
  echo "  Auto-bumps patch version for changed components, commits all changes, and pushes."
  exit 1
fi

echo "=== Detecting changed components and bumping versions ==="
./scripts/bump-version.sh

echo ""
echo "=== Committing and pushing ==="
git add -A
git commit -m "$1"
git push

echo ""
echo "Done! Changes pushed."