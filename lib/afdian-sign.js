var crypto = require("crypto");

var AFDIAN_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\n" +
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y\n" +
  "lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS\n" +
  "4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr\n" +
  "8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf\n" +
  "jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7\n" +
  "jRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW\n" +
  "MQIDAQAB\n" +
  "-----END PUBLIC KEY-----";

function md5(data) {
  return crypto.createHash("md5").update(data).digest("hex");
}

function generateApiSign(token, paramsJson, ts, userId) {
  var kvString = "params" + paramsJson + "ts" + ts + "user_id" + userId;
  return md5(token + kvString);
}

function buildApiRequestBody(userId, token, params, ts) {
  var paramsJson = JSON.stringify(params);
  var sign = generateApiSign(token, paramsJson, ts, userId);
  return {
    user_id: userId,
    params: paramsJson,
    ts: ts,
    sign: sign,
  };
}

function verifyWebhookSign(outTradeNo, userId, planId, totalAmount, signBase64) {
  try {
    var signStr = outTradeNo + userId + planId + totalAmount;
    var signBuf = Buffer.from(signBase64, "base64");
    var verify = crypto.createVerify("SHA256");
    verify.update(signStr);
    verify.end();
    return crypto.verify(null, signBuf, {
      key: AFDIAN_PUBLIC_KEY,
      format: "pem",
      type: "pkcs1",
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, AFDIAN_PUBLIC_KEY);
  } catch (e) {
    return false;
  }
}

function verifyWebhookSignSimple(signStr, signBase64) {
  try {
    var signBuf = Buffer.from(signBase64, "base64");
    return crypto.createVerify("SHA256")
      .update(signStr)
      .verify(AFDIAN_PUBLIC_KEY, signBuf);
  } catch (e) {
    return false;
  }
}

module.exports = {
  md5: md5,
  generateApiSign: generateApiSign,
  buildApiRequestBody: buildApiRequestBody,
  verifyWebhookSign: verifyWebhookSign,
  verifyWebhookSignSimple: verifyWebhookSignSimple,
  AFDIAN_PUBLIC_KEY: AFDIAN_PUBLIC_KEY,
};