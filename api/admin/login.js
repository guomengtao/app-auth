const redis = require("../../lib/redis");
const { createToken } = require("../../lib/auth");
const { validateUsername, validatePassword } = require("../../lib/validate");
const crypto = require("crypto");

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { username, password } = req.body || {};

    const userCheck = validateUsername(username);
    if (!userCheck.valid) {
      return res.status(400).json({ success: false, error: userCheck.error });
    }

    const passCheck = validatePassword(password);
    if (!passCheck.valid) {
      return res.status(400).json({ success: false, error: passCheck.error });
    }

    const adminData = await redis.hgetall("auth:admin");
    if (!adminData || !adminData.username) {
      const defaultPassword = hashPassword("admin123");
      await redis.hset("auth:admin", {
        username: "admin",
        password_hash: defaultPassword,
      });
    }

    const admin = await redis.hgetall("auth:admin");
    if (admin.username !== userCheck.value) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    const inputHash = hashPassword(passCheck.value);
    if (admin.password_hash !== inputHash) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    const token = createToken(admin.username);

    res.setHeader(
      "Set-Cookie",
      `token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`
    );

    return res.json({ success: true, username: admin.username });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};