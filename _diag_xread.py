import ssl, socket, time

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


ctx = ssl.create_default_context()
s = ctx.wrap_socket(socket.create_connection((HOST, PORT), timeout=10), server_hostname=HOST)
s.settimeout(10)

def send(*a):
    parts = []
    for x in a:
        v = str(x)
        parts.append(f"${len(v)}\r\n{v}\r\n".encode())
    header = f"*{len(a)}\r\n".encode()
    data = header + b"".join(parts)
    print(f"SEND: {a[0]} ({len(a)} args, {len(data)} bytes)")
    s.sendall(data)

def recv(label="", timeout=10):
    s.settimeout(timeout)
    buf = b""
    while True:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            print(f"{label} TIMEOUT after {len(buf)} bytes received")
            return buf, []
        if not chunk:
            print(f"{label} connection closed")
            return buf, []
        buf += chunk
        proto = RedisProtocol()
        proto.feed(buf)
        r = proto.parse_all()
        if r:
            print(f"{label} OK: {len(buf)} bytes -> {r}")
            return buf, r

print("=== 1. AUTH ===")
send('AUTH', TOKEN)
recv("AUTH")

print("\n=== 2. XREADGROUP (0-0) ===")
send('XREADGROUP', 'GROUP', GROUP, 'diag', 'COUNT', '5', 'STREAMS', STREAM, '0-0')
buf, results = recv("XREADGROUP")

if not results:
    print("NO RESULTS from XREADGROUP! Raw buf:")
    print(repr(buf))
    print("Trying again with fresh connection...")
    s.close()
    s = ctx.wrap_socket(socket.create_connection((HOST, PORT), timeout=10), server_hostname=HOST)
    s.settimeout(10)
    send('AUTH', TOKEN)
    recv("AUTH2")
    
    print("\n=== 3. Simple PING test ===")
    send('PING')
    recv("PING")
    
    print("\n=== 4. Simple XREAD (no group) ===")
    send('XREAD', 'COUNT', '2', 'STREAMS', STREAM, '0-0')
    recv("XREAD")

s.close()
print("\nDONE")