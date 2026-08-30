var REDEEM_CODE_PATTERN = /^[A-Za-z0-9]{4}$/;

function validateRedeemCode(code) {
  if (!code || typeof code !== "string") {
    return { valid: false, error: "兑换码不能为空" };
  }
  var trimmed = code.trim();
  if (!REDEEM_CODE_PATTERN.test(trimmed)) {
    return { valid: false, error: "兑换码格式无效（需要4位字母+数字）" };
  }
  return { valid: true, value: trimmed };
}

function validateDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== "string" || deviceId.trim().length < 2) {
    return { valid: false, error: "设备ID至少需要2个字符" };
  }
  return { valid: true, value: deviceId.trim() };
}

function validateProductName(name) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return { valid: false, error: "产品名称不能为空" };
  }
  if (name.trim().length > 100) {
    return { valid: false, error: "产品名称不能超过100个字符" };
  }
  return { valid: true, value: name.trim() };
}

function validateDuration(days) {
  var num = Number(days);
  if (!Number.isInteger(num) || num < 1) {
    return { valid: false, error: "天数必须是正整数" };
  }
  if (num > 9999) {
    return { valid: false, error: "天数不能超过9999天" };
  }
  return { valid: true, value: num };
}

function validateCount(count) {
  var num = Number(count);
  if (!Number.isInteger(num) || num < 1) {
    return { valid: false, error: "数量必须是正整数" };
  }
  if (num > 1000) {
    return { valid: false, error: "单次最多生成1000个兑换码" };
  }
  return { valid: true, value: num };
}

function validateUsername(username) {
  if (!username || typeof username !== "string" || username.trim().length < 2) {
    return { valid: false, error: "用户名至少需要2个字符" };
  }
  return { valid: true, value: username.trim() };
}

function validatePassword(password) {
  if (!password || typeof password !== "string" || password.length < 6) {
    return { valid: false, error: "密码至少需要6个字符" };
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