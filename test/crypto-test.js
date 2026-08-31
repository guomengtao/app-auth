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

  console.log(bold("\n--- 测试组 " + groupNum + " ---"));
  console.log(dim("  输入:   产品ID=" + productId + "  设备ID=" + deviceId + "  天数=" + days + (days === 9999 ? " (永久)" : "")));
  console.log("");
  console.log("  " + bold(yellow(" 加密后16位:  " + formatted + " ")));
  console.log("  " + bold(cyan(" 解密后      产品ID=" + result.productId + "  设备哈希=" + result.deviceHash + "  天数=" + result.days + (result.isPermanent ? " (永久)" : ""))));
  console.log("");
  console.log("  " + dim("产品:" + (pidMatch ? pass : fail) + "  设备:" + (devMatch ? pass : fail) + "  天数:" + (daysMatch ? pass : fail)) + "  -> " + bold(allMatch ? green("全部通过") : red("失败")));

  return allMatch;
}

function runCustomTest(code) {
  var cleaned = code.replace(/\s/g, "");
  var formatted = crypto.fmtCode16(cleaned);

  // Highlight the 16-digit code with grouping
  var parts = formatted.split(" ");
  var highlighted = bold(yellow(parts[0] + " " + parts[1] + " " + parts[2] + " " + parts[3]));

  console.log("");
  console.log(bold("  === 激活码验证 ==="));
  console.log("");

  console.log("  " + bold("加密后16位激活码:"));
  console.log("  ┌──────────────────────┐");
  console.log("  │  " + highlighted + "  │");
  console.log("  └──────────────────────┘");
  console.log("");

  if (cleaned.length !== 16) {
    console.log("  " + red("错误: 必须是16位数字, 当前" + cleaned.length + "位"));
    console.log("");
    return false;
  }
  if (!/^\d{16}$/.test(cleaned)) {
    console.log("  " + red("错误: 必须全部是数字"));
    console.log("");
    return false;
  }

  var scrambledPid = cleaned.substring(0, 4);
  var idHash = cleaned.substring(4, 8);
  var scrambledDays = cleaned.substring(8, 12);
  var checksum = cleaned.substring(12, 16);

  console.log(dim("  结构拆解:"));
  console.log(dim("    [" + scrambledPid + "] [" + idHash + "] [" + scrambledDays + "] [" + checksum + "]"));
  console.log(dim("    加密产品ID  设备哈希  加密天数  校验码"));
  console.log("");

  var plain = scrambledPid + idHash + scrambledDays;
  var expectedChecksum = crypto.generateChecksum4(plain);
  var checksumOk = expectedChecksum === checksum;
  console.log("  " + dim("校验码: ") + (checksumOk ? green("通过") + dim("  (" + expectedChecksum + " == " + checksum + ")") : red("失败") + dim("  (计算值 " + expectedChecksum + " != 输入值 " + checksum + ")")));
  console.log("");

  var unscrambledPid = crypto.unscramble4(scrambledPid, crypto.ACTIVATION_SECRET);
  var unscrambledDays = crypto.unscramble4(scrambledDays, crypto.ACTIVATION_SECRET);
  var days = parseInt(unscrambledDays, 10);

  console.log(dim("  解扰 (密钥 " + crypto.ACTIVATION_SECRET + "):"));
  console.log(dim("    产品ID: " + scrambledPid + " -> " + unscrambledPid));
  console.log(dim("    天数:   " + scrambledDays + " -> " + unscrambledDays + (days === 9999 ? " (永久)" : "")));
  console.log("");

  var result = crypto.decryptActivationCode(cleaned);
  console.log("  " + bold("解密结果:"));
  console.log("  ┌────────────────────────────────────────────┐");
  console.log("  │  " + bold(cyan("产品ID   = " + result.productId)) + "                        │");
  console.log("  │  " + bold(cyan("设备哈希 = " + result.deviceHash)) + "                        │");
  console.log("  │  " + bold(cyan("授权天数 = " + result.days + (result.isPermanent ? " (永久)" : ""))) + "                  │");
  console.log("  │  " + bold(cyan("有效性   = " + result.valid)) + "                             │");
  console.log("  └────────────────────────────────────────────┘");
  console.log("");

  if (result.valid) {
    console.log("  " + bold(green("=== 验证通过 ===")));
  } else {
    console.log("  " + bold(red("=== 验证失败: " + result.reason + " ===")));
  }
  console.log("");

  return result.valid;
}

function runEncryptThenDecrypt(productId, deviceId, days) {
  days = parseInt(days, 10);

  var pidHash = crypto.productIdTo4Digit(productId);
  var devHash = crypto.deviceIdTo4Digit(deviceId);

  var code = crypto.generateActivationCode(productId, deviceId, days);
  var formatted = crypto.fmtCode16(code);
  var parts = formatted.split(" ");
  var highlighted = bold(yellow(parts[0] + " " + parts[1] + " " + parts[2] + " " + parts[3]));

  console.log("");
  console.log(bold("  === 加密 -> 解密 往返测试 ==="));
  console.log("");
  console.log(dim("  输入:"));
  console.log(dim("    产品ID  = " + productId + "  -> 哈希: " + pidHash));
  console.log(dim("    设备ID  = " + deviceId + "  -> 哈希: " + devHash));
  console.log(dim("    天数    = " + days + (days === 9999 ? " (永久)" : "")));
  console.log("");

  console.log("  " + bold("加密后16位激活码:"));
  console.log("  ┌──────────────────────┐");
  console.log("  │  " + highlighted + "  │");
  console.log("  └──────────────────────┘");
  console.log("");

  var result = crypto.decryptActivationCode(code);

  var pidMatch = result.productId === pidHash;
  var devMatch = result.deviceHash === devHash;
  var daysMatch = result.days === days;
  var allMatch = pidMatch && devMatch && daysMatch;

  console.log("  " + bold("解密结果 (与原始输入对比):"));
  console.log("  ┌──────────────────────────────────────────────────────┐");
  console.log("  │  " + bold(cyan("产品ID哈希 = " + result.productId)) + "  ← hash(\"" + productId + "\") = " + pidHash + "  " + (pidMatch ? green("✓") : red("✗")) + "  │");
  console.log("  │  " + bold(cyan("设备ID哈希 = " + result.deviceHash)) + "  ← hash(\"" + deviceId + "\") = " + devHash + "  " + (devMatch ? green("✓") : red("✗")) + "  │");
  console.log("  │  " + bold(cyan("授权天数   = " + result.days + (result.isPermanent ? " (永久)" : ""))) + "  ← 原始输入 " + days + "  " + (daysMatch ? green("✓") : red("✗")) + "   │");
  console.log("  └──────────────────────────────────────────────────────┘");
  console.log("");

  console.log("  " + dim("产品:" + (pidMatch ? green("通过") : red("失败")) + "  设备:" + (devMatch ? green("通过") : red("失败")) + "  天数:" + (daysMatch ? green("通过") : red("失败"))));
  console.log("");
  console.log("  " + bold(allMatch ? green("=== 往返测试通过 ===") : red("=== 往返测试失败 ===")));
  console.log("");

  return allMatch;
}

var input = process.argv[2];
var raw = (input || "").replace(/\s/g, "");

if (!raw) {
  console.log("");
  console.log(bold("  加密/解密测试"));
  console.log(dim("  密钥: " + crypto.ACTIVATION_SECRET));
  console.log("");

  var pass1 = runRandomTest(1);
  var pass2 = runRandomTest(2);

  console.log("");
  console.log(bold("  === 总结 ==="));
  console.log("  测试组1: " + (pass1 ? green("通过") : red("失败")) + "   测试组2: " + (pass2 ? green("通过") : red("失败")));
  console.log("  总体:    " + bold(pass1 && pass2 ? green("全部通过") : red("部分失败")));
  console.log("");

  process.exit(pass1 && pass2 ? 0 : 1);
}

// 16 pure digits -> verify existing activation code
if (raw.length === 16 && /^\d{16}$/.test(raw)) {
  runCustomTest(raw);
  process.exit(0);
}

// Otherwise -> parse as: productId(4) + deviceId(4) + days(4) + checksum(4)
// and encrypt

var pid = raw.substring(0, 4);
var did = raw.substring(4, 8);
var daysStr = raw.substring(8, 12);
var userChecksum = raw.substring(12, 16) || "";
var days = parseInt(daysStr, 10);

console.log("");
console.log(bold("  === 加密 ==="));
console.log("");
console.log(dim("  解析输入:"));
console.log(dim("    产品ID  = " + pid));
console.log(dim("    设备ID  = " + did));
console.log(dim("    天数    = " + daysStr + " -> " + days + (days === 9999 ? " (永久)" : "")));
if (userChecksum.length === 4) {
  console.log(dim("    校验码  = " + userChecksum));
}

// Verify checksum if provided
if (userChecksum.length === 4) {
  var pidHash = crypto.productIdTo4Digit(pid);
  var devHash = crypto.deviceIdTo4Digit(did);
  var scrambledPid = crypto.scramble4(pidHash, crypto.ACTIVATION_SECRET);
  var scrambledDays = crypto.scramble4(crypto.pad4(days), crypto.ACTIVATION_SECRET);
  var plain = scrambledPid + devHash + scrambledDays;
  var expectedChecksum = crypto.generateChecksum4(plain);
  console.log("");
  console.log("  " + dim("校验码: 输入=" + userChecksum + "  计算=" + expectedChecksum + "  ") + (userChecksum === expectedChecksum ? green("匹配") : red("不匹配")));
}

runEncryptThenDecrypt(pid, did, days);