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
              '<td><button class="btn btn-sm" onclick="deleteBandBBSResource(\'' + c.resourceId + '\')" style="color:#dc2626">Delete</button></td>' +
              '</tr>';
          }
          tbody.innerHTML = rows;
        }
      }
    } catch (e) {
      console.error('loadBandBBS failed:', e);
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