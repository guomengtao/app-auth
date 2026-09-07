# Supabase Free Tier 自动休眠问题与防止方案

## 一、问题背景

Supabase Free Tier 有一个重要限制：**项目空闲超过 1 周（7天）无任何数据库请求，项目会被自动暂停（Pause）**。

项目暂停后：
- 所有 API 请求 500 错误
- 数据库连接全部断开
- 需要手动登录 Supabase Dashboard 恢复项目
- 恢复后数据不丢失，但期间用户完全无法使用

Supabase 官方文档说明：
> "Free projects are paused after 1 week of inactivity. Limit of 2 active projects."

## 二、什么是"非活跃"（Inactivity）

Supabase 判断非活跃的标准是：**是否有任何数据库操作或 API 请求**。

以下操作**不会**阻止休眠：
- 登录 Supabase Dashboard 查看
- 在 Supabase 管理后台操作
- 仅使用 Supabase Auth（认证服务）

以下操作**会**阻止休眠：
- 对数据库执行任何 SQL 查询（SELECT/INSERT/UPDATE/DELETE）
- 通过 Supabase REST API 请求数据
- 通过 PostgREST 访问数据库

## 三、防止方案

### 方案一：Vercel Cron Job 定时访问（推荐，已实施）

利用 Vercel 的免费 Cron Job 功能，每天定时调用项目的 API 接口，触发数据库操作，从而保持项目活跃。

**当前配置**（`vercel.json`）：

```json
{
  "crons": [
    {
      "path": "/api/afdian/query-orders",
      "schedule": "0 3 * * *"
    },
    {
      "path": "/api/admin/health?section=backup&cron=1",
      "schedule": "0 4 * * *"
    }
  ]
}
```

- 每天凌晨 3:00 查询爱发电订单（触发数据库读写）
- 每天凌晨 4:00 执行数据库备份（触发大量数据库操作）

**优点**：
- 免费（Vercel Hobby 计划支持 Cron Jobs）
- 自动运行，无需外部服务器
- 与项目代码统一管理
- 每次执行都会触发数据库操作，确保活跃

**注意事项**：
- Vercel Cron Job 最小间隔是 1 天，不能设置小时级频率
- 每天 2 次调用足以防止 7 天休眠阈值
- 免费版 Vercel 有执行次数限制，但每天 2 次完全够用

### 方案二：健康检查自动修复（已实施）

在 `api/admin/health.js` 中实现了完整的健康检查系统，包括：

```javascript
// 数据库 Ping 检查
checks.push(
  await runCheck("pg_ping", "Postgres Connectivity", async function () {
    var pong = await redis.ping();
    return {
      status: pong === "PONG" ? "pass" : "warn",
      detail: "ping => " + String(pong),
    };
  })
);

// 数据库读写检查
checks.push(
  await runCheck("pg_rw", "Postgres Read/Write", async function () {
    var key = "auth:health:probe";
    await redis.set(key, JSON.stringify(payload), { ex: 60 });
    var got = await redis.get(key);
    // ... read/write verification
  })
);
```

每次健康检查都会执行数据库读写操作，这也是保持活跃的有效方式。

### 方案三：外部监控服务（可选备用）

如果 Vercel Cron Job 不够可靠，可以使用以下免费外部服务作为补充：

| 服务 | 免费额度 | 最小间隔 |
|------|----------|----------|
| [UptimeRobot](https://uptimerobot.com) | 50 个监控，5 分钟间隔 | 5 分钟 |
| [Cron-job.org](https://cron-job.org) | 无限任务，1 分钟间隔 | 1 分钟 |
| [BetterStack](https://betterstack.com) | 10 个监控，3 分钟间隔 | 3 分钟 |
| [Healthchecks.io](https://healthchecks.io) | 20 个检查，1 分钟间隔 | 1 分钟 |

设置方法：监控 URL 指向 `/api/admin/health` 或其子路径，配置 `cron=1` 参数跳过认证。

### 方案四：管理后台手动刷新（辅助）

管理员定期登录后台管理页面，点击"刷新"按钮或运行健康检查，也会触发数据库操作。但这是被动方式，不建议依赖。

## 四、当前项目防休眠体系

```
┌─────────────────────────────────────────────────────┐
│                    防休眠体系                         │
├─────────────────────────────────────────────────────┤
│  Vercel Cron Jobs（自动化）                          │
│  ├─ 每天 03:00  /api/afdian/query-orders             │
│  │   → 查询爱发电订单 → DB 读写 ✅                    │
│  └─ 每天 04:00  /api/admin/health?section=backup     │
│      → 数据库备份 → DB 大量读写 ✅                    │
├─────────────────────────────────────────────────────┤
│  健康检查 API（按需）                                  │
│  └─ /api/admin/health → DB Ping + 读写验证 ✅         │
├─────────────────────────────────────────────────────┤
│  外部监控（可选备用）                                  │
│  └─ UptimeRobot / Cron-job.org → 定时 Ping ✅         │
├─────────────────────────────────────────────────────┤
│  管理员操作（辅助）                                    │
│  └─ 后台管理 → 刷新数据 → DB 读写 ✅                   │
└─────────────────────────────────────────────────────┘
```

## 五、验证方法

### 5.1 检查 Vercel Cron Job 执行记录

```bash
# 查看 Vercel 部署日志
npx vercel logs --scope guomengtaos-projects-7a91cee5 --project app-auth

# 或在 Vercel Dashboard → app-auth → Deployments → 查看 Cron Job 执行历史
```

### 5.2 检查 Supabase 项目状态

登录 [Supabase Dashboard](https://supabase.com/dashboard) → 选择项目 → 查看：
- 项目状态是否为 "Active"（非 "Paused"）
- 最近数据库查询时间
- 数据库使用量统计

### 5.3 项目内健康检查

访问管理后台 → 健康检查 Tab → 运行检测，确认：
- Postgres Connectivity: pass ✅
- Postgres Read/Write: pass ✅

## 六、应急预案

如果项目被暂停了：

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 找到被暂停的项目
3. 点击 "Restore project" 或 "Resume"
4. 等待 1-2 分钟项目恢复
5. 验证项目 API 是否正常

## 七、注意事项

1. **不要依赖外部监控服务**：免费外部服务可能不稳定，优先使用 Vercel Cron Job
2. **不要过于频繁请求**：Supabase Free Tier 有 2GB 带宽限制和 50K MAU 限制
3. **监控 Cron Job 执行**：定期检查 Vercel 日志，确保 Cron Job 正常运行
4. **备份数据**：即使项目暂停，数据不丢失，但建议定期备份到其他存储
5. **Vercel 部署会触发 Cron Job 重置**：每次部署后确认 Cron Job 配置正确