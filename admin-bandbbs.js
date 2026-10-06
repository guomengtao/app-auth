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
          tbody.innerHTML = '<tr><td colspan="7" class="empty">No resources configured</td></tr>';
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
          resourcesHtml += '<div style="margin:4px 0">#' + rid + ': ' + (v.error ? '<span style="color:#dc2626">错误: ' + v.error + '</span>' : v.count + ' reviews (' + (v.title || '') + ')') + '</div>';
        }
        box.innerHTML = '<div style="color:#16a34a;font-weight:600;margin-bottom:8px">抓取完成</div>' +
          '<div>新增评论: <b>' + r.newReviews + '</b> | Rewards Sent: <b>' + r.rewards.sent + '</b> | 跳过: <b>' + r.rewards.skipped + '</b> | 错误: <b>' + r.rewards.errors + '</b></div>' +
          '<div style="margin-top:4px">耗时: ' + r.duration + 'ms</div>' +
          '<div style="margin-top:8px">' + resourcesHtml + '</div>';
      } else {
        box.innerHTML = '<span style="color:#dc2626">抓取失败: ' + ((result && result.error) || '未知错误') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">请求失败: ' + (e.message || e) + '</span>';
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
        alert('Failed: ' + ((result && result.error) || 'Unknown'));
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
        resultBox.innerHTML = '<span style="color:#16a34a">已发送给 ' + recipient + ' (会话ID: ' + (result.conversationId || '-') + ')</span>';
      } else {
        resultBox.innerHTML = '<span style="color:#dc2626">发送失败: ' + ((result && result.error) || '未知错误') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbDmResult').innerHTML = '<span style="color:#dc2626">Request failed: ' + (e.message || e) + '</span>';
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
          h += '<div style="margin:4px 0">#' + k + ': ' + (v.error ? '<span style="color:#dc2626">Error: ' + v.error + '</span>' : v.count + ' reviews') + '</div>';
        }
        box.innerHTML = '<div style="color:#16a34a;font-weight:600;margin-bottom:8px">抓取完成</div>' +
          '<div>资源 <b>' + rid + '</b> | 新增: <b>' + r.newReviews + '</b> | 已发: <b>' + r.rewards.sent + '</b> | 跳过: <b>' + r.rewards.skipped + '</b> | 错误: <b>' + r.rewards.errors + '</b></div>' +
          '<div style="margin-top:4px">' + r.duration + 'ms</div><div style="margin-top:8px">' + h + '</div>';
      } else {
        box.innerHTML = '<span style="color:#dc2626">抓取失败: ' + ((result && result.error) || '未知') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">Request failed: ' + (e.message || e) + '</span>';
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
          var sum = (l.resources || []).map(function(x){ return '#'+x.resourceId+' ('+(x.count||0)+' reviews, new '+(x.newCount||0)+', sent '+(x.sent||0)+')'; }).join(', ');
          rows += '<tr><td style="font-size:0.75rem">'+(l.at||'-')+'</td><td>'+(l.mode==='cron'?'<span style="color:#f59e0b">定时</span>':'<span style="color:#16a34a">手动</span>')+'</td><td style="max-width:400px">'+(sum||'-')+'</td><td>'+(l.newReviews||0)+'</td><td>'+(l.rewardsSent||0)+'</td></tr>';
        }
        box.innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>时间</th><th>模式</th><th>资源</th><th>新增</th><th>已发</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
      } else { box.innerHTML = '<span class="muted">暂无记录</span>'; }
    } catch (e) { box.innerHTML = '<span class="muted">加载失败</span>'; }
  }


  async function loadBandBBSReviews() {
    // Load resource list into filter dropdown + show all reviews
    var sel = document.getElementById('bbDetailResourceSelect');
    var box = document.getElementById('bbReviewTable');
    if (!box) return;
    box.innerHTML = '<span class="muted">加载中...</span>';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=config');
      if (result && result.success) {
        var configs = result.data || [];
        var opts = '<option value="">全部资源</option>';
        for (var i = 0; i < configs.length; i++) {
          var c = configs[i];
          opts += '<option value="' + c.resourceId + '">#' + c.resourceId + ' - ' + (c.title || '') + '</option>';
        }
        if (sel) { sel.innerHTML = opts; }
        // Load all reviews by default
        filterBandBBSReviews();
      } else if (box) {
        box.innerHTML = '<span style="color:#dc2626">加载资源列表失败</span>';
      }
    } catch (e) {
      if (box) box.innerHTML = '<span style="color:#dc2626">请求失败: ' + (e.message || e) + '</span>';
    }
  }
async function loadBandBBSReviewsByResource(rid, box) {
    // Load reviews for a specific resource (used by filterBandBBSReviews)
    box.innerHTML = '<span class="muted">加载中...</span>';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=resource-detail&resourceId=' + encodeURIComponent(rid));
      if (!result || !result.success) {
        box.innerHTML = '<span style="color:#dc2626">失败: ' + ((result && result.error) || '未知') + '</span>';
        return [];
      }
      var d = result.data;
      var reviews = d.reviews || [];
      // Attach resourceId to each review for display
      for (var i = 0; i < reviews.length; i++) reviews[i]._resourceId = rid;
      return reviews;
    } catch (e) {
      box.innerHTML = '<span style="color:#dc2626">请求失败: ' + (e.message || e) + '</span>';
      return [];
    }
  

  async function filterBandBBSReviews() {
    var sel = document.getElementById('bbDetailResourceSelect');
    var statusFilter = document.getElementById('bbRewardFilter');
    var box = document.getElementById('bbReviewTable');
    if (!box) return;
    var rid = sel ? sel.value : '';
    var statusVal = statusFilter ? statusFilter.value : '';
    box.innerHTML = '<span class="muted">加载中...</span>';
    
    try {
      var configResult = await api('/api/admin/catalog?kind=bandbbs&op=config');
      var configs = (configResult && configResult.success && configResult.data) ? configResult.data : [];
      
      // If a specific resource selected, load only that one; else load all
      var allReviews = [];
      if (rid) {
        allReviews = await loadBandBBSReviewsByResource(rid, box);
      } else {
        // Load all resources' reviews
        for (var i = 0; i < configs.length; i++) {
          var c = configs[i];
          var rvs = await loadBandBBSReviewsByResource(c.resourceId, box);
          allReviews = allReviews.concat(rvs);
        }
      }
      
      // Apply reward status filter
      if (statusVal === 'rewarded') {
        allReviews = allReviews.filter(function(r) { return r.rewarded; });
      } else if (statusVal === 'not_rewarded') {
        allReviews = allReviews.filter(function(r) { return !r.rewarded; });
      }
      
      // Render table
      if (!allReviews.length) {
        box.innerHTML = '<span class="muted">暂无评论数据</span>';
        return;
      }
      
      var rows = '';
      for (var j = 0; j < allReviews.length; j++) {
        var rv = allReviews[j];
        var badge = rv.rewarded ? '<span style="color:#16a34a;font-weight:600">已发放</span>' : '<span style="color:#9ca3af">未发放</span>';
        var starsHtml = '';
        var starCount = (rv.stars !== undefined && rv.stars !== null) ? Number(rv.stars) : 0;
        for (var k = 0; k < 5; k++) starsHtml += k < starCount ? '★' : '☆';
        rows += '<tr>' +
          '<td style="font-size:0.75rem">#' + (rv._resourceId || '-') + '</td>' +
          '<td>' + (rv.username || '-') + '</td>' +
          '<td style="color:#f59e0b">' + starsHtml + '</td>' +
          '<td style="max-width:300px;white-space:pre-wrap;font-size:0.8125rem">' + (rv.content || '-') + '</td>' +
          '<td style="font-size:0.75rem">' + (rv.time || '-') + '</td>' +
          '<td>' + badge + '</td></tr>';
      }
      box.innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>资源</th><th>用户名</th><th>星级</th><th>内容</th><th>时间</th><th>奖励状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    } catch (e) {
      box.innerHTML = '<span style="color:#dc2626">加载失败: ' + (e.message || e) + '</span>';
    }
  }

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
          '<div>资源 <b>#' + rid + '</b> | 已发送: <b>' + (result.sent || 0) + '</b> | 跳过: <b>' + (result.skipped || 0) + '</b> | 错误: <b>' + (result.errors || 0) + '</b></div>';
        if (result.notEnough) {
          box.innerHTML += '<div style="color:#f59e0b;margin-top:4px">⚠️ 奖励池链接不足，还有 ' + result.notEnough + ' 条评论未发送</div>';
        }
      } else {
        box.innerHTML = '<span style="color:#dc2626">发送失败: ' + ((result && result.error) || '未知错误') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">请求失败: ' + (e.message || e) + '</span>';
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
    if (!template) { statusEl.textContent = 'Template cannot be empty'; return; }
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=reward-pool-save-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: template })
      });
      if (result && result.success) {
        statusEl.textContent = 'Saved';
        setTimeout(function() { statusEl.textContent = ''; }, 2000);
      } else {
        statusEl.textContent = 'Failed: ' + ((result && result.error) || 'unknown');
      }
    } catch (e) {
      statusEl.textContent = 'Error: ' + (e.message || e);
    }
  }

  // Batch import reward links
  async function importRewardLinks() {
    var linksText = document.getElementById('bbRewardImportArea').value.trim();
    var statusEl = document.getElementById('bbImportStatus');
    if (!linksText) { statusEl.textContent = 'Please paste redeem links first'; return; }
    statusEl.textContent = 'Importing...';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=reward-pool-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: linksText })
      });
      if (result && result.success) {
        var msg = 'Imported ' + result.imported + ' new links';
        if (result.skipped) msg += ', skipped ' + result.skipped + ' duplicates';
        if (result.errors && result.errors.length) msg += ', ' + result.errors.length + ' errors';
        statusEl.textContent = msg;
        document.getElementById('bbRewardImportArea').value = '';
        loadPoolStats();
        loadRewardLog();
      } else {
        statusEl.textContent = 'Failed: ' + ((result && result.error) || 'unknown');
      }
    } catch (e) {
      statusEl.textContent = 'Error: ' + (e.message || e);
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
    table.innerHTML = '<span class="muted">Loading...</span>';

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
          var opts = '<option value="">All Resources</option>';
          for (var i = 0; i < configs.length; i++) {
            var c = configs[i];
            opts += '<option value="' + c.resourceId + '">#' + c.resourceId + ' - ' + (c.title || '') + '</option>';
          }
          resourceFilter.innerHTML = opts;
          if (resourceId) resourceFilter.value = resourceId;
        }

        if (!logs.length) {
          table.innerHTML = '<span class="muted">No reward records</span>';
          return;
        }
        var rows = '';
        for (var j = 0; j < logs.length; j++) {
          var l = logs[j];
          var badge = l.claimed ? '<span style="color:#16a34a;font-weight:600">Claimed</span>' : '<span style="color:#f59e0b">Unclaimed</span>';
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
        table.innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>Code</th><th>User</th><th>Resource</th><th>Stars</th><th>Status</th><th>Assigned At</th><th>Go Link</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      } else {
        table.innerHTML = '<span style="color:#dc2626">Failed to load</span>';
      }
    } catch (e) {
      table.innerHTML = '<span style="color:#dc2626">Error: ' + (e.message || e) + '</span>';
    }
  }

  // Initialize reward pool section
  loadPoolStats();
  loadRewardLog();

}
