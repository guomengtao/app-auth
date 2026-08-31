const crypto = require("crypto");

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Activation code scrambling secret (4 digits, shared with client)
var ACTIVATION_SECRET = "7319";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function pad4(n) {
  var s = String(n);
  while (s.length < 4) { s = "0" + s; }
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
  var hash = 0;
  for (var i = 0; i < pid.length; i++) {
    hash = ((hash << 5) - hash) + pid.charCodeAt(i);
    hash = hash & hash;
  }
  return pad4(Math.abs(hash) % 10000);
}

function generateActivationCode(productId, deviceId, days, salt) {
  var pid = productIdTo4Digit(productId);
  var idHash = deviceIdTo4Digit(deviceId);
  var daysPart = pad4(days);

  salt = salt || generateRedeemCode();
  var saltHash = generateChecksum4(salt);
  var perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash);

  var scrambledPid = scramble4(pid, perCodeSecret);
  var scrambledDays = scramble4(daysPart, perCodeSecret);
  var plain = scrambledPid + idHash + scrambledDays;
  var checksum = generateChecksum4(plain);
  var embedded = scramble4(saltHash, checksum);

  return plain + embedded;
}

function encryptV2(deviceId, productId, days, salt) {
  var pid = productIdTo4Digit(productId);
  var idHash = deviceIdTo4Digit(deviceId);
  var daysPart = pad4(days);

  salt = salt || generateRedeemCode();
  var saltHash = generateChecksum4(salt);
  var perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash);

  var scrambledPid = scramble4(pid, perCodeSecret);
  var scrambledDays = scramble4(daysPart, perCodeSecret);
  var plain = scrambledPid + idHash + scrambledDays;
  var checksum = generateChecksum4(plain);
  var embedded = scramble4(saltHash, checksum);

  return {
    productId: pid,
    idHash: idHash,
    daysPart: daysPart,
    salt: salt,
    saltHash: saltHash,
    perCodeSecret: perCodeSecret,
    checksum: checksum,
    embedded: embedded,
    scrambledPid: scrambledPid,
    scrambledDays: scrambledDays,
    full: plain + embedded,
  };
}

function fmtCode16(code) {
  if (!code || code.length !== 16) return code;
  return code.substring(0, 4) + " " + code.substring(4, 8) + " " + code.substring(8, 12) + " " + code.substring(12, 16);
}

function decryptActivationCode(code) {
  var cleaned = code.replace(/\s/g, "");
  if (cleaned.length !== 16) {
    return { valid: false, reason: "激活码长度无效（需16位）" };
  }

  var scrambledPid = cleaned.substring(0, 4);
  var idHash = cleaned.substring(4, 8);
  var scrambledDays = cleaned.substring(8, 12);
  var embedded = cleaned.substring(12, 16);
  var plain = scrambledPid + idHash + scrambledDays;
  var checksum = generateChecksum4(plain);

  var saltHash = unscramble4(embedded, checksum);
  var perCodeSecret = scramble4(ACTIVATION_SECRET, saltHash);

  var pid = unscramble4(scrambledPid, perCodeSecret);
  var days = parseInt(unscramble4(scrambledDays, perCodeSecret), 10);

  return {
    valid: true,
    productId: pid,
    deviceHash: idHash,
    days: days,
    isPermanent: days === 9999,
    format: "16位",
  };
}

module.exports = {
  sha256,
  pad4,
  scramble4,
  unscramble4,
  ACTIVATION_SECRET,
  deviceIdTo4Digit,
  productIdTo4Digit,
  generateChecksum4,
  generateRedeemCode,
  generateActivationCode,
  encryptV2,
  fmtCode16,
  decryptActivationCode,
};