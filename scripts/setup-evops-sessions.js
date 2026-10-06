/* eslint-disable */
/**
 * 建表：evops_sessions（会话身份一等实体）+ evops_tasks.session_sid 列
 * 用法：node scripts/setup-evops-sessions.js
 *
 * 与 setup-evops-config.js 同源：连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING 优先，
 * DDL 走直连更稳），执行同目录 setup-evops-sessions.sql。幂等。
 *
 * 不依赖 dotenv（本仓未装）—— 自己解析 .env / .env.local 填充 process.env（不覆盖已有）。
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
  // 去掉 pooler 标记；并**剥离 sslmode**（Supabase 池化链路是自签证书链，
  // 连接串里的 sslmode=verify-full 会覆盖下方 Pool 的 ssl 选项导致
  // "self-signed certificate in certificate chain"；改由 ssl:{rejectUnauthorized:false} 统一控制）。
  return url
    .replace(/&supa=base-pooler\.x/, '')
    .replace(/([?&])sslmode=[^&]*/g, '$1')
    .replace(/[?&]$/, '');
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'setup-evops-sessions.sql'), 'utf-8');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Running setup-evops-sessions.sql ...');
    await pool.query(sql);

    // 验证 1：evops_sessions 表结构（列齐全）
    const cols = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_sessions' order by ordinal_position");
    console.log('OK · evops_sessions 列 =', cols.rows.map(function (r) { return r.column_name; }).join(', '));

    // 验证 2：evops_tasks.session_sid 已加列（P1 关键：不存在的列会让 REST select 直接 400）
    const has = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_tasks' and column_name = 'session_sid'");
    console.log('OK · evops_tasks.session_sid =', has.rows.length ? '存在' : '缺失(异常)');

    // 验证 3：现有行数（空表起步）
    const n = await pool.query('select count(*)::int as c from evops_sessions');
    console.log('OK · evops_sessions 行数 =', (n.rows[0] || {}).c);
  } catch (e) {
    console.error('FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
