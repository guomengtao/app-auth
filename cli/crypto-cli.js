#!/usr/bin/env node

var crypto = require("crypto");

var GLOBAL_SALT = "k3f9x";

var C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function color(c, s) {
  return c + s + C.reset;
}

function green(s) {
  return color(C.green, s);
}

function yellow(s) {
  return color(C.yellow, s);
}

function cyan(s) {
  return color(C.cyan, s);
}

function red(s) {
  return color(C.red, s);
}

function bold(s) {
  return color(C.bold, s);
}

function dim(s) {
  return color(C.dim, s);
}

function pad2(n) {
  var s = String(n);
  while (s.length < 2) { s = "0" + s; }
  return s;
}

function hmacSha256(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
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

  var productSalt = getProductSalt(g1);
  var checksum = computeChecksum(code18, productSalt);

  return code18 + checksum;
}

function decode(code) {
  var code18 = code.substring(0, 18);
  var checksum = code.substring(18, 20);

  var total = BigInt(code18);

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

  var productSalt = getProductSalt(g1);
  var expectedChecksum = computeChecksum(code18, productSalt);

  return {
    input: g1 + g2 + g3 + g4,
    g1: g1,
    g2: g2,
    g3: g3,
    g4: g4,
    productSalt: productSalt,
    checksum: checksum,
    expectedChecksum: expectedChecksum,
    valid: checksum === expectedChecksum,
  };
}

function validate12(input) {
  if (input.length !== 12) {
    return "Input must be exactly 12 characters, got " + input.length;
  }
  var g1 = input.substring(0, 2);
  var g2 = input.substring(2, 6);
  var g3 = input.substring(6, 8);
  var g4 = input.substring(8, 12);

  if (!/^\d{2}$/.test(g1)) {
    return "Group 1 (positions 1-2) must be 2 digits (0-9), got: " + g1;
  }
  if (!/^[A-Z0-9]{4}$/.test(g2)) {
    return "Group 2 (positions 3-6) must be 4 uppercase letters or digits (A-Z, 0-9), got: " + g2;
  }
  if (!/^\d{2}$/.test(g3)) {
    return "Group 3 (positions 7-8) must be 2 digits (0-9), got: " + g3;
  }
  if (!/^[A-Za-z0-9]{4}$/.test(g4)) {
    return "Group 4 (positions 9-12) must be 4 letters or digits (A-Z, a-z, 0-9), got: " + g4;
  }
  return null;
}

function validate18(input) {
  if (input.length !== 18) {
    return "Code must be exactly 18 digits, got " + input.length;
  }
  if (!/^\d{18}$/.test(input)) {
    return "Code must be 18 pure digits (0-9)";
  }
  return null;
}

function showUsage() {
  console.log("");
  console.log(bold("  Crypto CLI - Encode/Decode (CRYPTO_SPEC.md)"));
  console.log("");
  console.log("  " + bold("USAGE:"));
  console.log("    node test/crypto.js <input>");
  console.log("    node cli/crypto-cli.js <input>");
  console.log("");
  console.log("  " + bold("INPUT FORMATS:"));
  console.log("    12 characters  →  encode to 18-digit code");
    console.log("    18 digits      →  decode to 12-character original");
  console.log("");
  console.log("  " + bold("12-CHAR STRUCTURE:"));
  console.log("    " + dim("Group 1:  2 digits              (0-9)           product ID"));
  console.log("    " + dim("Group 2:  4 uppercase+digits     (A-Z, 0-9)      check code"));
  console.log("    " + dim("Group 3:  2 digits              (0-9)           months"));
  console.log("    " + dim("Group 4:  4 mixed-case+digits   (A-Z, a-z, 0-9) device ID"));
  console.log("");
  console.log("  " + bold("SECURITY:"));
  console.log("    " + dim("Global salt: " + GLOBAL_SALT));
  console.log("    " + dim("Product salt = HMAC(global_salt, product_id).first5"));
  console.log("    " + dim("Checksum = HMAC(product_salt, code18).first2hex % 100"));
  console.log("");
  console.log("  " + bold("EXAMPLES:"));
  console.log("    " + dim("$ node test/crypto.js 98ASDF39aA4D"));
  console.log("    " + dim("$ node test/crypto.js 000000000000000000"));
  console.log("");
}

function printEncodeResult(input, encoded) {
  var g1 = input.substring(0, 2);
  var g2 = input.substring(2, 6);
  var g3 = input.substring(6, 8);
  var g4 = input.substring(8, 12);

  console.log("");
  console.log(bold("  === Encode: 12-char → 18-digit ==="));
  console.log("");
  console.log("  " + bold("Input:"));
  console.log("    " + dim("[" + g1 + "] [" + g2 + "] [" + g3 + "] [" + g4 + "]"));
  console.log("    " + dim(" pid(2)   check(4)   months(2)  dev(4)"));
  console.log("");
  console.log("  " + bold("Encrypted: ") + bold(yellow(encoded)));
  console.log("");
}

function printDecodeResult(code, result) {
  console.log("");
  console.log(bold("  === Decode: 18-digit → 12-char ==="));
  console.log("");
  console.log("  " + bold("Input (18 digits):"));
  console.log("    " + bold(yellow(code)));
  console.log("");
  console.log("  " + bold("Decrypted:"));
  console.log("    " + dim("[" + result.productId + "] [" + result.checkCode + "] [" + result.months + "] [" + result.deviceId + "]"));
  console.log("    " + dim(" pid(2)   check(4)   months(2)  dev(4)"));
  console.log("");
  console.log("  " + bold("Decrypted: ") + bold(cyan(result.input)));
  console.log("");
}

var input = process.argv[2];
if (!input) {
  showUsage();
  process.exit(0);
}

var raw = input.replace(/\s/g, "");

if (raw.length === 12) {
  var err = validate12(raw);
  if (err) {
    console.log("");
    console.log("  " + red("Validation Error: ") + err);
    console.log("");
    process.exit(1);
  }

  var encoded = encode(raw);
  printEncodeResult(raw, encoded);

  var decoded = decode(encoded);
  console.log(bold("  " + (decoded.input === raw ? green("Compare OK") : red("Compare FAIL"))));
  console.log("");

} else if (raw.length === 18 && /^\d{18}$/.test(raw)) {
  var result = decode(raw);
  printDecodeResult(raw, result);
} else {
  console.log("");
  console.log("  " + red("Error: Invalid input format."));
  console.log("  " + dim("Expected 12 characters (encode) or 18 digits (decode), got " + raw.length + " characters."));
  console.log("");
  showUsage();
  process.exit(1);
}