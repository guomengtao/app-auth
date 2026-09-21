#!/bin/bash
set -e

cd "$(dirname "$0")/.."

ROOT_DIR=$(pwd)

bump_json_version() {
  local file="$1"
  local label="$2"

  if [ ! -f "$file" ]; then
    echo "  [skip] $label: $file not found"
    return 1
  fi

  local CURRENT
  CURRENT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$file','utf8')).version)")

  local MAJOR MINOR PATCH
  MAJOR=$(echo "$CURRENT" | cut -d. -f1)
  MINOR=$(echo "$CURRENT" | cut -d. -f2)
  PATCH=$(echo "$CURRENT" | cut -d. -f3)

  if [ -z "$MAJOR" ] || [ -z "$MINOR" ] || [ -z "$PATCH" ]; then
    echo "  [skip] $label: invalid version format '$CURRENT'"
    return 1
  fi

  local NEW_PATCH=$((PATCH + 1))
  local NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

  node -e "
    var fs = require('fs');
    var data = JSON.parse(fs.readFileSync('$file', 'utf8'));
    data.version = '$NEW_VERSION';
    fs.writeFileSync('$file', JSON.stringify(data, null, 2) + '\n');
  "

  echo "  $label: v$CURRENT -> v$NEW_VERSION"
  return 0
}

get_changed_files() {
  local staged unstaged untracked
  staged=$(git diff --cached --name-only 2>/dev/null || true)
  unstaged=$(git diff --name-only 2>/dev/null || true)
  untracked=$(git ls-files --others --exclude-standard 2>/dev/null || true)
  echo -e "$staged\n$unstaged\n$untracked" | sort -u | grep -v '^$' || true
}

is_main_file() {
  local file="$1"
  for td in tools/ev-notifier tools/ev-schedule-sync; do
    case "$file" in
      $td/*) return 1 ;;
    esac
  done
  return 0
}

component_changed() {
  local comp="$1"
  local dir="$2"
  local changed=1

  echo "$CHANGED_FILES" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ "$comp" = "main" ]; then
      if is_main_file "$f"; then
        echo "CHANGED" > /tmp/_bump_comp_$$.tmp
      fi
    else
      case "$f" in
        $dir/*) echo "CHANGED" > /tmp/_bump_comp_$$.tmp ;;
      esac
    fi
  done

  if [ -f /tmp/_bump_comp_$$.tmp ]; then
    rm -f /tmp/_bump_comp_$$.tmp
    return 0
  fi
  return 1
}

CHANGED_FILES=$(get_changed_files)

if [ -z "$CHANGED_FILES" ]; then
  echo "No changed files detected. Bumping main project version by default."
fi

BUMPED_COUNT=0
BUMPED_LIST=""

bump_component() {
  local comp="$1"
  local dir="$2"
  local file="$3"
  local label="$4"

  if component_changed "$comp" "$dir"; then
    if bump_json_version "$file" "$label"; then
      BUMPED_COUNT=$((BUMPED_COUNT + 1))
      if [ -n "$BUMPED_LIST" ]; then
        BUMPED_LIST="$BUMPED_LIST, "
      fi
      BUMPED_LIST="${BUMPED_LIST}${label}"
    fi
  fi
}

bump_component "main"                ""                                                                                        "version.json"                                                              "app-auth (main)"
bump_component "ev-notifier"         "tools/ev-notifier"                                                                       "tools/ev-notifier/version.json"                                             "ev-notifier"
bump_component "ev-schedule-sync"    "tools/ev-schedule-sync"                                                                  "tools/ev-schedule-sync/astrobox-build/astrobox-plugin/manifest.json"        "ev-schedule-sync"

if [ "$BUMPED_COUNT" -eq 0 ]; then
  echo "No component-specific changes detected. Bumping main project."
  bump_json_version "version.json" "app-auth (main)"
else
  echo ""
  echo "Bumped $BUMPED_COUNT component(s): $BUMPED_LIST"
fi