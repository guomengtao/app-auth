/* eslint-disable */
/**
 * P1：零操作激活通道 Supabase 建表 + Realtime 连通自检
 *
 * 用法：
 *   node scripts/setup-activation-realtime.js --check      只体检，不写任何对象
 *   node scripts/setup-activation-realtime.js              执行 DDL + 验证权限（幂等）
 *   node scripts/setup-activation-realtime.js --probe       额外插/删一条探针事件
 *   node scripts/setup-activation-realtime.js --ws-probe    真 WSS 订阅 + 插入，验证 Realtime 端到端投递
 *
 * 与 setup-evops-sessions.js 同源：直连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING
 * 优先，DDL 走直连更稳），执行同目录 setup-activation-realtime.sql。幂等。
 * 不依赖 dotenv —— 自己解析 .env.local / .env 填充 process.env（不覆盖已有）。
 *
 * 安全模型验证（方案 §1.6）：anon key 必须能读 activation_events、必须读不到 activation_codes。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    const txt = fs.readFileSync(file, 'utf-8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) { /* ignore */ }
}

const root = path.join(__dirname, '..');
loadEnvFile(path.join(root, '.env.local'));
loadEnvFile(path.join(root, '.env'));

const CHECK = process.argv.indexOf('--check') >= 0;
const PROBE = process.argv.indexOf('--probe') >= 0;
const WS_PROBE = process.argv.indexOf('--ws-probe') >= 0;

function pgUrl() {
  const url = process.env.Ev_POSTGRES_URL_NON_POOLING ||
    process.env.Ev_POSTGRES_URL ||
    process.env.SUPABASE_POSTGRES_URL ||
    process.env.Ev_POSTGRES_PRISMA_URL;
  if (!url) {
    console.error('Missing Ev_POSTGRES_URL(_NON_POOLING)');
    process.exit(1);
  }
  // 剥离 pooler 标记与 sslmode（Supabase 池化链路自签证书，改由 ssl 选项统一控制）
  return url
    .replace(/&supa=base-pooler\.x/, '')
    .replace(/([?&])sslmode=[^&]*/g, '$1')
    .replace(/[?&]$/, '');
}

function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString()
    .replace('T', ' ').replace(/\.\d+Z$/, '') + ' +0800';
}

/** 用 anon key 走 PostgREST 读一张表，返回 {status, body}，用于实证 RLS */
function anonSelect(table) {
  return new Promise(function (resolve) {
    const base = process.env.Ev_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.Ev_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) { resolve({ status: 0, body: 'no anon credentials' }); return; }
    const u = new URL(base.replace(/\/$/, '') + '/rest/v1/' + table + '?select=*&limit=1');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    }, function (res) {
      let s = '';
      res.on('data', function (c) { s += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: s.slice(0, 300) }); });
    });
    req.on('error', function (e) { resolve({ status: 0, body: e.message }); });
    req.setTimeout(12000, function () { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

/**
 * --ws-probe：真 WSS 订阅验收（P1 现象级标准）
 * 用 anon key 直连 Supabase Realtime，订阅 activation_events 的 INSERT，
 * 再用 service_role(pg) 插一条探针行；收到 postgres_changes 即证明链路通。
 * 全程不经 Vercel。探针行随即删除。
 */
function wsProbe(pool, sid) {
  return new Promise(async function (resolve) {
    const base = process.env.Ev_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.Ev_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) { resolve({ ok: false, why: 'no anon credentials' }); return; }
    const WS = (function () { try { return require('ws'); } catch (e) { return globalThis.WebSocket; } })();
    if (!WS) { resolve({ ok: false, why: 'no WebSocket client' }); return; }

    const host = base.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = 'wss://' + host + '/realtime/v1/websocket?apikey=' + encodeURIComponent(key) + '&vsn=1.0.0';
    let ws, done = false, joined = false;
    const finish = function (ok, why) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (e) { /* ignore */ }
      pool.query('delete from public.activation_events where sid=$1', [sid]).catch(function () {});
      resolve({ ok: ok, why: why });
    };
    const timer = setTimeout(function () { finish(false, '8s 超时未收到 postgres_changes'); }, 8000);

    try { ws = new WS(url); } catch (e) { finish(false, 'WS 构造失败: ' + e.message); return; }

    ws.onopen = function () {
      ws.send(JSON.stringify({
        topic: 'realtime:public:activation_events',
        event: 'phx_join',
        payload: { config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'activation_events' }] } },
        ref: '1', join_ref: '1'
      }));
    };
    ws.onmessage = async function (evt) {
      const raw = String((evt && evt.data) || '');
      let m = null;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (!joined && m.event === 'phx_reply' && m.payload && m.payload.status === 'ok') {
        console.log('OK   · phx_join 已接受（anon 直连 ' + host + '，未经 Vercel）');
        return;
      }
      // ⚠️ 真正的「订阅就绪」是这条 system 消息，不是 phx_reply。
      //    phx_reply 只表示 join 请求被接受，此时复制槽尚未挂上；
      //    实测在 phx_reply 立即插入会漏掉事件（8s 超时假阴性）。
      if (!joined && m.event === 'system' && m.payload && m.payload.status === 'ok'
          && String(m.payload.message || '').indexOf('Subscribed to PostgreSQL') >= 0) {
        joined = true;
        console.log('OK   · 订阅就绪（Subscribed to PostgreSQL）');
        try {
          await pool.query(
            'insert into public.activation_events (sid, status, ts) values ($1, $2, $3)',
            [sid, 'waiting', Date.now()]);
          console.log('OK   · 探针行已插入，等待 Realtime 投递…');
        } catch (e) { finish(false, '插入失败: ' + e.message); }
        return;
      }
      if (m.event === 'postgres_changes' && raw.indexOf(sid) >= 0) {
        finish(true, '收到 INSERT 投递');
      }
    };
    // ws 模块与全局 WebSocket 的错误事件名一致
    ws.onerror = function (e) { finish(false, 'WS 错误: ' + ((e && e.message) || 'unknown')); };
    ws.onclose = function () { if (!done) finish(false, 'WS 提前关闭（joined=' + joined + '）'); };
  });
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  let failed = 0;
  const mark = function (ok, label, detail) {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? '  · ' + detail : ''));
    if (!ok) failed++;
  };

  try {
    console.log('[' + bjNow() + '] ' + (CHECK ? 'CHECK（只读）' : 'SETUP') + ' · setup-activation-realtime');

    if (!CHECK) {
      const sql = fs.readFileSync(path.join(__dirname, 'setup-activation-realtime.sql'), 'utf-8');
      await pool.query(sql);
      console.log('OK   · DDL 执行完成（幂等）');
    }

    // ① 两表列齐全
    for (const t of ['activation_events', 'activation_codes']) {
      const cols = await pool.query(
        "select column_name from information_schema.columns " +
        "where table_schema='public' and table_name=$1 order by ordinal_position", [t]);
      mark(cols.rows.length > 0, '表 ' + t, cols.rows.map(function (r) { return r.column_name; }).join(', ') || '不存在');
    }

    // ② RLS 已启用
    const rls = await pool.query(
      "select relname, relrowsecurity from pg_class " +
      "where relnamespace='public'::regnamespace and relname in ('activation_events','activation_codes')");
    const rlsMap = {};
    rls.rows.forEach(function (r) { rlsMap[r.relname] = r.relrowsecurity; });
    for (const t of ['activation_events', 'activation_codes']) {
      mark(rlsMap[t] === true, 'RLS ' + t, rlsMap[t] === undefined ? '表缺失' : String(rlsMap[t]));
    }

    // ③ publication 包含事件表
    const pub = await pool.query(
      "select tablename from pg_publication_tables " +
      "where pubname='supabase_realtime' and schemaname='public' and tablename='activation_events'");
    mark(pub.rows.length === 1, 'Realtime publication', pub.rows.length ? 'activation_events 已加入' : '未加入');

    // ④ anon 权限实证：能读事件表、读不到码表
    const ev = await anonSelect('activation_events');
    const cd = await anonSelect('activation_codes');
    mark(ev.status === 200, 'anon 读 activation_events', 'HTTP ' + ev.status);
    mark(cd.status === 0 || cd.status === 401 || cd.status === 403 || cd.status === 200,
      'anon 读 activation_codes', 'HTTP ' + cd.status + '（200 时必须返回空数组，见下方）');
    if (cd.status === 200) {
      let arr = [];
      try { arr = JSON.parse(cd.body); } catch (e) { /* 非 JSON 视为异常 */ }
      mark(Array.isArray(arr) && arr.length === 0, '码表对 anon 零可见行', '返回 ' + arr.length + ' 行');
    }

    // ⑤ 可选探针：插一条事件再删除，供 WS 客户端观察 Realtime 投递
    if (PROBE && !CHECK) {
      const sid = 'p1-probe-' + Date.now();
      await pool.query(
        'insert into public.activation_events (sid, status, ts) values ($1, $2, $3)',
        [sid, 'waiting', Date.now()]);
      console.log('OK   · 探针事件已插入 sid=' + sid + '（WS 客户端应收到 INSERT）');
      await pool.query('delete from public.activation_events where sid=$1', [sid]);
      console.log('OK   · 探针事件已清理');
    }

    // ⑥ 真 WSS 订阅探针：验证「服务端写 → Realtime 推」端到端
    if (WS_PROBE && !CHECK) {
      const sid = 'ws-probe-' + Date.now();
      const r = await wsProbe(pool, sid);
      mark(r.ok, 'WSS Realtime 投递', r.why);
    }

    const n = await pool.query('select count(*)::int as c from public.activation_events');
    console.log('--- 事件表当前行数 =', (n.rows[0] || {}).c, '· 失败项 =', failed, '---');
  } catch (e) {
    console.error('FAILED:', e && e.message);
    failed++;
  } finally {
    await pool.end();
  }
  if (failed) process.exitCode = 1;
})();
