"""Region Editor v1.0.0 - Standalone Tk application for creating/editing screen regions.
This process runs as a NORMAL application (not LSUIElement), so Tk mouse events work.
"""

import json
import os
import sys
import tkinter as tk

REGIONS_FILE = os.path.expanduser("~/.screen_regions.json")
REGION_MIN_WIDTH = 30
REGION_MIN_HEIGHT = 20
REGION_COLORS = ["#FF4444", "#4488FF", "#44CC44", "#FF8800", "#AA44FF", "#888888"]
ACTION_TYPES = ["click", "ocr", "scroll", "screenshot", "none"]
ACTION_NAMES = ["click", "OCR", "scroll", "shot", "none"]


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
        from datetime import datetime
        import shutil
        data = {"version": "1.0", "updated_at": datetime.now().isoformat(), "regions": regions}
        bak = REGIONS_FILE + ".bak"
        if os.path.exists(REGIONS_FILE):
            shutil.copy2(REGIONS_FILE, bak)
        with open(REGIONS_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def get_screen_bounds():
    try:
        from AppKit import NSScreen
        screens = NSScreen.screens()
        min_x, min_y = 0, 0
        max_x, max_y = 0, 0
        for screen in screens:
            frame = screen.frame()
            if hasattr(frame, 'origin'):
                fx, fy = int(frame.origin.x), int(frame.origin.y)
                fw, fh = int(frame.size.width), int(frame.size.height)
            elif isinstance(frame, tuple):
                origin, size = frame
                fx, fy = int(origin[0]), int(origin[1])
                fw, fh = int(size[0]), int(size[1])
            else:
                continue
            min_x = min(min_x, fx)
            min_y = min(min_y, fy)
            max_x = max(max_x, fx + fw)
            max_y = max(max_y, fy + fh)
        return min_x, min_y, max_x, max_y
    except ImportError:
        pass
    root = tk.Tk()
    root.withdraw()
    w = root.winfo_screenwidth()
    h = root.winfo_screenheight()
    root.destroy()
    return 0, 0, w, h


def _hex_fade(hex_color, alpha):
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 6:
        r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
        r2 = int(r * alpha + 255 * (1 - alpha))
        g2 = int(g * alpha + 255 * (1 - alpha))
        b2 = int(b * alpha + 255 * (1 - alpha))
        return f"#{r2:02x}{g2:02x}{b2:02x}"
    return hex_color


class RegionCreateOverlay:
    def __init__(self, root, bounds):
        self.root = root
        self.min_x, self.min_y, self.max_x, self.max_y = bounds
        self.tw = self.max_x - self.min_x
        self.th = self.max_y - self.min_y
        self.result = None

        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.win.attributes("-alpha", 0.35)
        self.win.geometry(f"{self.tw}x{self.th}+{self.min_x}+{self.min_y}")
        self.win.configure(bg="black")

        self.canvas = tk.Canvas(self.win, width=self.tw, height=self.th,
                                bg="black", highlightthickness=0, cursor="crosshair")
        self.canvas.pack(fill="both", expand=True)

        self._sx, self._sy = 0, 0
        self._cx, self._cy = 0, 0

        self.canvas.bind("<ButtonPress-1>", self._on_down)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_up)

        self.win.bind("<Escape>", lambda e: self._cancel())

    def _on_down(self, event):
        self._sx, self._sy = event.x, event.y
        self._cx, self._cy = event.x, event.y
        self._draw_rect()

    def _on_drag(self, event):
        if self._sx is None:
            return
        self._cx, self._cy = event.x, event.y
        self._draw_rect()

    def _on_up(self, event):
        if self._sx is None:
            return
        self._cx, self._cy = event.x, event.y
        self._draw_rect()
        x1 = min(self._sx, self._cx)
        y1 = min(self._sy, self._cy)
        x2 = max(self._sx, self._cx)
        y2 = max(self._sy, self._cy)
        w, h = x2 - x1, y2 - y1
        if w >= REGION_MIN_WIDTH and h >= REGION_MIN_HEIGHT:
            self.result = {
                "x": self.min_x + x1, "y": self.min_y + y1,
                "w": w, "h": h,
            }
        self.win.destroy()

    def _cancel(self):
        self.result = None
        self.win.destroy()

    def _draw_rect(self):
        self.canvas.delete("all")
        x1 = min(self._sx, self._cx)
        y1 = min(self._sy, self._cy)
        x2 = max(self._sx, self._cx)
        y2 = max(self._sy, self._cy)
        if x2 - x1 > 0 and y2 - y1 > 0:
            self.canvas.create_rectangle(x1, y1, x2, y2, outline="#00FF00",
                                         width=2, dash=(6, 3))


class RegionEditWindow:
    def __init__(self, root, cfg, index, on_modified):
        self.root = root
        self.cfg = cfg
        self.index = index
        self.on_modified = on_modified
        self._start_x = 0
        self._start_y = 0
        self._orig_x = 0
        self._orig_y = 0
        self._orig_w = 0
        self._orig_h = 0
        self._mode = None

        w, h = cfg["width"], cfg["height"]
        x, y = cfg["x"], cfg["y"]
        color = cfg.get("color", "#FF4444")
        label = cfg.get("label", "?")

        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.win.attributes("-alpha", 0.90)
        self.win.geometry(f"{w}x{h}+{x}+{y}")
        self.win.configure(bg="systemTransparent")
        self.win.configure(background="systemTransparent")

        self.canvas = tk.Canvas(self.win, width=w, height=h,
                                bg="systemTransparent", highlightthickness=0,
                                cursor="crosshair")
        self.canvas.pack(fill="both", expand=True)

        self._draw(w, h, color, label)
        self._bind_events()

    def _draw(self, w, h, color, label):
        self.canvas.delete("all")

        self.canvas.create_rectangle(1, 1, w - 1, h - 1, outline=color, width=2, tags="border")

        tag_height = 24
        tag_width = max(len(label) * 12 + 50, 80)
        self.canvas.create_rectangle(0, 0, tag_width, tag_height, fill=color, outline="", tags="label_bg")
        num_label = f"#{self.index} {label}"
        self.canvas.create_text(10, tag_height // 2, text=num_label, anchor="w",
                                fill="#FFFFFF", font=("PingFang SC", 10, "bold"), tags="label_text")

        cx = tag_width - 12
        cy = tag_height // 2
        self.canvas.create_oval(cx - 6, cy - 6, cx + 6, cy + 6,
                                fill="#CC0000", outline="#990000", tags="close_btn")
        self.canvas.create_text(cx, cy, text="x", fill="#FFFFFF",
                                font=("Helvetica", 10, "bold"), tags="close_btn")

        cross_color = _hex_fade(color, 0.25)
        self.canvas.create_line(w // 2, 0, w // 2, h, fill=cross_color, width=1, tags="cross")
        self.canvas.create_line(0, h // 2, w, h // 2, fill=cross_color, width=1, tags="cross")

        rh_size = 16
        self.canvas.create_rectangle(w - rh_size, h - rh_size, w, h,
                                     fill="#3388FF", outline="", tags="resize_handle")
        self.canvas.create_line(w - rh_size + 5, h - 5, w - 5, h - rh_size + 5,
                                fill="#FFFFFF", width=2, tags="resize_handle")

        at = self.cfg.get("action_type", "click")
        at_short = dict(zip(ACTION_TYPES, ACTION_NAMES)).get(at, "click")
        self.canvas.create_text(w // 2, h - 8, text=f"[{at_short}]",
                                fill=color, font=("PingFang SC", 8, "bold"), tags="action_label")

    def _bind_events(self):
        for tag in ("border", "label_bg", "label_text", "cross", "action_label"):
            self.canvas.tag_bind(tag, "<ButtonPress-1>", self._start_move)
            self.canvas.tag_bind(tag, "<B1-Motion>", self._do_move)

        self.canvas.tag_bind("resize_handle", "<ButtonPress-1>", self._start_resize)
        self.canvas.tag_bind("resize_handle", "<B1-Motion>", self._do_resize)

        self.canvas.tag_bind("close_btn", "<Button-1>", lambda e: self._close())

    def _start_move(self, event):
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
        self.on_modified()

    def _start_resize(self, event):
        self._mode = "resize"
        self._start_x = event.x_root
        self._start_y = event.y_root
        self._orig_w = self.cfg["width"]
        self._orig_h = self.cfg["height"]

    def _do_resize(self, event):
        if self._mode != "resize":
            return
        nw = max(REGION_MIN_WIDTH, self._orig_w + (event.x_root - self._start_x))
        nh = max(REGION_MIN_HEIGHT, self._orig_h + (event.y_root - self._start_y))
        self.cfg["width"] = nw
        self.cfg["height"] = nh
        self.win.geometry(f"{nw}x{nh}")
        self._draw(nw, nh, self.cfg.get("color", "#FF4444"), self.cfg.get("label", "?"))
        self._bind_events()
        self.on_modified()

    def _close(self):
        self.cfg["_delete"] = True
        self.on_modified()
        self.win.destroy()

    def destroy(self):
        try:
            self.win.destroy()
        except Exception:
            pass


def run_create():
    bounds = get_screen_bounds()
    root = tk.Tk()
    root.withdraw()
    overlay = RegionCreateOverlay(root, bounds)
    root.wait_window(overlay.win)
    root.destroy()
    result = overlay.result
    if result:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print("null")


def run_edit():
    regions = load_regions()
    if not regions:
        print("NO_REGIONS")
        return

    root = tk.Tk()
    root.withdraw()
    root.overrideredirect(True)
    root.geometry("1x1+0+0")
    root.attributes("-topmost", True)

    modified = [False]
    edit_windows = {}

    def save_all():
        modified[0] = True
        all_regions = load_regions()
        for i, ew in edit_windows.items():
            for r in all_regions:
                if r["id"] == ew.cfg["id"]:
                    r["x"] = ew.cfg["x"]
                    r["y"] = ew.cfg["y"]
                    r["width"] = ew.cfg["width"]
                    r["height"] = ew.cfg["height"]
                    if ew.cfg.get("_delete"):
                        r["_delete"] = True
                    break
        deleted = [r for r in all_regions if r.get("_delete")]
        for r in deleted:
            all_regions.remove(r)
        for r in all_regions:
            r.pop("_delete", None)
        save_regions(all_regions)

    def on_modified():
        save_all()

    for i, r in enumerate(regions):
        ew = RegionEditWindow(root, r, i + 1, on_modified)
        edit_windows[i] = ew

    def check_all_closed():
        alive = [ew for ew in edit_windows.values() if ew.win and ew.win.winfo_exists()]
        if not alive:
            save_all()
            root.destroy()
        else:
            root.after(500, check_all_closed)

    root.after(500, check_all_closed)

    root.bind_all("<Escape>", lambda e: root.destroy())

    root.mainloop()

    if modified[0]:
        print("SAVED")
    else:
        print("NO_CHANGE")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "create"

    if mode == "--create" or mode == "create":
        run_create()
    elif mode == "--edit" or mode == "edit":
        run_edit()
    else:
        print(f"Usage: {sys.argv[0]} --create | --edit", file=sys.stderr)
        sys.exit(1)