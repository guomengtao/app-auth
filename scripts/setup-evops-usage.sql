-- Supabase PostgreSQL - EvOps 用量表 evops_usage（每会话一行：积分 + Token）
-- 方案出处：ev-ops-android/docs/积分消耗统计-方案.md §三（2026-10-09，evtask-D-evev-ops-and-261009-3xecvb）
-- 在 Supabase SQL Editor（或 scripts/setup-*.js）中运行一次。幂等，可重复执行。
--
-- 背景：钩子 ev-report.js 已把「Token 用量」写进 evops_messages（append-only 事件流），
--       但**逐轮积分**（本机 ~/.workbuddy/workbuddy.db 的 session_usage.credit_json）此前
--       完全没上云 → EvOps「积分」页取不到数。本表把「每会话的积分合计 + Token 累计」落一行，
--       供底部「积分」Tab 直接读（读多写多，覆盖式 upsert，非事件流）。
-- 分工：evops_messages = 逐条事件（历史/按天模型用量）；evops_usage = 每会话当前合计（排行榜/用）。
-- 主键 sid：稳定会话名（stableSid，workbuddy-YYYYMMDD-HHMM-hash4）；
--           raw_sid 另存工具原生会话 UUID（= workbuddy.db session_usage.session_id，可回查）。

create table if not exists evops_usage (
  sid          varchar(120) primary key,        -- 稳定会话名（stableSid）
  raw_sid      varchar(120),                    -- 工具原生会话 id（workbuddy.db 的 session_id）
  tool         varchar(32),                     -- workbuddy / codebuddy / …
  model        varchar(64),                     -- 最近一次上报时所用模型
  title        varchar(240),                    -- 会话标题（列表可读性，随钩子上报刷新）
  credit_total numeric(14,2) not null default 0,-- 积分合计（credit_json 逐轮求和）
  tok_in       bigint not null default 0,       -- 输入 token 累计
  tok_out      bigint not null default 0,        -- 输出 token 累计
  tok_total    bigint not null default 0,        -- 总 token 累计
  messages     int    not null default 0,        -- 该会话已计入的用户指令条数
  started_at   timestamptz,                      -- 会话开始时刻（钩子黑板带过来）
  first_seen   timestamptz not null default now(),-- 首次入库时刻
  updated_at   timestamptz not null default now() -- 最近一次上报时刻
);

create index if not exists idx_eu_credit  on evops_usage(credit_total desc);
create index if not exists idx_eu_updated on evops_usage(updated_at desc);
create index if not exists idx_eu_tool    on evops_usage(tool);

-- RLS：service_role（后端写）全权；anon 只读（与 evops_tasks / evops_sessions / evops_messages 同口径）
alter table evops_usage enable row level security;
drop policy if exists "evops_usage_anon_read" on evops_usage;
drop policy if exists "evops_usage_svc_all"   on evops_usage;
create policy "evops_usage_anon_read" on evops_usage for select using (true);
create policy "evops_usage_svc_all"  on evops_usage for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
