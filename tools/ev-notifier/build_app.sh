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
  <key>NSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

# 编译 Swift 原生启动器（隐藏 Dock 图标最可靠的方式）
echo "  编译启动器..."
swiftc -o "$MACOS_DIR/EvNotifier" "$SCRIPT_DIR/launcher.swift" 2>&1

# 复制 ev_notifier.py 到 app bundle 内
cp "$SCRIPT_DIR/ev_notifier.py" "$APP_DIR/ev_notifier.py"

# 生成应用图标（蓝色圆形 + EV 文字）
echo "  生成图标..."
ICONSET_DIR="/tmp/ev_icon.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

python3 -c "
import struct, zlib, os
w, h = 1024, 1024
raw = b''
for y in range(h):
    raw += b'\x00'
    for x in range(w):
        cx, cy = w//2, h//2
        d = ((x-cx)**2 + (y-cy)**2) ** 0.5
        r = 440
        if d < r - 10:
            raw += struct.pack('BBBB', 30, 64, 175, 255)
        elif d < r:
            a = max(0, min(255, int(255 * (r - d) / 10)))
            raw += struct.pack('BBBB', 30, 64, 175, a)
        else:
            raw += struct.pack('BBBB', 0, 0, 0, 0)
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
with open('/tmp/ev_icon_1024.png', 'wb') as f:
    f.write(png)
"
for size in 16 32 128 256 512; do
  sips -z $size $size /tmp/ev_icon_1024.png --out "$ICONSET_DIR/icon_${size}x${size}.png" 2>/dev/null
  sips -z $((size*2)) $((size*2)) /tmp/ev_icon_1024.png --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" 2>/dev/null
done
iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/EvNotifier.icns" 2>/dev/null
# 同时保存到项目目录，下次直接用
cp "$RESOURCES_DIR/EvNotifier.icns" "$SCRIPT_DIR/EvNotifier.icns"
rm -rf "$ICONSET_DIR" /tmp/ev_icon_1024.png

chmod +x "$MACOS_DIR/EvNotifier"

echo "✅ 构建完成: $APP_DIR"

# 复制到桌面
DESKTOP_APP="$HOME/Desktop/$APP_NAME.app"
rm -rf "$DESKTOP_APP"
cp -r "$APP_DIR" "$DESKTOP_APP"
echo "✅ 已复制到桌面: $DESKTOP_APP"

# 刷新 Finder 让图标更新
touch "$DESKTOP_APP"
osascript -e 'tell application "Finder" to update item (POSIX file "'"$DESKTOP_APP"'" as alias)' 2>/dev/null || true

echo ""
echo "用法:"
echo "  双击桌面上的 $APP_NAME.app 即可启动"
echo "  或拖入 应用程序 文件夹方便日常使用:"
echo "  cp -r \"$APP_DIR\" /Applications/"