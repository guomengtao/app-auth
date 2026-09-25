/**
 * lib/message-delivery.js 单元测试（mock 掉 lib/postgres.js，断言生成的 SQL）
 * 运行: node test/message-delivery.sync.test.js
 */
const Module = require('module');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const PG_PATH = require.resolve(path.join(ROOT, 'lib', 'postgres.js'));

// ── mock lib/postgres.js ──────────────────────────────────────────
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

const md = require(path.join(ROOT, 'lib', 'message-delivery.js'));

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const lastSql = () => QUERIES[QUERIES.length - 1];

(async () => {
  // 1. createMessageDelivery 返回 { messageId, seq } 且带 RETURNING id
  QUERIES = [];
  NEXT_RESULT = { rows: [{ id: '4242' }], rowCount: 1 };
  const rec = await md.createMessageDelivery({
    messageType: 'new_order', payload: { a: 1 }, source: 'notify.js',
  });
  check('create 返回对象含 messageId', !!rec && typeof rec.messageId === 'string' && rec.messageId.length === 36, JSON.stringify(rec));
  check('create 返回 seq = RETURNING id', rec && String(rec.seq) === '4242', rec && rec.seq);
  check('INSERT 带 RETURNING id', /RETURNING id\s*$/.test(lastSql().trim()), lastSql().slice(-60));
  check('INSERT 初始状态 pending', /'pending'/.test(lastSql()));

  // 2. payload 里的单引号必须被转义，不能破坏 SQL
  QUERIES = [];
  NEXT_RESULT = { rows: [{ id: 1 }], rowCount: 1 };
  await md.createMessageDelivery({
    messageType: 'x', payload: { evil: "o'brien" }, source: 's',
  });
  const inj = lastSql();
  check("payload 单引号被转义为 ''", inj.includes("o''brien"), inj.slice(0, 200));
  check('payload 仍是合法 jsonb 字面量', /'\{.*\}'::jsonb/.test(inj));

  // 3. getSince：游标语义
  QUERIES = [];
  NEXT_RESULT = { rows: [{ seq: '10' }, { seq: '11' }], rowCount: 2 };
  await md.getSince(9, 200, 336);
  let sql = lastSql();
  check('getSince 用 id > 游标', /WHERE id > 9\b/.test(sql), sql);
  check('getSince 按 id 排序（不用时间）', /ORDER BY id ASC/.test(sql), sql);
  check('getSince 不用 created_at 排序', !/ORDER BY created_at/.test(sql));
  check('getSince LIMIT 生效', /LIMIT 200\s*$/.test(sql.trim()), sql.slice(-40));
  check('getSince 带保留期上界', /created_at > NOW\(\) - INTERVAL '336 hours'/.test(sql));

  // 4. getSince limit 钳制
  QUERIES = [];
  await md.getSince(0, 99999);
  check('getSince limit 钳到 500', /LIMIT 500\s*$/.test(lastSql().trim()), lastSql().slice(-30));
  QUERIES = [];
  await md.getSince(NaN, undefined);
  check('getSince 非法入参有默认值', /WHERE id > 0\b/.test(lastSql()) && /LIMIT 200\s*$/.test(lastSql().trim()), lastSql());

  // 5. getMaxSeq
  QUERIES = [];
  NEXT_RESULT = { rows: [{ max_seq: '288' }], rowCount: 1 };
  const mx = await md.getMaxSeq();
  check('getMaxSeq 返回数字', mx === 288, mx);
  check('getMaxSeq 用 COALESCE(MAX(id),0)', /COALESCE\(MAX\(id\), 0\)/.test(lastSql()));

  // 6. markDelivered 放宽门禁（修掉「卡 pending → 0 行生效」）
  QUERIES = [];
  await md.markDelivered('m1', 'cli-a');
  sql = lastSql();
  check('markDelivered 允许 pending/published', /status IN \('pending', 'published'\)/.test(sql), sql.slice(-80));
  check('markDelivered 写 delivered_at', /delivered_at/.test(sql));
  check('markDelivered 写 target_client', /target_client = 'cli-a'/.test(sql));

  // 7. markConfirmed 放宽门禁
  QUERIES = [];
  await md.markConfirmed('m1');
  check('markConfirmed 允许 pending/published/delivered',
    /status IN \('pending', 'published', 'delivered'\)/.test(lastSql()), lastSql().slice(-80));

  // 8. 批量回执
  QUERIES = [];
  NEXT_RESULT = { rows: [], rowCount: 3 };
  const n = await md.markDeliveredBatch(['a', 'b', '', null, 'c'], 'cli-b');
  sql = lastSql();
  check('批量回执返回 rowCount', n === 3, n);
  check('批量回执 IN 列表只含有效 id', /IN \('a', 'b', 'c'\)/.test(sql), sql.slice(-90));
  check('批量回执同样放宽门禁', /status IN \('pending', 'published'\)/.test(sql));
  QUERIES = [];
  const n0 = await md.markDeliveredBatch([], 'x');
  check('批量回执空数组不发 SQL', QUERIES.length === 0 && n0 === 0, QUERIES.length);

  QUERIES = [];
  NEXT_RESULT = { rows: [], rowCount: 2 };
  await md.markConfirmedBatch(['a', 'b']);
  check('批量 confirmed 只影响未确认态',
    /status IN \('pending', 'published', 'delivered'\)/.test(lastSql()), lastSql().slice(-90));

  // 9. 导出完整性：新增函数都要在 exports 里
  for (const fn of ['getSince', 'getMaxSeq', 'markDeliveredBatch', 'markConfirmedBatch']) {
    check('exports 含 ' + fn, typeof md[fn] === 'function');
  }

  console.log('\nPASS: ' + pass + '  FAILED: ' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('测试脚本异常:', e); process.exit(2); });
