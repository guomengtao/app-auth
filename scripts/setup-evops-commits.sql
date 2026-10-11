-- Supabase PostgreSQL - EvOps git 提交流水表 evops_commits
-- 方案出处：docs/EvOps大屏-最近Git提交Tab-方案.md §4（2026-10-12，用户批「都同意」）
-- 在 Supabase SQL Editor（或 scripts/setup-evops-commits.js）中运行一次。幂等，可重复执行。
--
-- 背景：collect-status.js 的 extractCommits() 只做「会话窗口内未认领 commit → done 任务」兜底，
--       没有"提交流水"这种全量记录；安卓大屏「最近 Git 提交」轮播页需要它。
-- 分工：evops_tasks = 任务台账（含 commit 兜底补录）；
--       evops_commits = 逐条提交流水（幂等 on_conflict=hash，看"最近谁提交了什么"）。

create table if not exists evops_commits (
  hash          varchar(64) primary key,              -- 短 hash，幂等键
  repo          varchar(240),                         -- 本地仓库路径
  author        varchar(120),                         -- 提交人（= 会话花名，含 emoji）
  subject       varchar(300),                         -- 提交标题
  files_changed integer,                              -- git show --shortstat 解析（解析不到为 null → 端上显示 —）
  ts            timestamptz,                          -- 提交时间（commit 时间戳）
  sid           varchar(120),                         -- 采集时归属会话（可空）
  updated_at    timestamptz not null default now()
);

create index if not exists idx_ec_ts on evops_commits(ts desc);

-- RLS：service_role（采集器写）全权；anon 只读（与 evops_messages 同口径）
alter table evops_commits enable row level security;
drop policy if exists "evops_commits_anon_read" on evops_commits;
drop policy if exists "evops_commits_svc_all"   on evops_commits;
create policy "evops_commits_anon_read" on evops_commits for select using (true);
create policy "evops_commits_svc_all"  on evops_commits for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
