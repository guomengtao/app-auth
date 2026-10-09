/* eslint-disable */
/**
 * 建表：evops_usage（每会话用量：积分合计 + Token 累计）
 * 用法：node scripts/setup-evops-usage.js
 *
 * 与 setup-evops-messages.js 同源：连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING 优先，
 * DDL 走直连更稳），执行同目录 setup-evops-usage.sql。幂等。
 * 方案：ev-ops-android/docs/积分消耗统计-方案.md（evtask-D-evev-ops-and-261009-3xecvb）
 */
const fs = require('fs');
const path = require('path');

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

function pgUrl() {
  var url = process.env.Ev_POSTGRES_URL_NON_POOLING ||
    process.env.Ev_POSTGRES_URL ||
    process.env.SUPABASE_POSTGRES_URL ||
    process.env.Ev_POSTGRES_PRISMA_URL;
  if (!url) {
    console.error('Missing Ev_POSTGRES_URL(_NON_POOLING)');
    process.exit(1);
  }
  // 剥离 pooler 标记与 sslmode（Supabase 池化链路自签证书会与 ssl 选项冲突，见 setup-evops-sessions.js）
  return url
    .replace(/&supa=base-pooler\.x/, '')
    .replace(/([?&])sslmode=[^&]*/g, '$1')
    .replace(/[?&]$/, '');
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'setup-evops-usage.sql'), 'utf-8');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Running setup-evops-usage.sql ...');
    await pool.query(sql);

    // 验证 1：evops_usage 列齐全
    const cols = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_usage' order by ordinal_position");
    console.log('OK · evops_usage 列 =', cols.rows.map(function (r) { return r.column_name; }).join(', '));

    // 验证 2：RLS 已开启
    const rls = await pool.query(
      "select relrowsecurity from pg_class where relname = 'evops_usage'");
    console.log('OK · RLS =', (rls.rows[0] || {}).relrowsecurity ? '已开启' : '未开启(异常)');

    // 验证 3：索引
    const idx = await pool.query(
      "select indexname from pg_indexes where tablename = 'evops_usage' order by indexname");
    console.log('OK · 索引 =', idx.rows.map(function (r) { return r.indexname; }).join(', '));

    // 验证 4：行数（空表起步）
    const n = await pool.query('select count(*)::int as c from evops_usage');
    console.log('OK · evops_usage 行数 =', (n.rows[0] || {}).c);
  } catch (e) {
    console.error('FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
