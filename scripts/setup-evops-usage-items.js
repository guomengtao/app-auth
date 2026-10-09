/* eslint-disable */
/**
 * 建表：evops_usage_items（每轮积分一行，append-only 明细）
 * 用法：node scripts/setup-evops-usage-items.js
 *
 * 与 setup-evops-usage.js 同源：连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING 优先，
 * DDL 走直连更稳），执行同目录 setup-evops-usage-items.sql。幂等。
 * 方案：ev-ops-android/docs/积分消耗统计-方案.md §九（evtask-D-evev-ops-and-261009-3xecvb 迭代）
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
  return url
    .replace(/&supa=base-pooler\.x/, '')
    .replace(/([?&])sslmode=[^&]*/g, '$1')
    .replace(/[?&]$/, '');
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'setup-evops-usage-items.sql'), 'utf-8');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Running setup-evops-usage-items.sql ...');
    await pool.query(sql);

    const cols = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_usage_items' order by ordinal_position");
    console.log('OK · evops_usage_items 列 =', cols.rows.map(function (r) { return r.column_name; }).join(', '));

    const rls = await pool.query(
      "select relrowsecurity from pg_class where relname = 'evops_usage_items'");
    console.log('OK · RLS =', (rls.rows[0] || {}).relrowsecurity ? '已开启' : '未开启(异常)');

    const idx = await pool.query(
      "select indexname from pg_indexes where tablename = 'evops_usage_items' order by indexname");
    console.log('OK · 索引 =', idx.rows.map(function (r) { return r.indexname; }).join(', '));

    const n = await pool.query('select count(*)::int as c from evops_usage_items');
    console.log('OK · evops_usage_items 行数 =', (n.rows[0] || {}).c);

    // ⭐ 实时推送开关：没进 publication，安卓长连接连上也收不到 INSERT 事件
    const pub = await pool.query(
      "select 1 from pg_publication_tables " +
      "where pubname='supabase_realtime' and schemaname='public' and tablename='evops_usage_items'");
    console.log('OK · supabase_realtime publication =', pub.rowCount > 0 ? '已加入（可实时推送）' : '未加入（收不到实时事件！）');
  } catch (e) {
    console.error('FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
