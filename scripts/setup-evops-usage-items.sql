-- Supabase PostgreSQL - EvOps 积分明细表 evops_usage_items（每轮积分一行，append-only）
-- 方案出处：ev-ops-android/docs/积分消耗统计-方案.md §九（2026-10-09，evtask-D-evev-ops-and-261009-3xecvb 迭代）
-- 在 Supabase SQL Editor（或 scripts/setup-evops-usage-items.js）中运行一次。幂等，可重复执行。
--
-- 背景：evops_usage = 每会话「合计」（覆盖式 upsert，只能看排行榜）；
--       本表 = **逐条消耗明细**（append-only 事件流），支持「最新在前」的流水列表与长连接实时推送。
--
-- 数据来源：本机 ~/.workbuddy/workbuddy.db 的 session_usage.credit_json = { "mid": 积分 }。
--   ⭐ 关键（2026-10-09 实测）：credit_json 的 key == transcript 行 providerData.conversationRequestId，
--      据此 join 到 transcript 行顶层的 timestamp（毫秒）⇒ **每条积分都能拿到真实发生时刻**。
--      若某条 join 不到（会话未上报 transcript 等），退化为上报时刻见 occurred_at。
--
-- 去重：mid unique + 写侧 upsert(on_conflict=mid) ⇒ 重复上报同一轮不会插两行。

create table if not exists evops_usage_items (
  id          uuid primary key default gen_random_uuid(),
  sid         varchar(120),                       -- 稳定会话名（stableSid）
  raw_sid     varchar(120),                       -- 工具原生会话 id（workbuddy.db 的 session_id）
  tool        varchar(32),                        -- workbuddy / codebuddy / …
  model       varchar(64),                        -- 发生该轮消耗时所用模型（best-effort）
  title       varchar(240),                       -- 会话标题（列表可读性；行级显示用）
  mid         varchar(64) not null unique,        -- 该轮唯一标识（credit_json 的 key = conversationRequestId）
  seq         int,                                -- 该轮在会话内的序号（1 起，便于观察增长）
  credit      numeric(10,2) not null default 0,   -- 本轮消耗积分
  occurred_at timestamptz not null default now(), -- ⭐ 该轮真实发生时刻（由 transcript timestamp 换算）
  synced_at   timestamptz not null default now()  -- 上云时刻
);

-- 列表主查询：全部会话混合、按真实发生时间倒序（最新在前）
create index if not exists idx_eui_occurred on evops_usage_items(occurred_at desc);
create index if not exists idx_eui_sid      on evops_usage_items(sid);
create index if not exists idx_eui_credit   on evops_usage_items(credit desc);

-- RLS：service_role（后端写）全权；anon 只读（与 evops_usage / evops_tasks / evops_messages 同口径）
alter table evops_usage_items enable row level security;
drop policy if exists "evops_usage_items_anon_read" on evops_usage_items;
drop policy if exists "evops_usage_items_svc_all"   on evops_usage_items;
create policy "evops_usage_items_anon_read" on evops_usage_items for select using (true);
create policy "evops_usage_items_svc_all"  on evops_usage_items for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ── 迭代2 新增列（2026-10-10，evtask-D-evev-ops-and-261009-3xecvb）：行卡要显示对话内容/单号/上下文 ──
-- 幂等 add column：可重复执行，已存在则跳过。
alter table evops_usage_items add column if not exists prompt_text text;       -- 该轮用户发的指令内容（截断 120 字）
alter table evops_usage_items add column if not exists task_id     varchar(64);-- ev 任务单号（evtask-…），无则空
alter table evops_usage_items add column if not exists task_title  varchar(240);-- 任务名
alter table evops_usage_items add column if not exists ctx_used    int;        -- 该轮时上下文占用 token（session_usage.used）
alter table evops_usage_items add column if not exists ctx_size    int;        -- 上下文窗口（session_usage.size）
alter table evops_usage_items add column if not exists calls       int;        -- 已计费轮次（credit_json 条目数）＝「已调用 N 次」

-- 筛选/分页辅助索引
create index if not exists idx_eui_model on evops_usage_items(model);
create index if not exists idx_eui_tool  on evops_usage_items(tool);

-- ⭐ 实时推送开关（缺了这一步，安卓 SupabaseRealtime 连上了也收不到任何 INSERT 事件）
-- Supabase Realtime 只对 publication 内的表广播；drop+add 保证幂等可重复执行。
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'evops_usage_items'
  ) then
    alter publication supabase_realtime add table evops_usage_items;
  end if;
end $$;
