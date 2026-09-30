/*
 * track.js — 全站统一的访客埋点（P2 / D1）
 *
 * 为什么要统一：以前是每个页面各自复制一段 XHR，结果
 *   activation-guide.html / android-apk.html / pages.html 三页漏埋，
 *   apk-download.html 还用了老 WebView 不支持的 fetch（实际等于没上报）。
 *   改这里一处，全站同步。
 *
 * 接入方式（一行，放在 </body> 前）：
 *   <script src="/js/track.js" data-group="guide"></script>
 *
 * data-* 属性：
 *   data-group  页面分组：guide | download | activate | home | tool  （画像汇总按它出分组报表）
 *   data-page   覆盖上报的 path（默认 location.pathname + location.search，一般不用写）
 *   data-ref    来源标记，仅在浏览器不给 document.referrer 时兜底
 *
 * 页面需要额外埋一次「点击」时，调：
 *   WBTrack.send({ path: location.pathname, query: 'dl=xxx', group: 'download' })
 *
 * ⚠️ 兼容约定（与站内其它埋点一致，勿改）：只用 var + XMLHttpRequest，
 *    **不用** fetch / 箭头函数 / 模板字符串 / const —— 老 WebView 会整段语法报错。
 *    上报失败一律静默（埋点绝不能影响页面功能）。
 *
 * 服务端：POST /api/activate?section=visitor-track
 *   body { path, query, group, ref }
 *   path 带 search → 服务端拆成 path + query 两列并落 visitor_logs.params；
 *   group 写入 tracking_events.payload.group（D5），也接受 URL 上的 g= 参数。
 */
(function () {
  "use strict";

  var API = "/api/activate?section=visitor-track";

  function post(body) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", API, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify(body));
    } catch (e) {}
  }

  // 取自己的 <script> 标签：document.currentScript 在老 WebView 上常为 null，退回按 src 找
  function selfTag() {
    var s = document.currentScript;
    if (s && s.getAttribute && s.getAttribute("src")) return s;
    var all = document.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) {
      if (String(all[i].getAttribute("src") || "").indexOf("/js/track.js") >= 0) return all[i];
    }
    return null;
  }

  var TAG = selfTag();

  function attr(name) {
    return (TAG && TAG.getAttribute && TAG.getAttribute(name)) || "";
  }

  function send(extra) {
    extra = extra || {};
    post({
      path: extra.path || attr("data-page") || (location.pathname + location.search),
      query: extra.query || "",
      group: extra.group || attr("data-group") || "",
      ref: extra.ref || document.referrer || attr("data-ref") || "",
    });
  }

  window.WBTrack = { send: send };

  // 页面浏览：自动上报一次
  send();
})();
