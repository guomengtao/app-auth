"""Ev Notifier v1.0.1 - Connection Test (PING only)"""
import json, os, re, subprocess, sys, tempfile

DOTENV = [
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env"),
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env.local"),
    os.path.expanduser("~/.ev-notifier.env"),
]
REST_API_URL = None
UPSTASH_TOKEN = None


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


def upstash_http(cmd, timeout=5):
    url = f"{REST_API_URL}/{cmd}"
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


def main():
    print("Ev Notifier v1.0.1 - Connection Test")
    print("-" * 40)
    print(f"URL: {REST_API_URL}")
    print("Testing ping...")
    try:
        res = upstash_http("ping", timeout=5)
        if res.get("result") == "PONG":
            print("OK: PONG - Upstash is reachable")
            return 0
        print(f"WARN: unexpected: {res}")
        return 1
    except Exception as e:
        print(f"FAIL: {e}")
        return 1


if __name__ == "__main__":
    load_env()
    sys.exit(main())