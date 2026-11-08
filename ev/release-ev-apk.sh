#!/usr/bin/env bash
# release-ev-apk.sh — 同步器（EVSyncProbe）一键发布
#
# 为什么需要这个脚本：
#   0.6.1~0.6.8 曾经只在本地 build 过、既没上传 GitHub Release、也没更新线上清单，
#   结果是「版本号在跑、用户拿不到」，线上长期停在 0.6.0。发布必须四步齐全，
#   少任何一步都会造成假发布，所以把四步固化成一个脚本。
#
# 四步：build → GitHub Release 上传 → 包入 app-auth/ev/（Vercel 自托管，同时裁掉
#       超出保留数的旧包）→ 更新 update-ev.json（Vercel 为主下载源）→ push → 线上校验
#
# 用法：
#   ./release-ev-apk.sh --task evtask-D-evapp-auth-261108-xxxxxx
#   ./release-ev-apk.sh --task ... --notes "自定义更新说明"
#   ./release-ev-apk.sh --task ... --keep 2          # 只保留最近 2 个包（默认 3）
#   ./release-ev-apk.sh --task ... --no-build        # 复用 dist/ 里已存在的包
#   ./release-ev-apk.sh --task ... --dry-run         # 只打印将要做的事
#
# 前置：gh 已登录、能 push app-auth、apk/build.sh 可跑通
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_AUTH="$(cd "$SELF_DIR/.." && pwd)"
APK_REPO="$(cd "$APP_AUTH/../ev-schedule-android" && pwd)"
APK_DIR="$APK_REPO/apk"
VERSION_ENV="$APK_DIR/version.env"
DIST_DIR="$APK_DIR/dist"
SITE="https://app-auth.gudq.com"
MANIFEST="$APP_AUTH/ev/update-ev.json"

TASK=""
NOTES=""
DO_BUILD=1
DRY=0
KEEP=3

while [ $# -gt 0 ]; do
  case "$1" in
    --task)      TASK="${2:-}"; shift 2 ;;
    --notes)     NOTES="${2:-}"; shift 2 ;;
    --keep)      KEEP="${2:-3}"; shift 2 ;;
    --no-build)  DO_BUILD=0; shift ;;
    --dry-run)   DRY=1; shift ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（-h 看用法）" >&2; exit 2 ;;
  esac
done

die() { echo "❌ $*" >&2; exit 1; }
say() { echo "── $*"; }
run() { if [ "$DRY" = "1" ]; then echo "   [dry] $*"; else eval "$@"; fi; }

case "$KEEP" in
  ''|*[!0-9]*) die "--keep 需要正整数（收到：$KEEP）" ;;
esac
[ "$KEEP" -ge 1 ] || die "--keep 至少为 1"

# ── 0. 前置 ────────────────────────────────────────────────
[ -f "$VERSION_ENV" ] || die "找不到 $VERSION_ENV"
# shellcheck disable=SC1090
VER="$(grep -E '^VERSION_NAME=' "$VERSION_ENV" | cut -d= -f2 | tr -d ' \r')"
CODE="$(grep -E '^VERSION_CODE=' "$VERSION_ENV" | cut -d= -f2 | tr -d ' \r')"
[ -n "$VER" ] && [ -n "$CODE" ] || die "version.env 解析失败（VER=$VER CODE=$CODE）"
APK_NAME="EVSyncProbe-v${VER}.apk"

echo "版本：${VER}（code ${CODE}）  包名：${APK_NAME}"
[ "$DRY" = "1" ] && echo "⚠️  dry-run：不会真正构建/上传/提交"

# ── 1. 构建 ────────────────────────────────────────────────
if [ "$DO_BUILD" = "1" ]; then
  say "1/6 构建 APK"
  if [ "$DRY" = "0" ]; then
    ( cd "$APK_DIR" && bash build.sh ) || die "build.sh 失败"
  else
    echo "   [dry] cd $APK_DIR && bash build.sh"
  fi
else
  say "1/6 跳过构建（--no-build）"
fi

[ "$DRY" = "1" ] || [ -f "$DIST_DIR/$APK_NAME" ] || die "产物不存在：$DIST_DIR/$APK_NAME（dist 里的名字对不上 version.env？）"
SHA="$( [ "$DRY" = "1" ] && echo "<sha>" || shasum -a 256 "$DIST_DIR/$APK_NAME" | cut -d' ' -f1 )"
SIZE="$( [ "$DRY" = "1" ] && echo 0 || stat -f%z "$DIST_DIR/$APK_NAME" )"

# 构建脚本会把 version.env bump 到下一版，所以这里的 VER/CODE 必须来自构建前。
# 保险起见再核对一次 dist/update-ev.json 的版本与本脚本一致。
if [ "$DRY" = "0" ] && [ -f "$DIST_DIR/update-ev.json" ]; then
  DIST_VER="$(python3 -c "import json;print(json.load(open('$DIST_DIR/update-ev.json')).get('versionName',''))" 2>/dev/null)"
  [ "$DIST_VER" = "$VER" ] || die "dist/update-ev.json 版本($DIST_VER) 与 version.env($VER) 不一致，拒发"
fi
echo "sha256：$SHA  大小：$SIZE"

# ── 2. GitHub Release（兜底通道）─────────────────────────────
say "2/6 GitHub Release v${VER}"
TAG="v${VER}"
if gh release view "$TAG" --repo "$(cd "$APK_REPO" && git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?#\1#')" >/dev/null 2>&1; then
  say "   Release 已存在，补传资产"
  run "( cd '$APK_REPO' && gh release upload '$TAG' 'apk/dist/$APK_NAME' --clobber )"
else
  run "( cd '$APK_REPO' && gh release create '$TAG' 'apk/dist/$APK_NAME' --target main --title 'Ev课程表同步器 v${VER}' --notes '见 app-auth/ev/update-ev.json 的 updateLog' )"
fi

# ── 3. 包入 Vercel 自托管目录（主通道）+ 裁剪历史包 ─────────
say "3/6 复制包到 app-auth/ev/，并裁剪旧包（保留最近 ${KEEP} 个）"
run "cp -p '$DIST_DIR/$APK_NAME' '$APP_AUTH/ev/$APK_NAME'"

# 目录里每版 +500KB，不裁剪会让仓库持续变重。规则：按版本降序保留 N 个，
# 更早的**先备份到 ev/_archive-apk/ 并逐字节校验，通过后才删**；
# 备份失败一律中止删除——宁可留冗余，也不留不可恢复的删除。
prune_old_pkgs() {
  local dir="$APP_AUTH/ev" arch="$APP_AUTH/ev/_archive-apk" i=0 v del=0 list
  list="$(ls -1 "$dir"/EVSyncProbe-v*.apk 2>/dev/null \
          | sed -E 's#.*/EVSyncProbe-v(.*)\.apk#\1#' | sort -Vr)"
  [ -n "$list" ] || { echo "   ev/ 下没有安装包，跳过裁剪"; return 0; }
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    i=$((i + 1))
    [ "$i" -le "$keep_n" ] && continue
    f="$dir/EVSyncProbe-v$v.apk"
    echo "   裁剪 v$v（超出保留 ${keep_n} 个）"
    if [ "$DRY" = "1" ]; then
      echo "   [dry] 备份到 ev/_archive-apk/ 后 git rm ev/EVSyncProbe-v$v.apk"
      del=$((del + 1)); continue
    fi
    mkdir -p "$arch" || { echo "⚠️  无法创建备份目录 $arch，跳过裁剪（不删任何文件）"; return 0; }
    if ! cp -p "$f" "$arch/" || ! cmp -s "$f" "$arch/EVSyncProbe-v$v.apk"; then
      echo "⚠️  备份 v$v 失败/校验不一致，中止裁剪（不删任何文件）"
      return 0
    fi
    if ( cd "$APP_AUTH" && git ls-files --error-unmatch "ev/EVSyncProbe-v$v.apk" >/dev/null 2>&1 ); then
      ( cd "$APP_AUTH" && git rm --quiet "ev/EVSyncProbe-v$v.apk" ) \
        || { echo "⚠️  git rm v$v 失败，已保留该文件"; continue; }
    else
      rm -f "$f"   # 未跟踪的包（例如上次中断留下）直接清掉，备份已就位
    fi
    del=$((del + 1))
  done <<< "$list"
  if [ "$del" = "0" ]; then
    echo "   无需裁剪（当前包数 ≤ ${keep_n}）"
  elif [ "$DRY" = "1" ]; then
    echo "   [dry] 模拟裁剪 ${del} 个（真实执行时会先备份到 ev/_archive-apk/ 再删）"
  else
    echo "   已裁剪 ${del} 个，备份在 ev/_archive-apk/（gitignore 已忽略，不入库）"
  fi
}
keep_n="$KEEP"
prune_old_pkgs

# ── 4. 更新清单：Vercel 为主、GitHub 兜底 ───────────────────
say "4/6 更新 update-ev.json"
if [ "$DRY" = "1" ]; then
  echo "   [dry] mirror=https://app-auth.gudq.com/dl/$APK_NAME origin=GitHub"
else
  NOTES="$NOTES" VER="$VER" CODE="$CODE" SHA="$SHA" APK_NAME="$APK_NAME" python3 - "$MANIFEST" <<'PY'
import json, os, sys, collections
p = sys.argv[1]
ver, code, sha, name = os.environ["VER"], int(os.environ["CODE"]), os.environ["SHA"], os.environ["APK_NAME"]
notes = os.environ.get("NOTES", "").strip()
d = json.load(open(p), object_pairs_hook=collections.OrderedDict)
d["versionCode"] = code
d["versionName"] = ver
d["sha256"] = sha
d["downloadUrlMirror"] = "https://app-auth.gudq.com/dl/" + name
d["downloadUrlOrigin"] = ("https://github.com/guomengtao/ev-schedule-android/releases/download/"
                          "v%s/%s" % (ver, name))
if notes:
    d["updateLog"] = notes
json.dump(d, open(p, "w"), ensure_ascii=False, indent=1)
open(p, "a").write("\n")
print("   清单已写入：", d["downloadUrlMirror"])
PY
fi

# ── 5. 提交推送 ────────────────────────────────────────────
say "5/6 提交并推送"
[ -n "$TASK" ] || die "缺少 --task 单号（提交门禁需要）；请先 ev-add-task.js 建单"
run "( cd '$APP_AUTH' && git add -- 'ev/$APK_NAME' ev/update-ev.json \
  && ~/.workbuddy/scripts/ev-commit.sh -m 'release: 同步器 ${VER}(code ${CODE}) 上线，主下载源改为 Vercel 自托管 (${TASK})' \
  && git push )"

# ── 6. 线上校验（等 Vercel 部署）─────────────────────────────
say "6/6 线上校验"
if [ "$DRY" = "1" ]; then
  echo "   [dry] 轮询 $SITE/ev/update-ev.json 直到 versionName=$VER"
  exit 0
fi
OK=0
for i in 1 2 3 4 5 6 7 8; do
  R="$(curl -s --max-time 20 -H 'Cache-Control: no-cache' "$SITE/ev/update-ev.json?t=$(date +%s)$i" || true)"
  V="$(printf '%s' "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('versionName',''))" 2>/dev/null)"
  echo "   第 ${i} 次：线上清单 versionName=${V:-<空>}"
  if [ "$V" = "$VER" ]; then OK=1; break; fi
  sleep 15
done
[ "$OK" = "1" ] || die "线上清单未生效（已 push，Vercel 可能仍在部署，稍后跑 check-ev-release.sh 复查）"

echo "   校验直链…"
H_DL="$(curl -sIL --max-time 30 "$SITE/dl/$APK_NAME" | tr -d '\r' | grep -iE '^(HTTP/|content-length)' | tail -4)"
echo "$H_DL" | sed 's/^/     /'
ONLINE_SHA="$(curl -sL --max-time 90 "$SITE/ev/$APK_NAME" | shasum -a 256 | cut -d' ' -f1)"
if [ "$ONLINE_SHA" = "$SHA" ]; then
  echo "✅ 发布完成：$SITE/dl/$APK_NAME（sha256 与本地一致：${SHA:0:12}…）"
else
  echo "⚠️  线上包 sha256(${ONLINE_SHA:0:12}…) 与本地(${SHA:0:12}…) 不一致 —— 可能是 CDN 缓存旧文件，稍后复查"
  exit 1
fi
