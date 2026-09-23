"""Ev Notifier - PUB/SUB broadcast, zero polling, auto-restart, error logging"""
import atexit, json, os, queue, re, shutil, subprocess, sys, tempfile, time, threading, urllib.parse, plistlib
from datetime import datetime, timedelta

try:
    import redis
except ImportError:
    redis = None

def _load_version():
    try:
        _vf = os.path.join(os.path.dirname(os.path.abspath(__file__)), "version.json")
        with open(_vf, "r") as f:
            return "v" + json.load(f)["version"]
    except Exception:
        return "v0.0.0"

VERSION = _load_version()

# Delivery callback configuration
CALLBACK_BASE_URL = "https://app-auth.gudq.com"
CLIENT_ID = None  # Will be set on first run

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
DEBUG_LOG_FILE = os.path.expanduser("~/.ev_debug_log.json")

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
_last_sync_result = None
_focus_redeem = None


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
        "KeepAlive": True,
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
        return {"popup": True, "sound": True, "voice": True, "visitor_voice": True}


def save_notify_settings(settings):
    try:
        with open(NOTIFY_SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except Exception:
        pass


def load_messages():
    try:
        with open(MESSAGES_FILE, "r") as f:
            msgs = json.load(f)
        return [m for m in msgs if m.get("type") not in ("test", "test_curl")]
    except Exception:
        return []


def save_messages(data):
    with open(MESSAGES_FILE, "w") as f:
        json.dump(data, f, indent=2)


def store_message(ts, mtype, payload, message_id=None, is_read=False):
    msgs = load_messages()
    lt = _safe_localtime(ts)
    entry = {
        "time": time.strftime("%Y-%m-%d %H:%M:%S", lt) if lt else "",
        "type": mtype,
        "payload": payload,
        "messageId": message_id or "",
        "read": is_read,
    }
    msgs.insert(0, entry)
    if len(msgs) > 500:
        msgs = msgs[:500]
    save_messages(msgs)
    if mtype == "page_visit":
        store_visitor(ts, payload)


def mark_all_messages_read():
    msgs = load_messages()
    changed = False
    for m in msgs:
        if not m.get("read", False):
            m["read"] = True
            changed = True
    if changed:
        save_messages(msgs)
    return changed


def count_unread():
    msgs = load_messages()
    return sum(1 for m in msgs if not m.get("read", False))


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

    lt = _safe_localtime(ts)
    entry = {
        "ts": ts or int(time.time()),
        "time": time.strftime("%Y-%m-%d %H:%M:%S", lt) if lt else time.strftime("%Y-%m-%d %H:%M:%S"),
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
        data[date_str]["total_server"] = max(data[date_str]["total_server"], total_daily)
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


def _safe_localtime(ts):
    if not ts:
        return None
    try:
        if isinstance(ts, (int, float)):
            return time.localtime(int(ts))
        if isinstance(ts, str):
            try:
                return time.localtime(int(ts))
            except (ValueError, OverflowError):
                try:
                    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timetuple()
                except Exception:
                    return None
        return time.localtime(int(ts))
    except Exception:
        return None


def _run_and_ignore_timeout(cmd, timeout=5):
    try:
        subprocess.run(cmd, timeout=timeout, capture_output=True)
    except Exception:
        pass


_voice_queue = queue.Queue()

def _voice_worker():
    # try Chinese voices first, fall back to system default
    voice_chain = ["Tingting", "Sinji", "Meijia", None]  # None = system default
    while True:
        text = _voice_queue.get()
        if text is None:
            break
        for voice in voice_chain:
            try:
                cmd = ["say"]
                if voice:
                    cmd.extend(["-v", voice])
                cmd.append(text)
                result = subprocess.run(cmd, timeout=30, capture_output=True)
                if result.returncode == 0:
                    break
            except Exception:
                continue

_voice_thread = threading.Thread(target=_voice_worker, daemon=True)
_voice_thread.start()

def enqueue_voice(voice_text):
    if voice_text:
        _voice_queue.put(voice_text)


def do_recovery_poll(last_id):
    global _missing_count
    _debug_log(f"RECOVERY start: last_id={last_id}")
    print(f"RECOVERY: full stream scan from beginning, last_id={last_id}")

    all_received = load_received()
    received_by_date = {}
    for d, dd in all_received.items():
        received_by_date[d] = set(dd.get("received_idx", []))
    _debug_log(f"Loaded received data: dates={list(all_received.keys())}")

    try:
        batch_start = "-"
        recovered = 0
        max_batches = 20

        for batch_num in range(max_batches):
            _debug_log(f"XRANGE batch {batch_num+1}: start={batch_start}")
            result = upstash_http("xrange", STREAM_KEY, batch_start, "+", "COUNT", "500", timeout=15)
            messages = result.get("result", [])
            _debug_log(f"XRANGE batch {batch_num+1}: got {len(messages)} messages")
            if not messages:
                break

            for msg_entry in messages:
                if not isinstance(msg_entry, list) or len(msg_entry) < 2:
                    continue
                msg_id = msg_entry[0]
                fields = msg_entry[1]
                if msg_id == batch_start:
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
                    except Exception:
                        pass

                should_process = False
                if idx is not None and msg_date:
                    existing = received_by_date.get(msg_date, set())
                    if idx not in existing:
                        should_process = True
                        existing.add(idx)
                        received_by_date[msg_date] = existing
                elif idx is not None:
                    should_process = True

                if should_process:
                    _debug_log(f"Recovering: date={msg_date}, idx={idx}, total_daily={total_daily}")
                    if data_raw:
                        try:
                            handle_message(json.loads(data_raw))
                        except Exception:
                            pass
                    record_message(msg_id, idx=idx, total_daily=total_daily, date_str=msg_date)
                    recovered += 1

                last_id = msg_id

            if len(messages) < 500:
                break
            batch_start = messages[-1][0]

        save_last_id(last_id)
        record_poll("loss_detected", recovered)

        _missing_count = _recalc_missing()

        _debug_log(f"RECOVERY done: recovered={recovered}, missing={_missing_count}")
        print(f"RECOVERY: done, recovered={recovered}, missing={_missing_count}")
        return last_id
    except Exception as e:
        _debug_log(f"RECOVERY failed: {e}")
        print(f"RECOVERY: failed - {e}")
        return last_id


def notify_macos(title, subtitle, body, sound=False):
    try:
        msg = f"{subtitle}\n{body}" if body else subtitle
        terminal_notifier = shutil.which("terminal-notifier")
        if terminal_notifier:
            cmd = [terminal_notifier, "-title", title, "-message", msg]
            if sound:
                cmd.extend(["-sound", "default"])
            r = subprocess.run(cmd, capture_output=True, timeout=5)
            if r.returncode != 0:
                _debug_log(f"terminal-notifier failed rc={r.returncode}, falling back to osascript")
                _osascript_notify(title, subtitle, body)
            else:
                _debug_log(f"notify_macos terminal-notifier OK")
            return
        _osascript_notify(title, subtitle, body)
    except Exception as e:
        _debug_log(f"notify_macos EXCEPTION: {e}")
        try:
            _osascript_notify(title, subtitle, body)
        except Exception:
            pass


def _osascript_notify(title, subtitle, body):
    safe_title = title.replace('"', "'").replace("\\", "\\\\")
    safe_body = (subtitle + "\n" + body).replace('"', "'").replace("\\", "\\\\")
    script = f'display notification "{safe_body}" with title "{safe_title}"'
    subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)


def _delivery_callback(message_id, event="delivered"):
    """Notify server that a message was delivered/confirmed by the Mac client."""
    if not message_id:
        return
    import socket
    hostname = socket.gethostname()
    try:
        payload = json.dumps({
            "message_id": message_id,
            "event": event,
            "client_id": hostname,
            "received_at": datetime.now().isoformat()
        })
        url = f"{CALLBACK_BASE_URL}/api/admin/health?section=delivery-callback"
        fd, tmp = tempfile.mkstemp(suffix=".json", prefix="ev_dc_")
        try:
            os.close(fd)
            subprocess.run([
                "curl", "-s", "--connect-timeout", "3", "--max-time", "5",
                "-X", "POST", url,
                "-H", "Content-Type: application/json",
                "-d", payload,
                "-o", tmp
            ], timeout=10)
            resp = open(tmp).read().strip()
            if resp:
                try:
                    j = json.loads(resp)
                    if j.get("success"):
                        _debug_log(f"Delivery callback OK: {message_id} event={event}")
                except Exception:
                    pass
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass
    except Exception as e:
        _debug_log(f"Delivery callback failed: {e}")


def _startup_recovery():
    """Fetch undelivered messages from last 7 days and re-process them.
    Only re-process genuinely missed messages; skip re-notification for already-seen ones."""
    _debug_log("Startup recovery: checking for missed messages...")
    try:
        url = f"{CALLBACK_BASE_URL}/api/admin/health?section=delivery-query&action=undelivered&hours=168"
        fd, tmp = tempfile.mkstemp(suffix=".json", prefix="ev_rcv_")
        try:
            os.close(fd)
            subprocess.run(["curl", "-s", "--connect-timeout", "5", "--max-time", "10", url, "-o", tmp], timeout=15)
            resp = open(tmp).read().strip()
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass
        if not resp:
            _debug_log("Startup recovery: no response from server")
            return
        data = json.loads(resp)
        if not data.get("success"):
            _debug_log(f"Startup recovery: API returned error")
            return
        messages = data.get("messages", [])
        if not messages:
            _debug_log("Startup recovery: no missed messages")
            return
        _debug_log(f"Startup recovery: found {len(messages)} missed messages")

        # Load existing messages to avoid re-processing already-stored ones
        existing_msgs = load_messages()
        existing_ids = set()
        for em in existing_msgs:
            mid = em.get("messageId", "")
            if mid:
                existing_ids.add(mid)

        skipped = 0
        for msg in messages:
            try:
                msg_id = msg.get("message_id", "")
                # Skip if already stored locally and was already notified
                if msg_id and msg_id in existing_ids:
                    skipped += 1
                    _debug_log(f"Startup recovery: skipping already-stored message {msg_id}")
                    continue

                payload = msg.get("payload", {})
                if isinstance(payload, str):
                    try:
                        payload = json.loads(payload)
                    except Exception:
                        payload = {}
                created = msg.get("created_at", "")
                ts = 0
                if created:
                    try:
                        ts = int(datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp())
                    except Exception:
                        ts = int(time.time())
                recovered_msg = {
                    "ts": ts,
                    "type": msg.get("message_type", "unknown"),
                    "payload": payload,
                    "messageId": msg_id,
                }
                handle_message(recovered_msg, skip_notify=True)
                _debug_log(f"Startup recovery: re-processed {msg.get('message_type')} ({msg_id})")
            except Exception as e:
                _debug_log(f"Startup recovery: failed to re-process message: {e}")
        if skipped > 0:
            _debug_log(f"Startup recovery: skipped {skipped} already-stored messages")
        _debug_log(f"Startup recovery: completed")
    except Exception as e:
        _debug_log(f"Startup recovery failed: {e}")


def _zh_loc(p):
    """归属地优先取中文全量（location_full_zh → location_zh → city_zh），不做英文地名拼接。"""
    return str(
        p.get("location_full_zh") or p.get("location_zh") or p.get("city_zh") or ""
    ).strip()


def handle_message(msg, skip_notify=False):
    global _last_msg_ts, _new_msg_count, _paused
    if _paused:
        return
    ts = msg.get("ts", 0)
    mtype = msg.get("type", "unknown")
    p = msg.get("payload", {}) or {}
    msg_id = msg.get("messageId", "")
    mid = msg_id if msg_id else f"{ts}_{mtype}"
    if mid in _seen_ids:
        return
    _seen_ids.add(mid)
    if len(_seen_ids) > _MAX_SEEN:
        _seen_ids.clear()
    _last_msg_ts = ts
    if not skip_notify:
        _new_msg_count += 1
    lt = _safe_localtime(ts)
    ts_label = time.strftime("%H:%M:%S", lt) if lt else ""
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
        device_info = p.get("device_info", {}) or {}
        channel = device_info.get("source", "") or p.get("channel", "")
        title = "新设备激活"
        subtitle = f"{product} {months}".strip()
        lines = []
        # 地区先说
        loc = _zh_loc(p)
        if loc:
            lines.append(f"归属地: {loc}")
        if act_code:
            lines.append(f"激活码: {act_code}")
        if redeem_code:
            lines.append(f"兑换码: {redeem_code}")
        if device:
            lines.append(f"设备: {device}")
        if src:
            lines.append(f"来源: {src}")
        if channel:
            lines.append(f"渠道: {channel}")
        lines.append(ts_label)
        body = "\n".join(lines)
    elif mtype == "new_order":
        product = p.get("product_name", "") or p.get("plan_title", "")
        amount = _normalize_amount(p.get("total_amount") or p.get("amount") or 0)
        amount_str = f"CNY{amount:.2f}" if amount else ""
        user_name = p.get("user_name", "") or p.get("customer_name", "") or ""
        title = "新订单"
        subtitle = product
        lines = [f"金额: {amount_str}"] if amount_str else []
        if user_name:
            lines.insert(0, f"用户: {user_name}")
        redeem_code = p.get("redeem_code", "")
        if redeem_code:
            lines.append(f"兑换码: {redeem_code}")
        lines.append(ts_label)
        body = "\n".join(lines)
    elif mtype == "page_visit":
        page = p.get("page", "") or p.get("title", "")
        ip = p.get("ip", "")
        referrer = p.get("referrer", "")
        country = p.get("country", "")
        region = p.get("region", "")
        city = p.get("city", "")
        title = "页面访问"
        subtitle = page
        lines = []
        # 归属地优先中文（location_zh / city_zh），无中文时才回落英文拼接
        geo_str = _zh_loc(p)
        if not geo_str:
            geo_parts = []
            if country: geo_parts.append(country)
            if region: geo_parts.append(region)
            if city: geo_parts.append(city)
            geo_str = ", ".join(geo_parts) if geo_parts else ""
        # 地区先说：归属地放首行，IP 不再把地区塞进括号
        if geo_str:
            lines.append(f"归属地: {geo_str}")
        if ip:
            lines.append(f"IP: {ip}")
        if referrer:
            lines.append(f"来源: {referrer[:80]}")
        lines.append(ts_label)
        body = "\n".join(lines)
    elif mtype == "activation_failure":
        product = p.get("product_name", "") or ""
        reason = p.get("reason", "") or p.get("error", "") or ""
        redeem = p.get("redeem_code", "") or ""
        device = p.get("device_id", "") or ""
        device_info = p.get("device_info", {}) or {}
        channel = device_info.get("source", "") or p.get("channel", "")
        title = "激活失败"
        subtitle = product or "Unknown"
        if channel:
            subtitle += f" [{channel}]"
        lines = []
        # 地区先说
        loc = _zh_loc(p)
        if loc:
            lines.append(f"归属地: {loc}")
        if redeem:
            lines.append(f"兑换码: {redeem}")
        if reason:
            lines.append(f"原因: {reason[:80]}")
        if device:
            lines.append(f"设备: {device[:16]}")
        if channel:
            lines.append(f"渠道: {channel}")
        lines.append(ts_label)
        body = "\n".join(lines)
    elif mtype == "purchase_click":
        slug = p.get("slug", "")
        name_zh = p.get("name_zh", "") or p.get("name_en", "") or slug
        ip = p.get("ip", "")
        country = p.get("country", "")
        region = p.get("region", "")
        city = p.get("city", "")
        utm = p.get("utm_source", "") or ""
        ref = p.get("referrer", "") or ""
        title = "购买点击"
        subtitle = name_zh
        lines = [f"链接: /go/{slug}"]
        # 归属地优先中文（location_zh / city_zh），无中文时才回落英文拼接
        geo_str = _zh_loc(p)
        if not geo_str:
            geo_parts = []
            if country: geo_parts.append(country)
            if region: geo_parts.append(region)
            if city: geo_parts.append(city)
            geo_str = ", ".join(geo_parts) if geo_parts else ""
        # 地区先说：归属地放首行，IP 不再把地区塞进括号
        if geo_str:
            lines.append(f"归属地: {geo_str}")
        if ip:
            lines.append(f"IP: {ip}")
        if ref:
            lines.append(f"来源页面: {ref[:80]}")
        if utm:
            lines.append(f"渠道: {utm}")
        lines.append(ts_label)
        body = "\n".join(lines)
    else:
        body = json.dumps(p, ensure_ascii=False, indent=2)[:200]
    print(f"[{ts_label}] {title} | {subtitle}")

    # Store message to local file for the message panel
    store_message(ts, mtype, p, message_id=msg_id, is_read=False)

    if not skip_notify:
        nsettings = load_notify_settings()
        if nsettings.get("popup", True):
            notify_macos(title, subtitle, body, sound=False)
        if nsettings.get("sound", True):
            threading.Thread(target=lambda: _run_and_ignore_timeout(["afplay", "/System/Library/Sounds/Ping.aiff"], timeout=3), daemon=True).start()
    else:
        nsettings = load_notify_settings()

    if nsettings.get("voice", True) and not skip_notify and (
        mtype != "page_visit" or nsettings.get("visitor_voice", True)
    ):
        if mtype == "new_order":
            u = p.get("user_name", "") or p.get("customer_name", "") or ""
            a = _normalize_amount(p.get("total_amount") or p.get("amount") or 0)
            parts = ["新订单"]
            if u:
                parts.append(u)
            if a:
                parts.append(f"{a:.0f}元")
            voice_text = "，".join(parts)
        elif mtype == "new_activation":
            prod = p.get("product_name", "") or f"Product #{p.get('product_id', '')}"
            months = p.get("months", "")
            duration_str = ""
            try:
                m = int(months)
                duration_str = "永久" if m >= 99 else f"{m}个月"
            except Exception:
                pass
            user_name = p.get("user_name", "") or ""
            device_info = p.get("device_info", {}) or {}
            device_model = p.get("device_model", "") or device_info.get("model", "") or device_info.get("product", "") or ""
            loc = _zh_loc(p)
            # 地区先说：{地区}用户激活成功{产品}，{时长}（没有中文地区就不念英文城市）
            parts = [f"{loc}用户激活成功{prod}" if loc else f"用户激活成功{prod}"]
            if duration_str:
                parts.append(duration_str)
            if user_name:
                parts.append(user_name)
            if device_model:
                parts.append(f"设备{device_model}")
            voice_text = "，".join(parts)
        elif mtype == "activation_failure":
            reason = p.get("reason", "") or p.get("error", "") or ""
            loc = _zh_loc(p)
            head = f"{loc}用户激活失败" if loc else "用户激活失败"
            voice_text = f"{head}：{reason[:60]}" if reason else head
        elif mtype == "purchase_click":
            name_zh = p.get("name_zh", "") or p.get("slug", "")
            slug = p.get("slug", "")
            loc = _zh_loc(p)
            if slug == "ev-timetable" or "timetable" in slug.lower():
                voice_text = f"{loc}用户访问爱发电" if loc else "用户访问爱发电"
            elif name_zh:
                voice_text = f"{loc}用户点击购买{name_zh}" if loc else f"用户点击购买{name_zh}"
            else:
                voice_text = f"{loc}用户点击购买" if loc else "用户点击购买"
        elif mtype == "page_visit":
            page = p.get("page", "") or p.get("title", "") or ""
            loc = _zh_loc(p)
            page_cn = _page_name_cn(page)
            voice_text = f"{loc}用户访问{page_cn}" if loc else f"用户访问{page_cn}"
        elif mtype == "test_curl":
            voice_text = "收到测试消息"
        else:
            voice_text = f"{title}, {subtitle}".replace("[", "").replace("]", "")
        enqueue_voice(voice_text)

    # Delivery callback: confirm to server that message was received
    message_id = msg.get("messageId")
    if message_id:
        threading.Thread(target=_delivery_callback, args=(message_id, "delivered"), daemon=True).start()


def _recalc_missing():
    data = load_received()
    total = 0
    for date_str, day_data in data.items():
        total += max(0, day_data.get("total_server", 0) - len(day_data.get("received_idx", [])))
    return total


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
            threading.Thread(target=_startup_recovery, daemon=True).start()
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
        except Exception as e:
            print(f"SUBSCRIBE error: {e}, retrying in {reconnect_delay}s...")
            _status = f"retry({reconnect_delay}s)"
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
        type_label = "激活"
    elif mtype == "new_order":
        product = p.get("product_name", "") or ""
        amount = _normalize_amount(p.get("total_amount") or p.get("amount") or 0)
        amount_str = f" CNY{amount:.2f}" if amount else ""
        detail = f"{product}{amount_str}"
        type_label = "订单"
    elif mtype == "page_visit":
        page = p.get("page", "") or p.get("title", "") or ""
        ip = p.get("ip", "")
        city = _zh_loc(p) or p.get("city", "")
        detail = page
        if city:
            detail += f" | {city}"
        elif ip:
            detail += f" | {ip}"
        type_label = "访问"
    elif mtype == "test_curl":
        detail = json.dumps(p, ensure_ascii=False)[:100]
        type_label = "测试"
    elif mtype == "activation_failure":
        product = p.get("product_name", "") or ""
        reason = p.get("reason", "") or p.get("error", "") or ""
        redeem = p.get("redeem_code", "") or ""
        device = p.get("device_id", "") or ""
        detail = f"{product}"
        if redeem:
            detail += f" | {redeem}"
        if reason:
            detail += f" | {reason[:40]}"
        if device:
            detail += f" | {device[:16]}"
        type_label = "失败"
    elif mtype == "purchase_click":
        detail = p.get("name_zh", "") or p.get("slug", "")
        loc = _zh_loc(p)
        if loc:
            detail += f" | {loc}"
        type_label = "购买"
    return type_label, detail


def _page_name_cn(page):
    if not page:
        return "未知页面"
    page_lower = page.lower().rstrip("/")
    if page_lower in ("", "/", "/index", "/index.html", "/index.htm", "/home", "/home.html"):
        return "首页"
    if "activate" in page_lower:
        return "激活页面"
    if "download" in page_lower:
        return "下载页面"
    if "timetable" in page_lower:
        return "课程表页"
    if "course-guide" in page_lower:
        return "课程指南页"
    if "user-guide" in page_lower:
        return "使用指南页"
    if "redeem" in page_lower:
        return "兑换页"
    if "login" in page_lower:
        return "登录页"
    if "/go/" in page_lower:
        slug = page_lower.split("/go/")[-1].split("?")[0].split("/")[0]
        return f"{slug}页面"
    path = page_lower.split("?")[0]
    name = path.rsplit("/", 1)[-1] or path
    name = name.replace(".html", "").replace(".htm", "").replace("-", " ").replace("_", " ")
    if name and name != "/":
        return name + "页面"
    return page


def _normalize_amount(amount_raw):
    if amount_raw is None or amount_raw == "":
        return 0.0
    try:
        s = str(amount_raw)
        if "." in s:
            return float(s)
        val = float(s)
        if val == 0:
            return 0.0
        return val / 100.0
    except (ValueError, TypeError):
        return 0.0


def _build_order_list():
    msgs = load_messages()
    orders = []
    # Build activated redeem codes set from activation records
    activated_redeems = {}
    for m in msgs:
        if m.get("type") == "new_activation":
            p = m.get("payload", {}) or {}
            rc = p.get("redeem_code", "") or ""
            if rc:
                activated_redeems[rc] = True
    for m in msgs:
        if m.get("type") != "new_order":
            continue
        p = m.get("payload", {}) or {}
        product = p.get("product_name", "") or p.get("plan_title", "") or "-"
        amount_raw = p.get("total_amount") or p.get("amount") or 0
        amount = _normalize_amount(amount_raw)
        redeem = p.get("redeem_code", "") or "-"
        activation = p.get("activation_code", "") or ""
        out_trade_no = p.get("out_trade_no", "") or ""
        user_name = p.get("user_name", "") or ""
        # A paid order is always successful. activation_code is a separate step.
        # Mark as success if we have basic order data.
        has_trade_no = bool(out_trade_no)
        has_redeem = bool(redeem and redeem != "-")
        has_amount = amount > 0
        is_success = has_trade_no or has_redeem or has_amount
        status = "success" if is_success else "failed"
        # Cross-reference: check if this order's redeem_code was used in an activation
        is_activated = redeem in activated_redeems if has_redeem else False
        orders.append({
            "time": m.get("time", ""),
            "ts": m.get("ts", 0),
            "product": product,
            "amount": amount,
            "redeem": redeem,
            "status": status,
            "activation": activation,
            "trade_no": out_trade_no,
            "user_name": user_name,
            "activated": is_activated,
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
                daily[ds]["amount"] += _normalize_amount(amt_raw)

    dates = []
    counts = []
    amounts = []
    for ds in sorted(daily.keys()):
        dates.append(ds[5:])
        counts.append(daily[ds]["count"])
        amounts.append(daily[ds]["amount"])
    return dates, counts, amounts


def _build_hourly_data():
    msgs = load_messages()
    hours = [0] * 24
    for m in msgs:
        if m.get("type") != "new_order":
            continue
        t = m.get("time", "")
        if len(t) >= 13:
            try:
                h = int(t[11:13])
                if 0 <= h < 24:
                    hours[h] += 1
            except Exception:
                pass
    hour_labels = [f"{h}:00" for h in range(24)]
    return hour_labels, hours


def _build_weekly_data():
    msgs = load_messages()
    today = datetime.now().date()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    weekday_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    all_time = [0, 0, 0, 0, 0, 0, 0]
    this_week = [0, 0, 0, 0, 0, 0, 0]
    for m in msgs:
        if m.get("type") != "new_order":
            continue
        t = m.get("time", "")
        if len(t) >= 10:
            try:
                dt = datetime.strptime(t[:10], "%Y-%m-%d").date()
                wd = dt.weekday()
                all_time[wd] += 1
                if monday <= dt <= sunday:
                    this_week[wd] += 1
            except Exception:
                pass
    total_all = sum(all_time)
    total_week = sum(this_week)
    print(f"[weekly] all-time by day: {dict(zip(weekday_labels, all_time))}, total={total_all}")
    print(f"[weekly] this week by day: {dict(zip(weekday_labels, this_week))}, total={total_week}")
    return weekday_labels, all_time, this_week


def _build_activation_trend_data(days=30):
    msgs = load_messages()
    today = datetime.now().date()
    daily = {}
    for i in range(days):
        d = today - timedelta(days=days - 1 - i)
        ds = d.strftime("%Y-%m-%d")
        daily[ds] = {"success": 0, "failed": 0}

    for m in msgs:
        if m.get("type") not in ("new_activation", "activation_failure"):
            continue
        t = m.get("time", "")
        if len(t) >= 10:
            ds = t[:10]
            if ds in daily:
                p = m.get("payload", {}) or {}
                if m.get("type") == "new_activation":
                    success_flag = p.get("success", True)
                    if success_flag:
                        daily[ds]["success"] += 1
                    else:
                        daily[ds]["failed"] += 1
                else:
                    daily[ds]["failed"] += 1

    dates = []
    success_counts = []
    failed_counts = []
    for ds in sorted(daily.keys()):
        dates.append(ds[5:])
        success_counts.append(daily[ds]["success"])
        failed_counts.append(daily[ds]["failed"])
    return dates, success_counts, failed_counts


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
.stat-icon.emerald { background: linear-gradient(135deg, #d1fae5, #a7f3d0); color: #059669; }
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
.msg-indicator.type-fail { background: linear-gradient(180deg, #ef4444, #dc2626); }
.msg-indicator.type-purchase { background: linear-gradient(180deg, #f97316, #ea580c); }
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
.msg-badge.badge-fail { background: linear-gradient(135deg, #fee2e2, #fecaca); color: #b91c1c; }
.msg-badge.badge-purchase { background: linear-gradient(135deg, #fff7ed, #ffedd5); color: #c2410c; }
.msg-badge.badge-other { background: #f3f4f6; color: #4b5563; }

.msg-detail {
  font-size: 13px;
  color: var(--text);
  flex: 1;
  line-height: 1.6;
  padding-top: 3px;
  word-break: break-all;
}

.msg-unread { background: linear-gradient(90deg, rgba(59,130,246,0.04), transparent); }
.msg-unread .msg-detail { font-weight: 500; color: var(--text); }
.msg-read { opacity: 0.75; }
.msg-read .msg-detail { color: var(--text-secondary); }

.msg-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 0 8px;
  border-bottom: 2px solid var(--border-light);
  margin-bottom: 12px;
}

.msg-tab {
  font-size: 12px;
  font-weight: 500;
  padding: 6px 16px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.msg-tab:hover {
  background: var(--border-light);
  color: var(--text);
}

.msg-tab.active {
  background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(139,92,246,0.1));
  color: var(--blue);
  font-weight: 600;
}

.msg-tab-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--green);
}

.msg-tab-action:hover {
  background: #d1fae5;
  color: #047857;
}

.msg-card.msg-hidden { display: none; }

.visitor-hidden { display: none; }

.afdian-stats {
  background: linear-gradient(135deg, rgba(249,115,22,0.08), rgba(234,88,12,0.04));
  border: 1px solid rgba(249,115,22,0.2);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 8px;
}
.afdian-stats-header {
  font-size: 13px;
  font-weight: 600;
  color: #ea580c;
  margin-bottom: 10px;
}
.afdian-stats-grid {
  display: flex;
  gap: 24px;
}
.afdian-stat-item {
  text-align: center;
}
.afdian-stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text);
}
.afdian-stat-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
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
.badge-success { background:linear-gradient(135deg, #d1fae5, #6ee7b7); color:#065f46; }
.badge-fail { background:linear-gradient(135deg, #fee2e2, #fca5a5); color:#991b1b; }

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

.accordion-row { cursor:pointer; }
.accordion-row:hover td { background:#f0f7ff; }
.accordion-row .expand-icon { display:inline-block;width:18px;text-align:center;font-size:10px;color:var(--text-tertiary);transition:transform 0.2s; }
.accordion-row.open .expand-icon { transform:rotate(90deg); }

.detail-expand { display:none; }
.detail-expand.show { display:table-row; }
.detail-expand td { padding:0 !important; border-bottom:2px solid var(--accent) !important; background:#fafbff; }

.detail-card { padding:14px 20px; }
.detail-section { margin-bottom:14px; }
.detail-section:last-child { margin-bottom:0; }
.detail-section-title { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--accent);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(59,130,246,.15); }
.detail-table { width:100%;border-collapse:collapse;font-size:12px; }
.detail-table td { padding:4px 12px 4px 0;border:none !important;background:transparent !important; }
.detail-table td:first-child { color:var(--text-secondary);width:110px;white-space:nowrap;font-weight:500; }
.detail-table td:nth-child(2) { color:var(--text);word-break:break-all; }
.detail-table td:nth-child(3) { color:#64748b;font-size:11px;font-style:italic;width:180px;white-space:normal;line-height:1.5; }
.detail-table .code { font-family:monospace;font-size:11px;background:#f0f4ff;padding:2px 6px;border-radius:4px; }

.copy-btn { font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:#fff;cursor:pointer;color:var(--text-secondary);margin-left:6px;white-space:nowrap; }
.copy-btn:hover { background:var(--accent);color:#fff;border-color:var(--accent); }
"""

_TYPE_STYLES = {
    "订单": ("type-order", "badge-order"),
    "激活": ("type-activate", "badge-activate"),
    "失败": ("type-fail", "badge-fail"),
    "访问": ("type-visit", "badge-visit"),
    "购买": ("type-purchase", "badge-purchase"),
    "Recovery": ("type-recover", "badge-recover"),
    "测试": ("type-other", "badge-other"),
    "Other": ("type-other", "badge-other"),
}

_MENU = [
    {"id": "messages", "label": "消息", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>', "group": "main"},
    {"id": "orders", "label": "订单列表", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>', "group": "main"},
    {"id": "activations", "label": "激活记录", "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>', "group": "main"},
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


def _settle_navigation(listener, allow):
    """给 WebKit 的 decisionListener 回一次话（use=放行 / ignore=拦下）。

    ⚠️ listener 是 WebKit 私有的决策对象，pyobjc 在它上面做方法解析时若类型校验失败会直接
    `__builtin_trap()` → SIGTRAP(EXC_BREAKPOINT)，**try/except 抓不到**（2026-09-23 崩溃根因）。
    所以这里只做「一次方法调用」这一个最小访问，不碰任何属性，其余逻辑都放到外面。
    """
    if listener is None:
        return
    try:
        if allow:
            listener.use()
        else:
            listener.ignore()
    except Exception as e:
        _debug_log(f"_settle_navigation({allow}) failed: {e}")


class WebNavDelegate(NSObject):
    def init(self):
        self._dashboard = None
        return self

    def webView_decidePolicyForNavigationAction_request_frame_decisionListener_(self, wv, info, request, frame, listener):
        try:
            url_str = str(request.URL()) if request and request.URL() else ""
        except Exception:
            url_str = ""
        _debug_log(f"navAction url={url_str}")
        if not url_str.startswith("ev://"):
            _settle_navigation(listener, True)
            return
        try:
            self._handle_ev_url(url_str)
        except Exception as e:
            _debug_log(f"navAction dispatch ERROR: {e}")
        _settle_navigation(listener, False)

    def _handle_ev_url(self, url_str):
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
                match = re.search(r'nav=(\w+)', url_str)
                if match:
                    page_id = match.group(1)
                    focus_redeem_match = re.search(r'focus-redeem=([^&]+)', url_str)
                    if focus_redeem_match:
                        global _focus_redeem
                        _focus_redeem = focus_redeem_match.group(1)
                    self._dashboard._switch_to(page_id)
            except Exception:
                pass
        elif "order-sync" in url_str and self._dashboard:
            self._dashboard._sync_orders()
        elif "test-notify=" in url_str and self._dashboard:
            try:
                ntype = url_str.split("test-notify=")[1]
                self._dashboard._test_notify(ntype)
            except Exception:
                pass
        elif "mark-read=" in url_str and self._dashboard:
            self._dashboard._mark_all_read()


DEBUG_LOG_FILE = os.path.expanduser("~/.ev_debug.log")
DEBUG_LOG_MAX_LINES = 2000
DEBUG_LOG_KEEP_LINES = 1000

def _debug_log(msg):
    log_path = DEBUG_LOG_FILE
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        with open(log_path, "a") as f:
            f.write(f"[{ts}][pid {os.getpid()}] {msg}\n")
    except Exception:
        pass
    _rotate_debug_log(log_path)


# ── 崩溃可观测性（2026-09-23 加）───────────────────────────────────────────────
# 崩溃是 pyobjc trap 秒杀进程，Python 侧 atexit 不会执行，所以「上次有没有留下正常退出标记」
# 就是判定异常终止（崩溃/被 kill）的唯一可靠依据 —— 不再依赖系统 ~/Library/Logs/DiagnosticReports。
STATE_FILE = os.path.expanduser("~/.ev_notifier_state.json")


def _load_state():
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(data):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _record_startup():
    """启动时对账上次退出：没有正常退出标记 → 判定上次异常终止并累计次数。"""
    st = _load_state()
    prev_start = st.get("last_start_time")
    prev_ok = bool(st.get("clean_exit", False))
    abnormal = int(st.get("abnormal_exit_count", 0))
    if prev_start and not prev_ok:
        abnormal += 1
        _debug_log(f"⚠️ 上次启动({prev_start})未见正常退出标记 → 判定异常终止（崩溃/被杀），累计 {abnormal} 次")
    elif prev_start:
        _debug_log(f"上次启动({prev_start})为正常退出")
    st.update({
        "last_start_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "clean_exit": False,
        "boot_count": int(st.get("boot_count", 0)) + 1,
        "abnormal_exit_count": abnormal,
        "last_pid": os.getpid(),
        "version": VERSION,
    })
    _save_state(st)
    return st


def _mark_clean_exit(reason="normal"):
    """写正常退出标记（正常退出/菜单退出/execv 自重启前调用）。"""
    try:
        st = _load_state()
        st["clean_exit"] = True
        st["last_exit_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        st["last_exit_reason"] = reason
        _save_state(st)
    except Exception:
        pass


def _rotate_debug_log(log_path):
    try:
        with open(log_path, "r") as f:
            lines = f.readlines()
        if len(lines) > DEBUG_LOG_MAX_LINES:
            with open(log_path, "w") as f:
                f.writelines(lines[-DEBUG_LOG_KEEP_LINES:])
    except Exception:
        pass


class DashboardWindow:
    def __init__(self, app_ref):
        self._app = app_ref
        self._window = None
        self._webview = None
        self._msg_text = None
        self._current_page = "messages"
        self._webview_thread = None
        self._nav_delegate = None
        self._retired = []   # 已关闭的 (window, webview, delegate)，持有引用防止悬挂
        _debug_log("DashboardWindow.__init__")

    def show(self):
        """打开/前置面板。

        ⚠️ 两条纪律（2026-09-23 崩溃排查，详见 `打开面板崩溃与自动重启统计.md`）：

        1. 必须由主线程的「下一轮 runloop」调用（见 `EvNotifier.open_dashboard` 的 AppHelper.callLater）。
           在 rumps 菜单回调的同步栈（NSMenuTrackingSession → sendAction）里建窗/导航会踩到
           pyobjc 类型校验 trap → SIGTRAP，try/except 抓不住（线上 5 次崩溃的栈底就是这个栈）。
        2. **绝不碰已关闭的窗口**。`NSWindow` 默认 `releasedWhenClosed=True`，用户关掉面板后窗口已被释放，
           再去调 `isVisible()` / `center()` 就是访问悬垂对象 → 同样 SIGTRAP。
           `_create_window()` 里已 `setReleasedWhenClosed_(False)`，且关窗后一律重建窗口。
        """
        try:
            self._show_impl()
        except Exception as e:
            _debug_log(f"show() ERROR: {e}")

    def _show_impl(self):
        _debug_log("show() called, _HAS_WEBKIT=%s, _HAS_WEBVIEW=%s" % (str(_HAS_WEBKIT), str(_HAS_WEBVIEW)))

        if _HAS_WEBKIT:
            if self._window is not None and self._is_window_visible():
                # 面板已经开着：只前置，不在已加载文档的 WebView 上二次 setMainFrameURL_
                _debug_log("show(): window already visible -> front only, no navigation")
                self._bring_to_front()
                return
            # 全新窗口 + 新 WebView；一次导航直接灌最终 HTML（不再有 loading 页中转）
            self._recreate_window()
            self._refresh_content()
            self._bring_to_front()
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

    # _show_loading() 已于 2026-09-23 删除：它是「打开面板崩溃」的触发装置。
    # 旧流程 show() → 灌 loading 页(data URL) → 50ms 后 JS 跳 ev://refresh → 再灌真正的页面，
    # 等于每次打开都在 WebView 上做两次导航 + 一次定时器重入；改成一次直灌最终 HTML。

    def _bring_to_front(self):
        try:
            self._window.center()
            self._window.makeKeyAndOrderFront_(None)
            self._window.orderFrontRegardless()
            NSApplication.sharedApplication().setActivationPolicy_(
                NSApplicationActivationPolicyAccessory)
        except Exception as e:
            _debug_log(f"_bring_to_front ERROR: {e}")

    def _is_window_visible(self):
        try:
            return bool(self._window.isVisible())
        except Exception as e:
            _debug_log(f"_is_window_visible failed: {e}")
            return False

    def _recreate_window(self):
        """换一个全新的 NSWindow + WebView，不复用已加载过文档的 WebView。

        顺序很重要：**先建新的、再拆旧的**，并且把旧的三件套（window/webview/delegate）留在
        `self._retired` 里持有引用 —— WebKit / pyobjc 内部可能仍持有它们的裸指针，
        提前让 Python 释放会产生悬挂对象，正是那个 SIGTRAP 的成因类型。
        """
        old_window, old_webview, old_delegate = self._window, self._webview, self._nav_delegate
        self._window = None
        self._webview = None
        self._nav_delegate = None
        self._msg_text = None
        self._create_window()
        if old_window is not None:
            self._teardown_window(old_window, old_webview, old_delegate)

    def _teardown_window(self, window, webview, delegate):
        try:
            NSNotificationCenter.defaultCenter().removeObserver_name_object_(
                self, NSWindowWillCloseNotification, window)
        except Exception as e:
            _debug_log(f"_teardown_window: removeObserver failed: {e}")
        try:
            if webview is not None:
                webview.setPolicyDelegate_(None)   # 旧页面残留的 JS/导航不再回调我们
                # pyobjc-framework-WebKit 12.x 里该 selector 暴露为 stopLoading_（无参）
                if hasattr(webview, "stopLoading_"):
                    webview.stopLoading_()
                elif hasattr(webview, "stopLoading"):
                    webview.stopLoading()
        except Exception as e:
            _debug_log(f"_teardown_window: webview cleanup failed: {e}")
        try:
            window.close()
        except Exception as e:
            _debug_log(f"_teardown_window: close failed: {e}")
        self._retired.append((window, webview, delegate))
        del self._retired[:-3]   # 只留最近 3 份，防无限增长
        _debug_log(f"_teardown_window: retired={len(self._retired)}")

    def _create_window(self):
        rect = NSMakeRect(100, 100, 1100, 720)
        mask = (NSTitledWindowMask | NSClosableWindowMask |
                NSMiniaturizableWindowMask | NSResizableWindowMask)
        self._window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            rect, mask, NSBackingStoreBuffered, False)
        # ★★ 关键修复（2026-09-23，已用最小用例复现并验证）★★
        # NSWindow 默认 releasedWhenClosed=True：用户点红叉关掉面板后窗口对象被 dealloc，
        # 而 pyobjc 包装器还留着 → 下一次「打开面板」再碰这个包装器
        # （isVisible()/center()/makeKeyAndOrderFront_）就是访问已释放对象，
        # 表现为 pyobjc 类型校验 trap（SIGTRAP）或直接卡死 —— 这就是「第二次打开必崩」的根因。
        # 关掉自动释放后，窗口关掉只是 orderOut，对象始终有效。
        self._window.setReleasedWhenClosed_(False)
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
        common_js = """<script>
function toggleRowDetail(rowId) {
  var row = document.getElementById('detail-'+rowId);
  var toggle = document.getElementById('row-'+rowId);
  if (!row) return;
  if (row.classList.contains('show')) {
    row.classList.remove('show');
    if (toggle) toggle.classList.remove('open');
  } else {
    row.classList.add('show');
    if (toggle) toggle.classList.add('open');
  }
}
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() { }).catch(function() { });
  }
}
function filterMessages(filter) {
  var tabs = document.querySelectorAll('.msg-tab[data-filter]');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.remove('active');
    if (tabs[i].getAttribute('data-filter') === filter) {
      tabs[i].classList.add('active');
    }
  }
  var cards = document.querySelectorAll('.msg-card');
  var visible = 0;
  for (var j = 0; j < cards.length; j++) {
    var card = cards[j];
    if (filter === 'all') {
      card.classList.remove('msg-hidden');
      visible++;
    } else if (filter === 'unread') {
      if (card.classList.contains('msg-unread')) {
        card.classList.remove('msg-hidden');
        visible++;
      } else {
        card.classList.add('msg-hidden');
      }
    } else if (filter === 'read') {
      if (card.classList.contains('msg-read')) {
        card.classList.remove('msg-hidden');
        visible++;
      } else {
        card.classList.add('msg-hidden');
      }
    }
  }
  var emptyEl = document.getElementById('msg-empty');
  if (emptyEl) {
    emptyEl.style.display = visible === 0 ? '' : 'none';
  }
}
function markAllRead() {
  window.location = 'ev://mark-read=all';
}
function filterVisitors(filter) {
  var tabs = document.querySelectorAll('[data-visitor-filter]');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute('data-visitor-filter') === filter) {
      tabs[i].classList.add('active');
    } else {
      tabs[i].classList.remove('active');
    }
  }
  var afdianStats = document.getElementById('afdianStats');
  if (filter === 'afdian') {
    var rows = document.querySelectorAll('.visitor-all, .visitor-afdian');
    for (var j = 0; j < rows.length; j++) {
      rows[j].classList.toggle('visitor-hidden', !rows[j].classList.contains('visitor-afdian'));
    }
    if (afdianStats) afdianStats.style.display = 'block';
  } else {
    var rows2 = document.querySelectorAll('.visitor-all, .visitor-afdian');
    for (var k = 0; k < rows2.length; k++) {
      rows2[k].classList.remove('visitor-hidden');
    }
    if (afdianStats) afdianStats.style.display = 'none';
  }
}
</script>"""
        return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>{_DASH_CSS}</style></head>
<body><div class="layout">{sidebar}<div class="main">{topbar}<div class="content">{content}</div></div></div>{common_js}{scripts}</body></html>"""

    def _html_messages(self):
        msgs = load_messages()
        unread_count = sum(1 for m in msgs if not m.get("read", False))
        read_count = sum(1 for m in msgs if m.get("read", False))
        total_count = len(msgs)

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

        msg_tabs = f"""
        <div class="msg-tabs">
          <button class="msg-tab" data-filter="all" onclick="filterMessages('all')">All ({total_count})</button>
          <button class="msg-tab active" data-filter="unread" onclick="filterMessages('unread')">Unread ({unread_count})</button>
          <button class="msg-tab" data-filter="read" onclick="filterMessages('read')">Read ({read_count})</button>
          <button class="msg-tab msg-tab-action" onclick="markAllRead()" title="Mark all as read" style="margin-left:auto;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Mark All Read
          </button>
        </div>"""

        entries = []
        for m in msgs[:80]:
            type_label, detail = _format_message_detail(m)
            css_cls, badge_cls = _TYPE_STYLES.get(type_label, ("type-other", "badge-other"))
            is_read = m.get("read", False)
            entries.append((m.get("time", ""), type_label, detail, css_cls, badge_cls, is_read))

        polls = load_poll_log()
        for date_str in sorted(polls.keys(), reverse=True):
            for p in polls[date_str].get("polls", []):
                t = date_str + " " + p.get("time", "")
                detail = f"Recovered {p.get('recovered', 0)} messages - {p.get('reason', '')}"
                entries.append((t, "Recovery", detail, "type-recover", "badge-recover", True))

        msg_html = ""
        for t, tp, detail, css_cls, badge_cls, is_read in entries[:50]:
            time_short = _safe_str(t[-16:] if len(t) >= 16 else t)
            detail_safe = _safe_str(detail)
            read_class = "msg-read" if is_read else "msg-unread"
            msg_html += (
                f'<div class="msg-card {read_class}">'
                f'<div class="msg-indicator {css_cls}"></div>'
                f'<span class="msg-time">{time_short}</span>'
                f'<span class="msg-badge {badge_cls}">{_safe_str(tp)}</span>'
                f'<div class="msg-detail">{detail_safe}</div>'
                f'</div>\n')

        if not msg_html:
            msg_html = ('<div class="empty-state" id="msg-empty">'
                        '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="14" y2="12"/><line x1="7" y1="16" x2="11" y2="16"/></svg></div>'
                        '<div class="empty-title">No messages</div>'
                        '<div class="empty-desc">Waiting for notifications...</div></div>')

        body = f'<div class="panel"><div class="panel-header"><div class="panel-title"><div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>Activity Stream</div></div>{msg_tabs}<div class="msg-list">{msg_html}</div></div>'
        return body

    def _html_orders(self):
        orders = _build_order_list()
        total_amount = sum(o.get("amount", 0) for o in orders)
        total_count = len(orders)
        today_str = datetime.now().strftime("%Y-%m-%d")
        today_orders = [o for o in orders if o.get("time", "").startswith(today_str)]
        today_amount = sum(o.get("amount", 0) for o in today_orders)
        success_count = sum(1 for o in orders if o.get("status") == "success")
        failed_count = sum(1 for o in orders if o.get("status") == "failed")
        activated_count = sum(1 for o in orders if o.get("activated"))
        not_activated_count = total_count - activated_count

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

        filter_toggle_btn = """<button id="orderFilterToggle" onclick="toggleOrderFilter()" style="padding:6px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;background:#fff;cursor:pointer;color:#6b7280;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px;">Show Filters</button>"""

        filter_html = """
        <div class="filter-bar" id="orderFilterBar" style="display:none;align-items:center;gap:10px;padding:12px 0;flex-wrap:wrap;">
          <select id="filterStatus" onchange="applyOrderFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff;outline:none;cursor:pointer;">
            <option value="all">All</option>
            <option value="success">Paid</option>
            <option value="failed">Unpaid</option>
          </select>
          <select id="filterActivated" onchange="applyOrderFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff;outline:none;cursor:pointer;">
            <option value="all">Activated: All</option>
            <option value="true">Activated</option>
            <option value="false">Not Activated</option>
          </select>
          <select id="filterTime" onchange="onTimePresetChange()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff;outline:none;cursor:pointer;">
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="custom">Custom Range</option>
          </select>
          <input id="filterDateFrom" type="date" onchange="onDateRangeChange()" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:140px;display:none;" />
          <span id="filterDateSep" style="color:#9ca3af;font-size:12px;display:none;">to</span>
          <input id="filterDateTo" type="date" onchange="onDateRangeChange()" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:140px;display:none;" />
          <input id="filterProduct" type="text" placeholder="Product name..." oninput="applyOrderFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:160px;" />
          <input id="filterRedeem" type="text" placeholder="Redeem code..." oninput="applyOrderFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:130px;" />
          <input id="filterAmtMin" type="number" placeholder="Min CNY" onchange="applyOrderFilter()" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:90px;" step="0.01" min="0" />
          <span style="color:#9ca3af;font-size:12px;">-</span>
          <input id="filterAmtMax" type="number" placeholder="Max CNY" onchange="applyOrderFilter()" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:90px;" step="0.01" min="0" />
          <button onclick="resetOrderFilter()" style="padding:6px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;background:#f9fafb;cursor:pointer;color:#6b7280;">Reset</button>
          <span id="filterResult" style="font-size:12px;color:#6b7280;margin-left:4px;font-weight:500;"></span>
        </div>
        <script>
        function getDateStrings() {
          var now = new Date();
          var todayStr = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
          var yesterday = new Date(now);
          yesterday.setDate(now.getDate()-1);
          var yestStr = yesterday.getFullYear()+'-'+String(yesterday.getMonth()+1).padStart(2,'0')+'-'+String(yesterday.getDate()).padStart(2,'0');
          var dayOfWeek = now.getDay();
          var diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          var weekStart = new Date(now);
          weekStart.setDate(now.getDate()-diffToMonday);
          var weekStr = weekStart.getFullYear()+'-'+String(weekStart.getMonth()+1).padStart(2,'0')+'-'+String(weekStart.getDate()).padStart(2,'0');
          var monthStr = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
          return {today: todayStr, yesterday: yestStr, week: weekStr, month: monthStr};
        }
        function onTimePresetChange() {
          var timeVal = document.getElementById('filterTime').value;
          var dateFrom = document.getElementById('filterDateFrom');
          var dateTo = document.getElementById('filterDateTo');
          var dateSep = document.getElementById('filterDateSep');
          var ds = getDateStrings();
          if (timeVal === 'custom') {
            dateFrom.style.display = '';
            dateTo.style.display = '';
            dateSep.style.display = '';
          } else {
            dateFrom.style.display = 'none';
            dateTo.style.display = 'none';
            dateSep.style.display = 'none';
          }
          applyOrderFilter();
        }
        function onDateRangeChange() {
          document.getElementById('filterTime').value = 'custom';
          applyOrderFilter();
        }
        function applyOrderFilter() {
          var status = document.getElementById('filterStatus').value;
          var activated = document.getElementById('filterActivated').value;
          var time = document.getElementById('filterTime').value;
          var dateFrom = document.getElementById('filterDateFrom').value;
          var dateTo = document.getElementById('filterDateTo').value;
          var product = (document.getElementById('filterProduct').value || '').toLowerCase().trim();
          var redeem = (document.getElementById('filterRedeem').value || '').toUpperCase().trim();
          var amtMin = parseFloat(document.getElementById('filterAmtMin').value);
          var amtMax = parseFloat(document.getElementById('filterAmtMax').value);
          var rows = document.querySelectorAll('#orderTableBody tr');
          var ds = getDateStrings();
          var visible = 0;
          var totalAmt = 0;
          rows.forEach(function(row) {
            var show = true;
            var rowStatus = row.getAttribute('data-status');
            var rowActivated = row.getAttribute('data-activated');
            var rowTime = row.getAttribute('data-time');
            var rowProduct = (row.getAttribute('data-product') || '').toLowerCase();
            var rowRedeem = (row.getAttribute('data-redeem') || '').toUpperCase();
            var rowAmt = parseFloat(row.getAttribute('data-amount'));
            if (status !== 'all' && rowStatus !== status) show = false;
            if (activated !== 'all' && rowActivated !== activated) show = false;
            if (time === 'today' && rowTime !== ds.today) show = false;
            if (time === 'yesterday' && rowTime !== ds.yesterday) show = false;
            if (time === 'week' && rowTime < ds.week) show = false;
            if (time === 'month' && !rowTime.startsWith(ds.month)) show = false;
            if (time === 'custom') {
              if (dateFrom && rowTime < dateFrom) show = false;
              if (dateTo && rowTime > dateTo) show = false;
            }
            if (product && rowProduct.indexOf(product) === -1) show = false;
            if (redeem && rowRedeem.indexOf(redeem) === -1) show = false;
            if (!isNaN(amtMin) && rowAmt < amtMin) show = false;
            if (!isNaN(amtMax) && rowAmt > amtMax) show = false;
            row.style.display = show ? '' : 'none';
            var detailRow = document.getElementById('detail-' + row.id.replace('row-', ''));
            if (detailRow) { detailRow.style.display = show ? '' : 'none'; if (!show) detailRow.classList.remove('show'); }
            if (show) { visible++; totalAmt += rowAmt; }
          });
          document.getElementById('filterResult').textContent = visible+'/'+rows.length+' orders, sum CNY'+totalAmt.toFixed(2);
        }
        function resetOrderFilter() {
          document.getElementById('filterStatus').value = 'all';
          document.getElementById('filterActivated').value = 'all';
          document.getElementById('filterTime').value = 'all';
          document.getElementById('filterDateFrom').value = '';
          document.getElementById('filterDateTo').value = '';
          document.getElementById('filterDateFrom').style.display = 'none';
          document.getElementById('filterDateTo').style.display = 'none';
          document.getElementById('filterDateSep').style.display = 'none';
          document.getElementById('filterProduct').value = '';
          document.getElementById('filterRedeem').value = '';
          document.getElementById('filterAmtMin').value = '';
          document.getElementById('filterAmtMax').value = '';
          applyOrderFilter();
        }
        function toggleOrderFilter() {
          var bar = document.getElementById('orderFilterBar');
          var btn = document.getElementById('orderFilterToggle');
          if (bar.style.display === 'none' || bar.style.display === '') {
            bar.style.display = 'flex';
            btn.textContent = 'Hide Filters';
          } else {
            bar.style.display = 'none';
            btn.textContent = 'Show Filters';
          }
        }
        document.addEventListener('DOMContentLoaded', function() { applyOrderFilter(); });
        </script>
        """

        rows = ""
        idx = 0
        for o in orders[:200]:
            t = o.get("time", "")[-16:] if len(o.get("time", "")) >= 16 else o.get("time", "")
            date_str = o.get("time", "")[:10] if len(o.get("time", "")) >= 10 else ""
            amt = o.get('amount', 0)
            amt_display = f"CNY{amt:.2f}"
            product_safe = _safe_str(o.get("product", "-"))
            redeem_safe = _safe_str(o.get("redeem", "-"))
            activation_safe = _safe_str(o.get("activation", ""))
            trade_no_safe = _safe_str(o.get("trade_no", ""))
            status = o.get("status", "failed")
            status_class = "badge-success" if status == "success" else "badge-fail"
            status_label = "已付款" if status == "success" else "未付款"
            status_html = f'<span class="badge {status_class}">{status_label}</span>'
            activated = o.get("activated", False)
            user_name_safe = _safe_str(o.get("user_name", ""))
            redeem_escaped = redeem_safe.replace("'", "\\'")
            activated_badge = '<a href="ev://nav=activations&amp;focus-redeem=' + redeem_escaped + '" style="text-decoration:none" onclick="event.stopPropagation()"><span class="badge badge-success" style="font-size:10px;padding:1px 6px;cursor:pointer">Yes</span></a>' if activated else '<span class="badge badge-fail" style="font-size:10px;padding:1px 6px;">No</span>'
            rowId = "order" + str(idx)
            rows += (
                '<tr class="accordion-row" id="row-' + rowId + '" data-status="' + status + '" data-activated="' + str(activated).lower() + '" data-time="' + date_str + '" data-product="' + product_safe + '" data-redeem="' + redeem_safe + '" data-amount="' + f'{amt:.2f}' + '" onclick="toggleRowDetail(\'' + rowId + '\')">'
                '<td><span class="expand-icon">▶</span> ' + t + '</td>'
                '<td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + user_name_safe + '">' + (user_name_safe or "-") + '</td>'
                '<td>' + product_safe + '</td>'
                '<td class="amount">' + amt_display + '</td>'
                '<td style="font-family:monospace">' + redeem_safe + '</td>'
                '<td>' + activated_badge + '</td>'
                '<td>' + status_html + '</td></tr>\n'
            )
            detail_html = '<div class="detail-card">'
            detail_html += '<div class="detail-section"><div class="detail-section-title">订单详情</div><table class="detail-table">'
            detail_html += '<tr><td>产品</td><td>' + product_safe + '</td></tr>'
            if user_name_safe:
                detail_html += '<tr><td>用户</td><td>' + user_name_safe + '</td></tr>'
            detail_html += '<tr><td>金额</td><td>' + amt_display + '</td></tr>'
            if trade_no_safe:
                detail_html += '<tr><td>交易号</td><td style="font-family:monospace;font-size:11px;">' + trade_no_safe + '</td></tr>'
            detail_html += '<tr><td>兑换码</td><td class="code">' + redeem_safe + '</td></tr>'
            if activation_safe:
                detail_html += '<tr><td>激活码</td><td class="code">' + activation_safe + '</td><td style="color:#64748b;font-size:11px;">用户已激活设备</td></tr>'
            detail_html += '<tr><td>已激活</td><td>' + activated_badge + '</td></tr>'
            detail_html += '<tr><td>状态</td><td>' + status_html + '</td></tr>'
            detail_html += '</table></div></div>'
            rows += '<tr class="detail-expand" id="detail-' + rowId + '"><td colspan="7">' + detail_html + '</td></tr>\n'
            idx += 1
        if not rows:
            rows = ('<tr><td colspan="7" style="text-align:center;padding:60px">'
                    '<div class="empty-state" style="padding:0">'
                    '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/></svg></div>'
                    '<div class="empty-title">暂无订单</div>'
                    '<div class="empty-desc">等待订单数据...</div></div></td></tr>')

        sync_result_html = ""
        if _last_sync_result:
            sync_time = _last_sync_result.get("time", "")
            sync_total = _last_sync_result.get("total", 0)
            sync_new = _last_sync_result.get("new", 0)
            sync_error = _last_sync_result.get("error", "")
            if sync_error:
                sync_result_html = f'<div style="margin-top:12px;padding:10px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#dc2626;font-size:13px">Sync failed: {sync_error}</div>'
            else:
                sync_result_html = f'<div style="margin-top:12px;padding:10px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;color:#166534;font-size:13px">Synced at {sync_time}: {sync_total} orders total, {sync_new} new orders</div>'

        table = f'<div class="panel"><div class="panel-header"><div class="panel-title"><div class="panel-title-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>订单列表</div><a class="btn" href="ev://order-sync" onclick="this.style.opacity=&#39;0.6&#39;;this.textContent=&#39;Syncing...&#39;;setTimeout(function(){{location.reload()}},3000)" style="margin-left:8px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>Sync Orders</a></div>{filter_html}<div class="table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>产品</th><th>金额</th><th>兑换码</th><th>已激活</th><th>状态</th></tr></thead><tbody id="orderTableBody">{rows}</tbody></table></div></div>'
        return stats_html + sync_result_html + filter_toggle_btn + table

    def _html_activations(self):
        """Activation records page - list new_activation and activation_failure messages."""
        messages = load_messages()
        acts = [m for m in messages if m.get("type") in ("new_activation", "activation_failure")]
        acts.sort(key=lambda x: x.get("ts", 0), reverse=True)

        total_count = len(acts)
        success_count = sum(1 for a in acts if a.get("type") == "new_activation")
        fail_count = sum(1 for a in acts if a.get("type") == "activation_failure")
        today_str = datetime.now().strftime("%Y-%m-%d")
        today_acts = []
        for a in acts:
            lt = _safe_localtime(a.get("ts"))
            if lt and time.strftime("%Y-%m-%d", lt) == today_str:
                today_acts.append(a)

        stats_html = f"""
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
            <div class="stat-body"><div class="stat-value">{total_count}</div><div class="stat-label">All Activations</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
            <div class="stat-body"><div class="stat-value">{len(today_acts)}</div><div class="stat-label">Today</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon emerald"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
            <div class="stat-body"><div class="stat-value">{success_count}</div><div class="stat-label">Success</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>
            <div class="stat-body"><div class="stat-value">{fail_count}</div><div class="stat-label">Failed</div></div>
          </div>
        </div>"""

        filter_html = """
        <div class="filter-bar" id="actFilterBar" style="display:none;align-items:center;gap:10px;padding:12px 0;flex-wrap:wrap;">
          <select id="actFilterTime" onchange="onActTimePreset()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff;outline:none;">
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">This Week</option>
            <option value="custom">Custom Range</option>
          </select>
          <input id="actFilterFrom" type="date" onchange="applyActFilter()" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:140px;display:none;" />
          <span id="actFilterSep" style="color:#9ca3af;font-size:12px;display:none;">to</span>
          <input id="actFilterTo" type="date" onchange="applyActFilter()" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:140px;display:none;" />
          <input id="actFilterProduct" type="text" placeholder="Product name..." oninput="applyActFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:160px;" />
          <input id="actFilterDevice" type="text" placeholder="Device ID..." oninput="applyActFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:150px;" />
          <input id="actFilterRedeem" type="text" placeholder="Redeem code..." oninput="applyActFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:140px;" />
          <input id="actFilterVersion" type="text" placeholder="Version..." oninput="applyActFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:120px;" />
          <input id="actFilterModel" type="text" placeholder="Model..." oninput="applyActFilter()" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;width:140px;" />
          <button onclick="resetActFilter()" style="padding:6px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;background:#f9fafb;cursor:pointer;color:#6b7280;">Reset</button>
          <span id="actFilterResult" style="font-size:12px;color:#6b7280;margin-left:4px;font-weight:500;"></span>
        </div>
        <script>
        function onActTimePreset() {
          var v = document.getElementById("actFilterTime").value;
          document.getElementById("actFilterFrom").style.display = (v === "custom") ? "" : "none";
          document.getElementById("actFilterSep").style.display = (v === "custom") ? "" : "none";
          document.getElementById("actFilterTo").style.display = (v === "custom") ? "" : "none";
          applyActFilter();
        }
        function applyActFilter() {
          var t = document.getElementById("actFilterTime").value;
          var f = document.getElementById("actFilterFrom").value;
          var t2 = document.getElementById("actFilterTo").value;
          var p = (document.getElementById("actFilterProduct").value || "").toLowerCase();
          var d = (document.getElementById("actFilterDevice").value || "").toLowerCase();
          var r = (document.getElementById("actFilterRedeem").value || "").toLowerCase();
          var v = (document.getElementById("actFilterVersion").value || "").toLowerCase();
          var m = (document.getElementById("actFilterModel").value || "").toLowerCase();
          var rows = document.querySelectorAll("#actTable tbody tr");
          var vis = 0, total = 0;
          rows.forEach(function(rr) {
            total++;
            var show = true;
            var dt = rr.getAttribute("data-time") || "";
            var pp = (rr.getAttribute("data-product") || "").toLowerCase();
            var dd = (rr.getAttribute("data-device") || "").toLowerCase();
            var rd = (rr.getAttribute("data-redeem") || "").toLowerCase();
            var vv = (rr.getAttribute("data-version") || "").toLowerCase();
            var mm = (rr.getAttribute("data-model") || "").toLowerCase();
            if (t === "today") {
              var n = new Date();
              var td = n.getFullYear() + "-" + (n.getMonth() + 1).toString().padStart(2, "0") + "-" + n.getDate().toString().padStart(2, "0");
              if (dt !== td) show = false;
            } else if (t === "yesterday") {
              var y = new Date();
              y.setDate(y.getDate() - 1);
              var ys = y.getFullYear() + "-" + (y.getMonth() + 1).toString().padStart(2, "0") + "-" + y.getDate().toString().padStart(2, "0");
              if (dt !== ys) show = false;
            } else if (t === "week") {
              var w = new Date();
              w.setDate(w.getDate() - w.getDay());
              var ws = w.getFullYear() + "-" + (w.getMonth() + 1).toString().padStart(2, "0") + "-" + w.getDate().toString().padStart(2, "0");
              if (dt < ws) show = false;
            } else if (t === "custom" && f && t2) {
              if (dt < f || dt > t2) show = false;
            }
            if (p && pp.indexOf(p) < 0) show = false;
            if (d && dd.indexOf(d) < 0) show = false;
            if (r && rd.indexOf(r) < 0) show = false;
            if (v && vv.indexOf(v) < 0) show = false;
            if (m && mm.indexOf(m) < 0) show = false;
            rr.style.display = show ? "" : "none";
            var dtRow = document.getElementById('detail-' + rr.id.replace('row-', ''));
            if (dtRow) { dtRow.style.display = show ? "" : "none"; if (!show) dtRow.classList.remove('show'); }
            if (show) vis++;
          });
          document.getElementById("actFilterResult").textContent = vis + "/" + total + " shown";
        }
        function resetActFilter() {
          ["actFilterTime", "actFilterFrom", "actFilterTo", "actFilterProduct", "actFilterDevice", "actFilterRedeem", "actFilterVersion", "actFilterModel"].forEach(function(id) {
            var el = document.getElementById(id);
            if (el.tagName === "INPUT") el.value = "";
            else el.value = "all";
          });
          document.getElementById("actFilterFrom").style.display = "none";
          document.getElementById("actFilterSep").style.display = "none";
          document.getElementById("actFilterTo").style.display = "none";
          applyActFilter();
        }
        function toggleActFilter() {
          var bar = document.getElementById("actFilterBar");
          var btn = document.getElementById("actFilterToggle");
          if (bar.style.display === "none" || bar.style.display === "") {
            bar.style.display = "flex";
            btn.textContent = "Hide Filters";
          } else {
            bar.style.display = "none";
            btn.textContent = "Show Filters";
          }
        }
        </script>
        """
        toggle_btn = '<button id="actFilterToggle" onclick="toggleActFilter()" style="padding:6px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;background:#fff;cursor:pointer;color:#6b7280;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px;">Show Filters</button>'

        rows = ""
        aidx = 0
        for a in acts:
            ts = a.get("ts", 0)
            p = a.get("payload", {}) or {}
            lt = _safe_localtime(ts)
            t = time.strftime("%Y-%m-%d %H:%M", lt) if lt else "-"
            date_str = time.strftime("%Y-%m-%d", lt) if lt else ""
            product = p.get("product_name", "") or f"#{p.get('product_id', '')}"
            device = p.get("device_id", "")
            act_code = p.get("activation_code", "")
            redeem_code = p.get("redeem_code", "")
            source = p.get("source", "")
            months = p.get("months", "")
            try:
                m = int(months)
                months_display = f"{m // 12}y" if m >= 12 and m % 12 == 0 else f"{m}m" if m else ""
            except Exception:
                months_display = str(months) if months else ""
            isFailure = a.get("type") == "activation_failure"
            success = p.get("success", not isFailure)
            reason = p.get("reason", "") or p.get("error", "") or ""
            status_html = '<span class="badge badge-success">成功</span>' if (success and not isFailure) else '<span class="badge badge-fail">失败</span>'

            di = p.get("device_info", {}) or {}
            vi = p.get("visitor_info", {}) or {}
            refUrl = vi.get("referer", "") or p.get("referer", "") or ""
            rMatch = None
            import re as _re
            try: rMatch = _re.search(r'[&?]r=([^&]+)', refUrl)
            except: pass
            versionVal = rMatch.group(1) if rMatch else ""
            try:
                from urllib.parse import unquote
                versionVal = unquote(versionVal)
            except:
                pass
            modelName = di.get("product", "") or di.get("model", "") or ""

            rowId = "act" + str(aidx)
            rows += (
                '<tr class="accordion-row" id="row-' + rowId + '" data-time="' + date_str + '" data-product="' + _safe_str(product) + '" data-device="' + _safe_str(device) + '" data-redeem="' + _safe_str(redeem_code) + '" data-version="' + _safe_str(versionVal) + '" data-model="' + _safe_str(modelName) + '" onclick="toggleRowDetail(\'' + rowId + '\')">'
                '<td><span class="expand-icon">▶</span> ' + _safe_str(t) + '</td>'
                '<td>' + _safe_str(product) + '</td>'
                '<td style="font-family:monospace;font-size:12px;">' + _safe_str(act_code[:16] if act_code else "") + '</td>'
                '<td>' + _safe_str(redeem_code) + '</td>'
                '<td style="font-family:monospace;font-size:11px;">' + _safe_str(device[:16] if device else "") + '</td>'
                '<td>' + _safe_str(versionVal) + '</td>'
                '<td>' + _safe_str(modelName) + '</td>'
                '<td>' + status_html + '</td></tr>\n'
            )

            # Build the full activation URL
            fullUrl = vi.get("url", "") or ""
            if not fullUrl:
                host = vi.get("host", "") or ""
                refPath = refUrl.split("?")[0] if "?" in refUrl else refUrl
                if host:
                    fullUrl = "https://" + host + "/activate.html" + ("?deviceId=" + _safe_str(device) if device else "")
            urlForDisplay = fullUrl

            # Parse URL query parameters for explanation
            parsed_url = urllib.parse.urlparse(urlForDisplay) if urlForDisplay.startswith(("http://", "https://")) else None
            url_query = urllib.parse.parse_qs(parsed_url.query) if parsed_url and parsed_url.query else {}
            param_explanations = []
            for qk, qv in url_query.items():
                qv_str = qv[0] if qv else ""
                if qk == "deviceId":
                    param_explanations.append(f"<div style='margin-top:2px;font-size:11px;color:#475569;'><code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{qk}</code> = <code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{_safe_str(qv_str[:20])}</code> &mdash; Device unique identifier (pre-filled from device)</div>")
                elif qk == "r":
                    param_explanations.append(f"<div style='margin-top:2px;font-size:11px;color:#475569;'><code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{qk}</code> = <code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{_safe_str(qv_str[:20])}</code> &mdash; App version identifier</div>")
                elif qk == "utm_source":
                    param_explanations.append(f"<div style='margin-top:2px;font-size:11px;color:#475569;'><code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{qk}</code> = <code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{_safe_str(qv_str[:20])}</code> &mdash; UTM marketing source</div>")
                elif qk == "utm_medium":
                    param_explanations.append(f"<div style='margin-top:2px;font-size:11px;color:#475569;'><code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{qk}</code> = <code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{_safe_str(qv_str[:20])}</code> &mdash; UTM marketing medium</div>")
                elif qk == "utm_campaign":
                    param_explanations.append(f"<div style='margin-top:2px;font-size:11px;color:#475569;'><code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{qk}</code> = <code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{_safe_str(qv_str[:20])}</code> &mdash; UTM marketing campaign</div>")
                else:
                    param_explanations.append(f"<div style='margin-top:2px;font-size:11px;color:#475569;'><code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{qk}</code> = <code style='background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:10px;'>{_safe_str(qv_str[:20])}</code></div>")

            detail_html = '<div class="detail-card">'

            # --- Activation URL Section ---
            detail_html += '<div class="detail-section"><div class="detail-section-title">Activation URL</div>'
            detail_html += '<div style="background:#f1f5f9;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:12px;word-break:break-all;line-height:1.6;margin-top:4px;">'
            if urlForDisplay:
                detail_html += '<div style="margin-bottom:6px;font-weight:600;color:#1e293b;">Link:</div>'
                detail_html += '<div style="margin-bottom:8px;"><a href="' + _safe_str(urlForDisplay).replace('"', '&quot;') + '" target="_blank" style="color:#2563eb;text-decoration:underline;font-size:12px;">' + _safe_str(urlForDisplay) + '</a>'
                detail_html += ' <button class="copy-btn" onclick="event.stopPropagation();copyText(\'' + _safe_str(urlForDisplay).replace("'", "\\'") + '\')" style="font-size:10px;padding:2px 8px;">Copy</button></div>'
                if param_explanations:
                    detail_html += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;"><div style="font-weight:600;color:#475569;font-size:11px;margin-bottom:4px;">Query Parameters:</div>'
                    for pe in param_explanations:
                        detail_html += pe
                    detail_html += '</div>'
            if refUrl:
                detail_html += '<div style="color:#64748b;font-size:11px;margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;">Referrer: <span style="color:#334155;">' + _safe_str(refUrl[:120]) + '</span></div>'
            detail_html += '</div></div>'

            # --- Failure Info ---
            if isFailure or reason:
                detail_html += '<div class="detail-section"><div class="detail-section-title" style="color:#ef4444;">Failure Info</div><table class="detail-table">'
                detail_html += '<tr><td>Reason</td><td style="color:#ef4444;font-weight:600;">' + _safe_str(reason or "Unknown") + '</td></tr>'
                detail_html += '</table></div>'

            # --- Field Explanation Table ---
            detail_html += '<div class="detail-section"><div class="detail-section-title">Field Breakdown</div><table class="detail-table">'
            if device:
                detail_html += '<tr><td>Device ID</td><td style="font-family:monospace;font-size:12px;">' + _safe_str(device) + '</td><td style="color:#64748b;font-size:11px;">Unique identifier of the wearable device</td></tr>'
            if product:
                detail_html += '<tr><td>Product</td><td>' + _safe_str(product) + '</td><td style="color:#64748b;font-size:11px;">Product/SKU identifier</td></tr>'
            if act_code:
                detail_html += '<tr><td>Activation Code</td><td style="font-family:monospace;font-size:12px;">' + _safe_str(act_code) + '</td><td style="color:#64748b;font-size:11px;">18-digit code used to activate the device</td></tr>'
            if redeem_code:
                detail_html += '<tr><td>Redeem Code</td><td style="font-family:monospace;font-size:12px;">' + _safe_str(redeem_code) + '</td><td style="color:#64748b;font-size:11px;">4-digit coupon code for activation</td></tr>'
            if months:
                detail_html += '<tr><td>Duration</td><td>' + _safe_str(months_display or str(months)) + '</td><td style="color:#64748b;font-size:11px;">Validity period of the activation</td></tr>'
            if source:
                detail_html += '<tr><td>Source</td><td>' + _safe_str(source) + '</td><td style="color:#64748b;font-size:11px;">Activation source (user/reuse/sync)</td></tr>'
            detail_html += '</table></div>'

            # --- Device Info ---
            if di:
                detail_html += '<div class="detail-section"><div class="detail-section-title">Device Info</div><table class="detail-table">'
                if di.get("model"): detail_html += '<tr><td>Model</td><td>' + _safe_str(di["model"]) + '</td><td style="color:#64748b;font-size:11px;">Device model number</td></tr>'
                if di.get("product"): detail_html += '<tr><td>Product Name</td><td>' + _safe_str(di["product"]) + '</td><td style="color:#64748b;font-size:11px;">Product marketing name</td></tr>'
                if di.get("osVersionCode"): detail_html += '<tr><td>OS Version</td><td>' + _safe_str(di["osVersionCode"]) + '</td><td style="color:#64748b;font-size:11px;">Firmware/OS version on device</td></tr>'
                if di.get("platformVersionCode"): detail_html += '<tr><td>Platform Ver.</td><td>' + _safe_str(di["platformVersionCode"]) + '</td><td style="color:#64748b;font-size:11px;">Platform SDK version</td></tr>'
                if di.get("deviceType"): detail_html += '<tr><td>Device Type</td><td>' + _safe_str(di["deviceType"]) + '</td><td style="color:#64748b;font-size:11px;">Category: band/watch/ring</td></tr>'
                screen = ""
                if di.get("screenShape"):
                    screen = di["screenShape"]
                    if di.get("screenWidth") and di.get("screenHeight"):
                        screen += " (" + str(di["screenWidth"]) + "x" + str(di["screenHeight"]) + ")"
                if screen: detail_html += '<tr><td>Screen</td><td>' + _safe_str(screen) + '</td><td style="color:#64748b;font-size:11px;">Screen shape & resolution</td></tr>'
                if di.get("apiLevel"): detail_html += '<tr><td>API Level</td><td>' + _safe_str(di["apiLevel"]) + '</td><td style="color:#64748b;font-size:11px;">Firmware API version</td></tr>'
                if di.get("language"): detail_html += '<tr><td>Language</td><td>' + _safe_str(di["language"]) + '</td><td style="color:#64748b;font-size:11px;">Device UI language setting</td></tr>'
                detail_html += '</table></div>'

            # --- Visitor / Browser Info ---
            if vi:
                detail_html += '<div class="detail-section"><div class="detail-section-title">Visitor Info</div><table class="detail-table">'
                if vi.get("ip"):
                    ip_safe = _safe_str(vi["ip"])
                    detail_html += '<tr><td>IP Address</td><td style="font-family:monospace;font-size:12px;font-weight:600;color:#1e293b;">' + ip_safe + ' <button class="geo-btn" onclick="event.stopPropagation();lookupGeo(\'' + ip_safe + '\', this)" style="font-size:10px;padding:2px 6px;margin-left:4px;cursor:pointer;border:1px solid #93c5fd;border-radius:4px;background:#dbeafe;color:#1d4ed8;">Geo</button><span class="geo-result" style="display:block;margin-top:4px;font-size:11px;font-weight:normal;color:#6b7280;"></span></td><td style="color:#64748b;font-size:11px;">Client IP address - click Geo to lookup location</td></tr>'
                if vi.get("os"):
                    detail_html += '<tr><td>OS</td><td>' + _safe_str(vi["os"]) + '</td><td style="color:#64748b;font-size:11px;">Operating system of the visitor</td></tr>'
                if vi.get("browser"):
                    detail_html += '<tr><td>Browser</td><td>' + _safe_str(vi["browser"]) + '</td><td style="color:#64748b;font-size:11px;">Web browser used for activation</td></tr>'
                if vi.get("device"):
                    detail_html += '<tr><td>Device Type</td><td>' + _safe_str(vi["device"]) + '</td><td style="color:#64748b;font-size:11px;">Desktop / Mobile / Tablet</td></tr>'
                if vi.get("language"):
                    detail_html += '<tr><td>Language</td><td>' + _safe_str(vi["language"]) + '</td><td style="color:#64748b;font-size:11px;">Browser language preference (Accept-Language)</td></tr>'
                if vi.get("time"):
                    local_time = vi["time"]
                    detail_html += '<tr><td>Event Time</td><td>' + _safe_str(local_time) + '</td><td style="color:#64748b;font-size:11px;">ISO timestamp of the request</td></tr>'
                if vi.get("origin"):
                    detail_html += '<tr><td>Origin</td><td style="font-family:monospace;font-size:11px;">' + _safe_str(vi["origin"]) + '</td><td style="color:#64748b;font-size:11px;">Request origin header (CORS)</td></tr>'
                if refUrl:
                    detail_html += '<tr><td>Referer</td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:11px;" title="' + _safe_str(refUrl).replace('"', '&quot;') + '">'
                    detail_html += _safe_str(refUrl[:80])
                    if len(refUrl) > 80:
                        detail_html += '...'
                    detail_html += ' <button class="copy-btn" onclick="event.stopPropagation();copyText(\'' + _safe_str(refUrl).replace("'", "\\'") + '\')" style="font-size:10px;padding:2px 6px;">Copy</button>'
                    detail_html += '</td><td style="color:#64748b;font-size:11px;">Referring page URL</td></tr>'
                if vi.get("userAgent"):
                    ua_full = _safe_str(vi["userAgent"])
                    ua_short = ua_full[:120]
                    if len(ua_full) > 120:
                        ua_short += "..."
                    detail_html += '<tr><td>User-Agent</td><td style="font-family:monospace;font-size:10px;max-width:300px;word-break:break-all;line-height:1.5;"><span title="' + ua_full.replace('"', '&quot;') + '">' + ua_short + '</span>'
                    detail_html += ' <button class="copy-btn" onclick="event.stopPropagation();copyText(\'' + ua_full.replace("'", "\\'") + '\')" style="font-size:10px;padding:2px 6px;">Copy</button>'
                    detail_html += '</td><td style="color:#64748b;font-size:11px;">Raw User-Agent string (browser fingerprint)</td></tr>'
                detail_html += '</table></div>'
            detail_html += '</div>'
            rows += '<tr class="detail-expand" id="detail-' + rowId + '"><td colspan="8">' + detail_html + '</td></tr>\n'
            aidx += 1

        if not rows:
            rows = ('<tr><td colspan="8" style="text-align:center;padding:60px">'
                    '<div class="empty-state" style="padding:0">'
                    '<div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>'
                    '<div class="empty-title">No activation records</div>'
                    '<div class="empty-sub">Waiting for device activation events...</div>'
                    '</div></td></tr>')

        table = f"""<div class="table-wrap"><table id="actTable"><thead><tr>
          <th>时间</th><th>产品</th><th>激活码</th><th>兑换码</th>
          <th>设备ID</th><th>版本</th><th>型号</th><th>状态</th>
        </tr></thead><tbody>{rows}</tbody></table></div>"""

        focus_script = ""
        global _focus_redeem
        if _focus_redeem:
            focus_script = '<script>window.__focusRedeem=' + json.dumps(_focus_redeem) + ';</script>'
            _focus_redeem = None

        return stats_html + toggle_btn + filter_html + table + focus_script + """<script>
function lookupGeo(ip, btn) {
  var resultEl = btn.parentElement.querySelector('.geo-result');
  if (!resultEl) return;
  resultEl.textContent = 'Loading...';
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,country,regionName,city,isp,org,query&lang=zh-CN', true);
  xhr.timeout = 5000;
  xhr.onload = function() {
    try {
      var data = JSON.parse(xhr.responseText);
      if (data.status === 'success') {
        var parts = [];
        if (data.country) parts.push(data.country);
        if (data.regionName) parts.push(data.regionName);
        if (data.city && data.city !== data.regionName) parts.push(data.city);
        if (data.isp) parts.push(data.isp);
        resultEl.textContent = parts.join(', ') || 'Unknown';
        resultEl.style.color = '#059669';
        btn.textContent = '✓ Geo';
        btn.style.background = '#d1fae5';
        btn.style.borderColor = '#6ee7b7';
        btn.style.color = '#059669';
      } else {
        resultEl.textContent = 'Lookup failed: ' + (data.message || 'unknown');
      }
    } catch(e) {
      resultEl.textContent = 'Lookup failed';
    }
  };
  xhr.onerror = function() { resultEl.textContent = 'Network error'; };
  xhr.ontimeout = function() { resultEl.textContent = 'Timeout'; };
  xhr.send();
}
(function checkFocusRedeem() {
  var rc = window.__focusRedeem;
  if (!rc) return;
  window.__focusRedeem = null;
  var rows = document.querySelectorAll("#actTable tbody tr.accordion-row");
  for (var i = 0; i < rows.length; i++) {
    var rr = rows[i];
    if (rr.getAttribute("data-redeem") === rc) {
      setTimeout(function() {
        rr.scrollIntoView({ behavior: "smooth", block: "center" });
        rr.click();
      }, 300);
      break;
    }
  }
})();
</script>"""

    def _html_trend(self):
        dates, counts, amounts = _build_trend_data(30)
        act_dates, act_success, act_failed = _build_activation_trend_data(30)
        total_orders = sum(counts)
        total_amount = sum(amounts)
        total_activations = sum(act_success) + sum(act_failed)
        all_orders = _build_order_list()
        all_time_total = len(all_orders)
        dates_js = json.dumps(list(dates))
        counts_js = json.dumps(list(counts))
        amounts_js = json.dumps(list(amounts))
        act_dates_js = json.dumps(list(act_dates))
        act_success_js = json.dumps(list(act_success))
        act_failed_js = json.dumps(list(act_failed))
        avg_orders = total_orders / 30 if total_orders else 0
        avg_revenue = total_amount / 30 if total_amount else 0

        hour_labels, hour_data = _build_hourly_data()
        hour_labels_js = json.dumps(hour_labels)
        hour_data_js = json.dumps(hour_data)

        wday_labels, wday_all_time, wday_this_week = _build_weekly_data()
        wday_labels_js = json.dumps(wday_labels)
        wday_all_js = json.dumps(wday_all_time)
        wday_week_js = json.dumps(wday_this_week)

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
          <div class="stat-card">
            <div class="stat-icon emerald"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></div>
            <div class="stat-body"><div class="stat-value">{all_time_total}</div><div class="stat-label">订单总数</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
            <div class="stat-body"><div class="stat-value">{total_activations}</div><div class="stat-label">30天激活</div></div>
          </div>
        </div>"""

        js_inject = f"""
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded',function(){{
  var ctx=document.getElementById('trendChart');
  if(ctx) {{
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
  }}

  var ctxH=document.getElementById('hourlyChart');
  if(ctxH) {{
    new Chart(ctxH.getContext('2d'),{{
      type:'bar',
      data:{{
        labels:{hour_labels_js},
        datasets:[{{
          label:'Orders per hour',
          data:{hour_data_js},
          backgroundColor:'rgba(99,102,241,0.7)',
          borderColor:'rgba(99,102,241,1)',
          borderWidth:1,
          borderRadius:3
        }}]
      }},
      options:{{
        responsive:true,maintainAspectRatio:false,
        plugins:{{
          title:{{display:true,text:'24-Hour Order Distribution',font:{{size:14,weight:'bold'}},padding:{{bottom:12}}}},
          legend:{{display:false}}
        }},
        scales:{{
          y:{{beginAtZero:true,title:{{display:true,text:'Orders',font:{{size:11}}}},ticks:{{stepSize:1,font:{{size:10}}}},grid:{{color:'rgba(0,0,0,0.04)'}}}},
          x:{{ticks:{{font:{{size:9}},maxRotation:0}},grid:{{display:false}}}}
        }}
      }}
    }});
  }}

  var ctxW=document.getElementById('weeklyChart');
  if(ctxW) {{
    new Chart(ctxW.getContext('2d'),{{
      type:'bar',
      data:{{
        labels:{wday_labels_js},
        datasets:[
          {{
            label:'All-time',
            data:{wday_all_js},
            backgroundColor:'rgba(99,102,241,0.35)',
            borderColor:'rgba(99,102,241,0.6)',
            borderWidth:1,
            borderRadius:4
          }},
          {{
            label:'This week',
            data:{wday_week_js},
            backgroundColor:['rgba(99,102,241,0.7)','rgba(99,102,241,0.7)','rgba(99,102,241,0.7)','rgba(99,102,241,0.7)','rgba(99,102,241,0.7)','rgba(249,115,22,0.7)','rgba(239,68,68,0.7)'],
            borderColor:['rgba(99,102,241,1)','rgba(99,102,241,1)','rgba(99,102,241,1)','rgba(99,102,241,1)','rgba(99,102,241,1)','rgba(249,115,22,1)','rgba(239,68,68,1)'],
            borderWidth:1,
            borderRadius:4
          }}
        ]
      }},
      options:{{
        responsive:true,maintainAspectRatio:false,
        plugins:{{
          title:{{display:true,text:'周订单汇总 (All-time + This Week)',font:{{size:14,weight:'bold'}},padding:{{bottom:12}}}},
          legend:{{position:'top',labels:{{usePointStyle:true,pointStyleWidth:8,padding:16,font:{{size:11}}}}}}
        }},
        scales:{{
          y:{{beginAtZero:true,title:{{display:true,text:'Orders',font:{{size:11}}}},ticks:{{stepSize:1,font:{{size:10}}}},grid:{{color:'rgba(0,0,0,0.04)'}}}},
          x:{{ticks:{{font:{{size:10}}}},grid:{{display:false}}}}
        }}
      }}
    }});
  }}

  var ctxA=document.getElementById('activationChart');
  if(ctxA) {{
    new Chart(ctxA.getContext('2d'),{{
      type:'bar',
      data:{{
        labels:{act_dates_js},
        datasets:[
          {{label:'Activation Success',data:{act_success_js},backgroundColor:'rgba(16,185,129,0.7)',borderColor:'rgba(16,185,129,1)',borderWidth:1,borderRadius:4}},
          {{label:'Activation Failed',data:{act_failed_js},backgroundColor:'rgba(239,68,68,0.5)',borderColor:'rgba(239,68,68,1)',borderWidth:1,borderRadius:4}}
        ]
      }},
      options:{{
        responsive:true,maintainAspectRatio:false,
        interaction:{{mode:'index',intersect:false}},
        plugins:{{
          title:{{display:true,text:'Activation Stats (30 days)',font:{{size:14,weight:'bold'}},padding:{{bottom:12}}}},
          legend:{{position:'top',labels:{{usePointStyle:true,pointStyleWidth:8,padding:24,font:{{size:12}}}}}}
        }},
        scales:{{
          x:{{stacked:true,ticks:{{font:{{size:9}},maxRotation:0}},grid:{{display:false}}}},
          y:{{stacked:true,beginAtZero:true,title:{{display:true,text:'Activations',font:{{size:11}}}},ticks:{{stepSize:1,font:{{size:10}}}},grid:{{color:'rgba(0,0,0,0.04)'}}}}
        }}
      }}
    }});
  }}
}});
</script>"""
        chart30 = f'<div class="chart-wrap"><canvas id="trendChart"></canvas></div>'
        chart_hourly = f'<div class="chart-wrap"><canvas id="hourlyChart"></canvas></div>'
        chart_weekly = f'<div class="chart-wrap"><canvas id="weeklyChart"></canvas></div>'
        chart_activation = f'<div class="chart-wrap"><canvas id="activationChart"></canvas></div>'
        charts_row = f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">{chart_hourly}{chart_weekly}</div>'
        activation_chart_row = f'<div style="margin-top:16px">{chart_activation}</div>'
        return stats_html + chart30 + charts_row + activation_chart_row + js_inject

    def _html_visitors(self):
        visitors = load_visitors()
        stats = _build_visitor_stats()

        afdian_visitors = [v for v in visitors if (v.get("path", "") or "").startswith("/go/")]
        afdian_today = sum(1 for v in afdian_visitors if v.get("time", "").startswith(datetime.now().strftime("%Y-%m-%d")))
        afdian_ips = len(set(v.get("ip", "") for v in afdian_visitors if v.get("ip")))

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

        afdian_stats_html = f"""
        <div class="afdian-stats" id="afdianStats" style="display:none;">
          <div class="afdian-stats-header">爱发电访问统计</div>
          <div class="afdian-stats-grid">
            <div class="afdian-stat-item">
              <div class="afdian-stat-value">{len(afdian_visitors)}</div>
              <div class="afdian-stat-label">爱发电总访问</div>
            </div>
            <div class="afdian-stat-item">
              <div class="afdian-stat-value">{afdian_today}</div>
              <div class="afdian-stat-label">今日</div>
            </div>
            <div class="afdian-stat-item">
              <div class="afdian-stat-value">{afdian_ips}</div>
              <div class="afdian-stat-label">独立IP</div>
            </div>
          </div>
        </div>"""

        visitor_tabs = f"""
        <div class="msg-tabs">
          <button class="msg-tab active" data-visitor-filter="all" onclick="filterVisitors('all')">全部访问 ({stats['total']})</button>
          <button class="msg-tab" data-visitor-filter="afdian" onclick="filterVisitors('afdian')">爱发电 ({len(afdian_visitors)})</button>
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
        vidx = 0
        for v in visitors[:100]:
            path = v.get("path", "") or "/"
            is_afdian = path.startswith("/go/")
            t = _safe_str(v.get("time", "")[-16:] if len(v.get("time", "")) >= 16 else v.get("time", ""))
            host = _safe_str(v.get("hostname", "") or "")
            url_display = (f'<span class="url-hostname">{host}</span><span class="url-path">{_safe_str(path)}</span>' if host else _safe_str(path))
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

            filter_class = "visitor-afdian" if is_afdian else "visitor-all"
            rowId = "visitor" + str(vidx)
            rows += ('<tr class="accordion-row ' + filter_class + '" id="row-' + rowId + '" onclick="toggleRowDetail(\'' + rowId + '\')">'
                     '<td><span class="expand-icon">▶</span> ' + t + '</td>'
                     '<td><div>' + url_display + '</div>' + utm_tags + '</td>'
                     '<td><span class="device-tag ' + device + '">' + _safe_str(device) + '</span></td>'
                     '<td>' + ip + '</td>'
                     '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + host_safe + '">' + host_safe + '</td></tr>\n')

            detail_html = '<div class="detail-card">'
            detail_html += '<div class="detail-section"><div class="detail-section-title">页面信息</div><table class="detail-table">'
            detail_html += '<tr><td>主机</td><td>' + host + '</td></tr>'
            detail_html += '<tr><td>路径</td><td>' + _safe_str(path) + '</td></tr>'
            if v.get("title"): detail_html += '<tr><td>标题</td><td>' + _safe_str(v["title"]) + '</td></tr>'
            detail_html += '</table></div>'

            detail_html += '<div class="detail-section"><div class="detail-section-title">访客信息</div><table class="detail-table">'
            detail_html += '<tr><td>IP地址</td><td>' + ip + '</td></tr>'
            detail_html += '<tr><td>设备类型</td><td>' + _safe_str(v.get("device", "Unknown")) + '</td></tr>'
            if v.get("os"): detail_html += '<tr><td>操作系统</td><td>' + _safe_str(v["os"]) + '</td></tr>'
            if v.get("browser"): detail_html += '<tr><td>浏览器</td><td>' + _safe_str(v["browser"]) + '</td></tr>'
            if v.get("language"): detail_html += '<tr><td>语言</td><td>' + _safe_str(v["language"]) + '</td></tr>'
            if v.get("screen"): detail_html += '<tr><td>屏幕</td><td>' + _safe_str(v["screen"]) + '</td></tr>'
            if v.get("country"): detail_html += '<tr><td>国家</td><td>' + _safe_str(v["country"]) + '</td></tr>'
            if v.get("region"): detail_html += '<tr><td>地区</td><td>' + _safe_str(v["region"]) + '</td></tr>'
            if v.get("utm_source"): detail_html += '<tr><td>UTM Source</td><td>' + _safe_str(v["utm_source"]) + '</td></tr>'
            if v.get("utm_medium"): detail_html += '<tr><td>UTM Medium</td><td>' + _safe_str(v["utm_medium"]) + '</td></tr>'
            if v.get("utm_campaign"): detail_html += '<tr><td>UTM Campaign</td><td>' + _safe_str(v["utm_campaign"]) + '</td></tr>'
            detail_html += '</table></div>'

            refUrl = v.get("referrer", "") or ""
            if refUrl:
                detail_html += '<div class="detail-section"><div class="detail-section-title">来源信息</div><table class="detail-table">'
                refShort = _safe_str(refUrl[:100]) + ("..." if len(refUrl) > 100 else "")
                detail_html += '<tr><td>Referer</td><td style="word-break:break-all">' + refShort + '</td></tr>'
                if v.get("referrer_host"): detail_html += '<tr><td>来源主机</td><td>' + _safe_str(v["referrer_host"]) + '</td></tr>'
                detail_html += '</table></div>'

            if v.get("user_agent"):
                ua = _safe_str(v["user_agent"])
                detail_html += '<div class="detail-section"><div class="detail-section-title">User-Agent</div>'
                detail_html += '<div style="font-size:11px;color:var(--text-secondary);word-break:break-all;max-height:80px;overflow-y:auto">' + ua + '</div>'
                detail_html += '</div>'

            detail_html += '</div>'
            rows += '<tr class="detail-expand ' + filter_class + '" id="detail-' + rowId + '"><td colspan="5">' + detail_html + '</td></tr>\n'
            vidx += 1

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
            <table id="visitorTable">
              <thead><tr><th>时间</th><th>页面URL</th><th>设备</th><th>IP</th><th>来源</th></tr></thead>
              <tbody>{rows}</tbody>
            </table>
          </div>
        </div>"""

        sidebar_right = f'<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">{top_pages_html}{devices_html}</div>' if (top_pages_html and devices_html) else (top_pages_html or devices_html)
        body = stats_html + afdian_stats_html + visitor_tabs + (sidebar_right if sidebar_right else "") + table
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

    def _test_notify(self, ntype):
        if ntype == "popup":
            threading.Thread(target=lambda: notify_macos("测试通知", "弹窗通知功能正常", "这是一条测试弹窗消息"), daemon=True).start()
        elif ntype == "sound":
            threading.Thread(target=lambda: _run_and_ignore_timeout(["afplay", "/System/Library/Sounds/Ping.aiff"], timeout=2), daemon=True).start()
        elif ntype == "voice":
            enqueue_voice("语音播报功能正常，这是一条中文语音测试")
        elif ntype == "visitor_voice":
            enqueue_voice("北京市朝阳区用户访问激活页面")
        _debug_log(f"test_notify: {ntype}")

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
        voice_on = nsettings.get("voice", True)
        voice_color = "var(--green)" if voice_on else "var(--text-tertiary)"
        voice_label = "ON" if voice_on else "OFF"
        voice_url = "ev://setting=voice"
        visitor_voice_on = nsettings.get("visitor_voice", True)
        visitor_voice_color = "var(--green)" if visitor_voice_on else "var(--text-tertiary)"
        visitor_voice_label = "ON" if visitor_voice_on else "OFF"
        visitor_voice_url = "ev://setting=visitor_voice"

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
                  <a class="btn" href="ev://test-notify=popup" style="background:#3b82f6;color:#fff;border-color:#3b82f6;">测试</a>
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
                  <a class="btn" href="ev://test-notify=sound" style="background:#3b82f6;color:#fff;border-color:#3b82f6;">测试</a>
                </div>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">语音播报</div>
                  <div class="settings-row-desc">收到新消息时用语音朗读标题</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-size:11px;font-weight:600;color:{voice_color};">{voice_label}</span>
                  <a class="btn" href="{voice_url}">切换</a>
                  <a class="btn" href="ev://test-notify=voice" style="background:#3b82f6;color:#fff;border-color:#3b82f6;">测试</a>
                </div>
              </div>
              <div class="settings-row">
                <div>
                  <div class="settings-row-label">访客访问语音播报</div>
                  <div class="settings-row-desc">有用户访问网站时用中文语音播报</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-size:11px;font-weight:600;color:{visitor_voice_color};">{visitor_voice_label}</span>
                  <a class="btn" href="{visitor_voice_url}">切换</a>
                  <a class="btn" href="ev://test-notify=visitor_voice" style="background:#3b82f6;color:#fff;border-color:#3b82f6;">测试</a>
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
        self._refresh_content()

    def _mark_all_read(self):
        _debug_log("_mark_all_read: marking all messages as read")
        mark_all_messages_read()
        self._current_page = "messages"
        self._refresh_content()

    def _sync_orders(self):
        global _last_sync_result
        _debug_log("_sync_orders: starting order sync")
        try:
            fd, tmp = tempfile.mkstemp(suffix=".json", prefix="ev_sync_")
            os.close(fd)
            r = subprocess.run([
                "curl", "-s", "--connect-timeout", "10", "--max-time", "30",
                "-X", "GET",
                "https://app-auth.gudq.com/api/afdian/query-orders?action=export",
                "-o", tmp
            ], timeout=35)
            if r.returncode != 0:
                raise ConnectionError(f"curl rc={r.returncode}")
            data = open(tmp).read()
            os.unlink(tmp)
            if not data.strip():
                raise ConnectionError("empty response")
            result = json.loads(data)
            if not result.get("success"):
                raise ConnectionError(result.get("error", "unknown error"))
            remote_orders = result.get("orders", [])
            _debug_log(f"_sync_orders: received {len(remote_orders)} orders from API")
            local_msgs = load_messages()
            existing_trade_nos = set()
            for m in local_msgs:
                if m.get("type") == "new_order":
                    p = m.get("payload", {}) or {}
                    tn = p.get("out_trade_no", "")
                    if tn:
                        existing_trade_nos.add(tn)
            new_count = 0
            for order in remote_orders:
                trade_no = order.get("out_trade_no", "")
                if trade_no in existing_trade_nos:
                    continue
                ts = int(order.get("created_at", 0)) if order.get("created_at") else int(time.time())
                amt_raw = order.get("total_amount", "0")
                try:
                    amt_str = f"{float(amt_raw):.2f}"
                except (ValueError, TypeError):
                    amt_str = "0.00"
                payload = {
                    "out_trade_no": trade_no,
                    "user_name": order.get("user_name", ""),
                    "plan_title": order.get("plan_title", ""),
                    "plan_id": order.get("plan_id", ""),
                    "month": order.get("month", 1),
                    "total_amount": amt_str,
                    "activation_code": order.get("activation_code", ""),
                    "redeem_code": order.get("redeem_code", ""),
                }
                store_message(ts, "new_order", payload)
                existing_trade_nos.add(trade_no)
                new_count += 1
            _last_sync_result = {
                "time": datetime.now().strftime("%H:%M:%S"),
                "total": len(remote_orders),
                "new": new_count,
            }
            _debug_log(f"_sync_orders: done, total={len(remote_orders)}, new={new_count}")
        except Exception as e:
            _last_sync_result = {
                "time": datetime.now().strftime("%H:%M:%S"),
                "total": 0,
                "new": 0,
                "error": str(e),
            }
            _debug_log(f"_sync_orders: error - {e}")
        self._current_page = "orders"
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
        "activations": "_html_activations",
        "visitors": "_html_visitors",
        "trend": "_html_trend",
        "devices": "_html_devices",
        "polls": "_html_polls",
        "settings": "_html_settings",
    }

    _PAGE_TITLES = {
        "messages": ("消息中心", ""),
        "orders": ("订单列表", "订单管理"),
        "activations": ("激活记录", "设备激活历史"),
        "visitors": ("访客浏览", "访问统计"),
        "trend": ("走势图", "数据趋势"),
        "devices": ("设备信息", "设备统计"),
        "polls": ("轮询统计", "手动恢复操作日志"),
        "settings": ("设置", "应用偏好"),
    }

    def _build_current_html(self):
        page = self._current_page

        tab_ids = ["messages", "orders", "activations", "visitors", "trend", "devices", "polls", "settings"]
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

        scripts = f"""
<script>
(function() {{
    function bindClicks() {{
        var links = document.querySelectorAll('.nav-item[data-tab]');
        for (var k = 0; k < links.length; k++) {{
            links[k].addEventListener('click', function(e) {{
                e.preventDefault();
                e.stopPropagation();
                var tabId = this.getAttribute('data-tab');
                if (tabId) {{
                    window.location = 'ev://nav=' + tabId;
                }}
                return false;
            }});
        }}
    }}

    document.addEventListener('DOMContentLoaded', function() {{
        bindClicks();
        if ('{page}' === 'messages') {{
            filterMessages('unread');
        }}
        if ('{page}' === 'visitors') {{
            filterVisitors('all');
        }}
    }});
}})();
</script>"""
        return self._html_wrap(tab_html, title, subtitle, scripts=scripts)

    def windowWillClose_(self, notification):
        # 用户关掉面板 → 立即丢弃窗口/WebView/delegate 引用，下次打开一律重建。
        # ⚠️ 实测（2026-09-23）：用**纯 Python 对象**注册的 selector 在应用里**从未被调用**（_retired 恒为 0），
        # 所以别依赖它做关键清理；真正的兜底是 _create_window() 里的 setReleasedWhenClosed_(False)
        # + _show_impl() 里"不可见就重建"。这里保留只为将来换成 NSObject 子类/窗口 delegate 时可用。
        _debug_log("windowWillClose_: 丢弃窗口引用，下次打开重建")
        self._retired.append((self._window, self._webview, self._nav_delegate))
        del self._retired[:-3]
        self._window = None
        self._webview = None
        self._nav_delegate = None
        self._msg_text = None
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyAccessory)


class EvNotifier(rumps.App):
    def __init__(self):
        super().__init__(f"Ev {VERSION}", quit_button=None)
        self._thread = threading.Thread(target=_run_event_loop, daemon=True)
        self._thread.start()
        self._dash = DashboardWindow(self)
        ensure_auto_start()
        self.menu.add(self._version_menu())
        try:
            self.menu.add(rumps.separator)
        except Exception:
            pass
        restart_menu = rumps.MenuItem("重启")
        restart_menu.add(rumps.MenuItem("重启 VS Code", callback=self.restart_vscode))
        restart_menu.add(rumps.MenuItem("重启 AIOT IDE", callback=self.restart_aiot_ide))
        restart_menu.add(rumps.MenuItem("重启 AstroBox", callback=self.restart_astrobox))
        restart_menu.add(rumps.separator)
        restart_menu.add(rumps.MenuItem("重启 Ev Notifier", callback=self.restart_self))
        restart_menu.add(rumps.MenuItem("全部重启", callback=self.restart_all))
        self.menu.add(restart_menu)
        # 截图：菜单项 + 快捷键 ⌃⇧⌘4（容易忘，显式展示；点击菜单项即可开始截图）
        try:
            from AppKit import NSControlKeyMask, NSShiftKeyMask, NSCommandKeyMask
            shot_item = rumps.MenuItem("截图", callback=self.start_screenshot, key="4")
            shot_item._menuitem.setKeyEquivalentModifierMask_(
                NSControlKeyMask | NSShiftKeyMask | NSCommandKeyMask)
            self.menu.add(shot_item)
        except Exception as e:
            _debug_log(f"screenshot menu setup ERROR: {e}")
        try:
            self.menu.add(rumps.separator)
        except Exception:
            pass
        try:
            from AppKit import NSApp, NSApplicationActivationPolicyAccessory
            NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        except Exception:
            pass

    @rumps.clicked("退出")
    def quit_app(self, _):
        disable_auto_start()
        _release_pid_lock()
        _mark_clean_exit("menu_quit")
        from AppKit import NSApp
        NSApp.terminate_(None)

    def restart_self(self, _):
        import sys, os
        _debug_log("restart_self: execv 原地重启（非崩溃）")
        _mark_clean_exit("execv_restart")   # 主动重启不算异常终止
        os.execv(sys.executable, [sys.executable] + sys.argv)

    def restart_vscode(self, _):
        threading.Thread(target=self._do_force_restart,
                         args=("Visual Studio Code", "Visual Studio Code"),
                         daemon=True).start()

    def restart_aiot_ide(self, _):
        threading.Thread(target=self._do_force_restart,
                         args=("AIOT IDE", "AIOT IDE"),
                         daemon=True).start()

    def restart_astrobox(self, _):
        threading.Thread(target=self._do_force_restart,
                         args=("AstroBox", "AstroBox"),
                         daemon=True).start()

    def restart_all(self, _):
        threading.Thread(target=self._do_restart_all, daemon=True).start()

    def _do_restart_all(self):
        apps = [
            ("Visual Studio Code", "Visual Studio Code"),
            ("AIOT IDE", "AIOT IDE"),
            ("AstroBox", "AstroBox"),
        ]
        for app_name, open_target in apps:
            self._do_force_restart(app_name, open_target)
        self.restart_self(None)

    def _do_force_restart(self, app_name, open_target):
        subprocess.run(["osascript", "-e",
                        f'tell application "{app_name}" to quit'],
                       capture_output=True)
        time.sleep(1)
        subprocess.run(["pkill", "-9", "-i", app_name],
                       capture_output=True)
        time.sleep(5)
        subprocess.run(["open", "-a", open_target],
                       capture_output=True)
        rumps.notification("Ev Notifier", f"{app_name} restarted", "",
                           sound=False)

    def _version_menu(self):
        menu = rumps.MenuItem(f"版本: {VERSION}")
        return menu

    def start_screenshot(self, _):
        """触发系统原生快捷键 ⌃⇧⌘4 开始截图。延到下一轮 runloop，避免在菜单追踪栈里发按键。"""
        _debug_log("start_screenshot clicked")
        try:
            from PyObjCTools import AppHelper
            AppHelper.callLater(0.3, self._do_screenshot)
        except Exception as e:
            _debug_log(f"callLater unavailable ({e}), fallback to sync")
            self._do_screenshot()

    def _do_screenshot(self):
        # 直接触发系统原生快捷键 ⌃⇧⌘4（复制选区截图到剪贴板），
        # 与用户手动按下该组合键 100% 等价：原生十字选区、缩略图、剪贴板全走系统原生链路。
        # key code 21 = 数字键 4。需要「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能 → 勾选 Python。
        script = ('tell application "System Events" to key code 21 '
                  'using {control down, shift down, command down}')
        try:
            r = subprocess.run(["osascript", "-e", script],
                               capture_output=True, timeout=10)
            if r.returncode != 0:
                err = (r.stderr or b"").decode(errors="replace").strip()
                _debug_log(f"native screenshot shortcut ERROR: {err}")
                try:
                    rumps.notification(f"Ev {VERSION}", "截图快捷键触发失败",
                                       "请在 系统设置→隐私与安全性→辅助功能 中授权 Python",
                                       sound=False)
                except Exception:
                    pass
        except Exception as e:
            _debug_log(f"native screenshot shortcut ERROR: {e}")

    @rumps.timer(2)
    def _update_title(self, _):
        if _new_msg_count > 0:
            badge = min(_new_msg_count, 99)
            self.title = f"Ev {VERSION} ({badge})"
        else:
            self.title = f"Ev {VERSION}"

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
        """只做「投递」：真正的建窗/导航延到主线程下一轮 runloop 执行。

        2026-09-23 崩溃排查结论：菜单回调是在 `NSStatusItem → NSMenu → sendAction → NSMenuTrackingSession`
        的同步栈里跑的，在这段栈里做 AppKit 建窗 / WebView 导航会在同一进程第 2 次打开面板时
        触发 pyobjc 类型校验 trap（SIGTRAP / EXC_BREAKPOINT），try/except 抓不住、进程秒崩。
        改用 AppHelper.callLater 排到下一轮 runloop（菜单收起后），彻底离开菜单事件循环。
        """
        _debug_log("open_dashboard clicked (deferred -> next runloop)")
        try:
            from PyObjCTools import AppHelper
            AppHelper.callLater(0.05, self._dash.show)
        except Exception as e:
            _debug_log(f"callLater unavailable ({e}), fallback to synchronous show")
            try:
                self._dash.show()
            except Exception as e2:
                _debug_log(f"open_dashboard ERROR: {e2}")

    @rumps.clicked("暂停/恢复")
    def toggle_pause(self, _):
        try:
            global _paused
            _paused = not _paused
            state = "已暂停" if _paused else "已恢复"
            rumps.notification(f"Ev {VERSION}", "", state, sound=False)
        except Exception as e:
            _debug_log(f"toggle_pause ERROR: {e}")

    @rumps.clicked("状态")
    def status_btn(self, _):
        try:
            lt = _safe_localtime(_last_msg_ts)
            ts_str = time.strftime("%H:%M:%S", lt) if lt else "无"
            status_str = "Online" if _status == "connected" else ("Reconnecting" if "retry" in _status else "Offline")
            text = (f"Status: {status_str}\nMessages today: {_new_msg_count}\nLast message: {ts_str}")
            rumps.alert(f"Ev {VERSION}", text)
        except Exception as e:
            _debug_log(f"status_btn ERROR: {e}")

    @rumps.clicked("调试日志")
    def debug_log_btn(self, _):
        try:
            with open(os.path.expanduser("~/.ev_debug.log"), "r") as f:
                lines_raw = f.readlines()
        except Exception:
            lines_raw = []
        if not lines_raw:
            rumps.alert("调试日志", "暂无日志")
            return
        lines = [line.rstrip("\n") for line in lines_raw[-30:]]
        text = "\n".join(lines)
        rumps.alert(f"调试日志 (最近{min(30, len(lines_raw))}条)", text[:800])


def main():
    global _app_ref
    app = EvNotifier()
    _app_ref = app
    _record_startup()
    print(f"Ev Notifier {VERSION} started: {REST_API_URL}")
    app.run()


PID_FILE = os.path.expanduser("~/.ev_notifier.pid")


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


if __name__ == "__main__":
    if not _acquire_pid_lock():
        sys.exit(0)
    atexit.register(_release_pid_lock)
    atexit.register(lambda: _voice_queue.put(None))
    atexit.register(lambda: _mark_clean_exit("atexit"))   # 崩溃(trap)不会走到这里 → 用于区分异常终止
    load_env()
    main()