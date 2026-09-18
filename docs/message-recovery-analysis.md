# Message Delivery Recovery Analysis

> Problem: PUB/SUB messages stay in "published" status forever when EvNotifier is offline. After coming back online, those messages are never recovered.

---

## 1. Current State

### Message Lifecycle

```
Server creates message
  │
  ├── INSERT Supabase message_delivery (status=pending)
  │
  ├── PUBLISH to Redis auth:push_channel
  │     │
  │     ├── SUCCESS → UPDATE Supabase (status=published)
  │     │
  │     └── FAIL    → UPDATE Supabase (status=failed)
  │
  └── EvNotifier receives via PUB/SUB subscribe
        │
        ├── ONLINE  → callback API → UPDATE (status=delivered)
        │
        └── OFFLINE → message lost forever
                       (stays in "published" status)
```

### The Problem

| Scenario | What happens | Recoverable? |
|----------|-------------|:------------:|
| EvNotifier online, connected | Real-time delivery | ✅ |
| EvNotifier briefly offline (seconds/minutes) | Messages lost during gap | ❌ |
| EvNotifier offline for days (laptop closed) | All messages stuck in "published" | ❌ Currently |
| EvNotifier starts up fresh after long absence | Misses everything since last session | ❌ Currently |

### Status Distribution (from user's screenshot)

- "Delivered" (green check) - 3 messages successfully received
- "Published" (no check) - 5+ messages sent to Redis but never received

---

## 2. Root Cause

### PUB/SUB is Fire-and-Forget

Redis PUB/SUB has **no message persistence**. When a message is published:
- If subscriber is connected → received immediately
- If subscriber is disconnected → message is **permanently lost**
- Redis does NOT queue messages for disconnected subscribers

### Existing getUndelivered Only Returns pending/failed

```sql
-- Current query (bug)
SELECT * FROM message_delivery
WHERE status IN ('pending', 'failed')    -- misses 'published'
AND created_at > NOW() - INTERVAL '24 hours'
```

Messages that reached Redis but were never received by EvNotifier stay in `published` status. They are excluded from the undelivered query, making recovery impossible.

---

## 3. Solution

### Fix 1: Include `published` in Undelivered Query

```sql
-- Fixed query
SELECT * FROM message_delivery
WHERE status IN ('pending', 'published', 'failed')  -- includes published
AND created_at > NOW() - INTERVAL '168 hours'        -- last 7 days
ORDER BY created_at;
```

### Fix 2: EvNotifier Startup Recovery

After subscribing to Redis channel, EvNotifier calls the undelivered API to catch up:

```
EvNotifier starts
  │
  ├── Subscribe to auth:push_channel (real-time from now)
  │
  ├── GET /api/admin/health?section=delivery-query&action=undelivered&hours=168
  │     │
  │     ├── Returns all published/pending/failed messages from last 7 days
  │     │
  │     └── For each message:
  │           ├── Handle like a real-time message (show notification)
  │           └── Call delivery callback → UPDATE (status=delivered)
```

### Recovery Flow

```
Before Fix:
  EvNotifier offline for 3 days
  Server publishes 50 messages (all → "published")
  EvNotifier comes back
  New SUBSCRIBE → only receives new messages from this point
  Old 50 messages → stuck in "published" forever ← problem

After Fix:
  EvNotifier offline for 3 days
  Server publishes 50 messages (all → "published")
  EvNotifier comes back
  ├── SUBSCRIBE → receives new messages (real-time)
  └── GET undelivered?hours=168
        └── Returns 50 messages → re-processed
              └── Shows notifications + callback → "delivered"
```

---

## 4. Implementation

### 4.1 Server: Fix getUndelivered

**File**: `lib/message-delivery.js`

```javascript
// Before
var sql = "SELECT * FROM " + TABLE + " WHERE status IN ('pending', 'failed') ...";

// After
var sql = "SELECT * FROM " + TABLE + " WHERE status IN ('pending', 'published', 'failed') ...";
```

### 4.2 Server: Increase Default Hours

```javascript
// Before
var hours = parseInt(req.query.hours || "24", 10);

// After  
var hours = parseInt(req.query.hours || "168", 10);  // 7 days
```

### 4.3 EvNotifier: Add Startup Recovery

In `redis_loop()`, after successful subscribe:

```python
def _startup_recovery():
    """Fetch undelivered messages from last 7 days and re-process them."""
    try:
        url = f"{CALLBACK_BASE_URL}/api/admin/health?section=delivery-query&action=undelivered&hours=168"
        fd, tmp = tempfile.mkstemp(suffix=".json", prefix="ev_recovery_")
        os.close(fd)
        subprocess.run(["curl", "-s", "--connect-timeout", "5", "--max-time", "10", url, "-o", tmp], timeout=15)
        resp = open(tmp).read().strip()
        os.unlink(tmp)
        if not resp:
            return
        data = json.loads(resp)
        if not data.get("success"):
            return
        messages = data.get("messages", [])
        for msg in messages:
            payload = msg.get("payload", {})
            if isinstance(payload, str):
                try: payload = json.loads(payload)
                except: payload = {}
            recovered_msg = {
                "ts": int(datetime.fromisoformat(msg["created_at"]).timestamp()),
                "type": msg["message_type"],
                "payload": payload,
                "messageId": msg["message_id"]
            }
            handle_message(recovered_msg)
    except Exception as e:
        _debug_log(f"Startup recovery failed: {e}")
```

Called after `_status = "connected"` in `redis_loop()`:

```python
_status = "connected"
threading.Thread(target=_startup_recovery, daemon=True).start()  # <-- add this
```

---

## 5. Timeline

| Phase | Task | Risk |
|-------|------|:----:|
| 1 | Fix `getUndelivered` to include `published` | Low - 1 line change |
| 2 | Increase default hours to 168 | Low - 1 line change |
| 3 | EvNotifier startup recovery | Low - isolated function |
| 4 | Deploy & restart EvNotifier | Low - restart required |

---

## Summary

**Current state**: Messages published while EvNotifier is offline are permanently lost, stuck in "published" status.

**Fix**: Two changes:
1. Server: `getUndelivered` includes `published` status + 7 day window
2. EvNotifier: On startup, call undelivered API and re-process missed messages

This makes message delivery fully resilient - regardless of how long EvNotifier has been offline.