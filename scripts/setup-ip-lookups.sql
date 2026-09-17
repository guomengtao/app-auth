-- Supabase PostgreSQL - IP lookup results persistent storage
-- Run this in Supabase SQL Editor or via migration script

create table if not exists ip_lookups (
  ip            varchar(45) primary key,
  country       varchar(64) not null default '',
  region        varchar(64) not null default '',
  city          varchar(64) not null default '',
  isp           varchar(128) not null default '',
  org           varchar(128) not null default '',
  asn           varchar(32) not null default '',
  lat           float8 not null default 0,
  lon           float8 not null default 0,
  timezone      varchar(64) not null default '',
  sources       varchar(255) not null default '',
  raw_data      jsonb,
  updated_at    timestamptz not null default now()
);

create index if not exists idx_ip_lookups_updated on ip_lookups(updated_at desc);