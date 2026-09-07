var pg = require("../lib/postgres");

async function readSetMembersDirect(pg, setKey, valueKeyPrefix) {
  var records = [];
  var memberResult = await pg.query("SELECT member FROM kv_sets WHERE key = $1 ORDER BY member", [setKey]);
  var members = (memberResult.rows || []).map(function(r) { return r.member; });
  console.log("  members: " + members.length);
  if (members.length > 0) {
    var chunks = [];
    for (var i = 0; i < members.length; i += 200) chunks.push(members.slice(i, i + 200));
    for (var c = 0; c < chunks.length; c++) {
      var batch = chunks[c];
      var lookupKeys = valueKeyPrefix ? batch.map(function(x) { return valueKeyPrefix + x; }) : batch;
      var placeholders = lookupKeys.map(function(_, idx) { return "$" + (idx + 1); }).join(",");
      var valResult = await pg.query(
        "SELECT key, value FROM kv_strings WHERE key IN (" + placeholders + ")",
        lookupKeys
      );
      var valMap = {};
      (valResult.rows || []).forEach(function(r) { valMap[r.key] = r.value; });
      for (var j = 0; j < batch.length; j++) {
        var raw = valMap[lookupKeys[j]];
        if (raw) {
          try {
            var rec = JSON.parse(raw);
            rec._backup_key = lookupKeys[j];
            rec._backup_member = batch[j];
            records.push(rec);
          } catch (_) {}
        }
      }
    }
  }
  return records;
}

async function readHashAllDirect(pg, hashKey) {
  var records = [];
  var result = await pg.query("SELECT field, value FROM kv_hashes WHERE key = $1", [hashKey]);
  console.log("  fields: " + (result.rows ? result.rows.length : 0));
  (result.rows || []).forEach(function(r) {
    try { records.push({ id: r.field, data: JSON.parse(r.value) }); } catch (_) {
      try { records.push({ id: r.field, value: r.value }); } catch (_) {}
    }
  });
  return records;
}

async function main() {
  console.log("=== Direct SQL Backup Test ===\n");

  console.log("products:");
  var products = await readHashAllDirect(pg, "auth:products");
  console.log("  => " + products.length + " records\n");

  console.log("redeem_codes:");
  var redeemCodes = await readSetMembersDirect(pg, "auth:redeem_codes", "auth:redeem:");
  console.log("  => " + redeemCodes.length + " records");
  if (redeemCodes.length > 0) {
    var r = redeemCodes[0];
    console.log("  sample: code=" + (r.code || r._backup_member) + " _backup_key=" + r._backup_key + " _backup_member=" + r._backup_member);
  }
  console.log("");

  console.log("activations:");
  var activations = await readSetMembersDirect(pg, "auth:activation_codes", "auth:activation:");
  console.log("  => " + activations.length + " records");
  if (activations.length > 0) {
    var a = activations[0];
    console.log("  sample: code=" + (a.activation_code || a._backup_member) + " _backup_key=" + a._backup_key + " _backup_member=" + a._backup_member);
  }
  console.log("");

  console.log("failures:");
  var failures = await readSetMembersDirect(pg, "auth:activation_failures", "");
  console.log("  => " + failures.length + " records");
  if (failures.length > 0) {
    var f = failures[0];
    console.log("  sample: _backup_key=" + f._backup_key + " _backup_member=" + f._backup_member + " reason=" + (f.reason || "").substring(0, 40));
  }
  console.log("");

  console.log("=== Done ===");
}

main().catch(function(e) {
  console.error("Fatal:", e.message);
  process.exit(1);
});