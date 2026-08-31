const crypto = require("../lib/crypto");

const PRODUCT_IDS = ["prod-001", "prod-002", "my-app", "test-prod", "app-pro", "tool-vip", "game-pass", "cloud-sync"];
const DEVICE_IDS = ["device-abc-123", "sensor-xyz-456", "watch-007", "band-pro-99", "phone-a1b2", "tablet-c3d4"];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

function runTest(groupNum) {
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

console.log("");
console.log("  Crypto Encrypt/Decrypt Round-Trip Test");
console.log("  Secret Key: " + crypto.ACTIVATION_SECRET);
console.log("");

var pass1 = runTest(1);
var pass2 = runTest(2);

console.log("═══════════════════════════════════════");
console.log("  Summary");
console.log("═══════════════════════════════════════");
console.log("  Group 1: " + (pass1 ? "PASS" : "FAIL"));
console.log("  Group 2: " + (pass2 ? "PASS" : "FAIL"));
console.log("  Overall: " + (pass1 && pass2 ? "ALL PASS" : "SOME FAILED"));
console.log("");

process.exit(pass1 && pass2 ? 0 : 1);