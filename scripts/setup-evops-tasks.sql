-- Supabase PostgreSQL - EvOps 任务登记表 evops_tasks
-- 在 Supabase SQL Editor（或迁移脚本）中运行一次。
-- 方案出处：ev-ops-android/docs/EvOps-任务登记与管理方案.md §4.5/§4.6（方案甲，Supabase 直写）
--
-- 数据流：登记页/API 写入本表 source=register 的任务 → Mac 采集器 collect-status.js 读合并
--        进 tasks.json（多源合一）→ 写 evops_status(id=1) 聚合 → 手机看板秒级回流。
-- 登记状态均为人工明确表达，以本表为权威，采集器不得覆盖（见方案 §4.6）。

create table if not exists evops_tasks (
  id            text primary key,          -- 稳定任务 id，登记页生成 reg-<时间戳>
  project       varchar(120) default '',   -- 归属项目（可选，缺省空=全局/待定）
  title         varchar(240) not null,      -- 任务标题（必填）
  type          varchar(24) not null default 'feature', -- feature/develop/bug/git/docs/infra/refactor/research
  description   text,                       -- 需求描述（人/AI 填）
  assignee      varchar(64),                -- 负责 AI/人（可选，缺省回退自动归因）
  eta_min       int,                        -- 预计耗时（分钟，正数）
  status        varchar(24) not null default 'in_progress', -- in_progress/planned/done/cancelled/blocked
  close_reason  varchar(40),                -- done=fixed / cancelled=wontfix|no_time|dup|superseded_by / blocked=not_reproduced|blocked_by|no_time
  closed_note   text,                       -- 结束说明（命中"解决"的文字证明，见方案 §五松绑）
  owner         varchar(120),               -- 登记人/AI 标识
  source        varchar(16) not null default 'register',
  priority      varchar(4)  not null default 'P2',
  replies       jsonb       not null default '[]',  -- 管理员/AI 答复对话 array [{by,role,at,text}]
  extra         jsonb       not null default '{}',  -- size/evidence/note 等扩展，供采集器回填
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_et_status   on evops_tasks(status);
create index if not exists idx_et_type     on evops_tasks(type);
create index if not exists idx_et_assignee on evops_tasks(assignee);
create index if not exists idx_et_updated  on evops_tasks(updated_at desc);
create index if not exists idx_et_project  on evops_tasks(project);

-- RLS：service_role（后端写）全权；anon 只读（App 经 Realtime 订阅 / status 拉到聚合，无需直读本表。
--  登记页写入一律走后端 EV_SYNC_TOKEN，故 anon 禁止写。
alter table evops_tasks enable row level security;
drop policy if exists "evops_tasks_anon_read"  on evops_tasks;
drop policy if exists "evops_tasks_svc_all"   on evops_tasks;
create policy "evops_tasks_anon_read" on evops_tasks for select using (true);
create policy "evops_tasks_svc_all"  on evops_tasks for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Realtime：把本表加进 supabase_realtime 发布，手机端「任务」页才能经 WebSocket 收到增/改推送并自动刷新。
-- （幂等：表已在发布中会告警但可重复执行；若首次执行报 WARNING 可忽略。）
alter publication supabase_realtime add table evops_tasks;