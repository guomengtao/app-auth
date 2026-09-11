# Vercel Edge Config 替代 Redis 作为数据库协调员方案分析

## 一、背景

当前系统的数据库切换协调功能仅需要一个简单的键值存储：
- **读操作**：每次 API 请求读取 `auth:db:primary`（当前主库是谁）
- **写操作**：管理员切换主库时写入 `auth:db:primary`（极低频，可能几天一次）

之前使用 Upstash Redis 承载这个功能，每天约消耗 400+ 次 HTTP 请求。本文分析使用 Vercel Edge Config 替代的可行性。

## 二、Vercel Edge Config 是什么

Vercel Edge Config 是 Vercel 自带的边缘配置存储，设计目标就是「高频读取、低频写入」的配置数据。

| 特性 | 说明 |
|------|------|
| 定位 | 全局边缘键值存储，用于功能开关、A/B 测试、动态配置 |
| 读取方式 | 从全球边缘节点读取，延迟极低（边缘网络内 < 1ms） |
| 写入方式 | 通过 Vercel API 或 Dashboard 写入 |
| SDK | `@vercel/edge-config` npm 包 |
| 数据容量 | 每个 Edge Config 约 100 个 key，总大小约 1MB |

## 三、与 Upstash Redis 对比

| 维度 | Upstash Redis | Vercel Edge Config |
|------|--------------|-------------------|
| **设计目标** | 通用内存数据库/缓存 | 边缘配置存储 |
| **读取路径** | HTTP REST API → Upstash 服务器 | 边缘节点本地读取 |
| **读取延迟** | ~10-50ms（跨网络） | < 1ms（边缘本地） |
| **免费额度（读）** | 10,000 次/天 | 海量（设计为高频读） |
| **免费额度（写）** | 包含在 10,000 次/天内 | 受限（约 500-1000 次/月 Hobby） |
| **适合场景** | 缓存、会话、消息队列 | 配置、开关、少量关键数据 |
| **Vercel 集成** | 第三方服务，需额外配置 | 原生集成，同一个 Dashboard |
| **数据持久化** | 内存 + 磁盘备份 | 边缘节点分发（最终一致性） |
| **最大 key 数** | 无限制 | 约 100 个 key |
| **最大 value 大小** | 无限制 | 约 25KB |
| **SDK 复杂度** | REST API，需自己封装 | `@vercel/edge-config` 一行代码读取 |

## 四、针对我们的使用场景分析

### 4.1 我们的需求

```
读操作: 每个 API 请求读取 auth:db:primary（1 个 key）
写操作: 管理员切换数据库时写入（极低频）
数据量: 1 个 key，value 不到 20 字节
```

### 4.2 Edge Config 完美匹配

这是一个教科书级别的 Edge Config 使用场景：
- ✅ 高频读取、低频写入
- ✅ 数据量极小（1 个 key）
- ✅ 需要边缘低延迟
- ✅ 写操作只在管理后台触发

### 4.3 每日用量估算

| 操作 | Edge Config | Upstash Redis |
|------|------------|--------------|
| 100 次 API 读取 | ~100 次（边缘本地，不计费或极低） | ~100 次（消耗每日配额） |
| 1 次切换写入 | ~1 次（月配额消耗 1 次） | ~1 次（消耗每日配额） |
| 免费额度压力 | 几乎为 0 | 约 1% |

## 五、安全性分析

### 5.1 数据安全

| 风险 | Edge Config | Upstash Redis |
|------|------------|--------------|
| 数据泄露 | Token 控制读写权限 | Token 控制读写权限 |
| 未授权写入 | 需 Vercel API Token + Team ID | 需 REST API Token |
| 传输加密 | HTTPS（Vercel 基础设施） | HTTPS |
| 数据存储位置 | Vercel 边缘网络 | Upstash 服务器（AWS/GCP） |

### 5.2 可用性

| 风险 | Edge Config | Upstash Redis |
|------|------------|--------------|
| 服务故障 | Vercel 基础设施（与网站同命运） | 独立第三方（可能单独故障） |
| 网络延迟 | 边缘本地 < 1ms | 跨网络 10-50ms |
| 写入延迟 | 需同步到边缘节点（秒级） | 实时写入 |
| 冷启动 | 无（边缘常驻） | 每次 HTTP 请求建立连接 |
| 故障恢复 | Vercel 自动处理 | Upstash 自动处理 |

### 5.3 关键风险

**风险 1：写入延迟**
- Edge Config 写入后需要几秒同步到全球边缘节点
- 管理员切换数据库后，旧节点可能短暂返回旧值
- **影响**：切换后 1-3 秒内请求可能仍连旧库
- **评估**：可接受，切换操作本身就很低频

**风险 2：单点依赖**
- Edge Config 依赖 Vercel 基础设施
- 如果 Vercel 故障，Edge Config 也无法读取
- **对等条件**：你的网站本身就部署在 Vercel，Vercel 挂了网站也挂了
- **评估**：不是新引入的风险

**风险 3：写入次数限制**
- Hobby 计划每月写入次数有限
- 如果频繁切换数据库，可能超额
- **实际情况**：切换数据库是管理操作，每月几次最多
- **评估**：完全不会超额

## 六、稳定性分析

### 6.1 读取稳定性

Edge Config 的读取是边缘本地操作，不走网络：
- 不需要建立 HTTP 连接
- 不受 Upstash 服务器状态影响
- 不受网络波动影响
- 与 Vercel Function 在同一基础设施，延迟极低

### 6.2 写入稳定性

写操作通过 Vercel API：
- 需要有效的 API Token
- Vercel API 有速率限制
- 写入后异步同步到边缘节点

### 6.3 故障演练

| 故障场景 | Edge Config 表现 | Upstash Redis 表现 |
|---------|-----------------|-------------------|
| Vercel 部分故障 | 影响（同网站） | 不受影响（独立服务） |
| Upstash 故障 | 不受影响 | ❌ 读取失败，回退默认 |
| 网络波动 | 不受影响（边缘本地） | ❌ HTTP 超时，回退默认 |
| 写入后立即读取 | 可能读到旧值（秒级延迟） | 读到新值（实时） |
| 冷启动 | 正常（边缘常驻数据） | 正常（HTTP 请求） |

### 6.4 结论

Edge Config 在读取稳定性上优于 Upstash（边缘本地 vs 跨网络 HTTP），在写入实时性上略逊（秒级同步 vs 实时），但我们的场景几乎不关心写入延迟。

## 七、实施复杂度评估

### 7.1 当前方案改动范围

只需修改 `lib/db-switches.js` 一个文件：
- `loadSwitches()` 改为读取 Edge Config 而非 Upstash HTTP
- `savePrimary()` 改为写入 Edge Config 而非 Upstash HTTP

### 7.2 需要新增的依赖

```bash
npm install @vercel/edge-config
```

### 7.3 需要配置的环境变量

```
EDGE_CONFIG            # Vercel 自动注入的连接字符串
EDGE_CONFIG_TOKEN      # 写入需要的 API Token（仅管理后台需要）
```

### 7.4 代码示意

```javascript
// 替换 Upstash HTTP fetch
const { get: edgeGet } = require('@vercel/edge-config');

async function loadSwitches() {
  // ...
  // 之前: fetch(upstashUrl + "/get/db:switch:...")
  // 之后: 
  const primary = await edgeGet('auth:db:primary');
  const switchUpstash = await edgeGet('db:switch:upstash');
  // ...
}
```

## 八、方案对比总结

| 维度 | 方案 A: 保留 Upstash | 方案 B: Edge Config | 方案 C: 全迁 Postgres |
|------|---------------------|-------------------|---------------------|
| Upstash 日消耗 | ~100 次 | **0 次** | **0 次** |
| 读取延迟 | ~10-50ms | **< 1ms** | ~5-10ms |
| Supabase 挂了能切吗 | ✅ 能 | ✅ 能 | ❌ 不能 |
| 新增依赖 | 无 | `@vercel/edge-config` | 无 |
| 免费额度压力 | 1%/天 | 几乎为 0 | 无 |
| 单点风险 | Upstash 独立 | Vercel 内置 | 无独立协调员 |
| 写入实时性 | 即时 | 秒级延迟 | 即时 |
| 代码改动量 | 小（已实现） | 小 | 小（已实现但有 bug） |

## 九、推荐

**强烈推荐方案 B（Edge Config）**：

1. 零额外费用（Hobby 计划已包含 Edge Config）
2. 零第三方依赖（全部在 Vercel 生态内）
3. 读取速度最快（边缘本地 < 1ms）
4. 不会因 Upstash 故障导致协调失败
5. 写入延迟（秒级）对于切换数据库的场景完全可接受
6. 代码改动极小，风险低

**不推荐方案 C**：因为协调员和被协调的库是同一个，Supabase 挂了就死锁。

**方案 A** 作为备选：已经实现，稳定可靠，只是有少量 Upstash 消耗。