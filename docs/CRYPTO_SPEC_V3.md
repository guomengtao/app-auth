# Activation Code Algorithm V3 Specification

> Version: V3
> Date: 2026-08-31
> Goal: 16-digit pure numeric activation code, hand band input friendly, tamper-resistant

## 1. Design Goals

| Goal | Description |
|------|-------------|
| 16-digit pure numeric | Easy input on hand band, numeric keypad only |
| Device ID hidden in middle | Positions 4-7, tampering detected by checksum |
| Redeem code as salt | Each redeem code generates a different encryption key, preventing batch cracking |
| Tamper-resistant | Checksum covers all content, any modification fails verification |

## 2. Redeem Code Character Set

V2 (old): 62 chars (0-9, A-Z, a-z), 4 chars = 14.77M combinations

V3 (new): 36 chars (0-9, a-z), 4 chars = 1.68M combinations

Reasons for removing uppercase:
- No need to switch case on hand band input, better UX
- 1.68M combinations is sufficient for redeem codes
- Reduces confusion (e.g. O/0, I/l/1)

## 3. Activation Code Format

16-digit structure:

```
Pos:     0-3    4-7    8-11   12-15
        +------+------+------+------+
        | PPPP | CCCC | SSSS | DDDD |
        +------+------+------+------+
          |      |      |      |
          |      |      |      +-- scrambled device ID hash (4 digits) <- at the end
          |      |      +-- scrambled days (4 digits)
          |      +-- embedded checksum (4 digits) <- hidden in middle! scramble4(saltHash, checksum)
          +-- scrambled product ID (4 digits)
```

Display format: no spaces `7312567800301234`, with spaces `7312 5678 0030 1234`

## 4. Core Algorithm

Constant: `ACTIVATION_SECRET = "7319"`

### 4.1 Generation Flow

```
Input: productId, deviceId, days, salt (redeem code)

1. pid = productIdTo4Digit(productId)
2. idHash = deviceIdTo4Digit(deviceId)
3. daysPart = pad4(days)
4. saltHash = generateChecksum4(salt)
5. perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash)
6. scrambledPid = scramble4(pid, perCodeSecret)
7. scrambledIdHash = scramble4(idHash, perCodeSecret)
8. scrambledDays = scramble4(daysPart, perCodeSecret)
9. plain = scrambledPid + scrambledIdHash + scrambledDays
10. checksum = generateChecksum4(plain)
11. embedded = scramble4(saltHash, checksum)
12. activation code = scrambledPid + embedded + scrambledDays + scrambledIdHash (16 digits)
```

### 4.2 Decryption/Verification Flow

```
Input: 16-digit activation code

1. Split: scrambledPid(0-4), embedded(4-8), scrambledDays(8-12), scrambledIdHash(12-16)
2. plain = scrambledPid + scrambledIdHash + scrambledDays
3. checksum = generateChecksum4(plain)
4. saltHash = unscramble4(embedded, checksum)
5. perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash)
6. pid = unscramble4(scrambledPid, perCodeSecret)
7. idHash = unscramble4(scrambledIdHash, perCodeSecret)
8. days = parseInt(unscramble4(scrambledDays, perCodeSecret))

Returns:
{
  valid: true,
  productId: pid,
  deviceHash: idHash,
  days: days,
  isPermanent: days === 9999,
  format: "16"
}
```

## 5. Helper Algorithms

### 5.1 String -> 4-digit hash

```
function hashTo4Digit(str):
  hash = 0
  for each char c in str:
    hash = ((hash << 5) - hash) + charCodeAt(c)
    hash = hash & hash
  return pad4(abs(hash) % 10000)
```

Used by: productIdTo4Digit, deviceIdTo4Digit, generateChecksum4

### 5.2 Digit Scramble (per-digit add/subtract)

```
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

### 5.3 Zero-padding

```
function pad4(n):
  s = String(n)
  while s.length < 4: s = "0" + s
  return s
```

## 6. Security Analysis

| Attack | Defense |
|--------|---------|
| Modify device ID | Device ID hash in middle (pos 4-7), checksum won't match |
| Modify days | Days scrambled, cannot compute correct value without dynamic key |
| Batch generation | Each redeem code produces different perCodeSecret, no batch cracking |
| Brute force | 16 pure digits = 10^16 combinations |
| Redeem code enumeration | 36^4 = 1.68M, server can rate-limit |

## 7. V2 -> V3 Migration

- Activation code length: 20 digits -> 16 digits
- 16-digit code does not contain recoverable device ID, only device ID hash
- Redeem code charset: no more uppercase letters
- Old 20-digit codes still verifiable (auto-detected by length)
- New codes are always 16 digits