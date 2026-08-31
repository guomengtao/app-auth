const crypto = require("../lib/crypto");

const PRODUCT_IDS = ["prod-001", "prod-002", "my-app", "test-prod", "app-pro", "tool-vip", "game-pass", "cloud-sync"];
const DEVICE_IDS = ["device-abc-123", "sensor-xyz-456", "watch-007", "band-pro-99", "phone-a1b2", "tablet-c3d4"];
const SHORT_DEVICE_IDS = ["AAAA", "BBBB", "CCCC", "Xy99", "AbCd", "TeSt", "DeMo", "Aa09", "Bb19"];

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
  var deviceId = randomPick(SHORT_DEVICE_IDS);
  var days = randomPick([7, 30, 90, 99, 60, 14, 1, 98]);
  var salt = crypto.generateRedeemCode();

  var code = crypto.generateActivationCode(productId, deviceId, days, salt);
  var formatted = crypto.fmtCode18(code);
  var result = crypto.decryptActivationCode(code);

  var pidMatch = result.productId === productId;
  var devMatch = result.deviceId === deviceId;
  var daysMatch = result.days === days;
  var redeemMatch = result.redeemCode === salt;
  var allMatch = pidMatch && devMatch && daysMatch && redeemMatch;

  var pass = green("PASS");
  var fail = red("FAIL");

  var daysLabel = days === 99 ? " (permanent)" : "";

  console.log(bold("\n--- test group " + groupNum + " ---"));
  console.log(dim("  input:   productId=" + productId + "  deviceId=" + deviceId + "  days=" + days + daysLabel + "  redeemCode=" + salt));
  console.log("");
  console.log("  " + bold(yellow(" encrypted 18-digit:  " + formatted + " ")));
  console.log("  " + bold(cyan(" decrypted            pid=" + result.productId + "  dev=" + result.deviceId + "  days=" + result.days + "  redeem=" + result.redeemCode)));
  console.log("");
  console.log("  " + dim("pid:" + (pidMatch ? pass : fail) + "  dev:" + (devMatch ? pass : fail) + "  days:" + (daysMatch ? pass : fail) + "  redeem:" + (redeemMatch ? pass : fail)) + "  -> " + bold(allMatch ? green("ALL PASS") : red("FAILED")));

  return allMatch;
}

function runCustomTest(code) {
  var cleaned = code.replace(/\s/g, "");
  var formatted;
  if (cleaned.length === 18) {
    formatted = crypto.fmtCode18(cleaned);
  } else {
    formatted = crypto.fmtCode16(cleaned);
  }

  var parts = formatted.split(" ");
  var highlighted = bold(yellow(parts.join(" ")));

  console.log("");
  console.log(bold("  === Activation Code Verification ==="));
  console.log("");

  console.log("  " + bold("Encrypted Code:"));
  console.log("  +----------------------------+");
  console.log("  |  " + highlighted + "  |");
  console.log("  +----------------------------+");
  console.log("");

  if (cleaned.length !== 16 && cleaned.length !== 18) {
    console.log("  " + red("ERROR: must be 16 or 18 digits, got " + cleaned.length));
    console.log("");
    return false;
  }
  if (!/^\d+$/.test(cleaned)) {
    console.log("  " + red("ERROR: must be all numeric digits"));
    console.log("");
    return false;
  }

  if (cleaned.length === 18) {
    var scrambledDev = cleaned.substring(0, 8);
    var scrambledRedeem = cleaned.substring(8, 15);
    var scrambledIdx = cleaned.substring(15, 17);
    var scrambledDays = cleaned.substring(17, 19);
    var checksumDigit = cleaned.substring(19, 20);

    var first19 = scrambledDev + scrambledRedeem + scrambledIdx + scrambledDays;
    var expectedChecksum = crypto.generateChecksum1(first19);

    console.log(dim("  Structure:"));
    console.log(dim("    [" + scrambledDev + "] [" + scrambledRedeem + "] [" + scrambledIdx + "] [" + scrambledDays + "] [" + checksumDigit + "]"));
    console.log(dim("    scrambledDev(8)  scrambledRedeem(7)  idx(2)  days(2)  checksum(1)"));
    console.log("");

    console.log("  " + dim("Checksum: " + checksumDigit + " (expected " + expectedChecksum + ")"));
    console.log("");

    var redeemEncoded = crypto.unscrambleN(scrambledRedeem, crypto.ACTIVATION_SECRET);
    var redeemCode = crypto.digit7ToRedeemCode(redeemEncoded);
    console.log(dim("  RedeemCode (fixed-key unscramble):"));
    console.log(dim("    " + scrambledRedeem + " -> " + redeemEncoded + " -> " + bold(redeemCode)));
    console.log("");

    var saltHash = crypto.generateChecksum4(redeemCode);
    var perCodeSecret = crypto.scramble4(crypto.ACTIVATION_SECRET, saltHash);
    console.log(dim("  PerCodeSecret: " + perCodeSecret + "  (saltHash=" + saltHash + ")"));
    console.log("");

    var devEncoded = crypto.unscrambleN(scrambledDev, perCodeSecret);
    var deviceId = crypto.decodeDeviceId(devEncoded);
    var productIdx = crypto.unscrambleN(scrambledIdx, perCodeSecret);
    var productId = crypto.indexToProductId(productIdx);
    var days = parseInt(crypto.unscrambleN(scrambledDays, perCodeSecret), 10);

    console.log(dim("  Unscramble (perCodeSecret " + perCodeSecret + "):"));
    console.log(dim("    dev:     " + scrambledDev + " -> " + devEncoded + " -> " + bold(deviceId)));
    console.log(dim("    idx:     " + scrambledIdx + " -> " + productIdx + " -> " + bold(productId)));
    console.log(dim("    days:    " + scrambledDays + " -> " + (days === 99 ? "99 (permanent)" : String(days))));
    console.log("");

    var result = crypto.decryptActivationCode(cleaned);
    console.log("  " + bold("Decrypted Result:"));
    console.log("  +--------------------------------------------------+");
    console.log("  |  " + bold(cyan("productId  = " + result.productId)) + "                          |");
    console.log("  |  " + bold(cyan("deviceId   = " + result.deviceId)) + "                          |");
    console.log("  |  " + bold(cyan("days       = " + result.days + (result.isPermanent ? " (permanent)" : ""))) + "                        |");
    console.log("  |  " + bold(cyan("redeemCode = " + result.redeemCode)) + "                          |");
    console.log("  |  " + bold(cyan("valid      = " + result.valid)) + "                                   |");
    console.log("  +--------------------------------------------------+");
    console.log("");

    if (result.valid) {
      console.log("  " + bold(green("=== VERIFICATION PASSED ===")));
    } else {
      console.log("  " + bold(red("=== VERIFICATION FAILED: " + result.reason + " ===")));
    }
    console.log("");
    return result.valid;
  }

  // 16-digit format
  var scrambledPid = cleaned.substring(0, 4);
  var embedded = cleaned.substring(4, 8);
  var scrambledDays = cleaned.substring(8, 12);
  var scrambledIdHash = cleaned.substring(12, 16);
  var plain = scrambledPid + scrambledIdHash + scrambledDays;
  var checksum = crypto.generateChecksum4(plain);
  var saltHash = crypto.unscramble4(embedded, checksum);

  console.log(dim("  Structure:"));
  console.log(dim("    [" + scrambledPid + "] [" + embedded + "] [" + scrambledDays + "] [" + scrambledIdHash + "]"));
  console.log(dim("    scrambledPid  embedded(checksum)  scrambledDays  scrambledIdHash"));
  console.log("");

  console.log("  " + dim("Checksum: " + checksum + "  SaltHash: " + saltHash));

  var perCodeSecret = crypto.scramble4(crypto.ACTIVATION_SECRET, saltHash);
  console.log(dim("  PerCodeSecret: " + perCodeSecret));
  console.log("");

  var unscrambledPid = crypto.unscramble4(scrambledPid, perCodeSecret);
  var unscrambledIdHash = crypto.unscramble4(scrambledIdHash, perCodeSecret);
  var unscrambledDays = crypto.unscramble4(scrambledDays, perCodeSecret);
  var days = parseInt(unscrambledDays, 10);

  console.log(dim("  Unscramble (perCodeSecret " + perCodeSecret + "):"));
  console.log(dim("    pid:      " + scrambledPid + " -> " + unscrambledPid));
  console.log(dim("    embedded: " + embedded + " (saltHash^checksum)"));
  console.log(dim("    days:     " + scrambledDays + " -> " + unscrambledDays + (days === 9999 ? " (permanent)" : "")));
  console.log(dim("    idHash:   " + scrambledIdHash + " -> " + unscrambledIdHash));
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

  var code = crypto.generateActivationCode(productId, deviceId, days, salt);
  var formatted = crypto.fmtCode18(code);

  var result = crypto.decryptActivationCode(code);

  var pidMatch = result.productId === productId;
  var devMatch = result.deviceId === deviceId;
  var daysMatch = result.days === days;
  var redeemMatch = result.redeemCode === salt;
  var allMatch = pidMatch && devMatch && daysMatch && redeemMatch;

  var daysLabel = result.isPermanent ? " days(permanent)" : " days";

  var check = " " + green("✓");
  var cross = " " + red("✗");

  console.log("");
  console.log("  " + bold("Input:     ") + dim(productId + " | " + deviceId + " | " + days + daysLabel + " | redeemCode=" + salt));
  console.log("");
  console.log("  " + bold("Encrypted: ") + bold(yellow(formatted)));
  console.log("");
  console.log("  " + bold("Decrypt Result:"));
  console.log("    productId:  " + bold(cyan(result.productId)) + (pidMatch ? check : cross + " expect " + productId));
  console.log("    deviceId:   " + bold(cyan(result.deviceId)) + (devMatch ? check : cross + " expect " + deviceId));
  console.log("    days:       " + bold(cyan(String(result.days))) + (daysMatch ? check : cross + " expect " + days));
  console.log("    redeemCode: " + bold(cyan(result.redeemCode)) + (redeemMatch ? check : cross + " expect " + salt));
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

// 18 pure digits -> verify existing activation code
if (raw.length === 18 && /^\d{18}$/.test(raw)) {
  runCustomTest(raw);
  process.exit(0);
}

// 16 pure digits -> verify existing activation code (legacy format)
if (raw.length === 16 && /^\d{16}$/.test(raw)) {
  runCustomTest(raw);
  process.exit(0);
}

// Otherwise -> parse as: productId(4) + deviceId(4) + days(4) + salt(rest)
var pid = raw.substring(0, 4);
var did = raw.substring(4, 8);
var daysStr = raw.substring(8, 12);
var salt = raw.substring(12) || "0000";
var days = parseInt(daysStr, 10);

console.log("");
console.log(bold("  === Encrypt ==="));
console.log("");

runEncryptThenDecrypt(pid, did, days, salt);