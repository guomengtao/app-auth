var fs = require("fs");
var path = require("path");

module.exports = function (req, res) {
  try {
    var raw = fs.readFileSync(path.join(__dirname, "..", "version.json"), "utf-8");
    var data = JSON.parse(raw);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ version: "0.0.0", patch: 0 });
  }
};