#!/usr/bin/env python3
"""EvNotifier diagnosis and test script - writes results to _ev_result.txt"""
import subprocess, os, sys, time, ssl, socket, json

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ev_result.txt")

def log(msg):
    with open(OUT, "a") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    print(msg, flush=True)

# Clear output
with open(OUT, "w") as f:
    f.write("=== EvNotifier Diagnosis ===\n")
log("Starting diagnosis...")

HOST = "on-cat-235786.upstash.io"
PORT = 6379
TOKEN = "gQAAAAAAA5kKAAIgcDIwNTEzNDZiNTQxMmU0ODgyOTZmMzZkNmNjYmUwNzRhYQ"
STREAM = "auth:notifications:stream"
GROUP = "ev-notifiers"

# Step 1: Kill existing processes
try:
    subprocess.run(["pkill", "-f", "ev_notifier.py"], capture_output=True, timeout=5)
    log("Killed old EvNotifier processes")
except:
    pass

time.sleep(2)

# Step 2: Sync latest code
src = "/Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py"
dst = "/Users/Banner/Desktop/EvNotifier.app/ev_notifier.py"
try:
    with open(src, "r") as f:
        content = f.read()
    with open(dst, "w") as f:
        f.write(content)
    log("Synced code to desktop")
except Exception as e:
    log(f"Sync failed: {e}")

# Step 3: Clear debug log
debug_log = "/Users/Banner/ev_notifier_debug.log"
try:
    os.remove(debug_log)
except:
    pass

# Step 4: Start EvNotifier via open
try:
    subprocess.run(["open", "/Users/Banner/Desktop/EvNotifier.app"], timeout=5)
    log("Started EvNotifier.app via open")
except Exception as e:
    log(f"Failed to start: {e}")

# Step 5: Wait for connection and send test message
time.sleep(8)

# Step 5a: Check process
try:
    r = subprocess.run(["pgrep", "-f", "ev_notifier.py"], capture_output=True, text=True, timeout=5)
    log(f"EvNotifier PID: {r.stdout.strip() or 'NONE'}")
except:
    log("pgrep failed")

# Step 5b: Check debug log
if os.path.exists(debug_log):
    with open(debug_log, "r") as f:
        log(f"DEBUG LOG:\n{f.read()}")
else:
    log("DEBUG LOG: NOT FOUND (EvNotifier may not have connected)")

# Step 6: Connect to Upstash and send test message + check state
try:
    ctx = ssl.create_default_context()
    sock = socket.create_connection((HOST, PORT), timeout=10)
    ssock = ctx.wrap_socket(sock, server_hostname=HOST)
    
    def cmd(*a):
        r = '*' + str(len(a)) + '\r\n'
        for x in a:
            s = str(x)
            r += '$' + str(len(s)) + '\r\n' + s + '\r\n'
        ssock.sendall(r.encode())
    
    def R(w=0.5):
        time.sleep(w)
        buf = b''
        try:
            ssock.settimeout(3)
            while True:
                c = ssock.recv(4096)
                if not c: break
                buf += c
        except:
            pass
        ssock.settimeout(None)
        return buf.decode(errors='replace')
    
    cmd("AUTH", TOKEN)
    R()
    
    # Check group
    cmd("XINFO", "GROUPS", STREAM)
    log(f"GROUP INFO: {R().strip()[:500]}")
    
    # ACK any pending
    cmd("XAUTOCLAIM", STREAM, GROUP, "mac-cleanup", "0", "0-0", "COUNT", "20")
    raw = R()
    log(f"XAUTOCLAIM: {raw.strip()[:200]}")
    
    cmd("XPENDING", STREAM, GROUP)
    log(f"PENDING: {R().strip()[:200]}")
    
    # Send test message
    msg = json.dumps({"ts": int(time.time()), "type": "new_activation", "payload": {
        "product_name": "FinalDiagTest",
        "months": 1,
        "source": "admin-direct",
        "activation_code": "DIAG-001",
        "redeem_code": "DIAG-REDEEM",
        "device_id": "device-diag"
    }})
    cmd("XADD", STREAM, "*", "data", msg)
    msg_id = R().strip()
    log(f"SENT TEST MSG: {msg_id}")
    
    # Wait for EvNotifier to process
    time.sleep(10)
    
    # Check pending and group
    cmd("XPENDING", STREAM, GROUP)
    log(f"PENDING AFTER 10s: {R().strip()[:200]}")
    
    cmd("XINFO", "GROUPS", STREAM)
    log(f"GROUP AFTER 10s: {R().strip()[:500]}")
    
    # Check debug log again
    if os.path.exists(debug_log):
        with open(debug_log, "r") as f:
            log(f"DEBUG LOG (updated):\n{f.read()}")
    else:
        log("DEBUG LOG: STILL NOT FOUND")
    
    ssock.close()
except Exception as e:
    log(f"Upstash error: {e}")

log("=== DIAGNOSIS COMPLETE ===")