const crypto = require("crypto");

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function pad4(n) {
  var s = String(n);
  while (s.length < 4) { s = "0" + s; }
  return s;
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

function productIdTo4Digit(pid) {
  if (pid && pid.length === 4 && /^\d{4}$/.test(pid)) {
    return pid;
  }
  var hash = 0;
  for (var i = 0; i < pid.length; i++) {
    hash = ((hash << 5) - hash) + pid.charCodeAt(i);
    hash = hash & hash;
  }
  return pad4(Math.abs(hash) % 10000);
}

function generateActivationCode(productId, deviceId, days) {
  var pid = productIdTo4Digit(productId);
  var idHash = deviceIdTo4Digit(deviceId);
  var daysPart = pad4(days);
  var plain = pid + idHash + daysPart;
  var checksum = generateChecksum4(plain);
  return plain + checksum;
}

function encryptV2(deviceId, productId, days) {
  var pid = productIdTo4Digit(productId);
  var idHash = deviceIdTo4Digit(deviceId);
  var daysPart = pad4(days);
  var plain = pid + idHash + daysPart;
  var checksum = generateChecksum4(plain);
  return {
    productId: pid,
    idHash: idHash,
    daysPart: daysPart,
    checksum: checksum,
    full: plain + checksum,
  };
}

function fmtCode16(code) {
  if (!code || code.length !== 16) return code;
  return code.substring(0, 4) + " " + code.substring(4, 8) + " " + code.substring(8, 12) + " " + code.substring(12, 16);
}

function decryptActivationCode(code) {
  var cleaned = code.replace(/\s/g, "");
  if (cleaned.length !== 16 && cleaned.length !== 12) {
    return { valid: false, reason: "激活码长度无效（需16位或12位）" };
  }

  if (cleaned.length === 16) {
    var pid = cleaned.substring(0, 4);
    var idHash = cleaned.substring(4, 8);
    var daysStr = cleaned.substring(8, 12);
    var checksum = cleaned.substring(12, 16);
    var days = parseInt(daysStr, 10);
    var plain = pid + idHash + daysStr;
    var expectedChecksum = generateChecksum4(plain);
    if (checksum !== expectedChecksum) {
      return { valid: false, reason: "校验码不匹配，激活码可能被篡改" };
    }
    return {
      valid: true,
      productId: pid,
      deviceHash: idHash,
      days: days,
      isPermanent: days === 9999,
      format: "v2-16位",
    };
  }

  if (cleaned.length === 12) {
    var pid = cleaned.substring(0, 4);
    var idHash = cleaned.substring(4, 8);
    var checksum = cleaned.substring(8, 12);
    var plain = pid + idHash;
    var expectedChecksum = generateChecksum4(plain);
    if (checksum !== expectedChecksum) {
      return { valid: false, reason: "校验码不匹配，激活码可能被篡改" };
    }
    return {
      valid: true,
      productId: pid,
      deviceHash: idHash,
      days: null,
      isPermanent: false,
      format: "v1-12位",
    };
  }
}

module.exports = {
  sha256,
  pad4,
  deviceIdTo4Digit,
  productIdTo4Digit,
  generateChecksum4,
  generateRedeemCode,
  generateActivationCode,
  encryptV2,
  fmtCode16,
  decryptActivationCode,
};