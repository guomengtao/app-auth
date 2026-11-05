/**
 * admin_Dx23.html 内联脚本语法检查
 *
 * 背景：后台面板是 9700+ 行的单文件，所有逻辑都在一个巨大的内联 <script> 里。
 * 改 UI/JS 后如果语法出错，页面上什么都不会显示（用户看到的就是「面板打不开、点了没反应」），
 * 而不像有构建的项目那样能在编译期发现。
 *
 * 断言：每个内联 <script> 都能通过 new Function() 编译（等价于语法检查）。
 *
 * 运行: node test/admin-panel.inline-js.test.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'admin', 'admin_Dx23.html');
const src = fs.readFileSync(FILE, 'utf8');

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
let m, idx = 0, checked = 0, totalChars = 0;
while ((m = re.exec(src)) !== null) {
  idx++;
  if (/\bsrc\s*=/.test(m[1])) continue;          // 外链脚本跳过
  const code = m[2];
  if (code.trim().length < 20) continue;
  const line = src.slice(0, m.index).split('\n').length;
  checked++;
  totalChars += code.length;
  let err = null;
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    err = e.message;
  }
  check(`内联 script#${idx} (line ${line}, ${code.length} chars) 语法正确`, !err, err);
}

check('至少存在一个内联脚本', checked > 0, checked);
check('脚本总体量合理（防误抓到压缩/截断内容）', totalChars > 10000, totalChars);

// 初始化链路必须带保护：历史上四个 load* 里任一抛异常都会吞掉后面的 switchTab
check('初始化用 safeInit 包裹（单个失败不阻断 switchTab）', /safeInit\(/.test(src));
check('初始化的 switchTab 在 safeInit 内', /safeInit\('tab'/.test(src));

// ── 「已授权设备」面板：四件套必须齐全，少一个就是"点了没反应" ──────────
check('设备面板：菜单项存在', /data-tab="devices"/.test(src));
check('设备面板：panel 容器存在', /id="panel-devices"/.test(src));
check('设备面板：TAB_META 已注册', /devices: \{ title:/.test(src));
check('设备面板：switchTab 会触发加载', /if \(tab === 'devices'\) loadDevices\(\);/.test(src));
check('设备面板：loadDevices 已定义', /function loadDevices\(/.test(src));
check('设备面板：撤销函数已定义',
  /function revokeDevice\(/.test(src) && /function revokeAllDevices\(/.test(src));
check('设备面板：调用了正确的接口',
  /\/api\/ev\?action=devices/.test(src) && /\/api\/ev\?action=device-revoke/.test(src));
check('设备面板：表格有 tbody 挂载点', /id="devicesTable"/.test(src));
check('设备面板：使用 escapeHtml 防注入', /escapeHtml\(d\.label/.test(src));
// 2026-11-05：`--card` 已在 :root 补成 `var(--card-bg)` 的兼容别名（见 :root 注释「曾有 7 处引用
// 未定义的 --card，导致卡片背景透明」），原「出现 --card 即失败」的判断前提已不存在。
// 改为守住这条兼容别名本身 —— 它被删掉才会真出问题。
check('设备面板：--card 仍是已定义的兼容别名（勿删 :root 定义）',
  /--card:\s*var\(--card-bg\)/.test(src), '未找到 --card 的 :root 定义，引用它的卡片会变透明');

// ── 「爱发电订单 · 私信模板」子 Tab 四件套（2026-11-05，evtask-D-evapp-auth-261105-ta38xn）──
check('私信模板：子 Tab 按钮存在', /id="afdianSubTabTemplates"/.test(src));
check('私信模板：面板容器存在', /id="afdian-sub-templates"/.test(src));
check('私信模板：switchAfdianSubTab 覆盖 templates 分支',
  /templates: document\.getElementById\('afdian-sub-templates'\)/.test(src));
check('私信模板：三条独立文本域由 JS 生成', /afdianTplTa/.test(src) && /AFDIAN_TPL_META/.test(src));
check('私信模板：走正确的接口（GET + preview/save/reset 同源）',
  /\/api\/afdian\?kind=dm-templates/.test(src)
  && /kind=dm-templates&op=preview/.test(src)
  && /kind=dm-templates&op=save/.test(src)
  && /kind=dm-templates&op=reset/.test(src));
check('私信模板：保存/恢复/加载函数已定义',
  /function saveAfdianTemplates\(/.test(src)
  && /function resetAfdianTemplates\(/.test(src)
  && /function loadAfdianTemplates\(/.test(src));
check('私信模板：切 Tab 会触发加载', /else if \(sub === 'templates'\) loadAfdianTemplates\(\);/.test(src));
check('私信模板：预览用 textContent 写入（防 XSS）', /pv\.textContent = rendered/.test(src));

// ── 兑换码筛选：产品 ID 归一化（2026-11-05，evtask-D-evapp-auth-261105-fecxed）──
// 背景：auth:products 与兑换码里同一产品并存 "01"/"1"/"0001"，严格相等会让
// 两个同名「Ev课程表」各筛一半，另有 name 为 "0"/undefined 的空壳产品点了必空。
check('兑换码筛选：定义了 normPid 归一化函数',
  /function normPid\(v\)/.test(src), '缺少 normPid');
check('兑换码筛选：纯数字补零到 2 位',
  /return n < 10 \? '0' \+ n : String\(n\)/.test(src), 'normPid 未做补零');
check('兑换码筛选：产品匹配走归一化而非严格相等',
  /normPid\(data\.product_id\) !== normPid\(filterProductId\)/.test(src),
  'matchCodeFilter 仍在用 data.product_id !== filterProductId');
check('兑换码筛选：定义了 normalizeProductList 清洗产品列表',
  /function normalizeProductList\(products\)/.test(src), '缺少 normalizeProductList');
check('兑换码筛选：过滤脏产品（名称缺失或名称等于 ID）',
  /!rawName \|\| rawName === rawId/.test(src), '未过滤脏产品');
check('兑换码筛选：chips 渲染前先清洗列表',
  /products = normalizeProductList\(products\);/.test(src), 'fillProductFilters 未清洗产品');
check("兑换码筛选：不再保留 0000 硬编码特例",
  !/filterProductId !== '0000'/.test(src), "仍存在 0000 硬编码特例");

console.log('\n共检查 ' + checked + ' 个内联脚本，' + totalChars + ' 字符');
console.log('PASS: ' + pass + '  FAILED: ' + fails.length);
process.exit(fails.length ? 1 : 0);
