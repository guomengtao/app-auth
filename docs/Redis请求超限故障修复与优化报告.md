# Upstash Redis 请求超限故障修复与优化报告

## 一、故障现象

**错误信息**：
```
ERR max requests limit exceeded. Limit: 500000, Usage: 500000
See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details
```

**用户影响**：
- 添加产品失败：返回"服务器内部错误"
- 激活兑换码失败：返回"服务器内部错误"
- 所有管理后台功能 500 错误

## 二、根本原因分析

### 2.1 Upstash 免费套餐限制
- **月度请求上限**：500,000 次/月
- 一旦触发，所有 Redis 请求被拒绝，直到下月重置或升级套餐

### 2.2 代码中导致请求爆炸的模式

| 模块 | 原代码问题 | 单次请求消耗 | 优化后 |
|------|-----------|-------------|--------|
| `stats.js` | 每次打开统计页 **SSCAN 全量遍历**所有兑换码 + pipeline 逐个 `GET` 判断 used 状态 | 1000 个码 ≈ 5~50 次 SSCAN + 10~13 次 pipeline | **计数器 key + 5 分钟缓存**，命中缓存时仅 4 次 `hlen/scard/get` |
| `redeem-codes.js` POST | 生成 N 个码用**循环单查**：每个码先 `GET` 查重(+重试) + `SET` + `SADD` | 1000 个码 ≈ **3000+ 次请求** | **批量 pipeline 查重 + 批量 pipeline 写入**：≈ 2 次 pipeline 执行 |
| `activate.js` | 激活码写入时 4 个操作**串行 await** | 4 次网络往返 | **Promise.all 并行**：1 次批量 |
| `messages.js` / `publish.js` | **每次 HTTP 请求 new Redis()** 创建新连接实例 | 连接泄漏 + 额外开销 | **复用 `lib/redis.js` 单例** |
| 全局错误处理 | 未识别 `max requests limit exceeded` 错误 | 用户只看到"内部错误" | 所有 API 添加 `isRateLimitError()` 检测，返回明确升级提示 |

### 2.3 典型请求消耗场景对比

| 操作 | 优化前（1000 兑换码） | 优化后 | 节省比例 |
|------|---------------------|--------|---------|
| 查看统计页 1 次 | ~30-50 次 | 4 次 (缓存命中) | **90%+** |
| 生成 100 个兑换码 | ~300 次 | ~2-3 次 pipeline | **99%** |
| 激活 1 个码 | 4 次串行 | 1 次并行批处理 | 75% |
| 打开兑换码列表页 | SSCAN + pipeline | SSCAN count=500 | 约 60% |

## 三、代码修复详情

### 3.1 lib/redis.js - 基础设施增强
- 新增 `isRateLimitError(err)` 函数：正则匹配 rate limit 相关错误
- 错误消息全英文化
- mock client 补齐 `hlen/lrange/lpush/mget` 等缺失方法

### 3.2 api/admin/stats.js - 最大优化点
```
新增计数器 key: auth:counter:used_redeem_codes (5 分钟 TTL 缓存)
- 缓存命中：4 个 O(1) 操作并行 Promise.all
- 缓存未命中：回退全量扫描，扫描结果写缓存
- 激活兑换码时主动 INCR 更新计数器
- 新增批量码时 DEL 失效缓存
```

### 3.3 api/admin/redeem-codes.js - 生成码流程重构
```
原流程:
  for (i=0; i<N; i++) {
    code = random();
    while (redis.get(KEY) 存在) 重试;  // 每个码 1~10 次 GET
    redis.set(KEY, record);            // 每个码 1 次 SET
    redis.sadd(SET, code);             // 每个码 1 次 SADD
  }
  = 3N ~ 11N 次请求

新流程:
  1. 本地 Set 预生成 N * 1.2 + 10 个候选码 (O(1) 内存去重)
  2. pipeline.GET 批量查重 (1 次网络调用)
  3. 选出可用码后，pipeline.SET + pipeline.SADD 批量写入 (1 次网络调用)
  4. DEL 删除统计缓存
  = 固定 ~3 次 pipeline + 1 次 DEL，与数量无关
```

### 3.4 api/activate.js - 并行化 + 计数器维护
- 激活成功路径的 4 次写操作改为 `Promise.all` 并行
- 激活成功时 `INCR auth:counter:used_redeem_codes` 更新统计计数
- 重复激活场景的 2 次写也改为 `Promise.all`
- 删除所有中文错误消息，替换为英文

### 3.5 api/messages.js & api/publish.js - 连接复用
- 删除 `const redis = new Redis({...})` 独立实例
- 改为 `const redis = require("../lib/redis")` 复用全局单例
- 避免连接池耗尽和额外握手请求

### 3.6 lib/validate.js - 英文化
- `validateDeviceId()` 错误消息 "设备ID不能为空" → "Device ID is required"

### 3.7 api/admin/health.js - 检查项英文化 + Rate Limit 智能提示
- 所有检查项名称、detail、hint 全英文化
- `runCheck()` 捕获异常时检测 `isRateLimitError`，给出升级链接
- 错误提示含 `https://upstash.com/docs/redis/troubleshooting/max_requests_limit`

### 3.8 api/admin/products.js & records.js
- 添加 `isRateLimitError` 错误分支，返回 Upstash 限额提示
- 产品上限提示 99 条英文本地化

## 四、紧急解决方案（立即恢复服务）

### 方案 A：升级 Upstash 套餐（推荐）
1. 登录 [https://console.upstash.com/](https://console.upstash.com/)
2. 选择 Redis 实例：`on-cat-235786`
3. 升级到 **Pay as you go** 计划：$0.20/100k 请求，无硬上限
4. 升级后立即生效，无需重新部署

### 方案 B：等待月度重置
- 重置时间：每月 1 号 UTC 00:00
- 期间所有依赖 Redis 的功能不可用（不推荐）

### 方案 C：临时切换到新的免费实例
1. Upstash 控制台新建一个免费 Redis
2. 复制新的 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`
3. 在 Vercel → Project → Settings → Environment Variables 替换
4. **注意**：新建实例是空库，产品、兑换码、激活记录全部丢失
5. Redeploy 后生效

## 五、长期建议

### 5.1 监控告警
- 在 Upstash 控制台设置 80% 使用量邮件告警
- Vercel 函数日志中搜索 `max requests limit` 关键词告警

### 5.2 进一步优化
1. **兑换码列表分页**：当前每次 GET 仍全量拉取，改服务端 cursor 分页可进一步省请求
2. **激活记录批量导出**：当前页拉取后全表排序，可 Redis 侧用 ZSET 存时间戳索引
3. **定时备份**：每周用 pipeline `SCARD + HGETALL` 全量导出到 JSON，免费实例丢失时可快速恢复

### 5.3 请求预算核算（Pay as you go）

| 场景 | 月请求数估算 | 月费用 |
|------|------------|--------|
| 小型使用（每天生成 100 码 + 激活 50 次） | ~50K 次 | $0.10 |
| 中型使用（每天 1000 码 + 激活 500 次） | ~500K 次 | $1.00 |
| 大型使用（每天 1 万码 + 激活 5000 次） | ~5M 次 | $10.00 |

## 六、修复文件清单

```
修改的文件 (11 个):
- lib/redis.js                      // 单例 + rate limit 检测 + mock 方法补全
- lib/validate.js                   // 设备ID 错误消息英文化
- api/admin/products.js             // rate limit 错误识别 + 英文化
- api/admin/redeem-codes.js         // 批量 pipeline 生成 + 缓存失效
- api/admin/stats.js                // 计数器 TTL 缓存 (最大优化)
- api/admin/records.js              // rate limit 错误识别
- api/admin/health.js               // 全英文化 + rate limit 专项提示
- api/activate.js                   // Promise.all 并行 + 计数器更新
- api/messages.js                   // 复用 lib/redis 单例
- api/publish.js                    // 复用 lib/redis 单例 + Promise.all 并行
- docs/Redis请求超限故障修复与优化报告.md  // 本文档 (新增)
```

## 七、验证清单

部署后通过以下步骤验证修复有效：

1. **Health Check**：访问 `/api/admin/health`，所有检查项 pass，redis_ping 返回 PONG
2. **添加产品**：POST `/api/admin/products`，返回 `{success: true}` 而非 500
3. **统计接口**：连续 GET `/api/admin/stats` 两次，第二次响应明显更快（缓存命中）
4. **生成兑换码**：POST 生成 100 个，观察 Vercel 日志无 `max requests` 报错
5. **错误识别**：如仍限额，错误消息应包含 "Redis request quota exceeded (Upstash monthly limit)" 而非泛泛的 "Internal server error"