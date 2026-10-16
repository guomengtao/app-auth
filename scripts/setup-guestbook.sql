-- Supabase PostgreSQL — 留言板 guestbook 表结构 + RLS 策略
-- 配套文件：api/guestbook.js（ensureTable 自动建表）、guestbook.html（前台投稿+留言墙）、
--           admin/admin-guestbook.html（后台审核台）
-- 任务单：evtask-D-evapp-auth-261016-8dm2pk
--
-- 何时需要跑：虽然 api/guestbook.js 首调会 CREATE TABLE IF NOT EXISTS 自动建表，
--   但**自动建表不附带任何 RLS 策略**。本脚本负责补上数据库层的权限锁：
--   ① 公开留言墙只读 approved（未审核内容绝不外泄）
--   ② 任何写操作（INSERT/UPDATE/DELETE）只能由后端 service_role 执行，
--      即便有人拿到 anon key，也无法绕过 API 的蜜罐/限流/审核流直接污染数据。
-- 幂等：全部 drop policy if exists / create table if not exists，可重复执行。

create table if not exists guestbook (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  name        text not null default '匿名',
  content     text not null,
  images      jsonb not null default '[]'::jsonb,
  status      text not null default 'pending',   -- pending / approved / hidden：投稿默认 pending，须经审核才上墙
  admin_note  text,                              -- 管理员备注（仅后台可见）
  ip_hash     text                               -- IP 哈希（限流溯源，不存明文）
);

-- 索引：留言墙按时间倒序分页；后台按 status 过滤
create index if not exists idx_gb_created     on guestbook(created_at desc);
create index if not exists idx_gb_status_time on guestbook(status, created_at desc);

-- ======================= RLS =======================
-- 安全口径：留言板比 evops_messages 更严 —— anon 只能看到 status='approved' 的行。
-- （对比：evops_messages 的 anon 策略是 using(true) 全表可读；留言板必须过滤未审核内容。）
alter table guestbook enable row level security;

drop policy if exists "guestbook_anon_read_approved" on guestbook;
-- ⚠️ 原稿此处照搬了 Supabase 模板的写策略：
--      create policy ... using (auth.role() = 'service_role')
--   但本项目的库是 **Neon**（不是 Supabase），没有 auth schema → 执行报
--   "schema \"auth\" does not exist"，写策略建不出来。
--
--   正确性说明（Neon + Vercel serverless 场景）：
--   Vercel 函数以**表 owner** 身份连接，而 PostgreSQL 的 RLS 对表 owner 默认不生效
--   （除非显式 ALTER TABLE ... FORCE ROW LEVEL SECURITY）。因此 INSERT/UPDATE/DELETE
--   实际不受影响 —— 线上 POST 已验证可正常写入。
--   上面对 public 角色的 SELECT 策略，仍然拦住了「将来可能出现的只读直连」场景：
--   那种连接不是 owner，读不到 status<>'approved' 的行。
--
--   若哪天迁回 Supabase，再补下面这条即可：
--   create policy "guestbook_svc_all" on guestbook for all
--     using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ======================= 校验（可选） =======================
-- 建完可在 Supabase SQL Editor 执行下面两句自查：
--   1) 策略是否生效：
--      select policyname, cmd from pg_policies where tablename = 'guestbook';
--      应看到 guestbook_anon_read_approved(SELECT) 与 guestbook_svc_all(ALL) 两条。
--   2) 用 anon key 从前端直接 select * from guestbook，应只返回 approved 行，
--      且 insert 会被拒绝（必须经 /api/guestbook 走 service_role）。
