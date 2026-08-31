const crypto = require("../lib/crypto");

const PRODUCT_IDS = ["prod-001", "prod-002", "my-app", "test-prod", "app-pro", "tool-vip", "game-pass", "cloud-sync"];
const DEVICE_IDS = ["device-abc-123", "sensor-xyz-456", "watch-007", "band-pro-99", "phone-a1b2", "tablet-c3d4"];

// ANSI color codes
const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", red: "\x1b[31m", magenta: "\x1b[35m", blue: "\x1b[34m" };
function color(c, s) { return c + s + C.reset; }
function green(s) { return color(C.green, s); }
function yellow(s) { return color(C.yellow, s); }
function cyan(s) { return color(C.cyan, s); }
function red(s) { return color(C.red, s); }
function bold(s) { return color(C.bold, s); }
function dim(s) { return color(C.dim, s); }
function magenta(s) { return color(C.magenta, s); }

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

  var pass = green("PASS");
  var fail = red("FAIL");

  console.log(bold("\n--- Test Group " + groupNum + " ---"));
  console.log(dim("  Input:   productId=" + productId + "  deviceId=" + deviceId + "  days=" + days + (days === 9999 ? " (permanent)" : "")));
  console.log("");
  console.log("  " + bold(yellow(" Encrypted 16-digit:  " + formatted + " ")));
  console.log("  " + bold(cyan(" Decrypted            productId=" + result.productId + "  deviceHash=" + result.deviceHash + "  days=" + result.days + (result.isPermanent ? " (permanent)" : ""))));
  console.log("");
  console.log("  " + dim("pid:" + (pidMatch ? pass : fail) + "  dev:" + (devMatch ? pass : fail) + "  days:" + (daysMatch ? pass : fail)) + "  -> " + bold(allMatch ? green("ALL PASS") : red("FAILED")));

  return allMatch;
}

function runCustomTest(code) {
  var cleaned = code.replace(/\s/g, "");
  var formatted = crypto.fmtCode16(cleaned);

  // Highlight the 16-digit code with grouping
  var parts = formatted.split(" ");
  var highlighted = bold(yellow(parts[0] + " " + parts[1] + " " + parts[2] + " " + parts[3]));

  console.log("");
  console.log(bold("  === Activation Code Verification ==="));
  console.log("");

  // --- ENCRYPTED 16-DIGIT CODE (prominent) ---
  console.log("  " + bold("Encrypted 16-digit Code:"));
  console.log("  ┌──────────────────────┐");
  console.log("  │  " + highlighted + "  │");
  console.log("  └──────────────────────┘");
  console.log("");

  // Validate format
  if (cleaned.length !== 16) {
    console.log("  " + red("ERROR: must be exactly 16 digits, got " + cleaned.length));
    console.log("");
    return false;
  }
  if (!/^\d{16}$/.test(cleaned)) {
    console.log("  " + red("ERROR: must be all numeric digits"));
    console.log("");
    return false;
  }

  // Structure breakdown
  var scrambledPid = cleaned.substring(0, 4);
  var idHash = cleaned.substring(4, 8);
  var scrambledDays = cleaned.substring(8, 12);
  var checksum = cleaned.substring(12, 16);

  console.log(dim("  Structure:"));
  console.log(dim("    [" + scrambledPid + "] [" + idHash + "] [" + scrambledDays + "] [" + checksum + "]"));
  console.log(dim("    scrambledPid  deviceHash  scrambledDays  checksum"));
  console.log("");

  // Checksum
  var plain = scrambledPid + idHash + scrambledDays;
  var expectedChecksum = crypto.generateChecksum4(plain);
  var checksumOk = expectedChecksum === checksum;
  console.log("  " + dim("Checksum: ") + (checksumOk ? green("PASS") + dim("  (" + expectedChecksum + " == " + checksum + ")") : red("FAIL") + dim("  (computed " + expectedChecksum + " != got " + checksum + ")")));
  console.log("");

  // Unscramble
  var unscrambledPid = crypto.unscramble4(scrambledPid, crypto.ACTIVATION_SECRET);
  var unscrambledDays = crypto.unscramble4(scrambledDays, crypto.ACTIVATION_SECRET);
  var days = parseInt(unscrambledDays, 10);

  console.log(dim("  Unscramble (secret " + crypto.ACTIVATION_SECRET + "):"));
  console.log(dim("    pid:  " + scrambledPid + " -> " + unscrambledPid));
  console.log(dim("    days: " + scrambledDays + " -> " + unscrambledDays + (days === 9999 ? " (permanent)" : "")));
  console.log("");

  // --- DECRYPTED RESULT (prominent, in cyan) ---
  var result = crypto.decryptActivationCode(cleaned);
  console.log("  " + bold("Decrypted Result:"));
  console.log("  ┌────────────────────────────────────────────┐");
  console.log("  │  " + bold(cyan("productId  = " + result.productId)) + "                        │");
  console.log("  │  " + bold(cyan("deviceHash = " + result.deviceHash)) + "                        │");
  console.log("  │  " + bold(cyan("days       = " + result.days + (result.isPermanent ? " (permanent)" : ""))) + "                  │");
  console.log("  │  " + bold(cyan("valid      = " + result.valid)) + "                             │");
  console.log("  └────────────────────────────────────────────┘");
  console.log("");

  if (result.valid) {
    console.log("  " + bold(green("=== VERIFICATION PASSED ===")));
  } else {
    console.log("  " + bold(red("=== VERIFICATION FAILED: " + result.reason + " ===")));
  }
  console.log("");

  return result.valid;
}

var customCode = process.argv[2];

if (customCode) {
  runCustomTest(customCode);
} else {
  console.log("");
  console.log(bold("  Crypto Encrypt/Decrypt Test"));
  console.log(dim("  Secret: " + crypto.ACTIVATION_SECRET + "  |  Usage: node test/crypto-test.js [16-digit-code]"));
  console.log("");

  var pass1 = runRandomTest(1);
  var pass2 = runRandomTest(2);

  console.log("");
  console.log(bold("  === Summary ==="));
  console.log("  Group 1: " + (pass1 ? green("PASS") : red("FAIL")) + "   Group 2: " + (pass2 ? green("PASS") : red("FAIL")));
  console.log("  Overall:  " + bold(pass1 && pass2 ? green("ALL PASS") : red("SOME FAILED")));
  console.log("");

  process.exit(pass1 && pass2 ? 0 : 1);
}