/**
 * lib/auth.js 鉴权回归测试 —— 核心是「绝不允许伪造 cookie 通过」
 *
 * 背景（2026-09-26 实测确认的真实漏洞）：
 *   requireAuth() 曾信任 Vercel 平台种的 `_vercel_jwt` cookie，并且**只 base64 解码、不验签**。
 *   于是任何人不需要任何密钥，把 {"email":"<ADMIN_EMAIL>"} 做一次 base64 拼成三段串，
 *   就能通过鉴权 —— 实测伪造后可拿到 section=stats 的真实业务数据。
 *
 * 这个测试是那个漏洞的护栏：任何"只解码不验签"的分支复活都会立刻挂掉。
 *
 * 运行: node test/auth-forged-cookie.test.js
 */
process.env.JWT_SECRET = "test-secret-for-regression-do-not-use-in-prod";
process.env.ADMIN_EMAIL = "guomengtao@gmail.com";

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const auth = require(path.join(ROOT, 'lib', 'auth.js'));

const ADMIN = "guomengtao@gmail.com";

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** 构造一个「签名随便填」的 _vercel_jwt —— 攻击者视角 */
const forgedVercelJwt = (email) => `_vercel_jwt=${b64({alg:'HS256',typ:'JWT'})}.${b64({email, name:'forged'})}.not-a-real-signature`;

const reqWith = (cookie) => ({ headers: { cookie } });

// ── 1. 核心回归：任何伪造的 _vercel_jwt 都必须被拒 ──────────────────
const forgedCases = [
  ['标准伪造（正确邮箱 + 假签名）', forgedVercelJwt(ADMIN)],
  ['邮箱大小写变形',              forgedVercelJwt(ADMIN.toUpperCase())],
  ['签名段为空',                  `_vercel_jwt=${b64({})}.${b64({email:ADMIN})}.`],
  ['只有两段',                    `_vercel_jwt=${b64({})}.${b64({email:ADMIN})}`],
  ['payload 不是 base64',         '_vercel_jwt=a.b.c'],
  ['payload 非 JSON',             `_vercel_jwt=${b64({})}.${Buffer.from('not json').toString('base64url')}.x`],
];
for (const [label, cookie] of forgedCases) {
  const r = auth.requireAuth(reqWith(cookie));
  check('伪造 _vercel_jwt 被拒：' + label, r.authorized === false, r);
}

// ── 2. 合法自签 token 必须通过 ─────────────────────────────────────
const good = auth.sign({ email: ADMIN, provider: 'vercel_oauth', exp: Date.now() + 3600000 });
check('自签合法 token → 放行', auth.requireAuth(reqWith('token=' + good)).authorized === true);

// ── 3. 自签但语义不符 → 拒 ─────────────────────────────────────────
const wrongEmail = auth.sign({ email: 'someone@example.com', provider: 'vercel_oauth', exp: Date.now() + 3600000 });
check('自签但邮箱不在白名单 → 拒', auth.requireAuth(reqWith('token=' + wrongEmail)).authorized === false);

const wrongProvider = auth.sign({ email: ADMIN, provider: 'password', exp: Date.now() + 3600000 });
check('自签但 provider 不是 vercel_oauth → 拒', auth.requireAuth(reqWith('token=' + wrongProvider)).authorized === false);

const noProvider = auth.sign({ email: ADMIN, exp: Date.now() + 3600000 });
check('自签但缺 provider → 拒', auth.requireAuth(reqWith('token=' + noProvider)).authorized === false);

const expired = auth.sign({ email: ADMIN, provider: 'vercel_oauth', exp: Date.now() - 1000 });
check('过期 token → 拒', auth.requireAuth(reqWith('token=' + expired)).authorized === false);

// ── 4. 篡改 payload 但保留原签名 → 必须拒（验签真的在生效）─────────
const parts = good.split('.');
const tamperedPayload = b64({ email: ADMIN, provider: 'vercel_oauth', exp: Date.now() + 99999999 });
const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
check('篡改 payload 保留旧签名 → 拒（验签生效）', auth.requireAuth(reqWith('token=' + tampered)).authorized === false);

// 用别的密钥签的 token
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'attacker-secret';
delete require.cache[require.resolve(path.join(ROOT, 'lib', 'auth.js'))];
const auth2 = require(path.join(ROOT, 'lib', 'auth.js'));
const foreignToken = auth2.sign({ email: ADMIN, provider: 'vercel_oauth', exp: Date.now() + 3600000 });
process.env.JWT_SECRET = originalSecret;
delete require.cache[require.resolve(path.join(ROOT, 'lib', 'auth.js'))];
const auth3 = require(path.join(ROOT, 'lib', 'auth.js'));
check('用别的密钥签的 token → 拒', auth3.requireAuth(reqWith('token=' + foreignToken)).authorized === false);

// ── 5. 无凭据 / 畸形输入 → 401 且不崩 ─────────────────────────────
const noAuth = auth.requireAuth(reqWith(''));
check('无 cookie → 401', noAuth.authorized === false && noAuth.status === 401, noAuth);
check('无 headers 字段不崩', auth.requireAuth({}).authorized === false);
check('cookie 只有分号不崩', auth.requireAuth(reqWith(';;;')).authorized === false);
check('token 为空串 → 401', auth.requireAuth(reqWith('token=')).authorized === false);

// ── 5b. 缺 exp / req 结构异常的加固 ────────────────────────────────
const noExp = auth.sign({ email: ADMIN, provider: 'vercel_oauth' });
check('自签但缺 exp → 拒（不能永不过期）', auth.requireAuth(reqWith('token=' + noExp)).authorized === false);

// ── 6. requireAuth 只从 cookie 读，不认自定义 header ───────────────
check('不认 x-ev-sync-token header（那是客户端专用通道）',
  auth.requireAuth({ headers: { 'x-ev-sync-token': 'anything' } }).authorized === false);

// ── 7. lib/vercel-auth.js 已改为委托，不再有独立解码分支 ────────────
const va = require(path.join(ROOT, 'lib', 'vercel-auth.js'));
let status = null, body = null;
const fakeRes = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
check('requireVercelAdmin：伪造 _vercel_jwt → false',
  va.requireVercelAdmin(reqWith(forgedVercelJwt(ADMIN)), fakeRes) === false);
check('requireVercelAdmin：伪造时返回 401', status === 401, status);
check('requireVercelAdmin：合法 token → true',
  va.requireVercelAdmin(reqWith('token=' + good), fakeRes) === true);
check('lib/vercel-auth.js 不再导出 decodeJwtPayload（去掉"只解码"的能力）',
  typeof va.decodeJwtPayload === 'undefined');

console.log('\nPASS: ' + pass + '  FAILED: ' + fails.length);
process.exit(fails.length ? 1 : 0);
