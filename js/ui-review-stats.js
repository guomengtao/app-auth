/*
 * ui-review-stats.js —— 截图排查页「统一统计 + 反馈管理」单一来源（各型号页面共用）
 *
 * 接入（每个排查页都要做，两步）：
 *   1. 声明本页型号（必须只有一个）：
 *      <script>window.UI_REVIEW_MODEL = { projectId:"ev-schedule-soundmini", model:"小爱音箱 Mini", lcd:"800x480" };</script>
 *   2. <script src="/js/ui-review-stats.js"></script>（放在 review-widget.js 之后）
 *
 * 做三件事：
 *   ① 型号隔离守卫：页面里所有 .shot-unit[data-project] 必须同属一个 projectId。
 *      出现别的型号 → 控制台报错 + 页面顶部红色告警条（禁止跨型号混图 / 混反馈）。
 *   ② 统计条：拉 GET /api/admin/review?projectId=… 汇总「截图数 / 已反馈 / 待修 / 待重采 / 已修」，
 *      按页分布也一并给出，方便排优先级。接口取不到时降级为本地计数（不报错、不挡页面）。
 *   ③ 反馈角标：有反馈的截图自动打角标（待修/待重采/已修/已删除），点角标跳反馈锚点。
 *
 * 注意：本文件是所有排查页的单一来源，升级改这里即可全局同步；接入方只调用，不 fork、不修改。
 */
(function () {
  "use strict";

  var MODEL = window.UI_REVIEW_MODEL || {};
  var PID = MODEL.projectId || "";
  var MODEL_NAME = MODEL.model || "（未声明型号）";
  var ACTION_CN = { fix: "待修", recapture: "待重采", delete: "已删除", resolved: "已修复" };
  var PENDING = { fix: 1, recapture: 1 };

  function units() {
    return Array.prototype.slice.call(document.querySelectorAll(".shot-unit[data-project]"));
  }

  // ── ① 型号隔离守卫 ────────────────────────────────────────────────
  function guard() {
    var found = {};
    units().forEach(function (u) { found[u.getAttribute("data-project")] = 1; });
    var ids = Object.keys(found);
    if (!PID) {
      warn("本页没有声明 window.UI_REVIEW_MODEL.projectId，无法确认型号归属");
      return;
    }
    var alien = ids.filter(function (i) { return i !== PID; });
    if (alien.length) {
      warn("本页混入了其他型号的截图单元：" + alien.join("、") +
           "（每页只允许出现自己型号 " + PID + " 的内容）");
    }
  }

  function warn(msg) {
    console.error("[ui-review-stats] " + msg);
    var bar = document.createElement("div");
    bar.style.cssText = "background:#dc2626;color:#fff;padding:8px 16px;font-size:.85rem;z-index:99;position:relative";
    bar.textContent = "⚠️ " + msg;
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // ── ② 统计条 ──────────────────────────────────────────────────────
  function barHtml(s) {
    function chip(label, n, color) {
      return '<span class="rs-chip" style="background:' + color + '">' + label + ' <b>' + n + '</b></span>';
    }
    return '<div class="rs-wrap">' +
      '<span class="rs-title">型号 ' + MODEL_NAME + ' · 反馈统计</span>' +
      chip("截图", s.shots, "#6b7280") +
      chip("已反馈", s.feedback, "#6c63ff") +
      chip("待修", s.fix, "#dc2626") +
      chip("待重采", s.recapture, "#f59e0b") +
      chip("已修", s.resolved, "#16a34a") +
      (s.deleted ? chip("已删除", s.deleted, "#111827") : "") +
      '<span class="rs-hint">（数据来自 /api/admin/review?projectId=' + PID + '）</span>' +
      '</div>';
  }

  function injectBar(s) {
    var host = document.getElementById("reviewStats");
    if (!host) {
      host = document.createElement("div");
      var top = document.querySelector(".topbar");
      if (top && top.parentNode) { top.parentNode.insertBefore(host, top.nextSibling); }
      else { document.body.insertBefore(host, document.body.firstChild); }
    }
    host.innerHTML = barHtml(s);
  }

  function localStats() {
    return { shots: units().length, feedback: 0, fix: 0, recapture: 0, resolved: 0, deleted: 0 };
  }

  // ── ③ 反馈角标 ────────────────────────────────────────────────────
  function markUnits(items) {
    var map = {};
    items.forEach(function (it) {
      map[(it.pageId || "") + "|" + (it.shotFile || "")] = it;
    });
    units().forEach(function (u) {
      var key = (u.getAttribute("data-page") || "") + "|" + (u.getAttribute("data-file") || "");
      var it = map[key];
      if (!it || it.action === "delete") { return; }
      var tag = document.createElement("span");
      tag.className = "rs-badge";
      tag.textContent = ACTION_CN[it.action] || it.action;
      tag.style.cssText = "position:absolute;right:2px;top:2px;z-index:3;background:" +
        (it.action === "fix" ? "#dc2626" : it.action === "recapture" ? "#f59e0b" : "#16a34a") +
        ";color:#fff;font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:9px";
      if (u.style.position !== "relative") { u.style.position = "relative"; }
      u.appendChild(tag);
    });
  }

  function load() {
    var s = localStats();
    if (!PID) { injectBar(s); return; }
    fetch("/api/admin/review?projectId=" + encodeURIComponent(PID))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(function (d) {
        var items = d && d.items ? d.items : [];
        var stat = { shots: s.shots, feedback: items.length, fix: 0, recapture: 0, resolved: 0, deleted: 0 };
        items.forEach(function (it) {
          if (it.action === "delete") { stat.deleted++; }
          else if (stat[it.action] != null) { stat[it.action]++; }
        });
        injectBar(stat);
        markUnits(items);
      })
      .catch(function (e) {
        console.warn("[ui-review-stats] 统计拉取失败，降级为本地计数：", e);
        injectBar(s);
      });
  }

  function boot() {
    guard();
    load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
