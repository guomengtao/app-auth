# Activation Code Management System - Implementation Plan

## Overview

A lightweight license activation system built on **Vercel Serverless Functions** + **Upstash Redis**, with a web-based admin panel and end-user activation page.

| Layer | Technology |
|-------|-----------|
| Frontend | Static HTML/CSS/JS (hosted on Vercel) |
| Backend | Vercel Serverless Functions (`/api/*`) |
| Storage | Upstash Redis (Hash, String, Set) |
| Auth | Admin session via JWT cookie |
| Deploy | Vercel + GitHub auto-deploy |

---

## 1. Project Structure

```
app-auth/
├── public/
│   ├── index.html              # Home page (redirect to /activate or /admin)
│   ├── activate.html           # End-user activation page
│   ├── admin.html              # Admin dashboard
│   ├── login.html              # Admin login page
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── activate.js
│       ├── admin.js
│       └── login.js
├── api/
│   ├── activate.js             # POST /api/activate
│   ├── admin/
│   │   ├── login.js            # POST /api/admin/login
│   │   ├── products.js         # GET/POST /api/admin/products
│   │   ├── redeem-codes.js     # GET/POST /api/admin/redeem-codes
│   │   ├── records.js          # GET /api/admin/records
│   │   └── stats.js            # GET /api/admin/stats
│   ├── publish.js              # (keep existing message board)
│   └── messages.js             # (keep existing message board)
├── lib/
│   ├── redis.js                # Shared Redis client instance
│   ├── crypto.js               # SHA256, activation code generation
│   ├── auth.js                 # JWT sign/verify helpers
│   └── validate.js             # Input validation utils
├── vercel.json
├── package.json
├── .gitignore
└── PLAN.md
```

---

## 2. Redis Data Model

All keys prefixed with `auth:` for easy cleanup.

### 2.1 Products

| Key | Type | Description |
|-----|------|-------------|
| `auth:products` | Hash | `product_id → JSON` (name, description, created_at) |
| `auth:product_ids` | Set | All product_id values for iteration |

```json
{
  "id": "prod-abc123",
  "name": "VIP Pro",
  "description": "VIP Professional Edition",
  "created_at": 1693209600000
}
```

### 2.2 Redeem Codes

| Key | Type | Description |
|-----|------|-------------|
| `auth:redeem:{code}` | String | JSON of redeem code details |
| `auth:redeem_codes` | Set | All redeem code strings for listing |

```json
{
  "code": "ABCD-EFGH-IJKL",
  "product_id": "prod-abc123",
  "duration_days": 365,
  "used": false,
  "used_device_id": null,
  "generated_activation_code": null,
  "created_at": 1693209600000,
  "used_at": null,
  "expire_at": null
}
```

### 2.3 Activation Records

| Key | Type | Description |
|-----|------|-------------|
| `auth:activation:{activation_code}` | String | JSON of activation record |
| `auth:activation_codes` | Set | All activation codes for listing |

```json
{
  "activation_code": "ACT-...",
  "device_id_hash": "sha256...",
  "product_id": "prod-abc123",
  "duration_days": 365,
  "generated_at": 1693209600000,
  "expires_at": 1724745600000
}
```

### 2.4 Device Index

| Key | Type | Description |
|-----|------|-------------|
| `auth:device:{device_hash}` | String | Latest activation code for this device |

### 2.5 Admin Account

| Key | Type | Description |
|-----|------|-------------|
| `auth:admin` | Hash | `username` and `password_hash` (bcrypt) |

---

## 3. API Endpoints

### 3.1 Core Activation

#### `POST /api/activate`

User activates a product by submitting a redeem code.

```
Request:
{
  "deviceId": "unique-device-identifier",
  "redeemCode": "ABCD-EFGH-IJKL"
}

Response (success):
{
  "success": true,
  "activationCode": "ACT-generated-code"
}

Response (error):
{
  "success": false,
  "error": "invalid code / already used / expired"
}
```

**Flow:**
1. Validate input (redeem code format, device ID not empty)
2. Look up `auth:redeem:{redeemCode}`
3. If not found → `400: invalid redeem code`
4. If already used:
   - Same device → return existing `generated_activation_code`
   - Different device → `400: code already used`
5. If not used:
   - Generate activation code via `generateActivationCode(product_id, deviceId, duration_days)`
   - Update redeem code record (mark used)
   - Create activation record
   - Update device index
   - Return activation code

### 3.2 Admin Authentication

#### `POST /api/admin/login`

```
Request:
{
  "username": "admin",
  "password": "***"
}

Response:
{
  "success": true,
  "token": "jwt..."
}
```

- Verify credentials against `auth:admin` hash
- Issue JWT with 24h expiry, set as httpOnly cookie

### 3.3 Admin - Products

#### `GET /api/admin/products`
List all products from `auth:products` hash.

#### `POST /api/admin/products`
Create a new product entry.

```
Request:
{
  "name": "VIP Pro",
  "description": "VIP Professional Edition"
}
```

### 3.4 Admin - Redeem Codes

#### `GET /api/admin/redeem-codes`
List redeem codes with pagination. Filter by `?used=true/false` and `?product_id=xxx`.

#### `POST /api/admin/redeem-codes`
Generate one or more redeem codes.

```
Request:
{
  "product_id": "prod-abc123",
  "duration_days": 365,
  "count": 10
}
```

- Generate `count` random codes (format: `XXXX-XXXX-XXXX`)
- Store each in `auth:redeem:{code}` and add to `auth:redeem_codes` set
- Use Redis `MULTI`/pipeline for batch writes

### 3.5 Admin - Activation Records

#### `GET /api/admin/records`
List activation records with pagination. Filter by `?product_id=xxx`.

### 3.6 Admin - Statistics

#### `GET /api/admin/stats`

```
Response:
{
  "totalProducts": 3,
  "totalRedeemCodes": 150,
  "usedRedeemCodes": 42,
  "unusedRedeemCodes": 108,
  "totalActivations": 42
}
```

---

## 4. Security

| Concern | Solution |
|---------|----------|
| Secrets in code | `.env` file gitignored; Vercel env vars for production |
| Admin auth | JWT stored in httpOnly cookie, verified on every admin API call |
| Password storage | bcrypt hash in `auth:admin` |
| Input validation | Whitelist-based validation on all inputs |
| Brute force | Rate limiting on `/api/activate` and `/api/admin/login` |
| Activation code security | Generated via HMAC with server secret, not guessable |

---

## 5. Activation Code Generation

```js
// lib/crypto.js
function generateActivationCode(productId, deviceId, durationDays) {
  const payload = `${productId}:${deviceId}:${durationDays}:${Date.now()}`;
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `ACT-${signature.slice(0, 32).toUpperCase()}`;
}
```

---

## 6. Frontend Pages

### activate.html
- Clean single-page form: device ID display + redeem code input
- Auto-detect/generate device fingerprint (browser fingerprint or user-provided)
- Show activation result and copy activation code

### admin.html
- Dashboard with stats cards (total products, codes, activations)
- Tab panels: Products, Redeem Codes, Activation Records
- Generate codes modal (product select, duration, count)
- Table views with pagination

### login.html
- Simple login form → redirect to admin.html

---

## 7. Deployment

```bash
# 1. Set Vercel environment variables
vercel env add KV_REST_API_URL
vercel env add KV_REST_API_TOKEN
vercel env add JWT_SECRET

# 2. Deploy
git add . && git commit -m "Add activation system" && git push
# Vercel auto-deploys on push to main
```

---

## 8. Development Phases

| Phase | Scope | Files |
|-------|-------|-------|
| **Phase 1** | Redis client + crypto lib + input validation | `lib/redis.js`, `lib/crypto.js`, `lib/validate.js` |
| **Phase 2** | Core activation API | `api/activate.js` |
| **Phase 3** | Admin auth + login | `api/admin/login.js`, `lib/auth.js` |
| **Phase 4** | Admin CRUD APIs | `api/admin/products.js`, `redeem-codes.js`, `records.js`, `stats.js` |
| **Phase 5** | Frontend pages | `public/activate.html`, `admin.html`, `login.html` |
| **Phase 6** | Polish & deploy | CSS, error handling, rate limiting |

---

## 9. Notes

- The existing message board (`index.html`, `api/publish.js`, `api/messages.js`) is kept as-is for testing/demo purposes.
- Domain: `app-auth.gudq.com` (already configured with Vercel + Cloudflare).
- All Redis keys use `auth:` prefix — easy to flush or migrate.
- `duration_days: 9999` means permanent/lifetime license.