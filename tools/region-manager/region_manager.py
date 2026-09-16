"""Screen Region Manager v1.3.0 - Draggable overlay windows with edit mode support"""
VERSION = "v1.5.0"

import atexit
import json
import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime

LOG_FILE = os.path.expanduser("~/.region_manager.log")
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

def _log(msg):
    logging.debug(msg)
    print(msg, flush=True)

try:
    import rumps
except ImportError:
    print("Error: rumps not installed. Run: pip install rumps")
    sys.exit(1)

try:
    import tkinter as tk
    TK_AVAILABLE = True
except ImportError:
    TK_AVAILABLE = False

try:
    from AppKit import NSScreen, NSApp, NSApplicationActivationPolicyAccessory, \
        NSEvent, NSLeftMouseDownMask, NSLeftMouseUpMask, NSMouseMovedMask, \
        NSApplication, NSWindow, NSBorderlessWindowMask, NSBackingStoreBuffered, \
        NSColor, NSMakeRect
    HAS_APPKIT = True
except ImportError:
    HAS_APPKIT = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import pytesseract
    HAS_OCR = True
except ImportError:
    HAS_OCR = False

REGIONS_FILE = os.path.expanduser("~/.screen_regions.json")
EDITOR_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "region_editor.py")
REGION_MIN_WIDTH = 30
REGION_MIN_HEIGHT = 20

def _find_tk_python():
    candidates = [
        sys.executable,
        "/opt/homebrew/bin/python3.13",
        "/opt/homebrew/bin/python3.12",
        "/usr/local/bin/python3.12",
        "/usr/local/bin/python3.13",
        "/usr/bin/python3",
    ]
    for py in candidates:
        if not os.path.exists(py):
            continue
        try:
            result = subprocess.run(
                [py, "-c", "import tkinter"], capture_output=True, timeout=10)
            if result.returncode == 0:
                _log(f"_find_tk_python: found {py}")
                return py
        except Exception:
            continue
    _log("_find_tk_python: no Python with tkinter found, falling back to sys.executable")
    return sys.executable

if not TK_AVAILABLE:
    _tk_py = _find_tk_python()
    if _tk_py != sys.executable and os.path.exists(_tk_py):
        _log(f"re-executing with tkinter-capable Python: {_tk_py}")
        os.execv(_tk_py, [_tk_py] + sys.argv)
    else:
        _log("tkinter not available, continuing without overlay windows")

REGION_COLORS = ["#FF4444", "#4488FF", "#44CC44", "#FF8800", "#AA44FF", "#888888"]
COLOR_NAMES = ["红色", "蓝色", "绿色", "橙色", "紫色", "灰色"]

ACTION_TYPES = ["click", "ocr", "scroll", "screenshot", "none"]
ACTION_NAMES = ["定时点击", "OCR 识别", "自动滚动", "定时截图", "仅标记"]

INTERVALS = [1, 2, 3, 5, 10, 30, 60]

_REGION_ACTION_STOP = {}
_TK_ROOT = None

def get_tk_root():
    global _TK_ROOT
    if _TK_ROOT is None and TK_AVAILABLE:
        _TK_ROOT = tk.Tk()
        _TK_ROOT.withdraw()
        _TK_ROOT.geometry("1x1+0+0")
        _TK_ROOT.overrideredirect(True)
    return _TK_ROOT

def load_regions():
    try:
        with open(REGIONS_FILE, "r") as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
            return data.get("regions", [])
    except Exception:
        return []

def save_regions(regions):
    try:
        data = {"version": "1.0", "updated_at": datetime.now().isoformat(), "regions": regions}
        bak = REGIONS_FILE + ".bak"
        if os.path.exists(REGIONS_FILE):
            shutil.copy2(REGIONS_FILE, bak)
        with open(REGIONS_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass

def add_region_config(x, y, width, height, label, color="#FF4444", action_type="click"):
    regions = load_regions()
    rid = f"region_{int(time.time())}"
    region = {
        "id": rid, "label": label,
        "x": x, "y": y,
        "width": max(width, REGION_MIN_WIDTH),
        "height": max(height, REGION_MIN_HEIGHT),
        "color": color, "enabled": True,
        "action_type": action_type,
        "action_config": {"interval_seconds": 3.0, "click_mode": "center",
                          "click_offset_x": 0, "click_offset_y": 0, "double_click": False}
        if action_type == "click" else {},
    }
    regions.append(region)
    save_regions(regions)
    return region

def remove_region_config(rid):
    regions = [r for r in load_regions() if r["id"] != rid]
    save_regions(regions)
    return regions

def toggle_region_config(rid):
    regions = load_regions()
    for r in regions:
        if r["id"] == rid:
            r["enabled"] = not r.get("enabled", True)
    save_regions(regions)
    return regions

def update_region_action(rid, action_type):
    regions = load_regions()
    for r in regions:
        if r["id"] == rid:
            r["action_type"] = action_type
            if action_type == "click" and not r.get("action_config"):
                r["action_config"] = {"interval_seconds": 3.0}
    save_regions(regions)
    return regions

def update_region_color(rid, color):
    regions = load_regions()
    for r in regions:
        if r["id"] == rid:
            r["color"] = color
    save_regions(regions)
    return regions

def update_region_interval(rid, interval):
    regions = load_regions()
    for r in regions:
        if r["id"] == rid:
            if "action_config" not in r:
                r["action_config"] = {}
            r["action_config"]["interval_seconds"] = interval
    save_regions(regions)
    return regions

def update_region_label(rid, label):
    regions = load_regions()
    for r in regions:
        if r["id"] == rid:
            r["label"] = label
    save_regions(regions)
    return regions

def get_all_screens():
    if not HAS_APPKIT:
        return [{"index": 0, "name": "主显示器", "x": 0, "y": 0, "width": 1920, "height": 1080, "is_primary": True}]
    screens = NSScreen.screens()
    result = []
    for i, screen in enumerate(screens):
        frame = screen.frame()
        if hasattr(frame, 'origin'):
            fx, fy = int(frame.origin.x), int(frame.origin.y)
            fw, fh = int(frame.size.width), int(frame.size.height)
        elif isinstance(frame, tuple):
            origin, size = frame
            if isinstance(origin, tuple) and len(origin) == 2:
                fx, fy = int(origin[0]), int(origin[1])
                fw, fh = int(size[0]), int(size[1])
            else:
                fx, fy = 0, 0
                fw, fh = 1920, 1080
        else:
            fx, fy = 0, 0
            fw, fh = 1920, 1080
        is_builtin = False
        try:
            is_builtin = getattr(screen, 'isBuiltin', lambda: False)()
        except Exception:
            pass
        if i == 0:
            name = "主显示器（内建）" if is_builtin else "主显示器"
        else:
            name = f"外接显示器 {i}"
        result.append({
            "index": i, "name": name,
            "x": fx, "y": fy,
            "width": fw, "height": fh,
            "is_primary": i == 0,
        })
    return result

def get_region_screen(region, screens):
    cx = region["x"] + region["width"] // 2
    cy = region["y"] + region["height"] // 2
    for s in screens:
        if s["x"] <= cx <= s["x"] + s["width"] and s["y"] <= cy <= s["y"] + s["height"]:
            return s["index"]
    return -1

def get_mouse_position():
    try:
        from Quartz import CGEventGetLocation, CGEventCreate
        try:
            pos = CGEventGetLocation(CGEventCreate(None))
            return (int(pos.x), int(pos.y))
        except Exception:
            pass
    except ImportError:
        pass
    try:
        r = subprocess.run(["osascript", "-e",
            'tell application "System Events" to get {x, y} of (current screen)'  ],
            capture_output=True, text=True, timeout=5)
        parts = r.stdout.strip().replace("{", "").replace("}", "").split(",")
        return (int(parts[0].strip()), int(parts[1].strip()))
    except Exception:
        return (500, 500)

def click_at(x, y):
    try:
        import Quartz
        Quartz.CGEventPost(Quartz.kCGHIDEventTap,
            Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (x, y), 0))
        time.sleep(0.02)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap,
            Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, (x, y), 0))
        time.sleep(0.02)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap,
            Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, (x, y), 0))
    except ImportError:
        subprocess.run(["osascript", "-e",
            f'tell application "System Events" to click at {{{x}, {y}}}'],
            capture_output=True, timeout=5)

def show_notification(title, message):
    try:
        subprocess.run(["osascript", "-e",
            f'display notification "{message}" with title "{title}"'],
            timeout=3)
    except Exception:
        pass

def show_text_input_sync(title, message, default_value=""):
    script = f'''
tell application "System Events"
    set resultText to text returned of (display dialog "{message}" with title "{title}" default answer "{default_value}" buttons {{"取消", "确定"}} default button "确定")
    return resultText
end tell'''
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=30)
        out = r.stdout.strip()
        if not out or "取消" in out:
            return None
        return out
    except Exception:
        return None

def show_dialog_sync(title, message, buttons):
    btn_str = ",".join(f'"{b}"' for b in buttons)
    script = f'''
tell application "System Events"
    set resultBtn to button returned of (display dialog "{message}" with title "{title}" buttons {{{btn_str}}})
    return resultBtn
end tell'''
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=30)
        return r.stdout.strip()
    except Exception:
        return None


class RegionOverlay:
    def __init__(self, region_cfg, region_index, edit_mode=False, on_delete=None):
        if not TK_AVAILABLE:
            raise RuntimeError("tkinter not available")
        self.cfg = region_cfg
        self.index = region_index
        self.edit_mode = edit_mode
        self.on_delete = on_delete
        self.win = None
        self.canvas = None
        self._close_win = None
        self._run_btn_win = None
        self._run_btn_label = None
        self._run_count = 0
        self._run_thread = None
        self._run_stop = True
        self._create_window()

    def _create_window(self):
        c = self.cfg
        root = get_tk_root()
        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.win.attributes("-alpha", 0.70)
        self.win.geometry(f"{c['width']}x{c['height']}+{c['x']}+{c['y']}")
        self.win.configure(bg="white")
        self.win.configure(background="white")
        self.win.wm_attributes("-transparent", "white")

        color = c.get("color", "#FF4444")
        label = c.get("label", "?")
        w, h = c["width"], c["height"]

        self.canvas = tk.Canvas(self.win, width=w, height=h,
                                bg="white", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)

        self._draw_everything(w, h, color, label)
        self._create_close_button()
        self._create_start_button()
        self._start_x = 0
        self._start_y = 0
        self._orig_x = 0
        self._orig_y = 0
        self._orig_w = 0
        self._orig_h = 0
        self._mode = None

    def _draw_everything(self, w, h, color, label):
        self.canvas.delete("all")

        self.canvas.create_rectangle(1, 1, w - 1, h - 1, outline=color, width=2, tags="border")

        tag_height = 24
        tag_width = max(len(label) * 12 + 50, 80)
        self.canvas.create_rectangle(0, 0, tag_width, tag_height, fill=color, outline="", tags="label_bg")
        num_label = f"#{self.index} {label}"
        self.canvas.create_text(10, tag_height // 2, text=num_label, anchor="w",
                                fill="#FFFFFF", font=("PingFang SC", 10, "bold"), tags="label_text")

        cross_color = self._hex_fade(color, 0.25)
        self.canvas.create_line(w // 2, 0, w // 2, h, fill=cross_color, width=1, tags="cross")
        self.canvas.create_line(0, h // 2, w, h // 2, fill=cross_color, width=1, tags="cross")

        rh_size = 16
        self.canvas.create_rectangle(w - rh_size, h - rh_size, w, h,
                                     fill="#666666", outline="", tags="resize_handle")
        self.canvas.create_line(w - rh_size + 5, h - 5, w - 5, h - rh_size + 5,
                                fill="#FFFFFF", width=2, tags="resize_handle")

        action_name = dict(zip(ACTION_TYPES, ACTION_NAMES)).get(self.cfg.get("action_type", "click"), "点击")
        self.canvas.create_text(w // 2, h - 8, text=f"[{action_name}]",
                                fill=color, font=("PingFang SC", 8, "bold"), tags="action_label")

    @staticmethod
    def _hex_fade(hex_color, alpha):
        hex_color = hex_color.lstrip("#")
        if len(hex_color) == 6:
            r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
            r2 = int(r * alpha + 255 * (1 - alpha))
            g2 = int(g * alpha + 255 * (1 - alpha))
            b2 = int(b * alpha + 255 * (1 - alpha))
            return f"#{r2:02x}{g2:02x}{b2:02x}"
        return hex_color

    def _create_close_button(self):
        c = self.cfg
        close_size = 20
        self._close_win = tk.Toplevel(self.win)
        self._close_win.overrideredirect(True)
        self._close_win.attributes("-topmost", True)
        cx = c["x"] + c["width"] - close_size - 2
        cy = c["y"] - close_size + 4
        self._close_win.geometry(f"{close_size}x{close_size}+{cx}+{cy}")
        self._close_win.configure(bg="#CC0000")

        btn = tk.Label(self._close_win, text="X",
                       bg="#CC0000", fg="#FFFFFF",
                       font=("Helvetica", 11, "bold"),
                       cursor="hand2")
        btn.pack(fill="both", expand=True)
        btn.bind("<Button-1>", self._on_close)
        btn.bind("<Enter>", lambda e: btn.configure(bg="#FF0000"))
        btn.bind("<Leave>", lambda e: btn.configure(bg="#CC0000"))

    def _on_close(self, event=None):
        self._mode = None
        if self.on_delete:
            self.on_delete(self.cfg["id"])
        self.destroy()
        return "break"

    def _position_close_button(self):
        if self._close_win is None:
            return
        c = self.cfg
        close_size = 20
        cx = c["x"] + c["width"] - close_size - 2
        cy = c["y"] - close_size + 4
        try:
            self._close_win.geometry(f"{close_size}x{close_size}+{cx}+{cy}")
        except Exception:
            pass

    def _create_start_button(self):
        c = self.cfg
        btn_w, btn_h = 52, 22
        self._run_btn_win = tk.Toplevel(self.win)
        self._run_btn_win.overrideredirect(True)
        self._run_btn_win.attributes("-topmost", True)
        cx = c["x"] + c["width"] // 2 - btn_w // 2
        cy = c["y"] + c["height"] + 4
        self._run_btn_win.geometry(f"{btn_w}x{btn_h}+{cx}+{cy}")
        self._run_btn_win.configure(bg="#228B22")

        self._run_btn_label = tk.Label(self._run_btn_win, text="Start",
                                       bg="#228B22", fg="#FFFFFF",
                                       font=("Helvetica", 9, "bold"),
                                       cursor="hand2")
        self._run_btn_label.pack(fill="both", expand=True)
        self._run_btn_label.bind("<Button-1>", self._toggle_run)
        self._run_btn_label.bind("<Enter>",
            lambda e: self._run_btn_label.configure(
                bg="#FF4444" if not self._run_stop else "#32CD32"))
        self._run_btn_label.bind("<Leave>",
            lambda e: self._run_btn_label.configure(
                bg="#FF4444" if not self._run_stop else "#228B22"))

    def _position_start_button(self):
        if self._run_btn_win is None:
            return
        c = self.cfg
        btn_w, btn_h = 52, 22
        cx = c["x"] + c["width"] // 2 - btn_w // 2
        cy = c["y"] + c["height"] + 4
        try:
            self._run_btn_win.geometry(f"{btn_w}x{btn_h}+{cx}+{cy}")
        except Exception:
            pass

    def _toggle_run(self, event=None):
        if self._run_stop:
            self._start_run_loop()
        else:
            self._stop_run_loop()

    def _start_run_loop(self):
        self._run_stop = False
        self._run_count = 0
        if self._run_btn_label:
            self._run_btn_label.configure(text="0 times", bg="#FF4444")
        self._run_thread = threading.Thread(target=self._run_loop, daemon=True)
        self._run_thread.start()

    def _stop_run_loop(self):
        self._run_stop = True
        if self._run_btn_label:
            self._run_btn_label.configure(text="Start", bg="#228B22")

    def _update_run_count(self):
        if self._run_btn_label:
            try:
                self._run_btn_label.configure(text=f"{self._run_count} times")
            except Exception:
                pass

    def _run_loop(self):
        while not self._run_stop:
            try:
                cx = self.cfg["x"] + self.cfg["width"] // 2
                cy = self.cfg["y"] + self.cfg["height"] // 2

                for _ in range(7):
                    if self._run_stop:
                        return
                    import Quartz
                    try:
                        Quartz.CGEventPost(Quartz.kCGHIDEventTap,
                            Quartz.CGEventCreateScrollWheelEvent(
                                None, Quartz.kCGScrollEventUnitLine, 1, -800))
                    except Exception:
                        pass
                    time.sleep(0.15)

                if self._run_stop:
                    return

                try:
                    import Quartz
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap,
                        Quartz.CGEventCreateMouseEvent(
                            None, Quartz.kCGEventMouseMoved, (cx, cy), 0))
                    time.sleep(0.03)
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap,
                        Quartz.CGEventCreateMouseEvent(
                            None, Quartz.kCGEventLeftMouseDown, (cx, cy), 0))
                    time.sleep(0.03)
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap,
                        Quartz.CGEventCreateMouseEvent(
                            None, Quartz.kCGEventLeftMouseUp, (cx, cy), 0))
                except Exception:
                    pass

                self._run_count += 1
                self.win.after(0, self._update_run_count)

                waited = 0
                while waited < 10 and not self._run_stop:
                    time.sleep(0.1)
                    waited += 0.1

            except Exception:
                time.sleep(1)

    def destroy(self):
        self._stop_run_loop()
        if self._run_btn_win:
            try:
                self._run_btn_win.destroy()
            except Exception:
                pass
            self._run_btn_win = None
            self._run_btn_label = None
        if self._close_win:
            try:
                self._close_win.destroy()
            except Exception:
                pass
            self._close_win = None
        if self.win:
            try:
                self.win.destroy()
            except Exception:
                pass
            self.win = None

    def update_label(self, index):
        self.index = index
        self._draw_everything(self.cfg["width"], self.cfg["height"],
                              self.cfg.get("color", "#FF4444"), self.cfg.get("label", "?"))
        self.win.lift()

    def _bind_edit(self):
        self._unbind_edit()
        self.canvas.bind("<ButtonPress-1>", self._start_move)
        self.canvas.bind("<B1-Motion>", self._do_move)
        self.canvas.bind("<ButtonRelease-1>", self._stop_move)

        self.canvas.tag_bind("resize_handle", "<ButtonPress-1>", self._start_resize)
        self.canvas.tag_bind("resize_handle", "<B1-Motion>", self._do_resize)
        self.canvas.tag_bind("resize_handle", "<ButtonRelease-1>", self._stop_move)

        tag_height = 24
        tag_width = max(len(self.cfg.get("label", "?")) * 12 + 50, 80)
        self.canvas.tag_unbind("label_bg", "<ButtonPress-1>")
        self.canvas.tag_unbind("label_text", "<ButtonPress-1>")
        self.canvas.tag_bind("label_bg", "<Double-Button-1>",
                             lambda e: self._open_detail())
        self.canvas.tag_bind("label_text", "<Double-Button-1>",
                             lambda e: self._open_detail())

    def _unbind_edit(self):
        self.canvas.unbind("<ButtonPress-1>")
        self.canvas.unbind("<B1-Motion>")
        self.canvas.unbind("<ButtonRelease-1>")
        self.canvas.tag_unbind("resize_handle", "<ButtonPress-1>")
        self.canvas.tag_unbind("resize_handle", "<B1-Motion>")
        self.canvas.tag_unbind("resize_handle", "<ButtonRelease-1>")
        self.canvas.tag_unbind("label_bg", "<Double-Button-1>")
        self.canvas.tag_unbind("label_text", "<Double-Button-1>")

    def _open_detail(self):
        if self.on_delete:
            pass

    def _save_cfg(self):
        regions = load_regions()
        for r in regions:
            if r["id"] == self.cfg["id"]:
                r["x"] = self.cfg["x"]
                r["y"] = self.cfg["y"]
                r["width"] = self.cfg["width"]
                r["height"] = self.cfg["height"]
                break
        save_regions(regions)

    def _start_move(self, event):
        if self._mode is not None:
            return
        self._mode = "move"
        self._start_x = event.x_root
        self._start_y = event.y_root
        self._orig_x = self.cfg["x"]
        self._orig_y = self.cfg["y"]

    def _do_move(self, event):
        if self._mode != "move":
            return
        dx = event.x_root - self._start_x
        dy = event.y_root - self._start_y
        nx = self._orig_x + dx
        ny = self._orig_y + dy
        self.cfg["x"] = nx
        self.cfg["y"] = ny
        self.win.geometry(f"+{nx}+{ny}")
        self._position_close_button()
        self._position_start_button()

    def _stop_move(self, event):
        if self._mode in ("move", "resize"):
            self._save_cfg()
        self._mode = None

    def _start_resize(self, event):
        self._mode = "resize"
        self._start_x = event.x_root
        self._start_y = event.y_root
        self._orig_x = self.cfg["x"]
        self._orig_y = self.cfg["y"]
        self._orig_w = self.cfg["width"]
        self._orig_h = self.cfg["height"]

    def _do_resize(self, event):
        if self._mode != "resize":
            return
        dx = event.x_root - self._start_x
        dy = event.y_root - self._start_y
        nw = max(REGION_MIN_WIDTH, self._orig_w + dx)
        nh = max(REGION_MIN_HEIGHT, self._orig_h + dy)
        self.cfg["width"] = nw
        self.cfg["height"] = nh
        self.win.geometry(f"{nw}x{nh}")
        self._draw_everything(nw, nh,
                              self.cfg.get("color", "#FF4444"),
                              self.cfg.get("label", "?"))
        self._bind_edit()
        self._position_close_button()
        self._position_start_button()


class RegionManager:
    def __init__(self):
        self.overlays = {}
        self._edit_mode = False

    def set_edit_mode(self, flag):
        self._edit_mode = flag
        for o in self.overlays.values():
            if flag:
                o._bind_edit()
            else:
                o._unbind_edit()

    def _renumber_all(self):
        sorted_ids = sorted(self.overlays.keys(),
                            key=lambda rid: (self.overlays[rid].cfg["y"], self.overlays[rid].cfg["x"]))
        for i, rid in enumerate(sorted_ids, 1):
            if rid in self.overlays:
                self.overlays[rid].update_label(i)

    def load_all(self):
        self.destroy_all()
        regions = load_regions()
        idx = 1
        for r in regions:
            if r.get("enabled", True):
                try:
                    overlay = RegionOverlay(r, idx)
                    self.overlays[r["id"]] = overlay
                    if self._edit_mode:
                        overlay._bind_edit()
                    idx += 1
                except RuntimeError:
                    pass

    def add_region(self, x, y, width, height, label, color="#FF4444", action_type="click"):
        region = add_region_config(x, y, width, height, label, color, action_type)
        idx = len(self.overlays) + 1
        try:
            overlay = RegionOverlay(region, idx)
            self.overlays[region["id"]] = overlay
            if self._edit_mode:
                overlay._bind_edit()
        except RuntimeError:
            pass
        return region

    def remove_region(self, rid):
        if rid in self.overlays:
            self.overlays[rid].destroy()
            del self.overlays[rid]
        remove_region_config(rid)
        self._renumber_all()

    def toggle_region(self, rid):
        toggle_region_config(rid)
        regions = load_regions()
        r = next((r for r in regions if r["id"] == rid), None)
        if r is None:
            return
        if r.get("enabled", True) and rid not in self.overlays:
            try:
                idx = len(self.overlays) + 1
                overlay = RegionOverlay(r, idx)
                self.overlays[rid] = overlay
            except RuntimeError:
                pass
        elif not r.get("enabled", True) and rid in self.overlays:
            self.overlays[rid].destroy()
            del self.overlays[rid]
            self._renumber_all()

    def destroy_all(self):
        for o in list(self.overlays.values()):
            o.destroy()
        self.overlays.clear()

    def get_active_regions(self):
        regions = load_regions()
        return [r for r in regions if r.get("enabled", True)]

    def start_action_loops(self):
        for rid in list(_REGION_ACTION_STOP.keys()):
            _REGION_ACTION_STOP[rid] = True
        regions = self.get_active_regions()
        for r in regions:
            rid = r["id"]
            at = r.get("action_type", "click")
            if at == "none":
                continue
            _REGION_ACTION_STOP[rid] = False
            if at == "click":
                t = threading.Thread(target=self._click_loop, args=(r,), daemon=True)
            elif at == "ocr":
                t = threading.Thread(target=self._ocr_loop, args=(r,), daemon=True)
            elif at == "scroll":
                t = threading.Thread(target=self._scroll_loop, args=(r,), daemon=True)
            elif at == "screenshot":
                t = threading.Thread(target=self._screenshot_loop, args=(r,), daemon=True)
            else:
                continue
            t.start()

    def stop_action_loops(self):
        for rid in _REGION_ACTION_STOP:
            _REGION_ACTION_STOP[rid] = True

    def _click_loop(self, r):
        rid = r["id"]
        ax = r["x"] + r["width"] // 2 + r.get("action_config", {}).get("click_offset_x", 0)
        ay = r["y"] + r["height"] // 2 + r.get("action_config", {}).get("click_offset_y", 0)
        interval = r.get("action_config", {}).get("interval_seconds", 3.0)
        double = r.get("action_config", {}).get("double_click", False)
        while not _REGION_ACTION_STOP.get(rid, True):
            try:
                click_at(ax, ay)
                if double:
                    time.sleep(0.05)
                    click_at(ax, ay)
            except Exception:
                pass
            time.sleep(interval)

    def _ocr_loop(self, r):
        if not HAS_OCR or not HAS_PIL:
            return
        rid = r["id"]
        interval = r.get("action_config", {}).get("interval_seconds", 5.0)
        watch_text = r.get("action_config", {}).get("watch_text", "").lower()
        rect = (r["x"], r["y"], r["width"], r["height"])
        last_text = ""
        while not _REGION_ACTION_STOP.get(rid, True):
            try:
                img_path = self._capture_screenshot(rect, f"_ocr_{rid}")
                if img_path and os.path.exists(img_path):
                    img = Image.open(img_path)
                    text = pytesseract.image_to_string(img, lang="chi_sim+eng").strip()
                    if text and text != last_text:
                        last_text = text
                        if watch_text and watch_text in text.lower():
                            show_notification(f"区域 [{r.get('label','?')}]", f"匹配: {watch_text}")
                    try:
                        os.unlink(img_path)
                    except Exception:
                        pass
            except Exception:
                pass
            time.sleep(interval)

    def _scroll_loop(self, r):
        rid = r["id"]
        interval = r.get("action_config", {}).get("interval_seconds", 10.0)
        distance = r.get("action_config", {}).get("scroll_distance", 300)
        direction = r.get("action_config", {}).get("direction", "down")
        cx = r["x"] + r["width"] // 2
        cy = r["y"] + r["height"] // 2
        while not _REGION_ACTION_STOP.get(rid, True):
            try:
                dy = distance if direction == "down" else -distance
                try:
                    import Quartz
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap,
                        Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (cx, cy), 0))
                    time.sleep(0.05)
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap,
                        Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, dy, 0))
                except ImportError:
                    pass
            except Exception:
                pass
            time.sleep(interval)

    def _screenshot_loop(self, r):
        rid = r["id"]
        interval = r.get("action_config", {}).get("interval_seconds", 60.0)
        save_path = os.path.expanduser(r.get("action_config", {}).get("save_path", "~/Desktop/"))
        prefix = r.get("action_config", {}).get("filename_prefix", "region")
        max_files = r.get("action_config", {}).get("max_files", 100)
        label = r.get("label", "?")
        rect = (r["x"], r["y"], r["width"], r["height"])
        os.makedirs(save_path, exist_ok=True)
        while not _REGION_ACTION_STOP.get(rid, True):
            try:
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = f"{prefix}_{label}_{ts}.png"
                filepath = os.path.join(save_path, filename)
                self._capture_screenshot(rect, filepath)
                existing = sorted([f for f in os.listdir(save_path)
                                   if f.startswith(f"{prefix}_{label}_") and f.endswith(".png")])
                while len(existing) > max_files:
                    try:
                        os.unlink(os.path.join(save_path, existing[0]))
                        existing.pop(0)
                    except Exception:
                        break
            except Exception:
                pass
            time.sleep(interval)

    def _capture_screenshot(self, rect, filepath):
        x, y, w, h = rect
        try:
            tmp = "/tmp/_rm_screenshot.png"
            subprocess.run(["screencapture", "-R", f"{x},{y},{w},{h}", "-x", tmp],
                           timeout=5, capture_output=True)
            if os.path.exists(tmp):
                if filepath.endswith(".png"):
                    shutil.move(tmp, filepath)
                else:
                    shutil.copy2(tmp, filepath)
                    os.unlink(tmp)
                return filepath
        except Exception:
            pass
        return None


class RegionManagerApp(rumps.App):
    PENDING_ADD_SIMPLE = "add_simple"
    PENDING_ADD_DRAG = "add_drag"
    PENDING_REBUILD = "rebuild"
    PENDING_DETAIL = "detail"
    PENDING_SHOW_DIALOG = "show_dialog"

    def __init__(self):
        super().__init__("屏幕位置", quit_button=None)
        self._rm = RegionManager()
        self._edit_mode = False
        self._screens = get_all_screens()
        self._op_queue = queue.Queue()
        self._editor_process = None
        self._drag_pending = False
        self._drag_done = threading.Event()
        self._drag_methods = [
            "canvas", "window", "bind_all", "motion", "poll",
            "nsevent_global", "nsevent_local", "cgevent_poll",
            "grab_global", "focus_poll",
        ]
        self._drag_method_index = 0

        if HAS_APPKIT:
            try:
                NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
            except Exception:
                pass

        if TK_AVAILABLE:
            get_tk_root()

        self._rm.load_all()
        self._build_menu()

    def _build_menu(self):
        self.menu.clear()

        screen_count = len(self._screens)
        screen_info = f"显示器: {screen_count} 台"
        if screen_count == 1:
            screen_info += f" ({self._screens[0]['width']}x{self._screens[0]['height']})"
        self.menu.add(rumps.MenuItem(screen_info))

        regions = load_regions()
        active_count = len([r for r in regions if r.get("enabled", True)])
        self.menu.add(rumps.MenuItem(f"区域: {active_count}/{len(regions)} 个"))
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("➕ 新建区域", callback=self._cb_new_region))
        self.menu.add(rumps.MenuItem("✏️ 拖拽创建区域", callback=self._cb_drag_create))
        self.menu.add(rumps.separator)

        if regions:
            self.menu.add(rumps.MenuItem("── 区域列表 ──"))
            for r in regions:
                enabled = r.get("enabled", True)
                status = "✅" if enabled else "❌"
                at = r.get("action_type", "click")
                at_name = dict(zip(ACTION_TYPES, ACTION_NAMES)).get(at, at)
                label = r.get("label", "?")
                self.menu.add(rumps.MenuItem(
                    f"   {status} #{label} [{at_name}]",
                    callback=lambda _, rid=r["id"]: self._cb_region_detail(rid)
                ))
            self.menu.add(rumps.separator)

        edit_label = "🔧 编辑模式: 开" if self._edit_mode else "🔧 编辑模式: 关"
        self.menu.add(rumps.MenuItem(edit_label, callback=self._cb_toggle_edit_mode))
        self.menu.add(rumps.MenuItem("🔬 高级编辑器", callback=self._cb_launch_editor))
        self.menu.add(rumps.MenuItem("👁️ 显示全部区域", callback=self._cb_show_all))
        self.menu.add(rumps.MenuItem("🙈 隐藏全部区域", callback=self._cb_hide_all))
        self.menu.add(rumps.MenuItem("💣 删除全部区域", callback=self._cb_delete_all))
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem("📤 导出配置...", callback=self._cb_export_config))
        self.menu.add(rumps.MenuItem("📥 导入配置...", callback=self._cb_import_config))
        self.menu.add(rumps.separator)

        self.menu.add(rumps.MenuItem(VERSION))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("🚪 退出", callback=self._cb_quit_app))

    def _cb_new_region(self, _):
        x, y = get_mouse_position()
        label = show_text_input_sync("新建区域", f"位置: ({x}, {y})",
                                     f"区域{len(load_regions())+1}")
        if label:
            self._op_queue.put((self.PENDING_ADD_SIMPLE, (x, y, 120, 40, label)))

    def _cb_drag_create(self, _):
        if not self._ensure_editor_script_exists():
            return
        if self._drag_pending:
            _log("_cb_drag_create: already pending, skip")
            return
        method = self._drag_methods[self._drag_method_index]
        self._drag_method_index = (self._drag_method_index + 1) % len(self._drag_methods)
        next_method = self._drag_methods[self._drag_method_index]
        show_notification("Region Manager", f"Drag: [{method}] (next: {next_method})")
        self._drag_pending = True
        self._drag_done.clear()
        _log(f"_cb_drag_create: launching editor with method={method}")
        threading.Thread(target=self._run_drag_subprocess, args=(method,), daemon=True).start()

    def _ensure_editor_script_exists(self):
        if not os.path.exists(EDITOR_SCRIPT):
            show_notification("Error", f"Editor script not found: {EDITOR_SCRIPT}")
            return False
        return True

    def _run_drag_subprocess(self, method="canvas"):
        _log(f"_run_drag_subprocess: launching editor --create method={method}")
        env = os.environ.copy()
        env["DRAG_METHOD"] = method
        py_exe = _find_tk_python()
        try:
            proc = subprocess.run(
                [py_exe, EDITOR_SCRIPT, "--create"],
                capture_output=True, text=True, timeout=120,
                env=env
            )
            out = proc.stdout.strip()
            _log(f"_run_drag_subprocess: stdout={out}")
            if out and out != "null":
                result = json.loads(out)
                x, y, w, h = result["x"], result["y"], result["w"], result["h"]
                _log(f"_run_drag_subprocess: valid region=({x},{y}) {w}x{h}")
                label = show_text_input_sync("New Region", f"Size: {w}x{h} Pos: ({x},{y})",
                                             f"region{len(load_regions())+1}")
                if label:
                    self._op_queue.put((self.PENDING_ADD_SIMPLE, (x, y, w, h, label)))
            else:
                _log("_run_drag_subprocess: cancelled or no result")
        except subprocess.TimeoutExpired:
            _log("_run_drag_subprocess: timeout")
        except json.JSONDecodeError:
            _log("_run_drag_subprocess: invalid JSON")
        except Exception as e:
            _log(f"_run_drag_subprocess: error: {e}")
        self._drag_done.set()
        self._drag_pending = False

    def _cb_region_detail(self, rid):
        self._do_region_detail(rid)

    def _do_region_detail(self, rid):
        regions = load_regions()
        r = next((r for r in regions if r["id"] == rid), None)
        if not r:
            return
        label = r.get("label", "?")
        at = r.get("action_type", "click")
        at_name = dict(zip(ACTION_TYPES, ACTION_NAMES)).get(at, at)
        enabled = r.get("enabled", True)
        screen_idx = get_region_screen(r, self._screens)
        screen_name = self._screens[screen_idx]["name"] if 0 <= screen_idx < len(self._screens) else "未知"

        msg = f"名称: {label}\n"
        msg += f"位置: ({r['x']}, {r['y']})\n"
        msg += f"大小: {r['width']}x{r['height']}\n"
        msg += f"操作: {at_name}\n"
        msg += f"状态: {'启用' if enabled else '禁用'}\n"
        msg += f"显示器: {screen_name}\n"
        if at == "click":
            msg += f"间隔: {r.get('action_config',{}).get('interval_seconds',3)} 秒"

        btn = show_dialog_sync(f"区域 #{label}", msg,
                               ["切换状态", "修改操作", "修改颜色", "修改间隔", "重命名", "删除", "关闭"])
        if btn == "切换状态":
            self._rm.toggle_region(rid)
            self._build_menu()
            show_notification("区域管理器", f"{label}: {'启用' if not enabled else '禁用'}")
        elif btn == "修改操作":
            sel = show_dialog_sync(f"修改操作 - {label}", "选择操作类型:",
                                   ACTION_NAMES + ["取消"])
            if sel and sel != "取消":
                idx = ACTION_NAMES.index(sel) if sel in ACTION_NAMES else -1
                if idx >= 0:
                    new_at = ACTION_TYPES[idx]
                    update_region_action(rid, new_at)
                    if rid in self._rm.overlays:
                        o = self._rm.overlays[rid]
                        o.cfg["action_type"] = new_at
                        o._draw_everything(o.cfg["width"], o.cfg["height"],
                                           o.cfg.get("color", "#FF4444"), o.cfg.get("label", "?"))
                        if self._edit_mode:
                            o._bind_edit()
                    self._build_menu()
                    show_notification("区域管理器", f"{label}: {sel}")
        elif btn == "修改颜色":
            sel = show_dialog_sync(f"修改颜色 - {label}", "选择颜色:",
                                   COLOR_NAMES + ["取消"])
            if sel and sel != "取消":
                idx_c = COLOR_NAMES.index(sel) if sel in COLOR_NAMES else -1
                if idx_c >= 0:
                    new_color = REGION_COLORS[idx_c]
                    update_region_color(rid, new_color)
                    if rid in self._rm.overlays:
                        o = self._rm.overlays[rid]
                        o.cfg["color"] = new_color
                        o._draw_everything(o.cfg["width"], o.cfg["height"],
                                           new_color, o.cfg.get("label", "?"))
                        if self._edit_mode:
                            o._bind_edit()
                    self._build_menu()
                    show_notification("区域管理器", f"{label}: {sel}")
        elif btn == "修改间隔":
            sel = show_dialog_sync(f"修改间隔 - {label}", "选择间隔时间:",
                                   [f"{iv} 秒" for iv in INTERVALS] + ["取消"])
            if sel and sel != "取消":
                iv = int(sel.replace(" 秒", ""))
                update_region_interval(rid, iv)
                if rid in self._rm.overlays:
                    if "action_config" not in self._rm.overlays[rid].cfg:
                        self._rm.overlays[rid].cfg["action_config"] = {}
                    self._rm.overlays[rid].cfg["action_config"]["interval_seconds"] = iv
                self._build_menu()
                show_notification("区域管理器", f"{label}: {iv} 秒")
        elif btn == "重命名":
            new_name = show_text_input_sync("重命名", f"区域 #{label} 的新名称:", label)
            if new_name:
                update_region_label(rid, new_name)
                if rid in self._rm.overlays:
                    o = self._rm.overlays[rid]
                    o.cfg["label"] = new_name
                    o._draw_everything(o.cfg["width"], o.cfg["height"],
                                       o.cfg.get("color", "#FF4444"), new_name)
                    if self._edit_mode:
                        o._bind_edit()
                self._build_menu()
                show_notification("区域管理器", f"已重命名为: {new_name}")
        elif btn == "删除":
            self._rm.stop_action_loops()
            self._rm.remove_region(rid)
            self._build_menu()
            show_notification("区域管理器", f"已删除: {label}")

    def _cb_toggle_edit_mode(self, _):
        self._edit_mode = not self._edit_mode
        self._rm.set_edit_mode(self._edit_mode)
        self._build_menu()
        show_notification("区域管理器", f"编辑模式: {'开启' if self._edit_mode else '关闭'}")

    def _cb_launch_editor(self, _):
        if not self._ensure_editor_script_exists():
            return
        py_exe = _find_tk_python()
        show_notification("区域管理器", "启动高级编辑器...")
        try:
            subprocess.Popen([py_exe, EDITOR_SCRIPT, "--edit"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            _log(f"_cb_launch_editor: error: {e}")
            show_notification("错误", f"无法启动编辑器: {e}")

    def _cb_show_all(self, _):
        regions = load_regions()
        to_show = [r for r in regions if not r.get("enabled", True)]
        for r in to_show:
            r["enabled"] = True
        save_regions(regions)
        self._rm.load_all()
        self._build_menu()
        show_notification("区域管理器", f"已显示 {len(to_show)} 个区域")

    def _cb_hide_all(self, _):
        self._rm.stop_action_loops()
        self._rm.destroy_all()
        regions = load_regions()
        for r in regions:
            r["enabled"] = False
        save_regions(regions)
        self._build_menu()
        show_notification("区域管理器", "已隐藏全部区域")

    def _cb_delete_all(self, _):
        btn = show_dialog_sync("确认删除", "确定要删除全部区域吗？此操作不可恢复。",
                               ["取消", "确定删除"])
        if btn == "确定删除":
            self._rm.stop_action_loops()
            self._rm.destroy_all()
            save_regions([])
            self._build_menu()
            show_notification("区域管理器", "已删除全部区域")

    def _cb_export_config(self, _):
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_path = os.path.expanduser(f"~/Desktop/screen_regions_{ts}.json")
        path = show_text_input_sync("导出配置", "保存路径:", default_path)
        if path:
            try:
                regions = load_regions()
                data = {"version": "1.0", "updated_at": datetime.now().isoformat(), "regions": regions}
                with open(path, "w") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                show_notification("区域管理器", f"配置已导出到: {path}")
            except Exception as e:
                show_notification("错误", f"导出失败: {e}")

    def _cb_import_config(self, _):
        path = show_text_input_sync("导入配置", "输入配置文件路径:", "")
        if path and os.path.exists(path):
            try:
                with open(path, "r") as f:
                    data = json.load(f)
                new_regions = data if isinstance(data, list) else data.get("regions", [])
                existing = load_regions()
                existing_ids = {r["id"] for r in existing}
                added = 0
                for r in new_regions:
                    if r["id"] not in existing_ids:
                        existing.append(r)
                        added += 1
                save_regions(existing)
                self._rm.load_all()
                self._build_menu()
                show_notification("区域管理器", f"已导入 {added} 个区域")
            except Exception as e:
                show_notification("错误", f"导入失败: {e}")
        elif path:
            show_notification("错误", f"文件不存在: {path}")

    def _cb_quit_app(self, _):
        self._rm.stop_action_loops()
        self._rm.destroy_all()
        if HAS_APPKIT:
            try:
                NSApp.terminate_(None)
            except Exception:
                pass
        else:
            rumps.quit_application()

    @rumps.timer(0.3)
    def _main_loop(self, _):
        try:
            while True:
                op_type, args = self._op_queue.get_nowait()
                if op_type == self.PENDING_ADD_SIMPLE:
                    if len(args) == 5:
                        x, y, w, h, label = args
                    else:
                        x, y, label = args
                        w, h = 120, 40
                    self._rm.add_region(x, y, w, h, label)
                    self._build_menu()
                    show_notification("区域管理器", f"已创建: {label} ({w}x{h})")
        except queue.Empty:
            pass


if __name__ == "__main__":
    app = RegionManagerApp()
    app.run()