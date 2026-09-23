-- Supabase PostgreSQL - IP lookup results persistent storage
-- Run this in Supabase SQL Editor or via migration script
--
-- 说明：`lib/geo-district.js` 会借用同一张表做「区县级归属地」缓存：
--   district             腾讯位置服务返回的区县（如「朝阳区」），空表示该 IP 无区县
--   district_checked_at  最近一次成功查询时间；30 天内命中即不再调接口（省免费额度）
--   只有「接口成功」才写这两列；失败（超时 / 121 配额用尽 / 110 未授权）不写，保证下次会重试

create table if not exists ip_lookups (
  ip            varchar(45) primary key,
  country       varchar(64) not null default '',
  region        varchar(64) not null default '',
  city          varchar(64) not null default '',
  isp           varchar(128) not null default '',
  org           varchar(128) not null default '',
  asn           varchar(32) not null default '',
  lat           float8 not null default 0,
  lon           float8 not null default 0,
  timezone      varchar(64) not null default '',
  sources       varchar(255) not null default '',
  raw_data      jsonb,
  updated_at    timestamptz not null default now()
);

-- 迁移：给已存在的表补「区县」相关列（幂等，可重复执行）
alter table ip_lookups add column if not exists district varchar(64) not null default '';
alter table ip_lookups add column if not exists district_checked_at timestamptz;

create index if not exists idx_ip_lookups_updated on ip_lookups(updated_at desc);
create index if not exists idx_ip_lookups_district_checked on ip_lookups(district_checked_at desc);
