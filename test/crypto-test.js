const crypto = require("../lib/crypto");

const PRODUCT_IDS = ["prod-001", "prod-002", "my-app", "test-prod", "app-pro", "tool-vip", "game-pass", "cloud-sync"];
const DEVICE_IDS = ["device-abc-123", "sensor-xyz-456", "watch-007", "band-pro-99", "phone-a1b2", "tablet-c3d4"];

var C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", red: "\x1b[31m", magenta: "\x1b[35m", blue: "\x1b[34m" };
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
  var salt = crypto.generateRedeemCode();

  var pidHash = crypto.productIdTo4Digit(productId);
  var devHash = crypto.deviceIdTo4Digit(deviceId);

  var code = crypto.generateActivationCode(productId, deviceId, days, salt);
  var formatted = crypto.fmtCode16(code);
  var result = crypto.decryptActivationCode(code);

  var pidMatch = result.productId === pidHash;
  var devMatch = result.deviceHash === devHash;
  var daysMatch = result.days === days;
  var allMatch = pidMatch && devMatch && daysMatch;

  var pass = green("PASS");
  var fail = red("FAIL");

  var daysLabel = days === 9999 ? " (permanent)" : "";

  console.log(bold("\n--- test group " + groupNum + " ---"));
  console.log(dim("  input:   productId=" + productId + "  deviceId=" + deviceId + "  days=" + days + daysLabel + "  salt=" + salt));
  console.log("");
  console.log("  " + bold(yellow(" encrypted 16-digit:  " + formatted + " ")));
  console.log("  " + bold(cyan(" decrypted            productId=" + result.productId + "  deviceHash=" + result.deviceHash + "  days=" + result.days + daysLabel)));
  console.log("");
  console.log("  " + dim("pid:" + (pidMatch ? pass : fail) + "  dev:" + (devMatch ? pass : fail) + "  days:" + (daysMatch ? pass : fail)) + "  -> " + bold(allMatch ? green("ALL PASS") : red("FAILED")));

  return allMatch;
}

function runCustomTest(code) {
  var cleaned = code.replace(/\s/g, "");
  var formatted = crypto.fmtCode16(cleaned);

  var parts = formatted.split(" ");
  var highlighted = bold(yellow(parts[0] + " " + parts[1] + " " + parts[2] + " " + parts[3]));

  console.log("");
  console.log(bold("  === Activation Code Verification ==="));
  console.log("");

  console.log("  " + bold("Encrypted 16-digit Code:"));
  console.log("  +----------------------+");
  console.log("  |  " + highlighted + "  |");
  console.log("  +----------------------+");
  console.log("");

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

  var scrambledPid = cleaned.substring(0, 4);
  var idHash = cleaned.substring(4, 8);
  var scrambledDays = cleaned.substring(8, 12);
  var embedded = cleaned.substring(12, 16);
  var plain = scrambledPid + idHash + scrambledDays;
  var checksum = crypto.generateChecksum4(plain);
  var saltHash = crypto.unscramble4(embedded, checksum);

  console.log(dim("  Structure:"));
  console.log(dim("    [" + scrambledPid + "] [" + idHash + "] [" + scrambledDays + "] [" + embedded + "]"));
  console.log(dim("    scrambledPid  deviceHash  scrambledDays  embedded(saltHash^checksum)"));
  console.log("");

  console.log("  " + dim("Checksum: " + checksum + "  SaltHash: " + saltHash));

  var perCodeSecret = crypto.scramble4(crypto.ACTIVATION_SECRET, saltHash);
  console.log(dim("  PerCodeSecret: " + perCodeSecret));
  console.log("");

  var unscrambledPid = crypto.unscramble4(scrambledPid, perCodeSecret);
  var unscrambledDays = crypto.unscramble4(scrambledDays, perCodeSecret);
  var days = parseInt(unscrambledDays, 10);

  console.log(dim("  Unscramble (perCodeSecret " + perCodeSecret + "):"));
  console.log(dim("    pid:  " + scrambledPid + " -> " + unscrambledPid));
  console.log(dim("    days: " + scrambledDays + " -> " + unscrambledDays + (days === 9999 ? " (permanent)" : "")));
  console.log("");

  var result = crypto.decryptActivationCode(cleaned);
  console.log("  " + bold("Decrypted Result:"));
  console.log("  +--------------------------------------------+");
  console.log("  |  " + bold(cyan("productId  = " + result.productId)) + "                        |");
  console.log("  |  " + bold(cyan("deviceHash = " + result.deviceHash)) + "                        |");
  console.log("  |  " + bold(cyan("days       = " + result.days + (result.isPermanent ? " (permanent)" : ""))) + "                  |");
  console.log("  |  " + bold(cyan("valid      = " + result.valid)) + "                             |");
  console.log("  +--------------------------------------------+");
  console.log("");

  if (result.valid) {
    console.log("  " + bold(green("=== VERIFICATION PASSED ===")));
  } else {
    console.log("  " + bold(red("=== VERIFICATION FAILED: " + result.reason + " ===")));
  }
  console.log("");

  return result.valid;
}

function runEncryptThenDecrypt(productId, deviceId, days, salt) {
  days = parseInt(days, 10);

  var pidHash = crypto.productIdTo4Digit(productId);
  var devHash = crypto.deviceIdTo4Digit(deviceId);

  var code = crypto.generateActivationCode(productId, deviceId, days, salt);
  var formatted = crypto.fmtCode16(code);

  var result = crypto.decryptActivationCode(code);

  var pidMatch = result.productId === pidHash;
  var devMatch = result.deviceHash === devHash;
  var daysMatch = result.days === days;
  var allMatch = pidMatch && devMatch && daysMatch;

  var daysLabel = result.isPermanent ? " days(permanent)" : " days";

  console.log("");
  console.log("  " + bold("Input:     ") + dim(productId + " | " + deviceId + " | " + days + daysLabel + " | salt=" + salt));
  console.log("");
  console.log("  " + bold("Encrypted: ") + bold(yellow(formatted)));
  console.log("  " + bold("Decrypted: ") + bold(cyan(pidHash + " | " + devHash + " | " + result.days + daysLabel)));
  console.log("");
  console.log("  " + bold(allMatch ? green("  round-trip OK") : red("  round-trip FAIL")));
  console.log("");

  return allMatch;
}

var input = process.argv[2];
var raw = (input || "").replace(/\s/g, "");

if (!raw) {
  console.log("");
  console.log(bold("  Crypto Encrypt/Decrypt Test"));
  console.log(dim("  Secret: " + crypto.ACTIVATION_SECRET));
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

// 16 pure digits -> verify existing activation code
if (raw.length === 16 && /^\d{16}$/.test(raw)) {
  runCustomTest(raw);
  process.exit(0);
}

// Otherwise -> parse as: productId(4) + deviceId(4) + days(4) + salt(rest)
// salt participates in encryption, each unique salt produces unique activation code

var pid = raw.substring(0, 4);
var did = raw.substring(4, 8);
var daysStr = raw.substring(8, 12);
var salt = raw.substring(12) || "0000";
var days = parseInt(daysStr, 10);

console.log("");
console.log(bold("  === Encrypt ==="));
console.log("");

runEncryptThenDecrypt(pid, did, days, salt);