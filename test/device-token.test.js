/**
 * lib/device-token.js 单元测试（mock lib/postgres.js，断言生成的 SQL）
 *
 * 核心不变量：
 *   1. 明文 token **绝不落库**（库里只有 sha256）—— 这是整个方案的安全性基础
 *   2. 已撤销的令牌一律校验失败
 *   3. token 足够长且不可预测
 *   4. last_seen 更新要节流（不能每个请求都写库）
 *
 * 运行: node test/device-token.test.js
 */
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PG_PATH = require.resolve(path.join(ROOT, 'lib', 'postgres.js'));

let QUERIES = [];
let NEXT_RESULT = { rows: [], rowCount: 0 };
const fake = new Module(PG_PATH, null);
fake.filename = PG_PATH;
fake.loaded = true;
fake.exports = {
  query: async (sql) => {
    QUERIES.push(sql);
    return typeof NEXT_RESULT === 'function' ? NEXT_RESULT(sql) : NEXT_RESULT;
  },
};
require.cache[PG_PATH] = fake;

const dt = require(path.join(ROOT, 'lib', 'device-token.js'));

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const lastSql = () => QUERIES[QUERIES.length - 1];
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  // ── 1. 创建：返回明文，但库里只应有哈希 ────────────────────────
  QUERIES = [];
  NEXT_RESULT = { rows: [{ id: 7 }], rowCount: 1 };
  const created = await dt.createDeviceToken({ label: 'MacBook-Air', email: 'a@b.com', appVersion: 'v2.3.22' });
  check('create 返回 { id, token }', !!created && created.id === 7 && typeof created.token === 'string', created);
  check('token 长度 >= 40（32 字节 base64url）', created.token.length >= 40, created.token.length);

  const insertSql = QUERIES.find((q) => /INSERT INTO device_tokens/i.test(q));
  check('INSERT 到 device_tokens', !!insertSql);
  check('INSERT 里存的是 sha256 哈希（不是明文）',
    insertSql.includes("'" + sha256(created.token) + "'"), insertSql.slice(0, 120));
  check('INSERT 里**不含明文 token**', !insertSql.includes(created.token));
  check('INSERT 带 RETURNING id', /RETURNING id\s*$/.test(insertSql.trim()));

  // 单引号转义（label 里带引号不能破坏 SQL）
  QUERIES = [];
  NEXT_RESULT = { rows: [{ id: 8 }], rowCount: 1 };
  await dt.createDeviceToken({ label: "Bob's Mac", email: "o'brien@x.com" });
  const escSql = QUERIES.find((q) => /INSERT INTO device_tokens/i.test(q));
  check("label/email 单引号被转义", escSql.includes("Bob''s Mac") && escSql.includes("o''brien@x.com"), escSql.slice(0, 160));

  // ── 2. token 不可预测 ─────────────────────────────────────────
  NEXT_RESULT = { rows: [{ id: 9 }], rowCount: 1 };
  const a = await dt.createDeviceToken({ label: 'x', email: 'x' });
  const b = await dt.createDeviceToken({ label: 'x', email: 'x' });
  check('两次生成的 token 不同', a.token !== b.token);
  check('token 是 base64url 安全字符集', /^[A-Za-z0-9_-]+$/.test(a.token), a.token.slice(0, 20));

  // ── 3. 校验：必须按哈希查、且排除已撤销 ─────────────────────────
  QUERIES = [];
  NEXT_RESULT = { rows: [{ id: 11, email: 'a@b.com', label: 'Mac', last_seen_at: new Date().toISOString() }], rowCount: 1 };
  const tok = 'FAKE-TOKEN-FOR-VERIFY';
  const ok = await dt.verifyDeviceToken(tok, '1.2.3.4');
  const selSql = QUERIES.find((q) => /SELECT .* FROM device_tokens/i.test(q));
  check('verify 用 sha256 查', selSql.includes("token_hash = '" + sha256(tok) + "'"), selSql.slice(0, 120));
  check('verify 排除已撤销', /revoked_at IS NULL/.test(selSql));
  check('verify 命中返回设备信息', !!ok && ok.id === 11 && ok.email === 'a@b.com', ok);
  check('verify 更新时 last_seen 是节流的（刚更新过就不再写）',
    !QUERIES.some((q) => /UPDATE device_tokens SET last_seen_at/i.test(q)), QUERIES.length);

  // 未命中 → null
  QUERIES = [];
  NEXT_RESULT = { rows: [], rowCount: 0 };
  check('verify 未命中 → null', (await dt.verifyDeviceToken('nope', '')) === null);

  // 空/非字符串 → null 且不查库
  QUERIES = [];
  check('verify 空 token → null', (await dt.verifyDeviceToken('', '')) === null);
  check('verify 非字符串 → null', (await dt.verifyDeviceToken(null, '')) === null);
  check('verify 非法输入不查库', QUERIES.length === 0, QUERIES.length);

  // ── 4. last_seen 节流：超过 1 小时才写 ──────────────────────────
  QUERIES = [];
  const oldSeen = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  NEXT_RESULT = { rows: [{ id: 12, email: 'a@b.com', label: 'Mac', last_seen_at: oldSeen }], rowCount: 1 };
  await dt.verifyDeviceToken('t', '9.9.9.9');
  const touchSql = QUERIES.find((q) => /UPDATE device_tokens SET last_seen_at/i.test(q));
  check('last_seen 超过 1 小时 → 写库', !!touchSql);
  check('touch 写入 IP', !!touchSql && touchSql.includes("'9.9.9.9'"), touchSql && touchSql.slice(0, 140));
  check('touch 按 id 精确更新', !!touchSql && /WHERE id = 12/.test(touchSql));

  // ── 5. 撤销 / 列表 ────────────────────────────────────────────
  QUERIES = [];
  NEXT_RESULT = { rows: [], rowCount: 1 };
  check('revoke 返回影响行数', (await dt.revokeDeviceToken(7)) === 1);
  const revSql = lastSql();
  check('revoke 是软删除（写 revoked_at）', /UPDATE device_tokens SET revoked_at = now\(\)/.test(revSql));
  check('revoke 只影响未撤销的', /revoked_at IS NULL/.test(revSql), revSql.slice(0, 160));

  QUERIES = [];
  NEXT_RESULT = { rows: [], rowCount: 3 };
  check('revokeAll 返回影响行数', (await dt.revokeAllDevices()) === 3);

  QUERIES = [];
  NEXT_RESULT = { rows: [{ id: 1, label: 'Mac' }], rowCount: 1 };
  const list = await dt.listDevices();
  check('listDevices 返回数组', Array.isArray(list) && list.length === 1, list);
  check('listDevices 带 LIMIT', /LIMIT \d+/.test(lastSql()), lastSql().slice(0, 100));

  QUERIES = [];
  NEXT_RESULT = { rows: [{ id: 5, label: 'Mac' }], rowCount: 1 };
  const one = await dt.getById(5);
  check('getById 命中', !!one && one.id === 5);
  QUERIES = [];
  NEXT_RESULT = { rows: [], rowCount: 0 };
  check('getById 未命中 → null', (await dt.getById(999)) === null);

  // ── 6. DB 报错不能抛到调用方（鉴权路径必须"失败即拒绝"而不是 500）──
  NEXT_RESULT = () => { throw new Error('db down'); };
  check('create 遇 DB 错误 → null（不抛）', (await dt.createDeviceToken({ label: 'x', email: 'y' })) === null);
  check('verify 遇 DB 错误 → null（不抛，鉴权失败即拒绝）', (await dt.verifyDeviceToken('t', '')) === null);
  check('list 遇 DB 错误 → 空数组', (await dt.listDevices()).length === 0);
  check('revoke 遇 DB 错误 → 0', (await dt.revokeDeviceToken(1)) === 0);
  NEXT_RESULT = { rows: [], rowCount: 0 };

  // ── 7. 导出的 sha256 与 internal 一致（客户端/服务端对齐用）──────
  check('导出 sha256 可用', dt.sha256('abc') === sha256('abc'));

  console.log('\nPASS: ' + pass + '  FAILED: ' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });
