/* eslint-disable */
/**
 * 建表：evops_commits（git 提交流水，大屏「最近 Git 提交」轮播页数据源）
 * 用法：node scripts/setup-evops-commits.js
 *
 * 与 setup-evops-messages.js 同源：连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING 优先，
 * DDL 走直连更稳），执行同目录 setup-evops-commits.sql。幂等。
 * 方案：docs/EvOps大屏-最近Git提交Tab-方案.md §4（2026-10-12，evtask-D-evapp-auth-261012-43ax37）
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
  const sql = fs.readFileSync(path.join(__dirname, 'setup-evops-commits.sql'), 'utf-8');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Running setup-evops-commits.sql ...');
    await pool.query(sql);

    // 验证 1：evops_commits 列齐全
    const cols = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_commits' order by ordinal_position");
    console.log('OK · evops_commits 列 =', cols.rows.map(function (r) { return r.column_name; }).join(', '));

    // 验证 2：RLS anon 读策略存在
    const pol = await pool.query(
      "select policyname from pg_policies where tablename = 'evops_commits' order by policyname");
    console.log('OK · RLS 策略 =', pol.rows.map(function (r) { return r.policyname; }).join(', ') || '缺失(异常)');

    // 验证 3：行数（空表起步）
    const n = await pool.query('select count(*)::int as c from evops_commits');
    console.log('OK · evops_commits 行数 =', (n.rows[0] || {}).c);
  } catch (e) {
    console.error('FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
