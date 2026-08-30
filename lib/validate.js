const REDEEM_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function validateRedeemCode(code) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "Redeem code is required" };
  }
  const upper = code.toUpperCase().trim();
  if (!REDEEM_CODE_PATTERN.test(upper)) {
    return { valid: false, error: "Invalid redeem code format (expected XXXX-XXXX-XXXX)" };
  }
  return { valid: true, value: upper };
}

function validateDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== "string" || deviceId.trim().length < 4) {
    return { valid: false, error: "Device ID must be at least 4 characters" };
  }
  return { valid: true, value: deviceId.trim() };
}

function validateProductName(name) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return { valid: false, error: "Product name is required" };
  }
  if (name.trim().length > 100) {
    return { valid: false, error: "Product name must be under 100 characters" };
  }
  return { valid: true, value: name.trim() };
}

function validateDuration(days) {
  const num = Number(days);
  if (!Number.isInteger(num) || num < 1) {
    return { valid: false, error: "Duration must be a positive integer (days)" };
  }
  if (num > 9999) {
    return { valid: false, error: "Duration must not exceed 9999 days" };
  }
  return { valid: true, value: num };
}

function validateCount(count) {
  const num = Number(count);
  if (!Number.isInteger(num) || num < 1) {
    return { valid: false, error: "Count must be a positive integer" };
  }
  if (num > 1000) {
    return { valid: false, error: "Cannot generate more than 1000 codes at once" };
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
  validateProductName,
  validateDuration,
  validateCount,
  validateUsername,
  validatePassword,
};