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
              '<td>' + (c.enabled ? '<span style="color:#16a34a">Enabled</span>' : '<span style="color:#dc2626">Disabled</span>') + '</td>' +
              '<td>' + (typeof c.lastPollCount === 'number' ? c.lastPollCount : '-') + '</td>' +
              '<td style="font-size:0.75rem">' + (c.lastPollAt || '-') + '</td>' +
              '<td>' + (typeof c.lastPollNew === 'number' ? '<span style="color:#16a34a">+' + c.lastPollNew + '</span>' : '-') + '</td>' +
              '<td style="white-space:nowrap">' +
              '<button class="btn btn-sm" onclick="pollSingleBandBBS(' + c.resourceId + ', this)" style="margin-right:4px">Scrape</button>' +
              '<button class="btn btn-sm" onclick="showBandBBSDetail(' + c.resourceId + ', this)">Detail</button>' +
              '<button class="btn btn-sm" onclick="deleteBandBBSResource(' + c.resourceId + ')" style="color:#dc2626;margin-left:4px">Delete</button></td>' +
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
    btn.textContent = 'Polling...';
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
          resourcesHtml += '<div style="margin:4px 0">Resource ' + rid + ': ' + (v.error ? '<span style="color:#dc2626">Error: ' + v.error + '</span>' : v.count + ' reviews (' + (v.title || '') + ')') + '</div>';
        }
        box.innerHTML = '<div style="color:#16a34a;font-weight:600;margin-bottom:8px">Poll Complete</div>' +
          '<div>New Reviews: <b>' + r.newReviews + '</b> | Rewards Sent: <b>' + r.rewards.sent + '</b> | Skipped: <b>' + r.rewards.skipped + '</b> | Errors: <b>' + r.rewards.errors + '</b></div>' +
          '<div style="margin-top:4px">Duration: ' + r.duration + 'ms</div>' +
          '<div style="margin-top:8px">' + resourcesHtml + '</div>';
      } else {
        box.innerHTML = '<span style="color:#dc2626">Poll failed: ' + ((result && result.error) || 'Unknown error') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">Request failed: ' + (e.message || e) + '</span>';
    }
    btn.disabled = false;
    btn.textContent = 'Manual Poll';
    loadBandBBS();
  }

  async function addBandBBSResource() {
    var rid = document.getElementById('bbResourceId').value.trim();
    var title = document.getElementById('bbResourceTitle').value.trim();
    if (!rid) { alert('Please enter a Resource ID'); return; }
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=config-save&resourceId=' + encodeURIComponent(rid), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: rid, title: title || ('Resource ' + rid), enabled: true })
      });
      if (result && result.success) {
        document.getElementById('bbResourceId').value = '';
        document.getElementById('bbResourceTitle').value = '';
        loadBandBBS();
      } else {
        alert('Failed: ' + ((result && result.error) || 'Unknown'));
      }
    } catch (e) {
      alert('Error: ' + (e.message || e));
    }
  }

  async function deleteBandBBSResource(rid) {
    if (!confirm('Delete resource ' + rid + '?')) return;
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
    if (!recipient || !title || !message) { alert('Please fill all fields'); return; }
    var btn = document.getElementById('btnSendDm');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=send-dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: recipient, title: title, message: message })
      });
      var resultBox = document.getElementById('bbDmResult');
      if (result && result.success) {
        resultBox.innerHTML = '<span style="color:#16a34a">DM sent to ' + recipient + ' (Conv ID: ' + (result.conversationId || '-') + ')</span>';
      } else {
        resultBox.innerHTML = '<span style="color:#dc2626">Send failed: ' + ((result && result.error) || 'Unknown error') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbDmResult').innerHTML = '<span style="color:#dc2626">Request failed: ' + (e.message || e) + '</span>';
    }
    btn.disabled = false;
    btn.textContent = 'Send DM';
  }

  async function pollSingleBandBBS(rid, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '...'; }
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
        box.innerHTML = '<div style="color:#16a34a;font-weight:600;margin-bottom:8px">Scrape Complete</div>' +
          '<div>Resource <b>' + rid + '</b> | New: <b>' + r.newReviews + '</b> | Sent: <b>' + r.rewards.sent + '</b> | Skipped: <b>' + r.rewards.skipped + '</b> | Errors: <b>' + r.rewards.errors + '</b></div>' +
          '<div style="margin-top:4px">' + r.duration + 'ms</div><div style="margin-top:8px">' + h + '</div>';
      } else {
        box.innerHTML = '<span style="color:#dc2626">Scrape failed: ' + ((result && result.error) || 'Unknown') + '</span>';
      }
    } catch (e) {
      document.getElementById('bbPollResult').innerHTML = '<span style="color:#dc2626">Request failed: ' + (e.message || e) + '</span>';
    }
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Scrape'; }
    loadBandBBS();
  }

  async function showBandBBSDetail(rid, btnEl) {
    var block = document.getElementById('bbDetailBlock');
    if (block) block.style.display = 'block';
    var box = document.getElementById('bbDetailResult');
    if (!box) return;
    box.innerHTML = '<span class="muted">Loading detail...</span>';
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=resource-detail&resourceId=' + encodeURIComponent(rid));
      if (result && result.success) {
        var d = result.data;
        var rows = '';
        var reviews = d.reviews || [];
        if (!reviews.length) {
          rows = '<tr><td colspan="5" class="empty">No reviews stored yet</td></tr>';
        } else {
          for (var i = 0; i < reviews.length; i++) {
            var rv = reviews[i];
            var badge = rv.rewarded ? '<span style="color:#16a34a;font-weight:600">Rewarded</span>' : '<span style="color:#9ca3af">Not rewarded</span>';
            rows += '<tr>' +
              '<td>' + (rv.username || '-') + '</td>' +
              '<td>' + (rv.stars || (rv.rating || '-')) + '</td>' +
              '<td style="max-width:320px;white-space:pre-wrap">' + (rv.content || '-') + '</td>' +
              '<td style="font-size:0.75rem">' + (rv.time || '-') + '</td>' +
              '<td>' + badge + '</td></tr>';
          }
        }
        box.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<h3 style="margin:0">Resource #' + d.resourceId + ' - ' + (d.title || '') + '</h3>' +
          '<span class="muted" style="font-size:0.8125rem">Last poll: ' + (d.lastPollAt || '-') + ' | New: ' + (d.lastPollNew || 0) + '</span></div>' +
          '<div style="overflow-x:auto"><table><thead><tr><th>Username</th><th>Rating</th><th>Content</th><th>Time</th><th>Reward</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      } else {
        box.innerHTML = '<span style="color:#dc2626">Failed: ' + ((result && result.error) || 'Unknown') + '</span>';
      }
    } catch (e) {
      box.innerHTML = '<span style="color:#dc2626">Request failed: ' + (e.message || e) + '</span>';
    }
  }

  async function loadBandBBSPollLogs() {
    var box = document.getElementById('bbPollLogResult');
    if (!box) return;
    try {
      var result = await api('/api/admin/catalog?kind=bandbbs&op=poll-logs&limit=30');
      if (result && result.success) {
        var logs = result.data || [];
        if (!logs || !logs.length) { box.innerHTML = '<span class="muted">No records yet</span>'; return; }
        var rows = '';
        for (var i = 0; i < logs.length; i++) {
          var l = logs[i];
          var sum = (l.resources || []).map(function(x){ return '#'+x.resourceId+' ('+(x.count||0)+' reviews, new '+(x.newCount||0)+', sent '+(x.sent||0)+')'; }).join(', ');
          rows += '<tr><td style="font-size:0.75rem">'+(l.at||'-')+'</td><td>'+(l.mode==='cron'?'<span style="color:#f59e0b">cron</span>':'<span style="color:#16a34a">manual</span>')+'</td><td style="max-width:400px">'+(sum||'-')+'</td><td>'+(l.newReviews||0)+'</td><td>'+(l.rewardsSent||0)+'</td></tr>';
        }
        box.innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>Time</th><th>Mode</th><th>Resources</th><th>New</th><th>Sent</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
      } else { box.innerHTML = '<span class="muted">No records</span>'; }
    } catch (e) { box.innerHTML = '<span class="muted">Failed</span>'; }
  }
