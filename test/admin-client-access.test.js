/**
 * api/admin/health.js 的 clientHasAccess() 单测
 *
 * 背景：delivery-callback / delivery-query / delivery-sync 会返回消息 payload 全文
 * （兑换码、激活码、用户昵称、IP），原本完全匿名可拉。加了「可选共享密钥」后必须验证：
 *   1. 没配 EV_SYNC_TOKEN → 一律放行（不能因为没配就中断 EvNotifier 的离线补拉）
 *   2. 配了 → 必须带对 x-ev-sync-token（或 ?token=）
 *   3. 配了 → 后台面板的 cookie 鉴权仍要放行
 *
 * 运行: node test/admin-client-access.test.js
 */
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── mock 掉 health.js 的全部外部依赖 ───────────────────────────────
const STUBS = {
  'lib/redis.js': { getRedis: () => null },
  'lib/auth.js': { requireAuth: (req) => ({ authorized: !!(req && req.headers && req.headers.cookie && req.headers.cookie.includes('admin_session')) }) },
  'lib/crypto.js': {},
  'lib/quota.js': {},
  'lib/db-switches.js': {},
  'lib/db-registry.js': {},
  'lib/notify.js': { pushNotification: async () => true },
  'lib/geo-zh.js': {},
  'lib/geo-district.js': {},
  'lib/background.js': { run: () => {} },
  'lib/ip-warmup.js': {},
  'lib/verify-switch.js': {},
  'lib/message-delivery.js': {},
};

for (const rel of Object.keys(STUBS)) {
  const p = require.resolve(path.join(ROOT, rel));
  const m = new Module(p, null);
  m.filename = p;
  m.loaded = true;
  m.exports = STUBS[rel];
  require.cache[p] = m;
}

const handler = require(path.join(ROOT, 'api/admin/health.js'));
const clientHasAccess = handler.clientHasAccess;

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

const TOKEN = 'test-sync-token-123';
const req = (headers, query) => ({ headers: headers || {}, query: query || {} });

// ── 1. 未配置 EV_SYNC_TOKEN：一律放行（向后兼容，必须）─────────────
delete process.env.EV_SYNC_TOKEN;
check("未配置：匿名放行", clientHasAccess(req()) === true);
check("未配置：带了错 token 也放行（不因配置缺失而拒绝）",
  clientHasAccess(req({ 'x-ev-sync-token': 'whatever' })) === true);
check("未配置：无 headers 字段也不崩", clientHasAccess({ query: {} }) === true);
check("未配置：完全空对象也不崩", clientHasAccess({}) === true);

// ── 2. 配了 EV_SYNC_TOKEN ─────────────────────────────────────────
process.env.EV_SYNC_TOKEN = TOKEN;

check("已配置：无凭据 → 拒绝", clientHasAccess(req()) === false);
check("已配置：错 token → 拒绝", clientHasAccess(req({ 'x-ev-sync-token': 'wrong' })) === false);
check("已配置：对 token（header，小写）→ 放行",
  clientHasAccess(req({ 'x-ev-sync-token': TOKEN })) === true);
check("已配置：对 token（header，大小写混写）→ 放行",
  clientHasAccess(req({ 'X-Ev-Sync-Token': TOKEN })) === true);
check("已配置：对 token（?token=）→ 放行",
  clientHasAccess(req({}, { token: TOKEN })) === true);
check("已配置：空字符串 token → 拒绝",
  clientHasAccess(req({ 'x-ev-sync-token': '' })) === false);
check("已配置：非字符串（数组）token → 拒绝",
  clientHasAccess(req({ 'x-ev-sync-token': [TOKEN] })) === false);
check("已配置：前缀相同的错 token → 拒绝",
  clientHasAccess(req({ 'x-ev-sync-token': TOKEN + 'x' })) === false);

// ── 3. 已配置时，后台面板的 cookie 鉴权仍要放行 ────────────────────
check("已配置：后台面板 cookie 鉴权 → 放行",
  clientHasAccess(req({ cookie: 'admin_session=abc' })) === true);
check("已配置：无关 cookie → 拒绝",
  clientHasAccess(req({ cookie: 'theme=dark' })) === false);

// ── 4. 环境变量为空串等同未配置 ───────────────────────────────────
process.env.EV_SYNC_TOKEN = '';
check("空串配置等同未配置 → 放行", clientHasAccess(req()) === true);

delete process.env.EV_SYNC_TOKEN;
console.log('\nPASS: ' + pass + '  FAILED: ' + fails.length);
process.exit(fails.length ? 1 : 0);
