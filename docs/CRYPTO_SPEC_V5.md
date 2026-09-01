# 可还原的解密和加密算法 V5 — 20位纯数字

## 1. 设计目标

- 激活码长度：**20位纯数字**
- 解密后**全部4项还原原始字符**：设备ID、兑换码、产品ID、天数
- 4项信息缺一不可，全部在码中
- 防篡改：修改任意一位数字 → 解密失败

---

## 2. 20位激活码结构

```
Pos:     0-7        8-14     15-16  17-19  19
        +----------+---------+------+------+--+
        | DDDDDDDD | RRRRRRR |  II  | SSS  |C |
        +----------+---------+------+------+--+
          |          |         |      |      |
          |          |         |      |      +-- 校验码 (1位, 覆盖前19位)
          |          |         |      +-- 天数 (3位, 000-999, 999=永久)
          |          |         +-- 产品ID索引 (2位, 00-99, 查表还原)
          |          +-- 兑换码编码 (7位, base36→数字, 可还原原始字符!)
          +-- 设备ID编码 (8位, 每字符2位, 可还原原始字符!)
```

### 2.1 各部分说明

| 部分 | 位置 | 位数 | 编码方式 | 可还原 | 示例 |
|------|------|------|----------|--------|------|
| 设备ID | 0-7 | 8 | `encodeDeviceId`, 每字符→2位数字 | ✅ 完全还原 | `AAAA` → `01010101` |
| 兑换码 | 8-14 | 7 | base36→数字, 4字符36^4=167万 | ✅ 完全还原 | `bbbb` → `0146280` |
| 产品ID | 15-16 | 2 | 预定义产品列表索引 | ✅ 查表还原 | `app-pro` → `04` |
| 天数 | 17-19 | 3 | 直接数字, 999=永久 | ✅ 完全还原 | `30` → `030` |
| 校验码 | 19 | 1 | 前19位加扰后求checksum | - | `5` |

---

## 3. 编码规则

### 3.1 设备ID编码 (encodeDeviceId)

将4字符设备ID编码为8位数字，每字符对应2位数字(00-61)：

```
字符映射表 (62字符集):
  '0'-'9' → 53-62
  'A'-'Z' → 01-26
  'a'-'z' → 27-52

示例: "AAAA" → "01010101"
      "Aa09" → "01275362"
      "Xy99" → "24516262"
```

解码时反向查表，**完全还原原始字符串**。

### 3.2 兑换码编码 (redeemCodeTo7Digit / digit7ToRedeemCode)

将4字符兑换码(36字符集: 0-9, a-z)编码为7位数字：

```
function redeemCodeTo7Digit(code):
  // 将4字符视为base36数字，转为10进制
  // 36^3 * idx(c0) + 36^2 * idx(c1) + 36^1 * idx(c2) + idx(c3)
  value = 0
  for each char c in code:
    value = value * 36 + charIndex(c)
  return pad7(value)     // 7位数字, 范围 0000000-1679615

function digit7ToRedeemCode(digits):
  value = parseInt(digits, 10)
  result = ""
  for i = 0 to 3:
    result = CHARSET[value % 36] + result
    value = value / 36
  return result
```

示例:
```
"0000" → 36^3*0 + 36^2*0 + 36*0 + 0 = 0000000
"bbbb" → 36^3*11 + 36^2*11 + 36*11 + 11 = 0146280
"zzzz" → 36^3*35 + 36^2*35 + 36*35 + 35 = 1679615
```

解码时反向计算，**完全还原原始字符串**。

### 3.3 产品ID索引

产品ID为任意字符串（如 `"app-pro"`, `"my-app"`），使用预定义产品列表：

```javascript
const PRODUCT_LIST = [
  "prod-001",   // index 0
  "prod-002",   // index 1
  "my-app",     // index 2
  "test-prod",  // index 3
  "app-pro",    // index 4
  "tool-vip",   // index 5
  "game-pass",  // index 6
  "cloud-sync", // index 7
  // ... 最多100个产品
];
```

编码时：`productIndex = pad2(PRODUCT_LIST.indexOf(productId))`。  
解码时：`productId = PRODUCT_LIST[productIndex]`，**查表还原原始字符串**。

### 3.4 天数编码

天数范围 0-999，编码为3位数字：
- 1-998：实际天数
- 999：永久有效
- 000：保留

### 3.5 校验码

```
checksum = generateChecksum1(scrambled19)  // 1位校验码, 覆盖前19位加扰数据
```

前19位先加扰，再求校验码。校验码放在最后一位(position 19)。

---

## 4. 加密流程

```
输入: productId, deviceId, days, redeemCode

1. devEncoded  = encodeDeviceId(deviceId)           // 8位, "AAAA" → "01010101"
2. redeemEncoded = redeemCodeTo7Digit(redeemCode)    // 7位, "bbbb" → "0146280"
3. productIdx  = pad2(PRODUCT_LIST.indexOf(productId)) // 2位, "app-pro" → "04"
4. daysPart    = pad3(days)                          // 3位, 30 → "030"

5. saltHash = generateChecksum4(redeemCode)          // 4位, 兑换码哈希
6. perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash) // 4位逐码密钥

7. scrambledDev    = scrambleN(devEncoded, perCodeSecret)    // 8位
8. scrambledRedeem = scrambleN(redeemEncoded, perCodeSecret) // 7位
9. scrambledIdx    = scramble4(productIdx, perCodeSecret)     // 2位
10. scrambledDays  = scrambleN(daysPart, perCodeSecret)      // 3位

11. first19 = scrambledDev + scrambledRedeem + scrambledIdx + scrambledDays
12. checksum = generateChecksum1(first19)              // 1位校验码

13. activationCode = first19 + checksum               // 20位纯数字
```

---

## 5. 解密流程

```
输入: activationCode (20位纯数字), PRODUCT_LIST

1. 拆分:
   scrambledDev    = code[0..7]       // 8位
   scrambledRedeem = code[8..14]      // 7位
   scrambledIdx    = code[15..16]     // 2位
   scrambledDays   = code[17..19]     // 3位
   checksumDigit   = code[19]         // 1位 (最后一位)

2. 验证校验码:
   first19 = scrambledDev + scrambledRedeem + scrambledIdx + scrambledDays
   expectedChecksum = generateChecksum1(first19)
   if (checksumDigit !== expectedChecksum) → 校验失败, 码被篡改

3. 提取兑换码:
   // 需要先知道兑换码才能推导perCodeSecret
   // 但兑换码被加扰了, 需要perCodeSecret才能解扰
   // 解决方案: 使用ACTIVATION_SECRET推导临时密钥
   tempSecret = scramble4(ACTIVATION_SECRET, "0000")  // 固定临时密钥
   redeemEncoded = unscrambleN(scrambledRedeem, tempSecret) // 7位
   redeemCode = digit7ToRedeemCode(redeemEncoded)     // 原始兑换码! ✅

4. 推导真密钥:
   saltHash = generateChecksum4(redeemCode)            // 4位
   perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash) // 4位

5. 解扰其余字段:
   devEncoded = unscrambleN(scrambledDev, perCodeSecret)    // 8位
   deviceId = decodeDeviceId(devEncoded)                    // 原始设备ID! ✅
   productIdx = unscramble4(scrambledIdx, perCodeSecret)     // 2位
   productId = PRODUCT_LIST[parseInt(productIdx, 10)]        // 原始产品ID! ✅
   days = parseInt(unscrambleN(scrambledDays, perCodeSecret), 10) // 天数 ✅

6. 验证:
   - productIdx 是否在有效范围内
   - days 是否有效 (1-998 或 999=永久)
   - deviceId 解码是否成功
   - redeemCode 是否全部为合法字符

返回: { productId, deviceId, days, redeemCode, saltHash }
```

### 5.1 兑换码提取的关键设计

兑换码被加扰在码中，但解密需要兑换码来推导密钥。这是一个"鸡生蛋"问题。

**解决方案**：兑换码用固定的临时密钥(`ACTIVATION_SECRET`)加扰，其他字段用兑换码推导的 `perCodeSecret` 加扰。这样解密时先用固定密钥提取兑换码，再用兑换码推导真密钥解扰其他字段。

```
加密:  redeem部分 → scrambleN(..., ACTIVATION_SECRET)     // 固定密钥
       dev/idx/days → scrambleN(..., perCodeSecret)        // 兑换码密钥

解密:  redeem部分 → unscrambleN(..., ACTIVATION_SECRET)    // 先提取兑换码
       推导 perCodeSecret = f(redeemCode)                   // 再推导真密钥
       dev/idx/days → unscrambleN(..., perCodeSecret)       // 解扰其余字段
```

---

## 6. 防篡改机制

### 6.1 校验码覆盖

```
checksum = generateChecksum1(scrambledDev + scrambledRedeem + scrambledIdx + scrambledDays)
```

修改任意一位 → checksum 不匹配 → 解密失败。

### 6.2 双层密钥保护

```
篡改兑换码 → 提取出的兑换码改变 → saltHash改变 → perCodeSecret改变
→ 设备ID/产品ID/天数全部解扰为乱码 → 校验失败
```

### 6.3 攻击场景分析

| 攻击方式 | 为什么失败 |
|----------|-----------|
| 修改设备ID部分 | checksum不匹配 |
| 修改兑换码部分 | 兑换码提取错误 → perCodeSecret错误 → 全部乱码 |
| 修改产品ID部分 | checksum不匹配 |
| 修改天数部分 | checksum不匹配 |
| 修改校验码 | checksum不匹配 |
| 暴力破解兑换码 | 36^4=167万种可能, 需逐一尝试 |
| 重放攻击 | 设备ID绑定, 其他设备无法使用 |

---

## 7. 完整示例

### 输入
```
productId  = "app-pro"      (产品列表索引4)
deviceId   = "AAAA"
days       = 30
redeemCode = "bbbb"
ACTIVATION_SECRET = "7319"
```

### 加密过程
```
1. devEncoded    = "01010101"     (AAAA → encodeDeviceId)
2. redeemEncoded = "0146280"      (bbbb → redeemCodeTo7Digit)
3. productIdx    = "04"           (app-pro = index 4)
4. daysPart      = "030"          (30天)

5. saltHash      = generateChecksum4("bbbb") = "xxxx"
6. perCodeSecret = scramble4("7319", "xxxx") = "yyyy"

7. scrambledDev    = scrambleN("01010101", "yyyy") = "........"
8. scrambledRedeem = scrambleN("0146280", "7319")  = "......."  (固定密钥)
9. scrambledIdx    = scramble4("04", "yyyy")        = ".."
10. scrambledDays  = scrambleN("030", "yyyy")       = "..."

11. first19  = "........" + "......." + ".." + "..."
12. checksum = generateChecksum1(first19) = "c"

13. code = first19 + "c"   // 20位纯数字
```

### 解密过程
```
1. 拆分 → scrambledDev(8) + scrambledRedeem(7) + scrambledIdx(2) + scrambledDays(3) + checksum(1)
2. 校验 checksum → 通过

3. redeemEncoded = unscrambleN(scrambledRedeem, "7319") = "0146280"
   redeemCode = digit7ToRedeemCode("0146280") = "bbbb" ✅

4. saltHash = generateChecksum4("bbbb") = "xxxx"
   perCodeSecret = scramble4("7319", "xxxx") = "yyyy"

5. devEncoded = unscrambleN(scrambledDev, "yyyy") = "01010101"
   deviceId = decodeDeviceId("01010101") = "AAAA" ✅

6. productIdx = unscramble4(scrambledIdx, "yyyy") = "04"
   productId = PRODUCT_LIST[4] = "app-pro" ✅

7. days = unscrambleN(scrambledDays, "yyyy") = "030" → 30 ✅
```

---

## 8. 与V4(16位)对比

| 特性 | V4 (16位) | V5 (20位) |
|------|-----------|-----------|
| 激活码长度 | 16位 | 20位 |
| 设备ID可还原 | ✅ 8位编码 | ✅ 8位编码 |
| 兑换码可还原 | ❌ 仅哈希 | ✅ 7位编码, 完全还原 |
| 产品ID可还原 | ✅ 2位索引 | ✅ 2位索引 |
| 天数可还原 | ✅ 2位(0-99) | ✅ 3位(0-999) |
| 校验码 | 4位 | 1位 |
| 用户输入难度 | 容易 | 稍长, 仍可接受 |

---

## 9. API 参考

### 9.1 generateActivationCode(productId, deviceId, days, redeemCode)

```javascript
// 输入
productId:  string  // 产品ID
deviceId:   string  // 设备ID, 4字符
days:       number  // 天数, 1-998 或 999(永久)
redeemCode: string  // 兑换码, 4字符(0-9,a-z)

// 输出
string  // 20位纯数字激活码
```

### 9.2 decryptActivationCode(code)

```javascript
// 输入
code: string  // 20位纯数字激活码

// 输出
{
  valid:       boolean,
  productId:   string,   // 原始产品ID ✅
  deviceId:    string,   // 原始设备ID ✅
  days:        number,   // 天数 ✅
  redeemCode:  string,   // 原始兑换码 ✅
  saltHash:    string,   // 兑换码哈希
  isPermanent: boolean,
  format:      "20位",
}
```

### 9.3 辅助函数

```javascript
redeemCodeTo7Digit("bbbb")   // → "0146280"
digit7ToRedeemCode("0146280") // → "bbbb"
encodeDeviceId("AAAA")        // → "01010101"
decodeDeviceId("01010101")    // → "AAAA"
```

---

## 10. 总结

| 需求 | 状态 | 说明 |
|------|------|------|
| 20位纯数字 | ✅ | 手环输入可接受 |
| 设备ID可还原原始字符 | ✅ | 8位编码, `decodeDeviceId` 还原 |
| 兑换码可还原原始字符 | ✅ | 7位base36编码, `digit7ToRedeemCode` 还原 |
| 产品ID可还原原始字符 | ✅ | 2位索引, 查 PRODUCT_LIST 还原 |
| 天数可还原 | ✅ | 3位数字, 直接还原 |
| 防篡改 | ✅ | 1位校验码 + 双层密钥加扰 |
| 全部4项在码中 | ✅ | 设备ID + 兑换码 + 产品ID + 天数 |