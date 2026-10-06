-- Supabase PostgreSQL - EvOps 配置表 evops_config（槽位上限云端化）
-- 方案出处：ev-ops-android/docs/槽位上限云端化-摆脱Mac常驻-方案.md §4.1
-- 在 Supabase SQL Editor（或 scripts/setup-evops-config.js）中运行一次。幂等，可重复执行。
--
-- 背景：并行上限 max_parallel 原先存在 evops_status.payload.summary（由 Mac collect-status.js
--       定期上报刷入）—— 这是唯一残留的「Mac 依赖」。本表把它搬进云端自己家：
--       手机 App 直接读写本表，云端闸门 task-register 也读本表，Mac 完全退出该链路。
-- 真值唯一：本表的 max_parallel 是唯一权威；evops_status.summary.max_parallel 降级为「本表的投影」。

create table if not exists evops_config (
  id           int primary key,                       -- 单行配置表，固定 id=1
  max_parallel int not null default 9
               check (max_parallel between 1 and 99), -- 与后端校验区间一致
  updated_at   timestamptz not null default now(),
  updated_by   text                                   -- 谁改的（手机 device / migration / 后台）
);

-- 初始行：值取自迁移时 Mac 侧 data/config.json 的真实值（2026-10-06 为 9）。
-- on conflict do nothing → 重复执行不会覆盖现网已改过的值。
insert into evops_config (id, max_parallel, updated_at, updated_by)
values (1, 9, now(), 'migration')
on conflict (id) do nothing;

-- RLS：service_role（后端写）全权；anon 只读（App 经后端 /api/ev 读写，不直连本表，
--     故 anon 写一律禁止；读放开便于调试）。
alter table evops_config enable row level security;
drop policy if exists "evops_config_anon_read" on evops_config;
drop policy if exists "evops_config_svc_all"  on evops_config;
create policy "evops_config_anon_read" on evops_config for select using (true);
create policy "evops_config_svc_all"  on evops_config for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
