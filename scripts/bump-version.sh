#!/bin/bash
set -e

cd "$(dirname "$0")/.."

VERSION_FILE="version.json"

if [ ! -f "$VERSION_FILE" ]; then
  echo '{"version": "1.0.0"}' > "$VERSION_FILE"
  echo "Created $VERSION_FILE with v1.0.0"
fi

CURRENT=$(node -e "console.log(require('./version.json').version)")
MAJOR=$(echo "$CURRENT" | cut -d. -f1)
MINOR=$(echo "$CURRENT" | cut -d. -f2)
PATCH=$(echo "$CURRENT" | cut -d. -f3)

if [ -z "$MAJOR" ] || [ -z "$MINOR" ] || [ -z "$PATCH" ]; then
  echo "Error: invalid version format in $VERSION_FILE: $CURRENT"
  exit 1
fi

NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

node -e "
var v = require('./version.json');
v.version = '$NEW_VERSION';
v.patch = (v.patch || 0) + 1;
require('fs').writeFileSync('$VERSION_FILE', JSON.stringify(v, null, 2) + '\n');
"
echo "Bump: v$CURRENT → v$NEW_VERSION (build patch: $(node -e "console.log(require('./version.json').patch)"))"