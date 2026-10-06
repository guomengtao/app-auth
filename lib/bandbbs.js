// lib/bandbbs.js — BandBBS community operations core library
// Functions: simulated login, review scraping, reward DM sending
// Dependencies: Node.js built-in http/https modules (zero external deps)
//
// Flow:
//   1. Cron (every 12h) → pollReviews() → find new reviews
//   2. For each new review → sendRewardDm() (test mode: send to "peipeijin")
//   3. Track rewarded users → each user gets only 1 reward per resource

var https = require("https");
var http = require("http");
var url = require("url");

var BASE_URL = "https://www.bandbbs.cn";
var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var REDIS_PREFIX = "bandbbs:";

// Test mode: send reward DMs to this user instead of actual reviewer
var TEST_RECIPIENT = "peipeijin";
var TEST_MODE = true; // set to false in production

var agent = new https.Agent({ rejectUnauthorized: false });
var cookieJar = "";

// ── HTTP helpers ──
function httpGet(theUrl, referer) {
    return new Promise(function(resolve, reject) {
        var u = url.parse(theUrl);
        var mod = u.protocol === "https:" ? https : http;
        var opts = {
            hostname: u.hostname, port: u.port, path: u.path, method: "GET",
            agent: u.protocol === "https:" ? agent : undefined,
            headers: { "User-Agent": UA, "Cookie": cookieJar }
        };
        if (referer) opts.headers["Referer"] = referer;
        var req = mod.request(opts, function(res) {
            var c = res.headers["set-cookie"];
            if (c) cookieJar = mergeCookie(cookieJar, c);
            var body = "";
            res.on("data", function(d) { body += d; });
            res.on("end", function() { resolve({ body: body, statusCode: res.statusCode, headers: res.headers }); });
        });
        req.on("error", reject);
        req.end();
    });
}

function httpPost(theUrl, data, referer) {
    return new Promise(function(resolve, reject) {
        var u = url.parse(theUrl);
        var mod = u.protocol === "https:" ? https : http;
        var postData = new URLSearchParams(data).toString();
        var opts = {
            hostname: u.hostname, port: u.port, path: u.path, method: "POST",
            agent: u.protocol === "https:" ? agent : undefined,
            headers: {
                "User-Agent": UA,
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData),
                "Cookie": cookieJar
            }
        };
        if (referer) opts.headers["Referer"] = referer;
        var req = mod.request(opts, function(res) {
            var c = res.headers["set-cookie"];
            if (c) cookieJar = mergeCookie(cookieJar, c);
            var body = "";
            res.on("data", function(d) { body += d; });
            res.on("end", function() { resolve({ body: body, statusCode: res.statusCode, headers: res.headers }); });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}

function mergeCookie(oldJar, setCookie) {
    if (!setCookie) return oldJar;
    var cookies = oldJar ? oldJar.split("; ").filter(Boolean) : [];
    // Handle both single string and array of cookie strings
    var cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookieList.forEach(function(cookieStr) {
        // Extract just the key=value part (before first ;)
        var firstPart = cookieStr.split(";")[0].trim();
        var eq = firstPart.indexOf("=");
        if (eq > 0) {
            var key = firstPart.substring(0, eq);
            cookies = cookies.filter(function(c) { return !c.startsWith(key + "="); });
            cookies.push(key + "=" + firstPart.substring(eq + 1));
        }
    });
    return cookies.join("; ");
}

function extractToken(html) {
    var m = html.match(/name="_xfToken"\s+value="([^"]+)"/);
    return m ? m[1] : null;
}

/**
 * 判断页面是否「真的未登录」：以 XenForo 在 <html> 上的 data-logged-in 属性为权威信号。
 *
 * ⚠️ 绝不能用「body 里是否出现 /login 子串」判断 —— 登录后的页面也含
 * /login/keep-alive（保活端点）与 /js/xf/login_signup.min.js（脚本名），
 * 2026-10-07 真实踩坑：登录成功、DM 页正常（有 _xfToken + attachment_hash），
 * 却因页面里有 3 处 /login 字样被误判「未登录」，导致所有奖励私信发不出去。
 */
function looksLoggedOut(html) {
    html = String(html || "");
    var dli = (html.match(/data-logged-in="(true|false)"/) || [])[1];
    if (dli) return dli === "false";
    // 兜底：页面连登录态标记都没有，但出现登录表单（用户名 + 密码输入）→ 视为未登录
    return /name="login"/.test(html) && /type="password"/.test(html);
}

function escapeHtml(str) {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── 1) Login ──
async function login(email, password) {
    email = email || process.env.BANDBBS_EMAIL || "";
    password = password || process.env.BANDBBS_PASSWORD || "";
    if (!email || !password) return { success: false, error: "BANDBBS_EMAIL/PASSWORD not configured" };

    cookieJar = "";
    var loginPage = await httpGet(BASE_URL + "/login");
    var token = extractToken(loginPage.body);
    if (!token) return { success: false, error: "no CSRF token on login page" };

    var result = await httpPost(BASE_URL + "/login/login", {
        login: email,
        password: password,
        _xfToken: token,
        _xfRedirect: "/",
        remember: "1",
    }, BASE_URL + "/login");

    // Check body first, then follow redirect if login POST returned a Location header
    var loggedIn = result.body.indexOf('data-logged-in="true"') !== -1;
    if (!loggedIn && result.headers && result.headers.location) {
        var followUrl = result.headers.location;
        if (followUrl.indexOf("http") !== 0) followUrl = BASE_URL + followUrl;
        var followResult = await httpGet(followUrl, BASE_URL + "/login/login");
        loggedIn = followResult.body.indexOf('data-logged-in="true"') !== -1;
    }
    return { success: loggedIn, token: token, error: loggedIn ? null : "login failed" };
}

// ── 1b) Diagnostic login — returns step-by-step results for admin UI ──
async function diagnosticLogin(email, password) {
    email = email || process.env.BANDBBS_EMAIL || "";
    password = password || process.env.BANDBBS_PASSWORD || "";
    var steps = [];
    var stepStart = 0;
    var step = function(name) { return { step: name, time: null, ok: null, detail: "", error: "" }; };

    var s1 = step("GET /login (fetch CSRF token)");
    steps.push(s1);
    stepStart = Date.now();
    try {
        cookieJar = "";
        var loginPage = await httpGet(BASE_URL + "/login");
        s1.time = Date.now() - stepStart;
        s1.detail = "status=" + loginPage.statusCode + " body_len=" + loginPage.body.length;
        var token = extractToken(loginPage.body);
        if (token) {
            s1.ok = true;
            s1.detail += " token=" + token.substring(0, 12) + "...";
        } else {
            s1.ok = false;
            s1.error = "no CSRF token found on login page";
            return { success: false, steps: steps, summary: "Login page did not contain CSRF token. Site structure may have changed." };
        }
    } catch (e) {
        s1.time = Date.now() - stepStart;
        s1.ok = false;
        s1.error = e.message || String(e);
        return { success: false, steps: steps, summary: "Failed to fetch login page: " + s1.error };
    }

    var s2 = step("POST /login/login (submit credentials)");
    steps.push(s2);
    stepStart = Date.now();
    try {
        var result = await httpPost(BASE_URL + "/login/login", {
            login: email,
            password: password,
            _xfToken: token,
            _xfRedirect: "/",
            remember: "1",
            _xfClientLoadTime: String(Date.now())
        }, BASE_URL + "/login");
        s2.time = Date.now() - stepStart;
        s2.detail = "status=" + result.statusCode + " body_len=" + result.body.length;
        var hasLocation = !!(result.headers && result.headers.location);
        s2.detail += " location=" + (hasLocation ? result.headers.location : "(none)");
        s2.ok = true;
    } catch (e) {
        s2.time = Date.now() - stepStart;
        s2.ok = false;
        s2.error = e.message || String(e);
        return { success: false, steps: steps, summary: "Login POST request failed: " + s2.error };
    }

    var s3 = step("Check login success");
    steps.push(s3);
    stepStart = Date.now();
    var loggedIn = result.body.indexOf('data-logged-in="true"') !== -1;
    s3.detail = "data-logged-in=" + loggedIn;

    if (!loggedIn && result.headers && result.headers.location) {
        var followUrl = result.headers.location;
        if (followUrl.indexOf("http") !== 0) followUrl = BASE_URL + followUrl;
        s3.detail += " → following redirect: " + followUrl;
        try {
            var followResult = await httpGet(followUrl, BASE_URL + "/login/login");
            loggedIn = followResult.body.indexOf('data-logged-in="true"') !== -1;
            s3.detail += " → follow_status=" + followResult.statusCode + " data-logged-in=" + loggedIn;
        } catch (e) {
            s3.detail += " → redirect failed: " + (e.message || e);
        }
    }
    s3.time = Date.now() - stepStart;
    s3.ok = loggedIn;

    var s4 = step("Verify session: GET /direct-messages/add");
    steps.push(s4);
    stepStart = Date.now();
    try {
        var dmPage = await httpGet(BASE_URL + "/direct-messages/add", BASE_URL + "/login");
        s4.time = Date.now() - stepStart;
        // 权威信号：data-logged-in + 是否真的取到发信表单的 _xfToken（/login 子串会误报，见 looksLoggedOut）
        var dmCsrf = extractToken(dmPage.body);
        var dli = (dmPage.body.match(/data-logged-in="(true|false)"/) || [])[1] || "(no marker)";
        s4.detail = "status=" + dmPage.statusCode + " body_len=" + dmPage.body.length +
            " data-logged-in=" + dli + " dmCsrf=" + (dmCsrf ? dmCsrf.substring(0, 12) + "..." : "NONE");
        if (looksLoggedOut(dmPage.body)) {
            s4.ok = false;
            var titleMatch = (dmPage.body.match(/<title>([^<]+)<\/title>/) || [])[1] || "";
            s4.error = "DM page shows login form (title: \"" + titleMatch + "\")";
            return { success: false, steps: steps, summary: "Login appeared to succeed but session was not maintained — DM page shows the login form." };
        }
        s4.ok = true;
    } catch (e) {
        s4.time = Date.now() - stepStart;
        s4.ok = false;
        s4.error = e.message || String(e);
        s4.detail += " error=" + s4.error;
    }

    return {
        success: loggedIn && s4.ok,
        steps: steps,
        summary: loggedIn
            ? (s4.ok ? "Login successful. Session is ready for DM and reward operations." : "Login succeeded but DM page is not accessible.")
            : "Login failed. " + (s3.error || "Credentials may be invalid or site structure changed.")
    };
}

// ── 2) Fetch reviews for a resource ──
async function fetchReviews(resourceId) {
    var pageUrl = BASE_URL + "/resources/" + resourceId + "/reviews";
    var result = await httpGet(pageUrl);
    var html = result.body;

    var reviews = [];
    // Current page structure uses <span id="resource-review-N"> anchors inside
    // <div class="message message--simple"> blocks (no </article class=review> / data-rating)
    var parts = html.split(/id="resource-review-(\d+)"/).slice(1);
    for (var i = 0; i < parts.length; i += 2) {
        var block = parts[i + 1] || "";
        if (!block) continue;
        var username = (block.match(/class="username\s*"[^>]*>([^<]+)<\/a>/) || [])[1] || "";
        var ratingM = block.match(/<span class="u-srOnly">([0-9.]+)\s*星<\/span>/);
        var rating = ratingM ? parseFloat(ratingM[1]) || 0 : 0;
        var time = (block.match(/datetime="([^"]+)"/) || [])[1] || "";
        var content = (block.match(/<div class="message-body">([\s\S]*?)<\/div>/) || [])[1] || "";
        var userId = (block.match(/itemid="https:\/\/www.bandbbs.cn\/members\/(\d+)\//) || [])[1] || (block.match(/\/members\/(\d+)\//) || [])[1] || "";
        content = content.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").trim();
        if (username) {
            reviews.push({
                username: username.trim(),
                userId: userId,
                rating: rating,
                content: content,
                time: time,
                stars: rating > 0 ? "\u2605".repeat(Math.round(rating)) + "\u2606".repeat(5 - Math.round(rating)) : "",
            });
        }
    }
    return reviews;
}

// ── 3) Send a DM ──
async function sendDm(recipient, title, message) {
    var email = process.env.BANDBBS_EMAIL || "";
    var password = process.env.BANDBBS_PASSWORD || "";
    if (!email || !password) return { success: false, error: "BANDBBS_EMAIL/PASSWORD not configured" };

    // Step 1: login
    var loginResult = await login(email, password);
    if (!loginResult.success) return loginResult;

    // Step 2: fetch DM compose page（用 data-logged-in 权威判定，勿用 /login 子串 —— 见 looksLoggedOut 注释）
    var dmPage = await httpGet(BASE_URL + "/direct-messages/add", BASE_URL + "/login");
    if (looksLoggedOut(dmPage.body)) {
        return { success: false, error: "not authenticated after login (DM page shows login form)" };
    }

    var dmCsrf = extractToken(dmPage.body);
    var attachHash = (dmPage.body.match(/name="attachment_hash"\s+value="([^"]*)"/) || [])[1] || "";
    var attachCombined = (dmPage.body.match(/name="attachment_hash_combined"\s+value="([^"]*)"/) || [])[1] || "";

    if (!dmCsrf) return { success: false, error: "no CSRF token on DM page" };

    // Step 3: send
    var postData = {
        _xfToken: dmCsrf,
        recipients: recipient,
        title: title,
        message_html: "<p>" + escapeHtml(message) + "</p>",
        message: message,
        open_invite: "0",
        conversation_locked: "0",
    };
    if (attachHash) postData.attachment_hash = attachHash;
    if (attachCombined) postData.attachment_hash_combined = attachCombined;

    var sent = await httpPost(BASE_URL + "/direct-messages/add", postData, BASE_URL + "/direct-messages/add");

    var location = sent.headers.location || "";
    var success = location.indexOf("/direct-messages/") !== -1 && location.indexOf("/add") === -1;
    if (!success) {
        var titleMatch = (sent.body.match(/<title>([^<]+)<\/title>/) || [])[1] || "";
        success = titleMatch.indexOf(title) !== -1;
    }

    var convId = (location.match(/\/direct-messages\/(\d+)/) || [])[1] || "";
    var convUrl = "";
    if (location) {
        convUrl = location.indexOf("http") === 0 ? location : (BASE_URL + location);
    }
    return {
        success: success,
        conversationId: convId,
        conversationUrl: convUrl,
    };
}

// ── 4) Main polling + reward logic ──
async function pollAndReward(redis, explicitResourceIds, opts) {
    var startTime = Date.now();
    var mode = (opts && opts.mode) || "manual";
    var results = { resources: {}, newReviews: 0, rewards: { sent: 0, skipped: 0, errors: 0 }, details: [], duration: 0 };
    var polled = [];

    // Get configured resources
    var configs = await getConfig(redis);
    if (!configs || !configs.length) {
        return { success: true, message: "no resources configured", results: results };
    }

    var toPoll = configs.filter(function(c) {
        if (!c.enabled) return false;
        if (explicitResourceIds && explicitResourceIds.length) {
            return explicitResourceIds.indexOf(c.resourceId) !== -1;
        }
        return true;
    });

    if (!toPoll.length) {
        return { success: true, message: "no enabled resources to poll", results: results };
    }

    for (var i = 0; i < toPoll.length; i++) {
        var cfg = toPoll[i];
        var rid = cfg.resourceId;
        var single = await pollOne(redis, cfg, results);
        if (single) polled.push({ resourceId: rid, title: cfg.title, count: single.count, newCount: single.newCount, sent: single.sent });
    }

    results.duration = Date.now() - startTime;

    // Persist poll log (manual and cron) for audit
    await appendPollLog(redis, polled, mode, results.newReviews, results.rewards.sent);

    return { success: true, results: results };
}

// Poll a single configured resource: fetch reviews, store them, reward new reviewers
async function pollOne(redis, cfg, results) {
    var rid = cfg.resourceId;
    var count = 0, newCount = 0, sent = 0;
    try {
        var reviews = await fetchReviews(rid);
        if (!results.resources[rid]) results.resources[rid] = { count: reviews.length, title: cfg.title };
        count = reviews.length;

        // Load previously known reviews
        var prevData = await redis.hgetall(REDIS_PREFIX + "reviews:" + rid);
        prevData = prevData || {};

        // Load rewarded users
        var rewarded = await redis.hgetall(REDIS_PREFIX + "rewarded:" + rid);
        rewarded = rewarded || {};

        for (var j = 0; j < reviews.length; j++) {
            var r = reviews[j];
            var key = r.username + "|" + r.time;

            // Store review
            var storeReview = {};
            storeReview[key] = JSON.stringify(r);
            await redis.hset(REDIS_PREFIX + "reviews:" + rid, storeReview);

            // Check if this is a new review
            if (!prevData[key]) {
                newCount++;
                results.newReviews++;

                // Check if already rewarded
                if (!rewarded[r.username]) {
                    // In test mode, send to TEST_RECIPIENT instead of actual reviewer
                    var recipient = TEST_MODE ? TEST_RECIPIENT : r.username;
                    var dmTitle = "[Reward] Thanks for your review!";
                    var dmMessage = "" +
                        "Hi " + r.username + "!\n\n" +
                        "Thank you for your " + r.stars + " review on " + (cfg.title || "our resource") + "!\n" +
                        "We really appreciate your feedback.\n\n" +
                        "As a token of gratitude, here is a small reward for you. " +
                        (TEST_MODE ? "(Test mode - DM sent to admin)" : "") + "\n\n" +
                        "Best regards,\nThe BandBBS Team";

                    results.details.push({
                        resourceId: rid,
                        username: r.username,
                        rating: r.rating,
                        recipient: recipient,
                        testMode: TEST_MODE,
                    });

                    try {
                        var dmResult = await sendDm(recipient, dmTitle, dmMessage);
                        if (dmResult.success) {
                            results.rewards.sent++;
                            sent++;
                            // Mark as rewarded
                            var rewardRecord = {
                                dm_sent_at: new Date().toISOString(),
                                conv_id: dmResult.conversationId,
                                conv_url: dmResult.conversationUrl,
                                test_mode: TEST_MODE,
                                actual_recipient: r.username,
                            };
                            var storeReward = {};
                            storeReward[r.username] = JSON.stringify(rewardRecord);
                            await redis.hset(REDIS_PREFIX + "rewarded:" + rid, storeReward);
                        } else {
                            results.rewards.errors++;
                            results.details[results.details.length - 1].error = dmResult.error;
                        }
                    } catch (e) {
                        results.rewards.errors++;
                        results.details[results.details.length - 1].error = e.message || String(e);
                    }
                } else {
                    results.rewards.skipped++;
                }
            }
        }

        // Update last poll time
        cfg.lastPollAt = new Date().toISOString();
        cfg.lastPollCount = reviews.length;
        cfg.lastPollNew = newCount;
        var storeCfg = {};
        storeCfg[rid] = JSON.stringify(cfg);
        await redis.hset(REDIS_PREFIX + "resource:config", storeCfg);

        return { count: count, newCount: newCount, sent: sent };
    } catch (e) {
        results.resources[rid] = { error: e.message || String(e) };
        return null;
    }
}

// From bandbbs.js
// Append a poll audit record to bandbbs:poll-log list (newest first)
async function appendPollLog(redis, polled, mode, newReviews, sent) {
    try {
        var entry = {
            at: new Date().toISOString(),
            mode: mode,
            resources: polled,
            newReviews: newReviews,
            rewardsSent: sent,
        };
        await redis.lpush(REDIS_PREFIX + "poll-log", JSON.stringify(entry));
        // keep log bounded to newest 100 entries via ltrim
        if (redis.ltrim) {
            await redis.ltrim(REDIS_PREFIX + "poll-log", 0, 99).catch(function(){});
        }
    } catch (e) {}
}

// Poll a single resource by id (manual per-resource button)
async function pollResource(redis, resourceId) {
    var configs = await getConfig(redis);
    var cfg = null;
    for (var i = 0; i < configs.length; i++) {
        if (configs[i].resourceId === resourceId) { cfg = configs[i]; break; }
    }
    if (!cfg) return { success: false, error: "resource not configured: " + resourceId };
    var results = { resources: {}, newReviews: 0, rewards: { sent: 0, skipped: 0, errors: 0 }, details: [], duration: 0 };
    var startTime = Date.now();
    var res = await pollOne(redis, cfg, results);
    results.duration = Date.now() - startTime;
    var polled = res ? [{ resourceId: cfg.resourceId, title: cfg.title, count: res.count, newCount: res.newCount, sent: res.sent }] : [];
    await appendPollLog(redis, polled, "manual", results.newReviews, results.rewards.sent);
    return { success: true, results: results };
}

// Detailed view: all reviews of a resource with per-user reward status
async function getResourceDetail(redis, resourceId) {
    var configs = await getConfig(redis);
    var cfg = null;
    for (var i = 0; i < configs.length; i++) {
        if (configs[i].resourceId === resourceId) { cfg = configs[i]; break; }
    }
    if (!cfg) return { success: false, error: "resource not configured: " + resourceId };

    var reviews = await redis.hgetall(REDIS_PREFIX + "reviews:" + resourceId);
    reviews = reviews || {};
    var rewarded = await redis.hgetall(REDIS_PREFIX + "rewarded:" + resourceId);
    rewarded = rewarded || {};

    var reviewList = [];
    var keys = Object.keys(reviews);
    for (var j = 0; j < keys.length; j++) {
        try { reviewList.push(JSON.parse(reviews[keys[j]])); } catch (e) {}
    }
    reviewList.sort(function(a, b) { return (b.time || "").localeCompare(a.time || ""); });

    // Decorate each review with reward status
    reviewList = reviewList.map(function(r) {
        var rewardObj = null;
        try { if (rewarded[r.username]) rewardObj = JSON.parse(rewarded[r.username]); } catch (e) {}
        r.rewarded = !!rewardObj;
        r.reward = rewardObj || null;
        // 需求④：回填所得奖品池 ID（兑换码）与发放时间，供「获奖名单」直接渲染。
        // 关联键 = rewarded:<resourceId> 哈希的 username 字段（记录内 coupon_code / dm_sent_at）。
        r.couponCode = rewardObj ? (rewardObj.coupon_code || rewardObj.couponCode || "") : "";
        r.assignedAt = rewardObj ? (rewardObj.dm_sent_at || rewardObj.assignedAt || "") : "";
        return r;
    });

    return { success: true, data: {
        resourceId: cfg.resourceId,
        title: cfg.title,
        enabled: cfg.enabled,
        lastPollAt: cfg.lastPollAt,
        lastPollCount: cfg.lastPollCount,
        lastPollNew: cfg.lastPollNew,
        reviews: reviewList,
        rewardedCount: Object.keys(rewarded).length,
    } };
}

// Read recent poll audit records
async function getPollLogs(redis, limit) {
    var n = limit || 50;
    var rows = await redis.lrange(REDIS_PREFIX + "poll-log", 0, n - 1).catch(function() { return []; });
    if (!Array.isArray(rows)) rows = [];
    var logs = [];
    for (var i = 0; i < rows.length; i++) {
        try { logs.push(JSON.parse(rows[i])); } catch (e) {}
    }
    return logs;
}

// ── 5) Get stats for admin panel ──
async function getStats(redis) {
    var configs = await getConfig(redis);
    var stats = { resources: [], totalReviews: 0, totalRewarded: 0, lastPoll: null };

    for (var i = 0; i < configs.length; i++) {
        var cfg = configs[i];
        var reviewCount = await redis.hlen(REDIS_PREFIX + "reviews:" + cfg.resourceId);
        reviewCount = reviewCount || 0;
        var rewardedCount = await redis.hlen(REDIS_PREFIX + "rewarded:" + cfg.resourceId);
        rewardedCount = rewardedCount || 0;

        stats.resources.push({
            resourceId: cfg.resourceId,
            title: cfg.title,
            enabled: cfg.enabled,
            reviewCount: reviewCount,
            rewardedCount: rewardedCount,
            lastPollAt: cfg.lastPollAt,
            lastPollCount: cfg.lastPollCount,
            lastPollNew: cfg.lastPollNew
        });

        stats.totalReviews += reviewCount;
        stats.totalRewarded += rewardedCount;
        if (!stats.lastPoll || (cfg.lastPollAt && cfg.lastPollAt > stats.lastPoll)) {
            stats.lastPoll = cfg.lastPollAt;
        }
    }

    return stats;
}

// ── 6) Get/set resource config ──
async function getConfig(redis) {
    var raw = await redis.hgetall(REDIS_PREFIX + "resource:config");
    raw = raw || {};
    var configs = [];
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
        try {
            var c = JSON.parse(raw[keys[i]]);
            if (!c || typeof c !=="object" || Array.isArray(c)) continue;
            c.resourceId = keys[i];
            configs.push(c);
        } catch (e) {}
    }
    return configs;
}

async function saveConfig(redis, resourceId, data) {
    var existing = {};
    try {
        var raw = await redis.hget(REDIS_PREFIX + "resource:config", resourceId);
        if (raw) existing = JSON.parse(raw);
    } catch (e) {}
    var merged = Object.assign({}, existing, data);
    merged.resourceId = resourceId;
    merged.updatedAt = new Date().toISOString();
    if (!merged.createdAt) merged.createdAt = merged.updatedAt;
    if (merged.enabled === undefined) merged.enabled = true;
    if (!merged.title) merged.title = "Resource #" + resourceId;
    var storeMerged = {};
    storeMerged[resourceId] = JSON.stringify(merged);
    await redis.hset(REDIS_PREFIX + "resource:config", storeMerged);
    return merged;
}

async function deleteConfig(redis, resourceId) {
    await redis.hdel(REDIS_PREFIX + "resource:config", resourceId);
    return { deleted: true };
}

// ── 7) Reward Pool Management ──

// Get/set reward DM template
async function getRewardTemplate(redis) {
    var tpl = await redis.get(REDIS_PREFIX + "reward:template");
    return tpl || "Thank you for your 5-star review! Here is a free EV Schedule Pro as a gift. Click the link to claim on Aifadian:";
}

async function saveRewardTemplate(redis, template) {
    await redis.set(REDIS_PREFIX + "reward:template", template);
    return { success: true };
}

// Import reward links: each line is one afdian redeem URL
async function importRewardLinks(redis, linksText) {
    if (!linksText || !linksText.trim()) {
        return { success: false, error: "no links provided" };
    }
    var lines = linksText.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l; });
    if (!lines.length) {
        return { success: false, error: "no valid links found" };
    }

    var imported = 0;
    var skipped = 0;
    var errors = [];

    for (var i = 0; i < lines.length; i++) {
        var link = lines[i];
        var codeMatch = link.match(/\/redeem\/([a-zA-Z0-9]+)/);
        if (!codeMatch) {
            errors.push("Line " + (i + 1) + ": invalid redeem URL format - " + link.substring(0, 60));
            continue;
        }
        var couponCode = codeMatch[1];

        var existing = await redis.hget(REDIS_PREFIX + "reward:pool", couponCode);
        if (existing) {
            skipped++;
            continue;
        }

        var goSlug = "evpro-" + couponCode;
        var goUrl = "https://evbox.cc/go/" + goSlug;

        var goEntry = {
            target_url: link,
            enabled: true,
            name_zh: "EV Pro Reward " + couponCode.substring(0, 8),
            name_en: "EV Pro Reward " + couponCode.substring(0, 8),
            note: "Auto-generated from reward pool import"
        };
        var goStore = {};
        goStore[goSlug] = JSON.stringify(goEntry);
        await redis.hset("go:mapping", goStore);

        var rewardEntry = {
            couponCode: couponCode,
            redeemUrl: link,
            goSlug: goSlug,
            goUrl: goUrl,
            assigned: false,
            assignedTo: null,
            assignedFor: null,
            assignedAt: null,
            resourceId: null,
            reviewStars: null,
            reviewContent: null,
            claimed: false,
            claimedAt: null
        };
        var store = {};
        store[couponCode] = JSON.stringify(rewardEntry);
        await redis.hset(REDIS_PREFIX + "reward:pool", store);

        imported++;
    }

    return {
        success: true,
        imported: imported,
        skipped: skipped,
        errors: errors,
        total: imported + skipped
    };
}

// Get reward pool stats
async function getRewardPoolStats(redis) {
    var pool = await redis.hgetall(REDIS_PREFIX + "reward:pool");
    pool = pool || {};
    var total = Object.keys(pool).length;
    var assigned = 0;
    var claimed = 0;
    for (var k in pool) {
        if (!pool.hasOwnProperty(k)) continue;
        try {
            var entry = JSON.parse(pool[k]);
            if (entry.assigned) assigned++;
            if (entry.claimed) claimed++;
        } catch (e) {}
    }
    return {
        success: true,
        data: {
            total: total,
            assigned: assigned,
            claimed: claimed,
            remaining: total - assigned
        }
    };
}

// List ALL reward pool entries (incl. unassigned) — 需求②：奖品池 Tab「全部奖品名单」
async function rewardPoolList(redis, opts) {
    opts = opts || {};
    var status = opts.status || "all";
    var batch = opts.batch || "";
    var limit = Number(opts.limit) > 0 ? Number(opts.limit) : 500;
    var offset = Number(opts.offset) > 0 ? Number(opts.offset) : 0;

    var pool = await redis.hgetall(REDIS_PREFIX + "reward:pool");
    pool = pool || {};

    var counts = { all: 0, unassigned: 0, claimed: 0, unclaimed: 0, assigned: 0 };
    var entries = [];
    var keys = Object.keys(pool);
    keys.sort();
    for (var i = 0; i < keys.length; i++) {
        var entry;
        try { entry = JSON.parse(pool[keys[i]]); } catch (e) { continue; }
        var st = !entry.assigned ? "unassigned" : (entry.claimed ? "claimed" : "unclaimed");
        counts.all++;
        counts[st]++;
        if (status !== "all" && st !== status) continue;
        if (batch && String(entry.batch || "") !== String(batch)) continue;
        entries.push(entry);
    }
    counts.assigned = counts.claimed + counts.unclaimed;

    // 未发放优先，其余按发放时间倒序
    entries.sort(function(a, b) {
        var sa = a.assigned ? 1 : 0, sb = b.assigned ? 1 : 0;
        if (sa !== sb) return sa - sb;
        return String(b.assignedAt || "").localeCompare(String(a.assignedAt || ""));
    });

    var page = entries.slice(offset, offset + limit).map(function(e) {
        // 安全：列表只回掩码链接 —— 完整兑换链接（=奖品本体）仅单条详情返回，避免整池泄露
        var raw = e.redeemUrl || e.goUrl || "";
        var slash = raw.lastIndexOf("/");
        // 只保留到最后一个 "/" 之前（形如 https://afdian.com/redeem/…），不泄露兑换码本体
        var masked = raw ? (slash > 8 ? raw.substring(0, slash + 1) + "\u2026" : raw.substring(0, 12) + "\u2026") : "";
        return {
            couponCode: e.couponCode || "",
            goSlug: e.goSlug || "",
            goUrl: masked,
            assigned: !!e.assigned,
            claimed: !!e.claimed,
            assignedTo: e.assignedTo || "",
            assignedFor: e.assignedFor || "",
            resourceId: e.resourceId || "",
            reviewStars: e.reviewStars,
            assignedAt: e.assignedAt || "",
            batch: e.batch || ""
        };
    });

    return { success: true, data: { items: page, total: entries.length, counts: counts } };
}

// Get reward distribution log
async function getRewardLog(redis, resourceId, statusFilter, limit) {
    var n = limit || 100;
    var pool = await redis.hgetall(REDIS_PREFIX + "reward:pool");
    pool = pool || {};

    var entries = [];
    var keys = Object.keys(pool);
    for (var i = 0; i < keys.length; i++) {
        try {
            var entry = JSON.parse(pool[keys[i]]);
            if (!entry.assigned) continue;
            entries.push(entry);
        } catch (e) {}
    }

    if (resourceId) {
        entries = entries.filter(function(e) { return String(e.resourceId) === String(resourceId); });
    }
    if (statusFilter === "claimed") {
        entries = entries.filter(function(e) { return e.claimed; });
    } else if (statusFilter === "unclaimed") {
        entries = entries.filter(function(e) { return !e.claimed; });
    }

    entries.sort(function(a, b) { return (b.assignedAt || "").localeCompare(a.assignedAt || ""); });

    return {
        success: true,
        data: entries.slice(0, n)
    };
}

// Send rewards for a specific resource using pool links
async function sendRewards(redis, resourceId, testMode) {
    if (!resourceId) return { success: false, error: "missing resourceId" };

    var configs = await getConfig(redis);
    var cfg = null;
    for (var i = 0; i < configs.length; i++) {
        if (configs[i].resourceId === resourceId) { cfg = configs[i]; break; }
    }
    if (!cfg) return { success: false, error: "resource not configured: " + resourceId };

    var reviews = await redis.hgetall(REDIS_PREFIX + "reviews:" + resourceId);
    reviews = reviews || {};
    var rewarded = await redis.hgetall(REDIS_PREFIX + "rewarded:" + resourceId);
    rewarded = rewarded || {};

    var pool = await redis.hgetall(REDIS_PREFIX + "reward:pool");
    pool = pool || {};

    var availableLinks = [];
    var poolKeys = Object.keys(pool);
    for (var j = 0; j < poolKeys.length; j++) {
        try {
            var pe = JSON.parse(pool[poolKeys[j]]);
            if (!pe.assigned) availableLinks.push({ key: poolKeys[j], entry: pe });
        } catch (e) {}
    }

    // 随机发奖（需求③）：先按 key 排序消除 Redis hash 返回顺序的不确定性，
    // 再用 Fisher-Yates 洗牌 —— 等价「无放回随机抽样」，
    // 保证同一批内不重复抽到同一条，且每批分布不同（原为顺序取用 availableLinks[r]）。
    availableLinks.sort(function(a, b) { return String(a.key).localeCompare(String(b.key)); });
    for (var sh = availableLinks.length - 1; sh > 0; sh--) {
        var sw = Math.floor(Math.random() * (sh + 1));
        var tmpLink = availableLinks[sh];
        availableLinks[sh] = availableLinks[sw];
        availableLinks[sw] = tmpLink;
    }

    var eligible = [];
    var reviewKeys = Object.keys(reviews);
    for (var k = 0; k < reviewKeys.length; k++) {
        try {
            var rv = JSON.parse(reviews[reviewKeys[k]]);
            var stars = rv.stars;
            if (typeof stars === "string") stars = (stars.match(/★/g) || []).length;
            if (Number(stars) >= 5 && !rewarded[rv.username]) {
                eligible.push({ key: reviewKeys[k], review: rv });
            }
        } catch (e) {}
    }

    if (!eligible.length) {
        return { success: true, sent: 0, skipped: 0, errors: 0, message: "no eligible 5-star unrewarded reviews" };
    }

    if (!availableLinks.length) {
        return { success: false, error: "no available reward links in pool", notEnough: eligible.length };
    }

    var template = await getRewardTemplate(redis);
    var sentCount = 0;
    var skippedCount = 0;
    var errorCount = 0;
    var conflictCount = 0;
    var poolCursor = 0;

    for (var r = 0; r < eligible.length; r++) {
        // 乐观锁（需求③）：从洗牌后的队列取下一个「未被占用」的池条目，
        // 写入前再读回校验 assigned —— 防止 cron 与手动并发时把同一份奖品发给两个人。
        var linkItem = null;
        while (poolCursor < availableLinks.length) {
            var cand = availableLinks[poolCursor++];
            try {
                var freshRaw = await redis.hget(REDIS_PREFIX + "reward:pool", cand.key);
                if (freshRaw) {
                    var freshEntry = JSON.parse(freshRaw);
                    if (freshEntry.assigned) { conflictCount++; continue; }
                    cand.entry = freshEntry;
                }
            } catch (e) {}
            linkItem = cand;
            break;
        }
        if (!linkItem) {
            skippedCount = eligible.length - r;
            break;
        }

        var el = eligible[r];
        var reviewer = el.review;
        var couponEntry = linkItem.entry;

        var dmTitle = "Thanks for your 5-star review!";
        var dmMessage = template + "\\n" + couponEntry.goUrl;

        var recipient = testMode ? TEST_RECIPIENT : reviewer.username;

        try {
            var dmResult = await sendDm(recipient, dmTitle, dmMessage);
            if (dmResult.success) {
                couponEntry.assigned = true;
                couponEntry.assignedTo = reviewer.username;
                couponEntry.assignedFor = el.key;
                couponEntry.assignedAt = new Date().toISOString();
                couponEntry.resourceId = resourceId;
                couponEntry.reviewStars = reviewer.stars;
                couponEntry.reviewContent = (reviewer.content || "").substring(0, 100);
                if (testMode) {
                    couponEntry.testMode = true;
                }
                var poolStore = {};
                poolStore[linkItem.key] = JSON.stringify(couponEntry);
                await redis.hset(REDIS_PREFIX + "reward:pool", poolStore);

                var rewardRecord = {
                    dm_sent_at: new Date().toISOString(),
                    conv_id: dmResult.conversationId,
                    conv_url: dmResult.conversationUrl,
                    test_mode: testMode,
                    actual_recipient: reviewer.username,
                    coupon_code: couponEntry.couponCode,
                    go_url: couponEntry.goUrl
                };
                var storeReward = {};
                storeReward[reviewer.username] = JSON.stringify(rewardRecord);
                await redis.hset(REDIS_PREFIX + "rewarded:" + resourceId, storeReward);

                sentCount++;
            } else {
                errorCount++;
            }
        } catch (e) {
            errorCount++;
        }
    }

    if (eligible.length > availableLinks.length) {
        return {
            success: true,
            sent: sentCount,
            skipped: 0,
            errors: errorCount,
            conflicts: conflictCount,
            notEnough: eligible.length - availableLinks.length
        };
    }

    return {
        success: true,
        sent: sentCount,
        skipped: skippedCount,
        errors: errorCount,
        conflicts: conflictCount
    };
}



/**
 * 手动发奖（运营用）：给「指定资源 + 指定用户」立即发一份奖品。
 *
 * 与 sendRewards 的区别：sendRewards 是「按资源批量补给所有 5 星未发者」，
 * 这里只发一个人，且**不要求 5 星**——运营在后台点某一行就能发（补发 / 破例发放）。
 * 写入字段与 sendRewards 完全一致（pool 条目 + rewarded:<rid>），保证前端口径与日志统一。
 *
 * opts:
 *   · force  —— 该用户本资源已发过也重发（复用原链接，不二次占用奖品）
 *   · dryRun —— 只校验可行性（有链接 / 是否已发），不发私信、不写库（联调与自检用）
 */
async function rewardOne(redis, resourceId, username, opts) {
    opts = opts || {};
    if (!resourceId) return { success: false, error: "missing resourceId" };
    if (!username) return { success: false, error: "missing username" };

    var rewarded = (await redis.hgetall(REDIS_PREFIX + "rewarded:" + resourceId)) || {};
    var already = !!rewarded[username];
    if (already && !opts.force) {
        return { success: false, alreadyRewarded: true, user: username, error: "该用户本资源已发过奖（勾选「重发」可复用原链接重发）" };
    }

    // 取 TA 在这条资源下的评论（星级/内容要写进奖品记录，便于对账）
    var reviews = (await redis.hgetall(REDIS_PREFIX + "reviews:" + resourceId)) || {};
    var reviewKey = null, review = null;
    Object.keys(reviews).forEach(function(k) {
        if (reviewKey) return;
        try {
            var rv = JSON.parse(reviews[k]);
            if (rv && String(rv.username) === String(username)) { reviewKey = k; review = rv; }
        } catch (e) {}
    });

    // 选链接：优先复用「已分配给 TA 且未被领取」的那条（force 重发必须复用，否则重复占用奖品）；
    // 否则从池里随机取一条未分配的（与 sendRewards 同款：排序 + Fisher-Yates，消除 Redis 返回顺序不确定性）。
    var pool = (await redis.hgetall(REDIS_PREFIX + "reward:pool")) || {};
    var reuseKey = null, reuseEntry = null, avail = [];
    Object.keys(pool).forEach(function(k) {
        try {
            var e = JSON.parse(pool[k]);
            if (e.assigned && !e.claimed && String(e.assignedTo) === String(username) &&
                String(e.resourceId) === String(resourceId)) {
                if (!reuseKey) { reuseKey = k; reuseEntry = e; }
            } else if (!e.assigned) {
                avail.push({ key: k, entry: e });
            }
        } catch (err) {}
    });
    avail.sort(function(a, b) { return String(a.key).localeCompare(String(b.key)); });
    for (var sh = avail.length - 1; sh > 0; sh--) {
        var sw = Math.floor(Math.random() * (sh + 1));
        var tmp = avail[sh]; avail[sh] = avail[sw]; avail[sw] = tmp;
    }
    var pick = reuseEntry ? { key: reuseKey, entry: reuseEntry } : (avail.length ? avail[0] : null);
    if (!pick) {
        return { success: false, noLink: true, error: "奖品池没有可用链接（未发放的奖品已用尽）" };
    }
    if (opts.dryRun) {
        return {
            success: true, dryRun: true, user: username, resourceId: resourceId,
            reusedLink: !!reuseEntry, couponCode: pick.entry.couponCode || "",
            alreadyRewarded: already, stars: review ? review.stars : null
        };
    }

    // 乐观锁：写入前回读，避免与 cron / 手动批量并发时把同一条发给两个人
    try {
        var freshRaw = await redis.hget(REDIS_PREFIX + "reward:pool", pick.key);
        if (freshRaw) {
            var freshEntry = JSON.parse(freshRaw);
            if (freshEntry.assigned && String(freshEntry.assignedTo) !== String(username)) {
                return { success: false, conflict: true, error: "该奖品链接刚被他人占用，请重试" };
            }
            pick.entry = freshEntry;
        }
    } catch (e) {}

    var couponEntry = pick.entry;
    var template = await getRewardTemplate(redis);
    var dmTitle = "Thanks for your 5-star review!";
    var dmMessage = template + "\n" + couponEntry.goUrl;

    var dmResult = null;
    try {
        dmResult = await sendDm(username, dmTitle, dmMessage);
    } catch (e) {
        return { success: false, error: "私信发送异常：" + (e.message || e) };
    }
    if (!dmResult || !dmResult.success) {
        return { success: false, error: "私信发送失败", dm: dmResult };
    }

    couponEntry.assigned = true;
    couponEntry.assignedTo = username;
    couponEntry.assignedFor = reviewKey || "";
    couponEntry.assignedAt = new Date().toISOString();
    couponEntry.resourceId = resourceId;
    couponEntry.reviewStars = review ? review.stars : undefined;
    couponEntry.reviewContent = review ? String(review.content || "").substring(0, 100) : "";
    couponEntry.manual = true;   // 标记：本条是手动发放（对账时可区分自动/手动）

    var poolStore = {};
    poolStore[pick.key] = JSON.stringify(couponEntry);
    await redis.hset(REDIS_PREFIX + "reward:pool", poolStore);

    var rewardRecord = {
        dm_sent_at: new Date().toISOString(),
        conv_id: dmResult.conversationId,
        conv_url: dmResult.conversationUrl,
        test_mode: false,
        manual: true,
        actual_recipient: username,
        coupon_code: couponEntry.couponCode,
        go_url: couponEntry.goUrl
    };
    var storeReward = {};
    storeReward[username] = JSON.stringify(rewardRecord);
    await redis.hset(REDIS_PREFIX + "rewarded:" + resourceId, storeReward);

    return {
        success: true, sent: 1, user: username, resourceId: resourceId,
        couponCode: couponEntry.couponCode || "",
        assignedAt: couponEntry.assignedAt,
        reusedLink: !!reuseEntry
    };
}

module.exports = {
    login: login,
    diagnosticLogin: diagnosticLogin,
    fetchReviews: fetchReviews,
    sendDm: sendDm,
    pollAndReward: pollAndReward,
    pollResource: pollResource,
    getStats: getStats,
    getResourceDetail: getResourceDetail,
    rewardPoolList: rewardPoolList,
    getPollLogs: getPollLogs,
    getConfig: getConfig,
    saveConfig: saveConfig,
    deleteConfig: deleteConfig,
    getRewardTemplate: getRewardTemplate,
    saveRewardTemplate: saveRewardTemplate,
    importRewardLinks: importRewardLinks,
    getRewardPoolStats: getRewardPoolStats,
    getRewardLog: getRewardLog,
    sendRewards: sendRewards,
    rewardOne: rewardOne,
    BASE_URL: BASE_URL,
};