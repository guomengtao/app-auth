/**
 * api/admin/health.js 的 clientHasAccess() 单测
 *
 * 背景：delivery-callback / delivery-query / delivery-sync 会返回消息 payload 全文
 * （兑换码、激活码、用户昵称、IP）。它有三条合法通道：
 *   ① 设备令牌（x-ev-device-token）—— 推荐通道，走「授权登录」拿到，可逐台撤销
 *   ② 共享密钥 EV_SYNC_TOKEN      —— 过渡期兼容
 *   ③ 后台面板 cookie             —— 浏览器里用
 * 以及一个模式开关 EV_AUTH_MODE=strict（只认 ① 和 ③，不再放行匿名）。
 *
 * 运行: node test/admin-client-access.test.js
 */
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = 'guomengtao@gmail.com';
const GOOD_DEVICE = 'good-device-token-value';
const GOOD_SYNC = 'test-sync-token-123';

// ── mock 掉 health.js 的全部外部依赖 ───────────────────────────────
const STUBS = {
  'lib/redis.js': { getRedis: () => null },
  'lib/auth.js': {
    requireAuth: (req) => ({
      authorized: !!(req && req.headers && req.headers.cookie && req.headers.cookie.includes('admin_session')),
    }),
  },
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
  'lib/device-token.js': {
    verifyDeviceToken: async (tok) => {
      if (tok === 'boom') throw new Error('db down');
      return tok === GOOD_DEVICE ? { id: 1, email: ADMIN, label: 'MacBook' } : null;
    },
  },
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
  else { fails.push(name); console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const req = (headers, query) => ({ headers: headers || {}, query: query || {} });
const devReq = (tok) => req({ 'x-ev-device-token': tok });

(async () => {
  console.log('--- 模式 A：默认 + 未配 EV_SYNC_TOKEN（历史兼容行为）---');
  delete process.env.EV_SYNC_TOKEN;
  delete process.env.EV_AUTH_MODE;
  check('未配置：匿名放行（不能因缺配置中断补拉）', (await clientHasAccess(req())) === true);
  check('未配置：带错 token 也放行', (await clientHasAccess(req({ 'x-ev-sync-token': 'whatever' }))) === true);
  check('未配置：无 headers 字段也不崩', (await clientHasAccess({ query: {} })) === true);
  check('未配置：完全空对象也不崩', (await clientHasAccess({})) === true);
  check('未配置：有效设备令牌放行', (await clientHasAccess(devReq(GOOD_DEVICE))) === true);

  console.log('\n--- 模式 B：默认 + 配了 EV_SYNC_TOKEN ---');
  process.env.EV_SYNC_TOKEN = GOOD_SYNC;
  check('已配置：无凭据 → 拒绝', (await clientHasAccess(req())) === false);
  check('已配置：错共享密钥 → 拒绝', (await clientHasAccess(req({ 'x-ev-sync-token': 'wrong' }))) === false);
  check('已配置：对共享密钥（header）→ 放行',
    (await clientHasAccess(req({ 'x-ev-sync-token': GOOD_SYNC }))) === true);
  check('已配置：对共享密钥（?token=）→ 放行',
    (await clientHasAccess(req({}, { token: GOOD_SYNC }))) === true);
  check('已配置：空字符串 token → 拒绝',
    (await clientHasAccess(req({ 'x-ev-sync-token': '' }))) === false);
  check('已配置：数组 token → 拒绝（String([x])===x 的绕过）',
    (await clientHasAccess(req({ 'x-ev-sync-token': [GOOD_SYNC] }))) === false);
  check('已配置：前缀相同的错 token → 拒绝',
    (await clientHasAccess(req({ 'x-ev-sync-token': GOOD_SYNC + 'x' }))) === false);
  check('已配置：★有效设备令牌 → 放行（新通道，不需要共享密钥）',
    (await clientHasAccess(devReq(GOOD_DEVICE))) === true);
  check('已配置：无效设备令牌 + 无共享密钥 → 拒绝',
    (await clientHasAccess(devReq('bogus'))) === false);
  check('已配置：设备令牌校验抛错 → 不崩且拒绝',
    (await clientHasAccess(devReq('boom'))) === false);
  check('已配置：后台面板 cookie → 放行',
    (await clientHasAccess(req({ cookie: 'admin_session=abc' }))) === true);
  check('已配置：无关 cookie → 拒绝',
    (await clientHasAccess(req({ cookie: 'theme=dark' }))) === false);

  console.log('\n--- 模式 C：EV_AUTH_MODE=strict（最终形态：停用共享密钥）---');
  process.env.EV_AUTH_MODE = 'strict';
  check('strict：匿名 → 拒绝（不再放行）', (await clientHasAccess(req())) === false);
  check('strict：★有效设备令牌 → 放行', (await clientHasAccess(devReq(GOOD_DEVICE))) === true);
  check('strict：无效设备令牌 → 拒绝', (await clientHasAccess(devReq('bogus'))) === false);
  check('strict：正确的共享密钥也不接受 → 拒绝',
    (await clientHasAccess(req({ 'x-ev-sync-token': GOOD_SYNC }))) === false);
  check('strict：后台 cookie → 放行',
    (await clientHasAccess(req({ cookie: 'admin_session=abc' }))) === true);
  check('strict：无效设备令牌 + cookie → 放行（cookie 兜底）',
    (await clientHasAccess(req({ 'x-ev-device-token': 'bogus', cookie: 'admin_session=abc' }))) === true);
  delete process.env.EV_SYNC_TOKEN;
  check('strict：即使没配 EV_SYNC_TOKEN 也拒绝匿名', (await clientHasAccess(req())) === false);
  process.env.EV_AUTH_MODE = 'STRICT';
  check('strict：大小写不敏感', (await clientHasAccess(req())) === false);

  delete process.env.EV_AUTH_MODE;
  delete process.env.EV_SYNC_TOKEN;

  console.log('\nPASS: ' + pass + '  FAILED: ' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });
