/*
 * site-nav.js — 全站前台页面目录 / 分类导航（单一来源）
 *
 * 接入（放在 </body> 前）：
 *   目录页（index.html）：
 *     <script src="/js/site-nav.js"></script>
 *     <script>SiteNav.mountCatalog('catalog');</script>
 *   其它前台页（ui-gallery / android-apk …）：
 *     <script src="/js/site-nav.js"></script>
 *     <script>SiteNav.mountNav('siteNavAnchor', 'ui-gallery-9');</script>
 *
 * 分类与页面清单只维护这里一处，全站同步。
 *
 * ⚠️ 兼容约束（与站内一致）：只用 var + 普通函数 + 字符串拼接，
 *    **不用** const / let / 箭头函数 / 模板字符串 / fetch。
 */
(function () {
  "use strict";

  // ── 分类（顺序即展示顺序）──
  var GROUPS = [
    { id: "activate", name: "激活 · 兑换" },
    { id: "guide",    name: "教程 · 指南" },
    { id: "archive",  name: "档案 · 截图" },
    { id: "product",  name: "下载 · 产品" },
    { id: "tool",     name: "工具 · 服务" }
  ];

  // ── 前台页面清单（含后台三页与测试页除外）──
  var PAGES = [
    { id: "activate",         name: "设备激活",       url: "/activate.html",       group: "activate", desc: "输入兑换码获取激活码", primary: true },
    { id: "user-guide",       name: "用户手册",       url: "/user-guide.html",     group: "activate", desc: "购买兑换码 → 激活流程指引" },
    { id: "activation-guide", name: "高级版激活流程",  url: "/activation-guide.html", group: "activate", desc: "图文 / 动画教学，如何解锁高级版" },
    { id: "redeem-counts",    name: "兑换码数量",     url: "/redeem-counts.html",  group: "activate", desc: "剩余可用兑换码统计" },

    { id: "course-guide",     name: "使用教程",       url: "/course-guide.html",   group: "guide",    desc: "添加 / 编辑课程教程" },

    { id: "ui-gallery-9",     name: "手环端页面总览",  url: "/ui-gallery-9.html",  group: "archive",  desc: "手环端逐页截图档案（排障索引）" },
    { id: "android-apk",      name: "安卓 APK 总览",   url: "/android-apk.html",    group: "archive",  desc: "安卓同步器逐页截图档案" },

    { id: "apk-download",     name: "安卓版下载",      url: "/apk-download.html",  group: "product",  desc: "下载 Ev课程表同步器 APK" },
    { id: "ev-schedule",      name: "产品介绍",        url: "/ev-schedule.html",   group: "product",  desc: "小米手环课程管理产品介绍" },
    { id: "ev-timetable",     name: "课程表介绍",      url: "/ev-timetable.html",  group: "product",  desc: "手环智能课程管理介绍" },

    { id: "my-ip",            name: "我的 IP 信息",    url: "/my-ip.html",         group: "tool",     desc: "查看公网 IP 与归属地" },
    { id: "feedback",         name: "帮助与反馈",      url: "/feedback.html",      group: "tool",     desc: "问题反馈与帮助" },
    { id: "ev-login",         name: "授权设备",        url: "/ev-login.html",      group: "tool",     desc: "EvNotifier 授权设备登录" }
  ];

  function groupName(id) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === id) return GROUPS[i].name;
    return id;
  }
  function pagesOf(id) {
    var out = [];
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].group === id) out.push(PAGES[i]);
    return out;
  }
  function cardHTML(p) {
    var cls = "link-card" + (p.primary ? " primary" : "");
    return '<a class="' + cls + '" href="' + p.url + '">'
         + '<div class="lc-title">' + p.name + "</div>"
         + '<div class="lc-desc">' + p.desc + "</div>"
         + "</a>";
  }
  function getCatFromUrl() {
    try {
      var q = location.search.replace(/^\?/, "");
      var parts = q.split("&");
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split("=");
        if (kv[0] === "cat") return decodeURIComponent(kv[1] || "");
      }
    } catch (e) {}
    return "";
  }

  // ── 目录页：分类筛选条 + 分组卡片（复用 index.html 的 .link-grid/.link-card/.section-title 样式）──
  function mountCatalog(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var bar = document.createElement("div");
    bar.className = "filterbar";
    bar.id = "snFilterbar";

    var all = document.createElement("button");
    all.className = "fbtn active";
    all.setAttribute("data-cat", "*");
    all.textContent = "全部";
    all.onclick = function () { setCat("*"); };
    bar.appendChild(all);

    for (var g = 0; g < GROUPS.length; g++) {
      (function (grp) {
        var b = document.createElement("button");
        b.className = "fbtn";
        b.setAttribute("data-cat", grp.id);
        b.textContent = grp.name;
        b.onclick = function () { setCat(grp.id); };
        bar.appendChild(b);
      })(GROUPS[g]);
    }
    container.appendChild(bar);

    var sections = {};
    for (var gi = 0; gi < GROUPS.length; gi++) {
      var grp = GROUPS[gi];
      var pages = pagesOf(grp.id);
      if (!pages.length) continue;

      var sec = document.createElement("div");
      sec.className = "sn-section";
      sec.setAttribute("data-cat", grp.id);

      var title = document.createElement("div");
      title.className = "section-title";
      title.textContent = groupName(grp.id) + "（" + pages.length + "）";
      sec.appendChild(title);

      var grid = document.createElement("div");
      grid.className = "link-grid";
      var html = "";
      for (var p = 0; p < pages.length; p++) html += cardHTML(pages[p]);
      grid.innerHTML = html;
      sec.appendChild(grid);

      container.appendChild(sec);
      sections[grp.id] = sec;
    }

    function setCat(cat) {
      var btns = bar.getElementsByTagName("button");
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        b.className = "fbtn" + (b.getAttribute("data-cat") === cat ? " active" : "");
      }
      for (var key in sections) {
        if (!sections.hasOwnProperty(key)) continue;
        sections[key].style.display = (cat === "*" || cat === key) ? "block" : "none";
      }
      if (cat !== "*") {
        try {
          var t = sections[cat];
          if (t && t.scrollIntoView) t.scrollIntoView(true);
        } catch (e) {}
      }
    }

    var init = getCatFromUrl();
    if (init && sections[init]) setCat(init);
  }

  // ── 其它页：全站分类导航条（复用目标页 .filterbar/.fbtn 样式），当前分类高亮、可跳回目录 ──
  function mountNav(containerId, currentId) {
    var c = document.getElementById(containerId);
    if (!c) return;
    var curGroup = "";
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id === currentId) curGroup = PAGES[i].group;

    var bar = document.createElement("div");
    bar.className = "filterbar";

    var home = document.createElement("a");
    home.className = "fbtn";
    home.textContent = "← 全站目录";
    home.href = "/";
    bar.appendChild(home);

    for (var g = 0; g < GROUPS.length; g++) {
      var b = document.createElement("a");
      b.className = "fbtn" + (GROUPS[g].id === curGroup ? " active" : "");
      b.textContent = GROUPS[g].name;
      b.href = "/?cat=" + GROUPS[g].id;
      bar.appendChild(b);
    }
    c.appendChild(bar);
  }

  window.SiteNav = {
    mountCatalog: mountCatalog,
    mountNav: mountNav,
    GROUPS: GROUPS,
    PAGES: PAGES
  };
})();
