-- Supabase PostgreSQL - EvOps 会话身份表 evops_sessions（把「会话」升为一等实体）
-- 方案出处：docs/会话身份字段入库Supabase-方案.md §③.1（2026-10-07，用户已批「开始」）
-- 在 Supabase SQL Editor（或 scripts/setup-evops-sessions.js）中运行一次。幂等，可重复执行。
--
-- 背景：会话身份（sid/raw_sid/tool/cwd/repo/started_at/heartbeat_at/tasks[]）此前只落在
--       Mac 黑板 ev-ops-android/data/active/<sid>.json，任务记录里没有会话维度，导致：
--         ① 同一会话能开多条单，占满并行上限（用户 2026-10-07 定「每会话唯一单号」）；
--         ② 无名额时无法判断老会话死活，只能按 age 盲收（误关「在做的慢活」）。
-- 本表把会话升为一等实体；evops_tasks 只加一列 session_sid 关联（只增不改，兼容老数据）。
--
-- 字段语义：见黑板 ev-report.js L130 {sid, raw_sid, tool, cwd, repo, started_at, heartbeat_at, tasks[]}
--           与 stableSid()（L83-103，_sidmap.json 保证同一 rawSid 恒定映射到同一 sid）。

create table if not exists evops_sessions (
  sid            varchar(120) primary key,   -- 稳定可读会话名（stableSid 派生）
  raw_sid        varchar(120),               -- 工具原生会话 id（钩子 payload 的 session_id，最权威）
  tool           varchar(32)  not null default '',  -- codebuddy / claude / …
  cwd            varchar(240),               -- 该会话在哪个工作区干活
  repo           varchar(240),               -- git 根（与 cwd 常相同）
  title          varchar(240),               -- 会话标题：取黑板 tasks[0].id（首条指令前 N 字），可被自报覆盖
  started_at     timestamptz,                -- 黑板首次写入
  heartbeat_at   timestamptz,                -- 会话是否还活着（QA 审查员判据，见总纲 §3.16）
  open_task_id   varchar(80),                -- 当前开着的单号（规则1「每会话唯一单号」用；无则 null）
  status         varchar(16) not null default 'live', -- live/stale/closed（按心跳推导或人工标注）
  tasks          jsonb not null default '[]', -- 黑板 tasks[] 快照（[{id,status,at}]）
  extra          jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_es_heartbeat on evops_sessions(heartbeat_at desc);
create index if not exists idx_es_status    on evops_sessions(status);
create index if not exists idx_es_opentask  on evops_sessions(open_task_id);

-- evops_tasks 只加一列（幂等；老行 session_sid=null，规则只对带会话的行生效）
alter table evops_tasks add column if not exists session_sid varchar(120);
create index if not exists idx_et_session on evops_tasks(session_sid);

-- RLS：service_role（后端写）全权；anon 只读（与 evops_tasks 同口径：App 经后端读写，anon 禁写）
alter table evops_sessions enable row level security;
drop policy if exists "evops_sessions_anon_read" on evops_sessions;
drop policy if exists "evops_sessions_svc_all"   on evops_sessions;
create policy "evops_sessions_anon_read" on evops_sessions for select using (true);
create policy "evops_sessions_svc_all"  on evops_sessions for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
