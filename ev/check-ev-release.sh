#!/usr/bin/env bash
# check-ev-release.sh — 同步器发布对账
#
# 解决什么问题：0.6.1~0.6.8 只 build 没发布，线上长期停在 0.6.0，
# 用户升不了级而我们从版本号上看不出来。这个脚本把「该发什么」和
# 「实际发到哪」四路对齐，不一致就报警（exit 1）。
#
# 对账四方：
#   ① 本地 dist/ 最新包（我们造了什么）
#   ② GitHub Release 最新 tag（兜底通道有没有）
#   ③ app-auth/ev/ 里的包 + sha256（Vercel 主通道是否就位）
#   ④ 线上 https://app-auth.gudq.com/ev/update-ev.json（用户实际拿到的）
#
# 用法：
#   ./check-ev-release.sh            # 完整对账（含网络）
#   ./check-ev-release.sh --offline  # 只查本地与 GitHub
#   ./check-ev-release.sh --quiet    # 只在异常时输出（可挂进晨检）
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_AUTH="$(cd "$SELF_DIR/.." && pwd)"
APK_DIR="$(cd "$APP_AUTH/../ev-schedule-android/apk" && pwd)"
SITE="https://app-auth.gudq.com"
OFFLINE=0
QUIET=0
[ "${1:-}" = "--offline" ] && OFFLINE=1
[ "${1:-}" = "--quiet" ] && QUIET=1

say() { [ "$QUIET" = "1" ] || echo "$@"; }
bad=0
warn() { echo "⚠️  $*"; bad=1; }

# ① 本地 dist 最新包
LOCAL_VER=""
if [ -d "$APK_DIR/dist" ]; then
  LOCAL_VER="$(ls -1 "$APK_DIR/dist" 2>/dev/null \
    | grep -E '^EVSyncProbe-v[0-9]+\.[0-9]+\.[0-9]+\.apk$' \
    | sed -E 's/^EVSyncProbe-v(.*)\.apk$/\1/' \
    | sort -V | tail -1)"
fi

# ② GitHub Release 最新
GH_VER=""
GH_VER="$(cd "$APP_AUTH/../ev-schedule-android" 2>/dev/null \
  && gh release list --limit 20 --json tagName --jq '.[].tagName' 2>/dev/null \
  | sed -E 's/^v//' | sort -V | tail -1)"

# ③ Vercel 自托管目录
SITE_VER=""
if [ -d "$APP_AUTH/ev" ]; then
  SITE_VER="$(ls -1 "$APP_AUTH/ev" 2>/dev/null \
    | grep -E '^EVSyncProbe-v[0-9]+\.[0-9]+\.[0-9]+\.apk$' \
    | sed -E 's/^EVSyncProbe-v(.*)\.apk$/\1/' \
    | sort -V | tail -1)"
fi

# ④ 线上清单
ONLINE_JSON=""
if [ "$OFFLINE" = "0" ]; then
  ONLINE_JSON="$(curl -s --max-time 20 -H 'Cache-Control: no-cache' "$SITE/ev/update-ev.json?t=$(date +%s)" || true)"
fi
ONLINE_VER="$(printf '%s' "$ONLINE_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('versionName',''))" 2>/dev/null)"
ONLINE_SHA="$(printf '%s' "$ONLINE_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sha256',''))" 2>/dev/null)"
ONLINE_MIRROR="$(printf '%s' "$ONLINE_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('downloadUrlMirror',''))" 2>/dev/null)"

say "┌ 同步器发布对账  $(date '+%Y-%m-%d %H:%M')"
say "│ ① 本地 dist 最新 : ${LOCAL_VER:-<无>}"
say "│ ② GitHub Release : ${GH_VER:-<无>}"
say "│ ③ Vercel 目录    : ${SITE_VER:-<无>}"
if [ "$OFFLINE" = "0" ]; then
  say "│ ④ 线上清单       : ${ONLINE_VER:-<取不到>}"
  say "│    主下载源      : ${ONLINE_MIRROR:-<无>}"
else
  say "│ ④ 线上清单       : (offline 跳过)"
fi
say "└"

# ── 判定 ───────────────────────────────────────────────────
if [ -z "$LOCAL_VER" ]; then
  warn "本地 dist 里没有任何 APK，先跑 build.sh"
  exit 1
fi

# 关键一：本地已有比线上更新的版本 → 就是「造了没发」
if [ -n "$ONLINE_VER" ] && [ "$LOCAL_VER" != "$ONLINE_VER" ]; then
  NEWER="$(printf '%s\n%s\n' "$LOCAL_VER" "$ONLINE_VER" | sort -V | tail -1)"
  if [ "$NEWER" = "$LOCAL_VER" ]; then
    warn "本地 ${LOCAL_VER} 比线上 ${ONLINE_VER} 新 —— 存在未发布的版本（跑 release-ev-apk.sh）"
  else
    warn "线上 ${ONLINE_VER} 比本地 dist 新 —— 本机 dist 可能被清理过，确认是否已发布"
  fi
fi

# 关键二：线上清单指向的主下载源必须是本站自托管，否则国内用户还会失败
if [ "$OFFLINE" = "0" ] && [ -n "$ONLINE_MIRROR" ]; then
  case "$ONLINE_MIRROR" in
    "$SITE"/*) : ;;
    *github.com*|*ghproxy*) warn "主下载源仍是 GitHub/镜像（$ONLINE_MIRROR），国内会失败" ;;
    *) warn "主下载源不是本站：$ONLINE_MIRROR" ;;
  esac
fi

# 关键三：Vercel 目录必须有清单所指向的包，且 sha256 与清单一致
if [ "$OFFLINE" = "0" ] && [ -n "$ONLINE_VER" ]; then
  F="$APP_AUTH/ev/EVSyncProbe-v${ONLINE_VER}.apk"
  if [ ! -f "$F" ]; then
    warn "app-auth/ev/ 缺清单对应的包：$(basename "$F")"
  elif [ -n "$ONLINE_SHA" ]; then
    ACT="$(shasum -a 256 "$F" | cut -d' ' -f1)"
    [ "$ACT" = "$ONLINE_SHA" ] || warn "清单 sha256 与 ev/ 内实际包不一致（清单 ${ONLINE_SHA:0:12}… / 实际 ${ACT:0:12}…）"
  fi
fi

# 关键四：GitHub Release 至少要覆盖线上版本（兜底通道不能比主通道旧）
if [ -n "$GH_VER" ] && [ -n "$ONLINE_VER" ]; then
  [ "$(printf '%s\n%s\n' "$GH_VER" "$ONLINE_VER" | sort -V | tail -1)" = "$GH_VER" ] \
    || warn "GitHub Release(${GH_VER}) 落后于线上(${ONLINE_VER})，兜底通道失效"
fi
[ -n "$GH_VER" ] || warn "GitHub 上查不到任何 Release"

# 关键五：真下载一次，确认端到端能拿到完整包（可选，--offline 跳过）
if [ "$OFFLINE" = "0" ] && [ -n "$ONLINE_SHA" ] && [ -n "$ONLINE_MIRROR" ]; then
  DSHA="$(curl -sL --max-time 90 "$ONLINE_MIRROR" | shasum -a 256 | cut -d' ' -f1)"
  if [ "$DSHA" = "$ONLINE_SHA" ]; then
    say "✅ 主下载源实测可用（sha256 一致）"
  else
    warn "主下载源实测不一致（下载 ${DSHA:0:12}… vs 清单 ${ONLINE_SHA:0:12}…）"
  fi
fi

if [ "$bad" = "0" ]; then
  say "✅ 四方一致，发布状态健康"
  exit 0
fi
exit 1
