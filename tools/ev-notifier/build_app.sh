#!/bin/bash
# 构建 EvNotifier.app 桌面应用
# 运行后生成 EvNotifier.app，双击即可启动，不显示在 Dock 栏

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="EvNotifier"
APP_DIR="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# Info.plist - LSUIElement=true 隐藏 Dock 图标
cat > "$CONTENTS_DIR/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>EvNotifier</string>
  <key>CFBundleDisplayName</key>
  <string>Ev 通知器</string>
  <key>CFBundleIdentifier</key>
  <string>com.ev.notifier</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>EvNotifier</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSBackgroundOnly</key>
  <false/>
</dict>
</plist>
PLIST

# 启动脚本
cat > "$MACOS_DIR/EvNotifier" << 'SCRIPT'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PYTHON_SCRIPT="$APP_DIR/ev_notifier.py"
LOG_DIR="$APP_DIR"
LOG_FILE="$LOG_DIR/ev_notifier.log"
ERR_FILE="$LOG_DIR/ev_notifier.err.log"

export PATH="/usr/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$APP_DIR"
nohup /usr/bin/python3 "$PYTHON_SCRIPT" > "$LOG_FILE" 2> "$ERR_FILE" &
echo "EvNotifier started (PID: $!)"
SCRIPT

# 复制 ev_notifier.py 到 app bundle 内
cp "$SCRIPT_DIR/ev_notifier.py" "$APP_DIR/ev_notifier.py"
# 如果 icns 存在就复制
if [ -f "$SCRIPT_DIR/EvNotifier.icns" ]; then
  cp "$SCRIPT_DIR/EvNotifier.icns" "$RESOURCES_DIR/EvNotifier.icns"
fi

chmod +x "$MACOS_DIR/EvNotifier"

echo "✅ 构建完成: $APP_DIR"
echo ""
echo "用法:"
echo "  双击 $APP_NAME.app 即可启动"
echo "  或拖入 应用程序 文件夹方便日常使用:"
echo "  cp -r \"$APP_DIR\" /Applications/"