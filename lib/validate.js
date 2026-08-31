var REDEEM_CODE_PATTERN = /^[A-Z0-9]{4}$/;

function validateRedeemCode(code) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "Redeem code is required" };
  }
  var trimmed = code.trim().toUpperCase();
  if (!REDEEM_CODE_PATTERN.test(trimmed)) {
    return { valid: false, error: "Redeem code must be 4 uppercase letters or digits (A-Z, 0-9)" };
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

function validateDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== "string") {
    return { valid: false, error: "Device ID is required" };
  }
  var trimmed = deviceId.trim();
  if (trimmed.length < 1) {
    return { valid: false, error: "Device ID is required" };
  }
  var normalized = normalizeDeviceId(trimmed);
  return { valid: true, value: normalized };
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
  normalizeDeviceId,
  validateProductName,
  validateDuration,
  validateCount,
  validateUsername,
  validatePassword,
};