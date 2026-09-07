# Upstash KV 备份方案

## 概述

当前系统使用 **Neon Postgres** 作为主数据库（通过 `lib/redis.js` 兼容层模拟 Redis 接口）。Vercel 提供了 **Upstash KV**（violet-basket）作为 Redis 兼容的键值存储，可作为备用数据库。

当 Neon Postgres 额度耗尽时，可切换到 Upstash KV 继续运行。

## 架构对比

| 项目 | 当前（Neon Postgres） | 备用（Upstash KV） |
|------|----------------------|-------------------|
| 类型 | PostgreSQL | Redis |
| 存储上限 | 0.5 GB（免费） | 256 MB（免费） |
| 每日请求 | 无限制 | 10,000 次 |
| 连接方式 | `@vercel/postgres` / `pg` | `@upstash/redis` SDK 或 REST API |
| 数据格式 | 表结构（kv_strings/kv_hashes/kv_sets/kv_zsets） | 原生 Redis 数据结构 |
| 配额耗尽 | 存储满后无法写入 | 请求次数超限后拒绝请求 |

## Upstash KV 创建步骤

### 1. 在 Vercel 中创建 Upstash KV

1. 打开 Vercel 项目 Dashboard → **Storage** 标签
2. 点击 **Create Database** → 选择 **Upstash KV**
3. 选择 violet-basket 或创建新实例
4. 创建完成后，Vercel 自动注入环境变量：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### 2. 在 Vercel 项目设置中确认环境变量

进入项目 Settings → Environment Variables，确认以下变量已存在：

```
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token_here
```

## 备份脚本

### 脚本位置

`scripts/backup-to-upstash.js`

### 功能

读取 Neon Postgres 中所有数据表，写入 Upstash KV：

| 源表 | 目标 Redis 结构 | 说明 |
|------|----------------|------|
| `kv_strings` | `SET key value` | 字符串键值对 |
| `kv_hashes` | `HSET key field value` | 哈希表 |
| `kv_sets` | `SADD key member` | 集合 |
| `kv_zsets` | `ZADD key score member` | 有序集合 |

### 执行方式

```bash
# 本地执行
UPSTASH_REDIS_REST_URL="https://xxx.upstash.io" \
UPSTASH_REDIS_REST_TOKEN="your_token" \
POSTGRES_URL="postgresql://..." \
node scripts/backup-to-upstash.js
```

```bash
# Vercel 环境执行（自动读取环境变量）
node scripts/backup-to-upstash.js
```

### 输出示例

```
Reading data from Postgres...
  kv_strings: 234 rows
  kv_hashes:  12 rows
  kv_sets:    156 rows
  kv_zsets:   8 rows

Total rows to backup: 410
Upstash current keys: 0

--- Writing kv_strings ---
  strings: 100/234
  strings: 200/234
  strings: 234/234

--- Writing kv_hashes ---
  hashes: 12/12

--- Writing kv_sets ---
  sets: 100/156
  sets: 156/156

--- Writing kv_zsets ---
  zsets: 8/8

=== Backup Complete ===
  Rows written: 410
  Errors: 0
  Upstash keys after backup: 89
```

## 切换到 Upstash KV 的方案

### 方案 A：环境变量切换（推荐）

修改 `lib/redis.js`，检测 `USE_UPSTASH=true` 环境变量时切换到 Upstash SDK：

```javascript
// lib/redis.js 中增加
if (process.env.USE_UPSTASH === "true") {
  var Redis = require("@upstash/redis");
  var redis = new Redis.Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  module.exports = redis;
  return;
}
```

安装依赖：

```bash
npm install @upstash/redis
```

在 Vercel 中设置环境变量 `USE_UPSTASH=true` 即可切换。

### 方案 B：手动切换

1. 执行备份脚本将数据同步到 Upstash KV
2. 部署包含方案 A 代码的新版本
3. 设置环境变量 `USE_UPSTASH=true`

## 注意事项

1. **存储容量**：Upstash KV 免费版 256 MB，Neon Postgres 免费版 0.5 GB。注意数据量不要超过 256 MB。
2. **请求限制**：Upstash KV 免费版每日 10,000 次请求。当前系统统计页面每次刷新消耗约 4-10 次请求，需注意优化。
3. **数据一致性**：备份脚本是全量同步，不会增量合并。每次执行会覆盖 Upstash 中已有数据。
4. **admin_messages 表**：该表是 Postgres 原生表（非 Redis 模拟），备份脚本暂不处理。如需备份此表，需额外处理。
5. **定时备份**：可在 Vercel Cron Jobs 中添加定时任务，每日自动备份到 Upstash KV。

## 定时备份（可选）

在 `vercel.json` 中添加：

```json
{
  "crons": [
    {
      "path": "/api/admin/backup-to-upstash",
      "schedule": "0 5 * * *"
    }
  ]
}
```

## 相关文件

- [scripts/backup-to-upstash.js](file:///Users/Banner/Documents/guomengtao/app-auth/scripts/backup-to-upstash.js) - 备份脚本
- [lib/redis.js](file:///Users/Banner/Documents/guomengtao/app-auth/lib/redis.js) - Redis 兼容层（需修改以支持切换）
- [lib/postgres.js](file:///Users/Banner/Documents/guomengtao/app-auth/lib/postgres.js) - Postgres 连接