"""Auto Clicker v1.0.1 - Minimal menu bar app, osascript + System Events button detection"""
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

VERSION = "v1.0.1"

PID_FILE = os.path.expanduser("~/.auto_clicker.pid")
LOG_FILE = os.path.expanduser("~/.auto_clicker_log.json")

CHECK_INTERVAL = 3
OSASCRIPT_TIMEOUT = 8
COOLDOWN_SECONDS = 5

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


def record_click(process_name, button_title, window_name):
    log = load_log()
    entry = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "process": process_name,
        "window": window_name,
        "button": button_title,
    }
    log["clicks"].insert(0, entry)
    if len(log["clicks"]) > 500:
        log["clicks"] = log["clicks"][:500]
    log["total_clicks"] = log.get("total_clicks", 0) + 1
    save_log(log)
    return log["total_clicks"]


def should_click_cooldown(button_title):
    now = time.time()
    key = button_title.lower()
    last = CLICK_HISTORY.get(key, 0)
    if now - last < COOLDOWN_SECONDS:
        return False
    CLICK_HISTORY[key] = now
    return True


def build_scan_script():
    click_list = "{" + ", ".join(f'"{t}"' for t in CLICK_TEXTS) + "}"
    never_list = "{" + ", ".join(f'"{t}"' for t in NEVER_CLICK_TEXTS) + "}"

    return f'''
set clickTexts to {click_list}
set neverTexts to {never_list}

tell application "System Events"
    set resultList to {{}}
    
    repeat with p in (every process whose name contains "Code" or name contains "Electron")
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
                            set browner to name of p
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
                                        try
                                            click b
                                        end try
                                        set end of resultList to pname & "::" & wname & "::" & btitle
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
    
    if (count of resultList) is 0 then
        return ""
    end if
    
    set AppleScript text item delimiters to "|||"
    return resultList as string
end tell
'''


def scan_and_click():
    try:
        script = build_scan_script()
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True,
            timeout=OSASCRIPT_TIMEOUT
        )
        output = result.stdout.strip()
        stderr = result.stderr.strip()

        if not output:
            if stderr:
                if "not allowed" in stderr.lower():
                    return [], "permission_denied"
                return [], "none"
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


class AutoClickerApp(rumps.App):
    def __init__(self):
        super().__init__("AC 0", quit_button=None)
        self._running = False
        self._click_count = 0
        self._thread = None
        self._lock = threading.Lock()
        self._last_status = "idle"

        self._start_item = rumps.MenuItem("Start Monitoring", callback=self.start_monitoring)
        self._stop_item = rumps.MenuItem("Stop Monitoring", callback=self.stop_monitoring)
        self.menu.add(self._start_item)
        self.menu.add(self._stop_item)
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Show Log", callback=self.show_log))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem(f"Version: {VERSION}"))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Quit", callback=self.quit_app))

    @rumps.timer(1)
    def _update_title(self, _):
        if self._running:
            self.title = f"AC {self._click_count}"
        else:
            self.title = "AC"

    def start_monitoring(self, _):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._thread.start()

    def stop_monitoring(self, _):
        self._running = False

    def show_log(self, _):
        log = load_log()
        total = log.get("total_clicks", 0)
        recent = log.get("clicks", [])[:15]
        msg = f"Total Clicks: {total}\n\nRecent:\n"
        for entry in recent:
            msg += f"[{entry['time']}] {entry['process']}\n"
            msg += f"  Window: {entry['window']}\n"
            msg += f"  Button: {entry['button']}\n\n"
        rumps.alert(title=f"Auto Clicker Log ({total} clicks)", message=msg)

    def quit_app(self, _):
        self._running = False
        _release_pid_lock()
        from AppKit import NSApp
        NSApp.terminate_(None)

    def _monitor_loop(self):
        while self._running:
            results, status = scan_and_click()
            if results:
                for r in results:
                    if not should_click_cooldown(r["button"]):
                        continue
                    count = record_click(r["process"], r["button"], r["window"])
                    with self._lock:
                        self._click_count = count
            with self._lock:
                self._last_status = status
            for _ in range(CHECK_INTERVAL):
                if not self._running:
                    break
                time.sleep(1)


def main():
    if rumps is None:
        print("Error: rumps not installed. Run: pip3 install rumps")
        sys.exit(1)
    app = AutoClickerApp()
    print(f"Auto Clicker {VERSION} started. Scanning for buttons...")
    app.run()


if __name__ == "__main__":
    if not _acquire_pid_lock():
        sys.exit(0)
    atexit.register(_release_pid_lock)
    main()