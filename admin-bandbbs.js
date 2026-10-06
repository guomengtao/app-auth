console.log('[bandbbs] admin-bandbbs.js loaded, loadBandBBS defined:', typeof loadBandBBS);

async function loadBandBBS() {
    console.log('[bandbbs] loadBandBBS() called');
    try {
      console.log('[bandbbs] fetching stats...');
      var data = await api('/api/admin/catalog?kind=bandbbs&op=stats');
      console.log('[bandbbs] stats response:', data && data.success ? 'success, ' + (data.data && data.data.resources ? data.data.resources.length + ' resources' : 'no resources') : 'FAILED', data);
      if (data && data.success && data.data) {
        var s = data.data;
        var elR = document.getElementById('bbStatResources');
        var elV = document.getElementById('bbStatReviews');
        var elW = document.getElementById('bbStatRewards');
        var elL = document.getElementById('bbStatLastPoll');
        console.log('[bandbbs] stat DOM elements:', { resources: !!elR, reviews: !!elV, rewards: !!elW, lastPoll: !!elL });
        if (elR) elR.textContent = (s.resources && s.resources.length) || 0;
        if (elV) elV.textContent = s.totalReviews || 0;
        if (elW) elW.textContent = s.totalRewarded || 0;
        if (elL) elL.textContent = s.lastPoll || '-';
      }
      console.log('[bandbbs] fetching config...');
      var configData = await api('/api/admin/catalog?kind=bandbbs&op=config');
      console.log('[bandbbs] config response:', configData && configData.success ? 'success, ' + (configData.data ? configData.data.length + ' configs' : 'no data') : 'FAILED', configData);
      if (configData && configData.success && configData.data) {
        var configs = configData.data;
        var tbody = document.getElementById('bbResourcesTable');
        console.log('[bandbbs] tbody element found:', !!tbody);
        if (!configs || !configs.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无已配置的资源</td></tr>';
        } else {
          var rows = '';
          for (var i = 0; i < configs.length; i++) {
            var c = configs[i];
            rows += '<tr>' +
              '<td>' + (c.resourceId || '-') + '</td>' +
              '<td>' + (c.title || '-') + '</td>' +
              '<td>' + (c.enabled ? '<span style="color:#16a34a">启用</span>' : '<span style="color:#dc2626">停用</span>') + '</td>' +
              '<td>' + (typeof c.lastPollCount === 'number' ? c.lastPollCount : '-') + '</td>' +
              '<td style="font-size:0.75rem">' + (c.lastPollAt || '-') + '</td>' +
              '<td>' + (typeof c.lastPollNew === 'number' ? '<span style="color:#16a34a">+' + c.lastPollNew + '</span>' : '-') + '</td>' +
              '<td style="white-space:nowrap">' +
              '<button class="btn btn-sm" onclick="pollSingleBandBBS(' + c.resourceId + ', this)" style="margin-right:4px">抓取</button>' +
              '<button class="btn btn-sm" onclick="showBandBBSDetail(' + c.resourceId + ')" style="margin-right:4px">详情</button>' +
              '<button class="btn btn-sm" onclick="sendRewardForResource(' + c.resourceId + ', this)" style="margin-right:4px;color:#f59e0b">发送奖励</button>' +
              '<button class="btn btn-sm" onclick="deleteBandBBSResource(' + c.resourceId + ')" style="color:#dc2626">删除</button></td>' +
              '</tr>';
          }
          tbody.innerHTML = rows;
        }
      }
    loadBandBBSPollLogs();
    } catch (e) {
      console.error('loadBandBBS failed:', e);
      var tbody = document.getElementById('bbResourcesTable');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty" style="color:#dc2626">\u52a0\u8f7d\u5931\u8d25: ' + (e && e.message ? e.message : e) + '</td></tr>';
      }
    }
  }

async function triggerBandBBSPoll() {
    var btn = document.getElementById('btnPoll');
    btn.disabled = true;
    btn.textContent = '抓取中...';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=poll');
      var box = document.getElementById('bbPollResult');
      if (result && result.success) {
        var r = result.results;
        var resourcesHtml = '';
        var resourceKeys = Object.keys(r.resources || {});
        for (var i = 0; i < resourceKeys.length; i++) {
          var rid = resourceKeys[i];
          var v = r.resources[rid];
          resourcesHtml += '<div style="margin:4px 0">#' + rid + ': ' + (v.error ? '<span style="color:#dc2626">错误：' + v.error + '</span>' : v.count + ' 条评论（' + (v.title || '') + '）') + '</div>';
        }
        box.innerHTML = '<div style="color:#16a34a;font-weight:600;margin-bottom:8px">抓取完成</div>' +
          '<div>新增评论：<b>' + r.newReviews + '</b> | 已发奖励：<b>' + r.rewards.sent + '</b> | 跳过：<b>' + r.rewards.skipped + '</b> | 错误：<b>' + r.rewards.errors + '</b></div>' +
          '<div style="margin-top:4px">耗时：' + r.duration + 'ms</div>' +
          '<div style="margin-top:8px">' + resourcesHtml + '</div>';
      } else {
        box.innerHTML = '<span style="color:#dc2626">抓取失败：' + ((result && result.error) || '未知错误') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">请求失败：' + (e.message || e) + '</span>';
    }
    btn.disabled = false;
    btn.textContent = '▶️ 手动抓取';
    loadBandBBS();
  }

  async function addBandBBSResource() {
    var rid = document.getElementById('bbResourceId').value.trim();
    var title = document.getElementById('bbResourceTitle').value.trim();
    if (!rid) { alert('请输入资源ID'); return; }
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=config-save&resourceId=' + encodeURIComponent(rid), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: rid, title: title || ('资源帖 ' + rid), enabled: true })
      });
      if (result && result.success) {
        document.getElementById('bbResourceId').value = '';
        document.getElementById('bbResourceTitle').value = '';
        loadBandBBS();
      } else {
        alert('失败: ' + ((result && result.error) || '未知错误'));
      }
    } catch (e) {
      alert('错误: ' + (e.message || e));
    }
  }

  async function deleteBandBBSResource(rid) {
    if (!confirm('删除资源帖 ' + rid + '？')) return;
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=config-delete&resourceId=' + encodeURIComponent(rid));
      if (result && result.success) {
        loadBandBBS();
      } else {
        alert('失败：' + ((result && result.error) || 'Unknown'));
      }
    } catch (e) {
      alert('Error: ' + (e.message || e));
    }
  }

  async function loginBandBBS() {
    var btn = document.getElementById('btnBandBBSLogin');
    var resultBox = document.getElementById('bbLoginResult');
    var hintBox = document.getElementById('bbLoginHint');
    btn.disabled = true;
    btn.textContent = 'Logging in...';
    resultBox.style.display = 'block';
    resultBox.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><div class="spinner"></div><span>Logging in to bandbbs.cn, checking each step...</span></div>';

    try {
      var res = await api('/api/admin/catalog?kind=bandbbs&op=bandbbs-login', { method: 'POST' });
      var steps = (res && res.steps) || [];
      var isSuccess = res && res.success;

      var html = '<div style="font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:8px">';
      html += (isSuccess
        ? '<span style="font-size:1.25rem">&#9989;</span><span style="color:var(--ok)">Login Ready</span>'
        : '<span style="font-size:1.25rem">&#10060;</span><span style="color:var(--err)">Login Failed</span>');
      html += '</div>';

      html += '<div style="font-size:0.8125rem;color:var(--muted);margin-bottom:12px">' + (res.summary || '') + '</div>';

      html += '<table style="width:100%;font-size:0.75rem;border-collapse:collapse">';
      html += '<thead><tr style="color:var(--muted);border-bottom:1px solid var(--line)"><th style="text-align:left;padding:4px 6px">Step</th><th style="text-align:center;width:56px;padding:4px 6px">Status</th><th style="text-align:right;width:60px;padding:4px 6px">Time</th><th style="text-align:left;padding:4px 6px">Detail</th></tr></thead><tbody>';
      for (var i = 0; i < steps.length; i++) {
        var s = steps[i];
        var icon = s.ok === true ? '&#9989;' : (s.ok === false ? '&#10060;' : '&#9203;');
        var errText = s.error ? '<br><span style="color:var(--err)">' + s.error + '</span>' : '';
        html += '<tr style="border-bottom:1px solid var(--line)">' +
          '<td style="padding:4px 6px;font-weight:600">' + (s.step || '') + '</td>' +
          '<td style="text-align:center;padding:4px 6px">' + icon + '</td>' +
          '<td style="text-align:right;padding:4px 6px;color:var(--muted)">' + (typeof s.time === 'number' ? s.time + 'ms' : '-') + '</td>' +
          '<td style="padding:4px 6px;color:var(--muted);word-break:break-all">' + (s.detail || '') + errText + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';

      resultBox.innerHTML = html;

      if (isSuccess) {
        window._bbLoginReady = true;
        btn.style.background = '#16a34a';
        btn.innerHTML = '<i data-lucide="check" class="lucide-inline"></i> Ready';
        btn.disabled = false;
        if (hintBox) hintBox.style.display = 'none';
        window._bbLoginHintDismissed = true;
      } else {
        window._bbLoginReady = false;
        btn.style.background = '#dc2626';
        btn.innerHTML = '<i data-lucide="alert-triangle" class="lucide-inline"></i> Failed';
        setTimeout(function() {
          btn.style.background = '#f59e0b';
          btn.innerHTML = '<i data-lucide="log-in" class="lucide-inline"></i> Retry';
          btn.disabled = false;
        }, 3000);
      }
    } catch (e) {
      resultBox.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:1.25rem">&#10060;</span>' +
        '<span style="color:var(--err);font-weight:700">Request Failed</span>' +
        '</div>' +
        '<div style="font-size:0.75rem;color:var(--err);margin-top:4px">' + (e.message || e) + '</div>';
      btn.style.background = '#f59e0b';
      btn.innerHTML = '<i data-lucide="log-in" class="lucide-inline"></i> Retry';
      btn.disabled = false;
    }
  }

  async function sendBandBBSDM() {
    if (!window._bbLoginReady && !window._bbLoginHintDismissed) {
      if (!confirm('会话可能未就绪：先点「登录准备」可避免「not authenticated」报错。\n\n仍要发送吗？')) return;
    }
    var recipient = document.getElementById('bbDmRecipient').value.trim();
    var title = document.getElementById('bbDmTitle').value.trim();
    var message = document.getElementById('bbDmMessage').value.trim();
    if (!recipient || !title || !message) { alert('请填写所有字段'); return; }
    var btn = document.getElementById('btnSendDm');
    btn.disabled = true;
    btn.textContent = '发送中...';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=send-dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: recipient, title: title, message: message })
      });
      var resultBox = document.getElementById('bbDmResult');
      if (result && result.success) {
        resultBox.innerHTML = '<span style="color:#16a34a">已发送给 ' + recipient + ' （会话ID：' + (result.conversationId || '-') + ')</span>';
      } else {
        resultBox.innerHTML = '<span style="color:#dc2626">发送失败: ' + ((result && result.error) || '未知错误') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbDmResult').innerHTML = '<span style="color:#dc2626">请求失败：' + (e.message || e) + '</span>';
    }
    btn.disabled = false;
    btn.textContent = '📨 发送';
  }

  async function pollSingleBandBBS(rid, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '抓取中...'; }
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=single-poll&resourceId=' + encodeURIComponent(rid));
      var box = document.getElementById('bbPollResult');
      if (result && result.success) {
        var r = result.results;
        var keys = Object.keys(r.resources || {});
        var h = '';
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i], v = r.resources[k];
          h += '<div style="margin:4px 0">#' + k + ': ' + (v.error ? '<span style="color:#dc2626">错误：' + v.error + '</span>' : v.count + ' 条评论') + '</div>';
        }
        box.innerHTML = '<div style="color:#16a34a;font-weight:600;margin-bottom:8px">抓取完成</div>' +
          '<div>资源 <b>' + rid + '</b> | 新增: <b>' + r.newReviews + '</b> | 已发: <b>' + r.rewards.sent + '</b> | 跳过：<b>' + r.rewards.skipped + '</b> | 错误：<b>' + r.rewards.errors + '</b></div>' +
          '<div style="margin-top:4px">' + r.duration + 'ms</div><div style="margin-top:8px">' + h + '</div>';
      } else {
        box.innerHTML = '<span style="color:#dc2626">抓取失败：' + ((result && result.error) || '未知') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">请求失败：' + (e.message || e) + '</span>';
    }
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '抓取'; }
    loadBandBBS();
  }

  async function showBandBBSDetail(rid) {
      if (!rid) return;
      // 1) Populate filter dropdown + select this resource
      var sel = document.getElementById('bbDetailResourceSelect');
      if (!sel) return;
      try {
        var result = await api('/api/admin/catalog?kind=bandbbs&op=config');
        var configs = (result && result.success && result.data) ? result.data : [];
        var opts = '<option value="">全部资源</option>';
        for (var i = 0; i < configs.length; i++) {
          var c = configs[i];
          opts += '<option value="' + c.resourceId + '">#' + c.resourceId + ' - ' + (c.title || '') + '</option>';
        }
        sel.innerHTML = opts;
        sel.value = String(rid);
      } catch (e) { /* best-effort */ }
      // 2) Load reviews filtered by this resource
      filterBandBBSReviews();
      // 3) Scroll to the review section
      var reviewSection = document.getElementById('bbReviewSection');
      if (reviewSection) reviewSection.scrollIntoView({ behavior: 'smooth' });
    }
async function loadBandBBSPollLogs() {
    var box = document.getElementById('bbPollLogResult');
    if (!box) return;
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=poll-logs&limit=30');
      if (result && result.success) {
        var logs = result.data || [];
        if (!logs || !logs.length) { box.innerHTML = '<span class="muted">暂无记录</span>'; return; }
        var rows = '';
        for (var i = 0; i < logs.length; i++) {
          var l = logs[i];
          var sum = (l.resources || []).map(function(x){ return '#'+x.resourceId+'（共 '+(x.count||0)+' 条，新增 '+(x.newCount||0)+'，已发 '+(x.sent||0)+'）'; }).join(', ');
          rows += '<tr><td style="font-size:0.75rem">'+(l.at||'-')+'</td><td>'+(l.mode==='cron'?'<span style="color:#f59e0b">定时</span>':'<span style="color:#16a34a">手动</span>')+'</td><td style="max-width:400px">'+(sum||'-')+'</td><td>'+(l.newReviews||0)+'</td><td>'+(l.rewardsSent||0)+'</td></tr>';
        }
        box.innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>时间</th><th>模式</th><th>资源</th><th>新增</th><th>已发</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
      } else { box.innerHTML = '<span class="muted">暂无记录</span>'; }
    } catch (e) { box.innerHTML = '<span class="muted">加载失败</span>'; }
  }


  async function loadBandBBSReviewsByResource(rid, box) {
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=resource-detail&resourceId=' + encodeURIComponent(rid));
      if (!result || !result.success) return [];
      var d = result.data;
      var reviews = d.reviews || [];
      for (var i = 0; i < reviews.length; i++) reviews[i]._resourceId = rid;
      return reviews;
    } catch (e) {
      return [];
    }
  }

  /* ============ 获奖名单（批次2）：本地缓存 + 芯片筛选状态机 ============ */
  var _bbReviews = [];
  var _bbConfigs = [];
  var _bbFilter = { resource: '', stars: '', status: '', q: '' };

  function bbEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }
  function bbStars(r) { return Number(r.stars || 0); }
  function bbEligible(r) { return bbStars(r) >= 5; }
  function bbState(r) { return r.rewarded ? 'rewarded' : (bbEligible(r) ? 'pending' : 'none'); }

  function bbReviewCounts() {
    var c = { all: _bbReviews.length, rewarded: 0, pending: 0, none: 0 };
    for (var i = 0; i < _bbReviews.length; i++) { var s = bbState(_bbReviews[i]); c[s] = (c[s] || 0) + 1; }
    return c;
  }

  async function loadBandBBSReviews() {
    var box = document.getElementById('bbReviewTable');
    if (!box) return;
    box.innerHTML = '<span class="muted">加载中...</span>';
    _bbFilter = { resource: '', stars: '', status: '', q: '' };
    try {
      var cr = await api('/api/admin/catalog?kind=bandbbs&op=config');
      _bbConfigs = (cr && cr.success && cr.data) ? cr.data : [];
      var sel = document.getElementById('bbDetailResourceSelect');
      if (sel) {
        var opts = '<option value="">全部资源</option>';
        for (var i = 0; i < _bbConfigs.length; i++) {
          opts += '<option value="' + _bbConfigs[i].resourceId + '">#' + _bbConfigs[i].resourceId + ' - ' + (_bbConfigs[i].title || '') + '</option>';
        }
        sel.innerHTML = opts;
      }
      var all = [];
      for (var j = 0; j < _bbConfigs.length; j++) {
        var rvs = await loadBandBBSReviewsByResource(_bbConfigs[j].resourceId, box);
        all = all.concat(rvs || []);
      }
      _bbReviews = all;
      window._bbReviews = all;
      renderBandBBSReviewChips();
      applyBandBBSReviewFilter();
    } catch (e) {
      box.innerHTML = '<span style="color:#dc2626">加载失败：' + (e.message || e) + '</span>';
    }
  }

  function bbChip(group, val, label, n, cls) {
    var on = String(_bbFilter[group]) === String(val);
    return '<button type="button" class="bbx-chip' + (on ? ' on' : '') + '"' + (cls ? ' data-c="' + cls + '"' : '') +
      ' data-g="' + group + '" data-v="' + val + '">' + label +
      (n === null || n === undefined ? '' : ' <span class="bbx-n">' + n + '</span>') + '</button>';
  }

  function renderBandBBSReviewChips() {
    var host = document.getElementById('bbDetailChips');
    if (!host) return;
    var c = bbReviewCounts();
    var h = '';
    h += '<div class="bbx-frow"><span class="bbx-flabel">资源帖</span>' + bbChip('resource', '', '全部', c.all);
    for (var i = 0; i < _bbConfigs.length; i++) {
      var cf = _bbConfigs[i], n = 0;
      for (var k = 0; k < _bbReviews.length; k++) { if (String(_bbReviews[k]._resourceId) === String(cf.resourceId)) n++; }
      h += bbChip('resource', cf.resourceId, '#' + cf.resourceId + ' ' + (cf.title || ''), n);
    }
    h += '</div>';
    var s5 = 0, s4 = 0, s3 = 0;
    for (var m = 0; m < _bbReviews.length; m++) { var st = bbStars(_bbReviews[m]); if (st >= 5) s5++; else if (st === 4) s4++; else s3++; }
    h += '<div class="bbx-frow"><span class="bbx-flabel">评分</span>' + bbChip('stars', '', '全部', c.all) +
      bbChip('stars', '5', '五星', s5) + bbChip('stars', '4', '四星', s4) + bbChip('stars', '3', '三星及以下', s3) + '</div>';
    var svg = '<svg class="bbx-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
    h += '<div class="bbx-frow"><span class="bbx-flabel">发放</span>' + bbChip('status', '', '全部', c.all) +
      bbChip('status', 'rewarded', '已获奖', c.rewarded, 'ok') +
      bbChip('status', 'pending', '待发奖', c.pending, 'prize') +
      bbChip('status', 'none', '未获奖', c.none) +
      '<label class="bbx-search">' + svg + '<input id="bbReviewSearch" type="search" placeholder="搜用户 / 评论 / 奖品 ID" value="' + bbEsc(_bbFilter.q || '') + '" autocomplete="off" style="border:0;background:transparent;outline:none;color:inherit;font:inherit;width:180px"></label>' +
      '</div>';
    host.innerHTML = h;
  }

  function bbSetReviewFilter(group, val) {
    _bbFilter[group] = val;
    var sel = document.getElementById('bbDetailResourceSelect');
    if (sel && group === 'resource') sel.value = String(val);
    var rf = document.getElementById('bbRewardFilter');
    if (rf && group === 'status') rf.value = (val === 'rewarded' ? 'rewarded' : (val === 'pending' || val === 'none' ? 'not_rewarded' : ''));
    var chips = document.querySelectorAll('#bbDetailChips .bbx-chip');
    for (var i = 0; i < chips.length; i++) {
      if (chips[i].getAttribute('data-g') !== group) continue;
      chips[i].classList.toggle('on', String(chips[i].getAttribute('data-v')) === String(val));
    }
    applyBandBBSReviewFilter();
  }

  /** 当前筛选命中的评论（渲染与计数共用，避免两处判定不一致）。 */
  function bbFilteredReviews() {
    var f = _bbFilter, q = (f.q || '').toLowerCase(), out = [];
    for (var i = 0; i < _bbReviews.length; i++) {
      var r = _bbReviews[i];
      if (f.resource !== '' && String(r._resourceId) !== String(f.resource)) continue;
      var st = bbStars(r);
      if (f.stars === '5' && st < 5) continue;
      if (f.stars === '4' && st !== 4) continue;
      if (f.stars === '3' && st >= 4) continue;
      if (f.status !== '' && bbState(r) !== f.status) continue;
      if (q) {
        var hay = ((r.username || '') + ' ' + (r.content || '') + ' ' + (r.couponCode || r.coupon_code || '')).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(r);
    }
    return out;
  }

  function applyBandBBSReviewFilter() {
    var box = document.getElementById('bbReviewTable');
    if (!box) return;
    var out = bbFilteredReviews();
    bbRenderReviewTable(out);
    bbUpdateReviewFoot(out);
  }

  function bbRenderReviewTable(list) {
    var box = document.getElementById('bbReviewTable');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<span class="muted">当前筛选下没有评论</span>'; return; }
    var rows = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i], st = bbStars(r), stars = '';
      for (var k = 0; k < 5; k++) stars += k < st ? '★' : '☆';
      var state = bbState(r);
      var pill = state === 'rewarded' ? '<span class="bbx-pill ok">已获奖</span>'
               : state === 'pending' ? '<span class="bbx-pill prize">待发奖</span>'
               : '<span class="bbx-pill">未获奖</span>';
      var pid = r.couponCode || r.coupon_code || '';
      var at = r.assignedAt || r.rewardedAt || r.assigned_at || '';
      // 奖品列（原「奖品池 ID + 发放时间」两列合并为一列两行）：减一列、信息还更聚拢
      var prizeCell = '<div class="bbx-cell2">' +
        (pid ? '<code class="bbx-code">' + bbEsc(String(pid).substring(0, 12)) + '</code>' : '<span class="muted">无奖品</span>') +
        '<span class="bbx-sub">' + bbEsc(at ? bbShortTime(at) : '——') + '</span></div>';
      // 手动发奖：已发过 → 重发（复用原链接）；未发/待发 → 手动发奖（不要求 5 星，破例补发）
      var userName = bbEsc(r.username || '');
      var awardBtn = state === 'rewarded'
        ? '<button type="button" class="bbx-mini" data-award="1" data-force="1" data-user="' + userName + '" data-rid="' + bbEsc(r._resourceId || '') + '">重发</button>'
        : '<button type="button" class="bbx-mini primary" data-award="1" data-user="' + userName + '" data-rid="' + bbEsc(r._resourceId || '') + '">手动发奖</button>';
      rows += '<tr' + (state === 'none' ? ' class="bbx-dim"' : '') + '>' +
        '<td><span class="muted">#' + bbEsc(r._resourceId || '-') + '</span></td>' +
        '<td class="bbx-user">' + (userName || '-') + '</td>' +
        '<td class="bbx-stars">' + stars + '</td>' +
        '<td class="bbx-content" title="' + bbEsc(String(r.content || '').replace(/\s+/g, ' ')) + '">' + bbEsc(r.content || '-') + '</td>' +
        '<td class="bb-prize-cell">' + prizeCell + '</td>' +
        '<td class="bb-state-cell">' + pill + '</td>' +
        '<td class="bb-op-cell">' + awardBtn + '</td>' +
        '</tr>';
    }
    box.innerHTML = '<div style="overflow-x:auto"><table class="bbx-table"><thead><tr><th style="width:74px">资源</th><th style="width:120px">用户</th><th style="width:92px">评分</th><th>评论内容</th><th style="width:150px">奖品 / 发放时间</th><th style="width:86px">状态</th><th style="width:96px">操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /** 时间短格式：2026-10-07T02:31:05.000Z → 10-07 02:31（表格里不需要年份秒与 T/Z）。 */
  function bbShortTime(s) {
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
    return String(s);
  }

  /**
   * 手动发奖：给这一行的用户立即发一份奖品（后端 reward-one）。
   * 已获奖的行走 force=1（复用原链接重发），避免二次占用奖品池。
   */
  function bbAwardOne(btn) {
    var user = btn.getAttribute('data-user') || '';
    var rid = btn.getAttribute('data-rid') || '';
    var force = btn.getAttribute('data-force') === '1';
    if (!user || !rid) return;
    var row = btn.closest ? btn.closest('tr') : null;
    bbConfirm(
      force ? '重发奖励' : '手动发奖',
      (force ? '给 <b>' + bbEsc(user) + '</b> 重发资源帖 <b>#' + bbEsc(rid) + '</b> 的奖励私信？'
             : '给 <b>' + bbEsc(user) + '</b> 手动发放资源帖 <b>#' + bbEsc(rid) + '</b> 的奖励？'
               + '<br><span style="color:var(--muted)">不受「五星才发」限制，会从其奖品池取一份可用链接并发送私信。</span>'),
      async function () {
        var old = btn.textContent;
        btn.disabled = true; btn.textContent = '发送中…';
        try {
          var res = await api('/api/admin/catalog?kind=bandbbs&op=reward-one', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resourceId: rid, username: user, force: force })
          });
          if (!res || !res.success) {
            btn.disabled = false; btn.textContent = old;
            alert('发奖失败：' + ((res && res.error) || '未知错误'));
            return;
          }
          // 就地更新：同步底册（chip 计数/后续重渲才对）+ 只重画这一行
          for (var i = 0; i < _bbReviews.length; i++) {
            if (String(_bbReviews[i].username) === String(user) &&
                String(_bbReviews[i]._resourceId) === String(rid)) {
              _bbReviews[i].couponCode = res.couponCode;
              _bbReviews[i].assignedAt = res.assignedAt;
              break;
            }
          }
          if (row) {
            var sc = row.querySelector('.bb-state-cell');
            if (sc) sc.innerHTML = '<span class="bbx-pill ok">已获奖</span>';
            var pc = row.querySelector('.bb-prize-cell');
            if (pc) pc.innerHTML = '<div class="bbx-cell2"><code class="bbx-code">' +
              bbEsc(String(res.couponCode || '').substring(0, 12)) + '</code><span class="bbx-sub">' +
              bbEsc(bbShortTime(res.assignedAt || new Date().toISOString())) + '</span></div>';
            row.classList.remove('bbx-dim');
            var ob = row.querySelector('.bbx-mini[data-award]');
            if (ob) { ob.removeAttribute('data-force'); ob.className = 'bbx-mini'; ob.textContent = '重发'; }
          }
          renderBandBBSReviewChips();            // 芯片计数（待发奖 / 已获奖）跟着变
          bbUpdateReviewFoot(bbFilteredReviews());
          btn.disabled = false;
          btn.textContent = '重发';
          bbToast('已发给 ' + user + (res.reusedLink ? '（复用原链接）' : '') + ' · ' + (res.couponCode || ''));
        } catch (e) {
          btn.disabled = false; btn.textContent = old;
          alert('发奖失败：' + ((e && e.message) || e));
        }
      }
    );
  }

  /** 轻量提示条（不打断操作，2.6s 自动消失）。 */
  function bbToast(msg) {
    var el = document.createElement('div');
    el.className = 'bbx-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 2600);
  }

  function bbMetric(label, num, cls) {
    return '<div class="bbx-metric' + (cls ? ' ' + cls : '') + '"><div class="bbx-mnum">' + num + '</div><div class="bbx-mlabel">' + label + '</div></div>';
  }

  function bbUpdateReviewFoot(list) {
    var c = bbReviewCounts();
    var rate = c.all ? Math.round(c.rewarded / c.all * 100) : 0;
    var f = document.getElementById('bbDetailFoot');
    if (f) f.textContent = '当前 ' + list.length + ' 条 · 共 ' + c.all + ' 条 · 已获奖 ' + c.rewarded + ' · 待发奖 ' + c.pending + ' · 未获奖 ' + c.none;
    var m = document.getElementById('bbDetailMetrics');
    if (m) m.innerHTML = bbMetric('全部评论', c.all) + bbMetric('已获奖', c.rewarded, 'ok') + bbMetric('待发奖', c.pending, 'prize') + bbMetric('获奖率', rate + '%');
  }

  // 兼容旧调用：从隐藏 select 同步后重新筛选
  async function filterBandBBSReviews() {
    var sel = document.getElementById('bbDetailResourceSelect');
    var rf = document.getElementById('bbRewardFilter');
    if (sel) _bbFilter.resource = sel.value || '';
    if (rf) _bbFilter.status = rf.value === 'rewarded' ? 'rewarded' : (rf.value === 'not_rewarded' ? 'pending' : '');
    applyBandBBSReviewFilter();
  }

  // 芯片 / 搜索事件委托（免内联 onclick 引号转义）
  (function () {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var chip = t.closest('#bbDetailChips .bbx-chip');
      if (chip) { bbSetReviewFilter(chip.getAttribute('data-g'), chip.getAttribute('data-v')); return; }
      var pchip = t.closest('#bbPoolChips .bbx-chip');
      if (pchip) { bbSetPoolFilter(pchip.getAttribute('data-g'), pchip.getAttribute('data-v')); return; }
      var abtn = t.closest('button[data-award]');
      if (abtn) { bbAwardOne(abtn); return; }
      var cbtn = t.closest('#bbRewardLogTable .bbx-mini');
      if (cbtn) { bbCopyText(cbtn.getAttribute('data-copy'), cbtn); return; }
    });
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'bbReviewSearch') { _bbFilter.q = t.value || ''; applyBandBBSReviewFilter(); return; }
      if (t.id === 'bbPoolSearch') { _bbPoolFilter.q = t.value || ''; applyBandBBSPoolFilter(); return; }
    });
  })();


  function bbConfirm(title, message, onOk, onCancel) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.id = '_bbConfirmOverlay';
    overlay.style.cssText = 'display:flex;animation:fadeIn 0.15s ease';
    overlay.innerHTML =
      '<div class="modal" style="max-width:380px;text-align:center;padding:28px 24px 20px">' +
      '<div style="font-size:1.125rem;font-weight:700;color:var(--ink);margin-bottom:12px">' + (title || '确认操作') + '</div>' +
      '<p style="color:var(--muted);margin:0 0 20px;font-size:0.875rem;line-height:1.5">' + (message || '') + '</p>' +
      '<div style="display:flex;gap:10px;justify-content:center">' +
      '<button class="btn btn-outline" id="_bbCancelBtn" style="min-width:90px">取消</button>' +
      '<button class="btn btn-primary" id="_bbOkBtn" style="min-width:90px;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:10px 20px;font-weight:600;cursor:pointer">确认</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    var done = false;
    function close(ok) {
      if (done) return; done = true;
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
      if (ok && onOk) onOk(); else if (!ok && onCancel) onCancel();
    }
    overlay.querySelector('#_bbOkBtn').onclick = function() { close(true); };
    overlay.querySelector('#_bbCancelBtn').onclick = function() { close(false); };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(false); });
  }

  async function sendRewardForResource(rid, btnEl) {
    var loginWarning = '';
    if (!window._bbLoginReady && !window._bbLoginHintDismissed) {
      loginWarning = '<br><br><span style="color:#f59e0b;font-size:0.8125rem">会话可能未就绪：若看到「redirected to login」报错，请先点 <b>登录准备</b> 再发。</span>';
    }
    bbConfirm(
      '发送奖励',
      '给资源帖 <b>#' + rid + '</b> 的所有<b>未获奖五星评论</b>发送奖励私信？' + loginWarning,
      async function() {
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = '\u53D1\u9001\u4E2D...'; }
        try {
          var result = await api('/api/admin/catalog?kind=bandbbs&op=send-rewards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resourceId: rid })
          });
          var box = document.getElementById('bbPollResult');
          if (result && result.success) {
            var allZero = !result.sent && !result.skipped && !result.errors;
            box.innerHTML =
              '<div style="background:var(--elevated);border-radius:12px;padding:16px 20px;border:1px solid var(--line)">' +
              '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
              '<span style="color:' + (allZero ? 'var(--muted)' : 'var(--ok)') + ';display:inline-flex">' + (allZero ? BB_MSG_SVG : BB_OK_SVG) + '</span>' +
              '<span style="font-weight:700;color:' + (allZero ? 'var(--muted)' : 'var(--ok)') + ';font-size:0.9375rem">' + (allZero ? '没有可发送的奖励' : '奖励已发送') + '</span>' +
              '</div>' +
              '<div style="display:flex;gap:16px;font-size:0.8125rem;color:var(--muted);margin-bottom:6px">' +
              '<span>资源 <b style="color:var(--ink)">#' + rid + '</b></span>' +
              '<span>已发送 <b style="color:var(--ok)">' + (result.sent || 0) + '</b></span>' +
              '<span>已跳过 <b style="color:var(--muted)">' + (result.skipped || 0) + '</b></span>' +
              '<span>出错 <b style="color:' + (result.errors ? 'var(--err)' : 'var(--muted)') + '">' + (result.errors || 0) + '</b></span>' +
              '</div>';
            if (result.message) {
              box.innerHTML += '<div style="font-size:0.8125rem;color:var(--muted);padding-top:6px;border-top:1px solid var(--line);margin-top:6px">' + result.message + '</div>';
            }
            if (result.notEnough) {
              box.innerHTML += '<div style="display:flex;align-items:center;gap:6px;color:#f59e0b;font-size:0.8125rem;margin-top:4px">' + BB_ALERT_SVG + '<span>奖品池可用链接不足，还有 ' + result.notEnough + ' 条评论未发送</span></div>';
            }
            box.innerHTML += '</div>';
          } else {
            box.innerHTML =
              '<div style="background:var(--elevated);border-radius:12px;padding:16px 20px;border:1px solid var(--line)">' +
              '<div style="display:flex;align-items:center;gap:8px">' +
              '<span style="color:var(--err);display:inline-flex">' + BB_FAIL_SVG + '</span>' +
              '<span style="font-weight:700;color:var(--err);font-size:0.9375rem">发送失败</span>' +
              '</div>' +
              '<div style="font-size:0.8125rem;color:var(--err);margin-top:4px">' + ((result && result.error) || '未知错误') + '</div>' +
              '</div>';
          }
        } catch (e) {
          document.getElementById('bbPollResult').innerHTML =
            '<div style="background:var(--elevated);border-radius:12px;padding:16px 20px;border:1px solid var(--line)">' +
            '<div style="display:flex;align-items:center;gap:8px">' +
            '<span style="color:var(--err);display:inline-flex">' + BB_FAIL_SVG + '</span>' +
            '<span style="font-weight:700;color:var(--err);font-size:0.9375rem">请求失败</span>' +
            '</div>' +
            '<div style="font-size:0.8125rem;color:var(--err);margin-top:4px">' + (e.message || e) + '</div>' +
            '</div>';
        }
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = '\u53D1\u9001\u5956\u52B1'; }
        loadBandBBS();
        filterBandBBSReviews();
      }
    );
  }

  // Auto-load reviews when panel opens
  loadBandBBSReviews();


  // ── Reward Pool Functions ──

  // Save reward message template
  async function saveRewardTemplate() {
    var template = document.getElementById('bbRewardTemplate').value.trim();
    var statusEl = document.getElementById('bbTemplateStatus');
    if (!template) { statusEl.textContent = '模板内容不能为空'; return; }
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=reward-pool-save-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: template })
      });
      if (result && result.success) {
        statusEl.textContent = '已保存';
        setTimeout(function() { statusEl.textContent = ''; }, 2000);
      } else {
        statusEl.textContent = '操作失败：' + ((result && result.error) || '未知错误');
      }
    } catch (e) {
      statusEl.textContent = '错误：' + (e.message || e);
    }
  }

  // Batch import reward links
  async function importRewardLinks() {
    var linksText = document.getElementById('bbRewardImportArea').value.trim();
    var statusEl = document.getElementById('bbImportStatus');
    if (!linksText) { statusEl.textContent = '请先粘贴兑换链接'; return; }
    statusEl.textContent = '导入中...';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=reward-pool-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: linksText })
      });
      if (result && result.success) {
        var msg = '成功导入 ' + result.imported + ' 条';
        if (result.skipped) msg += '，跳过 ' + result.skipped + ' 条重复';
        if (result.errors && result.errors.length) msg += '，' + result.errors.length + ' 条错误';
        statusEl.textContent = msg;
        document.getElementById('bbRewardImportArea').value = '';
        loadPoolStats();
        // 修复「批量导入后奖品丢失」：原调 loadRewardLog 走 op=reward-log，
        // 该接口只回「已发放」（见 lib/bandbbs.js getRewardLog），刚导入的奖品全是未发放
        // → 当场从列表消失，看起来像丢了（数据实际仍在 reward:pool）。
        loadRewardPool();
      } else {
        statusEl.textContent = '操作失败：' + ((result && result.error) || '未知错误');
      }
    } catch (e) {
      statusEl.textContent = '错误：' + (e.message || e);
    }
  }

  // Load reward pool stats
  async function loadPoolStats() {
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=reward-pool-stats');
      if (result && result.success && result.data) {
        var d = result.data;
        document.getElementById('bbPoolTotal').textContent = d.total;
        document.getElementById('bbPoolUsed').textContent = d.assigned;
        document.getElementById('bbPoolRemaining').textContent = d.remaining;
      }
    } catch (e) {
      console.error('loadPoolStats failed:', e);
    }
  }

/* ============ 奖品池（批次3）：全量列表 + 芯片筛选 + 警示条 ============ */
  var _bbPool = [];
  var _bbPoolFilter = { status: '', batch: '', q: '' };
  var BB_ALERT_SVG = '<svg class="bbx-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  var BB_SEARCH_SVG = '<svg class="bbx-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
  var BB_OK_SVG = '<svg class="bbx-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
  var BB_FAIL_SVG = '<svg class="bbx-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>';
  var BB_MSG_SVG = '<svg class="bbx-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';

  function bbPoolState(it) {
    if (!it.assigned) return 'unassigned';
    if (it.claimed) return 'claimed';
    return 'unclaimed';
  }

  function bbNormalizePoolItem(x) {
    x = x || {};
    return {
      couponCode: x.couponCode || x.coupon_code || x.code || '',
      goUrl: x.goUrl || x.go_url || '',
      goSlug: x.goSlug || x.go_slug || '',
      assigned: !!(x.assigned || x.assignedTo || x.assigned_to || x.claimed),
      claimed: !!x.claimed,
      assignedTo: x.assignedTo || x.assigned_to || '',
      resourceId: x.resourceId || x.resource_id || '',
      stars: x.reviewStars || x.stars || '',
      assignedAt: x.assignedAt || x.assigned_at || '',
      batch: x.batch || ''
    };
  }

  function bbPoolCountsLocal() {
    var c = { all: _bbPool.length, unassigned: 0, assigned: 0, claimed: 0, unclaimed: 0 };
    for (var i = 0; i < _bbPool.length; i++) {
      var s = bbPoolState(_bbPool[i]);
      if (s === 'unassigned') c.unassigned++;
      else { c.assigned++; if (s === 'claimed') c.claimed++; else c.unclaimed++; }
    }
    return c;
  }

  async function loadRewardPool() {
    var table = document.getElementById('bbRewardLogTable');
    if (!table) return;
    table.innerHTML = '<span class="muted">加载中...</span>';
    _bbPoolFilter = { status: '', batch: '', q: '' };
    try {
      var cr = await api('/api/admin/catalog?kind=bandbbs&op=config');
      var configs = (cr && cr.success && cr.data) ? cr.data : [];
      var rf = document.getElementById('bbRewardLogResourceFilter');
      if (rf) {
        var opts = '<option value="">全部资源</option>';
        for (var i = 0; i < configs.length; i++) {
          opts += '<option value="' + configs[i].resourceId + '">#' + configs[i].resourceId + ' - ' + (configs[i].title || '') + '</option>';
        }
        rf.innerHTML = opts;
      }
      var items = null;
      var degraded = false;
      try {
        var rp = await api('/api/admin/catalog?kind=bandbbs&op=reward-pool-list&status=all');
        if (rp && rp.success && rp.data) {
          var arr = rp.data.items || rp.data || [];
          items = [];
          for (var j = 0; j < arr.length; j++) items.push(bbNormalizePoolItem(arr[j]));
        }
      } catch (_) { items = null; }
      if (items === null) {
        // 降级兜底：后端不支持 reward-pool-list（如批次4 未部署）时退回 reward-log，
        // ⚠ 该接口只回「已发放」→ 未发放奖品不显示。必须显式告警，否则会被误读为「奖品丢失」。
        degraded = true;
        try {
          var st0 = await api('/api/admin/catalog?kind=bandbbs&op=reward-pool-stats');
          if (st0 && st0.success && st0.data) window._bbPoolDegradedTotal = st0.data.total;
        } catch (_d) {}
        var rl = await api('/api/admin/catalog?kind=bandbbs&op=reward-log&resourceId=&status=');
        var logs = (rl && rl.success && rl.data) ? rl.data : [];
        items = [];
        for (var k = 0; k < logs.length; k++) items.push(bbNormalizePoolItem(logs[k]));
      }
      _bbPool = items;
      window._bbPoolLoaded = true;
      window._bbPoolDegraded = degraded;
      _bbPool.sort(function (a, b) {
        var oa = bbPoolState(a) === 'unassigned' ? 0 : 1;
        var ob = bbPoolState(b) === 'unassigned' ? 0 : 1;
        return oa - ob;
      });
      renderBandBBSPoolChips();
      applyBandBBSPoolFilter();
      updatePoolAlert();
    } catch (e) {
      table.innerHTML = '<span style="color:#dc2626">加载失败：' + (e.message || e) + '</span>';
    }
  }

  function bbPoolChip(group, val, label, n, cls) {
    var on = String(_bbPoolFilter[group]) === String(val);
    return '<button type="button" class="bbx-chip' + (on ? ' on' : '') + '"' + (cls ? ' data-c="' + cls + '"' : '') +
      ' data-g="' + group + '" data-v="' + val + '">' + label +
      (n === null || n === undefined ? '' : ' <span class="bbx-n">' + n + '</span>') + '</button>';
  }

  function renderBandBBSPoolChips() {
    var host = document.getElementById('bbPoolChips');
    if (!host) return;
    var c = bbPoolCountsLocal();
    var h = '';
    h += '<div class="bbx-frow"><span class="bbx-flabel">状态</span>' +
      bbPoolChip('status', '', '全部', c.all) +
      bbPoolChip('status', 'unassigned', '未发放', c.unassigned, 'prize') +
      bbPoolChip('status', 'assigned', '已发放', c.assigned) +
      bbPoolChip('status', 'claimed', '已领取', c.claimed, 'ok') +
      bbPoolChip('status', 'unclaimed', '已发未领', c.unclaimed) +
      '<label class="bbx-search">' + BB_SEARCH_SVG +
      '<input id="bbPoolSearch" type="search" placeholder="搜奖品 ID / 获奖人 / 资源" value="' + bbEsc(_bbPoolFilter.q || '') + '" autocomplete="off" style="border:0;background:transparent;outline:none;color:inherit;font:inherit;width:190px"></label>' +
      '</div>';
    var batches = {}; var hasBatch = false;
    for (var i = 0; i < _bbPool.length; i++) { if (_bbPool[i].batch) { batches[_bbPool[i].batch] = 1; hasBatch = true; } }
    if (hasBatch) {
      var bk = Object.keys(batches);
      h += '<div class="bbx-frow"><span class="bbx-flabel">批次</span>' + bbPoolChip('batch', '', '全部', c.all);
      for (var j = 0; j < bk.length; j++) {
        var n = 0;
        for (var k = 0; k < _bbPool.length; k++) if (String(_bbPool[k].batch) === String(bk[j])) n++;
        h += bbPoolChip('batch', bk[j], String(bk[j]), n);
      }
      h += '</div>';
    }
    host.innerHTML = h;
  }

  function bbSetPoolFilter(group, val) {
    _bbPoolFilter[group] = val;
    var chips = document.querySelectorAll('#bbPoolChips .bbx-chip');
    for (var i = 0; i < chips.length; i++) {
      if (chips[i].getAttribute('data-g') !== group) continue;
      chips[i].classList.toggle('on', String(chips[i].getAttribute('data-v')) === String(val));
    }
    applyBandBBSPoolFilter();
  }

  function applyBandBBSPoolFilter() {
    var table = document.getElementById('bbRewardLogTable');
    if (!table) return;
    var f = _bbPoolFilter, q = (f.q || '').toLowerCase(), out = [];
    for (var i = 0; i < _bbPool.length; i++) {
      var it = _bbPool[i], st = bbPoolState(it);
      if (f.status === 'assigned') { if (st === 'unassigned') continue; }
      else if (f.status && st !== f.status) continue;
      if (f.batch && String(it.batch) !== String(f.batch)) continue;
      if (q) {
        var hay = ((it.couponCode || '') + ' ' + (it.assignedTo || '') + ' ' + (it.resourceId || '')).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(it);
    }
    bbRenderPoolTable(out);
    bbUpdatePoolFoot(out);
  }

  function bbRenderPoolTable(list) {
    var table = document.getElementById('bbRewardLogTable');
    if (!table) return;
    if (!list.length) { table.innerHTML = '<span class="muted">当前筛选下没有奖品</span>'; return; }
    var rows = '';
    for (var i = 0; i < list.length; i++) {
      var it = list[i], st = bbPoolState(it);
      var pill = st === 'claimed' ? '<span class="bbx-pill ok">已领取</span>'
               : st === 'unclaimed' ? '<span class="bbx-pill prize">已发未领</span>'
               : st === 'unassigned' ? '<span class="bbx-pill">未发放</span>'
               : '<span class="bbx-pill">已发放</span>';
      var code = it.couponCode ? '<code class="bbx-code">' + bbEsc(String(it.couponCode).substring(0, 14)) + '</code>' : '<span class="muted">—</span>';
      var link = it.goSlug ? '<span class="bbx-code">' + bbEsc(it.goSlug) + '</span>'
               : it.goUrl ? '<span class="bbx-code">' + bbEsc(String(it.goUrl).replace(/^https?:\/\//, '').substring(0, 26)) + '…</span>'
               : '<span class="muted">—</span>';
      var who = it.assignedTo ? '<span class="bbx-user">' + bbEsc(it.assignedTo) + '</span>' : '<span class="muted">未发放</span>';
      // 获奖人 + 发放时间合并为一列两行（原两列），配合缩窄的兑换链接列，整表更透气
      var whoCell = '<div class="bbx-cell2">' + who +
        (it.assignedAt ? '<span class="bbx-sub">' + bbEsc(bbShortTime(it.assignedAt)) + '</span>' : '') + '</div>';
      var op = it.couponCode ? '<button type="button" class="bbx-mini" data-copy="' + bbEsc(it.couponCode) + '">复制 ID</button>' : '<span class="muted">—</span>';
      rows += '<tr' + (st === 'unassigned' ? ' class="bbx-dim"' : '') + '>' +
        '<td>' + code + '</td>' +
        '<td>' + link + '</td>' +
        '<td>' + pill + '</td>' +
        '<td>' + whoCell + '</td>' +
        '<td class="bb-op-cell">' + op + '</td>' +
        '</tr>';
    }
    table.innerHTML = '<div style="overflow-x:auto"><table class="bbx-table"><thead><tr><th style="width:132px">奖品池 ID</th><th>兑换链接</th><th style="width:96px">状态</th><th style="width:170px">获奖人 / 发放时间</th><th style="width:96px">操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function bbUpdatePoolFoot(list) {
    var c = bbPoolCountsLocal();
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    set('bbPoolTotal', c.all);
    set('bbPoolRemaining', c.unassigned);
    set('bbPoolUsed', c.assigned);
    set('bbPoolClaimed', c.claimed);
    var f = document.getElementById('bbPoolFoot');
    if (f) f.textContent = '当前 ' + list.length + ' 条 · 共 ' + c.all + ' 条 · 未发放 ' + c.unassigned + ' · 已发放 ' + c.assigned + '（已领取 ' + c.claimed + ' / 已发未领 ' + c.unclaimed + '）';
  }

  function updatePoolAlert() {
    var el = document.getElementById('bbPoolAlert');
    if (!el) return;
    var c = bbPoolCountsLocal();
    var pending = 0;
    if (typeof _bbReviews !== 'undefined' && _bbReviews && _bbReviews.length) {
      for (var i = 0; i < _bbReviews.length; i++) { if (bbEligible(_bbReviews[i]) && !_bbReviews[i].rewarded) pending++; }
    }
    if (window._bbPoolDegraded) {
      var tot = window._bbPoolDegradedTotal;
      if (tot) {
        var te = document.getElementById('bbPoolTotal'); if (te) te.textContent = tot;
        var re = document.getElementById('bbPoolRemaining'); if (re) re.textContent = Math.max(0, tot - c.assigned);
      }
      el.innerHTML = BB_ALERT_SVG + '<span>后端暂未支持「全量奖品列表」接口，下方<b>仅显示已发放</b>奖品' +
        (tot ? '；奖品池实际共 <b>' + tot + '</b> 条，未发放的暂不显示' : '') +
        '。<b>数据仍在库中，未丢失</b></span>';
      el.classList.add('on');
      return;
    }
    var parts = [];
    if (c.unassigned > 0) parts.push('<b>' + c.unassigned + '</b> 份奖品未发放');
    if (pending > 0) parts.push('另有 <b>' + pending + '</b> 位五星用户待发奖');
    if (!parts.length) { el.classList.remove('on'); el.innerHTML = ''; return; }
    el.innerHTML = BB_ALERT_SVG + '<span>当前有 ' + parts.join('，') + '</span>';
    el.classList.add('on');
  }

  function bbCopyText(txt, btn) {
    if (!txt) return;
    var done = function () {
      if (!btn) return;
      var o = btn.textContent; btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = o; }, 1200);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, done); return; }
    } catch (_) {}
    done();
  }

  // Initialize reward pool section（批次3：统一由 loadRewardPool 加载全量奖品）
  loadRewardPool();

  // Auto-init: if bandbbs panel is already active (page loaded with ?tab=bandbbs),
  // loadBandBBS was skipped by the inline script guard; trigger it now.
  (function autoInitBandBBS() {
    console.log('[bandbbs] auto-init: checking panel...');
    var panel = document.getElementById('panel-bandbbs');
    console.log('[bandbbs] auto-init: panel found:', !!panel, 'active:', panel ? panel.classList.contains('active') : 'N/A');
    if (panel && panel.classList.contains('active')) {
      console.log('[bandbbs] auto-init: panel is active, calling loadBandBBS()');
      loadBandBBS();
    } else {
      console.log('[bandbbs] auto-init: panel not active, skipping');
    }
  })();