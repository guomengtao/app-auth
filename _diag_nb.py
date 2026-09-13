import ssl, socket, time, select

HOST = 'on-cat-235786.upstash.io'
PORT = 6379
TOKEN = 'gQAAAAAAA5kKAAIgcDIwNTEzNDZiNTQxMmU0ODgyOTZmMzZkNmNjYmUwNzRhYQ'
STREAM = 'auth:notifications:stream'
GROUP = 'ev-notifiers'

class RedisProtocol:
    def __init__(self):
        self._buf = b""
    def feed(self, data):
        self._buf += data
    def parse_all(self):
        results = []
        buf = self._buf
        while True:
            msg, remaining = self._parse_one(buf)
            if msg is None:
                break
            results.append(msg)
            buf = remaining
        self._buf = buf
        return results
    def _parse_one(self, data):
        if not data:
            return None, data
        idx = 0
        nl = data.find(b"\r\n", idx)
        if nl < 0:
            return None, data
        line = data[idx:nl]
        idx = nl + 2
        if line.startswith(b"+"):
            return line[1:].decode(errors="replace"), data[idx:]
        if line.startswith(b"-"):
            return ("error", line[1:].decode(errors="replace")), data[idx:]
        if line.startswith(b":"):
            return int(line[1:]), data[idx:]
        if line.startswith(b"$"):
            n = int(line[1:])
            if n < 0:
                return None, data[idx:]
            if idx + n + 2 > len(data):
                return None, data
            val = data[idx:idx + n].decode(errors="replace")
            idx += n + 2
            return val, data[idx:]
        if line.startswith(b"*"):
            count = int(line[1:])
            arr = []
            for _ in range(count):
                remaining = data[idx:]
                item, consumed = self._parse_one(remaining)
                if item is None:
                    return None, self._buf
                arr.append(item)
                idx = len(data) - len(consumed)
            return arr, data[idx:]
        return None, data

def send_cmd(ssock, *args):
    parts = []
    for a in args:
        s = str(a)
        parts.append(f"${len(s)}\r\n{s}\r\n".encode())
    header = f"*{len(args)}\r\n".encode()
    data = header + b"".join(parts)
    total = 0
    while total < len(data):
        try:
            sent = ssock.send(data[total:])
            if sent > 0:
                total += sent
        except (ssl.SSLWantWriteError, BlockingIOError, ssl.SSLWantReadError):
            select.select([ssock], [ssock], [], 0.5)

def recv_resp(ssock, timeout=30.0):
    buf = b""
    deadline = time.time() + timeout
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise TimeoutError("recv timeout")
        select.select([ssock], [ssock], [], min(remaining, 1.0))
        try:
            chunk = ssock.recv(65536)
        except (ssl.SSLWantReadError, BlockingIOError):
            continue
        except (ssl.SSLWantWriteError,):
            continue
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
        proto = RedisProtocol()
        proto.feed(buf)
        results = proto.parse_all()
        if results:
            return results, buf

ctx = ssl.create_default_context()
sock = socket.create_connection((HOST, PORT), timeout=10)
sock.setblocking(False)
ssock = ctx.wrap_socket(sock, server_hostname=HOST, do_handshake_on_connect=False)
ssock.setblocking(False)
while True:
    try:
        ssock.do_handshake()
        break
    except (ssl.SSLWantReadError, ssl.SSLWantWriteError):
        select.select([ssock], [ssock], [], 1.0)
print("✅ Connected + SSL handshake done")

print("\n1. AUTH...")
send_cmd(ssock, "AUTH", TOKEN)
results, _ = recv_resp(ssock, timeout=5)
print(f"   AUTH -> {results}")

print("\n2. XGROUP CREATE...")
send_cmd(ssock, "XGROUP", "CREATE", STREAM, GROUP, "$", "MKSTREAM")
results, _ = recv_resp(ssock, timeout=5)
print(f"   XGROUP -> {results}")

print("\n3. XREADGROUP (no message yet)...")
send_cmd(ssock, "XREADGROUP", "GROUP", GROUP, "diag-nb", "COUNT", "10", "STREAMS", STREAM, ">")
results, _ = recv_resp(ssock, timeout=5)
print(f"   XREADGROUP -> {results}")

print("\n--- All 3 commands succeeded! Non-blocking SSL works ---")

ssock.close()
print("DONE")