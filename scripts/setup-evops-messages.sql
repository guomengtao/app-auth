-- Supabase PostgreSQL - EvOps 钩子事件流表 evops_messages（会话/模型全字段落库）
-- 方案出处：docs/会话与模型数据入库Supabase-方案.md §③（2026-10-09，用户批「开始」）
-- 在 Supabase SQL Editor（或 scripts/setup-evops-messages.js）中运行一次。幂等，可重复执行。
--
-- 背景：钩子载荷（UserPromptSubmit 等）里带 model/client/version/generation_id/agent_type/
--       permission_mode/hook_event_name/transcript_path 共 8 个字段，但此前**一个都没落库**
--       （ev-report.js 只用了 session_id/prompt/cwd）→ 无法回答「这一轮用了哪个模型 / 每天用了多少」。
-- 分工：evops_sessions = 会话当前态（upsert 覆盖，看「谁在线」）；
--       evops_messages = 逐条事件流（append-only 永不覆盖，看「历史 / 模型用量」）。两者互补、非冗余。

create table if not exists evops_messages (
  id               bigserial primary key,
  ts               timestamptz not null default now(),  -- 落库时刻（按天聚合用）
  hook_event       varchar(32),                          -- UserPromptSubmit / SessionStart / SessionEnd
  sid              varchar(120),                         -- 稳定会话名（stableSid）
  raw_sid          varchar(120),                         -- 工具原生会话 id（载荷 session_id）
  tool             varchar(32),                          -- workbuddy / codebuddy / …
  task_id          varchar(120),                         -- 当时进行中的 evtask- 单号（无则空）
  model            varchar(64),                          -- ⭐ 模型（载荷 model）
  client           varchar(32),                          -- 客户端（WorkBuddy / CodeBuddy）
  version          varchar(32),                          -- 客户端版本
  generation_id    varchar(64),                          -- 单次生成 id
  agent_type       varchar(24),
  permission_mode  varchar(24),
  prompt           text,                                 -- 指令文本（截 500）
  is_short         boolean not null default false,       -- 短消息=心跳信号
  transcript_path  varchar(400),                         -- 转录文件路径（不存正文）
  cwd              varchar(240),
  repo             varchar(240),
  payload          jsonb not null default '{}'           -- 原始载荷全量（字段扩展兜底，无需改表）
);

create index if not exists idx_em_ts      on evops_messages(ts desc);
create index if not exists idx_em_sid     on evops_messages(sid);
create index if not exists idx_em_task    on evops_messages(task_id);
create index if not exists idx_em_model   on evops_messages(model);
create index if not exists idx_em_tool_ts on evops_messages(tool, ts desc);

-- RLS：service_role（后端写）全权；anon 只读（与 evops_tasks / evops_sessions 同口径）
alter table evops_messages enable row level security;
drop policy if exists "evops_messages_anon_read" on evops_messages;
drop policy if exists "evops_messages_svc_all"   on evops_messages;
create policy "evops_messages_anon_read" on evops_messages for select using (true);
create policy "evops_messages_svc_all"  on evops_messages for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- 会话台账：当前用什么模型（只增列，兼容老数据；老行 model=null）
alter table evops_sessions add column if not exists model   varchar(64);
alter table evops_sessions add column if not exists models  jsonb not null default '[]';
alter table evops_sessions add column if not exists client  varchar(32);
alter table evops_sessions add column if not exists version varchar(32);

-- 任务台账：该任务主力模型（只增列）
alter table evops_tasks add column if not exists model varchar(64);

-- 视图：按天 × 模型 × 工具 汇总（聚合现算，不落冗余表 —— 避免「登记加1、关闭不减」式漂移源）
-- 用 drop+create 而非 create or replace：视图列定义变化时后者会报 "cannot drop columns from view"
drop view if exists v_evops_model_daily;
create view v_evops_model_daily as
select date_trunc('day', ts)::date as day,
       tool, model, client,
       count(*)                as messages,   -- 该天该模型的消息条数
       count(distinct sid)     as sessions,   -- 涉及会话数
       count(distinct task_id) as tasks       -- 涉及任务数
from evops_messages
where hook_event = 'UserPromptSubmit'
group by 1,2,3,4
order by 1 desc, 5 desc;

-- Realtime 实时推送：把 evops_messages 加入 supabase_realtime publication。
-- ★ 安卓长连接（SupabaseRealtime 订阅 postgres_changes）只对 publication 内的表广播；
--   没加入即使 WS 连上、phx_join 成功，也收不到任何 INSERT 事件。
-- 幂等：已在则跳过，可重复执行。
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'evops_messages'
  ) then
    alter publication supabase_realtime add table evops_messages;
  end if;
end $$;
