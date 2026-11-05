/**
 * lib/afdian-dm.js 模板层测试（2026-11-05，evtask-D-evapp-auth-261105-ta38xn）
 *
 * 保护点（改动前后必须一致的安全性）：
 *   ① 未保存过模板时，买家收到的 3 条文案与旧硬编码版本**逐字一致**（本文件内联旧实现做回归对比）
 *   ② 占位符缺值时沿用旧兜底（code 缺失 → 人工兜底话术；链接缺失 → 空串）
 *   ③ 未知占位符原样保留，不会被静默吃掉
 *   ④ 保存校验拒绝非 3 条 / 空模板 / 超长 —— 条数变了会破坏 dm_sent 断点续发
 *   ⑤ buildOrderJob 已改为 async，仍返回带 3 条 messages 的 job
 *
 * 运行: node test/afdian-dm-templates.test.js
 */
const dm = require('../lib/afdian-dm.js');

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fails.push(name);
    console.log('FAIL  ' + name + '  → ' + (e && e.message));
  }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || '') + '\n  期望: ' + JSON.stringify(expected) + '\n  实际: ' + JSON.stringify(actual));
  }
}
function ok(cond, label) {
  if (!cond) throw new Error(label || '断言失败');
}

// 改动前的字符串拼接实现（2026-11-05 之前 lib/afdian-dm.js 的 buildOrderMessages），用于逐字回归
function legacyMessages(o) {
  o = o || {};
  var productName = o.product_name || 'Ev课程表';
  var msg1 = '🎉 感谢您赞助 ' + productName + ' 永久高级版！\n\n您的兑换码：' + (o.code || '（发货异常请回复本消息）') + '\n\n激活方法（3 步，不用装任何东西）：\n1. 手环打开 Ev课程表 → 高级版 → 兑换码激活，记下屏幕上的 4 位设备ID\n2. 浏览器打开 https://app-auth.gudq.com/activate ，输入 4 位设备ID + 上面的兑换码\n3. 网页给出 18 位激活码，回手环输入即可激活\n\n也可以点这个链接自动激活（安卓专用，需装同步器，可能较慢）：\n' + (o.activate_url || '') + '\n\n若链接卡住，请用上面的手工方式，任一步有疑问直接回复本消息。';
  return [
    { i: 1, content: msg1 },
    { i: 2, content: '如有疑问欢迎回复~ 祝使用愉快！' },
    { i: 3, content: '安装步骤指导：' + (o.guide_url || '') },
  ];
}

const FULL = {
  product_name: 'Ev课程表 Pro',
  code: 'ABCD1234',
  activate_url: 'https://app-auth.gudq.com/x?code=ABCD1234',
  guide_url: 'https://app-auth.gudq.com/guide',
};

// ── ① 逐字回归 ─────────────────────────────────────────────────────────
check('默认模板渲染与旧实现逐字一致（全字段）', function () {
  eq(JSON.stringify(dm.buildOrderMessages(FULL)), JSON.stringify(legacyMessages(FULL)));
});

check('默认模板渲染与旧实现逐字一致（只有 product_name）', function () {
  const o = { product_name: 'Ev课程表' };
  eq(JSON.stringify(dm.buildOrderMessages(o)), JSON.stringify(legacyMessages(o)));
});

check('默认模板渲染与旧实现逐字一致（全空对象）', function () {
  eq(JSON.stringify(dm.buildOrderMessages({})), JSON.stringify(legacyMessages({})));
});

check('默认模板是 3 条且条号 1/2/3', function () {
  const m = dm.buildOrderMessages(FULL);
  eq(m.length, 3, '条数');
  eq(m.map(function (x) { return x.i; }).join(','), '1,2,3', '条号');
});

// ── ② 缺值兜底 ─────────────────────────────────────────────────────────
check('code 缺失回落「（发货异常请回复本消息）」', function () {
  const m = dm.buildOrderMessages({ product_name: 'Ev课程表' });
  ok(m[0].content.indexOf('（发货异常请回复本消息）') >= 0, '缺 code 未见兜底话术');
});

check('activate_url 缺失渲染为空（不留占位符）', function () {
  const m = dm.buildOrderMessages({ code: 'C1' });
  ok(m[0].content.indexOf('{{activate_url}}') < 0, '占位符未被替换');
});

check('product_name 缺失回落 Ev课程表', function () {
  const m = dm.buildOrderMessages({ code: 'C1' });
  ok(m[0].content.indexOf('感谢您赞助 Ev课程表 永久高级版') >= 0, '产品名回落失败');
});

// ── ③ 未知占位符 ───────────────────────────────────────────────────────
check('未知占位符原样保留', function () {
  const m = dm.buildOrderMessages(FULL, [
    { i: 1, content: 'hi {{nope}} and {{code}}' },
    { i: 2, content: 'x' },
    { i: 3, content: 'y' },
  ]);
  eq(m[0].content, 'hi {{nope}} and ABCD1234');
});

check('findUnknownVars 去重且只报未知', function () {
  const u = dm.findUnknownVars('{{code}} {{a}} {{a}} {{b}} {{product_name}}');
  eq(u.join(','), 'a,b');
});

check('占位符内允许空格 {{ code }}', function () {
  const m = dm.buildOrderMessages(FULL, [
    { i: 1, content: 'code={{  code  }}' },
    { i: 2, content: 'x' },
    { i: 3, content: 'y' },
  ]);
  eq(m[0].content, 'code=ABCD1234');
});

// ── ④ 保存校验 ─────────────────────────────────────────────────────────
check('normalizeTemplates 拒绝非 3 条', function () {
  ok(dm.normalizeTemplates([{ content: 'a' }]).ok === false, '1 条应被拒绝');
  ok(dm.normalizeTemplates([{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }]).ok === false, '4 条应被拒绝');
  ok(dm.normalizeTemplates(null).ok === false, 'null 应被拒绝');
});

check('normalizeTemplates 拒绝空/纯空白', function () {
  ok(dm.normalizeTemplates([{ content: 'a' }, { content: '   ' }, { content: 'c' }]).ok === false, '空白应被拒绝');
  ok(dm.normalizeTemplates([{ content: 'a' }, { content: '' }, { content: 'c' }]).ok === false, '空串应被拒绝');
});

check('normalizeTemplates 拒绝超长', function () {
  const long = new Array(dm.MAX_TEMPLATE_CHARS + 2).join('x');
  ok(dm.normalizeTemplates([{ content: long }, { content: 'b' }, { content: 'c' }]).ok === false, '超长应被拒绝');
});

check('normalizeTemplates 通过时强制条号 1/2/3', function () {
  const r = dm.normalizeTemplates([{ i: 9, content: 'a' }, { i: 9, content: 'b' }, { i: 9, content: 'c' }]);
  ok(r.ok, '应通过');
  eq(r.templates.map(function (x) { return x.i; }).join(','), '1,2,3');
});

check('自定义模板渲染生效', function () {
  const m = dm.buildOrderMessages(FULL, [
    { i: 1, content: '自定义1 {{code}}' },
    { i: 2, content: '自定义2' },
    { i: 3, content: '自定义3 {{guide_url}}' },
  ]);
  eq(m[0].content, '自定义1 ABCD1234');
  eq(m[2].content, '自定义3 https://app-auth.gudq.com/guide');
});

// ── ⑤ buildOrderJob 改为 async ─────────────────────────────────────────
(async function () {
  try {
    const p = dm.buildOrderJob({ out_trade_no: 'T1', user_id: 'u1', code: 'C1' });
    ok(p && typeof p.then === 'function', 'buildOrderJob 应返回 Promise');
    const job = await p;
    eq(job.out_trade_no, 'T1');
    eq((job.messages || []).length, 3, 'messages 条数');
    eq(job.messages[0].i, 1, '首条条号');
    ok(typeof job.template_is_default === 'boolean', 'template_is_default 应存在');
    pass++;
    console.log('PASS  buildOrderJob 为 async 且返回 3 条 messages');
  } catch (e) {
    fails.push('buildOrderJob async');
    console.log('FAIL  buildOrderJob 为 async 且返回 3 条 messages  → ' + (e && e.message));
  }

  console.log('\nPASS: ' + pass + '  FAILED: ' + fails.length);
  process.exit(fails.length ? 1 : 0);
})();
