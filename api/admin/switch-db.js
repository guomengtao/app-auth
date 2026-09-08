process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var dbSwitches = require("../../lib/db-switches");
var dbRegistry = require("../../lib/db-registry");

module.exports = async function switchDb(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    var body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ success: false, error: "Request body is required" });
    }

    var targetDb = (body.target || "").toLowerCase();
    var allDbIds = dbRegistry.getAllDatabases().map(function(db) { return db.id; });
    if (allDbIds.indexOf(targetDb) === -1) {
      return res.status(400).json({
        success: false,
        error: "Invalid target. Available databases: " + allDbIds.join(", "),
      });
    }

    var currentPrimary = dbSwitches.getPrimary() || String(process.env.DB_PROVIDER || "auto").trim();
    if (targetDb === currentPrimary) {
      return res.json({
        success: true,
        message: "Already the primary database",
        switched: false,
        from: currentPrimary,
        to: targetDb,
      });
    }

    await dbSwitches.savePrimary(targetDb);

    return res.json({
      success: true,
      message: "Primary database switched from " + currentPrimary + " to " + targetDb,
      switched: true,
      from: currentPrimary,
      to: targetDb,
      note: "The switch takes effect on the next request. Existing connections may still use the old primary for a few seconds.",
    });
  } catch (e) {
    console.error("switch-db error:", e);
    return res.status(500).json({
      success: false,
      error: "Switch failed: " + (e.message || String(e)),
    });
  }
};