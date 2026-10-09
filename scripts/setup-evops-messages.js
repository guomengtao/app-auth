/* eslint-disable */
/**
 * 建表：evops_messages（钩子事件流，会话/模型全字段落库）
 *     + evops_sessions.model/models/client/version 四列 + evops_tasks.model 一列
 *     + 视图 v_evops_model_daily
 * 用法：node scripts/setup-evops-messages.js
 *
 * 与 setup-evops-sessions.js 同源：连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING 优先，
 * DDL 走直连更稳），执行同目录 setup-evops-messages.sql。幂等。
 * 方案：docs/会话与模型数据入库Supabase-方案.md §③（2026-10-09）
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
  const sql = fs.readFileSync(path.join(__dirname, 'setup-evops-messages.sql'), 'utf-8');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Running setup-evops-messages.sql ...');
    await pool.query(sql);

    // 验证 1：evops_messages 列齐全
    const cols = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_messages' order by ordinal_position");
    console.log('OK · evops_messages 列 =', cols.rows.map(function (r) { return r.column_name; }).join(', '));

    // 验证 2：evops_sessions 新列（model/client/version）已加
    const sc = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_sessions' and column_name in ('model','models','client','version') " +
      "order by column_name");
    console.log('OK · evops_sessions 新列 =', sc.rows.map(function (r) { return r.column_name; }).join(', '));

    // 验证 3：evops_tasks.model 已加
    const tc = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_tasks' and column_name = 'model'");
    console.log('OK · evops_tasks.model =', tc.rows.length ? '存在' : '缺失(异常)');

    // 验证 4：视图存在
    const v = await pool.query(
      "select table_name from information_schema.views where table_name = 'v_evops_model_daily'");
    console.log('OK · 视图 v_evops_model_daily =', v.rows.length ? '存在' : '缺失(异常)');

    // 验证 5：行数（空表起步）
    const n = await pool.query('select count(*)::int as c from evops_messages');
    console.log('OK · evops_messages 行数 =', (n.rows[0] || {}).c);
  } catch (e) {
    console.error('FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
