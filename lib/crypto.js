const crypto = require("crypto");

const SECRET = process.env.CRYPTO_SECRET || "app-auth-default-secret-change-me";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function generateRedeemCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segments = [];
  for (let s = 0; s < 3; s++) {
    let segment = "";
    for (let i = 0; i < 4; i++) {
      segment += chars[Math.floor(Math.random() * chars.length)];
    }
    segments.push(segment);
  }
  return segments.join("-");
}

function generateActivationCode(productId, deviceId, durationDays) {
  const payload = `${productId}:${deviceId}:${durationDays}:${Date.now()}`;
  const signature = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `ACT-${signature.slice(0, 32).toUpperCase()}`;
}

module.exports = {
  sha256,
  generateRedeemCode,
  generateActivationCode,
};