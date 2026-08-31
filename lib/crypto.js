const crypto = require("crypto");

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

var ACTIVATION_SECRET = "7319";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function pad4(n) {
  var s = String(n);
  while (s.length < 4) { s = "0" + s; }
  return s;
}

function pad2(n) {
  var s = String(n);
  while (s.length < 2) { s = "0" + s; }
  return s;
}

function pad3(n) {
  var s = String(n);
  while (s.length < 3) { s = "0" + s; }
  return s;
}

function pad7(n) {
  var s = String(n);
  while (s.length < 7) { s = "0" + s; }
  return s;
}

function scramble4(digits, secret) {
  var result = "";
  for (var i = 0; i < 4; i++) {
    result += ((parseInt(digits[i], 10) + parseInt(secret[i], 10)) % 10).toString();
  }
  return result;
}

function unscramble4(digits, secret) {
  var result = "";
  for (var i = 0; i < 4; i++) {
    result += ((parseInt(digits[i], 10) - parseInt(secret[i], 10) + 10) % 10).toString();
  }
  return result;
}

function scrambleN(digits, secret) {
  var result = "";
  for (var i = 0; i < digits.length; i++) {
    var s = parseInt(secret[i % secret.length], 10);
    result += ((parseInt(digits[i], 10) + s) % 10).toString();
  }
  return result;
}

function unscrambleN(digits, secret) {
  var result = "";
  for (var i = 0; i < digits.length; i++) {
    var s = parseInt(secret[i % secret.length], 10);
    result += ((parseInt(digits[i], 10) - s + 10) % 10).toString();
  }
  return result;
}

function charToDigit2(c) {
  var code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return pad2(code - 48 + 53);
  if (code >= 65 && code <= 90) return pad2(code - 65 + 1);
  if (code >= 97 && code <= 122) return pad2(code - 97 + 27);
  return "00";
}

function digit2ToChar(d) {
  var n = parseInt(d, 10);
  if (n >= 53 && n <= 62) return String.fromCharCode(48 + n - 53);
  if (n >= 1 && n <= 26) return String.fromCharCode(65 + n - 1);
  if (n >= 27 && n <= 52) return String.fromCharCode(97 + n - 27);
  return "?";
}

function encodeDeviceId(deviceId) {
  var result = "";
  for (var i = 0; i < 4; i++) {
    if (i < deviceId.length) {
      result += charToDigit2(deviceId[i]);
    } else {
      result += "00";
    }
  }
  return result;
}

function decodeDeviceId(encoded) {
  var result = "";
  for (var i = 0; i < 8; i += 2) {
    var pair = encoded.substring(i, i + 2);
    var ch = digit2ToChar(pair);
    if (ch !== "?") {
      result += ch;
    }
  }
  return result;
}

function deviceIdTo4Digit(id) {
  var hash = 0;
  for (var i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash = hash & hash;
  }
  return pad4(Math.abs(hash) % 10000);
}

function generateChecksum4(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return pad4(Math.abs(hash) % 10000);
}

function generateRedeemCode() {
  var code = "";
  for (var i = 0; i < 4; i++) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return code;
}

function generateChecksum1(str) {
  var sum = 0;
  for (var i = 0; i < str.length; i++) {
    sum += parseInt(str[i], 10);
  }
  return String(sum % 10);
}

function charIndex36(c) {
  var code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 122) return code - 97 + 10;
  if (code >= 65 && code <= 90) return code - 65 + 10;
  return 0;
}

function indexToChar36(idx) {
  if (idx >= 0 && idx <= 9) return String.fromCharCode(48 + idx);
  if (idx >= 10 && idx <= 35) return String.fromCharCode(65 + idx - 10);
  return "0";
}

function redeemCodeTo7Digit(code) {
  var value = 0;
  for (var i = 0; i < 4; i++) {
    value = value * 36 + charIndex36(code[i] || "0");
  }
  return pad7(value);
}

function digit7ToRedeemCode(digits) {
  var value = parseInt(digits, 10);
  var result = "";
  for (var i = 0; i < 4; i++) {
    result = indexToChar36(value % 36) + result;
    value = Math.floor(value / 36);
  }
  return result;
}

var PRODUCT_LIST = [
  "prod-001",
  "prod-002",
  "my-app",
  "test-prod",
  "app-pro",
  "tool-vip",
  "game-pass",
  "cloud-sync",
];

function productIdToIndex(productId) {
  var idx = PRODUCT_LIST.indexOf(productId);
  if (idx >= 0) return pad2(idx);
  var num = parseInt(productId, 10);
  if (!isNaN(num) && num >= 0 && num < 100) {
    while (PRODUCT_LIST.length <= num) {
      PRODUCT_LIST.push(String(PRODUCT_LIST.length));
    }
    PRODUCT_LIST[num] = productId;
    return pad2(num);
  }
  PRODUCT_LIST.push(productId);
  return pad2(PRODUCT_LIST.length - 1);
}

function indexToProductId(index) {
  var idx = parseInt(index, 10);
  if (idx >= 0 && idx < PRODUCT_LIST.length) {
    return PRODUCT_LIST[idx];
  }
  return "?";
}

function productIdTo4Digit(pid) {
  if (/^\d{4}$/.test(pid)) {
    return pid;
  }
  var hash = 0;
  for (var i = 0; i < pid.length; i++) {
    hash = ((hash << 5) - hash) + pid.charCodeAt(i);
    hash = hash & hash;
  }
  return pad4(Math.abs(hash) % 10000);
}

function generateActivationCode(productId, deviceId, days, salt) {
  salt = salt || generateRedeemCode();
  var devEncoded = encodeDeviceId(deviceId);
  var redeemEncoded = redeemCodeTo7Digit(salt);
  var productIdx = productIdToIndex(productId);
  var daysPart = pad2(days);
  var saltHash = generateChecksum4(salt);
  var perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash);

  var scrambledDev = scrambleN(devEncoded, perCodeSecret);
  var scrambledRedeem = scrambleN(redeemEncoded, ACTIVATION_SECRET);
  var scrambledIdx = scrambleN(productIdx, perCodeSecret);
  var scrambledDays = scrambleN(daysPart, perCodeSecret);

  var first19 = scrambledDev + scrambledRedeem + scrambledIdx + scrambledDays;
  var checksum = generateChecksum1(first19);

  return first19 + checksum;
}

function encryptV2(deviceId, productId, days, salt) {
  salt = salt || generateRedeemCode();
  var devEncoded = encodeDeviceId(deviceId);
  var redeemEncoded = redeemCodeTo7Digit(salt);
  var productIdx = productIdToIndex(productId);
  var daysPart = pad2(days);
  var saltHash = generateChecksum4(salt);
  var perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash);

  var scrambledDev = scrambleN(devEncoded, perCodeSecret);
  var scrambledRedeem = scrambleN(redeemEncoded, ACTIVATION_SECRET);
  var scrambledIdx = scrambleN(productIdx, perCodeSecret);
  var scrambledDays = scrambleN(daysPart, perCodeSecret);

  var first19 = scrambledDev + scrambledRedeem + scrambledIdx + scrambledDays;
  var checksum = generateChecksum1(first19);

  return {
    productId: productId,
    productIdx: productIdx,
    deviceId: deviceId,
    devEncoded: devEncoded,
    daysPart: daysPart,
    salt: salt,
    saltHash: saltHash,
    redeemEncoded: redeemEncoded,
    perCodeSecret: perCodeSecret,
    checksum: checksum,
    scrambledDev: scrambledDev,
    scrambledRedeem: scrambledRedeem,
    scrambledIdx: scrambledIdx,
    scrambledDays: scrambledDays,
    first19: first19,
    full: first19 + checksum,
  };
}

function fmtCode16(code) {
  if (!code || code.length !== 16) return code;
  return code.substring(0, 4) + " " + code.substring(4, 8) + " " + code.substring(8, 12) + " " + code.substring(12, 16);
}

function fmtCode20(code) {
  if (!code || code.length !== 20) return code;
  return code.substring(0, 8) + " " + code.substring(8, 15) + " " + code.substring(15, 17) + " " + code.substring(17, 19) + " " + code.substring(19, 20);
}

function decryptActivationCode(code) {
  var cleaned = code.replace(/\s/g, "");

  if (cleaned.length === 20) {
    var scrambledDev = cleaned.substring(0, 8);
    var scrambledRedeem = cleaned.substring(8, 15);
    var scrambledIdx = cleaned.substring(15, 17);
    var scrambledDays = cleaned.substring(17, 19);
    var checksumDigit = cleaned.substring(19, 20);

    var first19 = scrambledDev + scrambledRedeem + scrambledIdx + scrambledDays;
    var expectedChecksum = generateChecksum1(first19);
    if (checksumDigit !== expectedChecksum) {
      return { valid: false, reason: "checksum mismatch" };
    }

    var redeemEncoded = unscrambleN(scrambledRedeem, ACTIVATION_SECRET);
    var redeemCode = digit7ToRedeemCode(redeemEncoded);

    var saltHash = generateChecksum4(redeemCode);
    var perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash);

    var devEncoded = unscrambleN(scrambledDev, perCodeSecret);
    var deviceId = decodeDeviceId(devEncoded);
    var productIdx = unscrambleN(scrambledIdx, perCodeSecret);
    var productId = indexToProductId(productIdx);
    var days = parseInt(unscrambleN(scrambledDays, perCodeSecret), 10);

    return {
      valid: true,
      productId: productId,
      deviceId: deviceId,
      days: days,
      redeemCode: redeemCode,
      saltHash: saltHash,
      isPermanent: days === 99,
      format: "20位",
    };
  }

  if (cleaned.length === 16) {
    var scrambledPid = cleaned.substring(0, 4);
    var embedded = cleaned.substring(4, 8);
    var scrambledDays = cleaned.substring(8, 12);
    var scrambledIdHash = cleaned.substring(12, 16);
    var plain = scrambledPid + scrambledIdHash + scrambledDays;
    var checksum = generateChecksum4(plain);

    var saltHash = unscramble4(embedded, checksum);
    var perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash);

    var pid = unscramble4(scrambledPid, perCodeSecret);
    var idHash = unscramble4(scrambledIdHash, perCodeSecret);
    var days = parseInt(unscramble4(scrambledDays, perCodeSecret), 10);

    return {
      valid: true,
      productId: pid,
      deviceHash: idHash,
      days: days,
      saltHash: saltHash,
      checksum: checksum,
      isPermanent: days === 9999,
      format: "16位",
    };
  }

  return { valid: false, reason: "激活码长度无效（需16位或20位）" };
}

module.exports = {
  CHARSET,
  sha256,
  pad4,
  pad2,
  pad3,
  pad7,
  scramble4,
  unscramble4,
  scrambleN,
  unscrambleN,
  ACTIVATION_SECRET,
  PRODUCT_LIST,
  charToDigit2,
  digit2ToChar,
  encodeDeviceId,
  decodeDeviceId,
  deviceIdTo4Digit,
  productIdTo4Digit,
  generateChecksum4,
  generateChecksum1,
  generateRedeemCode,
  redeemCodeTo7Digit,
  digit7ToRedeemCode,
  productIdToIndex,
  indexToProductId,
  generateActivationCode,
  encryptV2,
  fmtCode16,
  fmtCode20,
  decryptActivationCode,
};