"""Auto Clicker v1.4.0 - Screen Position Specifier: drag-to-create wireframe overlays with multi-action support"""
VERSION = "v1.4.0"

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
REGIONS_FILE = os.path.expanduser("~/.auto_clicker_regions.json")
SCREENSHOT_DIR = os.path.expanduser("~/Desktop/AutoClicker_Screenshots")

CHECK_INTERVAL = 3
OSASCRIPT_TIMEOUT = 8
COOLDOWN_SECONDS = 5
POS_COOLDOWN_SECONDS = 3
MAX_HISTORY = 500
STATUS_WINDOW_REFRESH = 2
INDICATOR_DURATION = 0.5
REGION_MIN_WIDTH = 30
REGION_MIN_HEIGHT = 20

CLICK_HISTORY = {}
LIVE_STATUS = {
    "running": False, "last_scan": "", "last_status": "idle",
    "last_results": [], "total_clicks": 0, "dry_run": True,
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

REGION_COLORS = ["#FF4444", "#4488FF", "#44CC44", "#FF8800", "#AA44FF", "#888888"]

TK_AVAILABLE = False
try:
    import tkinter as tk
    TK_AVAILABLE = True
except ImportError:
    pass

HAS_OCR = False
try:
    import pytesseract
    HAS_OCR = True
except ImportError:
    pass

_REGION_ACTION_LOOPS = {}
_REGION_ACTION_STOP = {}

# ===========================================================================
# Region config persistence
# ===========================================================================

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
        data = {
            "version": "1.0",
            "updated_at": datetime.now().isoformat(),
            "regions": regions,
        }
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
        "id": rid,
        "label": label,
        "x": x, "y": y,
        "width": max(width, REGION_MIN_WIDTH),
        "height": max(height, REGION_MIN_HEIGHT),
        "color": color,
        "enabled": True,
        "action_type": action_type,
        "action_config": {
            "interval_seconds": 3.0,
            "click_mode": "center",
            "click_offset_x": 0,
            "click_offset_y": 0,
            "double_click": False,
        } if action_type == "click" else {},
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

def update_region_click_interval(rid, interval):
    regions = load_regions()
    for r in regions:
        if r["id"] == rid:
            if "action_config" not in r:
                r["action_config"] = {}
            r["action_config"]["interval_seconds"] = interval
    save_regions(regions)
    return regions

# ===========================================================================
# Drag-to-create overlay (fullscreen transparent window for region drawing)
# ===========================================================================

class DragCreateOverlay:
    def __init__(self, on_create=None):
        if not TK_AVAILABLE:
            raise RuntimeError("tkinter not available")
        self.on_create = on_create
        self.root = None
        self.canvas = None
        self.start_x = 0
        self.start_y = 0
        self.rect_id = None
        self._result = None
        self._create_window()

    def _create_window(self):
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.35)
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        self.root.geometry(f"{screen_w}x{screen_h}+0+0")
        self.root.configure(bg="black")

        self.canvas = tk.Canvas(
            self.root, width=screen_w, height=screen_h,
            bg="black", highlightthickness=0,
            cursor="crosshair",
        )
        self.canvas.pack(fill="both", expand=True)

        hint = "Drag to draw a region. Press Escape to cancel."
        self.canvas.create_text(
            screen_w // 2, 30, text=hint,
            fill="#AAAAAA", font=("Helvetica", 14, "bold"),
            tags="hint",
        )

        self.canvas.bind("<Button-1>", self._on_press)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.root.bind("<Escape>", lambda e: self._cancel())

        self.root.mainloop()

    def _on_press(self, event):
        self.start_x = event.x
        self.start_y = event.y
        if self.rect_id:
            self.canvas.delete(self.rect_id)
        self.rect_id = self.canvas.create_rectangle(
            self.start_x, self.start_y, self.start_x, self.start_y,
            outline="#FF4444", width=3, dash=(6, 3),
            tags="drag_rect",
        )

    def _on_drag(self, event):
        if self.rect_id:
            self.canvas.coords(self.rect_id, self.start_x, self.start_y, event.x, event.y)

    def _on_release(self, event):
        x1, y1 = min(self.start_x, event.x), min(self.start_y, event.y)
        x2, y2 = max(self.start_x, event.x), max(self.start_y, event.y)
        w, h = x2 - x1, y2 - y1
        if w < REGION_MIN_WIDTH or h < REGION_MIN_HEIGHT:
            return
        self._result = (x1, y1, w, h)
        self.root.quit()
        self.root.destroy()

    def _cancel(self):
        self._result = None
        self.root.quit()
        self.root.destroy()

    def get_result(self):
        return self._result


# ===========================================================================
# Region overlay windows (Tkinter)
# ===========================================================================

class RegionOverlay:
    def __init__(self, region_cfg, region_index, edit_mode=False, on_delete=None):
        if not TK_AVAILABLE:
            raise RuntimeError("tkinter not available")
        self.cfg = region_cfg
        self.index = region_index
        self.edit_mode = edit_mode
        self.on_delete = on_delete
        self.root = None
        self.canvas = None
        self._drag_x = 0
        self._drag_y = 0
        self._context_menu = None
        self._create_window()

    def _create_window(self):
        c = self.cfg
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        if self.edit_mode:
            self.root.attributes("-alpha", 0.90)
        else:
            self.root.attributes("-alpha", 0.70)
        self.root.geometry(f"{c['width']}x{c['height']}+{c['x']}+{c['y']}")
        self.root.configure(bg="systemTransparent")

        color = c.get("color", "#FF4444")
        label = c.get("label", "?")
        w, h = c["width"], c["height"]

        self.canvas = tk.Canvas(
            self.root, width=w, height=h,
            bg="systemTransparent", highlightthickness=0,
            cursor="crosshair" if self.edit_mode else "none",
        )
        self.canvas.pack(fill="both", expand=True)

        self._draw_everything(w, h, color, label)

        if self.edit_mode:
            self._bind_edit()
        self._bind_context_menu()

        self.canvas.bind("<Enter>", lambda e: self._on_hover(True))
        self.canvas.bind("<Leave>", lambda e: self._on_hover(False))

    def _draw_everything(self, w, h, color, label):
        self.canvas.delete("all")

        self.canvas.create_rectangle(0, 0, w, h, outline=color, width=2, tags="border")

        tag_height = 24
        tag_width = max(len(label) * 9 + 50, 70)
        self.canvas.create_rectangle(0, 0, tag_width, tag_height, fill=color, outline="", tags="label_bg")
        num_label = f"#{self.index} {label}"
        self.canvas.create_text(10, tag_height // 2, text=num_label, anchor="w",
                                fill="#FFFFFF", font=("Helvetica", 10, "bold"), tags="label_text")

        cx = tag_width - 12
        cy = tag_height // 2
        self.canvas.create_oval(cx - 6, cy - 6, cx + 6, cy + 6,
                                fill="#CC0000", outline="#990000", tags="close_btn")
        self.canvas.create_text(cx, cy, text="x", fill="#FFFFFF",
                                font=("Helvetica", 10, "bold"), tags="close_btn")
        if self.edit_mode:
            self.canvas.tag_bind("close_btn", "<Button-1>", lambda e: self._close_clicked())

        cross_color = self._hex_to_rgb_fade(color, 0.25)
        self.canvas.create_line(w // 2, 0, w // 2, h, fill=cross_color, width=1, tags="cross")
        self.canvas.create_line(0, h // 2, w, h // 2, fill=cross_color, width=1, tags="cross")

        rh_size = 16
        handle_color = "#3388FF" if self.edit_mode else "#666666"
        self.canvas.create_rectangle(w - rh_size, h - rh_size, w, h,
                                     fill=handle_color, outline="",
                                     tags="resize_handle")
        self.canvas.create_line(w - rh_size + 5, h - 5, w - 5, h - rh_size + 5,
                                fill="#FFFFFF", width=2, tags="resize_handle")

        action_label = f"[{self.cfg.get('action_type', 'click')}]"
        self.canvas.create_text(w // 2, h - 8, text=action_label,
                                fill=color, font=("Helvetica", 8, "bold"), tags="action_label")

    @staticmethod
    def _hex_to_rgb_fade(hex_color, alpha):
        hex_color = hex_color.lstrip("#")
        if len(hex_color) == 6:
            r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
            r2 = int(r * alpha + 255 * (1 - alpha))
            g2 = int(g * alpha + 255 * (1 - alpha))
            b2 = int(b * alpha + 255 * (1 - alpha))
            return f"#{r2:02x}{g2:02x}{b2:02x}"
        return hex_color

    def _on_hover(self, entering):
        if not self.edit_mode:
            return
        try:
            if entering:
                self.root.attributes("-alpha", 0.95)
            else:
                self.root.attributes("-alpha", 0.85)
        except Exception:
            pass

    def _bind_edit(self):
        for tag in ("border", "label_bg", "label_text", "cross", "action_label"):
            self.canvas.tag_bind(tag, "<Button-1>", self._start_drag)
            self.canvas.tag_bind(tag, "<B1-Motion>", self._do_drag)
        self.canvas.tag_bind("resize_handle", "<Button-1>", self._start_resize)
        self.canvas.tag_bind("resize_handle", "<B1-Motion>", self._do_resize)
        self.canvas.tag_bind("close_btn", "<Button-1>", lambda e: self._close_clicked())

    def _unbind_edit(self):
        for tag in ("border", "label_bg", "label_text", "cross", "action_label", "resize_handle", "close_btn"):
            self.canvas.tag_unbind(tag, "<Button-1>")
            self.canvas.tag_unbind(tag, "<B1-Motion>")

    def _bind_context_menu(self):
        def show_menu(event):
            if not self.edit_mode:
                return
            menu = tk.Menu(self.root, tearoff=0)
            menu.add_command(label="Delete Region",
                             command=lambda: self._close_clicked())
            colors_menu = tk.Menu(menu, tearoff=0)
            for clr in REGION_COLORS:
                colors_menu.add_command(
                    label=f"  {clr}",
                    command=lambda c=clr: self._change_color(c),
                    background=clr,
                    foreground="#FFFFFF" if clr != "#FF8800" else "#000000",
                )
            menu.add_cascade(label="Change Color", menu=colors_menu)
            menu.add_separator()
            actions = ["click", "ocr", "scroll", "screenshot", "none"]
            cur_action = self.cfg.get("action_type", "click")
            action_menu = tk.Menu(menu, tearoff=0)
            for act in actions:
                check = "v" if act == cur_action else " "
                action_menu.add_command(
                    label=f"[{check}] {act}",
                    command=lambda a=act: self._change_action(a),
                )
            menu.add_cascade(label="Action Type", menu=action_menu)
            menu.add_separator()
            intervals = [1, 2, 3, 5, 10, 30, 60]
            cur_interval = self.cfg.get("action_config", {}).get("interval_seconds", 3)
            interval_menu = tk.Menu(menu, tearoff=0)
            for iv in intervals:
                check = "v" if iv == cur_interval else " "
                interval_menu.add_command(
                    label=f"[{check}] {iv}s",
                    command=lambda i=iv: self._change_interval(i),
                )
            menu.add_cascade(label="Interval", menu=interval_menu)
            try:
                menu.tk_popup(event.x_root, event.y_root)
            finally:
                menu.grab_release()
        self.canvas.bind("<Button-2>", show_menu)
        self.canvas.bind("<Control-Button-1>", show_menu)

    def _close_clicked(self):
        if self.on_delete:
            self.on_delete(self.cfg["id"])
        self.destroy()

    def _change_color(self, color):
        self.cfg["color"] = color
        update_region_color(self.cfg["id"], color)
        self._draw_everything(self.cfg["width"], self.cfg["height"], color, self.cfg.get("label", "?"))
        if self.edit_mode:
            self._bind_edit()

    def _change_action(self, action_type):
        self.cfg["action_type"] = action_type
        update_region_action(self.cfg["id"], action_type)
        self._draw_everything(self.cfg["width"], self.cfg["height"],
                              self.cfg.get("color", "#FF4444"), self.cfg.get("label", "?"))
        if self.edit_mode:
            self._bind_edit()

    def _change_interval(self, interval):
        if "action_config" not in self.cfg:
            self.cfg["action_config"] = {}
        self.cfg["action_config"]["interval_seconds"] = interval
        update_region_click_interval(self.cfg["id"], interval)

    def _start_drag(self, event):
        self._drag_x = event.x
        self._drag_y = event.y

    def _do_drag(self, event):
        dx = event.x - self._drag_x
        dy = event.y - self._drag_y
        nx = max(0, self.root.winfo_x() + dx)
        ny = max(0, self.root.winfo_y() + dy)
        self.root.geometry(f"+{nx}+{ny}")
        self.cfg["x"] = nx
        self.cfg["y"] = ny
        self._save_position()

    def _start_resize(self, event):
        self._drag_x = event.x
        self._drag_y = event.y

    def _do_resize(self, event):
        nw = max(REGION_MIN_WIDTH, self.cfg["width"] + event.x - self._drag_x)
        nh = max(REGION_MIN_HEIGHT, self.cfg["height"] + event.y - self._drag_y)
        self.cfg["width"] = nw
        self.cfg["height"] = nh
        self._drag_x = event.x
        self._drag_y = event.y
        self.root.geometry(f"{nw}x{nh}")
        self._draw_everything(nw, nh, self.cfg.get("color", "#FF4444"), self.cfg.get("label", "?"))
        if self.edit_mode:
            self._bind_edit()
        self._save_position()

    def _save_position(self):
        regions = load_regions()
        for r in regions:
            if r["id"] == self.cfg["id"]:
                r["x"] = self.cfg["x"]
                r["y"] = self.cfg["y"]
                r["width"] = self.cfg["width"]
                r["height"] = self.cfg["height"]
                break
        save_regions(regions)

    def set_edit_mode(self, edit_mode):
        self.edit_mode = edit_mode
        w, h = self.cfg["width"], self.cfg["height"]
        color = self.cfg.get("color", "#FF4444")
        label = self.cfg.get("label", "?")
        if edit_mode:
            self._unbind_edit()
        self._draw_everything(w, h, color, label)
        if edit_mode:
            self.root.attributes("-alpha", 0.90)
            self._bind_edit()
        else:
            self.root.attributes("-alpha", 0.70)
        self.root.lift()

    def update_label(self, index):
        self.index = index
        self._draw_everything(self.cfg["width"], self.cfg["height"],
                              self.cfg.get("color", "#FF4444"), self.cfg.get("label", "?"))
        if self.edit_mode:
            self._bind_edit()

    def destroy(self):
        if self.root:
            try:
                self.root.destroy()
            except Exception:
                pass
            self.root = None

    def get_click_center(self):
        offset_x = self.cfg.get("action_config", {}).get("click_offset_x", 0)
        offset_y = self.cfg.get("action_config", {}).get("click_offset_y", 0)
        return (self.cfg["x"] + self.cfg["width"] // 2 + offset_x,
                self.cfg["y"] + self.cfg["height"] // 2 + offset_y)


class RegionManager:
    def __init__(self):
        self.overlays = {}
        self._edit_mode = False

    def _get_next_index(self):
        existing = list(self.overlays.keys())
        regions = load_regions()
        all_ids = [r["id"] for r in regions]
        used_indices = set()
        for rid in all_ids:
            if rid in self.overlays:
                used_indices.add(list(self.overlays.keys()).index(rid) + 1)
        idx = 1
        while idx in used_indices:
            idx += 1
        return idx

    def _renumber_all(self):
        sorted_ids = sorted(self.overlays.keys(), key=lambda rid: (
            self.overlays[rid].cfg["y"], self.overlays[rid].cfg["x"]
        ))
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
                    overlay = RegionOverlay(
                        r, idx, self._edit_mode,
                        on_delete=lambda rid=r["id"]: self.remove_region(rid)
                    )
                    self.overlays[r["id"]] = overlay
                    idx += 1
                except RuntimeError:
                    pass

    def add_region(self, x, y, width, height, label, color="#FF4444", action_type="click"):
        region = add_region_config(x, y, width, height, label, color, action_type)
        idx = len(self.overlays) + 1
        try:
            overlay = RegionOverlay(
                region, idx, self._edit_mode,
                on_delete=lambda rid=region["id"]: self.remove_region(rid)
            )
            self.overlays[region["id"]] = overlay
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
                overlay = RegionOverlay(
                    r, idx, self._edit_mode,
                    on_delete=lambda: self.remove_region(rid)
                )
                self.overlays[rid] = overlay
            except RuntimeError:
                pass
        elif not r.get("enabled", True) and rid in self.overlays:
            self.overlays[rid].destroy()
            del self.overlays[rid]
            self._renumber_all()

    def set_edit_mode(self, edit_mode):
        self._edit_mode = edit_mode
        for o in list(self.overlays.values()):
            try:
                if o.root and o.root.winfo_exists():
                    o.set_edit_mode(edit_mode)
            except Exception:
                pass

    def destroy_all(self):
        for o in list(self.overlays.values()):
            o.destroy()
        self.overlays.clear()

    def get_click_positions(self):
        positions = []
        regions = load_regions()
        for r in regions:
            if not r.get("enabled", True):
                continue
            if r.get("action_type") != "click":
                continue
            rid = r["id"]
            if rid in self.overlays:
                cx, cy = self.overlays[rid].get_click_center()
            else:
                ox = r.get("action_config", {}).get("click_offset_x", 0)
                oy = r.get("action_config", {}).get("click_offset_y", 0)
                cx = r["x"] + r["width"] // 2 + ox
                cy = r["y"] + r["height"] // 2 + oy
            positions.append({
                "id": rid, "x": cx, "y": cy, "label": r.get("label", "?"),
                "action_type": "click",
                "action_config": r.get("action_config", {}),
            })
        return positions

    def get_active_regions(self):
        regions = load_regions()
        return [r for r in regions if r.get("enabled", True)]

    def process_region_clicks(self, cfg, dry_run, click_fn):
        positions = self.get_click_positions()
        clicked = 0
        pc = cfg.get("pos_cooldown_seconds", POS_COOLDOWN_SECONDS)
        for p in positions:
            key = f"region:{p['label']}"
            now = time.time()
            if now - _POS_CLICK_LAST.get(key, 0) < pc:
                continue
            _POS_CLICK_LAST[key] = now
            interval = p.get("action_config", {}).get("interval_seconds", 3.0)
            if now - _POS_CLICK_LAST.get(key, 0) < interval:
                continue
            _POS_CLICK_LAST[key] = now
            if dry_run:
                print(f"  [region] DRY-RUN: {p['label']} @ ({p['x']},{p['y']})")
                record_click("region", p["label"], "", was_dry_run=True)
                clicked += 1
            else:
                try:
                    double = p.get("action_config", {}).get("double_click", False)
                    print(f"  [region] CLICKED: {p['label']} @ ({p['x']},{p['y']})")
                    click_fn(p["x"], p["y"])
                    if double:
                        time.sleep(0.05)
                        click_fn(p["x"], p["y"])
                    record_click("region", p["label"], "", was_dry_run=False)
                    clicked += 1
                except Exception as e:
                    print(f"  [region] FAILED: {p['label']}: {e}")
        return clicked

    def start_action_loops(self, cfg, dry_run, click_fn):
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
                t = threading.Thread(target=self._click_loop, args=(r, cfg, dry_run, click_fn), daemon=True)
            elif at == "ocr":
                t = threading.Thread(target=self._ocr_loop, args=(r, cfg), daemon=True)
            elif at == "scroll":
                t = threading.Thread(target=self._scroll_loop, args=(r, cfg), daemon=True)
            elif at == "screenshot":
                t = threading.Thread(target=self._screenshot_loop, args=(r, cfg), daemon=True)
            else:
                continue
            _REGION_ACTION_LOOPS[rid] = t
            t.start()

    def stop_action_loops(self):
        for rid in _REGION_ACTION_STOP:
            _REGION_ACTION_STOP[rid] = True

    def _click_loop(self, r, cfg, dry_run, click_fn):
        rid = r["id"]
        ax = r["x"] + r["width"] // 2 + r.get("action_config", {}).get("click_offset_x", 0)
        ay = r["y"] + r["height"] // 2 + r.get("action_config", {}).get("click_offset_y", 0)
        interval = r.get("action_config", {}).get("interval_seconds", 3.0)
        double = r.get("action_config", {}).get("double_click", False)
        label = r.get("label", "?")
        while not _REGION_ACTION_STOP.get(rid, True):
            if dry_run:
                print(f"  [{label}] DRY-RUN click @ ({ax},{ay})")
                record_click("region", label, "", was_dry_run=True)
            else:
                try:
                    click_fn(ax, ay)
                    if double:
                        time.sleep(0.05)
                        click_fn(ax, ay)
                    record_click("region", label, "", was_dry_run=False)
                    print(f"  [{label}] Clicked @ ({ax},{ay})")
                except Exception as e:
                    print(f"  [{label}] Click error: {e}")
            time.sleep(interval)

    def _ocr_loop(self, r, cfg):
        if not HAS_OCR:
            print(f"  [OCR] pytesseract not available, install: pip install pytesseract")
            return
        rid = r["id"]
        interval = r.get("action_config", {}).get("interval_seconds", 5.0)
        watch_text = r.get("action_config", {}).get("watch_text", "").lower()
        label = r.get("label", "?")
        rect = (r["x"], r["y"], r["width"], r["height"])
        last_text = ""
        while not _REGION_ACTION_STOP.get(rid, True):
            try:
                img_path = self._capture_region_screenshot(rect, f"_ocr_{rid}")
                if img_path and os.path.exists(img_path):
                    img = Image.open(img_path)
                    text = pytesseract.image_to_string(img, lang="chi_sim+eng").strip()
                    if text and text != last_text:
                        last_text = text
                        ts = datetime.now().strftime("%H:%M:%S")
                        print(f"  [{label}] OCR [{ts}]: {text[:100]}")
                        if watch_text and watch_text in text.lower():
                            show_notification(f"Region [{label}]", f"Matched: {watch_text}")
                        if r.get("action_config", {}).get("notify_on_change"):
                            show_notification(f"Region [{label}]", f"Text: {text[:80]}")
                    try:
                        os.unlink(img_path)
                    except Exception:
                        pass
            except Exception as e:
                print(f"  [{label}] OCR error: {e}")
            time.sleep(interval)

    def _scroll_loop(self, r, cfg):
        rid = r["id"]
        interval = r.get("action_config", {}).get("interval_seconds", 10.0)
        distance = r.get("action_config", {}).get("scroll_distance", 300)
        direction = r.get("action_config", {}).get("direction", "down")
        label = r.get("label", "?")
        cx = r["x"] + r["width"] // 2
        cy = r["y"] + r["height"] // 2
        while not _REGION_ACTION_STOP.get(rid, True):
            try:
                Q = _get_quartz()
                dx, dy = 0, distance if direction == "down" else -distance
                Q.CGEventPost(Q.kCGHIDEventTap, Q.CGEventCreateMouseEvent(None, Q.kCGEventMouseMoved, (cx, cy), 0))
                time.sleep(0.05)
                Q.CGEventPost(Q.kCGHIDEventTap, Q.CGEventCreateScrollWheelEvent(None, Q.kCGScrollEventUnitLine, 1, dy, dx))
                print(f"  [{label}] Scrolled {direction} {distance}px")
            except Exception as e:
                print(f"  [{label}] Scroll error: {e}")
            time.sleep(interval)

    def _screenshot_loop(self, r, cfg):
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
                self._capture_region_screenshot(rect, filepath)
                print(f"  [{label}] Screenshot: {filepath}")
                existing = sorted([
                    f for f in os.listdir(save_path)
                    if f.startswith(f"{prefix}_{label}_") and f.endswith(".png")
                ])
                while len(existing) > max_files:
                    try:
                        os.unlink(os.path.join(save_path, existing[0]))
                        existing.pop(0)
                    except Exception:
                        break
            except Exception as e:
                print(f"  [{label}] Screenshot error: {e}")
            time.sleep(interval)

    def _capture_region_screenshot(self, rect, filepath):
        try:
            from Quartz import CGWindowListCreateImage, CGRectMake, kCGWindowListOptionOnScreenOnly, kCGWindowImageDefault
            x, y, w, h = rect
            region = CGRectMake(x, y, w, h)
            img_ref = CGWindowListCreateImage(region, kCGWindowListOptionOnScreenOnly, 0, kCGWindowImageDefault)
            if img_ref is None:
                return None
            from Quartz import CGImageGetWidth, CGImageGetHeight, CGImageGetDataProvider, CGDataProviderCopyData
            from PIL import Image
            width = CGImageGetWidth(img_ref)
            height = CGImageGetHeight(img_ref)
            provider = CGImageGetDataProvider(img_ref)
            data = CGDataProviderCopyData(provider)
            from Quartz import CGImageGetBitsPerPixel, CGImageGetBytesPerRow
            bpp = CGImageGetBitsPerPixel(img_ref)
            bpr = CGImageGetBytesPerRow(img_ref)
            img = Image.frombytes("RGBA", (width, height), bytes(data), "raw", "BGRA", bpr, 1)
            img.save(filepath, "PNG")
            return filepath
        except ImportError:
            pass
        try:
            tmp = "/tmp/_ac_region_cap.png"
            subprocess.run(["screencapture", "-R", f"{rect[0]},{rect[1]},{rect[2]},{rect[3]}", "-x", tmp],
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

_POS_CLICK_LAST = {}

# ===========================================================================
# CGEvent click engine
# ===========================================================================

def _get_quartz():
    import Quartz
    return Quartz

def click_at(x, y):
    Q = _get_quartz()
    Q.CGEventPost(Q.kCGHIDEventTap, Q.CGEventCreateMouseEvent(None, Q.kCGEventMouseMoved, (x, y), 0))
    time.sleep(0.02)
    Q.CGEventPost(Q.kCGHIDEventTap, Q.CGEventCreateMouseEvent(None, Q.kCGEventLeftMouseDown, (x, y), 0))
    time.sleep(0.02)
    Q.CGEventPost(Q.kCGHIDEventTap, Q.CGEventCreateMouseEvent(None, Q.kCGEventLeftMouseUp, (x, y), 0))

def get_mouse_position():
    Q = _get_quartz()
    pos = Q.CGEventGetLocation(Q.CGEventCreate(None))
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
        canvas = tk.Canvas(root, width=r*2, height=r*2, bg="systemTransparent", highlightthickness=0)
        canvas.pack()
        canvas.create_oval(2, 2, r*2-2, r*2-2, outline="#FF3333", width=3, fill="#FF0000")
        canvas.create_line(r, r-8, r, r+8, fill="#FFFFFF", width=2)
        canvas.create_line(r-8, r, r+8, r, fill="#FFFFFF", width=2)
        root.lift()
        def fade(a=0.8):
            if a <= 0:
                root.destroy()
                return
            root.attributes("-alpha", a)
            root.after(50, lambda: fade(a-0.15))
        root.after(int(INDICATOR_DURATION*1000), fade)
        root.mainloop()
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t

# ===========================================================================
# Positions (legacy single-point)
# ===========================================================================

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
            p["x"] = x; p["y"] = y; p["enabled"] = True
            save_positions(positions)
            return positions
    positions.append({"x": x, "y": y, "label": label, "enabled": True,
                      "added": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
    save_positions(positions)
    return positions

def clear_all_positions():
    save_positions([])

# ===========================================================================
# PID
# ===========================================================================

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

# ===========================================================================
# Config / Log
# ===========================================================================

def load_config():
    defaults = {
        "dry_run": True, "enabled_processes": ["Code", "Electron"],
        "check_interval": 3, "cooldown_seconds": 5,
        "pos_cooldown_seconds": 3, "show_alert_on_click": False,
        "show_alert_on_find": True, "max_clicks_per_minute": 20,
        "verbose": True, "click_texts": CLICK_TEXTS,
        "never_click_texts": NEVER_CLICK_TEXTS,
        "window_filters": [], "capture_screenshots": True,
        "show_status_window": False, "show_indicator": True,
        "pos_enabled": True, "regions_enabled": True,
        "regions_edit_mode": False,
    }
    try:
        with open(CONFIG_FILE, "r") as f:
            saved = json.load(f)
            for k, v in defaults.items():
                if k not in saved:
                    saved[k] = v
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
    log["clicks"].insert(0, {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "process": process_name, "window": window_name,
        "button": button_title, "dry_run": was_dry_run,
    })
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

# ===========================================================================
# AppleScript
# ===========================================================================

def build_scan_script(enabled_processes, click_texts, never_texts, window_filters=None, debug_all=False):
    proc_conditions = [f'name contains "{p}"' for p in enabled_processes]
    proc_filter = " or ".join(proc_conditions)
    if debug_all:
        win_filter = " or ".join([f'wname contains "{wf}"' for wf in window_filters]) if window_filters else ""
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
    win_filter = " or ".join([f'wname contains "{wf}"' for wf in window_filters]) if window_filters else ""
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
                                        set shouldSkip to true; exit repeat
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

def check_accessibility_permission():
    try:
        r = subprocess.run(["osascript", "-e",
            'tell application "System Events"\ntry\ncount of every process\nreturn "OK"\non error errMsg\nreturn "DENIED: " & errMsg\nend try\nend tell'],
            capture_output=True, text=True, timeout=5)
        return ("OK" in r.stdout.strip(), r.stdout.strip())
    except Exception as e:
        return (False, str(e))

def click_button(process_name, button_title):
    try:
        r = subprocess.run(["osascript", "-e",
            f'tell application "System Events"\ntell process "{process_name}"\ntry\nclick (first button of window 1 whose title contains "{button_title}")\nreturn "OK"\non error errMsg\nreturn "FAIL: " & errMsg\nend try\nend tell\nend tell'],
            capture_output=True, text=True, timeout=5)
        return ("OK" in r.stdout.strip(), r.stdout.strip())
    except Exception as e:
        return (False, str(e))

def scan_buttons(enabled_processes, click_texts=None, never_texts=None, window_filters=None, debug_all=False, verbose=False):
    if click_texts is None: click_texts = CLICK_TEXTS
    if never_texts is None: never_texts = NEVER_CLICK_TEXTS
    t0 = time.time()
    try:
        script = build_scan_script(enabled_processes, click_texts, never_texts, window_filters, debug_all)
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=OSASCRIPT_TIMEOUT)
        elapsed = time.time() - t0
        output = r.stdout.strip(); stderr = r.stderr.strip()
        if verbose: print(f"  [scan] took {elapsed:.1f}s", end="")
        if stderr:
            if "not allowed" in stderr.lower():
                return [], "permission_denied", elapsed
            if "not found" not in stderr.lower() and "ok" not in stderr.lower():
                return [], f"error: {stderr[:80]}", elapsed
        if not output:
            if verbose: print(" -> no matches")
            return [], "none", elapsed
        entries = [e.strip() for e in output.split("|||") if e.strip()]
        results = []
        for e in entries:
            parts = e.split("::", 2)
            if len(parts) == 3:
                results.append({"process": parts[0], "window": parts[1], "button": parts[2]})
        if verbose: print(f" -> found {len(results)}")
        return results, "ok", elapsed
    except subprocess.TimeoutExpired:
        elapsed = time.time() - t0
        if verbose: print(f"  [scan] timeout after {elapsed:.1f}s")
        return [], "timeout", elapsed
    except Exception as e:
        elapsed = time.time() - t0
        if verbose: print(f"  [scan] error: {e}")
        return [], f"error: {e}", elapsed

def debug_scan_all(enabled_processes, window_filters=None):
    script = build_scan_script(enabled_processes, CLICK_TEXTS, [], window_filters, debug_all=True)
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=OSASCRIPT_TIMEOUT)
    out = r.stdout.strip()
    if not out: return []
    return [{"process": p[0], "window": p[1], "button": p[2]}
            for e in out.split("|||") if e.strip()
            for p in [e.split("::", 2)] if len(p) == 3]

# ===========================================================================
# Utils
# ===========================================================================

def capture_screenshot(filename=None):
    if filename is None:
        filename = f"screenshot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
    filepath = os.path.join(SCREENSHOT_DIR, filename)
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    try:
        subprocess.run(["screencapture", "-x", filepath], timeout=5, capture_output=True)
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
end tell'''
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)
        procs = []
        for e in r.stdout.strip().split("|||"):
            parts = e.split(":::")
            if len(parts) == 2 and parts[0].strip():
                procs.append({"name": parts[0].strip(), "windows": int(parts[1])})
        return procs
    except Exception:
        return []

def open_accessibility_settings():
    subprocess.run(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"])

def show_notification(title, message):
    try:
        subprocess.run(["osascript", "-e", f'display notification "{message}" with title "{title}"'], timeout=3)
    except Exception:
        pass

def show_dialog_with_list(title, message, items, default_items=None):
    its = ", ".join(f'"{it}"' for it in items)
    dits = ", ".join(f'"{it}"' for it in (default_items or []))
    script = f'''
set allItems to {{{its}}}
set defaultItems to {{{dits}}}
set selectedItems to choose from list allItems with title "{title}" with prompt "{message}" with multiple selections allowed default items defaultItems
if selectedItems is false then return ""
set AppleScript's text item delimiters to "|||"
set outText to selectedItems as text
set AppleScript's text item delimiters to ""
return outText'''
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=30)
        out = r.stdout.strip()
        if not out: return []
        return [x.strip() for x in out.split("|||") if x.strip()]
    except Exception:
        return []

def show_text_input(title, message, default_value=""):
    script = f'''
tell application "System Events"
    set resultText to text returned of (display dialog "{message}" with title "{title}" default answer "{default_value}" buttons {{"Cancel", "Save"}} default button "Save")
    return resultText
end tell'''
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=30)
        out = r.stdout.strip()
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
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([8, 8, size-8, size-8], fill=(200,100,80,255))
    draw.ellipse([30, 30, size-30, size-30], fill=(220,120,100,255))
    cx, cy = size//2, size//2+35
    draw.polygon([(cx, cy+33), (cx-25, cy-16), (cx+25, cy-16)], fill=(255,240,100,255))
    return img

def generate_iconset(icon_path):
    img = generate_icon_png()
    if img is None: return
    iconset_dir = icon_path.replace(".icns", ".iconset")
    os.makedirs(iconset_dir, exist_ok=True)
    for fn, s in {"icon_16x16.png":16,"icon_16x16@2x.png":32,"icon_32x32.png":32,"icon_32x32@2x.png":64,"icon_128x128.png":128,"icon_128x128@2x.png":256,"icon_256x256.png":256,"icon_256x256@2x.png":512,"icon_512x512.png":512,"icon_512x512@2x.png":1024}.items():
        img.resize((s, s), 3).save(os.path.join(iconset_dir, fn))
    subprocess.run(["iconutil", "-c", "icns", "-o", icon_path, iconset_dir], capture_output=True)
    shutil.rmtree(iconset_dir, ignore_errors=True)

def build_standalone():
    sp = os.path.abspath(__file__)
    ad = os.path.expanduser("~/Desktop/AutoClicker.app")
    md = os.path.join(ad, "Contents", "MacOS")
    rd = os.path.join(ad, "Contents", "Resources")
    if os.path.exists(ad): shutil.rmtree(ad)
    os.makedirs(md, exist_ok=True)
    os.makedirs(rd, exist_ok=True)
    lp = os.path.join(md, "AutoClicker")
    with open(lp, "w") as f:
        f.write('#!/bin/bash\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\nRESOURCES="$SCRIPT_DIR/../Resources"\ncd "$RESOURCES"\nexec /usr/bin/python3 "$RESOURCES/auto_clicker.py" --gui\n')
    os.chmod(lp, 0o755)
    shutil.copy2(sp, os.path.join(rd, "auto_clicker.py"))
    generate_iconset(os.path.join(rd, "AppIcon.icns"))
    with open(os.path.join(ad, "Contents", "Info.plist"), "w") as f:
        f.write(f'''<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>AutoClicker</string><key>CFBundleDisplayName</key><string>AutoClicker</string><key>CFBundleIdentifier</key><string>com.guomengtao.autoclicker</string><key>CFBundleVersion</key><string>{VERSION}</string><key>CFBundleShortVersionString</key><string>{VERSION}</string><key>CFBundleExecutable</key><string>AutoClicker</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>10.13</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>''')
    return ad

def install_login_item():
    ap = os.path.expanduser("~/Desktop/AutoClicker.app")
    if not os.path.exists(ap):
        print("[install] No AutoClicker.app on Desktop. Run --build first.")
        return False
    try:
        r = subprocess.run(["osascript", "-e", f'tell application "System Events"\nif not (exists login item "AutoClicker") then\nmake new login item at end with properties {{path:"{ap}", hidden:true}}\nend if\nend tell'], capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            print("[install] AutoClicker added to Login Items")
            return True
        return False
    except Exception as e:
        print(f"[install] Error: {e}")
        return False

def uninstall_login_item():
    try:
        subprocess.run(["osascript", "-e", 'tell application "System Events"\ntry\ndelete login item "AutoClicker"\nend try\nend tell'], capture_output=True, timeout=10)
        print("[uninstall] AutoClicker removed from Login Items")
        return True
    except Exception as e:
        print(f"[uninstall] Error: {e}")
        return False

def open_status_window(rm):
    try:
        import tkinter as tk
    except ImportError:
        return None
    root = tk.Tk()
    root.title(f"Auto Clicker {VERSION}")
    root.geometry("520x520")
    root.attributes("-topmost", True)
    tk.Label(root, text=f"Auto Clicker {VERSION}", font=("Helvetica",14,"bold")).pack(pady=10)
    sf = tk.Frame(root); sf.pack(fill="x", padx=20, pady=5)
    sl = tk.Label(sf, text="Status: Stopped", font=("Helvetica",12)); sl.pack(anchor="w")
    dl = tk.Label(sf, text="Mode: DRY-RUN", font=("Helvetica",10), fg="orange"); dl.pack(anchor="w")
    pl = tk.Label(sf, text="Permission: ...", font=("Helvetica",10)); pl.pack(anchor="w")
    rl = tk.Label(sf, text="Regions: 0", font=("Helvetica",10)); rl.pack(anchor="w")
    el = tk.Label(sf, text="Edit Mode: OFF", font=("Helvetica",10)); el.pack(anchor="w")
    tk.Frame(root, height=2, bg="gray").pack(fill="x", padx=20, pady=5)
    lt = tk.Text(root, height=18, width=60, font=("Monaco",9), state="disabled"); lt.pack(padx=20, pady=5, fill="both", expand=True)
    slb = tk.Label(root, text="Total: 0", font=("Helvetica",10)); slb.pack(pady=5)
    root.protocol("WM_DELETE_WINDOW", root.withdraw)
    def update():
        try:
            rn = LIVE_STATUS["running"]
            sl.config(text=f"Status: {'Running' if rn else 'Stopped'}", fg="green" if rn else "gray")
            dr = "DRY-RUN" if LIVE_STATUS["dry_run"] else "LIVE"
            dl.config(text=f"Mode: {dr}", fg="orange" if LIVE_STATUS["dry_run"] else "red")
            pl.config(text=f"Permission: {'OK' if LIVE_STATUS['permission_ok'] else 'NEEDED'}")
            rs = load_regions(); rl.config(text=f"Regions: {len(rs)}")
            em = "ON" if (rm and rm._edit_mode) else "OFF"
            el.config(text=f"Edit Mode: {em}")
            lt.config(state="normal"); lt.delete("1.0","end")
            for r in LIVE_STATUS.get("last_results",[])[:5]:
                lt.insert("end", f"[{LIVE_STATUS.get('last_scan','?')}] {r['process']}: {r['button']}\n")
            lt.insert("end", "\n--- Regions ---\n")
            for i, r in enumerate(rs, 1):
                s = "ON" if r.get("enabled",True) else "OFF"
                lt.insert("end", f"#{i} [{s}] {r.get('label','?')}: ({r['x']},{r['y']}) {r['width']}x{r['height']} [{r.get('action_type','click')}]\n")
            if not rs: lt.insert("end", "(No regions)\n")
            lt.config(state="disabled")
            slb.config(text=f"Total: {LIVE_STATUS.get('total_clicks',0)}")
        except Exception:
            pass
        try:
            root.after(STATUS_WINDOW_REFRESH*1000, update)
        except Exception:
            pass
    root.after(STATUS_WINDOW_REFRESH*1000, update)
    return root

# ===========================================================================
# rumps App
# ===========================================================================

class AutoClickerApp(rumps.App):
    def __init__(self):
        super().__init__("AC v1.4", quit_button=None)
        self._cfg = load_config()
        self._running = False
        self._click_count = 0
        self._thread = None
        self._last_status = "idle"
        self._has_permission = True
        self._click_this_minute = []
        self._last_scan_results = []
        self._status_window = None
        self._rm = RegionManager()

        from AppKit import NSApp, NSApplicationActivationPolicyAccessory
        try: NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        except Exception: pass

        global LIVE_STATUS
        LIVE_STATUS["dry_run"] = self._cfg.get("dry_run", True)
        self._build_menu()
        threading.Thread(target=self._check_permission_startup, daemon=True).start()
        if self._cfg.get("regions_enabled", True):
            self._rm.load_all()
        if self._cfg.get("show_status_window", False):
            self.start_status_window(None)

    def _build_menu(self):
        self.menu.clear()
        dry = "DRY" if self._cfg.get("dry_run", True) else "LIVE"
        run = "RUNNING" if self._running else "STOPPED"
        self._si = rumps.MenuItem(f"Status: {run} ({dry})")
        self.menu.add(self._si); self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Start", callback=self.start_monitoring))
        self.menu.add(rumps.MenuItem("Stop", callback=self.stop_monitoring))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem(f"Dry-Run: {'ON' if self._cfg.get('dry_run',True) else 'OFF'}", callback=self._tdr))
        self.menu.add(rumps.MenuItem(f"Regions: {'ON' if self._cfg.get('regions_enabled',True) else 'OFF'}", callback=self._tre))
        self.menu.add(rumps.MenuItem(f"Edit Mode: {'ON' if self._cfg.get('regions_edit_mode',False) else 'OFF'}", callback=self._tem))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("+ New Region", callback=self._new_region))
        self.menu.add(rumps.MenuItem("Drag to Create Region", callback=self._drag_create_region))
        regions = load_regions()
        if regions:
            self.menu.add(rumps.MenuItem("--- Regions ---"))
            for r in regions:
                s = "ON" if r.get("enabled", True) else "OFF"
                at = r.get("action_type", "click")
                self.menu.add(rumps.MenuItem(
                    f"  [{s}] {r.get('label','?')} [{at}]",
                    callback=lambda _, rid=r["id"]: self._region_menu(rid)
                ))
            self.menu.add(rumps.MenuItem("Remove All Regions", callback=self._rem_all))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Record Position", callback=self._rec_pos))
        self.menu.add(rumps.MenuItem("Test Scan", callback=self.test_scan))
        self.menu.add(rumps.MenuItem("Debug Scan", callback=self.debug_scan))
        self.menu.add(rumps.MenuItem("Show Log", callback=self._show_log))
        self.menu.add(rumps.MenuItem("Edit Config", callback=self._edit_cfg))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Status Window", callback=lambda _: self._tw()))
        self.menu.add(rumps.MenuItem("Install Auto-Start", callback=self._ias))
        self.menu.add(rumps.MenuItem("Accessibility", callback=lambda _: open_accessibility_settings()))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem(f"{VERSION}"))
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("Quit", callback=self.quit_app))

    def _region_menu(self, rid):
        regions = load_regions()
        r = next((r for r in regions if r["id"] == rid), None)
        if not r:
            return
        label = r.get("label", "?")
        msg = f"Region: {label}\nAction: {r.get('action_type','click')}\n"
        if r.get("action_type") == "click":
            msg += f"Interval: {r.get('action_config',{}).get('interval_seconds',3)}s\n"
        msg += "Select new action:"
        actions = ["click", "ocr", "scroll", "screenshot", "none"]
        cur = r.get("action_type", "click")
        als = [f"[{'v' if a==cur else ' '}] {a}" for a in actions]
        sel = show_dialog_with_list(f"Region: {label}", msg, als,
                                     [f"[{'v' if a==cur else ' '}] {a}" for a in actions if a==cur])
        if sel:
            for a in actions:
                if a in sel[0]:
                    update_region_action(rid, a)
                    self._rm.overlays[rid]._change_action(a)
                    show_notification("Region Updated", f"{label}: {a}")
        colors = REGION_COLORS
        cur_color = r.get("color", "#FF4444")
        cls = [f"[{'v' if cl==cur_color else ' '}] {cl}" for cl in colors]
        sel_cl = show_dialog_with_list(f"Color: {label}", "Select color:", cls,
                                        [f"[{'v' if cl==cur_color else ' '}] {cl}" for cl in colors if cl==cur_color])
        if sel_cl:
            for cl in colors:
                if cl in sel_cl[0]:
                    update_region_color(rid, cl)
                    if rid in self._rm.overlays:
                        self._rm.overlays[rid]._change_color(cl)
                    show_notification("Color Updated", f"{label}: {cl}")

    def _new_region(self, _):
        if not TK_AVAILABLE:
            rumps.alert("Error", "tkinter not available"); return
        x, y = get_mouse_position()
        label = show_text_input("New Region", f"At ({x},{y}):", f"R{len(load_regions())+1}")
        if label:
            self._rm.add_region(x, y, 120, 40, label)
            self._build_menu()
            show_notification("Auto Clicker", f"Region: {label}")

    def _drag_create_region(self, _):
        if not TK_AVAILABLE:
            rumps.alert("Error", "tkinter not available"); return
        show_notification("Auto Clicker", "Drag on screen to create region. Press Esc to cancel.")
        def _run_drag():
            overlay = DragCreateOverlay()
            result = overlay.get_result()
            if result:
                x, y, w, h = result
                label = show_text_input("New Region", f"Size: {w}x{h} at ({x},{y})", f"R{len(load_regions())+1}")
                if label:
                    self._rm.add_region(x, y, w, h, label)
                    self._build_menu()
                    show_notification("Auto Clicker", f"Region created: {label} ({w}x{h})")
        threading.Thread(target=_run_drag, daemon=True).start()

    def _rem_all(self, _):
        self._rm.stop_action_loops()
        self._rm.destroy_all()
        save_regions([])
        self._build_menu()
        show_notification("Auto Clicker", "All regions removed")

    def _tem(self, _):
        self._cfg["regions_edit_mode"] = not self._cfg.get("regions_edit_mode", False)
        save_config(self._cfg)
        self._rm.set_edit_mode(self._cfg["regions_edit_mode"])
        self._build_menu()

    def _tre(self, _):
        self._cfg["regions_enabled"] = not self._cfg.get("regions_enabled", True)
        save_config(self._cfg)
        if not self._cfg["regions_enabled"]:
            self._rm.stop_action_loops()
            self._rm.destroy_all()
        else:
            self._rm.load_all()
        self._build_menu()

    def _tdr(self, _):
        self._cfg["dry_run"] = not self._cfg.get("dry_run", True)
        save_config(self._cfg)
        LIVE_STATUS["dry_run"] = self._cfg["dry_run"]
        self._build_menu()

    def _rec_pos(self, _):
        x, y = get_mouse_position()
        label = show_text_input("Record", f"({x},{y}):", f"Pos_{x}_{y}")
        if label:
            add_position(x, y, label)
            self._build_menu()
            show_notification("Auto Clicker", f"Saved: {label}")

    def _show_log(self, _):
        log = load_log()
        total = log.get("total_clicks", 0)
        recent = log.get("clicks", [])[:10]
        msg = f"Total: {total}\n\nRecent:\n"
        for e in recent:
            msg += f"[{e['time']}] {e['process']}{' [DRY]' if e.get('dry_run') else ''}\n"
        rumps.alert("Log", msg)

    def _edit_cfg(self, _):
        subprocess.Popen(["open", "-a", "TextEdit", CONFIG_FILE])

    def _ias(self, _):
        if install_login_item():
            rumps.alert("Auto-Start", "Added to Login Items.")
        else:
            rumps.alert("Auto-Start", "Failed. Run --build first.")

    def _tw(self):
        if self._status_window:
            try:
                self._status_window.destroy()
            except Exception:
                pass
            self._status_window = None
        else:
            def _run():
                self._status_window = open_status_window(self._rm)
                if self._status_window:
                    self._status_window.mainloop()
            threading.Thread(target=_run, daemon=True).start()

    def _check_permission_startup(self):
        ok, _ = check_accessibility_permission()
        self._has_permission = ok
        LIVE_STATUS["permission_ok"] = ok

    @rumps.timer(1)
    def _update_title(self, _):
        p = "AC"
        if self._running:
            s = {"permission_denied":"X","timeout":"T","none":"-","ok":"+"}.get(self._last_status,"")
            self.title = f"{p}{s}{self._click_count}"
        else:
            dry = "D" if self._cfg.get("dry_run", True) else "L"
            self.title = f"{p}:{dry}"

    @rumps.timer(0.2)
    def _keep_tk_alive(self, _):
        for overlay in list(self._rm.overlays.values()):
            try:
                if overlay.root and overlay.root.winfo_exists():
                    overlay.root.update()
            except Exception:
                pass

    def start_monitoring(self, _):
        if not self._has_permission:
            open_accessibility_settings(); return
        if self._running:
            return
        self._running = True
        LIVE_STATUS["running"] = True
        self._rm.stop_action_loops()
        dry = self._cfg.get("dry_run", True)
        self._rm.start_action_loops(self._cfg, dry, click_at)
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._thread.start()

    def stop_monitoring(self, _):
        self._running = False
        LIVE_STATUS["running"] = False
        self._rm.stop_action_loops()

    def test_scan(self, _):
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        results, _, _ = scan_buttons(enabled, self._cfg.get("click_texts", CLICK_TEXTS),
                                      self._cfg.get("never_click_texts", NEVER_CLICK_TEXTS),
                                      self._cfg.get("window_filters", []), verbose=True)
        msg = f"Found {len(results)}:\n" + "\n".join(f"[{r['process']}] {r['button']}" for r in results[:20])
        rumps.alert("Scan", msg)

    def debug_scan(self, _):
        enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
        results = debug_scan_all(enabled, self._cfg.get("window_filters", []))
        msg = f"ALL buttons ({len(results)}):\n"
        by_p = {}
        for r in results:
            by_p.setdefault(r["process"], []).append(r)
        for proc, btns in sorted(by_p.items()):
            msg += f"\n[{proc}] ({len(btns)})\n" + "\n".join(f"  * {b['button']}" for b in btns[:5])
        rumps.alert("Debug Scan", msg)

    def quit_app(self, _):
        self._running = False
        LIVE_STATUS["running"] = False
        self._rm.stop_action_loops()
        self._rm.destroy_all()
        _release_pid_lock()
        from AppKit import NSApp
        try: NSApp.terminate_(None)
        except Exception: pass

    def _monitor_loop(self):
        while self._running:
            enabled = self._cfg.get("enabled_processes", PROCESS_NAMES)
            ct = self._cfg.get("click_texts", CLICK_TEXTS)
            nt = self._cfg.get("never_click_texts", NEVER_CLICK_TEXTS)
            wf = self._cfg.get("window_filters", [])
            dry = self._cfg.get("dry_run", True)
            results, status, _ = scan_buttons(enabled, ct, nt, wf, verbose=False)
            self._last_status = status
            self._last_scan_results = results
            LIVE_STATUS["last_scan"] = datetime.now().strftime("%H:%M:%S")
            LIVE_STATUS["last_status"] = status
            LIVE_STATUS["last_results"] = results
            if results:
                for r in results:
                    if not should_click_cooldown(r["button"]):
                        continue
                    if dry:
                        self._click_count = record_click(r["process"], r["button"], r["window"], was_dry_run=True)
                    else:
                        ok, _ = click_button(r["process"], r["button"])
                        self._click_count = record_click(r["process"], r["button"], r["window"], was_dry_run=not ok)
            LIVE_STATUS["total_clicks"] = self._click_count
            for _ in range(self._cfg.get("check_interval", CHECK_INTERVAL)):
                if not self._running:
                    break
                time.sleep(1)

# ===========================================================================
# CLI
# ===========================================================================

def run_cli_loop(cfg, rm):
    ct = cfg.get("click_texts", CLICK_TEXTS)
    nt = cfg.get("never_click_texts", NEVER_CLICK_TEXTS)
    wf = cfg.get("window_filters", [])
    print(f"  Auto Clicker {VERSION} - CLI")
    print(f"  Dry-Run: {'ON' if cfg.get('dry_run',True) else 'OFF'}")
    print(f"  Regions: {len(load_regions())}")
    print(f"  Ctrl+C to stop\n{'='*60}")
    dry = cfg.get("dry_run", True)
    rm.start_action_loops(cfg, dry, click_at)
    sc = 0
    while True:
        try:
            sc += 1
            ts = datetime.now().strftime("%H:%M:%S")
            enabled = cfg.get("enabled_processes", PROCESS_NAMES)
            print(f"[{ts}] #{sc}", end="", flush=True)
            results, status, elapsed = scan_buttons(enabled, ct, nt, wf, verbose=False)
            if status == "permission_denied":
                print(f" PERMISSION DENIED")
            elif results:
                names = ", ".join(f"'{r['button']}'" for r in results)
                action = "DRY" if dry else "CLICK"
                print(f" {action}: {names} ({elapsed:.1f}s)")
                for r in results:
                    if not should_click_cooldown(r["button"]):
                        continue
                    if dry:
                        record_click(r["process"], r["button"], r["window"], was_dry_run=True)
                    else:
                        ok, err = click_button(r["process"], r["button"])
                        record_click(r["process"], r["button"], r["window"], was_dry_run=not ok)
                        if not ok:
                            print(f"  [!] Click failed: {err}")
            else:
                print(f" ({elapsed:.1f}s)")
            time.sleep(cfg.get("check_interval", CHECK_INTERVAL))
        except KeyboardInterrupt:
            print(f"\nStopped. Scans: {sc}")
            rm.stop_action_loops()
            break
        except Exception as e:
            print(f" Error: {e}")
            time.sleep(2)

def main():
    if not _acquire_pid_lock():
        sys.exit(0)
    atexit.register(_release_pid_lock)

    if "--build" in sys.argv:
        print(f"[build] Done: {build_standalone()}"); return
    if "--install-login-item" in sys.argv:
        install_login_item(); return
    if "--uninstall-login-item" in sys.argv:
        uninstall_login_item(); return
    if "--list-procs" in sys.argv:
        for p in list_running_processes():
            print(f"  {p['name']} ({p['windows']} windows)")
        return
    if "--debug-scan" in sys.argv:
        for r in debug_scan_all(load_config().get("enabled_processes", PROCESS_NAMES)):
            print(f"  [{r['process']}] {r['button']} | {r['window']}")
        return
    if "--screenshot" in sys.argv:
        path = capture_screenshot()
        print(f"Screenshot: {path}" if path else "Failed.")
        return
    if "--record-pos" in sys.argv:
        idx = sys.argv.index("--record-pos")
        label = sys.argv[idx+1] if idx+1 < len(sys.argv) else f"Pos_{int(time.time())}"
        x, y = get_mouse_position()
        add_position(x, y, label)
        print(f"Recorded: {label} @ ({x},{y})")
        show_click_indicator(x, y); return
    if "--list-pos" in sys.argv:
        positions = load_positions()
        if not positions:
            print("No positions.")
        else:
            for p in positions:
                print(f"  [{'ON' if p.get('enabled',True) else 'OFF'}] {p['label']}: ({p['x']},{p['y']})")
        return
    if "--clear-pos" in sys.argv:
        n = len(load_positions()); clear_all_positions()
        print(f"Cleared {n} positions."); return
    if "--click-pos" in sys.argv:
        idx = sys.argv.index("--click-pos")
        if idx+2 < len(sys.argv):
            x, y = int(sys.argv[idx+1]), int(sys.argv[idx+2])
        else:
            print("Usage: --click-pos <x> <y>"); return
        if "--live" in sys.argv:
            show_click_indicator(x, y); click_at(x, y)
            print(f"Clicked ({x},{y})")
        else:
            show_click_indicator(x, y)
            print(f"DRY-RUN ({x},{y})")
        return
    if "--region-new" in sys.argv:
        x, y = get_mouse_position()
        idx = sys.argv.index("--region-new")
        label = sys.argv[idx+1] if idx+1 < len(sys.argv) and not sys.argv[idx+1].startswith("--") else f"R{len(load_regions())+1}"
        add_region_config(x, y, 120, 40, label)
        print(f"Region created: {label} @ ({x},{y})")
        return
    if "--region-new-drag" in sys.argv:
        print("Drag on screen to create region. Press Esc to cancel.")
        overlay = DragCreateOverlay()
        result = overlay.get_result()
        if result:
            x, y, w, h = result
            label = f"R{len(load_regions())+1}"
            if "--label" in sys.argv:
                li = sys.argv.index("--label")
                if li + 1 < len(sys.argv):
                    label = sys.argv[li + 1]
            add_region_config(x, y, w, h, label)
            print(f"Region created: {label} @ ({x},{y}) {w}x{h}")
        else:
            print("Cancelled.")
        return
    if "--region-list" in sys.argv:
        regions = load_regions()
        if not regions:
            print("No regions.")
        else:
            for i, r in enumerate(regions, 1):
                s = "ON" if r.get("enabled", True) else "OFF"
                print(f"  #{i} [{s}] {r['label']}: ({r['x']},{r['y']}) {r['width']}x{r['height']} [{r.get('action_type','click')}]")
        return
    if "--region-clear" in sys.argv:
        n = len(load_regions()); save_regions([])
        print(f"Cleared {n} regions."); return
    if "--region-test" in sys.argv:
        cfg = load_config(); rm = RegionManager(); rm.load_all()
        dry = cfg.get("dry_run", True)
        c = rm.process_region_clicks(cfg, dry, click_at)
        print(f"Region clicks: {c}"); return
    if "--region-delete" in sys.argv:
        idx = sys.argv.index("--region-delete")
        if idx+1 < len(sys.argv):
            target = sys.argv[idx+1]
            regions = load_regions()
            if target.isdigit():
                target_idx = int(target) - 1
                if 0 <= target_idx < len(regions):
                    remove_region_config(regions[target_idx]["id"])
                    print(f"Deleted region #{target}")
                else:
                    print(f"Invalid region number: {target}")
            else:
                remove_region_config(target)
                print(f"Deleted region: {target}")
        else:
            print("Usage: --region-delete <number|id>")
        return
    if "--region-toggle" in sys.argv:
        idx = sys.argv.index("--region-toggle")
        if idx+1 < len(sys.argv):
            target = sys.argv[idx+1]
            regions = load_regions()
            if target.isdigit():
                target_idx = int(target) - 1
                if 0 <= target_idx < len(regions):
                    toggle_region_config(regions[target_idx]["id"])
                    s = "ON" if regions[target_idx].get("enabled", True) else "OFF"
                    print(f"Toggled region #{target}: {s}")
            else:
                toggle_region_config(target)
                print(f"Toggled region: {target}")
        else:
            print("Usage: --region-toggle <number|id>")
        return

    cfg = load_config()
    if "--cli" in sys.argv or "--test-scan" in sys.argv:
        if "--test-scan" in sys.argv:
            results, _, _ = scan_buttons(cfg.get("enabled_processes", PROCESS_NAMES),
                                          cfg.get("click_texts", CLICK_TEXTS),
                                          cfg.get("never_click_texts", NEVER_CLICK_TEXTS),
                                          cfg.get("window_filters", []), verbose=True)
            for r in results:
                print(f"  [{r['process']}] {r['button']}")
            return
        rm = RegionManager(); rm.load_all()
        run_cli_loop(cfg, rm); return

    app = AutoClickerApp()
    print(f"Auto Clicker {VERSION}. Look for 'AC v1.4' in menu bar.")
    app.run()

if __name__ == "__main__":
    main()