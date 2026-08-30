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

function generateActivationCode(productId, deviceId) {
  var idHash = deviceIdTo4Digit(deviceId);
  var plain = productId + idHash;
  var checksum = generateChecksum4(plain);
  return plain + checksum;
}

function encryptV2(deviceId, productId, days) {
  var idHash = deviceIdTo4Digit(deviceId);
  var daysPart = pad4(days);
  var plain = productId + idHash + daysPart;
  var checksum = generateChecksum4(plain);
  return {
    productId: productId,
    idHash: idHash,
    daysPart: daysPart,
    checksum: checksum,
    full: plain + checksum,
  };
}

function fmtCode12(code) {
  if (!code || code.length !== 12) return code;
  return code.substring(0, 4) + " " + code.substring(4, 8) + " " + code.substring(8, 12);
}

module.exports = {
  sha256,
  pad4,
  deviceIdTo4Digit,
  generateChecksum4,
  generateRedeemCode,
  generateActivationCode,
  encryptV2,
  fmtCode12,
};