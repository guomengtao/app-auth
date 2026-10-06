/* eslint-disable */
/**
 * 建表：evops_config（槽位上限云端化）
 * 用法：node scripts/setup-evops-config.js
 *
 * 与 setup-supabase.js 同源：连 Supabase Postgres（Ev_POSTGRES_URL_NON_POOLING 优先，
 * DDL 走直连更稳），执行同目录 setup-evops-config.sql。幂等。
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
  const sql = fs.readFileSync(path.join(__dirname, 'setup-evops-config.sql'), 'utf-8');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: 3, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Running setup-evops-config.sql ...');
    await pool.query(sql);
    const r = await pool.query('select id, max_parallel, updated_by, updated_at from evops_config where id = 1');
    console.log('OK · evops_config =', JSON.stringify(r.rows[0] || null));
  } catch (e) {
    console.error('FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
