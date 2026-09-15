"""Auto Clicker v1.0.4 - CLI mode, webview verification, verbose output, dry-run default"""
import atexit
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime

try:
    import rumps
except ImportError:
    rumps = None

VERSION = "v1.0.4"

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


def build_scan_script(enabled_processes):
    proc_conditions = []
    for p in enabled_processes:
        proc_conditions.append(f'name contains "{p}"')
    proc_filter = " or ".join(proc_conditions)

    click_list = ", ".join(f'"{t}"' for t in CLICK_TEXTS)
    never_list = ", ".join(f'"{t}"' for t in NEVER_CLICK_TEXTS)

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


def build_webview_verify_script(process_name):
    return f'''
tell application "System Events"
    if not (exists process "{process_name}") then
        return "NO_PROCESS"
    end if
    tell process "{process_name}"
        if (count of windows) is 0 then
            return "NO_WINDOW"
        end if
        set allElems to entire contents of window 1
        set outputText to ""
        repeat with elem in allElems
            try
                set elemRole to role of elem
                set elemTitle to title of elem
                if length of elemTitle > 0 then
                    set outputText to outputText & "[" & elemRole & "] " & elemTitle & "\\n"
                end if
            end try
        end repeat
        if length of outputText is 0 then
            return "EMPTY"
        end if
        return outputText
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


def scan_buttons(enabled_processes, verbose=False):
    try:
        script = build_scan_script(enabled_processes)
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True,
            timeout=OSASCRIPT_TIMEOUT
        )
        output = result.stdout.strip()
        stderr = result.stderr.strip()

        if stderr:
            if "not allowed" in stderr.lower():
                return [], "permission_denied"
            if "not found" not in stderr.lower() and "ok" not in stderr.lower():
                if verbose:
                    print(f"  [osascript stderr] {stderr[:100]}")
                return [], f"error: {stderr[:80]}"

        if not output:
            return [], "none"

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
        return results, "ok"
    except subprocess.TimeoutExpired:
        return [], "timeout"
    except Exception as e:
        return [], f"error: {e}"


def verify_webview(process_name, timeout=30):
    print(f"[webview-verify] Scanning entire contents of '{process_name}' window 1...")
    print(f"[webview-verify] This may take up to {timeout}s for complex apps...")
    try:
        script = build_webview_verify_script(process_name)
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout
        )
        output = result.stdout.strip()
        stderr = result.stderr.strip()

        if output in ("NO_PROCESS", "NO_WINDOW", "EMPTY", ""):
            print(f"[webview-verify] Result: {output or 'empty'}")
            return None
        if stderr:
            print(f"[webview-verify] Stderr: {stderr[:200]}")
        print(f"[webview-verify] Found elements (first 2000 chars):")
        print(output[:2000])
        return output
    except subprocess.TimeoutExpired:
        print(f"[webview-verify] Timeout after {timeout}s - app UI tree too large")
        return None
    except Exception as e:
        print(f"[webview-verify] Error: {e}")
        return None


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


def run_cli_loop(cfg):
    print(f"  Auto Clicker {VERSION} - CLI Mode")
    print(f"  Dry-Run: {'ON (safe)' if cfg.get('dry_run', True) else 'OFF (will click!)'}")
    print(f"  Processes: {cfg.get('enabled_processes', PROCESS_NAMES)}")
    print(f"  Interval: {cfg.get('check_interval', CHECK_INTERVAL)}s")
    print(f"  Press Ctrl+C to stop")
    print(f"{'='*60}")

    scan_count = 0
    while True:
        try:
            scan_count += 1
            enabled = cfg.get("enabled_processes", PROCESS_NAMES)
            results, status = scan_buttons(enabled, verbose=True)
            ts = datetime.now().strftime("%H:%M:%S")

            if status == "permission_denied":
                print(f"[{ts}] [#{scan_count}] PERMISSION DENIED!")
                print("  -> Run: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'")
            elif status == "timeout":
                print(f"[{ts}] [#{scan_count}] Timeout (scan >{OSASCRIPT_TIMEOUT}s)")
            elif status.startswith("error"):
                print(f"[{ts}] [#{scan_count}] Error: {status}")
            elif results:
                dry_run = cfg.get("dry_run", True)
                for r in results:
                    if not should_click_cooldown(r["button"]):
                        print(f"[{ts}] [#{scan_count}] SKIP (cooldown): {r['process']} -> {r['button']}")
                        continue

                    if dry_run:
                        print(f"[{ts}] [#{scan_count}] FOUND (dry-run): {r['process']} -> '{r['button']}' | window: {r['window']}")
                        record_click(r["process"], r["button"], r["window"], was_dry_run=True)
                    else:
                        success, err = click_button(r["process"], r["button"])
                        if success:
                            print(f"[{ts}] [#{scan_count}] CLICKED: {r['process']} -> '{r['button']}' | window: {r['window']}")
                            record_click(r["process"], r["button"], r["window"], was_dry_run=False)
                        else:
                            print(f"[{ts}] [#{scan_count}] CLICK FAIL: {r['process']} -> '{r['button']}': {err}")
                if cfg.get("show_alert_on_find", True):
                    names = set(r["button"] for r in results)
                    show_notification("Auto Clicker", f"Found: {', '.join(sorted(names))}")
            else:
                if scan_count % 5 == 0:
                    print(f"[{ts}] [#{scan_count}] No matches (normal)")
            time.sleep(cfg.get("check_interval", CHECK_INTERVAL))
        except KeyboardInterrupt:
            print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Stopped. Total scans: {scan_count}")
            break
        except Exception as e:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Unexpected error: {e}")
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

        from AppKit import NSApp, NSApplicationActivationPolicyAccessory
        NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

        self._build_menu()
        threading.Thread(target=self._check_permission_startup, daemon=True).start()

    def _build_menu(self):
        self.menu.clear()
        dry = "DRY-RUN" if self._cfg.get("dry_run", True) else "LIVE"
        self._status_item = rumps.MenuItem(f"Status: Starting... ({dry})")
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

        self.menu.add(rumps.MenuItem("Verify Webview (VSCode)", callback=self.verify_vscode))
        self.menu.add(rumps.MenuItem("Test Scan", callback=self.test_scan))
        self.menu.add(rumps.MenuItem("Show Log", callback=self.show_log))
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("Open Accessibility Settings", callback=self.open_perm))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem(f"Version: {VERSION}"))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Quit", callback=self.quit_app))

    def _check_permission_startup(self):
        permitted, err = check_accessibility_permission()
        self._has_permission = permitted
        if not permitted:
            self._status_item.title = "Status: NO PERMISSION - Click to fix"
            self._status_item.set_callback(self.open_perm)
        else:
            dry = "DRY-RUN" if self._cfg.get("dry_run", True) else "LIVE"
            self._status_item.title = f"Status: Ready ({dry})"

    @rumps.timer(1)
    def _update_title(self, _):
        prefix = "D" if self._cfg.get("dry_run", True) else "L"
        if self._running:
            s = {"permission_denied": "X", "timeout": "T", "none": "-", "ok": "+"}.get(
                self._last_status, "E" if self._last_status.startswith("error") else ""
            )
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

    def verify_vscode(self, _):
        self._status_item.title = "Status: Verifying VSCode webview..."
        threading.Thread(target=self._run_verify_vscode, daemon=True).start()

    def _run_verify_vscode(self):
        output = verify_webview("Code", timeout=60)
        if output:
            self._status_item.title = "Webview verify: FOUND elements"
            has_btn = "continue" in output.lower() or "accept" in output.lower()
            status = "BUTTONS VISIBLE!" if has_btn else "No dialog buttons found"
            rumps.alert(title="Webview Verification", message=f"{status}\n\nFirst 500 chars in log file.")
        else:
            self._status_item.title = "Webview verify: Timeout/empty"

    def test_scan(self, _):
        self._status_item.title = "Status: Testing..."
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        results, status = scan_buttons(enabled, verbose=self._verbose)
        if status == "permission_denied":
            self._has_permission = False
            self._status_item.title = "Status: NO PERMISSION"
            rumps.alert(title="Accessibility Permission Required",
                        message="Open System Preferences > Security & Privacy > Privacy > Accessibility")
        elif status == "timeout":
            self._status_item.title = "Status: Timeout"
            rumps.alert(title="Scan Timeout", message="Scan took >8s.")
        elif status.startswith("error"):
            self._status_item.title = f"Error: {status}"
            rumps.alert(title="Scan Error", message=status)
        elif results:
            self._status_item.title = "Status: Found!"
            msg = "Buttons found:\n"
            for r in results:
                msg += f"[{r['process']}] {r['button']}\n"
            rumps.alert(title="Scan Results", message=msg)
        else:
            self._status_item.title = "Status: No buttons (OK)"
            rumps.alert(title="Scan OK", message="No matching buttons. Normal behavior.")

    def show_log(self, _):
        log = load_log()
        total = log.get("total_clicks", 0)
        recent = log.get("clicks", [])[:15]
        msg = f"Total Events: {total}\n\nRecent:\n"
        for entry in recent:
            dr = " [DRY]" if entry.get("dry_run") else ""
            msg += f"[{entry['time']}] {entry['process']}{dr}\n"
            msg += f"  Window: {entry['window']}\n"
            msg += f"  Button: {entry['button']}\n\n"
        if total == 0:
            msg += "(No events yet)"
        rumps.alert(title=f"Auto Clicker Log ({total})", message=msg)

    def open_perm(self, _):
        open_accessibility_settings()

    def quit_app(self, _):
        self._running = False
        _release_pid_lock()
        from AppKit import NSApp
        NSApp.terminate_(None)

    def _monitor_loop(self):
        while self._running:
            enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
            results, status = scan_buttons(enabled, verbose=self._verbose)
            with self._lock:
                self._last_status = status
                self._last_scan_time = datetime.now().strftime("%H:%M:%S")

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
                        count = record_click(
                            r["process"], r["button"], r["window"], was_dry_run=not success
                        )
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
                if dry_run:
                    self._status_item.title = f"Found {len(btn_names)} btn(s) [DRY]"
                else:
                    self._status_item.title = f"Clicked {clicked_count}/{len(btn_names)}"
            elif status == "none":
                self._status_item.title = f"OK ({self._last_scan_time})"

            interval = self._cfg.get("check_interval", CHECK_INTERVAL)
            for _ in range(interval):
                if not self._running:
                    break
                time.sleep(1)


def main():
    if not _acquire_pid_lock():
        sys.exit(0)
    atexit.register(_release_pid_lock)

    if "--cli" in sys.argv or "--test-scan" in sys.argv or "--verify" in sys.argv:
        cfg = load_config()

        if "--verify" in sys.argv:
            verify_webview("Code", timeout=60)
            return
        if "--test-scan" in sys.argv:
            enabled = cfg.get("enabled_processes", PROCESS_NAMES)
            results, status = scan_buttons(enabled, verbose=True)
            print(f"Status: {status}")
            for r in results:
                print(f"  [{r['process']}] {r['button']} | window: {r['window']}")
            return

        run_cli_loop(cfg)
        return

    if rumps is None:
        print("Error: rumps not installed. Run: pip3 install rumps")
        print("Or use CLI mode: python3 auto_clicker_v1.0.4.py --cli")
        sys.exit(1)

    app = AutoClickerApp()
    print(f"Auto Clicker {VERSION} started.")
    app.run()


if __name__ == "__main__":
    main()