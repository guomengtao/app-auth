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
    DRAG_METHODS = [
        "canvas", "window", "bind_all", "motion", "poll",
        "nsevent_global", "nsevent_local", "cgevent_poll",
        "grab_global", "focus_poll",
    ]

    def __init__(self, root, bounds, method="canvas"):
        self.root = root
        self.method = method
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

        self._sx = None
        self._sy = None
        self._cx = 0
        self._cy = 0
        self._mouse_down = False

        self.win.bind("<Escape>", lambda e: self._cancel())

        method_name = f"_bind_{method}"
        bind_fn = getattr(self, method_name, None)
        if bind_fn:
            bind_fn()
        else:
            self._bind_canvas()

        print(f"[DragMethod] {method}", file=sys.stderr, flush=True)

    def _bind_canvas(self):
        self.canvas.bind("<ButtonPress-1>", self._on_down)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_up)

    def _bind_window(self):
        self.win.bind("<ButtonPress-1>", self._on_down)
        self.win.bind("<B1-Motion>", self._on_drag)
        self.win.bind("<ButtonRelease-1>", self._on_up)

    def _bind_bind_all(self):
        self.root.bind_all("<ButtonPress-1>", self._on_down)
        self.root.bind_all("<B1-Motion>", self._on_drag)
        self.root.bind_all("<ButtonRelease-1>", self._on_up)

    def _bind_motion(self):
        self.canvas.bind("<ButtonPress-1>", self._on_motion_down)
        self.canvas.bind("<ButtonRelease-1>", self._on_motion_up)
        self.canvas.bind("<Motion>", self._on_motion_move)

    def _bind_poll(self):
        self.canvas.bind("<ButtonPress-1>", self._on_poll_down)
        self.canvas.bind("<ButtonRelease-1>", self._on_poll_up)
        self._poll_loop()

    def _bind_nsevent_global(self):
        try:
            from AppKit import NSEvent, NSLeftMouseDownMask, NSLeftMouseUpMask, \
                NSMouseMovedMask, NSLeftMouseDraggedMask
            from Quartz import CGEventGetLocation, CGEventCreate
            self._nsevent_down_mon = NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(
                NSLeftMouseDownMask, self._on_nsevent_down)
            self._nsevent_drag_mon = NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(
                NSLeftMouseDraggedMask, self._on_nsevent_drag)
            self._nsevent_up_mon = NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(
                NSLeftMouseUpMask, self._on_nsevent_up)
        except Exception as e:
            print(f"[NSEventGlobal] Failed: {e}", file=sys.stderr, flush=True)
            self._bind_canvas()

    def _on_nsevent_down(self, event):
        try:
            pos = CGEventGetLocation(CGEventCreate(None))
            px = int(pos.x) - self.win.winfo_rootx()
            py = int(pos.y) - self.win.winfo_rooty()
            if 0 <= px <= self.tw and 0 <= py <= self.th:
                self._sx, self._sy = px, py
                self._cx, self._cy = px, py
                self._draw_rect()
        except Exception:
            pass

    def _on_nsevent_drag(self, event):
        if self._sx is None:
            return
        try:
            pos = CGEventGetLocation(CGEventCreate(None))
            px = int(pos.x) - self.win.winfo_rootx()
            py = int(pos.y) - self.win.winfo_rooty()
            self._cx, self._cy = px, py
            self._draw_rect()
        except Exception:
            pass

    def _on_nsevent_up(self, event):
        if self._sx is None:
            return
        try:
            pos = CGEventGetLocation(CGEventCreate(None))
            px = int(pos.x) - self.win.winfo_rootx()
            py = int(pos.y) - self.win.winfo_rooty()
            self._cx, self._cy = px, py
            self._finish_rect()
        except Exception:
            pass

    def _bind_nsevent_local(self):
        try:
            from AppKit import NSEvent, NSLeftMouseDownMask, NSLeftMouseUpMask, \
                NSLeftMouseDraggedMask
            self._nsevent_loc_down = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
                NSLeftMouseDownMask, self._on_nsevent_local)
            self._nsevent_loc_drag = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
                NSLeftMouseDraggedMask, self._on_nsevent_local_drag)
            self._nsevent_loc_up = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
                NSLeftMouseUpMask, self._on_nsevent_local_up)
        except Exception as e:
            print(f"[NSEventLocal] Failed: {e}", file=sys.stderr, flush=True)
            self._bind_canvas()

    def _on_nsevent_local(self, event):
        if not self.win.winfo_exists():
            return event
        loc = event.locationInWindow()
        if hasattr(loc, 'x'):
            px, py = int(loc.x), int(loc.y)
        else:
            return event
        if 0 <= px <= self.tw and 0 <= py <= self.th:
            self._sx, self._sy = px, py
            self._cx, self._cy = px, py
            self._draw_rect()
        return event

    def _on_nsevent_local_drag(self, event):
        if self._sx is None or not self.win.winfo_exists():
            return event
        loc = event.locationInWindow()
        if hasattr(loc, 'x'):
            px, py = int(loc.x), int(loc.y)
        else:
            return event
        self._cx, self._cy = px, py
        self._draw_rect()
        return event

    def _on_nsevent_local_up(self, event):
        if self._sx is None or not self.win.winfo_exists():
            return event
        loc = event.locationInWindow()
        if hasattr(loc, 'x'):
            px, py = int(loc.x), int(loc.y)
        else:
            return event
        self._cx, self._cy = px, py
        self._finish_rect()
        return event

    def _bind_cgevent_poll(self):
        try:
            from Quartz import CGEventSourceButtonState, kCGEventSourceStateHIDSystemState
            self.canvas.bind("<ButtonPress-1>", self._on_cgpoll_down)
            self.canvas.bind("<ButtonRelease-1>", self._on_cgpoll_up)
            self._cgevent_poll_loop()
        except Exception as e:
            print(f"[CGEventPoll] Failed: {e}", file=sys.stderr, flush=True)
            self._bind_canvas()

    def _on_cgpoll_down(self, event):
        self._mouse_down = True
        self._sx, self._sy = event.x, event.y
        self._cx, self._cy = event.x, event.y

    def _on_cgpoll_up(self, event):
        if self._mouse_down and self._sx is not None:
            self._finish_rect()
        self._mouse_down = False

    def _cgevent_poll_loop(self):
        if self._mouse_down and self._sx is not None:
            try:
                from Quartz import CGEventGetLocation, CGEventCreate
                pos = CGEventGetLocation(CGEventCreate(None))
                px = int(pos.x) - self.win.winfo_rootx()
                py = int(pos.y) - self.win.winfo_rooty()
                self._cx, self._cy = px, py
                self._draw_rect()
            except Exception:
                px = self.win.winfo_pointerx() - self.win.winfo_rootx()
                py = self.win.winfo_pointery() - self.win.winfo_rooty()
                self._cx, self._cy = px, py
                self._draw_rect()
        if self.win.winfo_exists():
            self.win.after(16, self._cgevent_poll_loop)

    def _bind_grab_global(self):
        try:
            self.win.grab_set_global()
            self.canvas.bind("<ButtonPress-1>", self._on_grab_down)
            self.canvas.bind("<B1-Motion>", self._on_grab_drag)
            self.canvas.bind("<ButtonRelease-1>", self._on_grab_up)
        except Exception as e:
            print(f"[GrabGlobal] grab_set_global failed: {e}", file=sys.stderr, flush=True)
            self.canvas.bind("<ButtonPress-1>", self._on_grab_down)
            self.canvas.bind("<B1-Motion>", self._on_grab_drag)
            self.canvas.bind("<ButtonRelease-1>", self._on_grab_up)

    def _on_grab_down(self, event):
        self._sx, self._sy = event.x, event.y
        self._cx, self._cy = event.x, event.y
        self._draw_rect()

    def _on_grab_drag(self, event):
        if self._sx is None:
            return
        self._cx, self._cy = event.x, event.y
        self._draw_rect()

    def _on_grab_up(self, event):
        if self._sx is None:
            return
        self._cx, self._cy = event.x, event.y
        self._draw_rect()
        self._finish_rect()

    def _bind_focus_poll(self):
        self.canvas.bind("<ButtonPress-1>", self._on_focus_down)
        self.canvas.bind("<ButtonRelease-1>", self._on_focus_up)
        self._focus_poll_loop()

    def _on_focus_down(self, event):
        self._mouse_down = True
        self._sx, self._sy = event.x, event.y
        self._cx, self._cy = event.x, event.y
        try:
            self.win.focus_force()
            self.win.lift()
        except Exception:
            pass

    def _on_focus_up(self, event):
        if self._mouse_down and self._sx is not None:
            self._cx, self._cy = event.x, event.y
            self._finish_rect()
        self._mouse_down = False

    def _focus_poll_loop(self):
        if self._mouse_down and self._sx is not None:
            px = self.win.winfo_pointerx() - self.win.winfo_rootx()
            py = self.win.winfo_pointery() - self.win.winfo_rooty()
            if px >= 0 and py >= 0:
                self._cx, self._cy = px, py
                self._draw_rect()
            else:
                self._cx = max(0, min(px, self.tw))
                self._cy = max(0, min(py, self.th))
                self._draw_rect()
        if self.win.winfo_exists():
            self.win.after(8, self._focus_poll_loop)

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
        self._finish_rect()

    def _on_motion_down(self, event):
        self._mouse_down = True
        self._sx, self._sy = event.x, event.y
        self._cx, self._cy = event.x, event.y

    def _on_motion_up(self, event):
        if self._mouse_down and self._sx is not None:
            self._cx, self._cy = event.x, event.y
            self._finish_rect()
        self._mouse_down = False

    def _on_motion_move(self, event):
        if not self._mouse_down or self._sx is None:
            return
        self._cx, self._cy = event.x, event.y
        self._draw_rect()

    def _on_poll_down(self, event):
        self._mouse_down = True
        self._sx, self._sy = event.x, event.y
        self._cx, self._cy = event.x, event.y

    def _on_poll_up(self, event):
        if self._mouse_down and self._sx is not None:
            self._finish_rect()
        self._mouse_down = False

    def _poll_loop(self):
        if self._mouse_down and self._sx is not None:
            px = self.win.winfo_pointerx() - self.win.winfo_rootx()
            py = self.win.winfo_pointery() - self.win.winfo_rooty()
            if 0 <= px <= self.tw and 0 <= py <= self.th:
                self._cx, self._cy = px, py
                self._draw_rect()
        if self.win.winfo_exists():
            self.win.after(16, self._poll_loop)

    def _finish_rect(self):
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

        rh = 18

        self.canvas.create_rectangle(w - rh, h - rh, w, h,
                                     fill="#3388FF", outline="", tags="resize_se")
        self.canvas.create_line(w - rh + 5, h - 5, w - 5, h - rh + 5,
                                fill="#FFFFFF", width=2, tags="resize_se")

        self.canvas.create_rectangle(0, h - rh, rh, h,
                                     fill="#3388FF", outline="", tags="resize_sw")
        self.canvas.create_line(rh - 5, h - 5, 5, h - rh + 5,
                                fill="#FFFFFF", width=2, tags="resize_sw")

        self.canvas.create_rectangle(w - rh, 0, w, rh,
                                     fill="#3388FF", outline="", tags="resize_ne")
        self.canvas.create_line(w - rh + 5, rh - 5, w - 5, 5,
                                fill="#FFFFFF", width=2, tags="resize_ne")

        self.canvas.create_rectangle(0, 0, rh, rh,
                                     fill="#3388FF", outline="", tags="resize_nw")

        edge_thick = 8
        self.canvas.create_rectangle(0, rh, edge_thick, h - rh,
                                     fill="", outline="", tags="resize_w")
        self.canvas.create_rectangle(w - edge_thick, rh, w, h - rh,
                                     fill="", outline="", tags="resize_e")
        self.canvas.create_rectangle(rh, 0, w - rh, edge_thick,
                                     fill="", outline="", tags="resize_n")
        self.canvas.create_rectangle(rh, h - edge_thick, w - rh, h,
                                     fill="", outline="", tags="resize_s")

        at = self.cfg.get("action_type", "click")
        at_short = dict(zip(ACTION_TYPES, ACTION_NAMES)).get(at, "click")
        self.canvas.create_text(w // 2, h - 8, text=f"[{at_short}]",
                                fill=color, font=("PingFang SC", 8, "bold"), tags="action_label")

    def _bind_events(self):
        self.canvas.bind("<ButtonPress-1>", self._start_move)
        self.canvas.bind("<B1-Motion>", self._do_move)
        self.canvas.bind("<ButtonRelease-1>", self._stop_move)

        resize_tags = ["resize_se", "resize_sw", "resize_ne", "resize_nw",
                       "resize_e", "resize_w", "resize_n", "resize_s"]
        for tag in resize_tags:
            self.canvas.tag_bind(tag, "<ButtonPress-1>",
                                 lambda e, t=tag: self._start_resize(e, t))
            self.canvas.tag_bind(tag, "<B1-Motion>",
                                 lambda e, t=tag: self._do_resize(e, t))
            self.canvas.tag_bind(tag, "<ButtonRelease-1>", self._stop_move)

        self.canvas.tag_bind("close_btn", "<Button-1>", self._on_close_click)

    def _on_close_click(self, event):
        if self._mode == "move":
            self._mode = None
            return "break"
        self._close()
        return "break"

    def _stop_move(self, event):
        self._mode = None

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
        self.on_modified()

    def _start_resize(self, event, tag):
        self._mode = tag
        self._start_x = event.x_root
        self._start_y = event.y_root
        self._orig_x = self.cfg["x"]
        self._orig_y = self.cfg["y"]
        self._orig_w = self.cfg["width"]
        self._orig_h = self.cfg["height"]

    def _do_resize(self, event, tag):
        if not self._mode or not self._mode.startswith("resize"):
            return
        dx = event.x_root - self._start_x
        dy = event.y_root - self._start_y

        nw, nh = self._orig_w, self._orig_h
        nx, ny = self._orig_x, self._orig_y

        if "e" in tag:
            nw = max(REGION_MIN_WIDTH, self._orig_w + dx)
        if "w" in tag:
            nw = max(REGION_MIN_WIDTH, self._orig_w - dx)
            nx = self._orig_x + dx
            if nw == REGION_MIN_WIDTH:
                nx = self._orig_x + self._orig_w - REGION_MIN_WIDTH
        if "s" in tag:
            nh = max(REGION_MIN_HEIGHT, self._orig_h + dy)
        if "n" in tag:
            nh = max(REGION_MIN_HEIGHT, self._orig_h - dy)
            ny = self._orig_y + dy
            if nh == REGION_MIN_HEIGHT:
                ny = self._orig_y + self._orig_h - REGION_MIN_HEIGHT

        self.cfg["x"] = nx
        self.cfg["y"] = ny
        self.cfg["width"] = nw
        self.cfg["height"] = nh
        self.win.geometry(f"{nw}x{nh}+{nx}+{ny}")
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
    method = os.environ.get("DRAG_METHOD", "canvas")
    test_all = os.environ.get("DRAG_TEST_ALL", "").lower() in ("1", "true", "yes")
    args = sys.argv[2:] if len(sys.argv) > 2 else []

    if "--test-all" in args:
        test_all = True
    for a in args:
        if a.startswith("--method="):
            method = a.split("=", 1)[1]

    if test_all:
        return _test_all_methods()

    if method not in RegionCreateOverlay.DRAG_METHODS:
        print(f"Unknown method: {method}, trying: {RegionCreateOverlay.DRAG_METHODS}",
              file=sys.stderr, flush=True)
        method = "canvas"
    bounds = get_screen_bounds()
    root = tk.Tk()
    root.withdraw()
    overlay = RegionCreateOverlay(root, bounds, method=method)
    root.wait_window(overlay.win)
    root.destroy()
    result = overlay.result
    if result:
        result["method"] = method
        print(json.dumps(result, ensure_ascii=False))
    else:
        print("null")


def _test_all_methods():
    results = []
    for method in RegionCreateOverlay.DRAG_METHODS:
        print(f"\n{'='*60}", file=sys.stderr, flush=True)
        print(f"[TestAll] Testing method: {method}", file=sys.stderr, flush=True)
        bounds = get_screen_bounds()
        root = tk.Tk()
        root.withdraw()
        try:
            overlay = RegionCreateOverlay(root, bounds, method=method)
            root.wait_window(overlay.win)
            result = overlay.result
            status = "OK" if result else "CANCELLED"
            results.append({"method": method, "result": result, "status": status})
            print(f"[TestAll] {method}: {status}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[TestAll] {method}: ERROR - {e}", file=sys.stderr, flush=True)
            results.append({"method": method, "result": None, "status": f"ERROR: {e}"})
        finally:
            try:
                root.destroy()
            except Exception:
                pass

    print("\n" + "=" * 60, file=sys.stderr, flush=True)
    print("[TestAll] SUMMARY:", file=sys.stderr, flush=True)
    for r in results:
        print(f"  {r['method']:20s} → {r['status']}", file=sys.stderr, flush=True)
    print(json.dumps(results, ensure_ascii=False))


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