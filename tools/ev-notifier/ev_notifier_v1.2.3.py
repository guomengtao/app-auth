"""Ev Notifier v1.2.3 - left sidebar menu + order list + trend chart"""
import json, os, re, subprocess, sys, tempfile, time, threading, urllib.parse, plistlib
from datetime import datetime, timedelta

VERSION = "v1.2.3"

try:
    from AppKit import (NSApplication, NSApplicationActivationPolicyAccessory, NSApplicationActivationPolicyRegular,
                        NSWindow, NSScrollView, NSTextView,
                        NSTextField, NSButton, NSView, NSMakeRect, NSMakeSize,
                        NSTitledWindowMask, NSClosableWindowMask, NSMiniaturizableWindowMask,
                        NSResizableWindowMask, NSBackingStoreBuffered, NSOnState, NSOffState,
                        NSSwitchButton, NSFont, NSColor, NSNotificationCenter,
                        NSWindowWillCloseNotification, NSViewWidthSizable, NSViewHeightSizable,
                        NSTableView, NSTableColumn, NSBezierPath,
                        NSViewMinYMargin, NSRectFill,
                        NSFontAttributeName, NSForegroundColorAttributeName)
    from Foundation import NSObject, NSMakePoint
    _HAS_APPKIT = True
except ImportError:
    _HAS_APPKIT = False

try:
    from WebKit import (WKWebView, WKWebViewConfiguration, WKUserContentController,
                        WKNavigationActionPolicyAllow, WKNavigationActionPolicyCancel)
    _HAS_WEBKIT = True
except ImportError:
    _HAS_WEBKIT = False

import rumps

DOTENV = [
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env"),
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env.local"),
    os.path.expanduser("~/.ev-notifier.env"),
]
REST_API_URL = None
UPSTASH_TOKEN = None
STREAM_KEY = "auth:notifications:stream"
LAST_ID_FILE = os.path.expanduser("~/.ev_last_id_v1.2.3")
RECEIVED_FILE = os.path.expanduser("~/.ev_received.json")
POLL_LOG_FILE = os.path.expanduser("~/.ev_poll_log.json")
MESSAGES_FILE = os.path.expanduser("~/.ev_messages.json")

LAUNCH_AGENT_LABEL = "com.evnotifier.agent"
LAUNCH_AGENT_DIR = os.path.expanduser("~/Library/LaunchAgents")
LAUNCH_AGENT_PATH = os.path.join(LAUNCH_AGENT_DIR, f"{LAUNCH_AGENT_LABEL}.plist")

_MAX_SEEN = 1000

_status = "starting"
_last_msg_ts = 0
_new_msg_count = 0
_paused = False
_seen_ids = set()
_app_ref = None
_last_poll_hour = -1
_recovery_count_today = 0


def load_env():
    global REST_API_URL, UPSTASH_TOKEN
    env = {}
    for p in DOTENV:
        if os.path.isfile(p):
            for line in open(p):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"^([A-Z_]+)=(.*)$", line)
                if not m:
                    continue
                v = m.group(2).strip().strip("\"'")
                if v == "[SENSITIVE]":
                    continue
                env[m.group(1)] = v
    url = env.get("KV_REST_API_URL") or env.get("UPSTASH_REDIS_REST_URL") or ""
    if url:
        REST_API_URL = url.rstrip("/")
    UPSTASH_TOKEN = env.get("KV_REST_API_TOKEN") or env.get("UPSTASH_REDIS_REST_TOKEN")
    if not REST_API_URL or not UPSTASH_TOKEN:
        print("ERROR: Config not found.")
        sys.exit(1)


def ensure_auto_start():
    if not os.path.exists(LAUNCH_AGENT_DIR):
        os.makedirs(LAUNCH_AGENT_DIR, exist_ok=True)
    if os.path.exists(LAUNCH_AGENT_PATH):
        return
    script_path = os.path.abspath(__file__)
    python_path = sys.executable
    plist = {
        "Label": LAUNCH_AGENT_LABEL,
        "ProgramArguments": [python_path, script_path],
        "RunAtLoad": True,
        "KeepAlive": False,
        "StandardOutPath": os.path.expanduser("~/.ev_notifier_stdout.log"),
        "StandardErrorPath": os.path.expanduser("~/.ev_notifier_stderr.log"),
    }
    with open(LAUNCH_AGENT_PATH, "wb") as f:
        plistlib.dump(plist, f)
    print(f"Auto-start enabled: {LAUNCH_AGENT_PATH}")


def disable_auto_start():
    if os.path.exists(LAUNCH_AGENT_PATH):
        os.unlink(LAUNCH_AGENT_PATH)
        print(f"Auto-start disabled: {LAUNCH_AGENT_PATH}")


def get_auto_start():
    return os.path.exists(LAUNCH_AGENT_PATH)


def load_messages():
    try:
        with open(MESSAGES_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []


def save_messages(data):
    with open(MESSAGES_FILE, "w") as f:
        json.dump(data, f, indent=2)


def store_message(ts, mtype, payload):
    msgs = load_messages()
    entry = {
        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else "",
        "type": mtype,
        "payload": payload,
    }
    msgs.insert(0, entry)
    if len(msgs) > 200:
        msgs = msgs[:200]
    save_messages(msgs)


def upstash_http(cmd, *args, timeout=10):
    path_parts = [cmd]
    for a in args:
        path_parts.append(urllib.parse.quote(str(a), safe=""))
    url = f"{REST_API_URL}/{'/'.join(path_parts)}"
    fd, tmp = tempfile.mkstemp(suffix=".json", prefix="ev_")
    try:
        os.close(fd)
        r = subprocess.run([
            "curl", "-s", "--connect-timeout", "3", "--max-time", str(timeout),
            "-X", "POST", url,
            "-H", f"Authorization: Bearer {UPSTASH_TOKEN}",
            "-o", tmp
        ], timeout=timeout + 5)
        if r.returncode != 0:
            raise ConnectionError(f"curl rc={r.returncode}")
        data = open(tmp).read()
        if not data.strip():
            raise ConnectionError("empty response")
        return json.loads(data)
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def load_last_id():
    try:
        with open(LAST_ID_FILE, "r") as f:
            return f.read().strip()
    except Exception:
        return "-"


def save_last_id(last_id):
    with open(LAST_ID_FILE, "w") as f:
        f.write(last_id)


def load_received():
    try:
        with open(RECEIVED_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_received(data):
    with open(RECEIVED_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_poll_log():
    try:
        with open(POLL_LOG_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_poll_log(data):
    with open(POLL_LOG_FILE, "w") as f:
        json.dump(data, f, indent=2)


def clean_old_logs():
    data = load_poll_log()
    cutoff = datetime.now().strftime("%Y-%m-%d")
    keys = sorted(data.keys())
    for k in keys:
        if k < cutoff:
            if (datetime.now() - datetime.strptime(k, "%Y-%m-%d")).days > 30:
                del data[k]
    save_poll_log(data)


def record_poll(reason, recovered):
    global _recovery_count_today
    date_str = datetime.now().strftime("%Y-%m-%d")
    data = load_poll_log()
    if date_str not in data:
        data[date_str] = {"last_poll_hour": -1, "total_polls_today": 0, "polls": []}
    entry = {
        "time": datetime.now().strftime("%H:%M:%S"),
        "type": "recovery",
        "reason": reason,
        "recovered": recovered
    }
    data[date_str]["polls"].append(entry)
    data[date_str]["total_polls_today"] = len(data[date_str]["polls"])
    data[date_str]["last_poll_hour"] = datetime.now().hour
    save_poll_log(data)
    _recovery_count_today = data[date_str]["total_polls_today"]
    clean_old_logs()


def record_message(msg_id, fields):
    date_str = datetime.now().strftime("%Y-%m-%d")
    data = load_received()
    if date_str not in data:
        data[date_str] = {"total_server": 0, "received_idx": [], "last_check": ""}
    idx = _extract_idx(fields)
    if idx is not None and idx not in data[date_str]["received_idx"]:
        data[date_str]["received_idx"].append(idx)
        data[date_str]["received_idx"].sort()
    total = _extract_total_daily(fields)
    if total is not None:
        data[date_str]["total_server"] = total
    data[date_str]["last_check"] = datetime.now().strftime("%H:%M:%S")
    save_received(data)
    return data[date_str]


def _extract_field(fields, key):
    if not isinstance(fields, list):
        return None
    for i in range(0, len(fields) - 1, 2):
        if fields[i] == key:
            return fields[i + 1]
    return None


def _extract_total_daily(fields):
    v = _extract_field(fields, "total_daily")
    if v is not None:
        try:
            return int(v)
        except (ValueError, TypeError):
            pass
    return None


def _extract_idx(fields):
    v = _extract_field(fields, "idx")
    if v is not None:
        try:
            return int(v)
        except (ValueError, TypeError):
            pass
    return None


def check_integrity(day_data):
    global _last_poll_hour
    total = day_data.get("total_server", 0)
    received = day_data.get("received_idx", [])
    local_cnt = len(received)
    if total <= 0:
        return False
    if local_cnt < total:
        missing = total - local_cnt
        print(f"LOSS: server={total}, local={local_cnt}, missing={missing}")
        current_hour = datetime.now().hour
        if current_hour == _last_poll_hour:
            print(f"COOLDOWN: recovery already used this hour (hour={current_hour})")
            return False
        return True
    return False


def do_recovery_poll(last_id):
    global _last_poll_hour
    print(f"RECOVERY: XRANGE from {last_id}")
    try:
        result = upstash_http("xrange", STREAM_KEY, last_id, "+", timeout=10)
        messages = result.get("result", [])
        recovered = 0
        for msg_entry in messages:
            if not isinstance(msg_entry, list) or len(msg_entry) < 2:
                continue
            msg_id = msg_entry[0]
            fields = msg_entry[1]
            if msg_id == last_id:
                continue
            record_message(msg_id, fields)
            data_raw = _extract_field(fields, "data")
            if data_raw:
                try:
                    msg = json.loads(data_raw)
                    handle_message(msg)
                except Exception:
                    pass
            recovered += 1
            last_id = msg_id
        save_last_id(last_id)
        _last_poll_hour = datetime.now().hour
        record_poll("loss_detected", recovered)
        print(f"RECOVERY: done, recovered={recovered}")
        return last_id
    except Exception as e:
        print(f"RECOVERY: failed - {e}")
        return last_id


def notify_macos(title, subtitle, body):
    try:
        safe_title = title.replace('"', "'")
        safe_body = (subtitle + "\n" + body).replace('"', "'")
        script = f'display notification "{safe_body}" with title "{safe_title}"'
        subprocess.run(["osascript", "-e", script], timeout=3)
    except Exception:
        pass


def handle_message(msg):
    global _last_msg_ts, _new_msg_count, _paused
    if _paused:
        return
    ts = msg.get("ts", 0)
    mtype = msg.get("type", "unknown")
    p = msg.get("payload", {}) or {}
    mid = f"{ts}_{mtype}"
    if mid in _seen_ids:
        return
    _seen_ids.add(mid)
    if len(_seen_ids) > _MAX_SEEN:
        _seen_ids.clear()
    _last_msg_ts = ts
    _new_msg_count += 1
    ts_label = time.strftime("%H:%M:%S", time.localtime(ts)) if ts else ""
    title = f"New {mtype}"
    subtitle = ts_label
    body = ""
    if mtype == "new_activation":
        product = p.get("product_name", "") or f"Product #{p.get('product_id', '')}"
        months = p.get("months", "")
        if months:
            try:
                m = int(months)
                months = f"{m // 12}y" if m >= 12 and m % 12 == 0 else f"{m}m"
            except Exception:
                pass
        act_code = p.get("activation_code", "")
        redeem_code = p.get("redeem_code", "")
        device = p.get("device_id", "")
        src = p.get("source", "")
        title = "New Device Activated"
        subtitle = f"{product} {months}".strip()
        lines = []
        if act_code:
            lines.append(f"Activation: {act_code}")
        if redeem_code:
            lines.append(f"Redeem: {redeem_code}")
        if device:
            lines.append(f"Device: {device}")
        if src:
            lines.append(f"Source: {src}")
        lines.append(ts_label)
        body = "\n".join(lines)
    elif mtype == "new_order":
        product = p.get("product_name", "") or p.get("plan_title", "")
        amount = p.get("total_amount") or p.get("amount") or ""
        if amount:
            try:
                amount = f"CNY{int(amount) / 100:.2f}"
            except Exception:
                pass
        title = "New Order"
        subtitle = product
        lines = [f"Amount: {amount}"] if amount else []
        redeem_code = p.get("redeem_code", "")
        if redeem_code:
            lines.append(f"Redeem: {redeem_code}")
        lines.append(ts_label)
        body = "\n".join(lines)
    elif mtype == "page_visit":
        page = p.get("page", "") or p.get("title", "")
        title = "Page Visit"
        subtitle = page
        body = ts_label
    else:
        body = json.dumps(p, ensure_ascii=False, indent=2)[:200]
    print(f"[{ts_label}] {title} | {subtitle}")
    notify_macos(title, subtitle, body)
    store_message(ts, mtype, p)
    if _app_ref:
        _app_ref.title = f"Ev {VERSION}({_new_msg_count})"


def redis_loop():
    global _status, _last_poll_hour, _new_msg_count
    reconnect_delay = 1
    try:
        last_id = load_last_id()
    except Exception:
        last_id = "-"
    if last_id != "-":
        _last_poll_hour = datetime.now().hour

    while True:
        try:
            _status = "connecting"
            if _app_ref:
                _app_ref.title = f"Ev {VERSION} 连接中..."
            ping = upstash_http("ping", timeout=5)
            if ping.get("result") != "PONG":
                raise ConnectionError(f"PING failed: {ping}")
            _status = "connected"
            reconnect_delay = 1
            if _app_ref:
                _app_ref.title = f"Ev {VERSION}({_new_msg_count})" if _new_msg_count else f"Ev {VERSION}"
            print(f"Ev online: {STREAM_KEY}, last_id={last_id}")
            while True:
                try:
                    result = upstash_http("xrange", STREAM_KEY, last_id, "+", timeout=10)
                    messages = result.get("result", [])
                    if messages:
                        for msg_entry in messages:
                            if not isinstance(msg_entry, list) or len(msg_entry) < 2:
                                continue
                            msg_id = msg_entry[0]
                            fields = msg_entry[1]
                            if msg_id == last_id:
                                continue
                            data_raw = _extract_field(fields, "data")
                            if data_raw:
                                try:
                                    msg = json.loads(data_raw)
                                    handle_message(msg)
                                except Exception:
                                    pass
                            day_data = record_message(msg_id, fields)
                            if check_integrity(day_data):
                                last_id = do_recovery_poll(last_id)
                            last_id = msg_id
                        save_last_id(last_id)
                    time.sleep(5)
                except ConnectionError:
                    raise
        except Exception as e:
            print(f"Error: {e}, retrying in {reconnect_delay}s...")
            _status = f"retry({reconnect_delay}s)"
            if _app_ref:
                _app_ref.title = f"Ev {VERSION} 重试({reconnect_delay}s)..."
            time.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, 30)


def _run_event_loop():
    redis_loop()


def _format_message_detail(m):
    p = m.get("payload", {}) or {}
    mtype = m.get("type", "unknown")
    detail = ""
    type_cn = mtype
    if mtype == "new_activation":
        product = p.get("product_name", "") or ""
        code = p.get("activation_code", "") or ""
        device = p.get("device_id", "") or ""
        months = p.get("months", "")
        dur = ""
        if months:
            try:
                mi = int(months)
                dur = f" {mi // 12}y" if mi >= 12 and mi % 12 == 0 else f" {mi}m"
            except Exception:
                pass
        detail = f"{product}{dur}"
        if code:
            detail += f" | {code}"
        if device:
            detail += f" | {device}"
        type_cn = "激活"
    elif mtype == "new_order":
        product = p.get("product_name", "") or ""
        amount = p.get("total_amount") or p.get("amount") or ""
        if amount:
            try:
                amount = f" CNY{int(amount)/100:.2f}"
            except Exception:
                amount = ""
        detail = f"{product}{amount}"
        type_cn = "订单"
    elif mtype == "page_visit":
        detail = p.get("page", "") or p.get("title", "") or ""
        type_cn = "访问"
    elif mtype == "test_curl":
        detail = json.dumps(p, ensure_ascii=False)[:100]
        type_cn = "测试"
    else:
        detail = json.dumps(p, ensure_ascii=False)[:100]
        type_cn = "其他"
    return type_cn, detail


def _build_messages_text():
    msgs = load_messages()
    polls = load_poll_log()
    entries = []

    for m in msgs[:100]:
        type_cn, detail = _format_message_detail(m)
        entries.append({
            "time": m.get("time", ""),
            "type": type_cn,
            "detail": detail,
        })

    for date_str in sorted(polls.keys(), reverse=True):
        for p in polls[date_str].get("polls", []):
            entries.append({
                "time": f"{date_str} {p.get('time', '')}",
                "type": "恢复",
                "detail": f"找回 {p.get('recovered', 0)} 条消息 - {p.get('reason', '')}",
            })

    if not entries:
        return "暂无消息"

    lines = []
    for entry in entries[:50]:
        ts = entry["time"]
        tp = entry["type"]
        detail = entry["detail"]
        lines.append(f"[{ts}] [{tp}] {detail}")
    return "\n\n".join(lines)


def _build_status_text():
    received = load_received()
    today = datetime.now().strftime("%Y-%m-%d")
    today_data = received.get(today, {})
    total_server = today_data.get("total_server", 0)
    local_cnt = len(today_data.get("received_idx", []))

    status_cn = "已连接" if _status == "connected" else "重试中..." if "retry" in _status else "错误"
    paused_cn = "是" if _paused else "否"

    lines = [
        f"连接状态: {status_cn}  ({_status})",
        f"今日收到: {_new_msg_count} 条",
        f"已暂停: {paused_cn}",
        f"恢复轮询: {_recovery_count_today} 次",
        f"服务端总数: {total_server}",
        f"本地记录: {local_cnt}",
        "",
        f"数据流: {STREAM_KEY}",
        f"版本: {VERSION}",
    ]
    return "\n".join(lines)


def _build_order_list():
    msgs = load_messages()
    orders = []
    for m in msgs:
        if m.get("type") != "new_order":
            continue
        p = m.get("payload", {}) or {}
        product = p.get("product_name", "") or p.get("plan_title", "") or "-"
        amount_raw = p.get("total_amount") or p.get("amount") or 0
        try:
            amount = float(amount_raw) / 100.0
        except Exception:
            amount = 0.0
        redeem = p.get("redeem_code", "") or "-"
        orders.append({
            "time": m.get("time", ""),
            "product": product,
            "amount": amount,
            "redeem": redeem,
        })
    return orders


def _build_trend_data(days=30):
    msgs = load_messages()
    today = datetime.now().date()
    daily = {}
    for i in range(days):
        d = today - timedelta(days=days - 1 - i)
        ds = d.strftime("%Y-%m-%d")
        daily[ds] = {"count": 0, "amount": 0.0}

    for m in msgs:
        if m.get("type") != "new_order":
            continue
        t = m.get("time", "")
        if len(t) >= 10:
            ds = t[:10]
            if ds in daily:
                daily[ds]["count"] += 1
                p = m.get("payload", {}) or {}
                amt_raw = p.get("total_amount") or p.get("amount") or 0
                try:
                    daily[ds]["amount"] += float(amt_raw) / 100.0
                except Exception:
                    pass

    dates = []
    counts = []
    amounts = []
    for ds in sorted(daily.keys()):
        dates.append(ds[5:])
        counts.append(daily[ds]["count"])
        amounts.append(daily[ds]["amount"])
    return dates, counts, amounts


def _build_visitor_list():
    msgs = load_messages()
    visitors = []
    for m in msgs:
        if m.get("type") != "page_visit":
            continue
        p = m.get("payload", {}) or {}
        page = p.get("page", "") or p.get("title", "") or "-"
        referrer = p.get("referrer", "") or "-"
        ua = p.get("user_agent", "") or "-"
        ip = p.get("ip", "") or "-"
        visitors.append({
            "time": m.get("time", ""),
            "page": page,
            "referrer": referrer,
            "ip": ip,
        })
    return visitors


class TrendChartView(NSView):
    def initWithFrame_(self, frame):
        self = super().initWithFrame_(frame)
        if self is None:
            return None
        self._dates = []
        self._counts = []
        self._amounts = []
        self._bar_color = NSColor.colorWithRed_green_blue_alpha_(0.2, 0.6, 1.0, 0.7)
        self._line_color = NSColor.colorWithRed_green_blue_alpha_(1.0, 0.4, 0.3, 1.0)
        self._grid_color = NSColor.colorWithWhite_alpha_(0.85, 1.0)
        self._label_color = NSColor.grayColor()
        self._label_font = NSFont.systemFontOfSize_(9)
        return self

    def drawRect_(self, rect):
        NSColor.whiteColor().set()
        NSRectFill(rect)

        if not self._dates:
            return

        w = self.bounds().size.width
        h = self.bounds().size.height
        margin_left = 40
        margin_right = 45
        margin_top = 30
        margin_bottom = 40
        plot_w = w - margin_left - margin_right
        plot_h = h - margin_top - margin_bottom

        if plot_w <= 0 or plot_h <= 0:
            return

        n = len(self._dates)
        if n < 2:
            return

        max_count = max(self._counts) if self._counts else 1
        max_count = max(max_count, 1)
        max_amount = max(self._amounts) if self._amounts else 1.0
        max_amount = max(max_amount, 0.01)

        for i in range(5):
            y_pct = i / 4.0
            y = margin_bottom + plot_h * y_pct
            path = NSBezierPath.bezierPath()
            path.moveToPoint_(NSMakePoint(margin_left, y))
            path.lineToPoint_(NSMakePoint(w - margin_right, y))
            self._grid_color.set()
            path.setLineWidth_(0.5)
            path.stroke()

            val = int(max_count * (1 - y_pct))
            label = str(val)
            attr = {NSFontAttributeName: self._label_font,
                    NSForegroundColorAttributeName: self._label_color}
            from Foundation import NSString
            ns_str = NSString.stringWithString_(label)
            ns_str.drawAtPoint_withAttributes_(NSMakePoint(2, y - 6), attr)

            amt_val = max_amount * (1 - y_pct)
            if amt_val >= 1000:
                label2 = "%dk" % int(amt_val / 1000)
            else:
                label2 = "%d" % int(amt_val)
            ns_str2 = NSString.stringWithString_(label2)
            ns_str2.drawAtPoint_withAttributes_(NSMakePoint(w - 42, y - 6), attr)

        bar_w = max(plot_w / n * 0.6, 2)
        gap = plot_w / n
        for i in range(n):
            cnt = self._counts[i]
            bar_h = (cnt / max_count) * plot_h if max_count > 0 else 0
            x = margin_left + i * gap + (gap - bar_w) / 2
            y = margin_bottom
            bar_rect = ((x, y), (bar_w, bar_h))
            self._bar_color.set()
            NSRectFill(bar_rect)

        if max_amount > 0:
            line_path = NSBezierPath.bezierPath()
            line_path.setLineWidth_(2.0)
            first = True
            for i in range(n):
                amt = self._amounts[i]
                lx = margin_left + i * gap + gap / 2
                ly = margin_bottom + (amt / max_amount) * plot_h
                pt = NSMakePoint(lx, ly)
                if first:
                    line_path.moveToPoint_(pt)
                    first = False
                else:
                    line_path.lineToPoint_(pt)
            self._line_color.set()
            line_path.stroke()

            for i in range(n):
                amt = self._amounts[i]
                lx = margin_left + i * gap + gap / 2
                ly = margin_bottom + (amt / max_amount) * plot_h
                dot_rect = ((lx - 3, ly - 3), (6, 6))
                dot_path = NSBezierPath.bezierPathWithOvalInRect_(dot_rect)
                self._line_color.set()
                dot_path.fill()

        step = max(n // 7, 1)
        for i in range(n):
            if i % step != 0 and i != n - 1:
                continue
            label = self._dates[i]
            attr = {NSFontAttributeName: self._label_font,
                    NSForegroundColorAttributeName: self._label_color}
            from Foundation import NSString
            ns_str = NSString.stringWithString_(label)
            lx = margin_left + i * gap + gap / 2 - 12
            ns_str.drawAtPoint_withAttributes_(NSMakePoint(lx, margin_bottom - 16), attr)


_SIDEBAR_ITEMS = ["消息", "订单列表", "走势图", "访客浏览", "设置"]
_SIDEBAR_WIDTH = 110


class SidebarDataSource(NSObject):
    def init(self):
        self._items = _SIDEBAR_ITEMS
        self._on_select = None
        return self

    def numberOfRowsInTableView_(self, tv):
        return len(self._items)

    def tableView_objectValueForTableColumn_row_(self, tv, col, row):
        if row < len(self._items):
            return self._items[row]
        return ""

    def tableViewSelectionDidChange_(self, notification):
        tv = notification.object()
        row = tv.selectedRow()
        if 0 <= row < len(self._items) and self._on_select:
            self._on_select(row)


class OrderTableDataSource(NSObject):
    def init(self):
        self._orders = []
        return self

    def setOrders_(self, orders):
        self._orders = orders

    def numberOfRowsInTableView_(self, tv):
        return len(self._orders)

    def tableView_objectValueForTableColumn_row_(self, tv, col, row):
        if row >= len(self._orders):
            return ""
        o = self._orders[row]
        cid = col.identifier()
        if cid == "time":
            t = o.get("time", "")
            return t[:16] if len(t) >= 16 else t
        elif cid == "product":
            return o.get("product", "")
        elif cid == "amount":
            return "CNY%.2f" % o["amount"]
        elif cid == "redeem":
            return o.get("redeem", "")
        return ""


class WebNavDelegate(NSObject):
    def init(self):
        self._dashboard = None
        return self

    def webView_decidePolicyForNavigationAction_decisionHandler_(self, wv, action, handler):
        url_str = str(action.request().URL())
        if url_str and url_str.startswith("ev://"):
            if "refresh" in url_str and self._dashboard:
                self._dashboard._refresh_content()
            handler(WKNavigationActionPolicyCancel)
        else:
            handler(WKNavigationActionPolicyAllow)


_DASH_CSS = """
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif;background:#f0f2f5;color:#1d1d1f;padding:24px;-webkit-font-smoothing:antialiased}}
.header{{margin-bottom:20px;display:flex;align-items:center;justify-content:space-between}}
.header h2{{font-size:18px;font-weight:600;color:#1d1d1f}}
.stats{{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}}
.stat-card{{background:#fff;border-radius:8px;padding:14px 18px;box-shadow:0 1px 3px rgba(0,0,0,0.06);min-width:90px;flex:1}}
.stat-value{{font-size:22px;font-weight:700;color:#0071e3}}
.stat-label{{font-size:10px;color:#86868b;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}}
.msg-card{{background:#fff;border-radius:8px;padding:12px 16px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,0.04);border-left:4px solid #0071e3;display:flex;align-items:flex-start;gap:10px}}
.msg-card.type-order{{border-left-color:#34c759}}
.msg-card.type-activate{{border-left-color:#ff9f0a}}
.msg-card.type-visit{{border-left-color:#5e5ce6}}
.msg-card.type-recover{{border-left-color:#30d158}}
.msg-card.type-other{{border-left-color:#8e8e93}}
.msg-time{{font-size:11px;color:#86868b;min-width:130px;white-space:nowrap}}
.msg-badge{{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:#e8f0fe;color:#0071e3;white-space:nowrap}}
.msg-badge.badge-order{{background:#d4f5e0;color:#1a7a3a}}
.msg-badge.badge-activate{{background:#fff3d6;color:#b06d00}}
.msg-badge.badge-visit{{background:#e5e4f9;color:#4a47b0}}
.msg-badge.badge-recover{{background:#d4f5e0;color:#1a7a3a}}
.msg-badge.badge-other{{background:#f2f2f7;color:#636366}}
.msg-detail{{font-size:12px;color:#3a3a3c;flex:1;line-height:1.4}}
table{{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)}}
th{{text-align:left;padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#86868b;background:#fafafa;border-bottom:1px solid #e5e5ea}}
td{{padding:10px 14px;font-size:12px;border-bottom:1px solid #f2f2f7}}
tr:last-child td{{border-bottom:none}}
tr:hover td{{background:#f8f9fa}}
.chart-wrap{{background:#fff;border-radius:8px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}}
canvas{{max-height:340px;width:100%!important}}
.empty-msg{{text-align:center;padding:60px 20px;color:#86868b;font-size:14px}}
.empty-msg svg{{display:block;margin:0 auto 16px;width:48px;height:48px;opacity:.3}}
.btn-refresh{{font-size:11px;color:#0071e3;background:none;border:1px solid #0071e3;border-radius:6px;padding:4px 12px;cursor:pointer;text-decoration:none}}
.btn-refresh:hover{{background:#e8f0fe}}
.info-row{{display:flex;align-items:center;gap:16px;margin-bottom:8px}}
.info-row .label{{font-size:13px;color:#1d1d1f;font-weight:500;min-width:180px}}
.info-row .value{{font-size:13px;color:#86868b}}
"""

_TYPE_STYLES = {
    "订单": ("type-order", "badge-order"),
    "激活": ("type-activate", "badge-activate"),
    "访问": ("type-visit", "badge-visit"),
    "恢复": ("type-recover", "badge-recover"),
    "测试": ("type-other", "badge-other"),
    "其他": ("type-other", "badge-other"),
}


class DashboardWindow:
    def __init__(self, app_ref):
        self._app = app_ref
        self._window = None
        self._sidebar_table = None
        self._sidebar_ds = SidebarDataSource.alloc().init()
        self._content_container = None
        self._current_tab = 0
        self._pages = {}
        self._webview = None
        self._settings_page = None
        self._auto_start_btn = None
        self._auto_start_label = None
        self._order_ds = OrderTableDataSource.alloc().init()

    def show(self):
        if not _HAS_APPKIT:
            text = _build_status_text() + "\n\n" + _build_messages_text()
            rumps.alert(f"Ev Notifier {VERSION}", text[:800])
            return
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyRegular)
        if self._window is None:
            self._create_window()
        self._refresh_content()
        self._window.makeKeyAndOrderFront_(None)
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)

    def _create_window(self):
        rect = NSMakeRect(100, 100, 820, 620)
        mask = (NSTitledWindowMask | NSClosableWindowMask |
                NSMiniaturizableWindowMask | NSResizableWindowMask)
        self._window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, mask, NSBackingStoreBuffered, False)
        self._window.setTitle_(f"Ev Notifier {VERSION}")
        self._window.setMinSize_(NSMakeSize(620, 420))

        nc = NSNotificationCenter.defaultCenter()
        nc.addObserver_selector_name_object_(
            self, 'windowWillClose:', NSWindowWillCloseNotification, self._window)

        win_w = rect[1][0]
        win_h = rect[1][1]

        sidebar_scroll = NSScrollView.alloc().initWithFrame_(
            ((0, 0), (_SIDEBAR_WIDTH, win_h)))
        sidebar_scroll.setHasVerticalScroller_(False)
        sidebar_scroll.setBorderType_(1)
        sidebar_scroll.setAutoresizingMask_(NSViewHeightSizable)

        self._sidebar_table = NSTableView.alloc().initWithFrame_(
            ((0, 0), (_SIDEBAR_WIDTH, win_h)))
        col = NSTableColumn.alloc().initWithIdentifier_("menu")
        col.setWidth_(_SIDEBAR_WIDTH - 2)
        col.setMinWidth_(_SIDEBAR_WIDTH - 2)
        self._sidebar_table.addTableColumn_(col)
        self._sidebar_table.setHeaderView_(None)
        self._sidebar_table.setRowHeight_(36)
        self._sidebar_table.setIntercellSpacing_((0, 0))
        self._sidebar_table.setAutoresizingMask_(NSViewHeightSizable)

        self._sidebar_ds._on_select = self._switch_page
        self._sidebar_table.setDataSource_(self._sidebar_ds)
        self._sidebar_table.setDelegate_(self._sidebar_ds)
        self._sidebar_table.reloadData()
        try:
            import objc
            idx_set = objc.lookup_class('NSIndexSet').indexSetWithIndex_(0)
            self._sidebar_table.selectRowIndexes_byExtendingSelection_(idx_set, False)
        except Exception:
            pass

        sidebar_scroll.setDocumentView_(self._sidebar_table)
        self._window.contentView().addSubview_(sidebar_scroll)

        content_frame = ((_SIDEBAR_WIDTH, 0), (win_w - _SIDEBAR_WIDTH, win_h))
        self._content_container = NSView.alloc().initWithFrame_(content_frame)
        self._content_container.setAutoresizingMask_(
            NSViewWidthSizable | NSViewHeightSizable)
        self._window.contentView().addSubview_(self._content_container)

        self._build_all_pages()
        self._switch_page(0)
        self._window.center()

    def _build_all_pages(self):
        cw = self._content_container.bounds().size.width
        ch = self._content_container.bounds().size.height

        if _HAS_WEBKIT:
            nav_delegate = WebNavDelegate.alloc().init()
            nav_delegate._dashboard = self
            config = WKWebViewConfiguration.alloc().init()
            self._webview = WKWebView.alloc().initWithFrame_configuration_(
                ((0, 0), (cw, ch)), config)
            self._webview.setAutoresizingMask_(
                NSViewWidthSizable | NSViewHeightSizable)
            self._webview.setNavigationDelegate_(nav_delegate)
            self._content_container.addSubview_(self._webview)

        self._settings_page = self._build_settings_page(cw, ch)
        self._settings_page.setHidden_(True)
        self._content_container.addSubview_(self._settings_page)
        self._pages[4] = self._settings_page

    def _build_settings_page(self, cw, ch):
        container = NSView.alloc().initWithFrame_(((0, 0), (cw, ch)))
        container.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)

        y = ch - 100

        card = NSView.alloc().initWithFrame_(((20, y - 60), (cw - 40, 120)))
        card.setWantsLayer_(True)
        try:
            card.layer().setBackgroundColor_(NSColor.whiteColor().CGColor())
            card.layer().setCornerRadius_(10.0)
        except Exception:
            pass
        container.addSubview_(card)

        label = NSTextField.alloc().initWithFrame_(((20, 74), (300, 22)))
        label.setStringValue_("Auto-start on Login")
        label.setBezeled_(False)
        label.setDrawsBackground_(False)
        label.setEditable_(False)
        label.setSelectable_(False)
        label.setFont_(NSFont.boldSystemFontOfSize_(14))
        card.addSubview_(label)

        btn = NSButton.alloc().initWithFrame_(((300, 66), (120, 28)))
        btn.setButtonType_(NSSwitchButton)
        btn.setTitle_("")
        btn.setState_(NSOnState if get_auto_start() else NSOffState)
        btn.setTarget_(self)
        btn.setAction_('toggleAutoStart:')
        card.addSubview_(btn)
        self._auto_start_btn = btn

        self._auto_start_label = NSTextField.alloc().initWithFrame_(((20, 46), (400, 22)))
        self._auto_start_label.setStringValue_(
            "Status: " + ("ON" if get_auto_start() else "OFF"))
        self._auto_start_label.setBezeled_(False)
        self._auto_start_label.setDrawsBackground_(False)
        self._auto_start_label.setEditable_(False)
        self._auto_start_label.setSelectable_(False)
        self._auto_start_label.setFont_(NSFont.systemFontOfSize_(12))
        self._auto_start_label.setTextColor_(NSColor.grayColor())
        card.addSubview_(self._auto_start_label)

        desc = NSTextField.alloc().initWithFrame_(((20, 20), (cw - 80, 20)))
        desc.setStringValue_("App will start automatically when you log in to your Mac.")
        desc.setBezeled_(False)
        desc.setDrawsBackground_(False)
        desc.setEditable_(False)
        desc.setSelectable_(False)
        desc.setFont_(NSFont.systemFontOfSize_(11))
        desc.setTextColor_(NSColor.lightGrayColor())
        card.addSubview_(desc)

        y -= 200
        card2 = NSView.alloc().initWithFrame_(((20, y - 160), (cw - 40, 160)))
        card2.setWantsLayer_(True)
        try:
            card2.layer().setBackgroundColor_(NSColor.whiteColor().CGColor())
            card2.layer().setCornerRadius_(10.0)
        except Exception:
            pass
        container.addSubview_(card2)

        ttl = NSTextField.alloc().initWithFrame_(((20, 130), (300, 20)))
        ttl.setStringValue_("Application Info")
        ttl.setBezeled_(False)
        ttl.setDrawsBackground_(False)
        ttl.setEditable_(False)
        ttl.setSelectable_(False)
        ttl.setFont_(NSFont.boldSystemFontOfSize_(14))
        card2.addSubview_(ttl)

        info_items = [
            "Version: " + VERSION,
            "Stream Key: " + STREAM_KEY,
            "Messages: ~/.ev_messages.json",
            "Poll Log: ~/.ev_poll_log.json",
            "Launch Agent: " + LAUNCH_AGENT_PATH,
        ]
        for i, item_text in enumerate(info_items):
            ly = 100 - i * 22
            lbl = NSTextField.alloc().initWithFrame_(((20, ly), (cw - 80, 20)))
            lbl.setStringValue_(item_text)
            lbl.setBezeled_(False)
            lbl.setDrawsBackground_(False)
            lbl.setEditable_(False)
            lbl.setSelectable_(True)
            lbl.setFont_(NSFont.systemFontOfSize_(11))
            lbl.setTextColor_(NSColor.grayColor())
            card2.addSubview_(lbl)

        return container

    def _html_base(self, body_html, inject_js=""):
        return """<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>""" + _DASH_CSS + """</style>""" + inject_js + """</head><body>
""" + body_html + """</body></html>"""

    def _html_messages(self):
        status_cn = "Connected" if _status == "connected" else (
            "Retrying..." if "retry" in _status else "Error")
        status_color = ("#34c759" if _status == "connected"
                        else ("#ff9f0a" if "retry" in _status else "#ff3b30"))
        received_data = load_received()
        today_str = datetime.now().strftime("%Y-%m-%d")
        today_data = received_data.get(today_str, {})
        total_server = today_data.get("total_server", 0)
        local_cnt = len(today_data.get("received_idx", []))

        stats_html = (
            '<div class="stats">\n'
            '  <div class="stat-card"><div class="stat-value">' + str(_new_msg_count) + '</div><div class="stat-label">Today</div></div>\n'
            '  <div class="stat-card"><div class="stat-value" style="color:' + status_color + '">' + status_cn + '</div><div class="stat-label">Status</div></div>\n'
            '  <div class="stat-card"><div class="stat-value">' + str(total_server) + '</div><div class="stat-label">Server Total</div></div>\n'
            '  <div class="stat-card"><div class="stat-value">' + str(local_cnt) + '</div><div class="stat-label">Local Received</div></div>\n'
            '  <div class="stat-card"><div class="stat-value">' + str(_recovery_count_today) + '</div><div class="stat-label">Recoveries</div></div>\n'
            '</div>')

        msgs = load_messages()
        entries = []
        for m in msgs[:80]:
            type_cn, detail = _format_message_detail(m)
            css_cls, badge_cls = _TYPE_STYLES.get(
                type_cn, ("type-other", "badge-other"))
            entries.append(
                (m.get("time", ""), type_cn, detail, css_cls, badge_cls))

        polls = load_poll_log()
        for date_str in sorted(polls.keys(), reverse=True):
            for p in polls[date_str].get("polls", []):
                t = date_str + " " + p.get("time", "")
                detail = ("Recovered " + str(p.get("recovered", 0))
                          + " messages - " + p.get("reason", ""))
                entries.append((t, "恢复", detail,
                                "type-recover", "badge-recover"))

        msg_html = ""
        for t, tp, detail, css_cls, badge_cls in entries[:50]:
            time_short = t[-16:] if len(t) >= 16 else t
            detail_safe = (detail.replace("&", "&amp;")
                           .replace("<", "&lt;")
                           .replace(">", "&gt;")
                           .replace('"', "&quot;"))
            msg_html += (
                '<div class="msg-card ' + css_cls + '">'
                '<span class="msg-time">' + time_short + '</span>'
                '<span class="msg-badge ' + badge_cls + '">' + tp + '</span>'
                '<div class="msg-detail">' + detail_safe + '</div>'
                '</div>\n')

        if not msg_html:
            msg_html = (
                '<div class="empty-msg">'
                '<svg viewBox="0 0 48 48" fill="none">'
                '<rect x="6" y="8" width="36" height="32" rx="3" stroke="currentColor" stroke-width="2"/>'
                '<line x1="12" y1="16" x2="36" y2="16" stroke="currentColor" stroke-width="2"/>'
                '<line x1="12" y1="22" x2="30" y2="22" stroke="currentColor" stroke-width="2"/>'
                '<line x1="12" y1="28" x2="24" y2="28" stroke="currentColor" stroke-width="2"/>'
                '</svg>No messages yet</div>')

        body = (
            '<div class="header"><h2>Messages</h2>'
            '<a class="btn-refresh" href="ev://refresh">Refresh</a></div>\n'
            + stats_html + msg_html)
        return self._html_base(body)

    def _html_orders(self):
        orders = _build_order_list()
        rows = ""
        for o in orders[:100]:
            t = o.get("time", "")[-16:] if len(o.get("time", "")) >= 16 else o.get("time", "")
            amt_display = "CNY{:.2f}".format(o.get("amount", 0))
            product_safe = o.get("product", "-")
            product_safe = product_safe.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            redeem_safe = o.get("redeem", "-")
            redeem_safe = redeem_safe.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            rows += ("<tr><td>" + t + "</td>"
                     "<td>" + product_safe + "</td>"
                     "<td>" + amt_display + "</td>"
                     "<td>" + redeem_safe + "</td></tr>\n")
        if not rows:
            rows = ('<tr><td colspan="4" style="text-align:center;padding:40px;color:#86868b">'
                    'No orders</td></tr>')
        table = ('<table><thead><tr>'
                 '<th>Time</th><th>Product</th><th>Amount</th><th>Redeem Code</th>'
                 '</tr></thead><tbody>' + rows + '</tbody></table>')
        body = ('<div class="header"><h2>Order List</h2>'
                '<a class="btn-refresh" href="ev://refresh">Refresh</a></div>\n' + table)
        return self._html_base(body)

    def _html_trend(self):
        dates, counts, amounts = _build_trend_data(30)
        dates_js = json.dumps(list(dates))
        counts_js = json.dumps(list(counts))
        amounts_js = json.dumps(list(amounts))
        js_inject = """
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded',function(){
  var ctx=document.getElementById('trendChart');
  if(!ctx)return;
  new Chart(ctx.getContext('2d'),{
    type:'bar',
    data:{
      labels:""" + dates_js + """,
      datasets:[
        {label:'Orders',data:""" + counts_js + """,backgroundColor:'rgba(0,113,227,0.7)',borderColor:'rgba(0,113,227,1)',borderWidth:1,borderRadius:3,yAxisID:'y'},
        {label:'CNY',data:""" + amounts_js + """,type:'line',borderColor:'rgba(255,69,58,1)',backgroundColor:'rgba(255,69,58,0.1)',borderWidth:2,pointRadius:3,pointBackgroundColor:'rgba(255,69,58,1)',tension:0.3,fill:true,yAxisID:'y1'}
      ]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'top',labels:{usePointStyle:true,padding:20}}},
      scales:{
        y:{type:'linear',position:'left',title:{display:true,text:'Orders'},beginAtZero:true,ticks:{stepSize:1}},
        y1:{type:'linear',position:'right',title:{display:true,text:'CNY'},beginAtZero:true,grid:{drawOnChartArea:false}}
      }
    }
  });
});
</script>"""
        body = ('<div class="header"><h2>30-Day Trend</h2>'
                '<a class="btn-refresh" href="ev://refresh">Refresh</a></div>\n'
                '<div class="chart-wrap"><canvas id="trendChart"></canvas></div>')
        return self._html_base(body, js_inject)

    def _html_visitor(self):
        visitors = _build_visitor_list()
        rows = ""
        for v in visitors[:100]:
            t = v.get("time", "")[-16:] if len(v.get("time", "")) >= 16 else v.get("time", "")
            page = v.get("page", "-")
            page_safe = page.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
            ref = v.get("referrer", "-")
            ref_safe = ref.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
            ip = v.get("ip", "-")
            rows += ("<tr><td>" + t + "</td>"
                     "<td>" + page_safe + "</td>"
                     "<td>" + ref_safe + "</td>"
                     "<td>" + ip + "</td></tr>\n")
        if not rows:
            rows = ('<tr><td colspan="4" style="text-align:center;padding:40px;color:#86868b">'
                    'No visitor data</td></tr>')
        table = ('<table><thead><tr>'
                 '<th>Time</th><th>Page URL</th><th>Referrer</th><th>IP</th>'
                 '</tr></thead><tbody>' + rows + '</tbody></table>')
        body = ('<div class="header"><h2>Visitor Log</h2>'
                '<a class="btn-refresh" href="ev://refresh">Refresh</a></div>\n' + table)
        return self._html_base(body)

    def _switch_page(self, index):
        if _HAS_WEBKIT and self._webview:
            self._webview.setHidden_(index >= 4)
        if self._settings_page:
            self._settings_page.setHidden_(index != 4)
        self._current_tab = index
        if index < 4 and _HAS_WEBKIT and self._webview:
            self._load_web_page(index)

    def _load_web_page(self, index):
        if index == 0:
            html = self._html_messages()
        elif index == 1:
            html = self._html_orders()
        elif index == 2:
            html = self._html_trend()
        else:
            html = self._html_visitor()
        self._webview.loadHTMLString_baseURL_(html, None)

    def toggleAutoStart_(self, sender):
        enabled = (sender.state() == NSOnState)
        if enabled:
            ensure_auto_start()
        else:
            disable_auto_start()
        new_state = get_auto_start()
        if self._auto_start_btn:
            self._auto_start_btn.setState_(NSOnState if new_state else NSOffState)
        if self._auto_start_label:
            self._auto_start_label.setStringValue_(
                "Status: " + ("ON" if new_state else "OFF"))

    def windowWillClose_(self, notification):
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyAccessory)

    def _refresh_content(self):
        if self._auto_start_btn:
            self._auto_start_btn.setState_(
                NSOnState if get_auto_start() else NSOffState)
        if self._auto_start_label:
            self._auto_start_label.setStringValue_(
                "Status: " + ("ON" if get_auto_start() else "OFF"))
        if _HAS_WEBKIT and self._webview and not self._webview.isHidden():
            self._load_web_page(self._current_tab).setAutoresizingMask_(NSViewWidthSizable)
        scroll.setDocumentView_(tv)
        container.addSubview_(scroll)
        self._msg_text = tv
        return container

    def _build_order_list_page(self, cw, ch):
        container = NSView.alloc().initWithFrame_(((0, 0), (cw, ch)))
        container.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)

        scroll = NSScrollView.alloc().initWithFrame_(((10, 10), (cw - 20, ch - 20)))
        scroll.setHasVerticalScroller_(True)
        scroll.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        scroll.setBorderType_(1)

        tv = NSTableView.alloc().initWithFrame_(((0, 0), (cw - 20, ch - 20)))
        tv.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)

        cols_def = [
            ("time", "time", 140),
            ("product", "product", 180),
            ("amount", "amount", 100),
            ("redeem", "redeem", 130),
        ]
        for cid, title, w in cols_def:
            col = NSTableColumn.alloc().initWithIdentifier_(cid)
            col.headerCell().setStringValue_(title)
            col.setWidth_(w)
            col.setMinWidth_(60)
            tv.addTableColumn_(col)

        tv.setDataSource_(self._order_ds)
        tv.setRowHeight_(24)
        tv.reloadData()
        scroll.setDocumentView_(tv)
        container.addSubview_(scroll)
        self._order_table = tv
        return container

    def _build_trend_page(self, cw, ch):
        container = NSView.alloc().initWithFrame_(((0, 0), (cw, ch)))
        container.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)

        legend_y = ch - 28
        bar_label = NSTextField.alloc().initWithFrame_(((20, legend_y), (120, 20)))
        bar_label.setStringValue_("...   orders")
        bar_label.setBezeled_(False)
        bar_label.setDrawsBackground_(False)
        bar_label.setEditable_(False)
        bar_label.setSelectable_(False)
        bar_label.setFont_(NSFont.systemFontOfSize_(11))
        bar_label.setTextColor_(NSColor.colorWithRed_green_blue_alpha_(0.2, 0.6, 1.0, 1.0))
        container.addSubview_(bar_label)

        line_label = NSTextField.alloc().initWithFrame_(((150, legend_y), (120, 20)))
        line_label.setStringValue_("___  CNY")
        line_label.setBezeled_(False)
        line_label.setDrawsBackground_(False)
        line_label.setEditable_(False)
        line_label.setSelectable_(False)
        line_label.setFont_(NSFont.systemFontOfSize_(11))
        line_label.setTextColor_(NSColor.colorWithRed_green_blue_alpha_(1.0, 0.4, 0.3, 1.0))
        container.addSubview_(line_label)

        chart_frame = ((10, 10), (cw - 20, ch - 50))
        chart = TrendChartView.alloc().initWithFrame_(chart_frame)
        chart.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        container.addSubview_(chart)
        self._chart_view = chart
        return container

    def _build_settings_page(self, cw, ch):
        container = NSView.alloc().initWithFrame_(((0, 0), (cw, ch)))
        container.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)

        y = ch - 40
        label = NSTextField.alloc().initWithFrame_(((20, y), (200, 22)))
        label.setStringValue_("...  start")
        label.setBezeled_(False)
        label.setDrawsBackground_(False)
        label.setEditable_(False)
        label.setSelectable_(False)
        label.setFont_(NSFont.systemFontOfSize_(14))
        container.addSubview_(label)

        btn = NSButton.alloc().initWithFrame_(((220, y - 5), (120, 28)))
        btn.setButtonType_(NSSwitchButton)
        btn.setTitle_("")
        btn.setState_(NSOnState if get_auto_start() else NSOffState)
        btn.setTarget_(self)
        btn.setAction_('toggleAutoStart:')
        container.addSubview_(btn)
        self._auto_start_btn = btn

        y -= 50
        self._auto_start_label = NSTextField.alloc().initWithFrame_(((20, y), (400, 22)))
        self._auto_start_label.setStringValue_(
            "current: ON" if get_auto_start() else "current: OFF")
        self._auto_start_label.setBezeled_(False)
        self._auto_start_label.setDrawsBackground_(False)
        self._auto_start_label.setEditable_(False)
        self._auto_start_label.setSelectable_(False)
        self._auto_start_label.setFont_(NSFont.systemFontOfSize_(12))
        self._auto_start_label.setTextColor_(NSColor.grayColor())
        container.addSubview_(self._auto_start_label)

        y -= 40
        info_items = [
            "version: " + VERSION,
            "stream: " + STREAM_KEY,
            "messages: ~/.ev_messages.json",
            "poll log: ~/.ev_poll_log.json",
            "launch agent: " + LAUNCH_AGENT_PATH,
        ]
        for item_text in info_items:
            lbl = NSTextField.alloc().initWithFrame_(((20, y), (400, 20)))
            lbl.setStringValue_(item_text)
            lbl.setBezeled_(False)
            lbl.setDrawsBackground_(False)
            lbl.setEditable_(False)
            lbl.setSelectable_(True)
            lbl.setFont_(NSFont.systemFontOfSize_(11))
            lbl.setTextColor_(NSColor.grayColor())
            container.addSubview_(lbl)
            y -= 22

        return container

    def _switch_page(self, index):
        for i, page in self._pages.items():
            page.setHidden_(i != index)
        self._current_tab = index

    def toggleAutoStart_(self, sender):
        enabled = (sender.state() == NSOnState)
        if enabled:
            ensure_auto_start()
        else:
            disable_auto_start()
        new_state = get_auto_start()
        if self._auto_start_label:
            self._auto_start_label.setStringValue_(
                "current: ON" if new_state else "current: OFF")

    def windowWillClose_(self, notification):
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyAccessory)

    def _refresh_content(self):
        if self._auto_start_btn:
            self._auto_start_btn.setState_(
                NSOnState if get_auto_start() else NSOffState)
        if self._auto_start_label:
            self._auto_start_label.setStringValue_(
                "current: ON" if get_auto_start() else "current: OFF")
        if self._msg_text:
            header = _build_status_text()
            body = _build_messages_text()
            self._msg_text.setString_(
                header + "\n\n" + "=" * 40 + "  recent messages " + "=" * 40 + "\n\n" + body)
        if self._order_ds:
            orders = _build_order_list()
            self._order_ds.setOrders_(orders)
            if self._order_table:
                self._order_table.reloadData()
        if self._chart_view:
            dates, counts, amounts = _build_trend_data(30)
            self._chart_view._dates = list(dates) if dates else []
            self._chart_view._counts = list(counts) if counts else []
            self._chart_view._amounts = list(amounts) if amounts else []
            self._chart_view.setNeedsDisplay_(True)


class EvNotifier(rumps.App):
    def __init__(self):
        super().__init__(f"Ev {VERSION}", quit_button="退出")
        try:
            from AppKit import NSApp, NSApplicationActivationPolicyAccessory
            NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        except Exception:
            pass
        self._thread = threading.Thread(target=_run_event_loop, daemon=True)
        self._thread.start()
        self._dash = DashboardWindow(self)
        ensure_auto_start()

    @rumps.clicked("打开面板")
    def open_dashboard(self, _):
        self._dash.show()

    @rumps.clicked("暂停/恢复通知")
    def toggle_pause(self, _):
        global _paused
        _paused = not _paused
        state_cn = "已暂停" if _paused else "已恢复"
        rumps.notification(f"Ev {VERSION}", "", state_cn, sound=False)

    @rumps.clicked("重置计数")
    def reset_count(self, _):
        global _new_msg_count, _seen_ids
        _new_msg_count = 0
        _seen_ids.clear()
        rumps.notification(f"Ev {VERSION}", "", "计数已重置", sound=False)

    @rumps.clicked("查看轮询日志")
    def view_poll_log(self, _):
        try:
            data = load_poll_log()
            today = datetime.now().strftime("%Y-%m-%d")
            today_data = data.get(today, {})
            today_polls = today_data.get("total_polls_today", 0)
            month_total = sum(len(d.get("polls", [])) for d in data.values())
            lines = []
            for date_str in sorted(data.keys(), reverse=True)[:7]:
                entry = data[date_str]
                for p in entry.get("polls", []):
                    lines.append(
                        f"{date_str} {p['time']}  recovered={p['recovered']}  {p['reason']}")
            if not lines:
                lines.append("暂无恢复轮询记录")
            text = "\n".join(lines)
            rumps.alert(
                f"轮询日志 | 今日: {today_polls} | 本月: {month_total}",
                text[:500]
            )
        except Exception as e:
            rumps.alert("错误", str(e))

    @rumps.clicked("状态")
    def status_btn(self, _):
        ts_str = (time.strftime("%H:%M:%S", time.localtime(_last_msg_ts))
                  if _last_msg_ts else "无")
        status_cn = "已连接" if _status == "connected" else "未连接"
        text = (
            f"状态: {status_cn}\n"
            f"今日收到: {_new_msg_count}\n"
            f"恢复轮询: {_recovery_count_today}\n"
            f"最后消息: {ts_str}"
        )
        rumps.alert(f"Ev {VERSION}", text)


def main():
    global _app_ref
    app = EvNotifier()
    _app_ref = app
    print(f"Ev Notifier {VERSION} started: {REST_API_URL}")
    app.run()


if __name__ == "__main__":
    load_env()
    main()