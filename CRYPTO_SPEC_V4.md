# 可还原的解密和加密算法 (Reversible Encryption/Decryption Algorithm)

## 1. 设计目标

- 激活码长度：**16位纯数字**，用户在手环上输入友好
- 解密后可还原原始字符：设备ID、产品ID、天数
- 包含4项信息：产品ID、兑换码、天数、设备ID（缺一不可）
- 防篡改：修改任意一位数字都会导致校验失败
- 兑换码作为加密密钥参与，不直接出现在码中（数学约束，见下文）

---

## 2. 数学约束分析

### 2.1 为什么16位纯数字无法同时容纳全部4项的原始字符？

| 信息项 | 原始格式 | 字符集 | 可能值数量 | 最少需要位数 |
|--------|----------|--------|-----------|-------------|
| 设备ID | 4字符 | 62 (0-9,a-z,A-Z) | 62^4 = 14,776,336 | 8位 |
| 兑换码 | 4字符 | 36 (0-9,a-z) | 36^4 = 1,679,616 | 7位 |
| 天数 | 数字 | 0-9999 | 10,000 | 4位 |
| 产品ID | 字符串 | 任意 | 哈希后4位(碰撞) | 4位 |
| **合计** | | | | **23位** |

23位 > 16位，**数学上不可能全部还原原始字符**。

### 2.2 取舍方案

**兑换码不直接编码进16位数字中**，而是作为加密密钥参与加解密：

- 兑换码通过 `generateChecksum4(salt)` 生成 `saltHash`（4位哈希）
- `saltHash` 参与推导 `perCodeSecret`（逐码密钥）
- 兑换码不同 → `saltHash` 不同 → `perCodeSecret` 不同 → 解密失败
- **效果等价于"兑换码包含在码中"，且无法被剥离**

---

## 3. 16位激活码结构

```
Pos:     0-7        8-9   10-11  12-15
        +----------+------+------+------+
        | DDDDDDDD |  II  |  SS  | CCCC |
        +----------+------+------+------+
          |          |      |      |
          |          |      |      +-- 校验码嵌入 (4位) ← 藏在中间!
          |          |      +-- 天数 (2位, 00-99, 99=永久)
          |          +-- 产品ID索引 (2位, 00-99, 查表还原)
          +-- 设备ID编码 (8位, 每字符2位数字, 可还原原始字符串)
```

### 3.1 各部分说明

| 部分 | 位置 | 位数 | 说明 | 可还原 |
|------|------|------|------|--------|
| 设备ID编码 | 0-7 | 8 | `encodeDeviceId(deviceId)`，每字符编码为2位数字 | ✅ 完全还原 |
| 产品ID索引 | 8-9 | 2 | 产品在预定义列表中的序号(0-99) | ✅ 查表还原 |
| 天数 | 10-11 | 2 | 00-99，99=永久 | ✅ 完全还原 |
| 校验码嵌入 | 12-15 | 4 | `scramble4(saltHash, checksum)`，兑换码参与 | ✅ saltHash可还原 |

### 3.2 校验码计算

```
plain = deviceIdEncoded(8位) + productIndex(2位) + daysPart(2位)
checksum = generateChecksum4(plain)        // 覆盖前12位, 防篡改
saltHash = generateChecksum4(redeemCode)    // 兑换码的4位哈希
embedded = scramble4(saltHash, checksum)    // 校验码藏在最后4位
```

---

## 4. 编码规则

### 4.1 设备ID编码 (encodeDeviceId)

将4字符设备ID编码为8位数字，每字符对应2位数字(00-61)：

```
字符映射表 (62字符集):
  '0'-'9' → 53-62
  'A'-'Z' → 01-26
  'a'-'z' → 27-52

示例: "AAAA" → "01"+"01"+"01"+"01" = "01010101"
      "Aa09" → "01"+"27"+"53"+"62" = "01275362"
```

解码时反向查表，**完全还原原始字符串**。

### 4.2 产品ID索引

产品ID为任意字符串（如 `"app-pro"`, `"my-app"`），不直接编码。使用预定义产品列表：

```javascript
// 产品列表 (服务器和手环端需同步)
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

编码时：`productIndex = PRODUCT_LIST.indexOf(productId)`，转为2位数字(`"04"`)。  
解码时：`productId = PRODUCT_LIST[productIndex]`，**查表还原原始字符串**。

### 4.3 天数编码

天数范围 0-99，编码为2位数字：
- 1-98：实际天数
- 99：永久有效
- 00：保留

### 4.4 兑换码 (不在码中，作为密钥)

兑换码为4字符(36字符集: 0-9, a-z)，通过哈希参与加密：

```
saltHash = generateChecksum4(redeemCode)   // 4位哈希
perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash)  // 逐码密钥
```

不同兑换码 → 不同 saltHash → 不同 perCodeSecret → 解密结果不同。

---

## 5. 加密流程 (生成激活码)

```
输入: productId, deviceId, days, redeemCode

1. deviceIdEncoded = encodeDeviceId(deviceId)        // 8位数字
2. productIndex = pad2(PRODUCT_LIST.indexOf(productId)) // 2位数字
3. daysPart = pad2(days)                              // 2位数字
4. saltHash = generateChecksum4(redeemCode)            // 4位哈希
5. perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash) // 4位密钥

6. scrambledDev = scrambleN(deviceIdEncoded, perCodeSecret)  // 8位, 加扰
7. scrambledIdx = scramble4(productIndex, perCodeSecret)     // 2位, 加扰
8. scrambledDays = scramble4(daysPart, perCodeSecret)        // 2位, 加扰

9. plain = scrambledDev + scrambledIdx + scrambledDays       // 12位明文
10. checksum = generateChecksum4(plain)                      // 4位校验码
11. embedded = scramble4(saltHash, checksum)                 // 4位嵌入(兑换码)

12. activationCode = scrambledDev + scrambledIdx + scrambledDays + embedded
    // 16位纯数字
```

---

## 6. 解密流程 (验证激活码)

```
输入: activationCode (16位纯数字), PRODUCT_LIST (产品列表)

1. 拆分:
   scrambledDev = code[0..7]       // 8位
   scrambledIdx = code[8..9]       // 2位
   scrambledDays = code[10..11]    // 2位
   embedded = code[12..15]         // 4位

2. plain = scrambledDev + scrambledIdx + scrambledDays  // 12位
3. checksum = generateChecksum4(plain)                   // 4位校验码

4. saltHash = unscramble4(embedded, checksum)             // 还原兑换码哈希
5. perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash) // 还原密钥

6. deviceIdEncoded = unscrambleN(scrambledDev, perCodeSecret)  // 8位
7. deviceId = decodeDeviceId(deviceIdEncoded)                  // 原始字符串! ✅
8. productIndex = parseInt(unscramble4(scrambledIdx, perCodeSecret), 10) // 数字
9. productId = PRODUCT_LIST[productIndex]                     // 原始字符串! ✅
10. days = parseInt(unscramble4(scrambledDays, perCodeSecret), 10) // 数字 ✅

11. 验证:
    - productIndex 是否在有效范围内
    - days 是否有效 (1-98 或 99=永久)
    - deviceId 解码是否成功

返回: { productId, deviceId, days, saltHash }
```

---

## 7. 防篡改机制

### 7.1 校验码覆盖

```
checksum = generateChecksum4(scrambledDev + scrambledIdx + scrambledDays)
```

修改任意一位数字 → plain 改变 → checksum 改变 → embedded 解密出的 saltHash 改变 → perCodeSecret 改变 → 全部解密结果错乱。

### 7.2 兑换码绑定

```
saltHash = generateChecksum4(redeemCode)
embedded = scramble4(saltHash, checksum)
```

攻击者不知道兑换码 → 无法计算正确的 saltHash → 无法伪造 embedded。

### 7.3 攻击场景分析

| 攻击方式 | 为什么失败 |
|----------|-----------|
| 修改设备ID | checksum不匹配 → saltHash错误 → 解密失败 |
| 修改天数 | 同上 |
| 修改产品ID | 同上 |
| 修改校验码 | saltHash错误 → perCodeSecret错误 → 全部解密错误 |
| 猜测兑换码 | saltHash空间=10000, 暴力破解需尝试10000次 |
| 重放攻击 | 设备ID绑定, 其他设备无法使用 |

---

## 8. 字符集

| 字符集 | 字符 | 大小 | 用途 |
|--------|------|------|------|
| 激活码 | 0-9 | 10 | 16位纯数字, 用户在手环输入 |
| 设备ID | 0-9, a-z, A-Z | 62 | 设备标识, 可还原 |
| 兑换码 | 0-9, a-z | 36 | 购买凭证, 作为密钥(不直接出现在码中) |
| 产品ID | 任意字符串 | 不限 | 通过索引查表还原 |

---

## 9. API 参考

### 9.1 generateActivationCode(productId, deviceId, days, redeemCode)

生成16位激活码。

```javascript
// 输入
productId:  string  // 产品ID, 如 "app-pro"
deviceId:   string  // 设备ID, 4字符, 如 "AAAA"
days:       number  // 天数, 1-98 或 99(永久)
redeemCode: string  // 兑换码, 4字符, 如 "bbbb"

// 输出
string  // 16位纯数字激活码, 如 "01010101040499..."
```

### 9.2 decryptActivationCode(code)

解密16位激活码，还原原始字符。

```javascript
// 输入
code: string  // 16位纯数字激活码

// 输出
{
  valid:      boolean,  // 是否有效
  productId:  string,   // 原始产品ID, 如 "app-pro" ✅
  deviceId:   string,   // 原始设备ID, 如 "AAAA" ✅
  days:       number,   // 天数, 如 30 ✅
  saltHash:   string,   // 兑换码哈希(4位)
  isPermanent: boolean, // 是否永久
  format:     string,   // "16位"
}
```

### 9.3 encodeDeviceId / decodeDeviceId

设备ID编码/解码。

```javascript
encodeDeviceId("AAAA")  // → "01010101"
decodeDeviceId("01010101")  // → "AAAA"
```

---

## 10. 示例

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
1. deviceIdEncoded = encodeDeviceId("AAAA") = "01010101"
2. productIndex = "04"  (app-pro 在列表中索引为4)
3. daysPart = "30"
4. saltHash = generateChecksum4("bbbb") = "xxxx"
5. perCodeSecret = scramble4("7319", "xxxx") = "yyyy"
6. scrambledDev = scrambleN("01010101", "yyyy") = "........"
7. scrambledIdx = scramble4("04", "yyyy") = ".."
8. scrambledDays = scramble4("30", "yyyy") = ".."
9. plain = scrambledDev + scrambledIdx + scrambledDays
10. checksum = generateChecksum4(plain) = "cccc"
11. embedded = scramble4("xxxx", "cccc") = "eeee"
12. code = "........" + ".." + ".." + "eeee"  // 16位
```

### 解密过程
```
1. 拆分 → scrambledDev, scrambledIdx, scrambledDays, embedded
2. checksum = generateChecksum4(plain)
3. saltHash = unscramble4(embedded, checksum) = "xxxx"
4. perCodeSecret = scramble4("7319", "xxxx") = "yyyy"
5. deviceIdEncoded = unscrambleN(scrambledDev, "yyyy") = "01010101"
6. deviceId = decodeDeviceId("01010101") = "AAAA" ✅
7. productIndex = 4 → PRODUCT_LIST[4] = "app-pro" ✅
8. days = 30 ✅
```

---

## 11. 总结

| 需求 | 状态 | 说明 |
|------|------|------|
| 16位纯数字 | ✅ | 用户友好，手环输入方便 |
| 设备ID可还原 | ✅ | 8位编码，`decodeDeviceId` 还原原始字符串 |
| 产品ID可还原 | ✅ | 2位索引，查表还原原始字符串 |
| 天数可还原 | ✅ | 2位数字，直接还原 |
| 兑换码参与 | ✅ | 作为密钥参与加密，`saltHash` 嵌入校验码 |
| 防篡改 | ✅ | 校验码覆盖全部内容，修改任意位导致解密失败 |
| 兑换码还原 | ❌ 不可行 | 数学约束，16位数字无法容纳4字符(36字符集) |

**唯一无法还原的是兑换码原始字符串**，因为它需要7位数字来编码，但16位已经被其他3项占满。兑换码作为加密密钥参与，效果等价：兑换码不对则解密失败，防篡改机制完整。