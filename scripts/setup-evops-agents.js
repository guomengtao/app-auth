/* eslint-disable */
/**
 * 建表：evops_agents（AI 开发者昵称注册表）
 *     + evops_messages 加 token 用量列（tok_in/tok_out/tok_total）
 *     + 视图 v_evops_model_daily（追加 token）+ v_evops_agent_daily
 * 用法：node scripts/setup-evops-agents.js
 *
 * 与 setup-evops-messages.js 同源：连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING 优先），
 * 执行同目录 setup-evops-agents.sql。幂等。
 * 方案：docs/数据大屏V5-AI开发者视角-升级方案.md §六（2026-10-09，用户批「开工」+「用量一起上屏」）
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
  const sql = fs.readFileSync(path.join(__dirname, 'setup-evops-agents.sql'), 'utf-8');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Running setup-evops-agents.sql ...');
    await pool.query(sql);

    // 验证 1：evops_agents 列齐全
    const ac = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_agents' order by ordinal_position");
    console.log('OK · evops_agents 列 =', ac.rows.map(function (r) { return r.column_name; }).join(', '));

    // 验证 2：nickname 无 unique 约束（允许重名）
    const uc = await pool.query(
      "select count(*)::int c from information_schema.table_constraints tc " +
      "join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name " +
      "where tc.table_name='evops_agents' and tc.constraint_type='UNIQUE' and ccu.column_name='nickname'");
    console.log('OK · nickname unique 约束数 =', uc.rows[0].c, '(应为 0 → 允许重名)');

    // 验证 3：evops_messages token 三列已加
    const tc = await pool.query(
      "select column_name from information_schema.columns " +
      "where table_name = 'evops_messages' and column_name in ('tok_in','tok_out','tok_total') order by column_name");
    console.log('OK · evops_messages token 列 =', tc.rows.map(function (r) { return r.column_name; }).join(', '));

    // 验证 4：两个视图存在，且 model_daily 含 tok_total
    for (const v of ['v_evops_model_daily', 'v_evops_agent_daily']) {
      const vv = await pool.query("select table_name from information_schema.views where table_name = $1", [v]);
      console.log('OK · 视图 ' + v + ' =', vv.rows.length ? '存在' : '缺失(异常)');
    }
    const vc = await pool.query(
      "select column_name from information_schema.columns where table_name = 'v_evops_model_daily' " +
      "and column_name in ('tok_in','tok_out','tok_total') order by column_name");
    console.log('OK · v_evops_model_daily token 列 =', vc.rows.map(function (r) { return r.column_name; }).join(', '));
  } catch (e) {
    console.error('FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
