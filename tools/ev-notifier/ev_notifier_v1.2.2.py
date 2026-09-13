"""Ev Notifier v1.2.2 - native macOS window + Chinese UI + version in menu bar"""
import json, os, re, subprocess, sys, tempfile, time, threading, urllib.parse, plistlib
from datetime import datetime

VERSION = "v1.2.2"

try:
    from AppKit import (NSApplication, NSApplicationActivationPolicyAccessory, NSApplicationActivationPolicyRegular,
                        NSWindow, NSTabView, NSTabViewItem, NSScrollView, NSTextView,
                        NSTextField, NSButton, NSView, NSMakeRect, NSMakeSize,
                        NSTitledWindowMask, NSClosableWindowMask, NSMiniaturizableWindowMask,
                        NSResizableWindowMask, NSBackingStoreBuffered, NSOnState, NSOffState,
                        NSSwitchButton, NSFont, NSColor, NSNotificationCenter,
                        NSWindowWillCloseNotification, NSViewWidthSizable, NSViewHeightSizable)
    from Foundation import NSObject
    _HAS_APPKIT = True
except ImportError:
    _HAS_APPKIT = False

import rumps

DOTENV = [
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env"),
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env.local"),
    os.path.expanduser("~/.ev-notifier.env"),
]
REST_API_URL = None
UPSTASH_TOKEN = None
STREAM_KEY = "auth:notifications:stream"
LAST_ID_FILE = os.path.expanduser("~/.ev_last_id_v1.2.2")
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


class DashboardWindow:
    def __init__(self, app_ref):
        self._app = app_ref
        self._window = None
        self._tab_view = None
        self._msg_text = None
        self._auto_start_btn = None
        self._auto_start_label = None

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
        rect = NSMakeRect(100, 100, 460, 620)
        mask = (NSTitledWindowMask | NSClosableWindowMask |
                NSMiniaturizableWindowMask | NSResizableWindowMask)
        self._window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, mask, NSBackingStoreBuffered, False)
        self._window.setTitle_(f"Ev Notifier {VERSION}")
        self._window.setMinSize_(NSMakeSize(360, 400))

        nc = NSNotificationCenter.defaultCenter()
        nc.addObserver_selector_name_object_(
            self, 'windowWillClose:', NSWindowWillCloseNotification, self._window)

        content_rect = ((0, 0), (460, 600))
        self._tab_view = NSTabView.alloc().initWithFrame_(content_rect)
        self._tab_view.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)

        self._create_messages_tab()
        self._create_settings_tab()

        self._window.contentView().addSubview_(self._tab_view)
        self._window.center()

    def _create_messages_tab(self):
        tab_rect = ((10, 10), (440, 550))

        scroll = NSScrollView.alloc().initWithFrame_(tab_rect)
        scroll.setHasVerticalScroller_(True)
        scroll.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        scroll.setBorderType_(0)

        self._msg_text = NSTextView.alloc().initWithFrame_(tab_rect)
        self._msg_text.setEditable_(False)
        self._msg_text.setSelectable_(True)
        self._msg_text.setVerticallyResizable_(True)
        self._msg_text.setHorizontallyResizable_(False)
        self._msg_text.setFont_(NSFont.fontWithName_size_("Menlo", 13))
        self._msg_text.setTextContainerInset_((8, 8))
        self._msg_text.setAutoresizingMask_(NSViewWidthSizable)

        scroll.setDocumentView_(self._msg_text)

        from AppKit import NSMakeSize as ms
        scroll_size = scroll.contentSize()
        self._msg_text.setFrameSize_(ms(scroll_size.width, scroll_size.height))

        item = NSTabViewItem.alloc().initWithIdentifier_("messages")
        item.setLabel_("消息")
        item.setView_(scroll)
        self._tab_view.addTabViewItem_(item)

    def _create_settings_tab(self):
        view_rect = ((0, 0), (440, 550))
        container = NSView.alloc().initWithFrame_(view_rect)

        y = 520

        label = NSTextField.alloc().initWithFrame_(((20, y), (200, 22)))
        label.setStringValue_("开机自动启动")
        label.setBezeled_(False)
        label.setDrawsBackground_(False)
        label.setEditable_(False)
        label.setSelectable_(False)
        label.setFont_(NSFont.systemFontOfSize_(14))
        container.addSubview_(label)

        btn = NSButton.alloc().initWithFrame_(((300, y - 5), (120, 28)))
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
            "当前: 已启用" if get_auto_start() else "当前: 已禁用")
        self._auto_start_label.setBezeled_(False)
        self._auto_start_label.setDrawsBackground_(False)
        self._auto_start_label.setEditable_(False)
        self._auto_start_label.setSelectable_(False)
        self._auto_start_label.setFont_(NSFont.systemFontOfSize_(12))
        self._auto_start_label.setTextColor_(NSColor.grayColor())
        container.addSubview_(self._auto_start_label)

        y -= 40
        sep = NSTextField.alloc().initWithFrame_(((20, y), (400, 18)))
        sep.setStringValue_("____________________________")
        sep.setBezeled_(False)
        sep.setDrawsBackground_(False)
        sep.setEditable_(False)
        sep.setSelectable_(False)
        sep.setTextColor_(NSColor.lightGrayColor())
        sep.setFont_(NSFont.systemFontOfSize_(10))
        container.addSubview_(sep)

        y -= 40
        info_items = [
            f"版本: {VERSION}",
            f"数据流: {STREAM_KEY}",
            f"消息存储: ~/.ev_messages.json",
            f"轮询日志: ~/.ev_poll_log.json",
            f"启动项: ~/Library/LaunchAgents/com.evnotifier.agent.plist",
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

        item = NSTabViewItem.alloc().initWithIdentifier_("settings")
        item.setLabel_("设置")
        item.setView_(container)
        self._tab_view.addTabViewItem_(item)

    def toggleAutoStart_(self, sender):
        enabled = (sender.state() == NSOnState)
        if enabled:
            ensure_auto_start()
        else:
            disable_auto_start()
        new_state = get_auto_start()
        if self._auto_start_label:
            self._auto_start_label.setStringValue_(
                "当前: 已启用" if new_state else "当前: 已禁用")

    def windowWillClose_(self, notification):
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyAccessory)

    def _refresh_content(self):
        if self._auto_start_btn:
            self._auto_start_btn.setState_(
                NSOnState if get_auto_start() else NSOffState)
        if self._auto_start_label:
            self._auto_start_label.setStringValue_(
                "当前: 已启用" if get_auto_start() else "当前: 已禁用")
        if self._msg_text:
            header = _build_status_text()
            body = _build_messages_text()
            self._msg_text.setString_(
                header + "\n\n" + "=" * 40 + " 最近消息 " + "=" * 40 + "\n\n" + body)


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