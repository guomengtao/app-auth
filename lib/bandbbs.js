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

    // Step 2: fetch DM compose page
    var dmPage = await httpGet(BASE_URL + "/direct-messages/add", BASE_URL + "/login");
    if (dmPage.body.indexOf("/login") !== -1) {
        return { success: false, error: "not authenticated after login (redirected to login)" };
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
        var reviews = await redis.hgetall(REDIS_PREFIX + "reviews:" + cfg.resourceId);
        reviews = reviews || {};
        var rewarded = await redis.hgetall(REDIS_PREFIX + "rewarded:" + cfg.resourceId);
        rewarded = rewarded || {};

        var reviewList = [];
        var keys = Object.keys(reviews);
        for (var j = 0; j < keys.length; j++) {
            try { reviewList.push(JSON.parse(reviews[keys[j]])); } catch (e) {}
        }
        reviewList.sort(function(a, b) { return (b.time || "").localeCompare(a.time || ""); });

        var rewardUsers = Object.keys(rewarded);

        stats.resources.push({
            resourceId: cfg.resourceId,
            title: cfg.title,
            enabled: cfg.enabled,
            reviewCount: reviewList.length,
            rewardedCount: rewardUsers.length,
            lastPollAt: cfg.lastPollAt,
            lastPollCount: cfg.lastPollCount,
            lastPollNew: cfg.lastPollNew,
            recentReviews: reviewList.slice(0, 10),
            rewardedUsers: rewardUsers,
        });

        stats.totalReviews += reviewList.length;
        stats.totalRewarded += rewardUsers.length;
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

module.exports = {
    login: login,
    fetchReviews: fetchReviews,
    sendDm: sendDm,
    pollAndReward: pollAndReward,
    pollResource: pollResource,
    getStats: getStats,
    getResourceDetail: getResourceDetail,
    getPollLogs: getPollLogs,
    getConfig: getConfig,
    saveConfig: saveConfig,
    deleteConfig: deleteConfig,
    BASE_URL: BASE_URL,
};