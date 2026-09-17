// Setup message_delivery table in Supabase/Postgres
// Usage: node scripts/setup-message-delivery.js

var pg = require("../lib/postgres");

var SQL = `
create table if not exists message_delivery (
  id            bigserial primary key,
  message_id    varchar(64) not null,
  message_type  varchar(32) not null,
  payload       jsonb not null default '{}',
  source        varchar(64) not null,
  channel       varchar(64) not null default 'auth:push_channel',
  target_client varchar(128),
  created_at    timestamptz not null default now(),
  published_at  timestamptz,
  delivered_at  timestamptz,
  confirmed_at  timestamptz,
  status        varchar(16) not null default 'pending',
  error_message text,
  retry_count   int not null default 0,
  related_code  varchar(32),
  related_device varchar(128)
);

create index if not exists idx_md_status on message_delivery(status);
create index if not exists idx_md_created on message_delivery(created_at desc);
create index if not exists idx_md_message_id on message_delivery(message_id);
create index if not exists idx_md_related_code on message_delivery(related_code);
create index if not exists idx_md_status_created on message_delivery(status, created_at desc);
`;

async function main() {
  console.log("Setting up message_delivery table...");
  try {
    await pg.query(SQL);
    console.log("SUCCESS: message_delivery table is ready.");
  } catch (e) {
    console.error("FAILED:", e.message || e);
    process.exit(1);
  }
  process.exit(0);
}

main();