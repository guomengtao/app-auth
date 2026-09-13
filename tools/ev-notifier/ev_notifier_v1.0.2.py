"""Ev Notifier v1.0.2 - XRANGE polling, print messages to terminal"""
import json, os, re, subprocess, sys, tempfile, time, urllib.parse

DOTENV = [
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env"),
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env.local"),
    os.path.expanduser("~/.ev-notifier.env"),
]
REST_API_URL = None
UPSTASH_TOKEN = None
STREAM_KEY = "auth:notifications:stream"
LAST_ID_FILE = os.path.expanduser("~/.ev_last_id_v1.0.2")


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
        print("ERROR: Config not found. Create ~/.ev-notifier.env")
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


def main():
    print("Ev Notifier v1.0.2 - XRANGE Polling")
    print("-" * 40)
    print(f"URL: {REST_API_URL}")
    print(f"Stream: {STREAM_KEY}")

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
    print("Polling for messages... (Ctrl+C to stop)")
    print()

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
                    ts = time.strftime("%H:%M:%S")
                    print(f"[{ts}] {msg_id} fields={len(fields)}")
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