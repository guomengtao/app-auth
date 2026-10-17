-- Supabase PostgreSQL - 退休俱乐部评分账本 ev_retirement_scores
-- 方案出处：guomengtao/docs/ev-sls-退休俱乐部-方案.md v1.0 §四（2026-10-14，差评发电机⚡）
-- 在 Supabase SQL Editor 中运行一次（项目：Ev_SUPABASE / kqzkdpmyivtpxkfmibnd）。幂等，可重复执行。
--
-- 定位：ev-sls（会话全生命周期打分）的「云端永久账本」，同时充当 v0.3 方案的 D4 终态快照 —
--       会话被软删除后分数不可考的问题（闪烁南瓜 30 分丢失即活案例）由此根治。
-- 写入方：~/.workbuddy/scripts/ev-sls.sh（service_role key，只在本机 .env，不入库不提交）
-- 读取方：evops 大屏 / api/ev.js（anon key，只读）
--
-- 键设计：ev_sid 与 session_uuid 双键冗余。归因真实键是 session_uuid（sessions.id），
--         ev_sid 是可读别名（两天可变、实测漂移 1930↔1931），仅供人读与跨工具对账。

create table if not exists ev_retirement_scores (
  id                bigserial primary key,
  ev_sid            text not null,                  -- workbuddy-2026xxxx-xxxx-xxxx（可读别名）
  session_uuid      text not null,                  -- sessions.id（归因真实键）
  nickname          text,                           -- 花名（含 emoji，仅展示）
  workspace         text,                           -- 入会前 cwd（原属空间）；入会后不可回溯时为 NULL
  retired_at        timestamptz,                    -- 会话创建时间（近似入会时间）
  score             numeric(5,2),                   -- 严格口径总分（n/a 项按 0 计）
  score_calculable  numeric(5,2),                   -- 可算口径总分（仅 present=1 的项）
  grade             text,                           -- A/B/C/D（v1.2 起按 score_rate 判定）
  coverage          numeric(4,2),                   -- 有数据项 / 16
  scorecard_json    jsonb not null,                 -- 四维 16 项完整评分卡（含依据 note、scorer 版本）
  scored_by         text default 'ev-sls.sh',
  scored_at         timestamptz default now(),
  deleted_at        timestamptz,                    -- ⑤ 软删除执行时间（NULL=未处置）
  unique (ev_sid, scored_at)                        -- 同会话多次评分各留一条（append-only）
);

create index if not exists idx_ers_uuid     on ev_retirement_scores(session_uuid);
create index if not exists idx_ers_scored   on ev_retirement_scores(scored_at desc);
create index if not exists idx_ers_grade    on ev_retirement_scores(grade);
create index if not exists idx_ers_pending  on ev_retirement_scores(deleted_at) where deleted_at is null;

-- RLS：anon 只读（供大屏/前端），写入仅 service_role（key 只在本机 ev/app-auth/.env）
alter table ev_retirement_scores enable row level security;
drop policy if exists "ev_retirement_scores_anon_read" on ev_retirement_scores;
drop policy if exists "ev_retirement_scores_svc_all"   on ev_retirement_scores;
create policy "ev_retirement_scores_anon_read" on ev_retirement_scores for select using (true);
create policy "ev_retirement_scores_svc_all"   on ev_retirement_scores for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- 验收（应返回 200 / 401-42501 各一条）：
--   read : curl -s "$SB_URL/rest/v1/ev_retirement_scores?select=id&limit=1" -H "apikey: $ANON"
--   write: curl -s -X POST "$SB_URL/rest/v1/ev_retirement_scores" -H "apikey: $ANON" -d '{"ev_sid":"x"}'
--          → 应返回 401 {"code":"42501","message":"new row violates row-level security policy ..."}
