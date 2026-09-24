var REDEEM_CODE_PATTERN = /^[A-Z0-9]{4}$/;

function validateRedeemCode(code) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "请输入兑换码" };
  }
  var trimmed = code.trim().toUpperCase();
  if (!REDEEM_CODE_PATTERN.test(trimmed)) {
    return { valid: false, error: "兑换码必须是 4 位大写字母或数字（A-Z, 0-9）" };
  }
  return { valid: true, value: trimmed };
}

function normalizeDeviceId(deviceId) {
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

// 手环端取不到设备标识时的常见回落值：这类值一旦放行，会被归一化成同一个设备指纹
// （例如 "NA" → "00NA"），导致一码一机校验失效、激活码可跨设备复用。
var INVALID_DEVICE_TOKENS = {
  NA: 1, "N/A": 1, NULL: 1, UNDEFINED: 1, NONE: 1, UNKNOWN: 1, UNKNOW: 1,
  NIL: 1, NAN: 1, "-": 1, "--": 1, TEST: 1, EMPTY: 1, DEFAULT: 1, FALSE: 1,
  // L2 观察名单：理论上真实设备也可能命中，先拦但保留独立 code 便于观察误伤
  0: 1, "0000": 1,
};

// 校验的是「原始值」，不是归一化后的后4位：
// 否则 "NA" 已被补成 "00NA" 看不出来，而 UUID 尾部恰为 0000 的正常用户会被误伤。
function isValidDeviceId(rawDeviceId) {
  var s = String(rawDeviceId == null ? "" : rawDeviceId).trim();
  if (!s) return false;
  if (INVALID_DEVICE_TOKENS[s.toUpperCase()]) return false;
  var alnum = s.replace(/[^0-9A-Za-z]/g, "");
  return alnum.length >= 4;
}

// options.strict 默认 true（用户自助激活必须严格）。
// 后台「直开激活码」传 { strict: false }：允许保留值/短 ID，便于为受影响用户手工开码或测试。
function validateDeviceId(deviceId, options) {
  var strict = !options || options.strict !== false;
  if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
    return { valid: false, code: "DEVICE_ID_EMPTY", error: "设备ID不能为空" };
  }
  if (strict && !isValidDeviceId(deviceId)) {
    // 截断原始值，后台一眼看出是 NA / null 还是别的
    var raw = deviceId.trim().slice(0, 12);
    return {
      valid: false,
      code: "DEVICE_ID_INVALID",
      // ⚠️ 服务端文案不写群号：群号只在 activate.html 底部维护（见 docs/设备ID为NA无效值拦截与反馈引导方案.md）
      error: '设备ID无效（当前值："' + raw + '"），请重启设备后重试，或联系作者处理',
      raw: raw,
    };
  }
  return { valid: true, value: normalizeDeviceId(deviceId) };
}

function validateProductName(name) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return { valid: false, error: "Product name is required" };
  }
  if (name.trim().length > 100) {
    return { valid: false, error: "Product name cannot exceed 100 characters" };
  }
  return { valid: true, value: name.trim() };
}

function validateDuration(days) {
  var num = Number(days);
  if (!Number.isInteger(num) || num < 1) {
    return { valid: false, error: "Duration must be a positive integer" };
  }
  if (num > 99) {
    return { valid: false, error: "Duration cannot exceed 99 months" };
  }
  return { valid: true, value: num };
}

function validateCount(count) {
  var num = Number(count);
  if (!Number.isInteger(num) || num < 1) {
    return { valid: false, error: "Count must be a positive integer" };
  }
  if (num > 1000) {
    return { valid: false, error: "Maximum 1000 codes per batch" };
  }
  return { valid: true, value: num };
}

function validateUsername(username) {
  if (!username || typeof username !== "string" || username.trim().length < 2) {
    return { valid: false, error: "Username must be at least 2 characters" };
  }
  return { valid: true, value: username.trim() };
}

function validatePassword(password) {
  if (!password || typeof password !== "string" || password.length < 6) {
    return { valid: false, error: "Password must be at least 6 characters" };
  }
  return { valid: true, value: password };
}

module.exports = {
  validateRedeemCode,
  validateDeviceId,
  isValidDeviceId,
  normalizeDeviceId,
  validateProductName,
  validateDuration,
  validateCount,
  validateUsername,
  validatePassword,
};