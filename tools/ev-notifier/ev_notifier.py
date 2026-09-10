"""
Ev课程表 Mac原生通知器
Upstash Redis Pub/Sub (原生 TLS TCP, 零轮询零带宽浪费)
菜单栏常驻,系统通知到达

依赖: pip install rumps --break-system-packages
"""
import asyncio
import json
import os
import re
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

import rumps

DOTENV_CANDIDATES = [
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env"),
    os.path.expanduser("~/Documents/guomengtao/app-auth/.env.local"),
    os.path.expanduser("~/.ev-notifier.env"),
]

UPSTASH_HOST = None
UPSTASH_PORT = 6379
UPSTASH_TOKEN = None
PUSH_CHANNEL = "auth:push_channel"


def _parse_env_line(line):
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    m = re.match(r'^([A-Z_]+)=(.*)$', line)
    if not m:
        return None
    v = m.group(2).strip()
    v = v.strip('"\'')
    if v == "[SENSITIVE]":
        return None
    return m.group(1), v


def load_env():
    global UPSTASH_HOST, UPSTASH_PORT, UPSTASH_TOKEN
    env = {}
    for p in DOTENV_CANDIDATES:
        if os.path.isfile(p):
            with open(p) as f:
                for line in f:
                    kv = _parse_env_line(line)
                    if kv:
                        env[kv[0]] = kv[1]
    url = env.get("KV_REST_API_URL") or env.get("UPSTASH_REDIS_REST_URL") or ""
    if url:
        UPSTASH_HOST = re.sub(r'^https?://', '', url).rstrip('/')
    UPSTASH_TOKEN = env.get("KV_REST_API_TOKEN") or env.get("UPSTASH_REDIS_REST_TOKEN")
    if not UPSTASH_HOST or not UPSTASH_TOKEN:
        print("Error: KV_REST_API_URL or KV_REST_API_TOKEN not found.")
        print("Create ~/.ev-notifier.env with:")
        print("  KV_REST_API_URL=https://xxx.upstash.io")
        print("  KV_REST_API_TOKEN=xxx")
        sys.exit(1)


load_env()


def redis_bulk(s):
    return f"${len(s)}\r\n{s}\r\n".encode()


def redis_array(*parts):
    body = b"".join(redis_bulk(p) for p in parts)
    return f"*{len(parts)}\r\n".encode() + body


def parse_redis_reply(data):
    data = data.decode(errors="replace")
    lines = data.split("\r\n")
    i = 0

    def parse_one():
        nonlocal i
        if i >= len(lines):
            return None
        t = lines[i]
        i += 1
        if t.startswith("+"):
            return t[1:]
        if t.startswith("-"):
            return ("error", t[1:])
        if t.startswith(":"):
            return int(t[1:])
        if t.startswith("$"):
            v = lines[i] if i < len(lines) else ""
            i += 1
            return v
        if t.startswith("*"):
            count = int(t[1:])
            r = []
            for _ in range(count):
                r.append(parse_one())
            return r
        return None

    return parse_one()


_seen_ids = set()
_MAX_SEEN = 500
_new_msg_count = 0
_last_msg_ts = 0
_paused = False
_status = "connecting"
_app_ref = None
_event_loop = None


def notify_macos(title, subtitle, message, sound=True):
    safe_msg = message.replace('"', '\\"').replace("'", "\\'")
    safe_sub = subtitle.replace('"', '\\"').replace("'", "\\'")
    sound_part = 'sound name "Glass"' if sound else ''
    script = f'display notification "{safe_msg}" with title "{title}" subtitle "{safe_sub}" {sound_part}'
    try:
        subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def handle_message(msg):
    global _last_msg_ts, _new_msg_count
    global _paused
    if _paused:
        return
    ts = msg.get("ts", 0)
    mtype = msg.get("type", "unknown")
    payload = msg.get("payload", {})

    mid = f"{ts}_{mtype}"
    if mid in _seen_ids:
        return
    _seen_ids.add(mid)
    if len(_seen_ids) > _MAX_SEEN:
        _seen_ids.clear()

    _last_msg_ts = ts
    _new_msg_count += 1

    title_map = {
        "new_activation": "兑换码已激活",
        "activation_failure": "兑换失败",
        "new_order": "新订单",
        "test_push": "测试推送",
    }
    title = title_map.get(mtype, mtype)

    code = payload.get("code", "")
    plan = payload.get("plan", payload.get("plan_name", ""))
    reason = payload.get("reason", "")

    if mtype == "new_activation":
        msg_text = f"{plan} · {code}"
    elif mtype == "activation_failure":
        msg_text = f"{code} {reason}"
    elif mtype == "new_order":
        msg_text = f"{plan} · 爱发电"
    else:
        msg_text = json.dumps(payload, ensure_ascii=False)[:100]

    print(f"[{time.strftime('%H:%M:%S')}] {title}: {msg_text}")
    notify_macos(title, plan or "", msg_text)

    if _app_ref:
        _app_ref.title = f"📦 Ev({_new_msg_count})"


async def redis_loop():
    global _status
    reconnect_delay = 1
    ctx = ssl.create_default_context()

    while True:
        try:
            _status = "connecting"
            if _app_ref:
                _app_ref.title = "📡 连接中..."

            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(UPSTASH_HOST, UPSTASH_PORT, ssl=ctx),
                timeout=10
            )

            _status = "authenticating"
            writer.write(redis_array("AUTH", UPSTASH_TOKEN))
            await writer.drain()
            auth_raw = await asyncio.wait_for(reader.read(4096), timeout=5)
            auth_reply = parse_redis_reply(auth_raw)

            if isinstance(auth_reply, tuple) and auth_reply[0] == "error":
                print(f"AUTH failed: {auth_reply}")
                writer.close()
                await writer.wait_closed()
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, 30)
                continue

            writer.write(redis_array("SUBSCRIBE", PUSH_CHANNEL))
            await writer.drain()
            sub_raw = await asyncio.wait_for(reader.read(4096), timeout=5)
            sub_reply = parse_redis_reply(sub_raw)

            _status = "connected"
            reconnect_delay = 1
            if _app_ref:
                _app_ref.title = "📦 Ev在线"

            print(f"✅ Connected to {UPSTASH_HOST}:{UPSTASH_PORT}, subscribed to {PUSH_CHANNEL}")

            heartbeat_counter = 0
            while True:
                try:
                    raw = await asyncio.wait_for(reader.read(8192), timeout=30)
                    if not raw:
                        raise ConnectionError("connection closed")
                    reply = parse_redis_reply(raw)
                    if isinstance(reply, list) and len(reply) >= 3 and reply[0] == "message":
                        channel = reply[1]
                        payload_raw = reply[2]
                        if channel != PUSH_CHANNEL:
                            continue
                        try:
                            msg = json.loads(payload_raw)
                        except Exception:
                            continue
                        handle_message(msg)
                except asyncio.TimeoutError:
                    heartbeat_counter += 1
                    if heartbeat_counter >= 3:
                        print("⏰ No data for 90s, reconnecting...")
                        raise ConnectionError("heartbeat timeout")

        except asyncio.CancelledError:
            break
        except ConnectionRefusedError:
            _status = f"retry({reconnect_delay}s)"
            if _app_ref:
                _app_ref.title = f"📡 重连中({reconnect_delay}s)..."
            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, 30)
        except Exception as e:
            _status = f"error: {type(e).__name__}"
            print(f"⚠️ {e}, retrying in {reconnect_delay}s...")
            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, 30)


def _run_event_loop():
    global _event_loop
    loop = asyncio.new_event_loop()
    _event_loop = loop
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(redis_loop())
    finally:
        loop.close()


class EvNotifier(rumps.App):
    def __init__(self):
        super().__init__("📦 Ev", quit_button="退出")
        self._thread = threading.Thread(target=_run_event_loop, daemon=True)
        self._thread.start()

    @rumps.clicked("查看状态")
    def status_btn(self, _):
        if _status == "connected":
            ts_str = time.strftime('%H:%M:%S', time.localtime(_last_msg_ts)) if _last_msg_ts else "无"
            rumps.alert(
                "Ev通知器",
                f"✅ 已连接到 Upstash\n"
                f"频道: {PUSH_CHANNEL}\n"
                f"端口: {UPSTASH_PORT}\n"
                f"今日已收: {_new_msg_count} 条\n"
                f"上次消息: {ts_str}"
            )
        else:
            rumps.alert("Ev通知器", f"❌ 当前状态: {_status}\n正在尝试自动重连...")

    @rumps.clicked("暂停/恢复")
    def toggle_pause(self, _):
        global _paused
        _paused = not _paused
        rumps.notification("Ev通知器", "", "已暂停" if _paused else "已恢复", sound=False)

    @rumps.clicked("重置计数")
    def reset_count(self, _):
        global _new_msg_count, _seen_ids
        _new_msg_count = 0
        _seen_ids.clear()
        rumps.notification("Ev通知器", "", "计数已重置", sound=False)


def main():
    global _app_ref
    app = EvNotifier()
    _app_ref = app
    print(f"Ev通知器启动: {UPSTASH_HOST}:{UPSTASH_PORT}")
    print(f"订阅频道: {PUSH_CHANNEL}")
    print("菜单栏图标已激活,等待消息...")
    app.run()


if __name__ == "__main__":
    main()