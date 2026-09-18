// scripts/seed-go-link.js — 一键写入 ev-timetable 短链配置到生产 Redis
//
// 用法（在项目根目录）：
//   node scripts/seed-go-link.js              # 仅当配置不存在时写入（推荐）
//   node scripts/seed-go-link.js --force       # 强制覆写（保留 enabled=true）
//   node scripts/seed-go-link.js --disable      # 写入但立即停用（写入 enabled=false）
//
// 依赖：与 api/ 同源的 lib/redis.js，自动读取 .env / 环境变量。

try {
  require('dotenv').config();
  require('dotenv').config({ path: '.env.local', override: false });
} catch (e) {
  console.warn('dotenv not available, using system env vars only');
}

var redis = require('../lib/redis');

var SLUG = 'ev-timetable';
var TARGET_URL = 'https://ifdian.net/item/54100fe4a1e011f1a3f452540025c377';

function buildEntry(enabled) {
  var now = Date.now();
  return {
    target_url: TARGET_URL,
    enabled: !!enabled,
    name_zh: '下载 EV 课程表',
    name_en: 'Download EV Timetable',
    note: 'EV 课程表应用页购买链接（首期唯一链接）',
    created_at: now,
    updated_at: now,
  };
}

async function main() {
  var args = process.argv.slice(2);
  var force = args.indexOf('--force') !== -1;
  var disable = args.indexOf('--disable') !== -1;

  var existing = null;
  try {
    existing = await redis.hget('go:mapping', SLUG);
  } catch (e) {
    console.error('读取 Redis 失败：', e.message);
    process.exit(1);
  }

  if (existing && !force) {
    console.log('已存在 slug=' + SLUG + ' 的配置，未做任何改动。如需覆写请加 --force。');
    console.log('当前内容：');
    console.log('  ' + existing);
    return;
  }

  var entry = buildEntry(!disable);
  try {
    await redis.hset('go:mapping', { [SLUG]: JSON.stringify(entry) });
  } catch (e) {
    console.error('写入 Redis 失败：', e.message);
    process.exit(1);
  }

  console.log('✅ 已写入 slug=' + SLUG + (disable ? '（已停用）' : '（启用）'));
  console.log('   target_url = ' + entry.target_url);
  console.log('   对外链接   = https://app-auth.gudq.com/go/' + SLUG);
  console.log('   后台查看   = /admin_Dx23.html?tab=purchase-logs');
}

main()
  .then(function () { process.exit(0); })
  .catch(function (e) {
    console.error('脚本异常：', e);
    process.exit(1);
  });