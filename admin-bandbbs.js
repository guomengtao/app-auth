async function loadBandBBS() {
    try {
      var data = await api('/api/admin/catalog?kind=bandbbs&op=stats');
      if (data && data.success && data.data) {
        var s = data.data;
        document.getElementById('bbStatResources').textContent = s.resources || 0;
        document.getElementById('bbStatReviews').textContent = s.totalReviews || 0;
        document.getElementById('bbStatRewards').textContent = s.totalRewarded || 0;
        document.getElementById('bbStatLastPoll').textContent = s.lastPoll || '-';
      }
      var configData = await api('/api/admin/catalog?kind=bandbbs&op=config');
      if (configData && configData.success && configData.data) {
        var configs = configData.data;
        var tbody = document.getElementById('bbResourcesTable');
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

  async function sendBandBBSDM() {
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

  function applyBandBBSReviewFilter() {
    var box = document.getElementById('bbReviewTable');
    if (!box) return;
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
      var pidCell = pid ? '<code class="bbx-code">' + bbEsc(String(pid).substring(0, 14)) + '</code>' : '<span class="muted">—</span>';
      var at = r.assignedAt || r.rewardedAt || r.assigned_at || '';
      rows += '<tr' + (state === 'none' ? ' style="opacity:.62"' : '') + '>' +
        '<td><span class="muted">#' + bbEsc(r._resourceId || '-') + '</span></td>' +
        '<td>' + bbEsc(r.username || '-') + '</td>' +
        '<td class="bbx-stars">' + stars + '</td>' +
        '<td class="bbx-content">' + bbEsc(r.content || '-') + '</td>' +
        '<td>' + pidCell + '</td>' +
        '<td>' + pill + '</td>' +
        '<td><span class="muted">' + bbEsc(at || '—') + '</span></td>' +
        '</tr>';
    }
    box.innerHTML = '<div style="overflow-x:auto"><table class="bbx-table"><thead><tr><th>资源</th><th>用户</th><th>评分</th><th>评论内容</th><th>奖品池 ID</th><th>发放状态</th><th>发放时间</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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
      if (!chip) return;
      bbSetReviewFilter(chip.getAttribute('data-g'), chip.getAttribute('data-v'));
    });
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || t.id !== 'bbReviewSearch') return;
      _bbFilter.q = t.value || '';
      applyBandBBSReviewFilter();
    });
  })();


  async function sendRewardForResource(rid, btnEl) {
    if (!confirm('确定要给资源帖 #' + rid + ' 的所有未奖励五星评论发送奖励私信吗？')) return;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '发送中...'; }
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=send-rewards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: rid })
      });
      var box = document.getElementById('bbPollResult');
      if (result && result.success) {
        box.innerHTML = '<div style="color:#16a34a;font-weight:600;margin-bottom:8px">奖励发送完成</div>' +
          '<div>资源 <b>#' + rid + '</b> | 已发送: <b>' + (result.sent || 0) + '</b> | 跳过：<b>' + (result.skipped || 0) + '</b> | 错误：<b>' + (result.errors || 0) + '</b></div>';
        if (result.notEnough) {
          box.innerHTML += '<div style="color:#f59e0b;margin-top:4px">⚠️ 奖励池链接不足，还有 ' + result.notEnough + ' 条评论未发送</div>';
        }
      } else {
        box.innerHTML = '<span style="color:#dc2626">发送失败: ' + ((result && result.error) || '未知错误') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">请求失败：' + (e.message || e) + '</span>';
    }
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '发送奖励'; }
    loadBandBBS();
    filterBandBBSReviews();
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
        loadRewardLog();
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

  // Load reward distribution log
  async function loadRewardLog() {
    var resourceFilter = document.getElementById('bbRewardLogResourceFilter');
    var statusFilter = document.getElementById('bbRewardLogStatusFilter');
    var table = document.getElementById('bbRewardLogTable');
    if (!table) return;
    table.innerHTML = '<span class="muted">加载中...</span>';

    var resourceId = resourceFilter ? resourceFilter.value : '';
    var status = statusFilter ? statusFilter.value : '';

    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=reward-log&resourceId=' + encodeURIComponent(resourceId) + '&status=' + encodeURIComponent(status));
      if (result && result.success && result.data) {
        var logs = result.data;
        // Populate resource filter
        if (resourceFilter) {
          var configResult = await api('/api/admin/catalog?kind=bandbbs&op=config');
          var configs = (configResult && configResult.success && configResult.data) ? configResult.data : [];
          var opts = '<option value="">全部资源</option>';
          for (var i = 0; i < configs.length; i++) {
            var c = configs[i];
            opts += '<option value="' + c.resourceId + '">#' + c.resourceId + ' - ' + (c.title || '') + '</option>';
          }
          resourceFilter.innerHTML = opts;
          if (resourceId) resourceFilter.value = resourceId;
        }

        if (!logs.length) {
          table.innerHTML = '<span class="muted">暂无发放记录</span>';
          return;
        }
        var rows = '';
        for (var j = 0; j < logs.length; j++) {
          var l = logs[j];
          var badge = l.claimed ? '<span style="color:#16a34a;font-weight:600">已领取</span>' : '<span style="color:#f59e0b">未领取</span>';
          rows += '<tr>' +
            '<td style="font-size:0.75rem">' + (l.couponCode ? l.couponCode.substring(0, 8) + '...' : '-') + '</td>' +
            '<td>' + (l.assignedTo || '-') + '</td>' +
            '<td>#' + (l.resourceId || '-') + '</td>' +
            '<td>' + (l.reviewStars || '-') + '</td>' +
            '<td>' + badge + '</td>' +
            '<td style="font-size:0.75rem">' + (l.assignedAt || '-') + '</td>' +
            '<td style="font-size:0.75rem"><a href="' + (l.goUrl || '#') + '" target="_blank" style="color:var(--accent)">' + (l.goSlug || '-') + '</a></td>' +
            '</tr>';
        }
        table.innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>兑换码</th><th>用户</th><th>资源</th><th>星级</th><th>状态</th><th>发放时间</th><th>跳转链接</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      } else {
        table.innerHTML = '<span style="color:#dc2626">加载失败</span>';
      }
    } catch (e) {
      table.innerHTML = '<span style="color:#dc2626">错误：' + (e.message || e) + '</span>';
    }
  }

  // Initialize reward pool section
  loadPoolStats();
  loadRewardLog();

