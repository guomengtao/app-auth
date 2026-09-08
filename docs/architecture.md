# App-Auth Architecture

## Overview

Two-tier architecture: **Coordination Layer** (Upstash KV) + **Data Layer** (Switchable PostgreSQL databases).

```
┌─────────────────────────────────────────────────────────┐
│              Coordination Layer (NOT switchable)          │
│                      Upstash KV (Redis)                   │
│  Free: 10K commands/day, 256MB storage                   │
│                                                          │
│  Responsibilities:                                       │
│  • Database switch config (auth:db:primary, db:switch:*)  │
│  • Business data (auth:*, afdian:*, quota:*, ratelimit:*)│
│  • Sync status & logs                                    │
│  • Data exchange hub between PostgreSQL databases         │
│                                                          │
│  Role: Commander + Data Exchange Station                 │
└──────────────────────┬──────────────────────────────────┘
                       │
         "Who is the primary database?"
                       │
┌──────────────────────┴──────────────────────────────────┐
│               Data Layer (Switchable)                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Supabase    │  │    Neon      │  │   (Future)   │   │
│  │  PostgreSQL  │  │  PostgreSQL  │  │   New DB     │   │
│  │              │  │              │  │              │   │
│  │  500MB free  │  │  512MB free  │  │  ...         │   │
│  │  No cold     │  │  100h/mo     │  │              │   │
│  │  start       │  │  compute     │  │              │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                          │
│  All databases store identical data via sync              │
│  Switch between them at runtime without downtime          │
└──────────────────────────────────────────────────────────┘
```

## Database Registry

All databases are defined in `db-registry.json`. Add new databases by editing this file and setting the corresponding environment variables.

```json
{
  "databases": [
    {
      "id": "upstash",
      "name": "Upstash KV",
      "type": "redis",
      "role": "coordinator",
      "urlEnv": "UPSTASH_REDIS_REST_URL",
      "tokenEnv": "UPSTASH_REDIS_REST_TOKEN",
      "freeLimit": "10K commands/day, 256MB storage",
      "host": "upstash.io"
    },
    {
      "id": "supabase",
      "name": "Supabase",
      "type": "postgres",
      "role": "data",
      "urlEnv": "Ev_POSTGRES_URL",
      "freeLimit": "500MB storage, 2GB egress/month",
      "host": "db.*.supabase.co"
    },
    {
      "id": "neon",
      "name": "Neon",
      "type": "postgres",
      "role": "data",
      "urlEnv": "POSTGRES_URL",
      "freeLimit": "100h compute/month, 512MB storage",
      "host": "ep-*.neon.tech"
    }
  ]
}
```

## How Database Switching Works

### Switch Flow

```
Admin Panel → POST /api/admin/switch-db { target: "neon" }
                              │
                              ▼
                   dbSwitches.savePrimary("neon")
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
            Write to Redis:      Update in-memory:
            SET auth:db:primary   cachedPrimary = "neon"
            = "neon"
            (persistent)          (immediate effect)
```

### Resolution Flow (Every Request)

```
User Request
    │
    ▼
postgres.js → resolveConnectionString()
    │
    ▼
dbSwitches.getPrimary()
    │
    ▼
return cachedPrimary    ← Pure JavaScript variable, NO Redis call
    │
    ▼
dbRegistry.getDatabase(primary) → get env var → connect
```

### Why Redis is NOT hit on every request

- `getPrimary()` returns a JavaScript variable `cachedPrimary` — zero Redis consumption
- `savePrimary()` writes to Redis AND updates `cachedPrimary` immediately
- Redis is only used for persistence and cross-instance sharing
- 1000 users = 0 Redis calls for database switching

## Memory (In-Process Caching)

### What is it?

A Node.js process variable inside Vercel Serverless (1024 MB total, ~900 MB free).

### Characteristics

| Property | Value |
|----------|-------|
| Scope | Per process instance |
| Shared across users? | Yes — multiple users on same instance share it |
| Shared across instances? | No — each instance has its own memory |
| Persists? | Only during warm starts (instance reuse) |
| Lost on cold start? | Yes — instance destroyed after idle |

### What it's good for

| ✅ Good for | ❌ Not good for |
|-------------|-----------------|
| Configuration variables (`cachedPrimary`) | Online user count |
| Database connection pools | Cross-instance shared state |
| Short-lived query caches | Counters that need accuracy |
| Reducing repeated computation | Persistent data |

## Data Synchronization

### Sync Direction

```
Primary PostgreSQL ──sync──► Other PostgreSQL databases
        │
        └────sync────► Upstash KV (Redis)
```

### Sync Process

1. Read all data from primary PostgreSQL
2. Write to target PostgreSQL using UPSERT
3. Clean orphan records in target (records not in source)
4. Sync string data to Upstash KV

### Fingerprint Verification

Before switching database, the system compares:
- Key count / record count
- Data fingerprint (MD5 hash of sorted content)
- Last sync timestamp

## Storage Strategy

| Layer | What | Why |
|-------|------|-----|
| Upstash KV | Business data + switch config | Fast key-value ops, always available |
| PostgreSQL (current primary) | All user data | SQL queries, backups, relations |
| PostgreSQL (standby) | Synced copy | Ready for instant switch |
| In-memory (`cachedPrimary`) | Current primary ID | Zero-latency routing |

## Free Tier Limits

| Service | Limit | Risk |
|---------|-------|------|
| Upstash KV | 10K commands/day | Monitor usage, keep switch config minimal |
| Supabase | 500MB, 2GB egress | Auto-pause after 7 days inactive |
| Neon | 100h compute/month, 512MB | Auto-sleep after 5 min idle |
| Vercel | 100GB bandwidth, 100GB-hours | Cold starts, 10s timeout |

## Adding a New Database

1. Edit `db-registry.json`, add entry:
   ```json
   {
     "id": "newdb",
     "name": "New Database",
     "type": "postgres",
     "role": "data",
     "urlEnv": "NEWDB_URL",
     "freeLimit": "Describe limits",
     "host": "example.com"
   }
   ```
2. Set `NEWDB_URL` in Vercel environment variables
3. Deploy — the admin panel automatically shows the new database
4. Sync data from current primary to the new database
5. Switch to it when ready