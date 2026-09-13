"""Ev Notifier v1.0.4 - v1.0.3 + integrity check (detect loss, log only)"""
import json, os, re, subprocess, sys, tempfile, time, urllib.parse
from datetime import datetime

DOTENV = [
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env"),
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env.local"),
    os.path.expanduser("~/.ev-notifier.env"),
]
REST_API_URL = None
UPSTASH_TOKEN = None
STREAM_KEY = "auth:notifications:stream"
ENCODED_KEY = None
LAST_ID_FILE = os.path.expanduser("~/.ev_last_id_v1.0.4")
RECEIVED_FILE = os.path.expanduser("~/.ev_received.json")


def load_env():
    global REST_API_URL, UPSTASH_TOKEN, ENCODED_KEY
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
        print("ERROR: Config not found. Create ~/.ev-notifier.env")
        sys.exit(1)
    ENCODED_KEY = urllib.parse.quote(STREAM_KEY, safe="")


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
    total = day_data.get("total_server", 0)
    received = day_data.get("received_idx", [])
    local_cnt = len(received)

    if total <= 0:
        return

    if local_cnt < total:
        missing = total - local_cnt
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] LOSS: server={total}, local={local_cnt}, missing={missing}")


def main():
    print("Ev Notifier v1.0.4 - Integrity Check")
    print("-" * 40)
    print(f"URL: {REST_API_URL}")
    print(f"Stream: {STREAM_KEY}")
    print(f"Received file: {RECEIVED_FILE}")

    try:
        ping = upstash_http("ping", timeout=5)
        if ping.get("result") != "PONG":
            print(f"PING failed: {ping}")
            return 1
        print("PING: OK")
    except Exception as e:
        print(f"FAIL: {e}")
        return 1

    last_id = load_last_id()
    print(f"last_id: {last_id}")
    print("Polling... (Ctrl+C to stop)")

    while True:
        try:
            result = upstash_http("xrange", ENCODED_KEY, last_id, "+", timeout=10)
            messages = result.get("result", [])
            if messages:
                for msg_entry in messages:
                    if not isinstance(msg_entry, list) or len(msg_entry) < 2:
                        continue
                    msg_id = msg_entry[0]
                    fields = msg_entry[1]
                    if msg_id == last_id:
                        continue

                    day_data = record_message(msg_id, fields)
                    ts = time.strftime("%H:%M:%S")
                    local_cnt = len(day_data.get("received_idx", []))
                    server_cnt = day_data.get("total_server", 0)
                    print(f"[{ts}] {msg_id} | local={local_cnt} server={server_cnt}")

                    check_integrity(day_data)

                    last_id = msg_id
                save_last_id(last_id)
            time.sleep(5)
        except KeyboardInterrupt:
            print("\nStopped.")
            return 0
        except Exception as e:
            print(f"Error: {e}, retrying in 5s...")
            time.sleep(5)


if __name__ == "__main__":
    load_env()
    sys.exit(main())