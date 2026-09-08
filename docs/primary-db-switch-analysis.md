# Primary Database Switching - Feasibility Analysis

## Overview

Analyze whether the admin panel can implement dynamic primary database switching, with automatic backup database fallback.

**Core requirement:**
- Admin panel can select which database is the "primary"
- Before switching, verify the target database has synced data (avoid data loss)
- Other databases automatically become backup databases
- "Sync" button: sync from current primary to all backup databases

---

## 1. Current Architecture

### 1.1 Existing Infrastructure

The system already has a solid foundation:

| Component | File | Status |
|-----------|------|--------|
| Database switch flags | db:switch:supabase/neon/upstash in Upstash KV | Done |
| Switch management module | lib/db-switches.js | Done |
| Switch API (GET/POST) | api/admin/health.js?section=dbswitches | Done |
| Sync API | api/admin/health.js?section=sync | Done |
| CLI sync tool | scripts/sync-all-dbs.js | Done |
| DB status overview | api/admin/health.js?section=dbstatus | Done |
| Data access layer | lib/redis.js | Needs modification |

### 1.2 Current Data Flow

```
                    lib/redis.js (data access layer)
                              |
                    USE_UPSTASH=true?
                    /                  \
                  YES                   NO
                   |                     |
             Upstash KV            Postgres (lib/postgres.js)
             (Redis)                    |
                                 DB_PROVIDER env var
                                 /                  \
                           supabase              neon
                              |                    |
                        Supabase PG           Neon PG
```

### 1.3 Current Switch Mechanism

The db:switch:* keys currently only control enable/disable (on/off), not which database is primary. The primary Postgres is determined by DB_PROVIDER env var at deploy time.

```javascript
// lib/redis.js (simplified)
if (USE_UPSTASH === "true" && dbSwitches.isEnabled("upstash")) {
  // Use Upstash Redis directly
} else {
  // Use Postgres (which one depends on DB_PROVIDER env var)
}
```

---

## 2. Proposed Architecture

### 2.1 Target Data Flow

```
                    lib/redis.js (data access layer)
                              |
                    Read db:primary:provider from Upstash
                    /           |            \
              upstash       supabase        neon
                 |             |              |
           Upstash KV     Supabase PG     Neon PG
           (Redis)        (Postgres)      (Postgres)
```

### 2.2 New Configuration Keys

| Key | Value | Description |
|-----|-------|-------------|
| db:primary:provider | upstash / supabase / neon | Which database is primary |
| db:primary:synced_at | ISO timestamp | Last sync time from primary to backups |
| db:primary:synced_hash | data fingerprint | Hash of data at last sync for verification |

---

## 3. Feasibility Assessment

### 3.1 What Already Works

- Database on/off toggles: db:switch:* keys and API already support enabling/disabling
- Sync infrastructure: sync API already syncs data between databases
- Orphan cleanup: sync script now cleans up orphan keys in target databases
- Status dashboard: dbstatus section shows all three databases with status
- Switch caching: lib/db-switches.js has 5-second cache TTL for runtime switching

### 3.2 What Needs to Be Built

#### 3.2.1 Dynamic Primary Selection in lib/redis.js

**Current problem:** lib/redis.js reads DB_PROVIDER from process.env at module load time (static).

**Solution:** Use a proxy pattern that routes requests to the correct backend based on the current primary setting in Upstash KV.

**Option A - Proxy Pattern (Recommended):**

```javascript
// lib/redis.js - conceptual change
var primaryProvider = "auto";

async function getBackend() {
  var provider = await dbSwitches.getPrimaryProvider();
  if (provider === "upstash") return upstashBackend;
  if (provider === "supabase") return supabasePgBackend;
  if (provider === "neon") return neonPgBackend;
  return defaultPgBackend;
}

async function get(key) {
  var backend = await getBackend();
  return backend.get(key);
}
```

**Complexity:** Medium. Need to initialize connection pools for all three databases and route dynamically.

#### 3.2.2 Pre-Switch Verification

**Verification steps:**

1. Count total keys/records in current primary
2. Count total keys/records in target database
3. Compare key-level data fingerprints
4. Check db:primary:synced_at timestamp
5. If mismatch, require sync before allowing switch

```javascript
async function verifySwitchTarget(currentPrimary, targetDb) {
  var currentStats = await getDbStats(currentPrimary);
  var targetStats = await getDbStats(targetDb);

  var keyCountMatch = Math.abs(currentStats.keys - targetStats.keys) <= THRESHOLD;
  var fingerprintMatch = currentStats.fingerprint === targetStats.fingerprint;
  var lastSync = await redis.get("db:primary:synced_at");
  var recentlySynced = lastSync && (Date.now() - new Date(lastSync).getTime() < 3600000);

  return {
    canSwitch: keyCountMatch && fingerprintMatch,
    needsSync: !keyCountMatch || !fingerprintMatch,
    details: { currentStats, targetStats, lastSync, recentlySynced }
  };
}
```

#### 3.2.3 Sync Direction Logic

**Current:** Sync always goes from the DB_PROVIDER env var database.

**After change:** Sync direction determined by db:primary:provider:

| Primary | Sync Targets |
|---------|-------------|
| upstash | Supabase PG, Neon PG |
| supabase | Upstash KV, Neon PG |
| neon | Upstash KV, Supabase PG |

#### 3.2.4 Admin Panel UI

New UI elements needed:
- Primary database selector (dropdown)
- "Verify and Switch" button with comparison results
- "Sync to Backups" button
- Visual indicator for current primary database

---

## 4. Risk Analysis

### 4.1 High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Data loss during switch | Critical | Pre-switch verification mandatory. Never switch without data confirmation. |
| Race condition: write during switch | High | Use write lock during switch. Queue or reject writes during switch window. |
| Cannot read primary setting | High | Always store db:primary:provider in Upstash KV. Upstash is always available and independent of Postgres. |

### 4.2 Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Upstash vs Postgres data model mismatch | Medium | Sync scripts already handle conversion. Proxy layer must handle both backends. |
| Connection pool exhaustion | Medium | Each Postgres backend needs its own pool. Limit pool sizes and share connections. |
| Sync takes too long | Medium | Current sync of 302 keys takes ~2-3 minutes. Use fingerprint check instead of full sync for verification. |

### 4.3 Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Admin mistakes | Low | Confirmation dialogs, verification display, undo capability |
| Cache inconsistency | Low | 5-second cache TTL sufficient. Flush cache on switch. |

---

## 5. Stability Assessment

### 5.1 Is This Stable?

**Yes, with caveats.** The core infrastructure is already in place.

**Key stability factors:**

1. Upstash as configuration store: db:primary:provider stored in Upstash KV, independent of Postgres. Even if both Postgres databases are down, the system can still read the primary setting and switch to Upstash.

2. Gradual rollout possible:
   - Phase 1: Add verification API (read-only, zero risk)
   - Phase 2: Add sync-from-primary API (uses existing logic)
   - Phase 3: Add dynamic primary switching in lib/redis.js
   - Phase 4: Add admin panel UI

3. Fallback mechanism: If primary is unreachable, auto-fallback to next available backup. Partially implemented with db:switch:* toggles.

### 5.2 Completion Status

| Feature | Completion |
|---------|-----------|
| Database switch storage | 100% |
| Switch management API | 100% |
| Sync API | 90% (needs direction logic update) |
| Sync CLI tool | 100% |
| Verification/diagnosis | 90% (needs comparison logic) |
| Dynamic primary routing | 30% (needs proxy pattern) |
| Admin panel UI | 20% (needs new components) |

---

## 6. Implementation Plan

### Phase 1: Verification API (Low Risk)
GET /api/admin/health?section=verify-switch&target=supabase
- Compares data between current primary and target
- Returns key counts, fingerprint, last sync time
- Read-only, no writes

### Phase 2: Sync Direction Update (Medium Risk)
Modify ?section=sync to:
- Read db:primary:provider for sync direction
- Support syncing from any primary to all backups
- Update db:primary:synced_at and db:primary:synced_hash

### Phase 3: Dynamic Primary Routing (Higher Risk)
Modify lib/redis.js to:
- Add proxy/delegate pattern for backend routing
- Initialize pools for all configured databases
- Read db:primary:provider at runtime with caching
- Handle connection failures gracefully

### Phase 4: Admin Panel UI
Add to Settings > Database page:
- Primary database selector
- Pre-switch verification display
- Sync button
- Status indicators

---

## 7. Conclusion

**The feature is both stable and feasible.** The existing architecture already has database switch infrastructure, sync capabilities, orphan cleanup, and status monitoring.

**Main work required:**
1. Making lib/redis.js dynamically route to the selected primary (proxy pattern)
2. Adding pre-switch verification
3. Updating admin panel UI

**Key design decision:** Keep Upstash KV as permanent storage for configuration keys (db:primary:provider, db:switch:*). This ensures the switch mechanism itself is always available, avoiding the chicken-and-egg problem.

**Recommendation:** Proceed with Phase 1 (verification API) first - zero risk, immediate value for diagnosing database consistency.