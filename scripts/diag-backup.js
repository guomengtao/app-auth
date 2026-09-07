var pg = require("../lib/postgres");

async function readSetMembersDirect(pg, setKey, valueKeyPrefix) {
  var records = [];
  var memberResult = await pg.query("SELECT member FROM kv_sets WHERE key = $1 ORDER BY member", [setKey]);
  var members = (memberResult.rows || []).map(function(r) { return r.member; });
  console.log("  members: " + members.length);
  if (members.length === 0) return records;

  if (valueKeyPrefix === null || valueKeyPrefix === "") {
    for (var i = 0; i < members.length; i++) {
      records.push({ _backup_member: members[i], value: members[i] });
    }
    return records;
  }

  var chunks = [];
  for (var i = 0; i < members.length; i += 200) chunks.push(members.slice(i, i + 200));
  for (var c = 0; c < chunks.length; c++) {
    var batch = chunks[c];
    var lookupKeys = batch.map(function(x) { return valueKeyPrefix + x; });
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

async function readStringDirect(pg, key) {
  var result = await pg.query("SELECT value FROM kv_strings WHERE key = $1", [key]);
  if (result.rows && result.rows.length > 0) {
    try { return JSON.parse(result.rows[0].value); } catch (_) {
      return result.rows[0].value;
    }
  }
  return null;
}

async function scanKeysDirect(pg, pattern) {
  var records = [];
  var sqlPattern = pattern.replace(/\*/g, "%").replace(/\?/g, "_");
  var result = await pg.query(
    "SELECT key, value FROM kv_strings WHERE key LIKE $1 ORDER BY key",
    [sqlPattern]
  );
  console.log("  keys: " + (result.rows ? result.rows.length : 0));
  (result.rows || []).forEach(function(r) {
    try {
      var rec = JSON.parse(r.value);
      rec._backup_key = r.key;
      records.push(rec);
    } catch (_) {
      records.push({ _backup_key: r.key, value: r.value });
    }
  });
  return records;
}

async function main() {
  console.log("=== Direct SQL Backup Test ===\n");

  var tests = [
    { name: "auth:products", fn: async function() { return await readHashAllDirect(pg, "auth:products"); } },
    { name: "auth:product_ids", fn: async function() { return await readSetMembersDirect(pg, "auth:product_ids", null); } },
    { name: "auth:redeem_codes", fn: async function() { return await readSetMembersDirect(pg, "auth:redeem_codes", "auth:redeem:"); } },
    { name: "auth:activation_codes", fn: async function() { return await readSetMembersDirect(pg, "auth:activation_codes", "auth:activation:"); } },
    { name: "auth:activation_failures", fn: async function() { return await readSetMembersDirect(pg, "auth:activation_failures", ""); } },
    { name: "auth:device:*", fn: async function() { return await scanKeysDirect(pg, "auth:device:%"); } },
    { name: "auth:admin", fn: async function() { return await readHashAllDirect(pg, "auth:admin"); } },
    { name: "auth:product_counter", fn: async function() { return await readStringDirect(pg, "auth:product_counter"); } },
    { name: "auth:counter:used_redeem_codes", fn: async function() { return await readStringDirect(pg, "auth:counter:used_redeem_codes"); } },
    { name: "afdian:order:*", fn: async function() { return await scanKeysDirect(pg, "afdian:order:%"); } },
    { name: "afdian:processed", fn: async function() { return await readSetMembersDirect(pg, "afdian:processed", null); } },
    { name: "afdian:last_sync", fn: async function() { return await readStringDirect(pg, "afdian:last_sync"); } },
    { name: "afdian:plan_map", fn: async function() { return await readHashAllDirect(pg, "afdian:plan_map"); } },
    { name: "quota:monthstate:*", fn: async function() { return await scanKeysDirect(pg, "quota:monthstate:%"); } },
  ];

  for (var t = 0; t < tests.length; t++) {
    var test = tests[t];
    console.log(test.name + ":");
    var result = await test.fn();
    if (Array.isArray(result)) {
      console.log("  => " + result.length + " records");
    } else if (result != null) {
      console.log("  => " + (typeof result === "object" ? JSON.stringify(result).substring(0, 80) : result));
    } else {
      console.log("  => null");
    }
    console.log("");
  }

  console.log("=== Done ===");
  process.exit(0);
}

main().catch(function(e) { console.error(e); process.exit(1); });