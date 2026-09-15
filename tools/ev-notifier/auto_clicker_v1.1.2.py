"""Auto Clicker v1.1.2 - Coordinate-based click positions, visual indicator"""
VERSION = "v1.1.2"

import atexit
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime

try:
    import rumps
except ImportError:
    rumps = None

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

PID_FILE = os.path.expanduser("~/.auto_clicker.pid")
LOG_FILE = os.path.expanduser("~/.auto_clicker_log.json")
CONFIG_FILE = os.path.expanduser("~/.auto_clicker_config.json")
POSITIONS_FILE = os.path.expanduser("~/.auto_clicker_positions.json")
SCREENSHOT_DIR = os.path.expanduser("~/Desktop/AutoClicker_Screenshots")

CHECK_INTERVAL = 3
OSASCRIPT_TIMEOUT = 8
COOLDOWN_SECONDS = 5
POS_COOLDOWN_SECONDS = 3
MAX_HISTORY = 500
STATUS_WINDOW_REFRESH = 2
INDICATOR_DURATION = 0.5

CLICK_HISTORY = {}
LIVE_STATUS = {
    "running": False,
    "last_scan": "",
    "last_status": "idle",
    "last_results": [],
    "total_clicks": 0,
    "dry_run": True,
    "permission_ok": False,
}

CLICK_TEXTS = [
    "Continue", "Confirm", "Accept", "OK", "Ok",
    "Run", "Retry", "Try again", "Try Again",
    "Allow", "Proceed", "Save", "Apply", "Submit",
    "Yes", "Dismiss", "Send",
]

NEVER_CLICK_TEXTS = [
    "Delete", "Logout", "Remove", "Format",
    "Uninstall", "Reset", "Clear", "Erase", "Discard",
]

PROCESS_NAMES = ["Code", "Electron"]


# ---------------------------------------------------------------------------
# Coordinate-click engine (Quartz CoreGraphics, zero external deps)
# ---------------------------------------------------------------------------

def _get_quartz():
    import Quartz
    return Quartz


def click_at(x, y):
    Quartz = _get_quartz()
    move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (x, y), 0)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
    time.sleep(0.02)
    down = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, (x, y), 0)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.02)
    up = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, (x, y), 0)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)


def get_mouse_position():
    Quartz = _get_quartz()
    pos = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
    return (int(pos.x), int(pos.y))


def show_click_indicator(x, y):
    try:
        import tkinter as tk
    except ImportError:
        return None

    def _run():
        r = 20
        root = tk.Tk()
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.attributes("-alpha", 0.8)
        root.geometry(f"{r*2}x{r*2}+{x-r}+{y-r}")
        root.configure(bg="")

        canvas = tk.Canvas(root, width=r*2, height=r*2,
                           bg="systemTransparent", highlightthickness=0)
        canvas.pack()

        def fade_out(alpha=0.8):
            if alpha <= 0:
                root.destroy()
                return
            root.attributes("-alpha", alpha)
            root.after(50, lambda: fade_out(alpha - 0.15))

        canvas.create_oval(2, 2, r*2-2, r*2-2,
                           outline="#FF3333", width=3,
                           fill="#FF0000")
        canvas.create_line(r, r-8, r, r+8, fill="#FFFFFF", width=2)
        canvas.create_line(r-8, r, r+8, r, fill="#FFFFFF", width=2)

        root.lift()
        root.after(int(INDICATOR_DURATION * 1000), fade_out)
        root.mainloop()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


# ---------------------------------------------------------------------------
# Position file helpers
# ---------------------------------------------------------------------------

def load_positions():
    try:
        with open(POSITIONS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []


def save_positions(positions):
    try:
        with open(POSITIONS_FILE, "w") as f:
            json.dump(positions, f, indent=2)
    except Exception:
        pass


def add_position(x, y, label):
    positions = load_positions()
    for p in positions:
        if p.get("label") == label:
            p["x"] = x
            p["y"] = y
            p["enabled"] = True
            save_positions(positions)
            return positions
    positions.append({
        "x": x, "y": y, "label": label, "enabled": True, "added": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    })
    save_positions(positions)
    return positions


def remove_position(label):
    positions = load_positions()
    positions = [p for p in positions if p.get("label") != label]
    save_positions(positions)
    return positions


def clear_all_positions():
    save_positions([])


# ---------------------------------------------------------------------------
# PID lock
# ---------------------------------------------------------------------------

def _acquire_pid_lock():
    try:
        if os.path.exists(PID_FILE):
            with open(PID_FILE, "r") as f:
                old_pid = f.read().strip()
            if old_pid:
                try:
                    os.kill(int(old_pid), 0)
                    return False
                except (OSError, ValueError):
                    pass
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))
        return True
    except Exception:
        return True


def _release_pid_lock():
    try:
        if os.path.exists(PID_FILE):
            os.unlink(PID_FILE)
    except Exception:
        pass


def load_config():
    defaults = {
        "dry_run": True,
        "enabled_processes": ["Code", "Electron"],
        "check_interval": 3,
        "cooldown_seconds": 5,
        "pos_cooldown_seconds": 3,
        "show_alert_on_click": False,
        "show_alert_on_find": True,
        "max_clicks_per_minute": 20,
        "verbose": True,
        "click_texts": CLICK_TEXTS,
        "never_click_texts": NEVER_CLICK_TEXTS,
        "window_filters": [],
        "capture_screenshots": True,
        "show_status_window": False,
        "show_indicator": True,
        "pos_enabled": True,
    }
    try:
        with open(CONFIG_FILE, "r") as f:
            saved = json.load(f)
            for key, val in defaults.items():
                if key not in saved:
                    saved[key] = val
            return saved
    except Exception:
        return defaults


def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


def load_log():
    try:
        with open(LOG_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"clicks": [], "total_clicks": 0}


def save_log(data):
    try:
        with open(LOG_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def record_click(process_name, button_title, window_name, was_dry_run):
    log = load_log()
    entry = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "process": process_name,
        "window": window_name,
        "button": button_title,
        "dry_run": was_dry_run,
    }
    log["clicks"].insert(0, entry)
    if len(log["clicks"]) > MAX_HISTORY:
        log["clicks"] = log["clicks"][:MAX_HISTORY]
    log["total_clicks"] = log.get("total_clicks", 0) + 1
    save_log(log)
    return log["total_clicks"]


def should_click_cooldown(button_title, cooldown=None):
    if cooldown is None:
        cooldown = COOLDOWN_SECONDS
    now = time.time()
    key = button_title.lower()
    last = CLICK_HISTORY.get(key, 0)
    if now - last < cooldown:
        return False
    CLICK_HISTORY[key] = now
    return True


# ---------------------------------------------------------------------------
# AppleScript builders (unchanged from v1.1.0)
# ---------------------------------------------------------------------------

def build_scan_script(enabled_processes, click_texts, never_texts,
                      window_filters=None, debug_all=False):
    proc_conditions = []
    for p in enabled_processes:
        proc_conditions.append(f'name contains "{p}"')
    proc_filter = " or ".join(proc_conditions)

    if debug_all:
        win_filter = ""
        if window_filters:
            conds = [f'wname contains "{wf}"' for wf in window_filters]
            win_filter = " or ".join(conds)
        return f'''
tell application "System Events"
    set outputText to ""
    repeat with p in (every process whose {proc_filter})
        set pname to name of p
        try
            repeat with w in (every window of p)
                set wname to ""
                try
                    set wname to name of w
                end try
                set winOK to true
                {"set winOK to (" + win_filter + ")" if window_filters else ""}
                if winOK then
                    try
                        set allBtns to every button of w
                        repeat with b in allBtns
                            try
                                set btitle to title of b
                            on error
                                set btitle to ""
                            end try
                            if length of btitle > 0 then
                                set outputText to outputText & pname & "::" & wname & "::" & btitle & "|||"
                            end if
                        end repeat
                    end try
                end if
            end repeat
        end try
    end repeat
    return outputText
end tell
'''

    click_list = ", ".join(f'"{t}"' for t in click_texts)
    never_list = ", ".join(f'"{t}"' for t in never_texts)

    win_filter = ""
    if window_filters:
        conds = [f'wname contains "{wf}"' for wf in window_filters]
        win_filter = " or ".join(conds)

    return f'''
set clickTexts to {{{click_list}}}
set neverTexts to {{{never_list}}}
tell application "System Events"
    set outputText to ""
    repeat with p in (every process whose {proc_filter})
        set pname to name of p
        try
            repeat with w in (every window of p)
                set wname to ""
                try
                    set wname to name of w
                end try
                set winOK to true
                {"set winOK to (" + win_filter + ")" if window_filters else ""}
                if winOK then
                    try
                        set allBtns to every button of w
                        repeat with b in allBtns
                            try
                                set btitle to title of b
                            on error
                                set btitle to ""
                            end try
                            if length of btitle > 0 then
                                set shouldSkip to false
                                repeat with nt in neverTexts
                                    if btitle contains nt then
                                        set shouldSkip to true
                                        exit repeat
                                    end if
                                end repeat
                                if not shouldSkip then
                                    repeat with ct in clickTexts
                                        if btitle contains ct then
                                            set outputText to outputText & pname & "::" & wname & "::" & btitle & "|||"
                                            exit repeat
                                        end if
                                    end repeat
                                end if
                            end if
                        end repeat
                    end try
                end if
            end repeat
        end try
    end repeat
    return outputText
end tell
'''


def build_click_script(process_name, button_title):
    return f'''
tell application "System Events"
    tell process "{process_name}"
        try
            click (first button of window 1 whose title contains "{button_title}")
            return "OK"
        on error errMsg
            return "FAIL: " & errMsg
        end try
    end tell
end tell
'''


def check_accessibility_permission():
    try:
        script = '''
tell application "System Events"
    try
        count of every process
        return "OK"
    on error errMsg
        return "DENIED: " & errMsg
    end try
end tell
'''
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        output = result.stdout.strip()
        if "OK" in output:
            return True, ""
        return False, output
    except Exception as e:
        return False, str(e)


def click_button(process_name, button_title):
    try:
        script = build_click_script(process_name, button_title)
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        output = result.stdout.strip()
        if "OK" in output:
            return True, ""
        return False, output
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as e:
        return False, str(e)


def scan_buttons(enabled_processes, click_texts=None, never_texts=None,
                 window_filters=None, debug_all=False, verbose=False):
    if click_texts is None:
        click_texts = CLICK_TEXTS
    if never_texts is None:
        never_texts = NEVER_CLICK_TEXTS

    t0 = time.time()
    try:
        script = build_scan_script(enabled_processes, click_texts, never_texts,
                                   window_filters, debug_all)
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True,
            timeout=OSASCRIPT_TIMEOUT
        )
        elapsed = time.time() - t0
        output = result.stdout.strip()
        stderr = result.stderr.strip()

        if verbose:
            print(f"  [scan] took {elapsed:.1f}s", end="")

        if stderr:
            if "not allowed" in stderr.lower():
                if verbose:
                    print(" -> PERMISSION DENIED")
                return [], "permission_denied", elapsed
            if "not found" not in stderr.lower() and "ok" not in stderr.lower():
                if verbose:
                    print(f" -> stderr: {stderr[:80]}")
                return [], f"error: {stderr[:80]}", elapsed

        if not output:
            if verbose:
                print(" -> no matches")
            return [], "none", elapsed

        entries = [e.strip() for e in output.split("|||") if e.strip()]
        results = []
        for entry in entries:
            parts = entry.split("::", 2)
            if len(parts) == 3:
                results.append({
                    "process": parts[0],
                    "window": parts[1],
                    "button": parts[2],
                })
        if verbose:
            print(f" -> found {len(results)}")
        return results, "ok", elapsed
    except subprocess.TimeoutExpired:
        elapsed = time.time() - t0
        if verbose:
            print(f"  [scan] timeout after {elapsed:.1f}s")
        return [], "timeout", elapsed
    except Exception as e:
        elapsed = time.time() - t0
        if verbose:
            print(f"  [scan] error: {e}")
        return [], f"error: {e}", elapsed


def debug_scan_all(enabled_processes, window_filters=None):
    script = build_scan_script(enabled_processes, CLICK_TEXTS, [], window_filters, debug_all=True)
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=OSASCRIPT_TIMEOUT
    )
    out = result.stdout.strip()
    if not out:
        return []
    entries = [e.strip() for e in out.split("|||") if e.strip()]
    results = []
    for entry in entries:
        parts = entry.split("::", 2)
        if len(parts) == 3:
            results.append({"process": parts[0], "window": parts[1], "button": parts[2]})
    return results


# ---------------------------------------------------------------------------
# Coordinate-based click processing
# ---------------------------------------------------------------------------

def process_position_clicks(cfg, dry_run):
    positions = load_positions()
    if not positions:
        return 0
    enabled_positions = [p for p in positions if p.get("enabled", True)]
    if not enabled_positions:
        return 0
    if not cfg.get("pos_enabled", True):
        return 0

    clicked_count = 0
    pos_cooldown = cfg.get("pos_cooldown_seconds", POS_COOLDOWN_SECONDS)
    show_indicator = cfg.get("show_indicator", True)

    for p in enabled_positions:
        label = p.get("label", f"({p['x']},{p['y']})")
        if not should_click_cooldown(f"pos:{label}", cooldown=pos_cooldown):
            continue
        if dry_run:
            print(f"  [position] DRY-RUN: {label} @ ({p['x']}, {p['y']})")
            record_click("position", label, "", was_dry_run=True)
            clicked_count += 1
        else:
            try:
                if show_indicator:
                    show_click_indicator(p["x"], p["y"])
                click_at(p["x"], p["y"])
                record_click("position", label, "", was_dry_run=False)
                clicked_count += 1
                print(f"  [position] CLICKED: {label} @ ({p['x']}, {p['y']})")
            except Exception as e:
                print(f"  [position] FAILED: {label}: {e}")

    return clicked_count


# ---------------------------------------------------------------------------
# Screenshot / Utils (unchanged from v1.1.0)
# ---------------------------------------------------------------------------

def capture_screenshot(filename=None):
    if filename is None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"screenshot_{ts}.png"
    filepath = os.path.join(SCREENSHOT_DIR, filename)
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    try:
        subprocess.run(
            ["screencapture", "-x", filepath],
            timeout=5, capture_output=True
        )
        return filepath
    except Exception:
        return None


def list_running_processes():
    script = '''
tell application "System Events"
    set procList to ""
    repeat with p in (every process whose background only is false)
        try
            set pname to name of p
            set wcount to count of (every window of p)
            if wcount > 0 then
                set procList to procList & pname & ":::" & wcount & "|||"
            end if
        end try
    end repeat
    return procList
end tell
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10
        )
        out = result.stdout.strip()
        procs = []
        for entry in out.split("|||"):
            parts = entry.split(":::")
            if len(parts) == 2 and parts[0].strip():
                procs.append({"name": parts[0].strip(), "windows": int(parts[1])})
        return procs
    except Exception:
        return []


def open_accessibility_settings():
    subprocess.run([
        "open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    ])


def show_notification(title, message):
    script = f'display notification "{message}" with title "{title}"'
    try:
        subprocess.run(["osascript", "-e", script], timeout=3)
    except Exception:
        pass


def show_dialog_with_list(title, message, items, default_items=None):
    item_str = ", ".join(f'"{it}"' for it in items)
    default_str = ", ".join(f'"{it}"' for it in (default_items or []))
    script = f'''
set allItems to {{{item_str}}}
set defaultItems to {{{default_str}}}
set selectedItems to choose from list allItems with title "{title}" with prompt "{message}" with multiple selections allowed default items defaultItems
if selectedItems is false then return ""
set AppleScript's text item delimiters to "|||"
set outText to selectedItems as text
set AppleScript's text item delimiters to ""
return outText
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=30
        )
        out = result.stdout.strip()
        if not out:
            return []
        return [x.strip() for x in out.split("|||") if x.strip()]
    except Exception:
        return []


def show_text_input(title, message, default_value=""):
    script = f'''
tell application "System Events"
    set resultText to text returned of (display dialog "{message}" with title "{title}" default answer "{default_value}" buttons {{"Cancel", "Save"}} default button "Save")
    return resultText
end tell
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=30
        )
        out = result.stdout.strip()
        if not out or "Cancel" in out or "false" in out.lower():
            return None
        return out
    except Exception:
        return None


def generate_icon_png():
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = 8
    draw.ellipse(
        [margin, margin, size - margin, size - margin],
        fill=(200, 100, 80, 255)
    )
    inner = 30
    draw.ellipse(
        [inner, inner, size - inner, size - inner],
        fill=(220, 120, 100, 255)
    )
    cx, cy = size // 2, size // 2 + 35
    arrow_size = 50
    points = [
        (cx, cy + arrow_size // 1.5),
        (cx - arrow_size // 2, cy - arrow_size // 3),
        (cx + arrow_size // 2, cy - arrow_size // 3),
    ]
    draw.polygon(points, fill=(255, 240, 100, 255))
    return img


def generate_iconset(icon_path):
    img = generate_icon_png()
    if img is None:
        return
    iconset_dir = icon_path.replace(".icns", ".iconset")
    os.makedirs(iconset_dir, exist_ok=True)
    sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for filename, s in sizes.items():
        resized = img.resize((s, s), 3)
        resized.save(os.path.join(iconset_dir, filename))
    subprocess.run(
        ["iconutil", "-c", "icns", "-o", icon_path, iconset_dir],
        capture_output=True
    )
    shutil.rmtree(iconset_dir, ignore_errors=True)


def build_standalone():
    script_path = os.path.abspath(__file__)
    app_name = "AutoClicker"
    app_dir = os.path.expanduser(f"~/Desktop/{app_name}.app")
    macos_dir = os.path.join(app_dir, "Contents", "MacOS")
    resources_dir = os.path.join(app_dir, "Contents", "Resources")

    if os.path.exists(app_dir):
        shutil.rmtree(app_dir)
    os.makedirs(macos_dir, exist_ok=True)
    os.makedirs(resources_dir, exist_ok=True)

    launcher_path = os.path.join(macos_dir, "AutoClicker")
    with open(launcher_path, "w") as f:
        f.write('''#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES="$SCRIPT_DIR/../Resources"
cd "$RESOURCES"
exec /usr/bin/python3 "$RESOURCES/auto_clicker.py" --gui
''')
    os.chmod(launcher_path, 0o755)

    dst_script = os.path.join(resources_dir, "auto_clicker.py")
    shutil.copy2(script_path, dst_script)

    icon_path = os.path.join(resources_dir, "AppIcon.icns")
    generate_iconset(icon_path)

    plist = os.path.join(app_dir, "Contents", "Info.plist")
    with open(plist, "w") as f:
        f.write(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>{app_name}</string>
    <key>CFBundleDisplayName</key>
    <string>{app_name}</string>
    <key>CFBundleIdentifier</key>
    <string>com.guomengtao.autoclicker</string>
    <key>CFBundleVersion</key>
    <string>{VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>{VERSION}</string>
    <key>CFBundleExecutable</key>
    <string>AutoClicker</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>''')
    return app_dir


def install_login_item():
    app_path = os.path.expanduser("~/Desktop/AutoClicker.app")
    if not os.path.exists(app_path):
        print("[install] No AutoClicker.app on Desktop. Run --build first.")
        return False
    script = f'''
tell application "System Events"
    if not (exists login item "AutoClicker") then
        make new login item at end with properties {{
            path:"{app_path}",
            hidden:true
        }}
    end if
end tell
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            print("[install] AutoClicker added to Login Items (auto-start)")
            return True
        return False
    except Exception as e:
        print(f"[install] Error: {e}")
        return False


def uninstall_login_item():
    script = '''
tell application "System Events"
    try
        delete login item "AutoClicker"
    end try
end tell
'''
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)
        print("[uninstall] AutoClicker removed from Login Items")
        return True
    except Exception as e:
        print(f"[uninstall] Error: {e}")
        return False


def open_status_window():
    try:
        import tkinter as tk
    except ImportError:
        print("[status] tkinter not available")
        return None

    root = tk.Tk()
    root.title(f"Auto Clicker {VERSION} - Status")
    root.geometry("520x480")
    root.attributes("-topmost", True)

    header = tk.Label(root, text=f"Auto Clicker {VERSION}", font=("Helvetica", 14, "bold"))
    header.pack(pady=10)

    status_frame = tk.Frame(root)
    status_frame.pack(fill="x", padx=20, pady=5)

    status_label = tk.Label(status_frame, text="Status: Stopped", font=("Helvetica", 12))
    status_label.pack(anchor="w")

    dry_label = tk.Label(status_frame, text="Mode: DRY-RUN (Safe)", font=("Helvetica", 10), fg="orange")
    dry_label.pack(anchor="w")

    perm_label = tk.Label(status_frame, text="Permission: Checking...", font=("Helvetica", 10))
    perm_label.pack(anchor="w")

    pos_label = tk.Label(status_frame, text="Positions: 0", font=("Helvetica", 10))
    pos_label.pack(anchor="w")

    separator = tk.Frame(root, height=2, bg="gray")
    separator.pack(fill="x", padx=20, pady=5)

    log_label = tk.Label(root, text="Recent Events:", font=("Helvetica", 10, "italic"))
    log_label.pack(anchor="w", padx=20)

    log_text = tk.Text(root, height=14, width=60, font=("Monaco", 9), state="disabled")
    log_text.pack(padx=20, pady=5, fill="both", expand=True)

    stats_label = tk.Label(root, text="Total Clicks: 0 | Scans: 0", font=("Helvetica", 10))
    stats_label.pack(pady=5)

    root.protocol("WM_DELETE_WINDOW", root.withdraw)

    def update():
        global LIVE_STATUS
        try:
            running = LIVE_STATUS["running"]
            status_label.config(
                text=f"Status: {'Running' if running else 'Stopped'}",
                fg="green" if running else "gray"
            )
            dry = "DRY-RUN (Safe)" if LIVE_STATUS["dry_run"] else "LIVE (Clicking!)"
            dry_color = "orange" if LIVE_STATUS["dry_run"] else "red"
            dry_label.config(text=f"Mode: {dry}", fg=dry_color)
            perm_label.config(
                text=f"Permission: {'OK' if LIVE_STATUS['permission_ok'] else 'NEEDED'}",
                fg="green" if LIVE_STATUS['permission_ok'] else "red"
            )
            positions = load_positions()
            pos_label.config(text=f"Positions: {len(positions)}")

            log_text.config(state="normal")
            log_text.delete("1.0", "end")
            log_text.insert("end", "--- Button Detection ---\n")
            for r in LIVE_STATUS.get("last_results", [])[:10]:
                log_text.insert("end", f"[{LIVE_STATUS.get('last_scan', '?')}] ")
                log_text.insert("end", f"{r['process']}: {r['button']}\n")
            if not LIVE_STATUS.get("last_results"):
                log_text.insert("end", "(No buttons detected yet)\n")

            log_text.insert("end", "\n--- Saved Positions ---\n")
            for p in positions:
                state = "ON" if p.get("enabled", True) else "OFF"
                log_text.insert("end", f"[{state}] {p.get('label','?')}: ({p['x']}, {p['y']})\n")
            if not positions:
                log_text.insert("end", "(No positions saved)\n")
            log_text.config(state="disabled")

            stats_label.config(
                text=f"Total Clicks: {LIVE_STATUS.get('total_clicks', 0)} | "
                     f"Last: {LIVE_STATUS.get('last_status', '?')}"
            )
        except Exception:
            pass
        root.after(STATUS_WINDOW_REFRESH * 1000, update)

    root.after(STATUS_WINDOW_REFRESH * 1000, update)
    return root


# ---------------------------------------------------------------------------
# rumps Menu Bar Application
# ---------------------------------------------------------------------------

class AutoClickerApp(rumps.App):
    def __init__(self):
        super().__init__("AC", quit_button=None)
        self._cfg = load_config()
        self._running = False
        self._click_count = 0
        self._thread = None
        self._lock = threading.Lock()
        self._last_status = "idle"
        self._last_scan_time = ""
        self._has_permission = True
        self._click_this_minute = []
        self._verbose = self._cfg.get("verbose", True)
        self._last_scan_results = []
        self._status_text = "Ready"
        self._status_window = None
        self._status_window_thread = None

        from AppKit import NSApp, NSApplicationActivationPolicyAccessory
        try:
            NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        except Exception:
            pass

        global LIVE_STATUS
        LIVE_STATUS["dry_run"] = self._cfg.get("dry_run", True)

        self._build_menu()
        threading.Thread(target=self._check_permission_startup, daemon=True).start()

        if self._cfg.get("show_status_window", False):
            self.start_status_window(None)

    def _build_menu(self):
        self.menu.clear()
        dry = "DRY-RUN" if self._cfg.get("dry_run", True) else "LIVE"
        running_str = "RUNNING" if self._running else "STOPPED"
        self._status_item = rumps.MenuItem(f"Status: {running_str} ({dry})")
        self.menu.add(self._status_item)
        self.menu.add(rumps.separator)

        self._start_item = rumps.MenuItem("Start Monitoring", callback=self.start_monitoring)
        self._stop_item = rumps.MenuItem("Stop Monitoring", callback=self.stop_monitoring)
        self.menu.add(self._start_item)
        self.menu.add(self._stop_item)
        self.menu.add(rumps.separator)

        self._dry_item = rumps.MenuItem(
            f"Dry-Run: {'ON' if self._cfg.get('dry_run', True) else 'OFF'}",
            callback=self.toggle_dry_run
        )
        self.menu.add(self._dry_item)

        self._pos_item = rumps.MenuItem(
            f"Position Clicks: {'ON' if self._cfg.get('pos_enabled', True) else 'OFF'}",
            callback=self.toggle_pos_enabled
        )
        self.menu.add(self._pos_item)

        self._indicator_item = rumps.MenuItem(
            f"Visual Indicator: {'ON' if self._cfg.get('show_indicator', True) else 'OFF'}",
            callback=self.toggle_indicator
        )
        self.menu.add(self._indicator_item)
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("Record Position", callback=self.record_position))
        self.menu.add(rumps.MenuItem("List Positions", callback=self.list_positions))
        self.menu.add(rumps.MenuItem("Test Click Position", callback=self.test_single_click))
        self.menu.add(rumps.MenuItem("Clear All Positions", callback=self.clear_positions_menu))
        self.menu.add(rumps.separator)

        self._alert_find_item = rumps.MenuItem(
            f"Alert on Find: {'ON' if self._cfg.get('show_alert_on_find', True) else 'OFF'}",
            callback=self.toggle_alert_find
        )
        self.menu.add(self._alert_find_item)
        self._alert_click_item = rumps.MenuItem(
            f"Alert on Click: {'ON' if self._cfg.get('show_alert_on_click', False) else 'OFF'}",
            callback=self.toggle_alert_click
        )
        self.menu.add(self._alert_click_item)

        self._screenshot_item = rumps.MenuItem(
            f"Screenshots: {'ON' if self._cfg.get('capture_screenshots', True) else 'OFF'}",
            callback=self.toggle_screenshots
        )
        self.menu.add(self._screenshot_item)
        self.menu.add(rumps.separator)

        self._status_win_item = rumps.MenuItem(
            f"Status Window: {'OPEN' if self._status_window else 'CLOSED'}",
            callback=self.toggle_status_window
        )
        self.menu.add(self._status_win_item)
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("Test Scan", callback=self.test_scan))
        self.menu.add(rumps.MenuItem("Debug Scan (All Buttons)", callback=self.debug_scan))
        self.menu.add(rumps.MenuItem("Capture Screenshot", callback=self.capture_now))
        self.menu.add(rumps.MenuItem("Show Log", callback=self.show_log))
        self.menu.add(rumps.MenuItem("Select Processes...", callback=self.select_processes))
        self.menu.add(rumps.MenuItem("Select Windows...", callback=self.select_windows))
        self.menu.add(rumps.MenuItem("Edit Config", callback=self.edit_config))
        self.menu.add(rumps.separator)

        positions = load_positions()
        if positions:
            for p in positions:
                state = "ON" if p.get("enabled", True) else "OFF"
                self.menu.add(rumps.MenuItem(
                    f"  [{state}] {p.get('label','?')} ({p['x']},{p['y']})"
                ))

        procs = self._cfg.get("enabled_processes", PROCESS_NAMES)
        self.menu.add(rumps.MenuItem(f"Monitoring: {', '.join(procs)}"))
        win_filters = self._cfg.get("window_filters", [])
        if win_filters:
            self.menu.add(rumps.MenuItem(f"Window filter: {', '.join(win_filters)}"))
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("Open Screenshots Folder", callback=self.open_screenshots))
        self.menu.add(rumps.MenuItem("Open Accessibility Settings", callback=self.open_perm))
        self.menu.add(rumps.MenuItem("Install Auto-Start", callback=self.install_auto_start))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem(f"Version: {VERSION}"))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Quit", callback=self.quit_app))

    def _check_permission_startup(self):
        permitted, err = check_accessibility_permission()
        self._has_permission = permitted
        global LIVE_STATUS
        LIVE_STATUS["permission_ok"] = permitted
        if not permitted:
            self._status_item.title = "Status: NO PERMISSION"
        else:
            dry = "DRY-RUN" if self._cfg.get("dry_run", True) else "LIVE"
            self._status_item.title = f"Status: Ready ({dry})"

    @rumps.timer(1)
    def _update_title(self, _):
        prefix = "D" if self._cfg.get("dry_run", True) else "L"
        if self._running:
            s = {
                "permission_denied": "X", "timeout": "T",
                "none": "-", "ok": "+"
            }.get(self._last_status, "E" if self._last_status.startswith("error") else "")
            self.title = f"{prefix}{s}{self._click_count}"
        else:
            self.title = f"{prefix}"

    def toggle_dry_run(self, _):
        self._cfg["dry_run"] = not self._cfg.get("dry_run", True)
        save_config(self._cfg)
        self._build_menu()
        global LIVE_STATUS
        LIVE_STATUS["dry_run"] = self._cfg["dry_run"]
        mode = "DRY-RUN" if self._cfg["dry_run"] else "LIVE"
        show_notification("Auto Clicker", f"Switched to {mode} mode")

    def toggle_pos_enabled(self, _):
        self._cfg["pos_enabled"] = not self._cfg.get("pos_enabled", True)
        save_config(self._cfg)
        self._build_menu()

    def toggle_indicator(self, _):
        self._cfg["show_indicator"] = not self._cfg.get("show_indicator", True)
        save_config(self._cfg)
        self._build_menu()

    def toggle_alert_find(self, _):
        self._cfg["show_alert_on_find"] = not self._cfg.get("show_alert_on_find", True)
        save_config(self._cfg)
        self._build_menu()

    def toggle_alert_click(self, _):
        self._cfg["show_alert_on_click"] = not self._cfg.get("show_alert_on_click", False)
        save_config(self._cfg)
        self._build_menu()

    def toggle_screenshots(self, _):
        self._cfg["capture_screenshots"] = not self._cfg.get("capture_screenshots", True)
        save_config(self._cfg)
        self._build_menu()

    def toggle_status_window(self, _):
        if self._status_window:
            self.close_status_window()
        else:
            self.start_status_window(None)
        self._build_menu()

    def start_status_window(self, _):
        self._cfg["show_status_window"] = True
        save_config(self._cfg)

        def _run_window():
            try:
                root = open_status_window()
                if root:
                    self._status_window = root
                    self._build_menu()
                    root.mainloop()
            except Exception as e:
                print(f"[status] Window error: {e}")

        self._status_window_thread = threading.Thread(target=_run_window, daemon=True)
        self._status_window_thread.start()

    def close_status_window(self):
        self._cfg["show_status_window"] = False
        save_config(self._cfg)
        if self._status_window:
            try:
                self._status_window.quit()
                self._status_window.destroy()
            except Exception:
                pass
            self._status_window = None

    # ---- Position management ----

    def record_position(self, _):
        x, y = get_mouse_position()
        label = show_text_input("Record Position",
                                f"Mouse at ({x}, {y}). Save as:",
                                f"Pos_{x}_{y}")
        if label:
            add_position(x, y, label)
            self._build_menu()
            show_notification("Auto Clicker", f"Position saved: {label} ({x},{y})")
            # Test indicator
            if self._cfg.get("show_indicator", True):
                show_click_indicator(x, y)

    def list_positions(self, _):
        positions = load_positions()
        if not positions:
            rumps.alert(title="Positions", message="No saved positions.\n\nUse 'Record Position' to save one.")
            return
        msg = f"{len(positions)} saved position(s):\n\n"
        for p in positions:
            state = "Enabled" if p.get("enabled", True) else "Disabled"
            msg += f"[{state}] {p.get('label','?')}: ({p['x']}, {p['y']})\n"
        rumps.alert(title="Saved Positions", message=msg)

    def test_single_click(self, _):
        positions = load_positions()
        enabled = [p for p in positions if p.get("enabled", True)]
        if not enabled:
            rumps.alert(title="No Positions", message="No enabled positions to test.")
            return
        labels = [p["label"] for p in enabled]
        selected = show_dialog_with_list("Test Click Position", "Select a position to test-click:", labels)
        if not selected:
            return
        label = selected[0]
        for p in enabled:
            if p["label"] == label:
                dry_run = self._cfg.get("dry_run", True)
                if dry_run:
                    rumps.alert(title="DRY-RUN",
                                message=f"Would click: {label} @ ({p['x']}, {p['y']})")
                else:
                    if self._cfg.get("show_indicator", True):
                        show_click_indicator(p["x"], p["y"])
                    click_at(p["x"], p["y"])
                    show_notification("Auto Clicker", f"Clicked: {label}")
                break

    def clear_positions_menu(self, _):
        count = len(load_positions())
        if count == 0:
            rumps.alert(title="Clear Positions", message="No positions to clear.")
            return
        clear_all_positions()
        self._build_menu()
        show_notification("Auto Clicker", f"Cleared {count} position(s)")

    # ---- Rate limit ----

    def _check_rate_limit(self):
        max_clicks = self._cfg.get("max_clicks_per_minute", 20)
        now = time.time()
        cutoff = now - 60
        self._click_this_minute = [t for t in self._click_this_minute if t > cutoff]
        if len(self._click_this_minute) >= max_clicks:
            return False
        self._click_this_minute.append(now)
        return True

    # ---- Process & Window selection ----

    def select_processes(self, _):
        procs = list_running_processes()
        if not procs:
            rumps.alert(title="No Processes", message="No windowed applications found.")
            return
        proc_names = sorted([p["name"] for p in procs], key=str.lower)
        current = self._cfg.get("enabled_processes", PROCESS_NAMES)
        selected = show_dialog_with_list(
            "Select Processes to Monitor",
            f"Found {len(proc_names)} apps with windows.",
            proc_names,
            current
        )
        if selected:
            self._cfg["enabled_processes"] = selected
            save_config(self._cfg)
            self._build_menu()
            rumps.alert(title="Updated", message=f"Monitoring:\n{', '.join(selected)}")

    def select_windows(self, _):
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        all_buttons = debug_scan_all(enabled)
        if not all_buttons:
            rumps.alert(title="No Windows",
                        message=f"No buttons found in:\n{', '.join(enabled)}")
            return
        window_names = sorted(set(r["window"] for r in all_buttons if r["window"]))
        if not window_names:
            rumps.alert(title="No Windows", message="No window names found.")
            return
        current = self._cfg.get("window_filters", [])
        selected = show_dialog_with_list(
            "Select Windows to Filter",
            f"Found {len(window_names)} window(s) with buttons.",
            window_names,
            current
        )
        if selected is not None:
            self._cfg["window_filters"] = selected
            save_config(self._cfg)
            self._build_menu()
            rumps.alert(title="Updated",
                        message=f"Window filter: {', '.join(selected) if selected else 'Cleared'}")

    # ---- Monitoring ----

    def start_monitoring(self, _):
        if not self._has_permission:
            self.open_perm(_)
            return
        if self._running:
            return
        self._running = True
        global LIVE_STATUS
        LIVE_STATUS["running"] = True
        self._status_item.title = "Status: Scanning..."
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._thread.start()

    def stop_monitoring(self, _):
        self._running = False
        global LIVE_STATUS
        LIVE_STATUS["running"] = False
        self._status_item.title = "Status: Stopped"

    def test_scan(self, _):
        self._status_item.title = "Status: Testing..."
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        click_texts = self._cfg.get("click_texts", CLICK_TEXTS)
        never_texts = self._cfg.get("never_click_texts", NEVER_CLICK_TEXTS)
        window_filters = self._cfg.get("window_filters", [])
        results, status, elapsed = scan_buttons(
            enabled, click_texts, never_texts, window_filters, verbose=self._verbose
        )
        if status == "permission_denied":
            self._has_permission = False
            self._status_item.title = "Status: NO PERMISSION"
            rumps.alert(title="Accessibility Permission Required",
                        message="System Preferences > Security & Privacy > Privacy > Accessibility")
        elif status == "timeout":
            self._status_item.title = "Status: Timeout"
            rumps.alert(title="Scan Timeout", message=f"Scan took {elapsed:.1f}s.")
        elif status.startswith("error"):
            self._status_item.title = f"Error: {status}"
            rumps.alert(title="Scan Error", message=status)
        elif results:
            self._status_item.title = "Status: Found!"
            msg = f"Found {len(results)} button(s) in {elapsed:.1f}s:\n"
            for r in results:
                msg += f"[{r['process']}] {r['button']} | {r['window']}\n"
            rumps.alert(title="Scan Results", message=msg)
        else:
            self._status_item.title = "Status: No buttons (OK)"
            rumps.alert(title="Scan OK",
                        message=f"No matching buttons.\nMonitored: {', '.join(enabled)}")

    def debug_scan(self, _):
        self._status_item.title = "Status: Debug Scan..."
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        window_filters = self._cfg.get("window_filters", [])
        results = debug_scan_all(enabled, window_filters)
        if not results:
            self._status_item.title = "Status: No buttons (debug)"
            rumps.alert(title="Debug Scan",
                        message=f"No buttons at all in:\n{', '.join(enabled)}")
            return
        by_process = {}
        for r in results:
            by_process.setdefault(r["process"], []).append(r)
        msg = f"ALL buttons found ({len(results)} total):\n"
        for proc, btns in sorted(by_process.items()):
            msg += f"\n[{proc}] ({len(btns)} buttons)\n"
            for b in btns[:5]:
                msg += f"  * {b['button']} | {b['window']}\n"
            if len(btns) > 5:
                msg += f"  ... and {len(btns) - 5} more\n"
        self._status_item.title = f"Found {len(results)} btns (debug)"
        rumps.alert(title=f"Debug: {len(results)} Buttons", message=msg)

    def capture_now(self, _):
        path = capture_screenshot()
        if path:
            show_notification("Auto Clicker", "Screenshot saved!")
            rumps.alert(title="Screenshot", message=f"Saved to:\n{path}")
        else:
            rumps.alert(title="Screenshot", message="Failed to capture screenshot.")

    def open_screenshots(self, _):
        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        subprocess.Popen(["open", SCREENSHOT_DIR])

    def show_log(self, _):
        log = load_log()
        total = log.get("total_clicks", 0)
        recent = log.get("clicks", [])[:10]
        msg = f"Total Events: {total}\n\nRecent:\n"
        for entry in recent:
            dr = " [DRY]" if entry.get("dry_run") else ""
            msg += f"[{entry['time']}] {entry['process']}{dr}\n"
            msg += f"  Window: {entry['window']}\n"
            msg += f"  Button: {entry['button']}\n\n"
        if total == 0:
            msg += "(No events yet)"
        rumps.alert(title=f"Auto Clicker Log ({total})", message=msg)

    def edit_config(self, _):
        cfg_path = os.path.expanduser(CONFIG_FILE)
        subprocess.Popen(["open", "-a", "TextEdit", cfg_path])

    def open_perm(self, _):
        open_accessibility_settings()

    def install_auto_start(self, _):
        if install_login_item():
            rumps.alert(title="Auto-Start", message="AutoClicker added to Login Items.")
        else:
            rumps.alert(title="Auto-Start", message="Failed. Run --build first.")

    def quit_app(self, _):
        self._running = False
        global LIVE_STATUS
        LIVE_STATUS["running"] = False
        self.close_status_window()
        _release_pid_lock()
        from AppKit import NSApp
        try:
            NSApp.terminate_(None)
        except Exception:
            pass

    def _monitor_loop(self):
        while self._running:
            enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
            click_texts = self._cfg.get("click_texts", CLICK_TEXTS)
            never_texts = self._cfg.get("never_click_texts", NEVER_CLICK_TEXTS)
            window_filters = self._cfg.get("window_filters", [])
            dry_run = self._cfg.get("dry_run", True)

            # 1. Button-based detection
            results, status, _ = scan_buttons(
                enabled, click_texts, never_texts, window_filters, verbose=self._verbose
            )
            with self._lock:
                self._last_status = status
                self._last_scan_time = datetime.now().strftime("%H:%M:%S")
                self._last_scan_results = results

            global LIVE_STATUS
            LIVE_STATUS["last_scan"] = self._last_scan_time
            LIVE_STATUS["last_status"] = status
            LIVE_STATUS["last_results"] = results
            LIVE_STATUS["permission_ok"] = self._has_permission

            if status == "permission_denied":
                self._has_permission = False
                self._status_item.title = "Status: NO PERMISSION"
            elif status == "timeout":
                self._status_item.title = "Status: Timeout"
            elif status.startswith("error"):
                self._status_item.title = f"Error: {status}"
            elif results:
                show_alert = self._cfg.get("show_alert_on_find", True)
                capture = self._cfg.get("capture_screenshots", True)
                btn_names = set()
                clicked_count = 0
                for r in results:
                    btn_names.add(r["button"])
                    if not should_click_cooldown(r["button"]):
                        continue
                    if not self._check_rate_limit():
                        continue
                    if capture and HAS_PIL:
                        capture_screenshot(
                            f"btn_{r['process']}_{r['button']}_{datetime.now().strftime('%H%M%S')}.png"
                        )
                    if dry_run:
                        count = record_click(r["process"], r["button"], r["window"], was_dry_run=True)
                    else:
                        success, _ = click_button(r["process"], r["button"])
                        count = record_click(r["process"], r["button"], r["window"], was_dry_run=not success)
                        if success:
                            clicked_count += 1
                            if capture and HAS_PIL:
                                capture_screenshot(
                                    f"clicked_{r['process']}_{r['button']}_{datetime.now().strftime('%H%M%S')}.png"
                                )
                    with self._lock:
                        self._click_count = count
                if show_alert:
                    names = ", ".join(sorted(btn_names))
                    if dry_run:
                        show_notification("Auto Clicker", f"Found: {names} (dry-run)")
                    elif clicked_count > 0:
                        show_notification("Auto Clicker", f"Clicked: {names}")
                dry_str = "DRY" if dry_run else "LIVE"
                self._status_item.title = f"Status: {clicked_count}/{len(btn_names)} btn(s) [{dry_str}]"
            elif status == "none":
                self._status_item.title = f"Status: OK"

            # 2. Coordinate-based position clicks
            pos_clicked = process_position_clicks(self._cfg, dry_run)
            if pos_clicked > 0:
                with self._lock:
                    self._click_count += pos_clicked
                LIVE_STATUS["total_clicks"] = self._click_count

            LIVE_STATUS["total_clicks"] = self._click_count

            interval = self._cfg.get("check_interval", CHECK_INTERVAL)
            for _ in range(interval):
                if not self._running:
                    break
                time.sleep(1)


# ---------------------------------------------------------------------------
# CLI Mode
# ---------------------------------------------------------------------------

def run_cli_loop(cfg):
    click_texts = cfg.get("click_texts", CLICK_TEXTS)
    never_texts = cfg.get("never_click_texts", NEVER_CLICK_TEXTS)
    window_filters = cfg.get("window_filters", [])

    print(f"  Auto Clicker {VERSION} - CLI Mode")
    print(f"  Dry-Run: {'ON (safe)' if cfg.get('dry_run', True) else 'OFF (will click!)'}")
    print(f"  Processes: {cfg.get('enabled_processes', PROCESS_NAMES)}")
    print(f"  Interval: {cfg.get('check_interval', CHECK_INTERVAL)}s")
    positions = load_positions()
    if positions:
        print(f"  Positions: {len(positions)} ({', '.join(p['label'] for p in positions)})")
    if window_filters:
        print(f"  Window filters: {window_filters}")
    print(f"  Press Ctrl+C to stop")
    print(f"{'='*60}")

    scan_count = 0
    while True:
        try:
            scan_count += 1
            ts = datetime.now().strftime("%H:%M:%S")
            enabled = cfg.get("enabled_processes", PROCESS_NAMES)
            dry_run = cfg.get("dry_run", True)

            print(f"[{ts}] #{scan_count}", end="", flush=True)
            results, status, elapsed = scan_buttons(
                enabled, click_texts, never_texts, window_filters, verbose=False
            )

            if status == "permission_denied":
                print(f" PERMISSION DENIED! ({elapsed:.1f}s)")
            elif status == "timeout":
                print(f" Timeout ({elapsed:.1f}s)")
            elif status.startswith("error"):
                print(f" Error: {status} ({elapsed:.1f}s)")
            elif results:
                btn_list = []
                for r in results:
                    btn_list.append(f"'{r['button']}'")
                    if not should_click_cooldown(r["button"]):
                        continue
                    if dry_run:
                        record_click(r["process"], r["button"], r["window"], was_dry_run=True)
                    else:
                        success, err = click_button(r["process"], r["button"])
                        record_click(
                            r["process"], r["button"], r["window"],
                            was_dry_run=not success
                        )
                        if not success:
                            print(f"\n  [!] Click failed: {r['button']}: {err}")
                names = ", ".join(btn_list)
                action = "DRY-RUN" if dry_run else "CLICKED"
                print(f" {action}: [{results[0].get('process', '?')}] {names} ({elapsed:.1f}s)")

                if cfg.get("show_alert_on_find", True):
                    show_notification(
                        "Auto Clicker",
                        f"Found: {', '.join(set(r['button'] for r in results))}"
                    )
            else:
                print(f" ({elapsed:.1f}s)")

            # Coordinate-based clicks
            process_position_clicks(cfg, dry_run)

            time.sleep(cfg.get("check_interval", CHECK_INTERVAL))
        except KeyboardInterrupt:
            print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Stopped. Total scans: {scan_count}")
            break
        except Exception as e:
            print(f" Unexpected error: {e}")
            time.sleep(2)


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def main():
    if not _acquire_pid_lock():
        sys.exit(0)
    atexit.register(_release_pid_lock)

    if "--build" in sys.argv:
        path = build_standalone()
        print(f"[build] Done: {path}")
        return

    if "--install-login-item" in sys.argv:
        install_login_item()
        return

    if "--uninstall-login-item" in sys.argv:
        uninstall_login_item()
        return

    if "--list-procs" in sys.argv:
        procs = list_running_processes()
        print(f"Found {len(procs)} windowed processes:")
        for p in sorted(procs, key=lambda x: x["name"].lower()):
            print(f"  {p['name']} ({p['windows']} windows)")
        return

    if "--debug-scan" in sys.argv:
        cfg = load_config()
        enabled = cfg.get("enabled_processes", PROCESS_NAMES)
        window_filters = cfg.get("window_filters", [])
        print(f"Debug scan in: {enabled}")
        results = debug_scan_all(enabled, window_filters)
        print(f"\nFound {len(results)} buttons total:")
        by_proc = {}
        for r in results:
            by_proc.setdefault(r["process"], []).append(r)
        for proc, btns in sorted(by_proc.items()):
            print(f"\n  [{proc}] ({len(btns)} buttons)")
            for b in btns:
                print(f"    * {b['button']} | window: {b['window']}")
        return

    if "--screenshot" in sys.argv:
        path = capture_screenshot()
        if path:
            print(f"Screenshot saved: {path}")
        else:
            print("Screenshot failed.")
        return

    # ---- Position commands ----
    if "--record-pos" in sys.argv:
        idx = sys.argv.index("--record-pos")
        label = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else f"Pos_{int(time.time())}"
        x, y = get_mouse_position()
        add_position(x, y, label)
        print(f"Recorded position: {label} @ ({x}, {y})")
        show_click_indicator(x, y)
        return

    if "--list-pos" in sys.argv:
        positions = load_positions()
        if not positions:
            print("No saved positions.")
        else:
            for p in positions:
                state = "Enabled" if p.get("enabled", True) else "Disabled"
                print(f"  [{state}] {p.get('label','?')}: ({p['x']}, {p['y']})")
        return

    if "--clear-pos" in sys.argv:
        count = len(load_positions())
        clear_all_positions()
        print(f"Cleared {count} position(s).")
        return

    if "--click-pos" in sys.argv:
        idx = sys.argv.index("--click-pos")
        if idx + 2 < len(sys.argv):
            x = int(sys.argv[idx + 1])
            y = int(sys.argv[idx + 2])
        else:
            print("Usage: --click-pos <x> <y>")
            return
        dry_run = "--dry" not in sys.argv and not any("--live" in a for a in sys.argv)
        if "--live" in sys.argv:
            dry_run = False
        if dry_run:
            print(f"DRY-RUN: would click ({x}, {y})")
            show_click_indicator(x, y)
        else:
            show_click_indicator(x, y)
            click_at(x, y)
            print(f"CLICKED ({x}, {y})")
        return

    if "--test-pos" in sys.argv:
        cfg = load_config()
        dry_run = cfg.get("dry_run", True)
        positions = load_positions()
        if not positions:
            print("No saved positions. Use --record-pos <label> first.")
            return
        print(f"Testing {len(positions)} position(s)...")
        clicked = process_position_clicks(cfg, dry_run)
        print(f"Done: {clicked} clicked.")
        return

    if "--cli" in sys.argv or "--test-scan" in sys.argv:
        cfg = load_config()

        if "--test-scan" in sys.argv:
            enabled = cfg.get("enabled_processes", PROCESS_NAMES)
            click_texts = cfg.get("click_texts", CLICK_TEXTS)
            never_texts = cfg.get("never_click_texts", NEVER_CLICK_TEXTS)
            window_filters = cfg.get("window_filters", [])
            print("Scanning...")
            results, status, elapsed = scan_buttons(
                enabled, click_texts, never_texts, window_filters, verbose=True
            )
            print(f"[test-scan] Status: {status}, took {elapsed:.1f}s")
            for r in results:
                print(f"  [{r['process']}] {r['button']} | window: {r['window']}")
            return

        run_cli_loop(cfg)
        return

    app = AutoClickerApp()
    print(f"Auto Clicker {VERSION} started. Look for 'AC' in menu bar.")
    app.run()


if __name__ == "__main__":
    main()