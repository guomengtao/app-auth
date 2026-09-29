#!/bin/bash
# 构建「自包含 venv」版 EvNotifier.app（正规 macOS bundle 结构）
#
# 用法：
#   ./build_app.sh              → 构建到 tools/ev-notifier/EvNotifier.app
#   ./build_app.sh --install    → 构建后安装到 /Applications/EvNotifier.app
#
# 为什么用 venv 而不是 PyInstaller：本机自用不需要公证/开发者账号，
# venv 方案体积约 30MB、调试所见即所得；缺点依赖 Homebrew Python（升级大版本需重建）。
#
# ⚠️ 禁止 rm -rf：清旧产物一律 mv 到 /tmp/trash/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="EvNotifier"
APP_DIR="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"
VENV="$RES/venv"

# 基础解释器：优先 Homebrew Python 3.14（与现有 LaunchAgent 同版本），缺失则退回 python3
BASE_PY=""
for cand in /opt/homebrew/opt/python@3.14/bin/python3.14 /opt/homebrew/bin/python3 /usr/bin/python3; do
  [ -x "$cand" ] && BASE_PY="$cand" && break
done
if [ -z "$BASE_PY" ]; then
  echo "❌ 找不到可用的 python3" >&2
  exit 1
fi

VER=$("$BASE_PY" -c "import json;print(json.load(open('$SCRIPT_DIR/version.json'))['version'])")
echo "▶ EvNotifier $VER（base python: $BASE_PY）"

# ---- 1. bundle 骨架（旧产物的 venv 先暂存到缓存里复用，避免每次重装依赖）----
mkdir -p /tmp/trash 2>/dev/null || true
VENV_CACHE=/tmp/evnotifier-venv-cache
if [ -d "$APP_DIR" ]; then
  if [ -x "$APP_DIR/Contents/Resources/venv/bin/python" ]; then
    [ -d "$VENV_CACHE" ] && mv "$VENV_CACHE" "/tmp/trash/evnotifier-venv-cache.$(date +%s)"
    mv "$APP_DIR/Contents/Resources/venv" "$VENV_CACHE"
  fi
  mv "$APP_DIR" "/tmp/trash/EvNotifier.app.$(date +%s)"
fi
mkdir -p "$MACOS" "$RES"
if [ -d "$VENV_CACHE" ] && [ ! -d "$VENV" ]; then
  mv "$VENV_CACHE" "$VENV"
fi

# ---- 2. bundle 自带 venv（已存在则复用，加快重复构建）----
if [ ! -x "$VENV/bin/python" ]; then
  echo "▶ 创建 venv ..."
  "$BASE_PY" -m venv "$VENV"
fi
PY="$VENV/bin/python"
"$PY" -m pip install -q -U pip wheel
echo "▶ 安装依赖 ..."
"$PY" -m pip install -q -r "$SCRIPT_DIR/requirements.txt"

# ---- 3. 源码与资源 ----
cp "$SCRIPT_DIR/ev_notifier.py" "$RES/ev_notifier.py"
cp "$SCRIPT_DIR/version.json" "$RES/version.json"
if [ -f "$SCRIPT_DIR/EvNotifier.icns" ]; then
  cp "$SCRIPT_DIR/EvNotifier.icns" "$RES/EvNotifier.icns"
fi
[ -f "$SCRIPT_DIR/README.md" ] && cp "$SCRIPT_DIR/README.md" "$RES/README.md"

# ---- 4. 启动器（相对自身路径解析，拷到任何位置都能跑）----
cat > "$MACOS/EvNotifier" << 'EOF'
#!/bin/sh
# EvNotifier 启动器：用 bundle 自带 venv 运行 Resources 里的主脚本。
# ⚠️ 必须相对 $0 解析路径：App 被拷到 /Applications 后绝对路径会变。
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RES="$DIR/Resources"
exec "$RES/venv/bin/python" -u "$RES/ev_notifier.py"
EOF
chmod +x "$MACOS/EvNotifier"

# ---- 5. Info.plist ----
cat > "$CONTENTS/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>Ev 通知器</string>
  <key>CFBundleIdentifier</key>
  <string>com.evnotifier.app</string>
  <key>CFBundleVersion</key>
  <string>$VER</string>
  <key>CFBundleShortVersionString</key>
  <string>$VER</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>$APP_NAME</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

# ---- 6. ad-hoc 签名（避免 Gatekeeper 报「已损坏」）----
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || echo "  ⚠️ 签名失败（不影响本机运行）"

SIZE=$(du -sh "$APP_DIR" | awk '{print $1}')
echo "✅ 构建完成: $APP_DIR （$SIZE）"

# ---- 7. 可选：安装到 /Applications ----
if [ "$1" = "--install" ]; then
  DEST="/Applications/$APP_NAME.app"
  if [ -d "$DEST" ]; then
    mv "$DEST" "/tmp/trash/EvNotifier.app.install.$(date +%s)"
  fi
  cp -R "$APP_DIR" "$DEST"
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  codesign --force --deep --sign - "$DEST" 2>/dev/null || true
  touch "$DEST"
  echo "✅ 已安装: $DEST"
fi
