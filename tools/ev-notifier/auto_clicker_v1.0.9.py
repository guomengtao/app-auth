"""Auto Clicker v1.0.9 - Debug scan mode, window filtering, all-buttons discovery"""
VERSION = "v1.0.9"

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

PID_FILE = os.path.expanduser("~/.auto_clicker.pid")
LOG_FILE = os.path.expanduser("~/.auto_clicker_log.json")
CONFIG_FILE = os.path.expanduser("~/.auto_clicker_config.json")

CHECK_INTERVAL = 3
OSASCRIPT_TIMEOUT = 8
COOLDOWN_SECONDS = 5
MAX_HISTORY = 500

CLICK_HISTORY = {}

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


def _acquire_pid_lock():
    try:
        if os.path.exists(PID_FILE):
            with open(PID_FILE, "r") as f:
                old_pid = f.read().strip()
            if old_pid:
                try:
                    os.kill(int(old_pid), 0)
                    print(f"[!] Another instance is already running (PID {old_pid}). Exiting.")
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
        "show_alert_on_click": False,
        "show_alert_on_find": True,
        "max_clicks_per_minute": 20,
        "verbose": True,
        "click_texts": CLICK_TEXTS,
        "never_click_texts": NEVER_CLICK_TEXTS,
        "window_filters": [],
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


def build_scan_script(enabled_processes, click_texts, never_texts, window_filters=None, debug_all=False):
    proc_conditions = []
    for p in enabled_processes:
        proc_conditions.append(f'name contains "{p}"')
    proc_filter = " or ".join(proc_conditions)

    click_list = ", ".join(f'"{t}"' for t in click_texts)
    never_list = ", ".join(f'"{t}"' for t in never_texts)

    win_filter = ""
    if window_filters:
        win_conditions = []
        for wf in window_filters:
            win_conditions.append(f'wname contains "{wf}"')
        win_filter = " or ".join(win_conditions)

    if debug_all:
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
        print("[build] Pillow not installed, skipping icon generation.")
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

    if os.path.exists(icon_path):
        print(f"[build] Icon generated: {icon_path}")
    else:
        print("[build] Icon generation failed, continuing without icon.")


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
        else:
            print(f"[install] Failed: {result.stderr.strip()}")
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


def run_cli_loop(cfg):
    click_texts = cfg.get("click_texts", CLICK_TEXTS)
    never_texts = cfg.get("never_click_texts", NEVER_CLICK_TEXTS)
    window_filters = cfg.get("window_filters", [])

    print(f"  Auto Clicker {VERSION} - CLI Mode")
    print(f"  Dry-Run: {'ON (safe)' if cfg.get('dry_run', True) else 'OFF (will click!)'}")
    print(f"  Processes: {cfg.get('enabled_processes', PROCESS_NAMES)}")
    print(f"  Interval: {cfg.get('check_interval', CHECK_INTERVAL)}s")
    if window_filters:
        print(f"  Window filters: {window_filters}")
    print(f"  Click texts: {click_texts}")
    print(f"  Press Ctrl+C to stop")
    print(f"{'='*60}")

    scan_count = 0
    while True:
        try:
            scan_count += 1
            ts = datetime.now().strftime("%H:%M:%S")
            enabled = cfg.get("enabled_processes", PROCESS_NAMES)

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
                dry_run = cfg.get("dry_run", True)
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
                print(f" {action}: [{r.get('process', '?')}] {names} ({elapsed:.1f}s)")

                if cfg.get("show_alert_on_find", True):
                    show_notification(
                        "Auto Clicker",
                        f"Found: {', '.join(set(r['button'] for r in results))}"
                    )
            else:
                print(f" ({elapsed:.1f}s)")

            time.sleep(cfg.get("check_interval", CHECK_INTERVAL))
        except KeyboardInterrupt:
            print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Stopped. Total scans: {scan_count}")
            break
        except Exception as e:
            print(f" Unexpected error: {e}")
            time.sleep(2)


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

        from AppKit import NSApp, NSApplicationActivationPolicyAccessory
        try:
            NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        except Exception:
            pass

        self._build_menu()
        threading.Thread(target=self._check_permission_startup, daemon=True).start()
        threading.Thread(target=self._status_updater, daemon=True).start()

    def _status_updater(self):
        while True:
            with self._lock:
                self._status_text = self._status_item.title if hasattr(self, "_status_item") else ""
            time.sleep(1)

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

        self._verbose_item = rumps.MenuItem(
            f"Verbose: {'ON' if self._verbose else 'OFF'}",
            callback=self.toggle_verbose
        )
        self.menu.add(self._verbose_item)
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("Test Scan", callback=self.test_scan))
        self.menu.add(rumps.MenuItem("Debug Scan (All Buttons)", callback=self.debug_scan))
        self.menu.add(rumps.MenuItem("Show Log", callback=self.show_log))
        self.menu.add(rumps.MenuItem("Select Processes...", callback=self.select_processes))
        self.menu.add(rumps.MenuItem("Select Windows...", callback=self.select_windows))
        self.menu.add(rumps.MenuItem("Edit Config", callback=self.edit_config))
        self.menu.add(rumps.separator)

        procs = self._cfg.get("enabled_processes", PROCESS_NAMES)
        self.menu.add(rumps.MenuItem(f"Monitoring: {', '.join(procs)}"))
        win_filters = self._cfg.get("window_filters", [])
        if win_filters:
            self.menu.add(rumps.MenuItem(f"Window filter: {', '.join(win_filters)}"))
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("Open Accessibility Settings", callback=self.open_perm))
        self.menu.add(rumps.MenuItem("Install Auto-Start", callback=self.install_auto_start))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem(f"Version: {VERSION}"))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Quit", callback=self.quit_app))

    def _check_permission_startup(self):
        permitted, err = check_accessibility_permission()
        self._has_permission = permitted
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
        mode = "DRY-RUN" if self._cfg["dry_run"] else "LIVE"
        show_notification("Auto Clicker", f"Switched to {mode} mode")

    def toggle_alert_find(self, _):
        self._cfg["show_alert_on_find"] = not self._cfg.get("show_alert_on_find", True)
        save_config(self._cfg)
        self._build_menu()

    def toggle_alert_click(self, _):
        self._cfg["show_alert_on_click"] = not self._cfg.get("show_alert_on_click", False)
        save_config(self._cfg)
        self._build_menu()

    def toggle_verbose(self, _):
        self._verbose = not self._verbose
        self._cfg["verbose"] = self._verbose
        save_config(self._cfg)
        self._build_menu()

    def _check_rate_limit(self):
        max_clicks = self._cfg.get("max_clicks_per_minute", 20)
        now = time.time()
        cutoff = now - 60
        self._click_this_minute = [t for t in self._click_this_minute if t > cutoff]
        if len(self._click_this_minute) >= max_clicks:
            return False
        self._click_this_minute.append(now)
        return True

    def select_processes(self, _):
        procs = list_running_processes()
        if not procs:
            rumps.alert(title="No Processes", message="No windowed applications found.")
            return

        proc_names = sorted([p["name"] for p in procs], key=str.lower)
        current = self._cfg.get("enabled_processes", PROCESS_NAMES)
        selected = show_dialog_with_list(
            "Select Processes to Monitor",
            f"Found {len(proc_names)} apps with windows.\nSelected apps will be monitored for buttons.",
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
            rumps.alert(title="No Windows", message=f"No buttons found in:\n{', '.join(enabled)}\n\nEnsure apps are running with windows open.")
            return

        window_names = sorted(set(r["window"] for r in all_buttons if r["window"]))
        if not window_names:
            rumps.alert(title="No Windows", message="No window names found.")
            return

        current = self._cfg.get("window_filters", [])
        selected = show_dialog_with_list(
            "Select Windows to Filter",
            f"Found {len(window_names)} window(s) with buttons.\nOnly buttons in selected windows will be clicked.",
            window_names,
            current
        )
        if selected is not None:
            self._cfg["window_filters"] = selected
            save_config(self._cfg)
            self._build_menu()
            if selected:
                rumps.alert(title="Updated", message=f"Window filter:\n{', '.join(selected)}")
            else:
                rumps.alert(title="Updated", message="Window filter cleared. All windows monitored.")

    def start_monitoring(self, _):
        if not self._has_permission:
            self.open_perm(_)
            return
        if self._running:
            return
        self._running = True
        self._status_item.title = "Status: Scanning..."
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._thread.start()

    def stop_monitoring(self, _):
        self._running = False
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
            rumps.alert(title="Scan Timeout", message=f"Scan took {elapsed:.1f}s > {OSASCRIPT_TIMEOUT}s.")
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
                        message=f"No matching buttons in {elapsed:.1f}s.\nMonitored: {', '.join(enabled)}")

    def debug_scan(self, _):
        self._status_item.title = "Status: Debug Scan..."
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        window_filters = self._cfg.get("window_filters", [])
        results = debug_scan_all(enabled, window_filters)

        if not results:
            self._status_item.title = "Status: No buttons (debug)"
            rumps.alert(title="Debug Scan", message=f"No buttons at all in:\n{', '.join(enabled)}\n\nMake sure apps have visible windows with buttons.")
            return

        by_process = {}
        for r in results:
            key = r["process"]
            if key not in by_process:
                by_process[key] = []
            by_process[key].append(r)

        msg = f"ALL buttons found ({len(results)} total):\n"
        for proc, btns in sorted(by_process.items()):
            msg += f"\n[{proc}] ({len(btns)} buttons)\n"
            for b in btns[:5]:
                msg += f"  • {b['button']} | {b['window']}\n"
            if len(btns) > 5:
                msg += f"  ... and {len(btns) - 5} more\n"

        self._status_item.title = f"Found {len(results)} btns (debug)"
        rumps.alert(title=f"Debug: {len(results)} Buttons", message=msg)

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
            results, status, _ = scan_buttons(
                enabled, click_texts, never_texts, window_filters, verbose=self._verbose
            )
            with self._lock:
                self._last_status = status
                self._last_scan_time = datetime.now().strftime("%H:%M:%S")
                self._last_scan_results = results

            if status == "permission_denied":
                self._has_permission = False
                self._status_item.title = "Status: NO PERMISSION"
            elif status == "timeout":
                self._status_item.title = "Status: Timeout"
            elif status.startswith("error"):
                self._status_item.title = f"Error: {status}"
            elif results:
                dry_run = self._cfg.get("dry_run", True)
                show_alert = self._cfg.get("show_alert_on_find", True)
                btn_names = set()
                clicked_count = 0
                for r in results:
                    btn_names.add(r["button"])
                    if not should_click_cooldown(r["button"]):
                        continue
                    if not self._check_rate_limit():
                        continue
                    if dry_run:
                        count = record_click(r["process"], r["button"], r["window"], was_dry_run=True)
                    else:
                        success, _ = click_button(r["process"], r["button"])
                        count = record_click(r["process"], r["button"], r["window"], was_dry_run=not success)
                        if success:
                            clicked_count += 1
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

            interval = self._cfg.get("check_interval", CHECK_INTERVAL)
            for _ in range(interval):
                if not self._running:
                    break
                time.sleep(1)


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
        if window_filters:
            print(f"Window filters: {window_filters}")
        results = debug_scan_all(enabled, window_filters)
        print(f"\nFound {len(results)} buttons total:")
        by_proc = {}
        for r in results:
            by_proc.setdefault(r["process"], []).append(r)
        for proc, btns in sorted(by_proc.items()):
            print(f"\n  [{proc}] ({len(btns)} buttons)")
            for b in btns:
                print(f"    • {b['button']} | window: {b['window']}")
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
    print(f"Auto Clicker {VERSION} started. Look for 'D' in menu bar.")
    app.run()


if __name__ == "__main__":
    main()