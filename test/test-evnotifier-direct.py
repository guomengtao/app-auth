#!/usr/bin/env python3
"""Direct test: connect to Upstash, read 1 message, process it."""

import sys, os, re, ssl, socket, time, json, platform, subprocess

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools', 'ev-notifier'))

DOTENV_CANDIDATES = [
    os.path.join(os.path.dirname(__file__), '..', '.env'),
    os.path.join(os.path.dirname(__file__), '..', '.env.local'),
    os.path.expanduser("~/.ev-notifier.env"),
]

UPSTASH_HOST = None
UPSTASH_PORT = 6379
UPSTASH_TOKEN = None
STREAM_KEY = "auth:notifications:stream"
GROUP_NAME = "ev-notifiers"
CONSUMER_NAME = "mac-" + platform.node().replace(".", "-") + "-diag"

def load_env():
    global UPSTASH_HOST, UPSTASH_TOKEN
    env = {}
    for p in DOTENV_CANDIDATES:
        if os.path.isfile(p):
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    m = re.match(r'^([A-Z_]+)=(.*)$', line)
                    if not m:
                        continue
                    v = m.group(2).strip().strip('"\'')
                    if v == "[SENSITIVE]":
                        continue
                    env[m.group(1)] = v
    url = env.get("KV_REST_API_URL") or env.get("UPSTASH_REDIS_REST_URL") or ""
    if url:
        UPSTASH_HOST = re.sub(r'^https?://', '', url).rstrip('/')
    UPSTASH_TOKEN = env.get("KV_REST_API_TOKEN") or env.get("UPSTASH_REDIS_REST_TOKEN")

def send_cmd(sock, *args):
    arr = '*' + str(len(args)) + '\r\n'
    for a in args:
        s = str(a)
        arr += '$' + str(len(s)) + '\r\n' + s + '\r\n'
    sock.sendall(arr.encode())

def read_resp(sock, wait=0.3):
    time.sleep(wait)
    buf = b''
    try:
        sock.settimeout(1.0)
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            buf += chunk
    except socket.timeout:
        pass
    except:
        pass
    sock.settimeout(None)
    return buf.decode(errors='replace')

def parse_resp(data):
    """Simple RESP parser, returns (value, remaining_bytes)"""
    if not data:
        return None, data
    c = data[0]
    if c == '+':
        nl = data.index('\r\n')
        return data[1:nl], data[nl+2:]
    elif c == '-':
        nl = data.index('\r\n')
        return ('error', data[1:nl]), data[nl+2:]
    elif c == ':':
        nl = data.index('\r\n')
        return int(data[1:nl]), data[nl+2:]
    elif c == '$':
        nl = data.index('\r\n')
        n = int(data[1:nl])
        if n < 0:
            return None, data[nl+2:]
        pos = nl + 2
        return data[pos:pos+n], data[pos+n+2:]
    elif c == '*':
        nl = data.index('\r\n')
        n = int(data[1:nl])
        pos = nl + 2
        arr = []
        for _ in range(n):
            item, remaining = parse_resp(data[pos:])
            arr.append(item)
            pos = len(data) - len(remaining)
        return arr, data[pos:]
    else:
        return None, data

def notify_macos(title, subtitle, message):
    def esc(s):
        return str(s).replace('\\', '\\\\').replace('"', '\\"')
    script = (
        f'display notification "{esc(message)}" '
        f'with title "{esc(title)}" subtitle "{esc(subtitle)}" '
        'sound name "Glass"'
    )
    try:
        subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"  notify failed: {e}")

def handle_message(msg):
    ts = msg.get("ts", 0)
    mtype = msg.get("type", "unknown")
    p = msg.get("payload", {}) or {}
    ts_label = time.strftime("%H:%M:%S", time.localtime(ts)) if ts else ""

    print(f"  type={mtype}, ts={ts}, payload keys={list(p.keys())}")

    if mtype == "new_activation":
        title = "🎫 兑换码已激活"
        subtitle = p.get("product_name", "") or f"Product #{p.get('product_id', '')}"
        body = f"激活码: {p.get('activation_code', '')}\n兑换码: {p.get('redeem_code', '')}\n设备: {p.get('device_id', '')}\n⏱ {ts_label}"
    elif mtype == "activation_failure":
        title = "❌ 兑换失败"
        subtitle = p.get("reason", "") or p.get("error", "") or "未知错误"
        body = f"兑换码: {p.get('redeem_code', '')}\n设备: {p.get('device_id', '')}\n⏱ {ts_label}"
    elif mtype == "page_visit":
        title = "🌐 网站访问"
        subtitle = p.get("title", "") or p.get("page", "") or "/"
        body = f"页面: {p.get('page', '')}\n来源: {p.get('referrer', '')}\n⏱ {ts_label}"
    else:
        title = f"📨 {mtype}"
        subtitle = ts_label
        body = json.dumps(p, ensure_ascii=False)[:200]

    print(f"  [{ts_label}] {title} | {subtitle}")
    for line in body.split('\n'):
        print(f"    {line}")
    notify_macos(title, subtitle, body)
    return True

def main():
    load_env()
    print(f"Host: {UPSTASH_HOST}")
    print(f"Token: {UPSTASH_TOKEN[:20]}...")
    print(f"Consumer: {CONSUMER_NAME}")

    ctx = ssl.create_default_context()
    sock = socket.create_connection((UPSTASH_HOST, UPSTASH_PORT), timeout=10)
    ssock = ctx.wrap_socket(sock, server_hostname=UPSTASH_HOST)

    send_cmd(ssock, 'AUTH', UPSTASH_TOKEN)
    resp = read_resp(ssock)
    print(f"AUTH: {resp.strip()}")

    send_cmd(ssock, 'XGROUP', 'CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM')
    resp = read_resp(ssock)
    print(f"XGROUP CREATE: {resp.strip()}")

    print("Waiting for messages (30s)...")

    start = time.time()
    while time.time() - start < 30:
        send_cmd(ssock, 'XREADGROUP', 'GROUP', GROUP_NAME, CONSUMER_NAME,
                 'COUNT', '5', 'BLOCK', '3000',
                 'STREAMS', STREAM_KEY, '>')
        raw = read_resp(ssock, wait=3.5)
        if not raw or raw.startswith('-'):
            continue

        parsed, _ = parse_resp(raw)
        if not isinstance(parsed, list) or len(parsed) == 0:
            continue

        if isinstance(parsed, list) and len(parsed) == 1:
            parsed = parsed[0]

        if not isinstance(parsed, list) or len(parsed) < 2:
            continue

        messages = parsed[1]
        if not isinstance(messages, list):
            continue

        print(f"Received {len(messages)} message(s)")

        for msg_entry in messages:
            if not isinstance(msg_entry, list) or len(msg_entry) < 2:
                continue
            msg_id = msg_entry[0]
            fields = msg_entry[1]
            if not isinstance(fields, list):
                continue

            data_raw = None
            for i in range(0, len(fields) - 1, 2):
                if fields[i] == 'data':
                    data_raw = fields[i + 1]
                    break

            if data_raw:
                try:
                    msg = json.loads(data_raw)
                    print(f"  msg_id={msg_id}")
                    handle_message(msg)
                except Exception as e:
                    print(f"  json parse error: {e}, raw: {data_raw[:100]}")
                    continue

            send_cmd(ssock, 'XACK', STREAM_KEY, GROUP_NAME, msg_id)
            ack_raw = read_resp(ssock)
            print(f"  XACK={msg_id}: {ack_raw.strip()}")

    ssock.close()
    print("Done")

if __name__ == '__main__':
    main()