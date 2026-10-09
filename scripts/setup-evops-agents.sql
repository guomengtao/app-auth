-- Supabase PostgreSQL - EvOps 大屏 V5：AI 开发者实体 + token 用量
-- 方案出处：docs/数据大屏V5-AI开发者视角-升级方案.md §六（2026-10-09，用户批「开工」+「用量一起上屏」）
-- 运行：node scripts/setup-evops-agents.js（或 Supabase SQL Editor）。幂等，可重复执行。
--
-- 背景：大屏把「每个会话 = 一个 AI 开发者」当核心实体。三件套：
--   ① 身份 ID（sid，唯一）；② 昵称/花名（可改·允许重名，绝不作唯一键）；③ 工作模式（快速通道 / 任务单）。
--   sid 已有（evops_sessions.sid）；本脚本补 ① 昵称注册表、② token 用量列、③ 聚合视图。

-- ── 1) AI 开发者昵称注册表（昵称属于「人」，独立于会被 upsert 覆盖的 evops_sessions）──
-- 唯一键 = sid；nickname 可任意改、**允许重名**（故不加 unique 约束）—— 显示用，绝不作聚合键。
create table if not exists evops_agents (
  sid        varchar(120) primary key,                 -- 身份 ID（= evops_sessions.sid）
  nickname   text,                                     -- 昵称/花名（例：一朵温柔的云）
  avatar     text,                                     -- 头像 emoji / 标识
  note       text,                                     -- 备注
  updated_at timestamptz not null default now()
);

alter table evops_agents enable row level security;
drop policy if exists "evops_agents_anon_read" on evops_agents;
drop policy if exists "evops_agents_svc_all"   on evops_agents;
create policy "evops_agents_anon_read" on evops_agents for select using (true);
create policy "evops_agents_svc_all"  on evops_agents for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ── 2) token 用量列（每轮增量：本条事件距上次之间新增消耗的 token）──
-- 采集：ev-report.js 增量读 transcript（按字节水位），只取 /message/usage 的 snake 形式，避免与
--       /providerData/usage 的 camel 形式重复计数。
alter table evops_messages add column if not exists tok_in    integer not null default 0;
alter table evops_messages add column if not exists tok_out   integer not null default 0;
alter table evops_messages add column if not exists tok_total integer not null default 0;

-- ── 3) 视图扩展：按天 × 模型 × 工具 汇总（追加 token 用量；列只能末尾追加）──
create or replace view v_evops_model_daily as
select date_trunc('day', ts)::date as day,
       tool, model, client,
       count(*)                         as messages,
       count(distinct sid)              as sessions,
       count(distinct task_id)          as tasks,
       coalesce(sum(tok_in), 0)::bigint  as tok_in,
       coalesce(sum(tok_out), 0)::bigint as tok_out,
       coalesce(sum(tok_total),0)::bigint as tok_total
from evops_messages
where hook_event = 'UserPromptSubmit'
group by 1,2,3,4;

-- ── 4) 开发者当日用量视图（大屏与手机端同读一份；按 sid 归因）──
-- 只算「有 token 记录」的会话；昵称不在此视图（显示名在应用层 join evops_agents，避免双写漂移）。
create or replace view v_evops_agent_daily as
select sid,
       (date_trunc('day', ts) at time zone 'Asia/Shanghai')::date as day,
       max(model)                                          as model,
       max(tool)                                           as tool,
       count(*) filter (where hook_event='UserPromptSubmit') as prompts,
       coalesce(sum(tok_total), 0)::bigint                 as tok_total
from evops_messages
where coalesce(sid, '') <> ''
group by 1, 2;
