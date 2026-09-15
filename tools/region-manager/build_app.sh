#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="RegionManager"
APP_DIR="$SCRIPT_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "Building $APP_NAME.app..."

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cat > "$CONTENTS_DIR/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>RegionManager</string>
  <key>CFBundleDisplayName</key>
  <string>RegionManager</string>
  <key>CFBundleIdentifier</key>
  <string>com.guomengtao.regionmanager</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleExecutable</key>
  <string>RegionManager</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

echo "  Compiling launcher..."
swiftc -o "$MACOS_DIR/RegionManager" "$SCRIPT_DIR/launcher.swift" 2>&1

cp "$SCRIPT_DIR/region_manager.py" "$APP_DIR/region_manager.py"

if [ -f "$SCRIPT_DIR/RegionManager.icns" ]; then
  echo "  Using existing icon"
  cp "$SCRIPT_DIR/RegionManager.icns" "$RESOURCES_DIR/RegionManager.icns"
else
  echo "  Generating icon..."
  ICONSET_DIR="/tmp/rm_icon.iconset"
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
            raw += struct.pack('BBBB', 40, 140, 40, 255)
        elif d < r:
            a = max(0, min(255, int(255 * (r - d) / 10)))
            raw += struct.pack('BBBB', 40, 140, 40, a)
        else:
            raw += struct.pack('BBBB', 0, 0, 0, 0)
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
with open('/tmp/rm_icon_1024.png', 'wb') as f:
    f.write(png)
"
  for size in 16 32 128 256 512; do
    sips -z $size $size /tmp/rm_icon_1024.png --out "$ICONSET_DIR/icon_${size}x${size}.png" 2>/dev/null
    sips -z $((size*2)) $((size*2)) /tmp/rm_icon_1024.png --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" 2>/dev/null
  done
  iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/RegionManager.icns" 2>/dev/null
  cp "$RESOURCES_DIR/RegionManager.icns" "$SCRIPT_DIR/RegionManager.icns"
  rm -rf "$ICONSET_DIR" /tmp/rm_icon_1024.png
fi

chmod +x "$MACOS_DIR/RegionManager"

DESKTOP_APP="$HOME/Desktop/$APP_NAME.app"
rm -rf "$DESKTOP_APP"
cp -r "$APP_DIR" "$DESKTOP_APP"

touch "$DESKTOP_APP"
osascript -e 'tell application "Finder" to update item (POSIX file "'"$DESKTOP_APP"'" as alias)' 2>/dev/null || true

echo ""
echo "Build complete: $APP_DIR"
echo "Desktop copy: $DESKTOP_APP"
echo ""
echo "Usage:"
echo "  Double-click $APP_NAME.app on Desktop to start"
echo "  Icon appears in menu bar (top), no Dock icon"