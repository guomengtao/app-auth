# Ev Notifier 顶部叹号标识分析

> 分析 Supabase 消息投递明细表上线后，Ev Notifier 菜单栏未读/丢失消息计数标识是否还有必要存在

---

## 1. 叹号标识是什么

**位置**：macOS 菜单栏 Ev Notifier 图标区域

**表现**：
| 状态 | 菜单栏显示 | 含义 |
|------|-----------|------|
| 正常 | `Ev(0)` 或 `Ev(3)` | `(N)` 表示**本次启动后**收到的消息数 |
| 有丢失 | `Ev(3) ⚠️` 或 `恢复(N)` 红色高亮 | XRANGE 补偿轮询发现 N 条丢失消息 |
| 断开 | `Ev 离线` | 网络断开 |

**完整链路**：
```
Server PUBLISH 消息
     │
     ▼
Redis PUB/SUB 广播
     │
     ├── EvNotifier 在线 → 实时收到 → 计数 +1 → 显示 Ev(N)
     │
     └── EvNotifier 离线 → 消息丢失
              │
              ▼
        下次上线 → XRANGE 对比 → 发现丢失 N 条
              │
              ▼
        菜单栏 → 恢复(N) 红色高亮
```

**叹号来源**：EvNotifier 的 `do_recovery_poll()` 通过 XRANGE 扫描 Redis Stream，与本地 `received_idx` 对比发现差异时，菜单栏出现 `恢复(N)` 红色提示。

---

## 2. Supabase 上线前后的变化

### 2.1 之前：纯本地 + Redis Stream

```
消息投递 = 不可知

Server 发完 → Redis PUB/SUB → 听天由命
                                │
                         EvNotifier 在线 = 收到
                         EvNotifier 离线 = 丢
                                   │
                              XRANGE 补偿 ≈ 碰运气
                              (受 Stream maxlen 窗口期限制)
```

**问题**：丢失检测依赖本地 JSON + Stream 对比，既不精确也不可靠。叹号标识实际反映的是「本地猜测的丢失率」，而非真实投递状态。

### 2.2 之后：Supabase message_delivery 表

```
消息投递 = 全量可追踪

Server 发消息前
     │
     ├── 写入 Supabase message_delivery (status=pending)
     │
     ├── PUBLISH 到 Redis
     │       │
     │       └── 成功后更新 Supabase (status=published)
     │
     └── EvNotifier 收到后回调 API
              │
              └── 更新 Supabase (status=delivered)

任何时候：
  SELECT * FROM message_delivery
  WHERE status IN ('pending', 'failed')
  AND created_at > now() - interval '24 hours'
  → 精确获取未送达消息列表
```

**改变**：丢失检测从「本地猜测」变成了**服务端 SQL 查询**，精确、可靠、不受窗口期限制。

---

## 3. 现在还需要叹号标识吗

### 3.1 原有场景逐一分析

| 场景 | 原有方式 | 新方式 | 叹号是否必要 |
|------|---------|--------|:----------:|
| 1. 通知用户有消息 | 菜单栏 `Ev(N)` | 消息已推送 + Supabase 记录 | ❌ 不再需要 |
| 2. 通知用户有丢失 | 恢复(N) 红色高亮 | 查询 Supabase 未送达列表 | ❌ 不再需要 |
| 3. 手动恢复消息 | 点击「恢复」→ XRANGE 扫描 | 点击「恢复」→ 查 Supabase 补推 | ❌ 可简化 |
| 4. 查看投递状态 | 无（完全不可知） | 管理后台 SQL / API 查询 | ❌ 可替代 |

### 3.2 叹号标识存在的历史原因

```
为什么当初要设计这个标识？
        │
        ▼
因为消息投递是"盲人摸象"——
Server 不知道客户端收没收到，
客户端不知道自己丢没丢，
只能在本地对比 Stream 来"猜"，
猜出差异就用叹号提醒用户"可能有丢失"。

现在 Supabase 表让消息投递"透明化"，
这个"猜"的标识自然不再需要。
```

### 3.3 替代方案

**推荐**：去掉 EvNotifier 菜单栏的未读/丢失计数标识，改为：

```
菜单栏显示     →  Ev v2.x.x            (只显示版本，无计数)
打开面板后显示 →  投递状态卡片
                   ├── 今日投递: 23 条 (来自 Supabase)
                   ├── 成功: 22 条
                   ├── 失败: 1 条
                   └── [恢复未送达] 按钮 → 查 Supabase 补推
```

**消息中心面板展示投递统计数据**：
| 指标 | 数据源 |
|------|--------|
| 今日消息总数 | Supabase `COUNT(*) WHERE created_at > today` |
| 投递成功率 | `delivered / total * 100%` |
| 未送达列表 | `WHERE status IN ('pending','failed')` |
| 平均投递延迟 | `AVG(delivered_at - created_at)` |

---

## 4. 实施建议

### Phase 1：EvNotifier 端去标识（低风险）

| 改动 | 文件 | 说明 |
|------|------|------|
| 菜单栏标题改为纯版本号 | `ev_notifier.py` | `super().__init__(f"Ev {VERSION}")` 去掉 `({_new_msg_count})` |
| 去掉"恢复(N)"红色高亮 | `ev_notifier.py` | "恢复"按钮正常显示，不显示丢失数量 |
| 菜单栏「重置计数」移除或简化 | `ev_notifier.py` | 计数不再显示，重置无意义 |

### Phase 2：面板投递状态卡片（低风险）

在 EvNotifier 仪表盘「消息中心」页面新增「投递状态」区块：

```python
# 伪代码
stats = await querySupabase("SELECT status, COUNT(*) FROM message_delivery GROUP BY status")
if stats.failed > 0:
    show_warning(f"{stats.failed} messages failed to deliver")
```

### Phase 3：恢复按钮改为查 Supabase（中风险）

```
旧逻辑：
  点击恢复 → XRANGE auth:stream → 本地对比 → 补推差异消息

新逻辑：
  点击恢复 → GET /api/message-delivery/undelivered → 遍历补推 → 更新状态
```

依赖条件：`api/message-delivery/callback.js` 已部署、EvNotifier 已集成回调确认。

---

## 5. 总结

| 维度 | 结论 |
|------|------|
| **叹号标识** | 不再必要，可去掉 |
| **理由** | Supabase 表让消息投递从不可知变成可知，丢失检测从本地猜测变成 SQL 精确查询 |
| **替代** | 面板内投递状态卡片 + SQL 查询未送达列表 |
| **保留场景** | 消息计数仍然有用（今日收到了多少条），但不需在菜单栏显示，移到面板内即可 |

**一句话结论**：消息投递追踪上线后，菜单栏叹号标识的历史使命已完成，可以移除，用面板内的投递状态卡片替代，体验更清晰、信息更准确。