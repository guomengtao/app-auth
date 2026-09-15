"""Auto Clicker v1.0.3 - Dry-run mode, process toggle, config persistence, alerts"""
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

VERSION = "v1.0.3"

PID_FILE = os.path.expanduser("~/.auto_clicker.pid")
LOG_FILE = os.path.expanduser("~/.auto_clicker_log.json")
CONFIG_FILE = os.path.expanduser("~/.auto_clicker_config.json")

CHECK_INTERVAL = 3
OSASCRIPT_TIMEOUT = 8
COOLDOWN_SECONDS = 5
MAX_CLICK_HISTORY = 500

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
                    print(f"Another instance is already running (PID {old_pid}). Exiting.")
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
    if len(log["clicks"]) > MAX_CLICK_HISTORY:
        log["clicks"] = log["clicks"][:MAX_CLICK_HISTORY]
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
        return True, ""
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as e:
        return False, str(e)


def scan_buttons(enabled_processes):
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
        self._minute_start = time.time()

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
        self.menu.add(rumps.separator)

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
            if self._last_status == "permission_denied":
                s = "X"
            elif self._last_status == "timeout":
                s = "T"
            elif self._last_status.startswith("error"):
                s = "E"
            elif self._last_status == "none":
                s = "-"
            elif self._last_status == "ok":
                s = "+"
            else:
                s = ""
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

    def test_scan(self, _):
        self._status_item.title = "Status: Testing..."
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        results, status = scan_buttons(enabled)
        if status == "permission_denied":
            self._has_permission = False
            self._status_item.title = "Status: NO PERMISSION"
            rumps.alert(
                title="Accessibility Permission Required",
                message="Auto Clicker needs Accessibility permission.\n\n"
                        "Open System Preferences > Security & Privacy > "
                        "Privacy > Accessibility and add Terminal to the list."
            )
        elif status == "timeout":
            self._status_item.title = "Status: Timeout"
            rumps.alert(title="Scan Timeout", message="Scan took >8s. Target app may be busy.")
        elif status.startswith("error"):
            self._status_item.title = f"Error: {status}"
            rumps.alert(title="Scan Error", message=status)
        elif results:
            self._status_item.title = "Status: Found!"
            msg = "Buttons found:\n"
            for r in results:
                msg += f"[{r['process']}] {r['button']}\n"
            msg += f"\nDry-Run: {'ON (no click)' if self._cfg.get('dry_run', True) else 'OFF (will click)'}"
            rumps.alert(title="Scan Results", message=msg)
        else:
            self._status_item.title = "Status: No buttons (OK)"
            rumps.alert(
                title="Scan OK",
                message="Scan completed. No matching buttons found.\n"
                        "Normal - no confirmation dialogs are open."
            )

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
            results, status = scan_buttons(enabled)

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
                dry_count = 0

                for r in results:
                    btn_names.add(r["button"])
                    if not should_click_cooldown(r["button"]):
                        continue
                    if not self._check_rate_limit():
                        continue

                    if dry_run:
                        dry_count += 1
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
                        show_notification(
                            "Auto Clicker",
                            f"Found: {names} (dry-run, not clicked)"
                        )
                    elif clicked_count > 0:
                        show_notification(
                            "Auto Clicker",
                            f"Clicked: {names}"
                        )

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
    if rumps is None:
        print("Error: rumps not installed. Run: pip3 install rumps")
        sys.exit(1)
    app = AutoClickerApp()
    print(f"Auto Clicker {VERSION} started.")
    app.run()


if __name__ == "__main__":
    if not _acquire_pid_lock():
        sys.exit(0)
    atexit.register(_release_pid_lock)
    main()