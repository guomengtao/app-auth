/*
 * review-widget.js — 共享审核组件（单一来源，多项目/多手环型号通用）
 *
 * 接入方 3 步：
 *   1. <script src="/js/review-widget.js"></script>
 *   2. 截图按约定结构渲染：
 *      <div class="shot-unit" data-project="<projectId>" data-page="<pageId>" data-file="<shotFile>">
 *        <div class="device"><img src="..."></div>
 *      </div>
 *   3. 渲染完成后调用 ReviewWidget.mountAll()
 *
 * 能力：多框拖选标注 / 问题多选 / 批注 / 随机昵称(可改记住) /
 *       历史记录折叠区(次数/状态) / 快捷标记(换版/删除，可点击撤销) /
 *       删除动态隐藏(可逆) / 角标状态回填
 *
 * 注意：本文件为所有接入方的单一来源，升级改这里即可全局同步；
 *       接入方只调用，不 fork、不修改。
 */
(function () {
  "use strict";

  var API = "/api/admin/review";
  var DEFAULT_PROJECT = "ev-schedule-watch9";
  var PROJECT = DEFAULT_PROJECT;
  var ITEMS = [];

  var ISSUES = ["文字遮挡", "文字省略", "标题显示不全", "布局错位", "按钮过小", "越界裁切", "对齐偏移", "颜色对比", "其他"];
  var ACTION_CN = { fix: "待修", recapture: "待重采", delete: "已删除", resolved: "已修复" };

  var CSS = [
    ".shot-unit{display:flex;flex-direction:column;align-items:center}",
    ".review-bar{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;justify-content:center}",
    ".rv-btn{border:1px solid var(--line,#e7e9f0);background:var(--surface,#fff);color:var(--ink,#1a1a2e);padding:3px 10px;border-radius:12px;font-size:.72rem;cursor:pointer}",
    ".rv-btn:hover{border-color:var(--accent,#6c63ff);color:var(--accent,#6c63ff)}",
    ".rv-btn.rv-del:hover{border-color:#e53935;color:#e53935}",
    ".rv-btn.rv-ok{border-color:#2e7d32;color:#2e7d32}",
    ".rv-btn.rv-warn{border-color:#f0a000;color:#f0a000}",
    ".device{position:relative}",
    ".anno-layer{position:absolute;inset:0;z-index:5;cursor:crosshair;background:rgba(0,0,0,0.08)}",
    ".anno-box{position:absolute;border:2px solid #ff3b30;background:rgba(255,59,48,0.15);pointer-events:none}",
    ".rv-flag{outline:3px solid #ff3b30;outline-offset:-3px}",
    ".rv-flag-resolved{outline:3px solid #2e7d32;outline-offset:-3px}",
    ".rv-flag-deleted{opacity:0.35}",
    ".review-panel{width:100%;background:var(--surface,#fff);border:1px solid var(--line,#e7e9f0);border-radius:10px;padding:8px;margin-top:6px;text-align:left}",
    ".rv-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}",
    ".rv-chip{border:1px solid var(--line,#e7e9f0);background:var(--surface,#fff);color:var(--muted,#6b7280);padding:2px 9px;border-radius:12px;font-size:.72rem;cursor:pointer}",
    ".rv-chip.on{background:var(--accent,#6c63ff);border-color:var(--accent,#6c63ff);color:#fff}",
    ".rv-boxinfo{font-size:.7rem;color:var(--muted,#6b7280);margin-bottom:5px}",
    ".rv-nick{width:40%;border:1px solid var(--line,#e7e9f0);border-radius:8px;padding:5px 8px;font-size:.78rem;box-sizing:border-box;margin-bottom:6px;margin-right:4%}",
    ".rv-note{width:100%;border:1px solid var(--line,#e7e9f0);border-radius:8px;padding:5px 8px;font-size:.78rem;box-sizing:border-box;margin-bottom:6px}",
    ".rv-actions{display:flex;gap:6px}",
    ".rv-actions .rv-btn{flex:1}",
    ".rv-msg{font-size:.7rem;color:var(--muted,#6b7280);margin-top:4px;min-height:1em}",
    ".rv-history{width:100%;background:var(--surface,#fff);border:1px solid var(--line,#e7e9f0);border-radius:10px;padding:8px;margin-top:6px;text-align:left}",
    ".rv-h-head{display:flex;justify-content:space-between;align-items:center;font-size:.72rem;color:var(--muted,#6b7280);margin-bottom:6px}",
    ".rv-h-status.ok{color:#2e7d32;font-weight:700}",
    ".rv-h-status.warn{color:#f0a000;font-weight:700}",
    ".rv-h-item{border-top:1px dashed var(--line,#e7e9f0);padding:5px 0;font-size:.74rem}",
    ".rv-h-empty{font-size:.74rem;color:var(--muted,#6b7280)}",
    ".rv-h-line1{display:flex;gap:8px;align-items:center}",
    ".rv-h-tag{background:var(--accent,#6c63ff);color:#fff;padding:1px 8px;border-radius:10px;font-size:.68rem}",
    ".rv-h-line2{color:#444;margin-top:2px}"
  ].join("\n");

  function injectCSS() {
    if (document.getElementById("rv-widget-style")) return;
    var st = document.createElement("style");
    st.id = "rv-widget-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ── 昵称：随机生成 + localStorage 记住 + 可改 ──
  function rvNick() {
    var n = "";
    try { n = localStorage.getItem("rv_nick") || ""; } catch (e) {}
    if (!n) {
      var pool = ["图虫", "快门", "像素", "描边", "像素眼", "挑刺儿", "找茬", "校对"];
      n = pool[Math.floor(Math.random() * pool.length)] + "-" + Math.floor(1000 + Math.random() * 9000);
      try { localStorage.setItem("rv_nick", n); } catch (e) {}
    }
    return n;
  }
  function rvSaveNick(v) {
    var n = String(v || "").trim().slice(0, 24);
    if (!n) return rvNick();
    try { localStorage.setItem("rv_nick", n); } catch (e) {}
    return n;
  }
  function fmtTs(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // ── 工具条 / 面板 / 历史 构建 ──
  function buildBar(unit) {
    var bar = document.createElement("div");
    bar.className = "review-bar";
    bar.innerHTML =
      '<button class="rv-btn" data-rv="review">审核</button>' +
      '<button class="rv-btn" data-rv="recapture">换最新版</button>' +
      '<button class="rv-btn rv-del" data-rv="delete">删除</button>' +
      '<button class="rv-btn" data-rv="history">记录</button>';
    unit.appendChild(bar);

    bar.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-rv]");
      if (!btn) return;
      e.stopPropagation();
      var kind = btn.getAttribute("data-rv");
      if (kind === "review") togglePanel(unit);
      else if (kind === "history") toggleHistory(unit);
      else quickMark(unit, kind, btn);
    });
  }

  function buildPanel(unit) {
    var panel = document.createElement("div");
    panel.className = "review-panel";
    panel.style.display = "none";
    var chips = "";
    for (var i = 0; i < ISSUES.length; i++) {
      chips += '<button class="rv-chip">' + ISSUES[i] + "</button>";
    }
    panel.innerHTML =
      '<div class="rv-chips">' + chips + "</div>" +
      '<div class="rv-boxinfo">在截图上按住拖框圈出问题区域（可多处框选）</div>' +
      '<input class="rv-nick" value="' + rvNick() + '" placeholder="昵称">' +
      '<input class="rv-note" placeholder="快速批注（可选）">' +
      '<div class="rv-actions">' +
      '<button class="rv-btn" data-rv-action="fix">提交审核</button>' +
      '<button class="rv-btn rv-ok" data-rv-action="resolved">已修复</button>' +
      '</div><div class="rv-msg"></div>';

    panel.addEventListener("click", function (e) {
      e.stopPropagation();
      var chip = e.target.closest(".rv-chip");
      if (chip) { chip.classList.toggle("on"); return; }
      var act = e.target.closest("[data-rv-action]");
      if (act) submitReview(unit, act.getAttribute("data-rv-action"));
    });
    unit.appendChild(panel);
    enableAnno(unit);
    return panel;
  }

  function togglePanel(unit) {
    var panel = unit.querySelector(".review-panel");
    if (!panel) panel = buildPanel(unit);
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  }

  // ── 拖框标注：多框（每次拖框新建；双击某框删除该框）──
  function enableAnno(unit) {
    var device = unit.querySelector(".device");
    var img = device.querySelector("img");
    var layer = document.createElement("div");
    layer.className = "anno-layer";
    device.appendChild(layer);
    var curBox = null, sx = 0, sy = 0, dragging = false;

    function pt(e) {
      var ir = img.getBoundingClientRect();
      var cx = Math.max(0, Math.min(ir.width, e.clientX - ir.left));
      var cy = Math.max(0, Math.min(ir.height, e.clientY - ir.top));
      return { x: cx, y: cy };
    }
    layer.addEventListener("pointerdown", function (e) {
      e.stopPropagation(); e.preventDefault();
      dragging = true;
      var p = pt(e); sx = p.x; sy = p.y;
      curBox = document.createElement("div");
      curBox.className = "anno-box";
      layer.appendChild(curBox);
      curBox.style.left = sx + "px"; curBox.style.top = sy + "px";
      curBox.style.width = "0px"; curBox.style.height = "0px";
      curBox.addEventListener("dblclick", function (ev) {
        ev.stopPropagation(); curBox.remove(); curBox = null; updateBoxInfo(unit);
      });
    });
    layer.addEventListener("pointermove", function (e) {
      if (!dragging || !curBox) return;
      e.preventDefault();
      var p = pt(e);
      curBox.style.left = Math.min(sx, p.x) + "px";
      curBox.style.top = Math.min(sy, p.y) + "px";
      curBox.style.width = Math.abs(p.x - sx) + "px";
      curBox.style.height = Math.abs(p.y - sy) + "px";
    });
    layer.addEventListener("pointerup", function () {
      dragging = false;
      updateBoxInfo(unit);
    });
    // 吃掉 click，避免拖框/点击时触发接入方的 lightbox
    layer.addEventListener("click", function (e) { e.stopPropagation(); });
  }

  // 框（显示坐标）→ 原始图像素归一化：处理 object-fit:cover 裁剪；多框
  function collectBoxes(unit) {
    var img = unit.querySelector("img");
    var layer = unit.querySelector(".anno-layer");
    if (!layer || !img) return [];
    var ir = img.getBoundingClientRect();
    var iw = img.naturalWidth || 192, ih = img.naturalHeight || 490;
    var scale = Math.max(ir.width / iw, ir.height / ih);
    var offX = (ir.width - iw * scale) / 2, offY = (ir.height - ih * scale) / 2;
    function c01(v, max) { return Math.max(0, Math.min(1, Math.round(v / max * 1000) / 1000)); }
    var out = [];
    var boxes = layer.querySelectorAll(".anno-box");
    for (var i = 0; i < boxes.length; i++) {
      var br = boxes[i].getBoundingClientRect();
      var ox = (br.left - ir.left - offX) / scale;
      var oy = (br.top - ir.top - offY) / scale;
      var ow = br.width / scale, oh = br.height / scale;
      if (ow <= 2 || oh <= 2) continue;
      out.push({ x: c01(ox, iw), y: c01(oy, ih), w: c01(ow, iw), h: c01(oh, ih) });
    }
    return out;
  }

  function updateBoxInfo(unit) {
    var info = unit.querySelector(".rv-boxinfo");
    if (!info) return;
    var n = collectBoxes(unit).length;
    info.textContent = n > 0
      ? "已框选 " + n + " 处（继续拖框可多处标注，双击某框可删除该框）"
      : "在截图上按住拖框圈出问题区域（可多处框选，可不框）";
  }

  function collectChips(unit) {
    var out = [], chips = unit.querySelectorAll(".rv-chip.on");
    for (var i = 0; i < chips.length; i++) out.push(chips[i].textContent);
    return out;
  }

  // ── 状态：角标 / 隐藏 / 按钮文字 ──
  function applyFlag(unit, action) {
    var device = unit.querySelector(".device");
    unit.style.display = action === "delete" ? "none" : "flex";
    device.classList.remove("rv-flag", "rv-flag-resolved", "rv-flag-deleted");
    if (action === "fix" || action === "recapture") device.classList.add("rv-flag");
    else if (action === "resolved") device.classList.add("rv-flag-resolved");
    else if (action === "delete") device.classList.add("rv-flag-deleted");
  }

  // 快捷标记按钮统一状态（含撤销提示与恢复），供 quickMark 与回填共用
  function applyBtnState(unit, action) {
    var bar = unit.querySelector(".review-bar");
    if (!bar) return;
    var btns = bar.querySelectorAll(".rv-btn");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.classList.contains("rv-ok") || b.classList.contains("rv-warn")) {
        b.classList.remove("rv-ok", "rv-warn");
        if (b.getAttribute("data-label")) { b.textContent = b.getAttribute("data-label"); b.removeAttribute("data-label"); }
      }
    }
    if (action === "recapture" || action === "delete") {
      var target = bar.querySelector('[data-rv="' + action + '"]');
      if (target) {
        if (!target.getAttribute("data-label")) target.setAttribute("data-label", target.textContent);
        target.textContent = action === "delete" ? "已标记删除(点撤销)" : "已标记换版(点撤销)";
        target.classList.add(action === "delete" ? "rv-del" : "rv-warn");
      }
    }
  }

  function applyReviewState(unit, it) {
    if (!it) return;
    unit.setAttribute("data-action", it.action);
    applyFlag(unit, it.action);
    applyBtnState(unit, it.action);
    unit.style.display = it.action === "delete" ? "none" : "flex";
  }

  // ── API ──
  function postReview(payload, cb) {
    payload.projectId = PROJECT;
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (d) {
      cb(!!(d && d.success), d);
    }).catch(function () { cb(false, { error: "网络错误" }); });
  }

  function submitReview(unit, action) {
    var msg = unit.querySelector(".rv-msg");
    var payload = {
      pageId: unit.getAttribute("data-page"),
      shotFile: unit.getAttribute("data-file"),
      issues: collectChips(unit),
      boxes: collectBoxes(unit),
      note: (unit.querySelector(".rv-note") || {}).value || "",
      action: action,
      reviewer: "用户",
      nickname: rvSaveNick((unit.querySelector(".rv-nick") || {}).value)
    };
    if (!payload.issues.length && !payload.boxes.length && !payload.note && action === "fix") {
      msg.textContent = "请先框选区域 / 勾选问题 / 填写批注";
      return;
    }
    msg.textContent = "提交中…";
    postReview(payload, function (okRes, d) {
      msg.textContent = okRes ? "✅ 已提交（" + (ACTION_CN[action] || action) + "）" : "❌ " + ((d && d.error) || "提交失败");
      if (okRes) {
        applyReviewState(unit, payload);
        if (action === "fix") {
          var layer = unit.querySelector(".anno-layer");
          if (layer) {
            var boxes = layer.querySelectorAll(".anno-box");
            for (var i = boxes.length - 1; i >= 0; i--) boxes[i].remove();
          }
          updateBoxInfo(unit);
        }
        refreshQuiet();
      }
    });
  }

  // 快捷标记：再点一次同一标记 = 撤销（恢复为待修 fix）
  function quickMark(unit, action) {
    var cur = unit.getAttribute("data-action") || "";
    var undoing = cur === action;
    postReview({
      pageId: unit.getAttribute("data-page"),
      shotFile: unit.getAttribute("data-file"),
      issues: [], boxes: [], note: undoing ? "撤销标记" : "",
      action: undoing ? "fix" : action,
      reviewer: "用户",
      nickname: rvNick()
    }, function (okRes) {
      if (!okRes) return;
      if (undoing) {
        unit.removeAttribute("data-action");
        applyFlag(unit, "none");
        applyBtnState(unit, "");
      } else {
        unit.setAttribute("data-action", action);
        applyFlag(unit, action);
        applyBtnState(unit, action);
      }
      refreshQuiet();
    });
  }

  // ── 历史记录折叠区 ──
  function toggleHistory(unit) {
    var box = unit.querySelector(".rv-history");
    if (!box) return;
    if (box.style.display === "block") { box.style.display = "none"; return; }
    var key = unit.getAttribute("data-page") + "|" + unit.getAttribute("data-file");
    var it = null;
    for (var i = 0; i < ITEMS.length; i++) {
      if (ITEMS[i].projectId + "|" + ITEMS[i].pageId + "|" + ITEMS[i].shotFile === key) { it = ITEMS[i]; break; }
    }
    if (!it) { box.innerHTML = '<div class="rv-h-empty">暂无提交记录</div>'; box.style.display = "block"; return; }
    var rows = '<div class="rv-h-head">'
      + '<span class="rv-h-status ' + (it.status === "done" ? "ok" : "warn") + '">' + (it.status === "done" ? "✅ 已全部处理" : "⏳ 待处理") + "</span>"
      + "<span>提交 " + it.count + " 次 · 最近 " + fmtTs(it.updated_at) + "</span>"
      + "</div>";
    var hist = (it.history || []).slice();
    hist.unshift({ action: it.action, issues: it.issues, note: it.note, nickname: it.nickname, reviewer: it.reviewer, at: it.updated_at });
    for (var j = 0; j < hist.length; j++) {
      var h = hist[j];
      var iss = (h.issues || []).join("、");
      var who = h.nickname || h.reviewer || "匿名";
      rows += '<div class="rv-h-item">'
        + '<div class="rv-h-line1"><b>' + fmtTs(h.at) + "</b><span>· " + who + '</span>'
        + '<span class="rv-h-tag">' + (ACTION_CN[h.action] || h.action) + "</span></div>"
        + (iss ? '<div class="rv-h-line2">问题：' + iss + "</div>" : "")
        + (h.note ? '<div class="rv-h-line2">批注：' + h.note + "</div>" : "")
        + "</div>";
    }
    box.innerHTML = rows;
    box.style.display = "block";
  }

  // ── 拉取回填：角标 / 撤销状态 / 隐藏 / 记录按钮 ──
  function refreshQuiet() { refresh(function () {}); }

  function refresh(done) {
    fetch(API + "?projectId=" + encodeURIComponent(PROJECT)).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.success || !d.items) { if (done) done(); return; }
      ITEMS = d.items;
      var byKey = {};
      d.items.forEach(function (it) { byKey[it.pageId + "|" + it.shotFile] = it; });
      var units = document.querySelectorAll('.shot-unit[data-project="' + PROJECT + '"]');
      for (var i = 0; i < units.length; i++) {
        var u = units[i];
        var key = u.getAttribute("data-page") + "|" + u.getAttribute("data-file");
        var it = byKey[key];
        var hbtn = u.querySelector('[data-rv="history"]');
        if (!it) {
          u.removeAttribute("data-action");
          u.style.display = "flex";
          if (hbtn) { hbtn.textContent = "记录"; hbtn.classList.remove("rv-ok", "rv-warn"); }
          continue;
        }
        applyReviewState(u, it);
        if (hbtn) {
          hbtn.textContent = "记录(" + it.count + ")";
          if (it.status === "done") hbtn.classList.add("rv-ok");
          else hbtn.classList.add("rv-warn");
        }
      }
      if (done) done();
    }).catch(function () { if (done) done(); });
  }

  // ── 挂载：扫描全部 .shot-unit[data-project]，构建工具条/面板/历史 ──
  function mountAll(opts) {
    opts = opts || {};
    if (opts.projectId) PROJECT = opts.projectId;
    injectCSS();
    var units = document.querySelectorAll(".shot-unit[data-project]");
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.getAttribute("data-rv-mounted")) continue;
      u.setAttribute("data-rv-mounted", "1");
      buildBar(u);
    }
    refreshQuiet();
  }

  // 对外 API
  window.ReviewWidget = {
    mountAll: mountAll,
    refresh: refreshQuiet,
    setProject: function (p) { PROJECT = p || DEFAULT_PROJECT; }
  };

  // 全局事件桥（保留与旧内联 onclick 的兼容）
  window.toggleReview = function (btn, e) { if (e) e.stopPropagation(); togglePanel(btn.closest(".shot-unit")); };
  window.quickMark = function (btn, action, e) { if (e) e.stopPropagation(); quickMark(btn.closest(".shot-unit"), action); };
  window.toggleHistory = function (btn, e) { if (e) e.stopPropagation(); toggleHistory(btn.closest(".shot-unit")); };
  window.submitReview = function (btn, action, e) { if (e) e.stopPropagation(); submitReview(btn.closest(".shot-unit"), action); };
  window.rvToggleChip = function (chip, e) { if (e) e.stopPropagation(); chip.classList.toggle("on"); };
})();
