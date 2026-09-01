#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if [ -z "$1" ]; then
  echo "Usage: ./scripts/push.sh \"commit message\""
  echo "  Auto-bumps patch version, commits all changes, and pushes."
  exit 1
fi

./scripts/bump-version.sh
NEW_VERSION=$(node -e "console.log(require('./version.json').version)")

git add -A
git commit -m "$1 (v$NEW_VERSION)"
git push

echo ""
echo "Done! v$NEW_VERSION pushed."