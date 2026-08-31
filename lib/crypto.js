var crypto = require("crypto");

var GLOBAL_SALT = "k3f9x";
var CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
var DEVICE_BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
}

function pad2(n) {
  var num = parseInt(n, 10);
  if (!Number.isFinite(num) || num < 0) num = 0;
  num = num % 100;
  var s = String(num);
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
  var i = DEVICE_BASE62.indexOf(c);
  return i >= 0 ? i : 0;
}

function normalizeDeviceIdSegment(deviceId) {
  var s = String(deviceId || "");
  var base = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      base += s[i];
    }
  }
  if (base.length === 0) base = "0000";
  var last4 = base.substring(base.length - 4);
  while (last4.length < 4) {
    last4 = "0" + last4;
  }
  return last4;
}

function base62ToChar(n) {
  if (n >= 0 && n < DEVICE_BASE62.length) return DEVICE_BASE62[n];
  return "?";
}

function base62ToBigInt(s) {
  var result = BigInt(0);
  for (var i = 0; i < s.length; i++) {
    var idx = DEVICE_BASE62.indexOf(s[i]);
    result = result * B62 + BigInt(idx < 0 ? 0 : idx);
  }
  return result;
}

function bigIntToBase62(num, len) {
  var result = "";
  var n = num;
  for (var i = 0; i < len; i++) {
    result = DEVICE_BASE62[Number(n % B62)] + result;
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
  var safeDevice = normalizeDeviceIdSegment(deviceId);
  var code = String(redeemCode || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    throw new Error("Invalid redeem code for activation encoding");
  }
  var input = pad2(productId) + code + pad2(months) + safeDevice;
  if (input.length !== 12) {
    throw new Error("Invalid activation input length: " + input.length);
  }
  if (!/^\d{2}[A-Z0-9]{4}\d{2}[A-Za-z0-9]{4}$/.test(input)) {
    throw new Error("Invalid activation input format");
  }
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
  DEVICE_BASE62,
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
  normalizeDeviceIdSegment,
  charToBase36,
  base36ToChar,
  base36ToBigInt,
  bigIntToBase36,
  charToBase62,
  base62ToChar,
  base62ToBigInt,
  bigIntToBase62,
};

if (require.main === module) {
  (function () {
    var C = {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      cyan: "\x1b[36m",
      red: "\x1b[31m",
    };
    function color(c, s) { return c + s + C.reset; }
    function green(s) { return color(C.green, s); }
    function yellow(s) { return color(C.yellow, s); }
    function cyan(s) { return color(C.cyan, s); }
    function red(s) { return color(C.red, s); }
    function bold(s) { return color(C.bold, s); }
    function dim(s) { return color(C.dim, s); }

    function showUsage() {
      console.log("");
      console.log(bold("  Crypto CLI - Encode/Decode 18-digit activation codes"));
      console.log("");
      console.log("  " + bold("USAGE:"));
      console.log("    node lib/crypto.js <input>");
      console.log("");
      console.log("  " + bold("INPUT FORMATS:"));
      console.log("    12 characters  -> encode to 18-digit activation code");
      console.log("                       format: PPCCCCMMDDDD");
      console.log("                       PP=产品ID(2位数字)");
      console.log("                       CCCC=兑换码(4位大写字母/数字)");
      console.log("                       MM=月份(2位数字, 99=永久)");
      console.log("                       DDDD=设备ID(4位大小写字母/数字)");
      console.log("    18 digits      -> decode activation code");
      console.log("");
      console.log("  " + bold("EXAMPLES:"));
      console.log("    " + dim("$ node lib/crypto.js 011BZR01c786"));
      console.log("    " + dim("$ node lib/crypto.js 002573764392844210"));
      console.log("");
    }

    function printEncodeResult(input, encoded) {
      var g1 = input.substring(0, 2);
      var g2 = input.substring(2, 6);
      var g3 = input.substring(6, 8);
      var g4 = input.substring(8, 12);
      var months = parseInt(g3, 10);
      var monthsText = months === 99 ? " (永久)" : "";
      console.log("");
      console.log(bold("  === Encode: 12 char -> 18 digit ==="));
      console.log("");
      console.log("  " + bold("Input:"));
      console.log("    " + dim("[" + g1 + "] [" + g2 + "] [" + g3 + "] [" + g4 + "]"));
      console.log("    " + dim("产品ID(2) 兑换码(4) 月数(2) 设备(4)"));
      console.log("       pid:" + g1 + " redeem:" + g2 + " months:" + months + monthsText + " device:" + g4);
      console.log("");
      console.log("  " + bold("18-digit activation code: ") + bold(yellow(fmtCode18(encoded))));
      console.log("  " + bold("Compact (no space):       ") + bold(yellow(encoded)));
      console.log("");
      var roundTrip = decryptActivationCode(encoded);
      var rtInput = roundTrip.productId + roundTrip.checkCode + pad2(roundTrip.months) + roundTrip.deviceId;
      var passed = rtInput === input && roundTrip.valid;
      console.log(bold("  " + (passed ? green("Round-trip PASS (decode还原一致)") : red("Round-trip FAIL (decode还原不一致)"))));
      console.log("");
    }

    function printDecodeResult(code, result) {
      var monthsText = result.months === 99 ? "永久" : result.months + " 个月";
      console.log("");
      console.log(bold("  === Decode: 18 digit -> 12 char ==="));
      console.log("");
      console.log("  " + bold("Input 激活码: ") + bold(yellow(fmtCode18(code))));
      console.log("");
      console.log("  " + bold("Decrypted:"));
      console.log("    " + dim("[" + result.productId + "] [" + result.checkCode + "] [" + pad2(result.months) + "] [" + result.deviceId + "]"));
      console.log("    " + dim("产品ID(2) 兑换码(4) 月数(2) 设备(4)"));
      console.log("");
      console.log("  产品 ID      : " + bold(cyan(result.productId)));
      console.log("  兑换码        : " + bold(cyan(result.checkCode)));
      console.log("  有效期(月)   : " + bold(cyan(String(result.months))) + dim("  (" + monthsText + ")"));
      console.log("  设备 ID      : " + bold(cyan(result.deviceId)));
      console.log("  12-char 原始 : " + bold(cyan(result.productId + result.checkCode + pad2(result.months) + result.deviceId)));
      console.log("");
    }

    var input = process.argv[2];
    if (!input) { showUsage(); process.exit(0); }
    var raw = String(input).replace(/\s/g, "");

    if (raw.length === 12) {
      var g1 = raw.substring(0, 2);
      var g2 = raw.substring(2, 6);
      var g3 = raw.substring(6, 8);
      var g4 = raw.substring(8, 12);
      if (!/^\d{2}$/.test(g1)) {
        console.log("  " + red("Validation Error:") + " 产品ID(1-2位)必须是2位纯数字, got: " + g1);
        process.exit(1);
      }
      if (!/^[A-Z0-9]{4}$/.test(g2)) {
        console.log("  " + red("Validation Error:") + " 兑换码(3-6位)必须是4位大写字母/数字(A-Z 0-9), got: " + g2);
        process.exit(1);
      }
      if (!/^\d{2}$/.test(g3)) {
        console.log("  " + red("Validation Error:") + " 月数(7-8位)必须是2位纯数字, got: " + g3);
        process.exit(1);
      }
      if (!/^[A-Za-z0-9]{4}$/.test(g4)) {
        console.log("  " + red("Validation Error:") + " 设备ID(9-12位)必须是4位字母/数字(A-Z a-z 0-9), got: " + g4);
        process.exit(1);
      }
      try {
        var encoded = generateActivationCode(g1, g4, parseInt(g3, 10), g2);
        printEncodeResult(raw, encoded);
      } catch (e) {
        console.log("  " + red("Encode Error: ") + (e.message || String(e)));
        process.exit(1);
      }
    } else if (raw.length === 18 && /^\d{18}$/.test(raw)) {
      var result = decryptActivationCode(raw);
      if (!result.valid) {
        console.log("  " + red("Decode Error: ") + (result.reason || "Invalid activation code"));
        process.exit(1);
      }
      printDecodeResult(raw, result);
    } else {
      console.log("  " + red("Error:") + " 输入格式不对，期望 12 字符(加密) 或 18 位数字(解密)，实际 " + raw.length + " 字符");
      showUsage();
      process.exit(1);
    }
  })();
}