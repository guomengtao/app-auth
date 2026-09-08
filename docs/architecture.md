# App-Auth 架构文档

## 概述

双层架构：**协调层**（Upstash KV）+ **数据层**（可切换的 PostgreSQL 数据库）。

Upstash KV 仅作为协调层，不参与数据传输。PostgreSQL 数据库之间直接同步，不经过 Redis 中转。

```
┌─────────────────────────────────────────────────────────┐
│              协调层（不可切换）                             │
│                   Upstash KV (Redis)                     │
│  免费额度: 10K 命令/天, 256MB 存储                        │
│                                                          │
│  职责:                                                   │
│  • 数据库切换配置 (auth:db:primary, db:switch:*)          │
│  • 业务数据存储 (auth:*, afdian:*, quota:*, ratelimit:*)  │
│  • 同步状态记录                                          │
│  • 不参与数据传输！                                       │
│                                                          │
│  角色: 指挥官 + 业务数据存储                               │
└──────────────────────┬──────────────────────────────────┘
                       │
            "谁是主数据库？"
                       │
┌──────────────────────┴──────────────────────────────────┐
│               数据层（可切换）                              │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Supabase    │  │    Neon      │  │   (未来)     │   │
│  │  PostgreSQL  │  │  PostgreSQL  │  │   新数据库    │   │
│  │              │◄─┼──直接同步───►│  │              │   │
│  │  500MB 免费  │  │  512MB 免费  │  │  ...         │   │
│  │  无冷启动    │  │  100h/月计算 │  │              │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                          │
│  所有数据库通过直接同步保持数据一致                          │
│  运行时切换数据库，无需停机                                 │
└──────────────────────────────────────────────────────────┘
```

## 数据库注册表

所有数据库在 `db-registry.json` 中定义。添加新数据库只需编辑此文件并设置对应的环境变量。

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

## 数据库切换原理

### 切换流程

```
管理员后台 → POST /api/admin/switch-db { target: "neon" }
                              │
                              ▼
                   dbSwitches.savePrimary("neon")
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
            写入 Redis:           更新内存缓存:
            SET auth:db:primary   cachedPrimary = "neon"
            = "neon"
            (持久化存储)           (立即生效)
```

### 每次请求的解析流程

```
用户请求
    │
    ▼
postgres.js → resolveConnectionString()
    │
    ▼
dbSwitches.getPrimary()
    │
    ▼
return cachedPrimary    ← 纯 JavaScript 变量读取，不调用 Redis
    │
    ▼
dbRegistry.getDatabase(primary) → 获取环境变量 → 连接数据库
```

### 为什么 Redis 不在请求路径上

- `getPrimary()` 只返回一个 JavaScript 变量 `cachedPrimary`，零 Redis 消耗
- `savePrimary()` 写入 Redis 的同时立即更新 `cachedPrimary`
- Redis 仅用于持久化和跨实例共享
- 1000 个用户访问 = 0 次 Redis 调用（用于数据库切换）

## 进程内存（内存缓存）

### 是什么？

Vercel Serverless 中 Node.js 进程内的 JavaScript 变量（总内存 1024 MB，约 900 MB 空闲可用）。

### 特性

| 属性 | 说明 |
|------|------|
| 作用域 | 单个进程实例内 |
| 多用户共享？ | 是，同一实例上的多个用户共享同一块内存 |
| 跨实例共享？ | 否，不同实例之间内存互相隔离 |
| 持久化？ | 仅在热启动（实例复用）期间保留 |
| 冷启动丢失？ | 是，闲置后实例被销毁，数据全部丢失 |

### 适合和不适合的场景

| ✅ 适合 | ❌ 不适合 |
|--------|----------|
| 配置变量 (`cachedPrimary`) | 在线人数统计 |
| 数据库连接池 | 需要跨实例共享的状态 |
| 短期查询缓存 | 需要精确的计数器 |
| 减少重复计算 | 需要持久化的数据 |

## 数据同步

### 同步方向

```
主 PostgreSQL ──直接批量同步──► 其他 PostgreSQL 数据库
                                  (不经过 Redis！)
```

### 同步策略

**直接同步，不经过 Redis 中转。**

```
❌ 旧方案（浪费 Redis 额度）:
   主库 → 读数据 → 逐条 HTTP 写入 Upstash → 逐条 HTTP 写入目标库
   一次同步消耗 ~500 次 Upstash 命令

✅ 新方案（零 Redis 消耗）:
   主库 → 读数据 → 批量 INSERT INTO 目标库
   一次同步消耗 0 次 Upstash 命令
```

### 同步流程

1. 从主 PostgreSQL 读取所有数据
2. 使用批量 INSERT 写入目标 PostgreSQL（一条 SQL 写入整张表，而非逐条写入）
3. 清理目标库中的孤儿记录（目标库有、源库没有的记录）
4. 可选：同步到 Upstash KV（仅在需要时手动触发）

### 同步消耗分析

| 操作 | 消耗 | 占免费额度比例 |
|------|------|---------------|
| 主库→目标库 PostgreSQL 同步 | ~4 条批量 SQL | 几乎为零 |
| 主库→Upstash KV 同步 | ~500 次命令 | 5% 日额度 |
| 每天同步一次 PostgreSQL | 忽略不计 | ✅ 安全 |
| 每天同步一次 Upstash | 5% 日额度 | ✅ 安全 |
| 每小时同步一次 | ❌ Upstash 超限 | ❌ 危险 |

**建议：** PostgreSQL 之间同步可频繁执行，Upstash 同步仅在必要时手动触发。

### 指纹验证

切换数据库前，系统会比较：
- 键数量 / 记录数量
- 数据指纹（排序后内容的 MD5 哈希）
- 最后同步时间戳

## 各层存储策略

| 存储层 | 存什么 | 为什么 |
|--------|--------|--------|
| Upstash KV | 业务数据 + 切换配置 | 快速键值操作，始终可用 |
| PostgreSQL（当前主库） | 所有关系型数据 | SQL 查询、备份、关联 |
| PostgreSQL（备用库） | 同步副本 | 随时可切换 |
| 进程内存 (`cachedPrimary`) | 当前主库 ID | 零延迟路由 |

## 免费额度限制

| 服务 | 限额 | 风险 |
|------|------|------|
| Upstash KV | 10K 命令/天 | 监控用量，避免频繁同步到 Upstash |
| Supabase | 500MB 存储, 2GB 出流量 | 闲置 7 天自动暂停 |
| Neon | 100h 计算/月, 512MB 存储 | 闲置 5 分钟自动休眠 |
| Vercel | 100GB 带宽, 100GB-小时 | 冷启动，10 秒超时 |

## 添加新数据库

1. 编辑 `db-registry.json`，添加条目：
   ```json
   {
     "id": "newdb",
     "name": "新数据库",
     "type": "postgres",
     "role": "data",
     "urlEnv": "NEWDB_URL",
     "freeLimit": "描述免费额度",
     "host": "example.com"
   }
   ```
2. 在 Vercel 环境变量中设置 `NEWDB_URL`
3. 部署后，后台管理页面会自动显示新数据库
4. 从当前主库直接同步数据到新数据库（不经过 Redis）
5. 准备就绪后切换过去