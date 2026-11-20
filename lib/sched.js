// lib/sched.js
//
// 课程表云同步接口（P1）。**故意放在 lib/ 而不是 api/**：
// Vercel 每个 api/ 下的文件都会算一个 Serverless Function，本项目已到 12 个上限
// （官方 12，我们按 10 收敛，见 api/ev.js 顶部注释），所以这里只提供 handler，
// 由 api/ev.js 用 `?action=sched-<op>` 转发进来，**不新增任何函数文件**。
//
// 路由：vercel.json 里 /api/sched/:op → /api/ev?action=sched-:op
// 对应安卓端 CloudApi.java 的九个方法。
//
// 三条铁律（docs/云同步与网页编辑-P1落地计划-20261120.md §3）：
//   1. 服务端「没有这条记录」永不解释为删除；缺失 = 未知；
//   2. 删除只写墓碑（deleted=true + deleted_at），行不物理删，至少留 30 天；
//   3. 首次上云一律以本地为真源（baseRev=0 且云端无行 → 直接 insert rev=1）。

var crypto = require("crypto");

var TABLE = "schedules";
var VERSIONS = "schedule_versions";
var TOKENS = "schedule_tokens";

var MAX_PAYLOAD_BYTES = 512 * 1024;   // 一张课表几十 KB，512KB 已是异常值上限
var MAX_NAME_LEN = 64;

function sb() {
    return {
        url: (process.env.NEXT_PUBLIC_Ev_SUPABASE_URL || process.env.Ev_SUPABASE_URL || "").replace(/\/+$/, ""),
        key: process.env.Ev_SUPABASE_SERVICE_ROLE_KEY || process.env.Ev_SUPABASE_SECRET_KEY || ""
    };
}

function json(res, code, obj) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
}

/** PostgREST 调用；返回 { code, body(已解析或 null), text } */
async function rest(path, opts) {
    var s = sb();
    if (!s.url || !s.key) throw new Error("supabase_env_missing");
    opts = opts || {};
    var headers = {
        "apikey": s.key,
        "Authorization": "Bearer " + s.key,
        "Content-Type": "application/json"
    };
    if (opts.prefer) headers["Prefer"] = opts.prefer;
    var r = await fetch(s.url + "/rest/v1/" + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body == null ? undefined : JSON.stringify(opts.body)
    });
    var text = await r.text();
    var parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
    return { code: r.status, body: parsed, text: text };
}

/** 从 Authorization: Bearer 取 token */
function bearer(req) {
    var h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    var m = /^Bearer\s+(.+)$/i.exec(String(h));
    return m ? m[1].trim() : "";
}

/** 取请求来源 Origin（拼可复制网址用） */
function originOf(req) {
    var proto = (req.headers && req.headers["x-forwarded-proto"]) || "https";
    var host = (req.headers && req.headers.host) || "app-auth.gudq.com";
    return proto + "://" + host;
}

/** 短码字母表：去掉 0/O/1/l/I 等易混字符，10 位约 8e17 空间，撞库概率可忽略 */
var SHORT_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

function newShortId(len) {
    var buf = crypto.randomBytes(len || 10), out = "";
    for (var i = 0; i < buf.length; i++) out += SHORT_ALPHABET[buf[i] % SHORT_ALPHABET.length];
    return out;
}

function badGuid(g) {
    return !g || typeof g !== "string" || g.length < 8 || g.length > 64 || !/^[A-Za-z0-9_-]+$/.test(g);
}

/**
 * 校验 token：必须存在、未撤销、未过期、且绑定的是这个 guid。
 * 返回 true/false。校验发生在服务端，网页端只拿到「可以/不可以」。
 */
async function tokenOk(req, guid) {
    var t = bearer(req);
    if (!t) return false;
    var q = TOKENS + "?token=eq." + encodeURIComponent(t)
        + "&guid=eq." + encodeURIComponent(guid)
        + "&revoked=eq.false&select=token,expires_at&limit=1";
    var r = await rest(q);
    if (r.code !== 200 || !Array.isArray(r.body) || !r.body.length) return false;
    var exp = r.body[0].expires_at;
    if (exp && new Date(exp).getTime() < Date.now()) return false;
    return true;
}

async function getRow(guid) {
    var r = await rest(TABLE + "?guid=eq." + encodeURIComponent(guid) + "&limit=1");
    if (r.code !== 200) throw new Error("read_failed_" + r.code);
    return Array.isArray(r.body) && r.body.length ? r.body[0] : null;
}

/** 取该 guid 现成的未撤销 token；没有就新发一个（避免每次 open 都堆一行 token）。 */
async function ensureToken(guid) {
    var r = await rest(TOKENS + "?guid=eq." + encodeURIComponent(guid)
        + "&revoked=eq.false&select=token,short_id&order=created_at.asc&limit=1");
    if (r.code === 200 && Array.isArray(r.body) && r.body.length) {
        var cur = r.body[0];
        // 短码功能上线前发出的 token 没有 short_id —— 直接复用会拼出 /e/null（2026-11-20 修）。
        // 这里当场补一个短码写回去，老 token 从此也能出可读网址。
        if (!cur.short_id) {
            var s2 = newShortId(10);
            await rest(TOKENS + "?token=eq." + encodeURIComponent(cur.token), {
                method: "PATCH", prefer: "return=minimal", body: { short_id: s2 }
            });
            return { token: cur.token, shortId: s2 };
        }
        return { token: cur.token, shortId: cur.short_id };
    }
    var token = crypto.randomBytes(24).toString("hex");
    var short = newShortId(10);
    await rest(TOKENS, {
        method: "POST",
        prefer: "return=minimal",
        body: { token: token, guid: guid, scope: "schedule", expires_at: null, revoked: false, short_id: short }
    });
    return { token: token, shortId: short };
}

/** 编辑授权是否仍然有效（未过期才算）。 */
function editAlive(row) {
    if (!row || !row.edit_until) return false;
    var t = new Date(row.edit_until).getTime();
    return !isNaN(t) && t > Date.now();
}

// ---------------- 1. publish ----------------

/**
 * 开通某张表的云同步（一次性）。
 * 幂等：guid 已存在时不覆盖 payload（避免用旧快照盖掉云端新数据），只补发一个 token，
 * 并如实返回当前 rev —— 客户端据此把本地 cloudRev 追平，后续 push 才不会误判冲突。
 */
async function handlePublish(req, res) {
    var b = req.body || {};
    var guid = String(b.guid || "");
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    var payload = b.payload;
    if (payload == null) return json(res, 400, { success: false, error: "missing_payload" });
    var payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (Buffer.byteLength(payloadStr, "utf8") > MAX_PAYLOAD_BYTES) {
        return json(res, 413, { success: false, error: "payload_too_large" });
    }

    var name = String(b.name || "").slice(0, MAX_NAME_LEN);
    var watchKey = String(b.watchKey || "");
    var watchName = String(b.watchName || "").slice(0, MAX_NAME_LEN);

    var row = await getRow(guid);
    var rev;
    if (row) {
        rev = row.rev || 0;
        // 只补 watch_key / watch_name / name（可读定位信息），不动 payload 与 rev
        await rest(TABLE + "?guid=eq." + encodeURIComponent(guid), {
            method: "PATCH",
            prefer: "return=minimal",
            body: {
                watch_key: watchKey || row.watch_key,
                watch_name: watchName || row.watch_name,
                name: name || row.name,
                updated_at: new Date().toISOString()
            }
        });
    } else {
        rev = 1;
        var ins = await rest(TABLE, {
            method: "POST",
            prefer: "return=minimal",
            body: {
                guid: guid,
                watch_key: watchKey,
                watch_name: watchName,
                name: name,
                rev: rev,
                payload: JSON.parse(payloadStr),
                updated_by: "android"
            }
        });
        if (ins.code !== 201 && ins.code !== 204) {
            return json(res, 502, { success: false, error: "insert_failed", detail: String(ins.text).slice(0, 200) });
        }
    }

    var token = crypto.randomBytes(24).toString("hex");
    var short = newShortId(10);   // 短码即凭据：/e/<short> 直接可读，MAC 与 guid 不再进 URL
    var tk = await rest(TOKENS, {
        method: "POST",
        prefer: "return=minimal",
        body: { token: token, guid: guid, scope: "schedule", expires_at: null, revoked: false, short_id: short }
    });
    if (tk.code !== 201 && tk.code !== 204) {
        return json(res, 502, { success: false, error: "token_failed", detail: String(tk.text).slice(0, 200) });
    }

    var url = originOf(req) + "/e/" + short;
    return json(res, 200, { success: true, rev: rev, token: token, shortId: short, url: url });
}

// ---------------- 2. push ----------------

/**
 * 队列消费。乐观锁：
 *   - 云端无行 + upsert → 以本地为真源 insert rev=1（绝不「云端为空就清本地」）
 *   - 云端无行 + delete → rev=0 无操作（缺失不等于已删）
 *   - 云端 rev !== baseRev → 409，把最新 rev/payload 回吐给客户端合并
 */
async function handlePush(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });

    var b = req.body || {};
    var op = b.op === "delete" ? "delete" : "upsert";
    var baseRev = parseInt(b.baseRev, 10);
    if (isNaN(baseRev) || baseRev < 0) baseRev = 0;

    var payloadStr = null;
    if (op === "upsert") {
        if (b.payload == null) return json(res, 400, { success: false, error: "missing_payload" });
        payloadStr = typeof b.payload === "string" ? b.payload : JSON.stringify(b.payload);
        if (Buffer.byteLength(payloadStr, "utf8") > MAX_PAYLOAD_BYTES) {
            return json(res, 413, { success: false, error: "payload_too_large" });
        }
    }

    var row = await getRow(guid);

    if (!row) {
        if (op === "delete") return json(res, 200, { success: true, rev: 0, noop: "never_uploaded" });
        var ins = await rest(TABLE, {
            method: "POST",
            prefer: "return=representation",
            body: {
                guid: guid,
                watch_key: String(b.watchKey || ""),
                watch_name: String(b.watchName || ""),
                name: String(b.name || "").slice(0, MAX_NAME_LEN),
                rev: 1,
                payload: JSON.parse(payloadStr),
                updated_by: "android"
            }
        });
        if (ins.code !== 201) {
            return json(res, 502, { success: false, error: "insert_failed", detail: String(ins.text).slice(0, 200) });
        }
        return json(res, 200, { success: true, rev: 1 });
    }

    var curRev = row.rev || 0;
    if (curRev !== baseRev) {
        return json(res, 409, { success: false, error: "rev_conflict", rev: curRev, payload: row.payload });
    }

    var nextRev = curRev + 1;
    var patch = {
        rev: nextRev,
        updated_at: new Date().toISOString(),
        updated_by: "android"
    };
    if (op === "upsert") {
        patch.payload = JSON.parse(payloadStr);
        patch.deleted = false;
        patch.deleted_at = null;
    } else {
        // 墓碑：保留 payload，只标记删除，30 天后再由定时任务清理
        patch.deleted = true;
        patch.deleted_at = new Date().toISOString();
    }

    // 用 return=representation 而不是 minimal：PostgREST 对「更新 0 行」也返回 204，
    // minimal 下拿不到「有没有真的写进去」的信号，乐观锁就形同虚设（2026-11-20 修）。
    var up = await rest(TABLE + "?guid=eq." + encodeURIComponent(guid) + "&rev=eq." + curRev, {
        method: "PATCH",
        prefer: "return=representation",
        body: patch
    });
    if (up.code !== 200 || !Array.isArray(up.body) || up.body.length === 0) {
        // 命中 0 行 = 并发写抢在前面，按冲突回吐最新态让客户端合并
        var again = await getRow(guid);
        return json(res, 409, {
            success: false, error: "rev_conflict",
            rev: again ? again.rev : 0, payload: again ? again.payload : null
        });
    }
    return json(res, 200, { success: true, rev: nextRev });
}

// ---------------- 3. pull ----------------

/**
 * 短码直达：/e/<short> 的取数口。短码本身就是读凭据，不需要 Bearer。
 * 只返回读所需字段；写权限仍走 Bearer token + 扫码会话，短码永远不能写。
 */
async function handleOpen(req, res) {
    var q = req.query || {};
    var c = String(q.c || "").trim();
    if (!/^[0-9A-Za-z]{6,24}$/.test(c)) return json(res, 400, { success: false, error: "bad_code" });
    var tr = await rest(TOKENS + "?short_id=eq." + encodeURIComponent(c) + "&revoked=eq.false&select=guid,expires_at&limit=1");
    if (tr.code !== 200 || !Array.isArray(tr.body) || !tr.body.length) {
        return json(res, 401, { success: false, error: "invalid_code" });
    }
    var t0 = tr.body[0];
    if (t0.expires_at && new Date(t0.expires_at).getTime() < Date.now()) {
        return json(res, 401, { success: false, error: "code_expired" });
    }
    var row = await getRow(t0.guid);
    if (!row) return json(res, 200, { success: true, exists: false, guid: t0.guid });

    // 编辑能力：只有手机端显式开过「允许网页编辑」（edit_until 未过期）才下发写入 token。
    // 短码本身永远只给读；写权限必须由手机持有者点头，且到期自动收回。
    var editable = editAlive(row);
    var out = {
        success: true, exists: true, guid: row.guid, name: row.name, rev: row.rev,
        deleted: !!row.deleted, payload: row.payload, publicRead: !!row.public_read,
        editable: editable
    };
    if (editable) {
        var tk = await ensureToken(row.guid);
        out.editToken = tk.token;
        out.editUntil = row.edit_until;
    }
    return json(res, 200, out);
}

async function handlePull(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var row = await getRow(guid);
    if (!row) {
        // 明确区分「云端还没有」与「已删除」，客户端不得据此删本地
        return json(res, 200, { success: true, exists: false, rev: 0, payload: null });
    }
    return json(res, 200, {
        success: true, exists: true, rev: row.rev, payload: row.payload,
        deleted: !!row.deleted, updatedBy: row.updated_by, updatedAt: row.updated_at
    });
}

// ---------------- 4. state（三级回执） ----------------

async function handleState(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var row = await getRow(guid);
    if (!row) return json(res, 200, { success: true, exists: false, rev: 0, ackRev: 0 });
    return json(res, 200, {
        success: true, exists: true, rev: row.rev, ackRev: row.ack_rev || 0, ackAt: row.ack_at,
        publicRead: !!row.public_read, updatedAt: row.updated_at, deleted: !!row.deleted
    });
}

// ---------------- 5. ack ----------------

async function handleAck(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var rev = parseInt((req.body || {}).rev, 10);
    if (isNaN(rev) || rev < 0) return json(res, 400, { success: false, error: "bad_rev" });
    await rest(TABLE + "?guid=eq." + encodeURIComponent(guid) + "&ack_rev=lt." + rev, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { ack_rev: rev, ack_at: new Date().toISOString() }
    });
    return json(res, 200, { success: true });
}

// ---------------- 6. share（默认关） ----------------

async function handleShare(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var on = !!(req.body || {}).publicRead;
    var up = await rest(TABLE + "?guid=eq." + encodeURIComponent(guid), {
        method: "PATCH",
        prefer: "return=minimal",
        body: { public_read: on, updated_at: new Date().toISOString() }
    });
    if (up.code !== 204 && up.code !== 200) return json(res, 502, { success: false, error: "update_failed" });
    return json(res, 200, {
        success: true, publicRead: on,
        url: on ? (originOf(req) + "/e/" + guid + "?public=1") : null
    });
}

// ---------------- 6b. edit（手机端点头授权，默认关） ----------------

/**
 * 手机端调：给这张表开一段「网页可写」的窗口（默认 7 天）。
 * 刻意不做账号、不做验证码——持有手机并点下按钮，就是权限的唯一来源。
 * 到期后网页只读，重新点一次即可续期；enable=false 立即收回。
 */
/**
 * 手机端调：只要一个可分享的网址，**不动 edit_until**（纯查看/复制链接用）。
 * 短码是这台设备现成的，没有就发一个，反复点不会堆 token。
 */
async function handleLink(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var row = await getRow(guid);
    if (!row) return json(res, 404, { success: false, error: "not_found" });
    var tk = await ensureToken(guid);
    return json(res, 200, {
        success: true,
        shortId: tk.shortId,
        url: originOf(req) + "/e/" + tk.shortId,
        editable: editAlive(row),
        editUntil: row.edit_until || null
    });
}

async function handleEdit(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var b = req.body || {};
    var enable = b.enable === undefined ? true : !!b.enable;
    var days = parseInt(b.days, 10);
    if (isNaN(days) || days < 1) days = 7;
    if (days > 30) days = 30;

    var until = enable ? new Date(Date.now() + days * 86400000).toISOString() : null;
    var up = await rest(TABLE + "?guid=eq." + encodeURIComponent(guid), {
        method: "PATCH",
        prefer: "representation",
        body: { edit_until: until }
    });
    if (up.code !== 200 && up.code !== 204) {
        return json(res, 502, { success: false, error: "update_failed" });
    }
    var tk = await ensureToken(guid);
    return json(res, 200, {
        success: true, editable: enable, editUntil: until,
        token: enable ? tk.token : null,
        shortId: tk.shortId,
        url: originOf(req) + "/e/" + tk.shortId
    });
}

// ---------------- 7. backup ----------------

async function handleBackup(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var reason = String((req.body || {}).reason || "manual").slice(0, 16);
    if (["manual", "auto", "pre-push", "pre-restore"].indexOf(reason) < 0) reason = "manual";

    var row = await getRow(guid);
    if (!row) return json(res, 404, { success: false, error: "not_found" });

    var ins = await rest(VERSIONS, {
        method: "POST",
        prefer: "return=representation",
        body: { guid: guid, rev: row.rev, payload: row.payload, reason: reason }
    });
    if (ins.code !== 201) return json(res, 502, { success: false, error: "backup_failed", detail: String(ins.text).slice(0, 200) });

    // 自动备份只留最近 7 份；手动/manual 不限（用户定稿的默认值）
    if (reason === "auto") {
        try {
            var list = await rest(VERSIONS + "?guid=eq." + encodeURIComponent(guid)
                + "&reason=eq.auto&select=id&order=id.desc");
            if (list.code === 200 && Array.isArray(list.body) && list.body.length > 7) {
                var drop = list.body.slice(7).map(function (x) { return x.id; });
                await rest(VERSIONS + "?id=in.(" + drop.join(",") + ")", { method: "DELETE", prefer: "return=minimal" });
            }
        } catch (e) { /* 清理失败不影响备份本身 */ }
    }

    var id = (Array.isArray(ins.body) && ins.body[0]) ? ins.body[0].id : null;
    return json(res, 200, { success: true, id: id, rev: row.rev });
}

// ---------------- 8. versions ----------------

async function handleVersions(req, res, guid, query) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var limit = parseInt(query.limit, 10);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    var r = await rest(VERSIONS + "?guid=eq." + encodeURIComponent(guid)
        + "&select=id,rev,reason,created_at&order=id.desc&limit=" + limit);
    if (r.code !== 200) return json(res, 502, { success: false, error: "read_failed" });
    return json(res, 200, { success: true, versions: r.body || [] });
}

// ---------------- 9. restore ----------------

async function handleRestore(req, res, guid) {
    if (badGuid(guid)) return json(res, 400, { success: false, error: "bad_guid" });
    if (!(await tokenOk(req, guid))) return json(res, 401, { success: false, error: "unauthorized" });
    var vid = String((req.body || {}).versionId || "");
    if (!vid) return json(res, 400, { success: false, error: "missing_version" });

    var vr = await rest(VERSIONS + "?id=eq." + encodeURIComponent(vid) + "&guid=eq." + encodeURIComponent(guid) + "&limit=1");
    if (vr.code !== 200 || !Array.isArray(vr.body) || !vr.body.length) {
        return json(res, 404, { success: false, error: "version_not_found" });
    }
    var row = await getRow(guid);
    if (!row) return json(res, 404, { success: false, error: "not_found" });

    // 恢复前把当前态存一份，误点能再退回来
    await rest(VERSIONS, {
        method: "POST", prefer: "return=minimal",
        body: { guid: guid, rev: row.rev, payload: row.payload, reason: "pre-restore" }
    }).catch(function () { });

    var nextRev = (row.rev || 0) + 1;
    var up = await rest(TABLE + "?guid=eq." + encodeURIComponent(guid), {
        method: "PATCH", prefer: "return=minimal",
        body: { payload: vr.body[0].payload, rev: nextRev, deleted: false, deleted_at: null, updated_at: new Date().toISOString(), updated_by: "restore" }
    });
    if (up.code !== 204 && up.code !== 200) return json(res, 502, { success: false, error: "restore_failed" });
    return json(res, 200, { success: true, rev: nextRev });
}

// ---------------- 入口 ----------------

/**
 * @param op 去掉前缀后的动作名：publish | push | pull | state | ack | share | backup | versions | restore
 */
async function handle(req, res, op) {
    var b = (req.body && typeof req.body === "object") ? req.body : {};
    var q = req.query || {};
    if (typeof req.body === "string") {
        try { b = JSON.parse(req.body); } catch (e) { b = {}; }
    }
    req.body = b;
    var guid = String(b.guid || q.guid || "");

    switch (op) {
        case "publish":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handlePublish(req, res);
        case "push":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handlePush(req, res, guid);
        case "open":
            if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
            return handleOpen(req, res);
        case "pull":
            if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
            return handlePull(req, res, guid);
        case "state":
            if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
            return handleState(req, res, guid);
        case "ack":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handleAck(req, res, guid);
        case "share":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handleShare(req, res, guid);
        case "link":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handleLink(req, res, guid);
        case "edit":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handleEdit(req, res, guid);
        case "backup":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handleBackup(req, res, guid);
        case "versions":
            if (req.method !== "GET") return json(res, 405, { success: false, error: "Use GET" });
            return handleVersions(req, res, guid, q);
        case "restore":
            if (req.method !== "POST") return json(res, 405, { success: false, error: "Use POST" });
            return handleRestore(req, res, guid);
        default:
            return json(res, 404, { success: false, error: "unknown_sched_op", op: op });
    }
}

module.exports = { handle: handle };
