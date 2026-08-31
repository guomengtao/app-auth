var crypto = require("crypto");

var GLOBAL_SALT = "k3f9x";
var CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
}

function pad2(n) {
  var s = String(n);
  while (s.length < 2) { s = "0" + s; }
  return s;
}

function pad4(n) {
  var s = String(n);
  while (s.length < 4) { s = "0" + s; }
  return s;
}

function getProductSalt(productId) {
  return hmacSha256(GLOBAL_SALT, productId).substring(0, 5);
}

function computeChecksum(code18, productSalt) {
  var hex = hmacSha256(productSalt, code18).substring(0, 2);
  return pad2(parseInt(hex, 16) % 100);
}

var B36 = BigInt(36);
var B10 = BigInt(10);
var B62 = BigInt(62);

var B36_4 = B36 ** BigInt(4);
var B10_2 = B10 ** BigInt(2);
var B62_4 = B62 ** BigInt(4);

var B10_2_B62_4 = B10_2 * B62_4;
var B36_4_B10_2_B62_4 = B36_4 * B10_2 * B62_4;

function charToBase36(c) {
  var code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 65 + 10;
  return -1;
}

function base36ToChar(n) {
  if (n >= 0 && n <= 9) return String.fromCharCode(48 + n);
  if (n >= 10 && n <= 35) return String.fromCharCode(65 + n - 10);
  return "?";
}

function base36ToBigInt(s) {
  var result = BigInt(0);
  for (var i = 0; i < s.length; i++) {
    result = result * B36 + BigInt(charToBase36(s[i]));
  }
  return result;
}

function bigIntToBase36(num, len) {
  var result = "";
  var n = num;
  for (var i = 0; i < len; i++) {
    result = base36ToChar(Number(n % B36)) + result;
    n = n / B36;
  }
  return result;
}

function charToBase62(c) {
  var code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 65 + 10;
  if (code >= 97 && code <= 122) return code - 97 + 36;
  return -1;
}

function base62ToChar(n) {
  if (n >= 0 && n <= 9) return String.fromCharCode(48 + n);
  if (n >= 10 && n <= 35) return String.fromCharCode(65 + n - 10);
  if (n >= 36 && n <= 61) return String.fromCharCode(97 + n - 36);
  return "?";
}

function base62ToBigInt(s) {
  var result = BigInt(0);
  for (var i = 0; i < s.length; i++) {
    result = result * B62 + BigInt(charToBase62(s[i]));
  }
  return result;
}

function bigIntToBase62(num, len) {
  var result = "";
  var n = num;
  for (var i = 0; i < len; i++) {
    result = base62ToChar(Number(n % B62)) + result;
    n = n / B62;
  }
  return result;
}

function encode(input) {
  var g1 = input.substring(0, 2);
  var g2 = input.substring(2, 6);
  var g3 = input.substring(6, 8);
  var g4 = input.substring(8, 12);

  var n1 = BigInt(parseInt(g1, 10));
  var n2 = base36ToBigInt(g2);
  var n3 = BigInt(parseInt(g3, 10));
  var n4 = base62ToBigInt(g4);

  var combined = n1 * B36_4_B10_2_B62_4 + n2 * B10_2_B62_4 + n3 * B62_4 + n4;
  var code18 = combined.toString().padStart(18, "0");

  return code18;
}

function decode(code) {
  var total = BigInt(code);

  var n4 = total % B62_4;
  var rem = total / B62_4;

  var n3 = rem % B10_2;
  rem = rem / B10_2;

  var n2 = rem % B36_4;
  var n1 = rem / B36_4;

  var g1 = n1.toString().padStart(2, "0");
  var g2 = bigIntToBase36(n2, 4);
  var g3 = n3.toString().padStart(2, "0");
  var g4 = bigIntToBase62(n4, 4);

  return {
    input: g1 + g2 + g3 + g4,
    productId: g1,
    checkCode: g2,
    months: g3,
    deviceId: g4,
    valid: true,
  };
}

function generateRedeemCode() {
  var code = "";
  for (var i = 0; i < 4; i++) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return code;
}

function generateActivationCode(productId, deviceId, months, redeemCode) {
  var input = pad2(productId) + redeemCode + pad2(months) + deviceId;
  return encode(input);
}

function decryptActivationCode(code) {
  var cleaned = String(code).replace(/\s/g, "");

  if (cleaned.length !== 18 || !/^\d{18}$/.test(cleaned)) {
    return { valid: false, reason: "Activation code must be 18 pure digits" };
  }

  var result = decode(cleaned);

  return {
    valid: result.valid,
    productId: result.productId,
    checkCode: result.checkCode,
    months: parseInt(result.months, 10),
    deviceId: result.deviceId,
    format: "18-digit",
  };
}

function fmtCode18(code) {
  if (!code || code.length !== 18) return code;
  return code.substring(0, 6) + " " + code.substring(6, 12) + " " + code.substring(12, 18);
}

module.exports = {
  GLOBAL_SALT,
  CHARSET,
  sha256,
  hmacSha256,
  pad2,
  pad4,
  getProductSalt,
  computeChecksum,
  encode,
  decode,
  generateRedeemCode,
  generateActivationCode,
  decryptActivationCode,
  fmtCode18,
  charToBase36,
  base36ToChar,
  base36ToBigInt,
  bigIntToBase36,
  charToBase62,
  base62ToChar,
  base62ToBigInt,
  bigIntToBase62,
};