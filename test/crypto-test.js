const crypto = require("../lib/crypto");

const PRODUCT_IDS = ["prod-001", "prod-002", "my-app", "test-prod", "app-pro", "tool-vip", "game-pass", "cloud-sync"];
const DEVICE_IDS = ["device-abc-123", "sensor-xyz-456", "watch-007", "band-pro-99", "phone-a1b2", "tablet-c3d4"];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

function runRandomTest(groupNum) {
  var productId = randomPick(PRODUCT_IDS);
  var deviceId = randomPick(DEVICE_IDS);
  var days = randomPick([7, 30, 90, 180, 365, 9999]);

  var pidHash = crypto.productIdTo4Digit(productId);
  var devHash = crypto.deviceIdTo4Digit(deviceId);

  var code = crypto.generateActivationCode(productId, deviceId, days);
  var formatted = crypto.fmtCode16(code);

  var result = crypto.decryptActivationCode(code);

  var pidMatch = result.productId === pidHash;
  var devMatch = result.deviceHash === devHash;
  var daysMatch = result.days === days;
  var allMatch = pidMatch && devMatch && daysMatch;

  console.log("═══════════════════════════════════════");
  console.log("  Test Group " + groupNum);
  console.log("═══════════════════════════════════════");
  console.log("");
  console.log("  Input:");
  console.log("    productId  = " + productId + "  -> hash: " + pidHash);
  console.log("    deviceId   = " + deviceId + "  -> hash: " + devHash);
  console.log("    days       = " + days + (days === 9999 ? " (permanent)" : ""));
  console.log("");
  console.log("  Generated Activation Code:");
  console.log("    " + formatted);
  console.log("");
  console.log("  Decrypted:");
  console.log("    productId  = " + result.productId);
  console.log("    deviceHash = " + result.deviceHash);
  console.log("    days       = " + result.days + (result.isPermanent ? " (permanent)" : ""));
  console.log("    valid      = " + result.valid);
  console.log("");
  console.log("  Verification:");
  console.log("    productId  match: " + (pidMatch ? "PASS" : "FAIL"));
  console.log("    deviceHash match: " + (devMatch ? "PASS" : "FAIL"));
  console.log("    days       match: " + (daysMatch ? "PASS" : "FAIL"));
  console.log("");
  console.log("  Result: " + (allMatch ? "ALL PASS" : "SOME FAILED"));
  console.log("");

  return allMatch;
}

function runCustomTest(code) {
  var cleaned = code.replace(/\s/g, "");

  console.log("═══════════════════════════════════════");
  console.log("  Custom Code Verification");
  console.log("═══════════════════════════════════════");
  console.log("");
  console.log("  Raw Input:    " + code);
  console.log("  Cleaned:      " + cleaned);
  console.log("  Length:       " + cleaned.length + (cleaned.length === 16 ? " (valid)" : " (invalid, expected 16)"));
  console.log("  All Digits:   " + (/^\d{16}$/.test(cleaned) ? "yes" : "no"));
  console.log("");

  if (cleaned.length !== 16) {
    console.log("  Result: FAIL - must be 16 digits");
    console.log("");
    return false;
  }

  if (!/^\d{16}$/.test(cleaned)) {
    console.log("  Result: FAIL - must be all digits");
    console.log("");
    return false;
  }

  var scrambledPid = cleaned.substring(0, 4);
  var idHash = cleaned.substring(4, 8);
  var scrambledDays = cleaned.substring(8, 12);
  var checksum = cleaned.substring(12, 16);

  console.log("  Structure:");
  console.log("    scrambledPid  = " + scrambledPid + "  (positions 1-4)");
  console.log("    deviceHash    = " + idHash + "  (positions 5-8)");
  console.log("    scrambledDays = " + scrambledDays + "  (positions 9-12)");
  console.log("    checksum      = " + checksum + "  (positions 13-16)");
  console.log("");

  var plain = scrambledPid + idHash + scrambledDays;
  var expectedChecksum = crypto.generateChecksum4(plain);
  console.log("  Checksum Check:");
  console.log("    computed = " + expectedChecksum);
  console.log("    provided = " + checksum);
  console.log("    match    = " + (expectedChecksum === checksum ? "PASS" : "FAIL"));
  console.log("");

  var unscrambledPid = crypto.unscramble4(scrambledPid, crypto.ACTIVATION_SECRET);
  var unscrambledDays = crypto.unscramble4(scrambledDays, crypto.ACTIVATION_SECRET);
  var days = parseInt(unscrambledDays, 10);

  console.log("  Unscrambling (secret: " + crypto.ACTIVATION_SECRET + "):");
  console.log("    productId:  " + scrambledPid + " -> " + unscrambledPid);
  console.log("    days:       " + scrambledDays + " -> " + unscrambledDays + (days === 9999 ? " (permanent)" : ""));
  console.log("");

  var result = crypto.decryptActivationCode(cleaned);
  console.log("  Full Decrypt Result:");
  console.log("    valid       = " + result.valid);
  console.log("    productId   = " + result.productId);
  console.log("    deviceHash  = " + result.deviceHash);
  console.log("    days        = " + result.days + (result.isPermanent ? " (permanent)" : ""));
  console.log("    format      = " + result.format);
  console.log("");

  if (result.valid) {
    console.log("  Result: PASS - valid activation code");
  } else {
    console.log("  Result: FAIL - " + result.reason);
  }
  console.log("");

  return result.valid;
}

var customCode = process.argv[2];

console.log("");
console.log("  Crypto Encrypt/Decrypt Test");
console.log("  Secret Key: " + crypto.ACTIVATION_SECRET);
console.log("");

if (customCode) {
  runCustomTest(customCode);
} else {
  console.log("  Usage: node test/crypto-test.js [16-digit-code]");
  console.log("  No code provided, running 2 random tests...");
  console.log("");

  var pass1 = runRandomTest(1);
  var pass2 = runRandomTest(2);

  console.log("═══════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════");
  console.log("  Group 1: " + (pass1 ? "PASS" : "FAIL"));
  console.log("  Group 2: " + (pass2 ? "PASS" : "FAIL"));
  console.log("  Overall: " + (pass1 && pass2 ? "ALL PASS" : "SOME FAILED"));
  console.log("");

  process.exit(pass1 && pass2 ? 0 : 1);
}