var crypto = require("../lib/crypto");

var B36 = BigInt(36);
var B10 = BigInt(10);
var B62 = BigInt(62);
var B36_4 = B36 ** BigInt(4);
var B10_2 = B10 ** BigInt(2);
var B62_4 = B62 ** BigInt(4);
var B10_2_B62_4 = B10_2 * B62_4;
var B36_4_B10_2_B62_4 = B36_4 * B10_2 * B62_4;

function pad2(n) {
  var x = parseInt(n, 10);
  if (!isFinite(x) || x < 0) x = 0;
  x %= 100;
  var s = String(x);
  while (s.length < 2) s = "0" + s;
  return s;
}
function cB36(c) {
  var o = c.charCodeAt(0);
  if (o >= 48 && o <= 57) return o - 48;
  if (o >= 65 && o <= 90) return o - 65 + 10;
  return -1;
}
function b36C(n) {
  if (n <= 9) return String.fromCharCode(48 + n);
  if (n <= 35) return String.fromCharCode(65 + n - 10);
  return "?";
}
function sb36(s) {
  var r = BigInt(0);
  for (var i = 0; i < s.length; i++) r = r * B36 + BigInt(cB36(s[i]));
  return r;
}
function bs36(n, l) {
  var r = "";
  var x = n;
  for (var i = 0; i < l; i++) {
    r = b36C(Number(x % B36)) + r;
    x = x / B36;
  }
  return r;
}
var DEVICE_BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function cB62(c) {
  var i = DEVICE_BASE62.indexOf(c);
  return i >= 0 ? i : 0;
}
function b62C(n) {
  if (n >= 0 && n < DEVICE_BASE62.length) return DEVICE_BASE62[n];
  return "?";
}
function sb62(s) {
  var r = BigInt(0);
  for (var i = 0; i < s.length; i++) r = r * B62 + BigInt(cB62(s[i]));
  return r;
}
function bs62(n, l) {
  var r = "";
  var x = n;
  for (var i = 0; i < l; i++) {
    r = b62C(Number(x % B62)) + r;
    x = x / B62;
  }
  return r;
}

function decode18(code) {
  if (code.length !== 18 || !/^\d{18}$/.test(code)) return { valid: false };
  var t = BigInt(code);
  var n4 = t % B62_4;
  var rem = t / B62_4;
  var n3 = rem % B10_2;
  rem = rem / B10_2;
  var n2 = rem % B36_4;
  var n1 = rem / B36_4;
  var g1 = n1.toString().padStart(2, "0");
  var g2 = bs36(n2, 4);
  var g3 = n3.toString().padStart(2, "0");
  var g4 = bs62(n4, 4);
  var inp = g1 + g2 + g3 + g4;
  if (!/^\d{2}[A-Z0-9]{4}\d{2}[A-Za-z0-9]{4}$/.test(inp)) return { valid: false };
  return {
    valid: true,
    productId: g1,
    checkCode: g2,
    months: parseInt(g3, 10),
    deviceId: g4,
  };
}

function encode18(pid, rc4, m, dev4) {
  var g1 = pad2(pid);
  var g2 = String(rc4).toUpperCase();
  var g3 = pad2(m);
  var g4 = dev4;
  var inp = g1 + g2 + g3 + g4;
  if (inp.length !== 12) return null;
  if (!/^\d{2}[A-Z0-9]{4}\d{2}[A-Za-z0-9]{4}$/.test(inp)) return null;
  var n1 = BigInt(parseInt(g1, 10));
  var n2 = sb36(g2);
  var n3 = BigInt(parseInt(g3, 10));
  var n4 = sb62(g4);
  var c = n1 * B36_4_B10_2_B62_4 + n2 * B10_2_B62_4 + n3 * B62_4 + n4;
  var code = c.toString().padStart(18, "0");
  return code.length === 18 ? code : null;
}

var cases = [];
if (process.argv[2]) {
  cases.push({
    code: String(process.argv[2]).replace(/\s/g, ""),
    label: "命令行参数",
  });
} else {
  cases.push({
    code: "002573764392844210",
    label: "用户提供的激活码",
  });
  var samples = [
    ["01", "TEST", 12, "Ab12"],
    ["07", "ABCD", 1, "WXyz"],
    ["99", "ZZZZ", 99, "0000"],
    ["01", "1BZR", 1, "c786"],
  ];
  samples.forEach(function (s) {
    cases.push({
      code: crypto.generateActivationCode(s[0], s[3], s[2], s[1]),
      label:
        "生成 sample: pid=" +
        s[0] +
        " rc=" +
        s[1] +
        " months=" +
        s[2] +
        " dev=" +
        s[3],
    });
  });
}

var ok = 0;
var fail = 0;
console.log(
  "测试项: " +
    cases.length +
    " (不传参数跑内置样例，传 18 位激活码只测那一个)\n"
);
cases.forEach(function (c) {
  var fe = decode18(c.code);
  var be = crypto.decryptActivationCode(c.code);
  var match =
    fe.valid === be.valid &&
    fe.productId === be.productId &&
    fe.checkCode === be.checkCode &&
    fe.months === be.months &&
    fe.deviceId === be.deviceId;
  var reencode = null;
  var roundTrip = false;
  if (fe.valid) {
    reencode = encode18(fe.productId, fe.checkCode, fe.months, fe.deviceId);
    roundTrip = reencode === c.code;
  }
  if (match && roundTrip) ok++;
  else fail++;
  var status = match && roundTrip ? "OK" : "FAIL";
  console.log("[" + status + "] " + c.label);
  console.log("  code         : " + c.code);
  if (!fe.valid || !be.valid) {
    console.log("  frontend: INVALID");
    console.log("  backend : INVALID reason=" + (be.reason || "-"));
  } else {
    console.log("  产品 ID(pid) : " + fe.productId + " (前后端一致: " + (fe.productId === be.productId) + ")");
    console.log("  兑换码 (rc)  : " + fe.checkCode);
    console.log("  月数(months) : " + fe.months + (fe.months === 99 ? " (永久)" : ""));
    console.log("  设备 ID(dev) : " + fe.deviceId);
  }
  if (fe.valid) {
    console.log("  往返重编码   : " + (reencode || "-"));
    console.log(
      "  往返一致性   : " +
        (roundTrip ? "PASS (还原后 encode 得到相同激活码)" : "FAIL (与原码不一致)")
    );
  }
  console.log();
});
console.log("===== 汇总: OK=" + ok + " FAIL=" + fail + " =====");
process.exit(fail ? 1 : 0);