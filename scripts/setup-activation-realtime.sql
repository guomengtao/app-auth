-- setup-activation-realtime.sql
-- 零操作激活通道：Supabase Realtime 事件表 + 待取激活码表
-- 对应 docs/零操作激活-MAC主键与爱发电自动对接-方案.md §1.6
-- 幂等：可重复执行；只新增对象，不改动任何既有表/策略/字段。
--
-- 安全模型：
--   activation_events  anon 只读，且表内只有 sid/status/ts，无激活码、无设备标识；
--                      App 用 anon key 订阅 INSERT，按 sid 本地过滤。
--   activation_codes   anon/authenticated 全拒（RLS 启用且不建任何 policy），
--                      仅 service_role 可读写；码靠服务端一次 GET 取走。
-- 说明：事件表不做定时任务清理（项目禁用 automation）。由 P2 的 webhook 在写入 paid
--       事件时顺带 delete 一小时前的旧行，属业务写入附带清理，不引入调度。

-- ① 状态事件表 -------------------------------------------------------------
create table if not exists public.activation_events (
  id     uuid primary key default gen_random_uuid(),
  sid    text not null,
  status text not null,          -- waiting | paid | failed
  ts     bigint not null          -- Unix 毫秒时间戳（绝对时刻；展示一律换算 GMT+8）
);
create index if not exists activation_events_sid_ts_idx
  on public.activation_events (sid, ts desc);

alter table public.activation_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'activation_events'
      and policyname = 'anon read events'
  ) then
    create policy "anon read events" on public.activation_events
      for select to anon using (true);
  end if;
end $$;

grant select on public.activation_events to anon;
grant insert, delete on public.activation_events to service_role;

-- Realtime publication：Supabase 通常已预建 supabase_realtime，这里兼容空库
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'activation_events'
  ) then
    alter publication supabase_realtime add table public.activation_events;
  end if;
end $$;

-- ② 待取激活码表（anon 全拒） ----------------------------------------------
create table if not exists public.activation_codes (
  sid        text primary key,
  code18     text not null,
  device_key text,
  node_id    text,
  expires    bigint not null
);

alter table public.activation_codes enable row level security;
revoke all on public.activation_codes from anon, authenticated;
-- 刻意不建任何 policy：RLS 开启 + 无 policy = anon/authenticated 一行都读不到
grant select, insert, delete on public.activation_codes to service_role;
