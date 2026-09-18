# Channel Tracking Analysis — QR Code Source Attribution

> Review of: [渠道识别与升级转化统计方案 — 参数对接分析](docs/渠道识别与升级转化统计方案.md)
> Focus: server-side capture, storage, reporting, and whether the proposal is reasonable

---

## 1. Proposal Summary

| Aspect | Proposal |
|--------|----------|
| What | Add `c` (channel) parameter to QR 2 URL |
| Format | `c={platform}-{device}[-{type}]` (e.g. `t-9p-d`) |
| Injection | Build-time `sed` replacement in `version.js` |
| Server | Backward compatible — no `c` = normal activation |

---

## 2. Data Flow — Full Lifecycle

```
Watch generates QR code
  │
  ├── QR URL includes &c=t-9p-d
  │
  └── User scans QR with phone browser
        │
        ├── activate.html loads
        │     │
        │     ├── parseQueryParams() → reads `c` from URL
        │     │
        │     ├── populateDevicePanel() (existing) ← shows device info
        │     │
        │     └── [MISSING] Currently no UI shows the channel to the user
        │            → Proposal does not mention showing it, which is fine
        │              (channel is internal analytics, no user-facing value)
        │
        ├── User enters redeem code, clicks activate
        │     │
        │     ├── POST /api/activate { deviceId, redeemCode, deviceInfo }
        │     │                          ▲
        │     │                          └── [MISSING] Does NOT include `c`
        │     │                              Channel info would be lost here
        │     │
        │     └── activate.js processes activation
        │           │
        │           ├── Saves record (Redis)
        │           │     ├── device_info: { model, product, osVersion, ... }
        │           │     ├── visitor_info: { ip, ua, browser, ... }
        │           │     └── [MISSING] No channel field
        │           │
        │           └── pushNotification() → PUB/SUB → EvNotifier
        │                 └── [MISSING] channel not included in push payload
        │
        └── Result: channel attribution data flows nowhere
```

**Critical gap**: The proposal sends `c` through QR → browser, but never passes it to the server API. `activate.html` reads `c` from URL params but the POST body does not include it (no `channel` or `c` field in the JSON).

---

## 3. Server-Side Storage — What Should Change

### 3.1 activate.html — Relay `c` to Server

```javascript
// activate.html — GET device info from URL (existing)
function getDeviceInfoFromUrl() {
  var params = parseQueryParams(window.location.search);
  return {
    model: params['m'] || '',
    product: params['p'] || '',
    // ... existing fields ...
    romVersion: params['r'] || '',
    source: params['c'] || '',  // ← NEW: capture channel
  };
}
```

```javascript
// activate.html — POST body (existing, modify)
JSON.stringify({
  deviceId: deviceId,
  redeemCode: code,
  deviceInfo: hasDeviceInfo ? deviceInfo : null,
  // ← channel is already inside deviceInfo.source
})
```

### 3.2 activate.js — Store channel in Activation Record

```javascript
// activate.js — activation record (existing, extend)
var record = {
  activation_code: activationCode,
  device_id_hash: deviceHash,
  device_id: device,
  device_id_full: rawDeviceId,
  product_id: productId,
  duration_months: months,
  redeem_code: code,
  generated_at: now,
  expires_at: expiresAt,
  device_info: deviceInfo || null,
  visitor_info: visitorInfo,
  channel: deviceInfo && deviceInfo.source ? deviceInfo.source : null,  // ← NEW
};
```

### 3.3 activate.js — Push channel to Notification Pipeline

```javascript
// activate.js — pushNotification call (existing, extend)
await notify.pushNotification("new_activation", {
  redeem_code: code,
  activation_code: activationCodeReuse,
  product_id: productId,
  device_id: device,
  months: months,
  source: "user-reuse",
  ip: visitorInfo ? visitorInfo.ip : "",
  channel: deviceInfo && deviceInfo.source ? deviceInfo.source : null,  // ← NEW
}).catch(function () {});
```

### 3.4 EvNotifier — Display channel in Notification

```python
# ev_notifier.py — handle_message (existing, extend)
channel = msg.get('payload', {}).get('channel', '')
if channel:
    subtitle += f' [{channel}]'  # Shows "[t-9p-d]" in the notification
```

---

## 4. Should Channel Go Into message_delivery Supabase Tables?

**Yes.** The channel is valuable analytics data. When a conversion happens (activation success/failure), storing the channel alongside the delivery record enables:

- **Conversion rate by channel**: `SELECT channel, COUNT(*) ... WHERE status='delivered' GROUP BY channel`
- **Channel funnel analysis**: How many scans → activations per channel
- **Failure rate by channel**: Some channels might have more errors (e.g., poor QR readability)

**Current message_delivery schema**:

```sql
CREATE TABLE message_delivery (
  id SERIAL PRIMARY KEY,
  message_id TEXT UNIQUE,
  message_type TEXT,
  status TEXT DEFAULT 'pending',
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Payload already captures everything** — `channel` goes into the `payload JSONB` field naturally:

```json
{
  "type": "new_activation",
  "status": "delivered",
  "payload": {
    "redeem_code": "A1B2",
    "product_id": "01",
    "channel": "t-9p-d",
    "ip": "1.2.3.4",
    "device_id": "..."
  }
}
```

**No schema change needed.** Just include `channel` in the payload when calling `createMessageDelivery()` or `pushNotification()`.

---

## 5. Cross-Reference: Existing Version Tracking

The current system already tracks `r` (version) the same way the proposal wants to track `c`:

| Parameter | Tracks | Stored in | Used for |
|-----------|--------|-----------|----------|
| `r` | Client version | `device_info.romVersion` in activation record | Upgrade adoption rate |
| `c` | Channel source | `device_info.source` (proposed) | Channel conversion rate |

**The pattern is identical** — both flow: QR URL → `activate.html` params → `deviceInfo` → activation record.

The proposal is structurally correct — it mirrors the existing version tracking mechanism exactly. No new infrastructure needed.

---

## 6. Data Retention & Query for Channel Stats

The activation record is stored in Redis (`auth:activation:{code}`) with the full JSON blob. Channel data lives inside each record. To query aggregate stats:

### 6.1 Redis Scan (Current)

```javascript
// Query: count activations by channel (scan all activation records)
var cursor = 0;
var channelCounts = {};
do {
  var [nextCursor, keys] = await redis.scan(cursor, { match: "auth:activation:*", count: 1000 });
  cursor = nextCursor;
  for (var k of keys) {
    var raw = await redis.get(k);
    var rec = JSON.parse(raw);
    var ch = rec.channel || '__unknown__';
    channelCounts[ch] = (channelCounts[ch] || 0) + 1;
  }
} while (cursor !== 0);
```

**Problem**: Expensive `O(N)` scan on every query — 10k+ records will be slow.

### 6.2 Supabase Query (Recommended for production)

If channel data is also pushed to message_delivery:

```sql
-- By channel, grouped
SELECT 
  payload->>'channel' AS channel,
  COUNT(*) AS total,
  SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
FROM message_delivery
WHERE message_type IN ('new_activation', 'activation_failure')
  AND payload->>'channel' IS NOT NULL
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY payload->>'channel'
ORDER BY total DESC;
```

**Result**:

| channel | total | delivered | failed |
|---------|-------|-----------|--------|
| t-9p-d | 156 | 150 | 6 |
| t-10-r | 89 | 85 | 4 |
| q | 45 | 44 | 1 |
| t-s4 | 22 | 21 | 1 |
| g | 12 | 12 | 0 |

---

## 7. Tension: Proposal vs Current Architecture

### 7.1 What the Proposal Does Well

| Item | Verdict |
|------|---------|
| Parameter name `c` | ✅ No conflict with existing 12 params |
| Build-time injection | ✅ Clean separation, no runtime detection |
| Backward compatibility | ✅ Old clients without `c` work normally |
| QR 1 untouched | ✅ No scope creep |
| Mirrors existing `r` pattern | ✅ Same mechanism, proven to work |

### 7.2 What the Proposal Misses

| Gap | Impact | Severity |
|-----|--------|:--------:|
| **`c` never sent to server API** | Channel data lost — reaches browser but stops there | **Critical** |
| **No server-side storage defined** | Cannot query or report after activation | **High** |
| **No notification pipeline integration** | EvNotifier cannot show channel in alerts | **Medium** |
| **No admin panel reporting** | Cannot view conversion data without raw DB query | **Medium** |
| **URL length concern** | 216 chars exceeds 200 limit, needs trimming | **Low** |
| **No dedup mechanism** | Same user scanning QR multiple times = multiple records with same channel | **Low** |

### 7.3 URL Length — Real Impact

Current full URL: ~216 chars — exceeds the 200-char recommended limit.

**Proposal's fallback** (strip device info, keep `deviceId` + `c` + `r`):
```
?deviceId=xxx&c=t-9p-d&r=1.5.70  → ~95 chars ✅
```

**Verdict**: The fallback is acceptable. Losing device info for channel tracking is a reasonable trade-off. The device info is "nice to have" for troubleshooting, while `deviceId` + `c` are essential for activation and analytics respectively.

However, one nuance: **the fallback triggers unpredictably** — some QR scans will show device info panel, some won't, depending on URL length. The user experience is inconsistent.

**Better approach**: Build the URL with `c` first, then truncate device info params from the end until under 200 chars:

```javascript
function buildActivationUrl(deviceId, deviceInfoParams, versionText, channelParam) {
  var base = ACTIVATION_URL + encodeURIComponent(deviceId);
  // Channel is highest priority — always include
  if (channelParam) base += '&c=' + encodeURIComponent(channelParam);
  // Version is next priority — include if fits
  if (versionText) {
    var withVersion = base + '&r=' + encodeURIComponent(versionText);
    if (withVersion.length <= 200) base = withVersion;
  }
  // Device info params last — include as many as fit
  if (deviceInfoParams) {
    var withDevice = base + '&' + deviceInfoParams;
    if (withDevice.length <= 200) base = withDevice;
  }
  return base;
}
```

Priority order: `deviceId` > `c` > `r` > device info.

---

## 8. Recommendation: Approval with Amendments

### Verdict: Reasonable with 3 fixes

The proposal is structurally sound — it mirrors the existing version tracking and requires minimal changes. But it has a critical hole that must be fixed before deployment.

### Required Fixes

| # | Fix | File | Effort |
|---|-----|------|--------|
| 1 | `getDeviceInfoFromUrl()` capture `c` as `source` | `activate.html` | 1 line |
| 2 | Store `channel` field in activation record | `activate.js` | 1 line |
| 3 | Push `channel` in notification payload | `activate.js` | 1 line |

### Nice-to-Have

| # | Improvement | Effort |
|---|-------------|--------|
| 4 | Show channel in EvNotifier notification subtitle | 3 lines |
| 5 | Priority-ordered URL builder (deviceId > c > r > info) | 15 lines |
| 6 | Admin panel channel filter/dashboard | 2-4 hours |

### Timeline

| Phase | Scope | Time |
|-------|-------|:----:|
| **P0** | Fixes 1-3: server captures and stores channel | 30 min |
| **P1** | Fix 4: EvNotifier display | 15 min |
| **P2** | Fix 5: URL builder with priority ordering | 30 min |
| **P3** | Fix 6: Admin panel channel reporting | 2-4 hours |

---

## 9. Summary

```
                     QR→Browser        Browser→API         Storage        Reporting
                    ┌──────────┐      ┌──────────┐      ┌──────────┐    ┌──────────┐
    Proposal says:  │ &c=t-9p-d│  ──► │    ❌    │  ──► │    ❌    │──► │    ❌    │
                    └──────────┘      └──────────┘      └──────────┘    └──────────┘
                        ✓                  ✗                ✗               ✗
                        Reaches           Not sent          Not stored     Not queried
                        browser           to API

    With fixes:    │ &c=t-9p-d│  ──► │  &c=t-9p-d  │  ──► │ channel:  │──► │ SELECT .. │
                        ✓                  ✓                ✓               ✓
```

**The proposal's QR-to-browser path is correct. The browser-to-server path is missing.** With the 3 required fixes, the data flows end-to-end through the existing infrastructure (deviceInfo → activation record → notification → message_delivery → EvNotifier → admin panel).

Once fixed, the channel tracking produces analytics queries like:

```sql
-- Conversion funnel by channel
SELECT 
  payload->>'channel' AS channel,
  DATE(created_at) AS day,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'delivered') AS delivered
FROM message_delivery
WHERE message_type LIKE 'activation_%'
GROUP BY payload->>'channel', DATE(created_at)
ORDER BY day DESC, total DESC;
```

Enabling data-driven decisions on which channels to prioritize for distribution and marketing.