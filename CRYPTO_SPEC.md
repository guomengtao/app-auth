# Crypto & Auth Algorithm Specification

> This document describes all encryption, hashing, encoding, and authentication algorithms used in the app-auth system.  
> Use this as the single source of truth for integrating external software.

---

## 1. SHA-256 Hashing

**Purpose**: Hash device IDs before storing them in the database.

**Algorithm**: Standard SHA-256, output as **lowercase hex string** (64 hex characters).

```
Input:  deviceId (raw string)
Output: sha256(deviceId) → lowercase hex string
```

**Node.js Reference**:
```js
const crypto = require("crypto");
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
```

**Example**:
```
Input:  "device-abc-123"
Output: "a1b2c3d4e5f6..." (64 lowercase hex chars)
```

---

## 2. Activation Code Algorithm

### 2.1 Format Overview

The activation code is a **16-digit numeric string** composed of 4 parts, with product ID and duration days **scrambled** to prevent tampering:

```
SPPP DDDD SDDD CCCC
│    │    │     │
│    │    │     └── Checksum (4 digits, mod 10000)
│    │    └── Scrambled duration days (4 digits)
│    └── Device ID hash (4 digits)
└── Scrambled product ID (4 digits)
```

- **Without spaces**: 16 consecutive digits, e.g. `7312567800301234`
- **With spaces** (display only): `7312 5678 0030 1234`

**Important**: The product ID and duration days are scrambled using a 4-digit secret key (`7319`). Without the secret, the raw values cannot be read from the activation code. This prevents users from modifying the product ID or duration.

### 2.2 Scrambling Algorithm (scramble4 / unscramble4)

A digit-wise Caesar cipher: each digit of the input is added/subtracted with the corresponding digit of the secret key, modulo 10.

```
ACTIVATION_SECRET = "7319"

function scramble4(digits, secret):
  result = ""
  for i = 0 to 3:
    result += ((parseInt(digits[i]) + parseInt(secret[i])) % 10).toString()
  return result

function unscramble4(digits, secret):
  result = ""
  for i = 0 to 3:
    result += ((parseInt(digits[i]) - parseInt(secret[i]) + 10) % 10).toString()
  return result
```

**Example**:
```
scramble4("0001", "7319") → "7310"
unscramble4("7310", "7319") → "0001"

scramble4("0030", "7319") → "7349"
unscramble4("7349", "7319") → "0030"
```

### 2.3 Step 1: Product ID → 4 Digits

**Always hash** the product ID to a 4-digit number using a rolling hash. There is no shortcut for already-numeric IDs — all product IDs are hashed to prevent plaintext leakage.

```
productIdTo4Digit(pid):
  hash = 0
  for each char c in pid:
    hash = ((hash << 5) - hash) + charCodeAt(c)
    hash = hash & hash  // 32-bit signed integer truncation
  return pad4(abs(hash) % 10000)
```

### 2.4 Step 2: Device ID → 4 Digits

Hash the raw device ID string to a 4-digit number using the same rolling hash algorithm as the checksum.

```
deviceIdTo4Digit(id):
  hash = 0
  for each char c in id:
    hash = ((hash << 5) - hash) + charCodeAt(c)
    hash = hash & hash
  return pad4(abs(hash) % 10000)
```

**Example**:
```
Input:  "device-abc-123"
Output: "1234" (deterministic, based on hash)
```

### 2.5 Step 3: Duration Days → 4 Digits

Left-pad the number of days to 4 digits with zeros.

```
pad4(n):
  s = String(n)
  while s.length < 4: s = "0" + s
  return s
```

### 2.6 Step 4: Scramble Product ID and Duration

Scramble the 4-digit product ID and duration using the secret key.

```
scrambledPid  = scramble4(pid, ACTIVATION_SECRET)
scrambledDays = scramble4(daysPart, ACTIVATION_SECRET)
```

### 2.7 Step 5: Generate Checksum

Compute a 4-digit checksum over the 12-digit scrambled text (scrambledPid + idHash + scrambledDays).

```
plain = scrambledPid + idHash + scrambledDays   // 12 digits
checksum = generateChecksum4(plain)              // 4 digits
```

### 2.8 Final Assembly

```
activationCode = scrambledPid + idHash + scrambledDays + checksum  // 16 digits
```

### 2.9 Complete Pseudocode

```
function generateActivationCode(productId, deviceId, days):
  pid          = productIdTo4Digit(productId)
  idHash       = deviceIdTo4Digit(deviceId)
  daysPart     = pad4(days)
  scrambledPid = scramble4(pid, ACTIVATION_SECRET)
  scrambledDays = scramble4(daysPart, ACTIVATION_SECRET)
  plain        = scrambledPid + idHash + scrambledDays
  checksum     = generateChecksum4(plain)
  return plain + checksum
```

### 2.10 Example Walkthrough

```
Input:
  productId = "my-product"
  deviceId  = "device-abc-123"
  days      = 30

Step 1: productIdTo4Digit("my-product") → hash → "5678"
Step 2: deviceIdTo4Digit("device-abc-123") → "0123"
Step 3: pad4(30) → "0030"
Step 4: scramble4("5678", "7319") → "2987"
         scramble4("0030", "7319") → "7349"
Step 5: plain = "2987" + "0123" + "7349" = "298701237349"
         checksum = generateChecksum4("298701237349") → "XXXX"
Output: "298701237349XXXX"
```

---

## 3. Activation Code Decryption (Verification)

### 3.1 16-digit Format

```
Input: 16-digit numeric string (spaces are stripped)
Steps:
  1. Strip all whitespace
  2. Assert length === 16
  3. Split: scrambledPid(0-4), idHash(4-8), scrambledDays(8-12), checksum(12-16)
  4. Recompute checksum from scrambledPid + idHash + scrambledDays
  5. Compare with provided checksum
  6. Unscramble: pid = unscramble4(scrambledPid, ACTIVATION_SECRET)
  7. Unscramble: days = parseInt(unscramble4(scrambledDays, ACTIVATION_SECRET))
  8. isPermanent = (days === 9999)
```

**Return value**:
```json
{
  "valid": true,
  "productId": "5678",
  "deviceHash": "0123",
  "days": 30,
  "isPermanent": false,
  "format": "16位"
}
```

### 3.2 Invalid Cases

```json
{ "valid": false, "reason": "激活码长度无效（需16位）" }
{ "valid": false, "reason": "校验码不匹配，激活码可能被篡改" }
```

---

## 4. Checksum Algorithm

**Purpose**: 4-digit integrity checksum to prevent tampering with activation codes.

**Algorithm**: Rolling hash, then mod 10000.

```
function generateChecksum4(str):
  hash = 0
  for each char c in str:
    hash = ((hash << 5) - hash) + charCodeAt(c)
    hash = hash & hash    // force 32-bit signed integer semantics
  return pad4(abs(hash) % 10000)
```

**Note**: `hash & hash` is a JavaScript idiom that forces the value into 32-bit signed integer range (same as `hash | 0`). In other languages, use a 32-bit signed integer type or cast.

**C/C++ equivalent**:
```c
int32_t hash = 0;
for (int i = 0; str[i]; i++) {
    hash = ((hash << 5) - hash) + (unsigned char)str[i];
}
int checksum = abs(hash) % 10000;
```

**Java equivalent**:
```java
int hash = 0;
for (char c : str.toCharArray()) {
    hash = ((hash << 5) - hash) + c;
}
int checksum = Math.abs(hash) % 10000;
```

**Python equivalent**:
```python
hash_val = 0
for c in str_val:
    hash_val = ((hash_val << 5) - hash_val) + ord(c)
    hash_val = hash_val & 0xFFFFFFFF  # keep 32-bit
    if hash_val >= 0x80000000:
        hash_val -= 0x100000000  # convert to signed
checksum = abs(hash_val) % 10000
```

**Example**:
```
Input:  "567801230030"
Output: "1234" (deterministic)
```

---

## 5. Redeem Code Generation

**Purpose**: Generate a random 4-character alphanumeric code used as a redeem/exchange key.

**Character Set**:
```
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz
```
(62 characters: 0-9, A-Z, a-z)

**Algorithm**:
```
for i in 0..3:
  code += CHARSET[random_index(62)]
return code
```

**Collision handling**: When generating redeem codes, the system checks Redis for existence. If a code already exists, it regenerates. This is handled at the API level, not in the generator function.

**Validation pattern**: `/^[A-Za-z0-9]{4}$/`

---

## 6. JWT Authentication (Admin Login)

### 6.1 Token Structure

Standard JWT with **HS256** (HMAC-SHA256).

```
Header:  {"alg":"HS256","typ":"JWT"}
Payload: {"username":"...","iat":<timestamp_ms>,"exp":<timestamp_ms>}
```

### 6.2 Signing Algorithm

```
1. headerB64  = base64url(JSON.stringify(header))
2. payloadB64 = base64url(JSON.stringify(payload))
3. signature  = HMAC-SHA256(secret, headerB64 + "." + payloadB64) → base64url
4. token      = headerB64 + "." + payloadB64 + "." + signature
```

### 6.3 Verification Algorithm

```
1. Split token by "." → [headerB64, payloadB64, signature]
2. Assert exactly 3 parts
3. Decode payloadB64 from base64url → JSON parse
4. Check payload.exp > current_time_ms (if exp exists)
5. Recompute: HMAC-SHA256(secret, headerB64 + "." + payloadB64) → base64url
6. Assert recomputed signature === provided signature
7. Return payload if valid, null otherwise
```

### 6.4 Secret Key

```
JWT_SECRET = process.env.JWT_SECRET || "jwt-secret-change-me"
```

### 6.5 Token Expiry

```
TOKEN_EXPIRY = 24 hours = 86400000 ms
```

### 6.6 Token Storage

The token is stored as an HTTP cookie named `"token"`.

### 6.7 Node.js Reference

```js
const crypto = require("crypto");

function base64url(str) {
  return Buffer.from(str).toString("base64url");
}

function sign(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verify(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8")
  );
  if (payload.exp && Date.now() > payload.exp) return null;
  const expectedSig = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  if (parts[2] !== expectedSig) return null;
  return payload;
}
```

---

## 7. Vercel JWT Authentication

**Purpose**: Alternative admin authentication via Vercel's built-in JWT cookie.

**Cookie name**: `_vercel_jwt`

**Algorithm**:
```
1. Extract _vercel_jwt cookie from request
2. Split by "." → [header, payload, signature]
3. Base64url-decode the payload (middle part)
4. JSON.parse the payload
5. Check payload.email === "guomengtao@gmail.com" (case-insensitive)
```

**Node.js Reference**:
```js
function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const payload = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(payload);
}
```

---

## 8. Helper: pad4

**Purpose**: Left-pad a number or string to exactly 4 characters with `"0"`.

```
function pad4(n):
  s = String(n)
  while s.length < 4: s = "0" + s
  return s
```

**Example**:
```
pad4(30)   → "0030"
pad4(365)  → "0365"
pad4(9999) → "9999"
```

---

## 9. Summary Table

| Algorithm | Purpose | Input | Output |
|-----------|---------|-------|--------|
| SHA-256 | Device ID hashing | Any string | 64-char lowercase hex |
| Rolling Hash + mod 10000 | Checksum for activation codes | 12-digit string | 4-digit string |
| Rolling Hash + mod 10000 | Product ID → 4 digits | Any string | 4-digit string |
| Rolling Hash + mod 10000 | Device ID → 4 digits | Device ID string | 4-digit string |
| Digit-wise Caesar + mod 10 | Scramble product ID & days | 4-digit + secret "7319" | 4-digit string |
| Random selection from 62-char set | Redeem code generator | (none) | 4-char alphanumeric |
| HMAC-SHA256 + base64url | JWT signing | JSON payload | JWT token string |
| HMAC-SHA256 + base64url | JWT verification | JWT token | JSON payload or null |
| base64url decode | Vercel JWT decode | JWT token | JSON payload |

---

## 10. Integration Checklist

When integrating external software with this system, ensure you can:

- [ ] Compute SHA-256 hash and output lowercase hex
- [ ] Implement the rolling hash checksum (`hash = (hash << 5) - hash + charCode`) with 32-bit signed integer semantics
- [ ] Implement the digit-wise scramble4/unscramble4 with secret `"7319"` (see Section 2.2)
- [ ] Generate activation codes using the scrambled format (scrambledPid + idHash + scrambledDays + checksum)
- [ ] Verify activation codes by recomputing checksum AND unscrambling product ID and days
- [ ] Generate random 4-character alphanumeric redeem codes
- [ ] Sign and verify JWT tokens using HS256 (HMAC-SHA256) with base64url encoding
- [ ] Use the same `JWT_SECRET` value as the server