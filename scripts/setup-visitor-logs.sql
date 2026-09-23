-- Supabase PostgreSQL - 访客访问永久日志
--
-- 为什么需要这张表：
--   原先访客明细存在 KV 结构里（`kv_lists` 的 `stats:recent`）——只保留约 100 条；
--   日报（`stats:pv/uv/pages`）7 天就过期。要长期保存 + 长期统计，必须落业务表。
--
-- 写入方：`api/activate.js`（section=visitor-track，页面埋点）、`api/go.js`（/go/:slug 购买点击）
--   均在响应之后用 `waitUntil` 写入，不占用用户等待时间；失败只打日志，不影响主流程。
-- 读取方：`api/admin/health.js` 的 `section=stats&sub=visitor-recent`（后台「访客记录」）
--   中文地区在读取时由 `lib/geo-district.getStoredGeo()` 富化（腾讯/ip_lookups），写入时不做外呼。
--
-- 注：应用侧 `lib/visitor-log.js` 的 `ensureTable()` 会自动建表（幂等），
--     本脚本用于人工执行 / 迁移参考。

create table if not exists visitor_logs (
  id            bigserial primary key,
  ts            timestamptz not null default now(),
  ip            varchar(45)  not null default '',
  path          text         not null default '',
  ua            varchar(256) not null default '',
  ref           varchar(256) not null default '',
  country       varchar(32)  not null default '',
  region        varchar(64)  not null default '',
  city          varchar(64)  not null default '',
  visitor_hash  varchar(32)  not null default '',
  source        varchar(32)  not null default 'visit'
);

create index if not exists idx_visitor_logs_ts on visitor_logs(ts desc);
create index if not exists idx_visitor_logs_ip on visitor_logs(ip);
create index if not exists idx_visitor_logs_hash on visitor_logs(visitor_hash);

-- 按北京时间（UTC+8）聚合每天的 PV / UV（趋势图用永久数据的正确口径）
-- select to_char((ts + interval '8 hours')::date, 'YYYY-MM-DD') as day,
--        count(*) as pv, count(distinct visitor_hash) as uv
-- from visitor_logs
-- where ts >= now() - interval '30 days'
-- group by 1 order by 1;
