"""Ev Notifier v1.1.1 - Milestone: menu bar + integrity check + recovery poll + poll log"""
import json, os, re, subprocess, sys, tempfile, time, threading, urllib.parse
from datetime import datetime

try:
    from AppKit import NSApplication, NSApplicationActivationPolicyAccessory
    NSApplication.sharedApplication().setActivationPolicy_(NSApplicationActivationPolicyAccessory)
except Exception:
    pass

import rumps

DOTENV = [
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env"),
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env.local"),
    os.path.expanduser("~/.ev-notifier.env"),
]
REST_API_URL = None
UPSTASH_TOKEN = None
STREAM_KEY = "auth:notifications:stream"
LAST_ID_FILE = os.path.expanduser("~/.ev_last_id_v1.1.1")
RECEIVED_FILE = os.path.expanduser("~/.ev_received.json")
POLL_LOG_FILE = os.path.expanduser("~/.ev_poll_log.json")

POLL_LIMIT_PER_HOUR = 1
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
        import subprocess
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
    if _app_ref:
        _app_ref.title = f"Ev({_new_msg_count})"


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
                _app_ref.title = "Connecting..."
            ping = upstash_http("ping", timeout=5)
            if ping.get("result") != "PONG":
                raise ConnectionError(f"PING failed: {ping}")
            _status = "connected"
            reconnect_delay = 1
            if _app_ref:
                _app_ref.title = f"Ev({_new_msg_count})" if _new_msg_count else "Ev Online"
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
                _app_ref.title = f"Retry({reconnect_delay}s)..."
            time.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, 30)


def _run_event_loop():
    redis_loop()


class EvNotifier(rumps.App):
    def __init__(self):
        super().__init__("Ev", quit_button="Quit")
        try:
            from AppKit import NSApp, NSApplicationActivationPolicyAccessory
            NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        except Exception:
            pass
        self._thread = threading.Thread(target=_run_event_loop, daemon=True)
        self._thread.start()

    @rumps.clicked("Status")
    def status_btn(self, _):
        ts_str = time.strftime("%H:%M:%S", time.localtime(_last_msg_ts)) if _last_msg_ts else "None"
        rumps.alert(
            "Ev Notifier v1.1.1",
            f"Status: {_status}\n"
            f"Stream: {STREAM_KEY}\n"
            f"Received today: {_new_msg_count}\n"
            f"Recovery polls today: {_recovery_count_today}\n"
            f"Last message: {ts_str}"
        )

    @rumps.clicked("Pause/Resume")
    def toggle_pause(self, _):
        global _paused
        _paused = not _paused
        rumps.notification("Ev Notifier", "", "Paused" if _paused else "Resumed", sound=False)

    @rumps.clicked("Reset Counter")
    def reset_count(self, _):
        global _new_msg_count, _seen_ids
        _new_msg_count = 0
        _seen_ids.clear()
        rumps.notification("Ev Notifier", "", "Counter reset", sound=False)

    @rumps.clicked("View Poll Log")
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
                    lines.append(f"{date_str} {p['time']}  recovered={p['recovered']}  {p['reason']}")
            if not lines:
                lines.append("No recovery polls yet")
            text = "\n".join(lines)
            rumps.alert(
                f"Poll Log | Today: {today_polls} | Month: {month_total}",
                text[:500]
            )
        except Exception as e:
            rumps.alert("Error", str(e))


def main():
    global _app_ref
    app = EvNotifier()
    _app_ref = app
    print(f"Ev Notifier v1.1.1 started: {REST_API_URL}")
    app.run()


if __name__ == "__main__":
    load_env()
    main()