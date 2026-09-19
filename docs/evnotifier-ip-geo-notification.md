# EvNotifier Visitor IP Geo Info & Chinese Notification Messages

## Overview

Two tasks:
1. Add visitor IP geo-location (city/region like Zibo, Shandong) to evnotifier notifications
2. Change purchase click redirect notification messages to Chinese, add Chinese prompts

---

## Data Flow

```
Browser           Vercel Serverless              Upstash Redis           Mac ev_notifier.py
+--------+  POST  +-----------------+  XADD/PUB  +--------------+  SUB  +--------------+
| visitor| -----> | health.js       | ---------> |              | ----> |              |
|        |        | pushToStream()  |            | auth:push    |       | handle_msg() |
+--------+        +-----------------+            | _channel     |       | -> macOS     |
                                                 |              |       | notification |
+--------+  GET   +-----------------+            | auth:notifi  |       +--------------+
| click  | -----> | go.js           | ---------> | cations:stream|
| buy    |  302   | pushPurchaseClick()          |              |
+--------+        +-----------------+            +--------------+
```

Key facts:
- Vercel provides **free** IP geo headers on every request:
  - `x-vercel-ip-country` -> country code (e.g. `CN`)
  - `x-vercel-ip-country-region` -> province/state (e.g. `Shandong`)
  - `x-vercel-ip-city` -> city in English (e.g. `Zibo`)
- `api/go.js` `pushPurchaseClick()` **already** includes `country`/`region`/`city` in payload
- `api/admin/health.js` `section=visit` handler does **NOT** collect these headers
- `ev_notifier.py` `handle_message()` does **NOT** display these fields

---

## Part 1: Add Visitor IP Geo Info to page_visit

### Change 1: health.js - Add Vercel Geo Headers

File: `api/admin/health.js` (section=visit handler, ~L613-L638)

Current:
```javascript
var visitMsg = {
  page: visitPayload.page || "",
  referrer: visitPayload.referrer || "",
  title: visitPayload.title || "",
  user_agent: visitUa.substring(0, 200),
  ip: visitIp,
};
```

Add 3 fields:
```javascript
var visitMsg = {
  page: visitPayload.page || "",
  referrer: visitPayload.referrer || "",
  title: visitPayload.title || "",
  user_agent: visitUa.substring(0, 200),
  ip: visitIp,
  country: String(visitHeaders["x-vercel-ip-country"] || "").slice(0, 8),
  region: String(visitHeaders["x-vercel-ip-country-region"] || "").slice(0, 16),
  city: String(visitHeaders["x-vercel-ip-city"] || "").slice(0, 40),
};
```

### Change 2: ev_notifier.py - page_visit Notification with Geo + Chinese

File: `tools/ev-notifier/ev_notifier.py` (handle_message, ~L729-L744)

Current:
```python
elif mtype == "page_visit":
    page = p.get("page", "") or p.get("title", "")
    ip = p.get("ip", "")
    referrer = p.get("referrer", "")
    title = "Page Visit"
    subtitle = page
    lines = []
    if ip:
        lines.append(f"IP: {ip}")
    if referrer:
        lines.append(f"Referrer: {referrer[:80]}")
    lines.append(ts_label)
    body = "\n".join(lines)
```

Replace with:
```python
elif mtype == "page_visit":
    page = p.get("page", "") or p.get("title", "")
    ip = p.get("ip", "")
    referrer = p.get("referrer", "")
    country = p.get("country", "")
    region = p.get("region", "")
    city = p.get("city", "")
    title = "New Page Visit"
    subtitle = page
    lines = []
    geo_parts = []
    if country: geo_parts.append(country)
    if region: geo_parts.append(region)
    if city: geo_parts.append(city)
    geo_str = ", ".join(geo_parts) if geo_parts else ""
    if ip:
        ip_line = f"IP: {ip}"
        if geo_str:
            ip_line += f" ({geo_str})"
        lines.append(ip_line)
    elif geo_str:
        lines.append(f"Location: {geo_str}")
    if referrer:
        lines.append(f"Referrer: {referrer[:80]}")
    lines.append(ts_label)
    body = "\n".join(lines)
```

### Change 3: ev_notifier.py - _format_message_detail for Visit List

File: `tools/ev-notifier/ev_notifier.py` (~L909-L914)

Current:
```python
elif mtype == "page_visit":
    page = p.get("page", "") or p.get("title", "") or ""
    ip = p.get("ip", "")
    detail = page
    if ip:
        detail += f" | IP: {ip}"
    type_label = "Visit"
```

Replace with:
```python
elif mtype == "page_visit":
    page = p.get("page", "") or p.get("title", "") or ""
    ip = p.get("ip", "")
    city = p.get("city", "")
    detail = page
    if city:
        detail += f" | {city}"
    elif ip:
        detail += f" | {ip}"
    type_label = "Visit"
```

---

## Part 2: Purchase Click - Show Geo + More Info

### go.js Already Sends Geo (No Change Needed)

File: `api/go.js` (pushPurchaseClick, ~L100-L148) already includes `country`, `region`, `city`. No change.

### Change 4: ev_notifier.py - purchase_click with Geo + Referrer + Channel

File: `tools/ev-notifier/ev_notifier.py` (~L764-L780)

Current:
```python
elif mtype == "purchase_click":
    slug = p.get("slug", "")
    name_zh = p.get("name_zh", "") or p.get("name_en", "") or slug
    ip = p.get("ip", "")
    country = p.get("country", "")
    utm = p.get("utm_source", "") or ""
    title = "Purchase Click"
    subtitle = name_zh
    lines = [f"Slug: /go/{slug}"]
    if ip:
        lines.append(f"IP: {ip}")
    if country:
        lines.append(f"Country: {country}")
    if utm:
        lines.append(f"UTM: {utm}")
    lines.append(ts_label)
    body = "\n".join(lines)
```

Replace with:
```python
elif mtype == "purchase_click":
    slug = p.get("slug", "")
    name_zh = p.get("name_zh", "") or p.get("name_en", "") or slug
    ip = p.get("ip", "")
    country = p.get("country", "")
    region = p.get("region", "")
    city = p.get("city", "")
    utm = p.get("utm_source", "") or ""
    ref = p.get("referrer", "") or ""
    title = "Purchase Click"
    subtitle = name_zh
    lines = [f"Link: /go/{slug}"]
    geo_parts = []
    if country: geo_parts.append(country)
    if region: geo_parts.append(region)
    if city: geo_parts.append(city)
    geo_str = ", ".join(geo_parts) if geo_parts else ""
    if ip:
        ip_line = f"IP: {ip}"
        if geo_str:
            ip_line += f" ({geo_str})"
        lines.append(ip_line)
    elif geo_str:
        lines.append(f"Location: {geo_str}")
    if ref:
        lines.append(f"Source: {ref[:80]}")
    if utm:
        lines.append(f"Channel: {utm}")
    lines.append(ts_label)
    body = "\n".join(lines)
```

---

## Before / After

### Page Visit

Before:
```
Page Visit - /activate.html
  IP: 1.2.3.4
  Referrer: https://xxx.com
```

After:
```
New Page Visit - /activate.html
  IP: 1.2.3.4 (CN, Shandong, Zibo)
  Referrer: https://xxx.com
```

### Purchase Click

Before:
```
Purchase Click - Product Name
  Slug: /go/ev-timetable
  IP: 1.2.3.4
  Country: CN
```

After:
```
Purchase Click - Product Name
  Link: /go/ev-timetable
  IP: 1.2.3.4 (CN, Shandong, Zibo)
  Source: https://xxx.com
  Channel: qrcode
```

---

## Vercel Geo Headers (Free, Zero Latency)

| Header | Meaning | Example |
|--------|---------|---------|
| `x-vercel-ip-country` | Country code | `CN`, `US` |
| `x-vercel-ip-country-region` | Province/State | `Shandong`, `California` |
| `x-vercel-ip-city` | City (English) | `Zibo`, `Beijing` |

Note: city names are in English. For Chinese names like "Zibo" -> "淄博", see section below.

---

## Implementation Steps

| Step | File | What | Deploy |
|------|------|------|--------|
| 1 | `api/admin/health.js` | Add `country`/`region`/`city` to visitMsg | Vercel deploy |
| 2 | `ev_notifier.py` - page_visit | Show IP + geo, add referrer | Restart script |
| 3 | `ev_notifier.py` - purchase_click | Show IP + geo + referrer + channel | Restart script |
| 4 | `ev_notifier.py` - detail | Show city in visit list | Restart script |

---

## Chinese City Name Mapping (Optional Enhancement)

Vercel `x-vercel-ip-city` returns English names (e.g. `Zibo`). For Chinese names:

### Option A: Async IP API (recommended, global coverage)

Use existing `lib/ip-lookup.js` with `ip-api.com` `lang=zh-CN`:
```
http://ip-api.com/json/{ip}?fields=city,regionName&lang=zh-CN
-> { "city": "淄博", "regionName": "山东" }
```
Fire-and-forget in `health.js`, write result to Redis.

### Option B: Local Mapping Table in ev_notifier.py (zero network, quick)

```python
CITY_MAP = {
    "Zibo": "Zibo City", "Beijing": "Beijing", "Shanghai": "Shanghai",
    "Guangzhou": "Guangzhou", "Shenzhen": "Shenzhen", "Hangzhou": "Hangzhou",
    "Chengdu": "Chengdu", "Wuhan": "Wuhan", "Nanjing": "Nanjing",
}

REGION_MAP = {
    "Shandong": "Shandong Province", "Beijing": "Beijing",
    "Shanghai": "Shanghai", "Guangdong": "Guangdong Province",
    "Zhejiang": "Zhejiang Province", "Sichuan": "Sichuan Province",
    "Hubei": "Hubei Province", "Jiangsu": "Jiangsu Province",
}

def _resolve_city(city_en, region_en):
    if city_en and city_en in CITY_MAP:
        return CITY_MAP[city_en]
    if region_en and region_en in REGION_MAP:
        result = REGION_MAP[region_en]
        if city_en:
            result += " " + city_en
        return result
    return city_en or region_en or ""
```

Recommend: Start with Option B (zero network cost), expand mapping as needed.