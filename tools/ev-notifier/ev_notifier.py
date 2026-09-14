"""Ev Notifier v2.0.0 - PUB/SUB broadcast mode, zero polling cost"""
import json, os, re, subprocess, sys, tempfile, time, threading, urllib.parse, plistlib
from datetime import datetime, timedelta

try:
    import redis
except ImportError:
    redis = None

VERSION = "v2.2.1"

try:
    from AppKit import (NSApplication, NSApplicationActivationPolicyAccessory, NSApplicationActivationPolicyRegular,
                        NSWindow, NSScrollView, NSTextView,
                        NSTextField, NSButton, NSView, NSMakeRect, NSMakeSize,
                        NSTitledWindowMask, NSClosableWindowMask, NSMiniaturizableWindowMask,
                        NSResizableWindowMask, NSBackingStoreBuffered, NSOnState, NSOffState,
                        NSSwitchButton, NSFont, NSColor, NSNotificationCenter,
                        NSWindowWillCloseNotification, NSViewWidthSizable, NSViewHeightSizable)
    from Foundation import NSObject
    _HAS_APPKIT = True
except ImportError:
    _HAS_APPKIT = False

try:
    import webview as _webview_lib
    _HAS_WEBVIEW = True
except ImportError:
    _HAS_WEBVIEW = False

try:
    from WebKit import WebView
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
LAST_ID_FILE = os.path.expanduser("~/.ev_last_id_v1.5.0")
RECEIVED_FILE = os.path.expanduser("~/.ev_received.json")
POLL_LOG_FILE = os.path.expanduser("~/.ev_poll_log.json")
MESSAGES_FILE = os.path.expanduser("~/.ev_messages.json")
VISITORS_FILE = os.path.expanduser("~/.ev_visitors.json")

LAUNCH_AGENT_LABEL = "com.evnotifier.agent"
LAUNCH_AGENT_DIR = os.path.expanduser("~/Library/LaunchAgents")
LAUNCH_AGENT_PATH = os.path.join(LAUNCH_AGENT_DIR, f"{LAUNCH_AGENT_LABEL}.plist")
NOTIFY_SETTINGS_FILE = os.path.expanduser("~/.ev_notify_settings.json")

_MAX_SEEN = 1000


def _safe_str(s):
    if s is None:
        return ""
    s = str(s)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    s = s.replace("{", "&#123;").replace("}", "&#125;")
    return s


_status = "starting"
_last_msg_ts = 0
_new_msg_count = 0
_paused = False
_seen_ids = set()
_app_ref = None
_recovery_count_today = 0
_missing_count = 0
_last_poll_detail = None


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
    old_exists = os.path.exists(LAUNCH_AGENT_PATH)
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
    action = "updated" if old_exists else "enabled"
    print(f"Auto-start {action}: {LAUNCH_AGENT_PATH}")
    try:
        subprocess.run(
            ["launchctl", "bootstrap", f"gui/{os.getuid()}", LAUNCH_AGENT_PATH],
            capture_output=True, timeout=3
        )
    except Exception:
        pass


def disable_auto_start():
    if os.path.exists(LAUNCH_AGENT_PATH):
        try:
            subprocess.run(
                ["launchctl", "bootout", f"gui/{os.getuid()}", LAUNCH_AGENT_PATH],
                capture_output=True, timeout=3
            )
        except Exception:
            pass
        os.unlink(LAUNCH_AGENT_PATH)
        print(f"Auto-start disabled: {LAUNCH_AGENT_PATH}")


def get_auto_start():
    return os.path.exists(LAUNCH_AGENT_PATH)


def load_notify_settings():
    try:
        with open(NOTIFY_SETTINGS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"popup": True, "sound": True}


def save_notify_settings(settings):
    try:
        with open(NOTIFY_SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except Exception:
        pass


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
    if len(msgs) > 500:
        msgs = msgs[:500]
    save_messages(msgs)
    if mtype == "page_visit":
        store_visitor(ts, payload)


def load_visitors():
    try:
        with open(VISITORS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []


def save_visitors(data):
    with open(VISITORS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def store_visitor(ts, payload):
    visitors = load_visitors()
    raw_url = payload.get("page", "") or payload.get("url", "") or payload.get("title", "") or ""
    parsed = urllib.parse.urlparse(raw_url) if raw_url.startswith(("http://", "https://")) else None
    hostname = parsed.hostname or "" if parsed else ""
    path = parsed.path or "" if parsed else ""
    query = urllib.parse.parse_qs(parsed.query) if parsed and parsed.query else {}
    utm_source = (query.get("utm_source", [""])[0] or "")
    utm_medium = (query.get("utm_medium", [""])[0] or "")
    utm_campaign = (query.get("utm_campaign", [""])[0] or "")

    referrer_raw = payload.get("referrer", "") or ""
    referrer_parsed = urllib.parse.urlparse(referrer_raw) if referrer_raw.startswith(("http://", "https://")) else None
    referrer_host = referrer_parsed.hostname or "" if referrer_parsed else ""

    ua = payload.get("user_agent", "") or payload.get("ua", "") or ""
    device_type = "Desktop"
    if ua:
        ua_lower = ua.lower()
        if "iphone" in ua_lower or "ipod" in ua_lower:
            device_type = "iPhone"
        elif "ipad" in ua_lower:
            device_type = "iPad"
        elif "android" in ua_lower:
            device_type = "Android"
        elif "mobile" in ua_lower:
            device_type = "Mobile"

    entry = {
        "ts": ts or int(time.time()),
        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else time.strftime("%Y-%m-%d %H:%M:%S"),
        "url": raw_url,
        "hostname": hostname,
        "path": path,
        "ip": payload.get("ip", "") or "",
        "referrer": referrer_raw,
        "referrer_host": referrer_host,
        "utm_source": utm_source,
        "utm_medium": utm_medium,
        "utm_campaign": utm_campaign,
        "device": device_type,
        "ua": ua[:200],
    }
    visitors.insert(0, entry)
    if len(visitors) > 2000:
        visitors = visitors[:2000]
    save_visitors(visitors)


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
        "type": "manual",
        "reason": reason,
        "recovered": recovered
    }
    data[date_str]["polls"].append(entry)
    data[date_str]["total_polls_today"] = len(data[date_str]["polls"])
    data[date_str]["last_poll_hour"] = datetime.now().hour
    save_poll_log(data)
    _recovery_count_today = data[date_str]["total_polls_today"]
    clean_old_logs()


def record_message(msg_id, idx=None, total_daily=None, date_str=None):
    global _missing_count
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d")
    data = load_received()
    if date_str not in data:
        data[date_str] = {"total_server": 0, "received_idx": [], "last_check": ""}
    if idx is not None and idx not in data[date_str]["received_idx"]:
        data[date_str]["received_idx"].append(idx)
        data[date_str]["received_idx"].sort()
    if total_daily is not None:
        data[date_str]["total_server"] = total_daily
    data[date_str]["last_check"] = datetime.now().strftime("%H:%M:%S")
    save_received(data)
    local_cnt = len(data[date_str]["received_idx"])
    server_cnt = data[date_str]["total_server"]
    _missing_count = max(0, server_cnt - local_cnt)
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
    total = day_data.get("total_server", 0)
    received = day_data.get("received_idx", [])
    local_cnt = len(received)
    if total <= 0:
        return 0
    return max(0, total - local_cnt)


def do_recovery_poll(last_id):
    global _missing_count
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
            idx = None
            total_daily = None
            msg_date = None
            data_raw = _extract_field(fields, "data")
            if data_raw:
                try:
                    msg = json.loads(data_raw)
                    idx = msg.get("idx")
                    total_daily = msg.get("total_daily")
                    msg_date = msg.get("date")
                    handle_message(msg)
                except Exception:
                    pass
            record_message(msg_id, idx=idx, total_daily=total_daily, date_str=msg_date)
            recovered += 1
            last_id = msg_id
        save_last_id(last_id)
        record_poll("loss_detected", recovered)
        print(f"RECOVERY: done, recovered={recovered}, missing={_missing_count}")
        return last_id
    except Exception as e:
        print(f"RECOVERY: failed - {e}")
        return last_id


def notify_macos(title, subtitle, body, sound=False):
    try:
        safe_title = title.replace('"', "'")
        safe_body = (subtitle + "\n" + body).replace('"', "'")
        if sound:
            script = f'display notification "{safe_body}" with title "{safe_title}" sound name "default"'
        else:
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
        ip = p.get("ip", "")
        referrer = p.get("referrer", "")
        title = "Page Visit"
        subtitle = page
        lines = []
        if ip:
            lines.append(f"IP: {ip}")
        if referrer:
            lines.append(f"Referrer: {referrer[:80]}")
        lines.append(ts_label)
        body = "\n".join(lines)
    else:
        body = json.dumps(p, ensure_ascii=False, indent=2)[:200]
    print(f"[{ts_label}] {title} | {subtitle}")
    nsettings = load_notify_settings()
    do_popup = nsettings.get("popup", True)
    do_sound = nsettings.get("sound", True)
    if do_popup:
        notify_macos(title, subtitle, body, sound=do_sound)
    store_message(ts, mtype, p)
    if _app_ref:
        _app_ref.title = f"Ev {VERSION}({_new_msg_count})"


def redis_loop():
    global _status, _new_msg_count
    reconnect_delay = 1
    from urllib.parse import urlparse
    redis_host = urlparse(REST_API_URL).hostname
    last_id = load_last_id()
    print(f"Ev online: PUB/SUB mode, channel=auth:push_channel, host={redis_host}")

    while True:
        try:
            _status = "connecting"
            if _app_ref:
                _app_ref.title = f"Ev {VERSION} 连接中..."
            r = redis.Redis(
                host=redis_host,
                port=6379,
                password=UPSTASH_TOKEN,
                ssl=True,
                ssl_cert_reqs=None,
                socket_connect_timeout=10,
                socket_keepalive=True,
                health_check_interval=30,
            )
            r.ping()
            pubsub = r.pubsub()
            pubsub.subscribe("auth:push_channel")
            _status = "connected"
            reconnect_delay = 1
            if _app_ref:
                if _missing_count > 0:
                    _app_ref.title = f"Ev {VERSION}({_new_msg_count}) ⚠{_missing_count}"
                elif _new_msg_count:
                    _app_ref.title = f"Ev {VERSION}({_new_msg_count})"
                else:
                    _app_ref.title = f"Ev {VERSION}"
            print("Ev SUBSCRIBE OK, waiting for messages...")
            for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                data_raw = message.get("data")
                if not data_raw:
                    continue
                try:
                    if isinstance(data_raw, bytes):
                        data_raw = data_raw.decode("utf-8")
                    msg = json.loads(data_raw)
                except Exception:
                    continue
                idx = msg.get("idx")
                total_daily = msg.get("total_daily")
                msg_date = msg.get("date")
                msg_id = str(msg.get("ts", ""))
                handle_message(msg)
                record_message(msg_id, idx=idx, total_daily=total_daily, date_str=msg_date)
                if _app_ref:
                    if _missing_count > 0:
                        _app_ref.title = f"Ev {VERSION}({_new_msg_count}) ⚠{_missing_count}"
                    elif _new_msg_count:
                        _app_ref.title = f"Ev {VERSION}({_new_msg_count})"
                    else:
                        _app_ref.title = f"Ev {VERSION}"
        except Exception as e:
            print(f"SUBSCRIBE error: {e}, retrying in {reconnect_delay}s...")
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
    type_label = mtype
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
        type_label = "Activation"
    elif mtype == "new_order":
        product = p.get("product_name", "") or ""
        amount = p.get("total_amount") or p.get("amount") or ""
        if amount:
            try:
                amount = f" CNY{int(amount)/100:.2f}"
            except Exception:
                amount = ""
        detail = f"{product}{amount}"
        type_label = "Order"
    elif mtype == "page_visit":
        page = p.get("page", "") or p.get("title", "") or ""
        ip = p.get("ip", "")
        detail = page
        if ip:
            detail += f" | IP: {ip}"
        type_label = "Visit"
    elif mtype == "test_curl":
        detail = json.dumps(p, ensure_ascii=False)[:100]
        type_label = "Test"
    else:
        detail = json.dumps(p, ensure_ascii=False)[:100]
        type_label = "Other"
    return type_label, detail


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


def _build_visitor_stats():
    visitors = load_visitors()
    today = datetime.now().strftime("%Y-%m-%d")
    today_count = sum(1 for v in visitors if v.get("time", "").startswith(today))

    hostname_counts = {}
    page_counts = {}
    ip_set = set()
    device_counts = {}
    source_counts = {}
    referrer_host_counts = {}

    for v in visitors:
        host = v.get("hostname", "") or "(unknown)"
        hostname_counts[host] = hostname_counts.get(host, 0) + 1

        page = v.get("path", "") or "/"
        full = (host + page) if host else page
        page_counts[full] = page_counts.get(full, 0) + 1

        ip = v.get("ip", "")
        if ip:
            ip_set.add(ip)

        dev = v.get("device", "") or "Unknown"
        device_counts[dev] = device_counts.get(dev, 0) + 1

        src = v.get("utm_source", "")
        if src:
            source_counts[src] = source_counts.get(src, 0) + 1

        rh = v.get("referrer_host", "")
        if rh:
            referrer_host_counts[rh] = referrer_host_counts.get(rh, 0) + 1

    top_hosts = sorted(hostname_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    top_pages = sorted(page_counts.items(), key=lambda x: x[1], reverse=True)[:10]
    top_devices = sorted(device_counts.items(), key=lambda x: x[1], reverse=True)
    top_sources = sorted(source_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    top_referrers = sorted(referrer_host_counts.items(), key=lambda x: x[1], reverse=True)[:5]

    return {
        "total": len(visitors),
        "today": today_count,
        "unique_ips": len(ip_set),
        "unique_hosts": len(hostname_counts),
        "top_hosts": top_hosts,
        "top_pages": top_pages,
        "top_devices": top_devices,
        "top_sources": top_sources,
        "top_referrers": top_referrers,
    }


_DASH_CSS = """
:root {
  --bg: #f5f7fa;
  --sidebar-bg: #0f1419;
  --sidebar-hover: #1c2128;
  --sidebar-active: #3b82f6;
  --sidebar-text: #8b949e;
  --sidebar-text-active: #f0f6fc;
  --card-bg: #ffffff;
  --text: #1f2937;
  --text-secondary: #6b7280;
  --text-tertiary: #9ca3af;
  --blue: #3b82f6;
  --blue-light: #dbeafe;
  --green: #10b981;
  --green-light: #d1fae5;
  --orange: #f59e0b;
  --orange-light: #fef3c7;
  --red: #ef4444;
  --red-light: #fee2e2;
  --purple: #8b5cf6;
  --purple-light: #ede9fe;
  --border: #e5e7eb;
  --border-light: #f3f4f6;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.04);
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -2px rgba(0,0,0,0.04);
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;
  --sidebar-w: 240px;
  --topbar-h: 64px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  height: 100%;
  min-height: 100vh;
  overflow: hidden;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-size: 13px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
}

.layout {
  display: flex;
  height: 100vh;
  background: linear-gradient(135deg, #f5f7fa 0%, #ebf0f5 100%);
}

/* =================== SIDEBAR =================== */
.sidebar {
  width: var(--sidebar-w);
  background: var(--sidebar-bg);
  color: var(--sidebar-text);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  box-shadow: 2px 0 20px rgba(0,0,0,0.15);
  z-index: 10;
}

.sidebar-brand {
  padding: 24px 20px 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

.brand-logo {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #ec4899 100%);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 15px;
  color: white;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
}

.brand-text {
  font-size: 15px;
  font-weight: 600;
  color: #f0f6fc;
  letter-spacing: -0.01em;
}

.brand-ver {
  font-size: 10px;
  color: var(--sidebar-text);
  opacity: 0.7;
  margin-top: 2px;
}

.sidebar-nav {
  flex: 1;
  padding: 16px 12px;
  overflow-y: auto;
}

.nav-group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(255,255,255,0.3);
  padding: 20px 14px 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 4px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--sidebar-text);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  text-decoration: none;
}

.nav-item:hover {
  background: var(--sidebar-hover);
  color: #f0f6fc;
}

.nav-item.active {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(139, 92, 246, 0.15));
  color: var(--sidebar-text-active);
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.2);
}

.nav-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav-icon svg { width: 18px; height: 18px; }

.nav-badge {
  margin-left: auto;
  background: linear-gradient(135deg, #ef4444, #f97316);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 12px;
  min-width: 20px;
  text-align: center;
  box-shadow: 0 2px 4px rgba(239, 68, 68, 0.3);
}

.sidebar-footer {
  padding: 16px;
  border-top: 1px solid rgba(255,255,255,0.06);
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: rgba(255,255,255,0.04);
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.05);
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--red);
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
}

.status-dot.online { 
  background: var(--green); 
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
  animation: pulse 2s infinite; 
}
.status-dot.retry { 
  background: var(--orange); 
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.5);
  animation: pulse 1s infinite; 
}

.status-label {
  font-size: 12px;
  color: #f0f6fc;
  flex: 1;
  font-weight: 500;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.95); }
}

/* =================== MAIN CONTENT =================== */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  height: var(--topbar-h);
  background: rgba(255,255,255,0.8);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
  flex-shrink: 0;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
}

.page-subtitle {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.version-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: 20px;
  background: linear-gradient(135deg, #ede9fe, #ddd6fe);
  color: #7c3aed;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.btn {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 16px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}

.btn:hover { 
  background: #f9fafb; 
  border-color: #d1d5db; 
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0,0,0,0.06);
}
.btn:active {
  transform: translateY(0);
}

.btn-primary {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}
.btn-primary:hover { 
  background: linear-gradient(135deg, #2563eb, #1d4ed8); 
  border-color: transparent;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px;
}

.content::-webkit-scrollbar { width: 8px; }
.content::-webkit-scrollbar-track { background: transparent; }
.content::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
.content::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

/* =================== STAT CARDS =================== */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: var(--card-bg);
  border-radius: var(--radius-lg);
  padding: 20px 22px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-light);
  display: flex;
  align-items: flex-start;
  gap: 16px;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.stat-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--blue), var(--purple));
  opacity: 0;
  transition: opacity 0.25s ease;
}

.stat-card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-3px);
  border-color: var(--blue);
}

.stat-card:hover::before {
  opacity: 1;
}

.stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-icon.blue { background: linear-gradient(135deg, #dbeafe, #bfdbfe); color: #2563eb; }
.stat-icon.green { background: linear-gradient(135deg, #d1fae5, #a7f3d0); color: #059669; }
.stat-icon.orange { background: linear-gradient(135deg, #fef3c7, #fde68a); color: #d97706; }
.stat-icon.purple { background: linear-gradient(135deg, #ede9fe, #ddd6fe); color: #7c3aed; }
.stat-icon.red { background: linear-gradient(135deg, #fee2e2, #fecaca); color: #dc2626; }

.stat-icon svg { width: 22px; height: 22px; }

.stat-body { flex: 1; min-width: 0; }

.stat-value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--text);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.stat-value.small { font-size: 15px; font-weight: 600; }

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
  font-weight: 500;
}

/* =================== CARDS / PANELS =================== */
.panel {
  background: var(--card-bg);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-light);
  margin-bottom: 20px;
  overflow: hidden;
}

.panel-header {
  padding: 18px 24px;
  border-bottom: 1px solid var(--border-light);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-title-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: linear-gradient(135deg, #dbeafe, #ede9fe);
  color: var(--blue);
  display: flex;
  align-items: center;
  justify-content: center;
}

.panel-title-icon svg { width: 14px; height: 14px; }

.panel-body { padding: 20px 24px; }

/* =================== MESSAGE LIST =================== */
.msg-list { display: flex; flex-direction: column; }

.msg-card {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-light);
  display: flex;
  align-items: flex-start;
  gap: 16px;
  transition: all 0.15s ease;
}

.msg-card:last-child { border-bottom: none; }
.msg-card:hover { background: linear-gradient(90deg, #f8fafc, #f1f5f9); }

.msg-indicator {
  width: 4px;
  height: 40px;
  border-radius: 2px;
  flex-shrink: 0;
  align-self: center;
}

.msg-indicator.type-order { background: linear-gradient(180deg, #10b981, #059669); }
.msg-indicator.type-activate { background: linear-gradient(180deg, #f59e0b, #d97706); }
.msg-indicator.type-visit { background: linear-gradient(180deg, #8b5cf6, #7c3aed); }
.msg-indicator.type-recover { background: linear-gradient(180deg, #3b82f6, #2563eb); }
.msg-indicator.type-other { background: linear-gradient(180deg, #9ca3af, #6b7280); }

.msg-time {
  font-size: 12px;
  color: var(--text-tertiary);
  min-width: 130px;
  font-variant-numeric: tabular-nums;
  padding-top: 3px;
}

.msg-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 20px;
  white-space: nowrap;
  letter-spacing: 0.03em;
  flex-shrink: 0;
  align-self: flex-start;
}

.msg-badge.badge-order { background: linear-gradient(135deg, #d1fae5, #a7f3d0); color: #047857; }
.msg-badge.badge-activate { background: linear-gradient(135deg, #fef3c7, #fde68a); color: #b45309; }
.msg-badge.badge-visit { background: linear-gradient(135deg, #ede9fe, #ddd6fe); color: #6d28d9; }
.msg-badge.badge-recover { background: linear-gradient(135deg, #dbeafe, #bfdbfe); color: #1d4ed8; }
.msg-badge.badge-other { background: #f3f4f6; color: #4b5563; }

.msg-detail {
  font-size: 13px;
  color: var(--text);
  flex: 1;
  line-height: 1.6;
  padding-top: 3px;
  word-break: break-all;
}

/* =================== TABLE =================== */
.table-wrap { overflow-x: auto; }

table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

thead { position: sticky; top: 0; z-index: 1; }

th {
  text-align: left;
  padding: 14px 24px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  background: #f8fafc;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}

td {
  padding: 14px 24px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

tr:last-child td { border-bottom: none; }
tr:hover td { background: linear-gradient(90deg, #f8fafc, #f1f5f9); }

.amount { font-weight: 600; color: #059669; }

/* =================== CHART =================== */
.chart-wrap {
  background: var(--card-bg);
  border-radius: var(--radius-lg);
  padding: 28px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-light);
  height: 420px;
}

.chart-wrap canvas { max-height: 380px; width: 100% !important; }

/* =================== EMPTY STATE =================== */
.empty-state {
  text-align: center;
  padding: 80px 24px;
  color: var(--text-tertiary);
}

.empty-icon {
  width: 72px;
  height: 72px;
  margin: 0 auto 20px;
  background: linear-gradient(135deg, #f3f4f6, #e5e7eb);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.04);
}

.empty-icon svg { width: 32px; height: 32px; opacity: 0.35; }

.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.empty-desc {
  font-size: 13px;
  color: var(--text-tertiary);
}

/* =================== VISITOR SPECIFIC =================== */
.url-full {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.6;
}

.url-hostname {
  color: #2563eb;
  font-weight: 600;
}

.url-path { color: var(--text); }

.device-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  background: #f3f4f6;
  color: var(--text-secondary);
}

.device-tag.iPhone { background: linear-gradient(135deg, #dbeafe, #bfdbfe); color: #2563eb; }
.device-tag.Android { background: linear-gradient(135deg, #d1fae5, #a7f3d0); color: #059669; }
.device-tag.Desktop { background: #f3f4f6; color: #4b5563; }

.utm-box {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.utm-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 6px;
  background: linear-gradient(135deg, #ede9fe, #ddd6fe);
  color: #6d28d9;
}

.bar-chart { display: flex; flex-direction: column; gap: 12px; }

.bar-row {
  display: grid;
  grid-template-columns: 1fr 80px 40px;
  align-items: center;
  gap: 14px;
}

.bar-label {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  height: 8px;
  background: linear-gradient(180deg, #f3f4f6, #e5e7eb);
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #8b5cf6);
  border-radius: 4px;
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.bar-count {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* =================== SETTINGS PAGE =================== */
.settings-group { margin-bottom: 32px; }

.settings-group-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
  margin-bottom: 14px;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  margin-bottom: 10px;
  transition: all 0.2s ease;
}

.settings-row:hover {
  border-color: var(--blue);
  box-shadow: var(--shadow-md);
}

.settings-row-label {
  font-size: 14px;
  font-weight: 500;
}

.settings-row-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

.settings-info {
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 12px 20px;
  padding: 20px 24px;
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}

.settings-info-key {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 600;
}

.settings-info-val {
  font-size: 12px;
  color: var(--text);
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
  word-break: break-all;
}

/* =================== RESPONSIVE =================== */
@media (max-width: 1200px) {
  .stats-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .sidebar {
    width: 200px;
  }
}

.spinner{width:40px;height:40px;border:4px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.badge { display:inline-block; padding:2px 10px; border-radius:99px; font-size:11px; font-weight:600; letter-spacing:0.02em; }
.badge-auto { background:linear-gradient(135deg, #d1fae5, #a7f3d0); color:#047857; }
.badge-manual { background:linear-gradient(135deg, #ede9fe, #ddd6fe); color:#6d28d9; }
.badge-broadcast { background:linear-gradient(135deg, #dbeafe, #bfdbfe); color:#1d4ed8; }

.chart-bar-group { display:flex; align-items:flex-end; gap:12px; height:120px; padding:8px 0; }
.chart-bar-item { display:flex; flex-direction:column; align-items:center; flex:1; height:100%; }
.chart-bar { width:100%; max-width:40px; background:linear-gradient(180deg, #3b82f6, #60a5fa); border-radius:6px 6px 0 0; transition:height .3s ease; min-height:4px; }
.chart-label { font-size:11px; color:var(--text-secondary); margin-top:6px; font-variant-numeric:tabular-nums; }

.message-table { width:100%; border-collapse:collapse; }
.message-table th { padding:10px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-secondary); background:#f8fafc; border-bottom:1px solid var(--border); text-align:left; }
.message-table td { padding:10px 16px; font-size:13px; border-bottom:1px solid var(--border-light); color:var(--text); }
.message-table tr:hover td { background:#f8fafc; }
.td-time { color:var(--text-secondary); font-size:12px !important; white-space:nowrap; }
.td-type { text-align:center; }
"""

_TYPE_STYLES = {
    "Order": ("type-order", "badge-order"),
    "Activation": ("type-activate", "badge-activate"),
    "Visit": ("type-visit", "badge-visit"),
    "Recovery": ("type-recover", "badge-recover"),
    "Test": ("type-other", "badge-other"),
    "Other": ("type-other", "badge-other"),
}

_MENU = [
    {"id": "messages", "label": "消息", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>', "group": "main"},
    {"id": "orders", "label": "订单列表", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>', "group": "main"},
    {"id": "visitors", "label": "访客浏览", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>', "group": "main"},
    {"id": "trend", "label": "走势图", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>', "group": "analytics"},
    {"id": "devices", "label": "设备", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>', "group": "analytics"},
    {"id": "polls", "label": "轮询统计", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>', "group": "analytics"},
    {"id": "settings", "label": "设置", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', "group": "system"},
]

_GROUP_LABELS = {
    "main": "概览",
    "analytics": "分析",
    "system": "系统",
}


class WebNavDelegate(NSObject):
    def init(self):
        self._dashboard = None
        return self

    def webView_decidePolicyForNavigationAction_request_frame_decisionListener_(self, wv, info, request, frame, listener):
        url_str = str(request.URL()) if request and request.URL() else ""
        _debug_log(f"navAction url={url_str}")
        if url_str and url_str.startswith("ev://"):
            if "refresh" in url_str and self._dashboard:
                self._dashboard._refresh_content()
            elif "poll=now" in url_str and self._dashboard:
                self._dashboard._poll_now()
            elif "setting=" in url_str and self._dashboard:
                try:
                    kv = url_str.split("setting=")[1]
                    self._dashboard._toggle_notify_setting(kv)
                except Exception:
                    pass
            elif "nav=" in url_str and self._dashboard:
                try:
                    page_id = url_str.split("nav=")[1]
                    self._dashboard._switch_to(page_id)
                except Exception:
                    pass
            listener.ignore()
        else:
            listener.use()


def _debug_log(msg):
    with open(os.path.expanduser("~/.ev_debug.log"), "a") as f:
        f.write(f"[{datetime.now().strftime('%H:%M:%S.%f')}] {msg}\n")


class DashboardWindow:
    def __init__(self, app_ref):
        self._app = app_ref
        self._window = None
        self._webview = None
        self._msg_text = None
        self._current_page = "messages"
        self._webview_thread = None
        self._nav_delegate = None
        _debug_log("DashboardWindow.__init__")

    def show(self):
        _debug_log("show() called, _HAS_WEBKIT=%s, _HAS_WEBVIEW=%s" % (str(_HAS_WEBKIT), str(_HAS_WEBVIEW)))

        if _HAS_WEBKIT:
            if self._window is None:
                self._create_window()
            self._show_loading()
            self._window.center()
            self._window.makeKeyAndOrderFront_(None)
            self._window.orderFrontRegardless()
            NSApplication.sharedApplication().setActivationPolicy_(
                NSApplicationActivationPolicyAccessory)
            return

        html = self._build_current_html()
        html_path = os.path.expanduser("~/.ev_dashboard.html")
        with open(html_path, "w") as f:
            f.write(html)
        _debug_log("HTML written to %s, len=%d" % (html_path, len(html)))

        if _HAS_WEBVIEW:
            script = (
                "import webview, sys\n"
                "with open(%r, 'r') as f:\n"
                "    html = f.read()\n"
                "window = webview.create_window(%r, html=html, "
                "width=1100, height=720, min_size=(900, 560), "
                "resizable=True, confirm_close=False)\n"
                "webview.start(debug=False)\n"
            ) % (html_path, f"Ev Notifier {VERSION}")
            try:
                subprocess.Popen([sys.executable, "-c", script],
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
                _debug_log("webview subprocess launched")
            except Exception as e:
                _debug_log("ERROR launching webview subprocess: %s" % e)
        else:
            _debug_log("no webview available, fallback to browser")
            try:
                from Foundation import NSURL
                from AppKit import NSWorkspace
                file_url = NSURL.fileURLWithPath_(html_path)
                NSWorkspace.sharedWorkspace().openURL_(file_url)
            except Exception as e:
                _debug_log("ERROR in show fallback: %s" % e)

    def _show_loading(self):
        if not _HAS_WEBKIT or not self._webview:
            return
        loading_html = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#f5f7fa}
body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.spinner{width:40px;height:40px;border:4px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
p{color:#6b7280;font-size:14px;margin-top:16px}
</style></head><body><div><div class="spinner"></div><p>Loading...</p></div><script>setTimeout(function(){window.location='ev://refresh';},50);</script></body></html>"""
        import base64
        b64 = base64.b64encode(loading_html.encode("utf-8")).decode("ascii")
        self._webview.setMainFrameURL_("data:text/html;base64," + b64)

    def _create_window(self):
        rect = NSMakeRect(100, 100, 1100, 720)
        mask = (NSTitledWindowMask | NSClosableWindowMask |
                NSMiniaturizableWindowMask | NSResizableWindowMask)
        self._window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, mask, NSBackingStoreBuffered, False)
        self._window.setTitle_(f"Ev Notifier {VERSION}")
        self._window.setMinSize_(NSMakeSize(900, 560))

        nc = NSNotificationCenter.defaultCenter()
        nc.addObserver_selector_name_object_(
            self, 'windowWillClose:', NSWindowWillCloseNotification, self._window)

        if _HAS_WEBKIT:
            self._nav_delegate = WebNavDelegate.alloc().init()
            self._nav_delegate._dashboard = self
            self._webview = WebView.alloc().initWithFrame_(
                ((0, 0), (rect[1][0], rect[1][1])))
            self._webview.setAutoresizingMask_(
                NSViewWidthSizable | NSViewHeightSizable)
            self._webview.setPolicyDelegate_(self._nav_delegate)
            self._window.contentView().addSubview_(self._webview)
        else:
            scroll = NSScrollView.alloc().initWithFrame_(
                ((10, 10), (rect[1][0] - 20, rect[1][1] - 20)))
            scroll.setHasVerticalScroller_(True)
            scroll.setAutoresizingMask_(
                NSViewWidthSizable | NSViewHeightSizable)
            scroll.setBorderType_(1)
            tv = NSTextView.alloc().initWithFrame_(
                ((0, 0), (rect[1][0] - 20, rect[1][1] - 20)))
            tv.setEditable_(False)
            tv.setSelectable_(True)
            tv.setVerticallyResizable_(True)
            tv.setHorizontallyResizable_(False)
            tv.setFont_(NSFont.fontWithName_size_("Menlo", 13))
            tv.setAutoresizingMask_(NSViewWidthSizable)
            scroll.setDocumentView_(tv)
            self._msg_text = tv
            self._window.contentView().addSubview_(scroll)

        self._window.center()

    def _build_status_summary(self):
        status_cn = "Connected" if _status == "connected" else ("Retrying..." if "retry" in _status else "Error")
        return f"状态: {status_cn} | 消息: {_new_msg_count} | 版本: {VERSION}"

    def _build_messages_text(self):
        msgs = load_messages()
        polls = load_poll_log()
        entries = []
        for m in msgs[:100]:
            type_label, detail = _format_message_detail(m)
            entries.append({"time": m.get("time", ""), "type": type_label, "detail": detail})
        for date_str in sorted(polls.keys(), reverse=True):
            for p in polls[date_str].get("polls", []):
                entries.append({
                    "time": f"{date_str} {p.get('time', '')}",
                    "type": "Recovery",
                    "detail": f"Recovered {p.get('recovered', 0)} messages",
                })
        if not entries:
            return "No messages"
        return "\n".join(f"[{e['time']}] [{e['type']}] {e['detail']}" for e in entries[:30])

    def _sidebar_html(self):
        groups = {}
        for item in _MENU:
            g = item["group"]
            if g not in groups:
                groups[g] = []
            groups[g].append(item)

        nav_html = ""
        for g in ["main", "analytics", "system"]:
            items = groups.get(g, [])
            if not items:
                continue
            nav_html += f'<div class="nav-group-label">{_GROUP_LABELS[g]}</div>\n'
            for item in items:
                active_cls = "active" if item["id"] == self._current_page else ""
                badge_html = ""
                if item["id"] == "messages" and _new_msg_count > 0:
                    badge_html = f'<span class="nav-badge">{min(_new_msg_count, 99)}</span>'
                nav_html += (
                    f'<div class="nav-item {active_cls}" data-tab="{item["id"]}">'
                    f'<span class="nav-icon">{item["icon"]}</span>'
                    f'<span>{item["label"]}</span>'
                    f'{badge_html}'
                    f'</div>\n'
                )

        if _status == "connected":
            dot_cls = "online"
            status_text = "Online"
        elif "retry" in _status:
            dot_cls = "retry"
            status_text = "Reconnecting..."
        else:
            dot_cls = ""
            status_text = "Offline"

        sidebar = f"""
        <div class="sidebar">
          <div class="sidebar-brand">
            <div class="brand-logo">Ev</div>
            <div>
              <div class="brand-text">Ev Notifier</div>
              <div class="brand-ver">{VERSION}</div>
            </div>
          </div>
          <div class="sidebar-nav">{nav_html}</div>
          <div class="sidebar-footer">
            <div class="status-bar">
              <span class="status-dot {dot_cls}"></span>
              <span class="status-label">{status_text}</span>
            </div>
          </div>
        </div>
        """
        return sidebar

    def _topbar_html(self, title, subtitle=""):
        refresh_btn = '<a class="btn" href="javascript:location.reload()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>刷新</a>'
        sub_html = f'<div class="page-subtitle">{subtitle}</div>' if subtitle else ""
        return f"""
        <div class="topbar">
          <div>
            <div class="page-title">{title}</div>
            {sub_html}
          </div>
          <div class="topbar-actions">
            <span class="version-badge">{VERSION}</span>
            {refresh_btn}
          </div>
        </div>
        """

    def _html_wrap(self, content, title, subtitle="", scripts=""):
        sidebar = self._sidebar_html()
        topbar = self._topbar_html(title, subtitle)
        return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>{_DASH_CSS}</style></head>
<body><div class="layout">{sidebar}<div class="main">{topbar}<div class="content">{content}</div></div></div>{scripts}</body></html>"""

    def _html_messages(self):
        received_data = load_received()
        today_str = datetime.now().strftime("%Y-%m-%d")
        today_data = received_data.get(today_str, {})
        total_server = today_data.get("total_server", 0)
        local_cnt = len(today_data.get("received_idx", []))

        stats_html = f"""
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div>
            <div class="stat-body"><div class="stat-value">{_new_msg_count}</div><div class="stat-label">今日消息</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon {'green' if _status == 'connected' else 'orange'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
            <div class="stat-body"><div class="stat-value small" style="color:{'var(--green)' if _status == 'connected' else 'var(--orange)'};">{"Online" if _status == "connected" else ("Reconnecting" if "retry" in _status else "Offline")}</div><div class="stat-label">连接状态</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
            <div class="stat-body"><div class="stat-value">{total_server}</div><div class="stat-label">服务器总量</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
            <div class="stat-body"><div class="stat-value">{local_cnt}</div><div class="stat-label">本地接收</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></div>
            <div class="stat-body"><div class="stat-value">{_recovery_count_today}</div><div class="stat-label">恢复次数</div></div>
          </div>
        </div>"""

        msgs = load_messages()
        entries = []
        for m in msgs[:80]:
            type_label, detail = _format_message_detail(m)
            css_cls, badge_cls = _TYPE_STYLES.get(type_label, ("type-other", "badge-other"))
            entries.append((m.get("time", ""), type_label, detail, css_cls, badge_cls))

        polls = load_poll_log()
        for date_str in sorted(polls.keys(), reverse=True):
            for p in polls[date_str].get("polls", []):
                t = date_str + " " + p.get("time", "")
                detail = f"Recovered {p.get('recovered', 0)} messages - {p.get('reason', '')}"
                entries.append((t, "Recovery", detail, "type-recover", "badge-recover"))

        msg_html = ""
        for t, tp, detail, css_cls, badge_cls in entries[:50]:
            time_short = _safe_str(t[-16:] if len(t) >= 16 else t)
            detail_safe = _safe_str(detail)
            msg_html += (
                f'<div class="msg-card">'
                f'<div class="msg-indicator {css_cls}"></div>'
                f'<span class="msg-time">{time_short}</span>'
                f'<span class="msg-badge {badge_cls}">{_safe_str(tp)}</span>'
                f'<div class="msg-detail">{detail_safe}</div>'
                f'</div>\n')

        if not msg_html:
            msg_html = ('<div class="empty-state">'
                        '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="14" y2="12"/><line x1="7" y1="16" x2="11" y2="16"/></svg></div>'
                        '<div class="empty-title">暂无消息</div>'
                        '<div class="empty-desc">等待通知...</div></div>')

        body = f'<div class="panel"><div class="panel-header"><div class="panel-title"><div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>活动流</div></div><div class="msg-list">{msg_html}</div></div>'
        return body

    def _html_orders(self):
        orders = _build_order_list()
        total_amount = sum(o.get("amount", 0) for o in orders)
        total_count = len(orders)
        today_str = datetime.now().strftime("%Y-%m-%d")
        today_orders = [o for o in orders if o.get("time", "").startswith(today_str)]
        today_amount = sum(o.get("amount", 0) for o in today_orders)

        stats_html = f"""
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div>
            <div class="stat-body"><div class="stat-value">{total_count}</div><div class="stat-label">订单总量</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
            <div class="stat-body"><div class="stat-value amount">CNY{total_amount:.2f}</div><div class="stat-label">收入总额</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
            <div class="stat-body"><div class="stat-value">{len(today_orders)}</div><div class="stat-label">Today</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg></div>
            <div class="stat-body"><div class="stat-value amount">CNY{today_amount:.2f}</div><div class="stat-label">今日收入</div></div>
          </div>
        </div>"""

        rows = ""
        for o in orders[:100]:
            t = o.get("time", "")[-16:] if len(o.get("time", "")) >= 16 else o.get("time", "")
            amt_display = f"CNY{o.get('amount', 0):.2f}"
            product_safe = _safe_str(o.get("product", "-"))
            redeem_safe = _safe_str(o.get("redeem", "-"))
            rows += (f"<tr><td>{t}</td><td>{product_safe}</td>"
                     f'<td class="amount">{amt_display}</td><td>{redeem_safe}</td></tr>\n')
        if not rows:
            rows = ('<tr><td colspan="4" style="text-align:center;padding:60px">'
                    '<div class="empty-state" style="padding:0">'
                    '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/></svg></div>'
                    '<div class="empty-title">暂无订单</div>'
                    '<div class="empty-desc">等待订单数据...</div></div></td></tr>')

        table = f'<div class="panel"><div class="panel-header"><div class="panel-title"><div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>订单列表</div></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>产品</th><th>金额</th><th>兑换码</th></tr></thead><tbody>{rows}</tbody></table></div></div>'
        return stats_html + table

    def _html_trend(self):
        dates, counts, amounts = _build_trend_data(30)
        total_orders = sum(counts)
        total_amount = sum(amounts)
        dates_js = json.dumps(list(dates))
        counts_js = json.dumps(list(counts))
        amounts_js = json.dumps(list(amounts))
        avg_orders = total_orders / 30 if total_orders else 0
        avg_revenue = total_amount / 30 if total_amount else 0

        stats_html = f"""
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></div>
            <div class="stat-body"><div class="stat-value">{total_orders}</div><div class="stat-label">30天订单</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
            <div class="stat-body"><div class="stat-value amount">CNY{total_amount:.0f}</div><div class="stat-label">30天收入</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>
            <div class="stat-body"><div class="stat-value small">{avg_orders:.1f}/day</div><div class="stat-label">日均订单</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>
            <div class="stat-body"><div class="stat-value small amount">CNY{avg_revenue:.0f}/day</div><div class="stat-label">日均收入</div></div>
          </div>
        </div>"""

        js_inject = f"""
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded',function(){{
  var ctx=document.getElementById('trendChart');
  if(!ctx)return;
  new Chart(ctx.getContext('2d'),{{
    type:'bar',
    data:{{
      labels:{dates_js},
      datasets:[
        {{label:'Orders',data:{counts_js},backgroundColor:'rgba(42,109,244,0.7)',borderColor:'rgba(42,109,244,1)',borderWidth:1,borderRadius:4,yAxisID:'y'}},
        {{label:'CNY',data:{amounts_js},type:'line',borderColor:'rgba(239,68,68,1)',backgroundColor:'rgba(239,68,68,0.08)',borderWidth:2.5,pointRadius:4,pointBackgroundColor:'rgba(239,68,68,1)',pointBorderColor:'#fff',pointBorderWidth:2,tension:0.35,fill:true,yAxisID:'y1'}}
      ]
    }},
    options:{{
      responsive:true,maintainAspectRatio:false,
      interaction:{{mode:'index',intersect:false}},
      plugins:{{legend:{{position:'top',labels:{{usePointStyle:true,pointStyleWidth:8,padding:24,font:{{size:12}}}}}}}},
      scales:{{
        y:{{type:'linear',position:'left',title:{{display:true,text:'Orders',font:{{size:11}}}},beginAtZero:true,ticks:{{stepSize:1,font:{{size:10}}}},grid:{{color:'rgba(0,0,0,0.04)'}}}},
        y1:{{type:'linear',position:'right',title:{{display:true,text:'CNY',font:{{size:11}}}},beginAtZero:true,grid:{{drawOnChartArea:false}},ticks:{{font:{{size:10}}}}}}
      }}
    }}
  }});
}});
</script>"""
        chart = f'<div class="chart-wrap"><canvas id="trendChart"></canvas></div>'
        return stats_html + chart + js_inject

    def _html_visitors(self):
        visitors = load_visitors()
        stats = _build_visitor_stats()

        stats_html = f"""
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
            <div class="stat-body"><div class="stat-value">{stats['total']}</div><div class="stat-label">总访问量</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
            <div class="stat-body"><div class="stat-value">{stats['today']}</div><div class="stat-label">Today</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
            <div class="stat-body"><div class="stat-value">{stats['unique_ips']}</div><div class="stat-label">独立IP</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
            <div class="stat-body"><div class="stat-value">{stats['unique_hosts']}</div><div class="stat-label">独立主机</div></div>
          </div>
        </div>"""

        top_pages_html = ""
        if stats["top_pages"]:
            max_count = stats["top_pages"][0][1] if stats["top_pages"] else 1
            rows = ""
            for page_url, count in stats["top_pages"]:
                pct = (count / max_count) * 100 if max_count else 0
                p = _safe_str(page_url)
                rows += f'<div class="bar-row"><span class="bar-label" title="{p}">{p}</span><div class="bar-track"><div class="bar-fill" style="width:{pct:.0f}%"></div></div><span class="bar-count">{count}</span></div>\n'
            top_pages_html = f"""
            <div class="panel">
              <div class="panel-header">
                <div class="panel-title">
                  <div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div>
                  热门页面
                </div>
              </div>
              <div class="panel-body"><div class="bar-chart">{rows}</div></div>
            </div>"""

        devices_html = ""
        if stats["top_devices"]:
            max_dev = stats["top_devices"][0][1]
            dev_rows = ""
            for dev, count in stats["top_devices"]:
                pct = (count / max_dev) * 100 if max_dev else 0
                dev_rows += f'<div class="bar-row"><span class="bar-label">{_safe_str(dev)}</span><div class="bar-track"><div class="bar-fill" style="width:{pct:.0f}%"></div></div><span class="bar-count">{count}</span></div>\n'
            devices_html = f"""
            <div class="panel">
              <div class="panel-header">
                <div class="panel-title">
                  <div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div>
                  Devices
                </div>
              </div>
              <div class="panel-body"><div class="bar-chart">{dev_rows}</div></div>
            </div>"""

        rows = ""
        for v in visitors[:100]:
            t = _safe_str(v.get("time", "")[-16:] if len(v.get("time", "")) >= 16 else v.get("time", ""))
            host = _safe_str(v.get("hostname", "") or "")
            path = _safe_str(v.get("path", "") or "/")
            url_display = (f'<span class="url-hostname">{host}</span><span class="url-path">{path}</span>' if host else path)
            ip = _safe_str(v.get("ip", "-") or "-")
            device = v.get("device", "Unknown")
            host_safe = _safe_str(v.get("referrer_host", "") or v.get("referrer", "-") or "-")
            if len(host_safe) > 30:
                host_safe = host_safe[:30] + "..."

            utm_tags = ""
            src = _safe_str(v.get("utm_source", ""))
            med = _safe_str(v.get("utm_medium", ""))
            camp = _safe_str(v.get("utm_campaign", ""))
            if v.get("utm_source", ""):
                utm_tags += f'<span class="utm-tag">source: {src}</span>'
            if v.get("utm_medium", ""):
                utm_tags += f'<span class="utm-tag">{med}</span>'
            if v.get("utm_campaign", ""):
                utm_tags += f'<span class="utm-tag">{camp}</span>'

            rows += (f'<tr><td>{t}</td>'
                     f'<td><div>{url_display}</div>{utm_tags}</td>'
                     f'<td><span class="device-tag {device}">{_safe_str(device)}</span></td>'
                     f'<td>{ip}</td>'
                     f'<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="{host_safe}">{host_safe}</td></tr>\n')

        if not rows:
            rows = ('<tr><td colspan="5"><div class="empty-state">'
                    '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>'
                    '<div class="empty-title">暂无访客数据</div>'
                    '<div class="empty-desc">访客追踪将自动显示在此</div></div></td></tr>')

        table = f"""
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">
              <div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
              访客日志
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>页面URL</th><th>设备</th><th>IP</th><th>来源</th></tr></thead>
              <tbody>{rows}</tbody>
            </table>
          </div>
        </div>"""

        sidebar_right = f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">{top_pages_html}{devices_html}</div>' if (top_pages_html and devices_html) else (top_pages_html or devices_html)
        body = stats_html + (sidebar_right if sidebar_right else "") + table
        return body

    def _html_devices(self):
        visitors = load_visitors()
        stats = _build_visitor_stats()

        stats_html = f"""
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div>
            <div class="stat-body"><div class="stat-value">{stats['unique_ips']}</div><div class="stat-label">独立设备</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>
            <div class="stat-body"><div class="stat-value">{stats['total']}</div><div class="stat-label">总会话</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
            <div class="stat-body"><div class="stat-value">{len([d for d in stats['top_devices'] if d[0] == 'Desktop'])}</div><div class="stat-label">桌面类型</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div>
            <div class="stat-body"><div class="stat-value">{sum(1 for d in stats['top_devices'] if d[0] in ('iPhone', 'Android', 'Mobile'))}</div><div class="stat-label">移动类型</div></div>
          </div>
        </div>"""

        devices_panel = ""
        if stats["top_devices"]:
            max_count = stats["top_devices"][0][1]
            rows = ""
            for dev, count in stats["top_devices"]:
                pct = (count / max_count) * 100 if max_count else 0
                icon_svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
                if dev == "Desktop":
                    icon_svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
                rows += f'<div class="bar-row"><span class="bar-label"><span class="device-tag {_safe_str(dev)}" style="margin-right:8px;display:inline-flex;align-items:center;gap:4px;">{icon_svg}{_safe_str(dev)}</span></span><div class="bar-track"><div class="bar-fill" style="width:{pct:.0f}%"></div></div><span class="bar-count">{count}</span></div>\n'
            devices_panel = f'<div class="panel"><div class="panel-header"><div class="panel-title"><div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div>设备分布</div></div><div class="panel-body"><div class="bar-chart">{rows}</div></div></div>'

        referrers_panel = ""
        if stats["top_referrers"]:
            max_count = stats["top_referrers"][0][1]
            rows = ""
            for host, count in stats["top_referrers"]:
                pct = (count / max_count) * 100 if max_count else 0
                rows += f'<div class="bar-row"><span class="bar-label">{_safe_str(host)}</span><div class="bar-track"><div class="bar-fill" style="width:{pct:.0f}%"></div></div><span class="bar-count">{count}</span></div>\n'
            referrers_panel = f'<div class="panel"><div class="panel-header"><div class="panel-title"><div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><line x1="2" y1="12" x2="22" y2="12"/></svg></div>热门来源</div></div><div class="panel-body"><div class="bar-chart">{rows}</div></div></div>'

        sources_panel = ""
        if stats["top_sources"]:
            max_count = stats["top_sources"][0][1]
            rows = ""
            for src, count in stats["top_sources"]:
                pct = (count / max_count) * 100 if max_count else 0
                rows += f'<div class="bar-row"><span class="bar-label"><span class="utm-tag" style="background:var(--purple-light);color:#6d28d9;">{_safe_str(src)}</span></span><div class="bar-track"><div class="bar-fill" style="width:{pct:.0f}%"></div></div><span class="bar-count">{count}</span></div>\n'
            sources_panel = f'<div class="panel"><div class="panel-header"><div class="panel-title"><div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg></div>流量来源(UTM)</div></div><div class="panel-body"><div class="bar-chart">{rows}</div></div></div>'

        grid = f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">{devices_panel}{referrers_panel}</div>'
        body = stats_html + grid + sources_panel
        if not devices_panel and not referrers_panel and not sources_panel:
            body += '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/></svg></div><div class="empty-title">暂无设备数据</div><div class="empty-desc">访问追踪将自动显示在此</div></div>'
        return body

    def _html_polls(self):
        global _last_poll_detail
        data = load_poll_log()
        today_str = datetime.now().strftime("%Y-%m-%d")
        today_data = data.get(today_str, {})
        today_all = today_data.get("polls", [])
        today_polls = [p for p in today_all if p.get("type") == "manual"]

        total_today = len(today_polls)

        month_total = 0
        for date_str in sorted(data.keys()):
            if date_str.startswith(datetime.now().strftime("%Y-%m")[:7]):
                month_total += sum(1 for p in data[date_str].get("polls", []) if p.get("type") == "manual")

        poll_button = '<a href="ev://poll=now" class="btn btn-primary">立即轮询 Stream</a>'
        poll_detail_html = ""
        if _last_poll_detail:
            d = _last_poll_detail
            found = d.get("messages_found", [])
            err = d.get("error")
            detail_rows = ""
            _last_poll_detail = None
            for m in found:
                idx_str = str(m.get("idx", "-"))
                mtype = m.get("type", "unknown")
                ts_val = m.get("ts", "")
                ts_disp = ""
                if ts_val:
                    try:
                        ts_disp = datetime.fromtimestamp(int(ts_val)).strftime("%H:%M:%S")
                    except Exception:
                        ts_disp = str(ts_val)
                detail_rows += f'<tr><td>{ts_disp}</td><td><span class="badge badge-broadcast">{mtype}</span></td><td>idx={idx_str}</td></tr>'
            result_color = "var(--green)" if not err and found else "var(--red)"
            result_text = f"找到 {len(found)} 条消息" if not err else f"错误: {err}"
            status_icon = "✓" if not err else "✗"
            poll_detail_html = f"""
            <div class="panel" style="margin-top:16px; border-left: 3px solid {result_color};">
              <div class="panel-header">
                <div class="panel-title">
                  <div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
                  轮询结果 ({d.get("time", "")})
                </div>
                <span style="color:{result_color}; font-weight:600;">{status_icon} {result_text}</span>
              </div>
              <div class="panel-body" style="padding:0;">
                <table class="message-table">
                  <thead><tr><th style="width:120px">时间</th><th style="width:100px">类型</th><th>索引</th></tr></thead>
                  <tbody>{detail_rows if detail_rows else '<tr><td colspan="3" style="text-align:center;color:var(--sub);padding:24px;">Stream 无新消息</td></tr>'}</tbody>
                </table>
              </div>
            </div>"""

        stats_html = f"""
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
          <div style="font-size:15px; font-weight:600; color:var(--text);">手动轮询</div>
          {poll_button}
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
            <div class="stat-body"><div class="stat-value">{total_today}</div><div class="stat-label">今日手动恢复</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
            <div class="stat-body"><div class="stat-value">{month_total}</div><div class="stat-label">本月手动恢复</div></div>
          </div>
        </div>"""

        rows_html = ""
        recent_polls = []
        for date_str in sorted(data.keys(), reverse=True)[:7]:
            for p in reversed(data[date_str].get("polls", [])):
                if p.get("type") == "manual":
                    recent_polls.append((date_str, p))

        if not recent_polls:
            body = stats_html + poll_detail_html + '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="empty-title">暂无手工轮询记录</div><div class="empty-desc">检测到消息丢失时，点击菜单栏「手动恢复」触发</div></div>'
            return body

        for date_str, p in recent_polls[:50]:
            ptime = date_str + " " + p.get("time", "")
            reason = p.get("reason", "")
            recovered = p.get("recovered", 0)
            recovery_text = f"恢复 {recovered} 条" if recovered else "无数据"
            recovery_color = "var(--green)" if recovered else "var(--red)"

            rows_html += f"""
            <tr>
              <td class="td-time">{ptime[:16]}</td>
              <td class="td-type"><span class="badge badge-manual">手动恢复</span></td>
              <td class="td-detail">
                <span>{reason}</span>
                <span style="color:{recovery_color};margin-left:8px">({recovery_text})</span>
              </td>
            </tr>"""

        table_html = f"""
        <div class="panel" style="margin-top:16px;">
          <div class="panel-header">
            <div class="panel-title">
              <div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
              手动恢复明细
            </div>
            <div class="panel-badge">{len(recent_polls)} 次</div>
          </div>
          <div class="panel-body" style="padding:0;">
            <table class="message-table">
              <thead><tr><th style="width:160px">时间</th><th style="width:80px">类型</th><th>详情</th></tr></thead>
              <tbody>{rows_html}</tbody>
            </table>
          </div>
        </div>"""

        return stats_html + poll_detail_html + table_html

    def _toggle_notify_setting(self, key):
        settings = load_notify_settings()
        current = settings.get(key, True)
        settings[key] = not current
        save_notify_settings(settings)
        _debug_log(f"notify setting: {key}={settings[key]}")
        self._refresh_content()

    def _html_settings(self):
        auto_status = get_auto_start()
        nsettings = load_notify_settings()
        popup_on = nsettings.get("popup", True)
        sound_on = nsettings.get("sound", True)

        info_items = [
            ("版本", VERSION),
            ("数据流", STREAM_KEY),
            ("消息存储", MESSAGES_FILE),
            ("访客存储", VISITORS_FILE),
            ("轮询日志", POLL_LOG_FILE),
            ("启动项", LAUNCH_AGENT_PATH),
        ]
        info_html = ""
        for k, v in info_items:
            info_html += f'<div class="settings-info-key">{_safe_str(k)}</div><div class="settings-info-val">{_safe_str(v)}</div>\n'

        popup_color = "var(--green)" if popup_on else "var(--text-tertiary)"
        popup_label = "ON" if popup_on else "OFF"
        popup_url = "ev://setting=popup"
        sound_color = "var(--green)" if sound_on else "var(--text-tertiary)"
        sound_label = "ON" if sound_on else "OFF"
        sound_url = "ev://setting=sound"

        body = f"""
        <div class="settings-group">
          <div class="settings-group-title">提醒方式</div>
          <div class="panel">
            <div class="panel-body">
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">弹窗通知</div>
                  <div class="settings-row-desc">收到新消息时弹出 macOS 通知</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-size:11px;font-weight:600;color:{popup_color};">{popup_label}</span>
                  <a class="btn" href="{popup_url}">切换</a>
                </div>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">提示音</div>
                  <div class="settings-row-desc">收到新消息时播放系统提示音</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-size:11px;font-weight:600;color:{sound_color};">{sound_label}</span>
                  <a class="btn" href="{sound_url}">切换</a>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">通用</div>
          <div class="panel">
            <div class="panel-body">
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">开机自启</div>
                  <div class="settings-row-desc">登录Mac时自动启动应用</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-size:11px;font-weight:600;color:{'var(--green)' if auto_status else 'var(--text-tertiary)'};">{'ON' if auto_status else 'OFF'}</span>
                  <a class="btn" href="javascript:location.reload()">Toggle</a>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">应用信息</div>
          <div class="settings-info">{info_html}</div>
        </div>
        """
        return body

    def _switch_to(self, page_id):
        self._current_page = page_id
        if page_id == "messages":
            global _new_msg_count, _seen_ids
            _new_msg_count = 0
            _seen_ids.clear()
            if _app_ref:
                _app_ref.title = f"Ev {VERSION}"
        self._refresh_content()

    def _poll_now(self):
        global _last_poll_detail
        _debug_log("_poll_now: starting manual poll from polls page")
        last_id = load_last_id()
        poll_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        detail = {
            "time": poll_time,
            "last_id_before": last_id,
            "messages_found": [],
            "total_count": 0,
            "error": None,
        }
        try:
            result = upstash_http("xrange", STREAM_KEY, last_id, "+", timeout=10)
            messages = result.get("result", [])
            detail["total_count"] = len(messages)
            new_last_id = last_id
            for msg_entry in messages:
                if not isinstance(msg_entry, list) or len(msg_entry) < 2:
                    continue
                msg_id = msg_entry[0]
                fields = msg_entry[1]
                if msg_id == last_id:
                    continue
                idx = None
                total_daily = None
                msg_date = None
                msg_type = "unknown"
                msg_ts = ""
                data_raw = _extract_field(fields, "data")
                if data_raw:
                    try:
                        msg = json.loads(data_raw)
                        idx = msg.get("idx")
                        total_daily = msg.get("total_daily")
                        msg_date = msg.get("date")
                        msg_type = msg.get("type", "unknown")
                        msg_ts = msg.get("ts", "")
                    except Exception:
                        pass
                detail["messages_found"].append({
                    "id": msg_id,
                    "idx": idx,
                    "type": msg_type,
                    "ts": msg_ts,
                })
                new_last_id = msg_id
            if new_last_id != last_id:
                save_last_id(new_last_id)
            _last_poll_detail = detail
            record_poll("manual_poll", len(detail["messages_found"]))
            _debug_log(f"_poll_now: done, found {len(detail['messages_found'])} messages")
        except Exception as e:
            detail["error"] = str(e)
            _last_poll_detail = detail
            record_poll("manual_poll_error", 0)
            _debug_log(f"_poll_now: error - {e}")
        self._current_page = "polls"
        self._refresh_content()

    def _refresh_content(self):
        _debug_log(f"_refresh_content: page={self._current_page}, webkit={_HAS_WEBKIT}, webview={self._webview}, msg_text={hasattr(self, '_msg_text') and self._msg_text}")
        try:
            if _HAS_WEBKIT and self._webview:
                html = self._build_current_html()
                _debug_log(f"HTML built, length={len(html)}, has_body={'<body>' in html}")
                print(f"[DEBUG] Loading HTML, length: {len(html)}")
                import base64
                b64 = base64.b64encode(html.encode("utf-8")).decode("ascii")
                data_url = "data:text/html;base64," + b64
                self._webview.setMainFrameURL_(data_url)
                _debug_log(f"setMainFrameURL with data URL, len={len(data_url)}")
            elif hasattr(self, '_msg_text') and self._msg_text:
                header = self._build_status_summary()
                body = self._build_messages_text()
                self._msg_text.setString_(
                    header + "\n\n" + "=" * 40 + " 最近消息 " + "=" * 40 + "\n\n" + body)
            else:
                print(f"[DEBUG] No WebKit: _HAS_APPKIT={_HAS_APPKIT}, _HAS_WEBKIT={_HAS_WEBKIT}")
        except Exception as e:
            _debug_log(f"ERROR in _refresh_content: {e}")
            print(f"[ERROR] Failed to load dashboard: {e}")
            import traceback
            traceback.print_exc()
            if hasattr(self, '_msg_text') and self._msg_text:
                self._msg_text.setString_(f"Error loading dashboard:\n\n{e}\n\nPlease check console for details.")

    _TAB_BUILDERS = {
        "messages": "_html_messages",
        "orders": "_html_orders",
        "visitors": "_html_visitors",
        "trend": "_html_trend",
        "devices": "_html_devices",
        "polls": "_html_polls",
        "settings": "_html_settings",
    }

    _PAGE_TITLES = {
        "messages": ("消息中心", ""),
        "orders": ("订单列表", "订单管理"),
        "visitors": ("访客浏览", "访问统计"),
        "trend": ("走势图", "数据趋势"),
        "devices": ("设备信息", "设备统计"),
        "polls": ("轮询统计", "手动恢复操作日志"),
        "settings": ("设置", "应用偏好"),
    }

    def _build_current_html(self):
        page = self._current_page

        tab_ids = ["messages", "orders", "visitors", "trend", "devices", "polls", "settings"]
        tab_html = ""
        for tid in tab_ids:
            if tid == page:
                builder = getattr(self, self._TAB_BUILDERS[tid])
                body = builder()
            else:
                body = '<div class="empty-state"><div class="empty-icon"><div class="spinner"></div></div><div class="empty-title" style="color:#86868b">Loading...</div></div>'
            display = "block" if tid == page else "none"
            tab_html += f'<div class="tab-content" id="tab-{tid}" style="display:{display}">{body}</div>'

        title, subtitle = self._PAGE_TITLES.get(page, ("消息中心", ""))

        scripts = """
<script>
(function() {
    function bindClicks() {
        var links = document.querySelectorAll('.nav-item[data-tab]');
        for (var k = 0; k < links.length; k++) {
            links[k].addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                var tabId = this.getAttribute('data-tab');
                if (tabId) {
                    window.location = 'ev://nav=' + tabId;
                }
                return false;
            });
        }
    }

    document.addEventListener('DOMContentLoaded', function() {
        bindClicks();
    });
})();
</script>"""
        return self._html_wrap(tab_html, title, subtitle, scripts=scripts)

    def windowWillClose_(self, notification):
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyAccessory)


class EvNotifier(rumps.App):
    def __init__(self):
        super().__init__(f"Ev {VERSION}", quit_button="退出")
        self._thread = threading.Thread(target=_run_event_loop, daemon=True)
        self._thread.start()
        self._dash = DashboardWindow(self)
        ensure_auto_start()
        self.menu.add(self._version_menu())
        try:
            from AppKit import NSApp, NSApplicationActivationPolicyAccessory
            NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        except Exception:
            pass

    def _version_menu(self):
        menu = rumps.MenuItem(f"版本: {VERSION}")
        return menu

    def run(self, **options):
        import rumps as _r
        from AppKit import NSApplicationActivationPolicyAccessory
        _rm = _r.rumps

        dont_change = object()
        debug = options.get('debug', dont_change)
        if debug is not dont_change:
            _r.debug_mode(debug)

        nsapplication = _rm.NSApplication.sharedApplication()
        nsapplication.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

        self._nsapp = _rm.NSApp.alloc().init()
        self._nsapp._app = self.__dict__
        nsapplication.setDelegate_(self._nsapp)
        nsdict = _rm.__dict__
        nsdict['notifications']._init_nsapp(self._nsapp)

        setattr(_rm.App, '*app_instance', self)
        for t in getattr(_rm.timer, '*timers', []):
            t.start()
        for b in getattr(_rm.clicked, '*buttons', []):
            b(self)

        self._nsapp.initializeStatusBar()
        _rm.AppHelper.installMachInterrupt()
        nsdict['events'].before_start.emit()
        _rm.AppHelper.runEventLoop()

    @rumps.clicked("打开面板")
    def open_dashboard(self, _):
        _debug_log("open_dashboard clicked")
        self._dash.show()

    @rumps.clicked("暂停/恢复")
    def toggle_pause(self, _):
        global _paused
        _paused = not _paused
        state = "已暂停" if _paused else "已恢复"
        rumps.notification(f"Ev {VERSION}", "", state, sound=False)

    @rumps.clicked("重置计数")
    def reset_count(self, _):
        global _new_msg_count, _seen_ids
        _new_msg_count = 0
        _seen_ids.clear()
        rumps.notification(f"Ev {VERSION}", "", "计数已重置", sound=False)

    @rumps.clicked("手动恢复")
    def manual_recovery(self, _):
        global _missing_count
        if _missing_count <= 0:
            rumps.notification(f"Ev {VERSION}", "", "无丢失消息", sound=False)
            return
        last_id = load_last_id()
        if not last_id:
            rumps.notification(f"Ev {VERSION}", "", "无法获取 last_id", sound=False)
            return
        rumps.notification(f"Ev {VERSION}", "", f"开始恢复 {_missing_count} 条...", sound=False)
        new_last_id = do_recovery_poll(last_id)
        if new_last_id:
            save_last_id(new_last_id)
        if _missing_count > 0:
            rumps.notification(f"Ev {VERSION}", "", f"恢复完成，剩余 {_missing_count} 条", sound=False)
        else:
            rumps.notification(f"Ev {VERSION}", "", "已全部恢复 ✓", sound=False)

    @rumps.clicked("拉取日志")
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
                    if p.get("type") != "manual":
                        continue
                    lines.append(f"{date_str} {p['time']}  恢复={p.get('recovered',0)}  原因={p.get('reason','')}")
            if not lines:
                lines.append("无恢复记录")
            text = "\n".join(lines)
            rumps.alert(f"拉取日志 | 今日: {today_polls} | 本月: {month_total}", text[:500])
        except Exception as e:
            rumps.alert("错误", str(e))

    @rumps.clicked("状态")
    def status_btn(self, _):
        ts_str = (time.strftime("%H:%M:%S", time.localtime(_last_msg_ts)) if _last_msg_ts else "无")
        status_str = "已连接" if _status == "connected" else "未连接"
        text = (f"状态: {status_str}\n今日消息: {_new_msg_count}\n恢复次数: {_recovery_count_today}\n最后消息: {ts_str}")
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