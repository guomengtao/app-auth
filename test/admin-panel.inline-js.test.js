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

const FILE = path.resolve(__dirname, '..', 'admin_Dx23.html');
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

console.log('\n共检查 ' + checked + ' 个内联脚本，' + totalChars + ' 字符');
console.log('PASS: ' + pass + '  FAILED: ' + fails.length);
process.exit(fails.length ? 1 : 0);
