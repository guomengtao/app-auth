# Vercel Serverless Function 限制与架构分析

## 官方限制

**Vercel Hobby 计划（免费版）最多 12 个 Serverless Function。**

> 参考：[Vercel Limits - Serverless Functions](https://vercel.com/docs/limits/overview#serverless-function)

超出限制后，部署会报错（build 成功但 deploy 失败，状态为 `ERROR`，无明确错误信息）。

---

## 当前 12 个函数清单

| # | 路径 | 功能 | 触发方式 | 认证 |
|---|------|------|----------|------|
| 1 | `api/activate.js` | 使用激活码激活设备 | POST | 无（激活码验证） |
| 2 | `api/admin/direct-activate.js` | 后台快捷激活（跳过兑换码） | POST | 管理员 |
| 3 | `api/admin/health.js` | 服务器健康检查 | GET | 无 |
| 4 | `api/admin/me.js` | 用户信息 + 登出（`?action=logout`） | GET | 管理员 |
| 5 | `api/admin/products.js` | 产品 CRUD 管理 | GET/POST/PUT/DELETE | 管理员 |
| 6 | `api/admin/records.js` | 激活记录查询 | GET | 管理员 |
| 7 | `api/admin/redeem-codes.js` | 兑换码生成、查询、导出 | GET/POST | 管理员 |
| 8 | `api/admin/stats.js` | 统计数据查询 | GET | 管理员 |
| 9 | `api/afdian/query-orders.js` | 爱发电订单同步（Cron）+ 订单列表（`?action=list`） | GET | Cron/管理员 |
| 10 | `api/afdian/webhook.js` | 爱发电 Webhook 接收 | POST | 签名验证 |
| 11 | `api/oauth/callback.js` | OAuth 回调处理 | GET | 无 |
| 12 | `api/oauth/login.js` | OAuth 登录跳转 | GET | 无 |

### 函数分类

```
api/
├── 核心业务 (3)
│   ├── activate.js              # 激活
│   ├── oauth/login.js           # 登录
│   └── oauth/callback.js        # 回调
│
├── 后台管理 (6)
│   ├── admin/me.js              # 用户信息 + 登出
│   ├── admin/products.js        # 产品管理
│   ├── admin/records.js         # 激活记录
│   ├── admin/redeem-codes.js    # 兑换码
│   ├── admin/stats.js           # 统计
│   ├── admin/health.js          # 健康检查
│   └── admin/direct-activate.js # 快捷激活
│
└── 爱发电对接 (2)
    ├── afdian/webhook.js        # Webhook 接收
    └── afdian/query-orders.js   # 订单同步 + 列表
```

---

## 合并策略记录

以下函数通过 query parameter 方式合并，节省了 4 个函数名额：

| 原函数 | 合并到 | 调用方式 |
|--------|--------|----------|
| `api/admin/logout.js` | `api/admin/me.js` | `GET ?action=logout` |
| `api/afdian/orders.js` | `api/afdian/query-orders.js` | `GET ?action=list` |
| `api/afdian/send-code.js` | 已删除 | processOrder 内自动发送私信 |
| `api/publish.js` | 已删除 | 旧留言板，不再需要 |

---

## 未来功能开发分析

### 是否难以继续开发？

**不困难，但需要采用合理的架构策略。** 12 个函数的限制看似紧张，但通过以下方式可以承载大量功能：

### 推荐策略

#### 1. 多功能合并（已在用）
通过 query parameter 区分不同操作，一个函数承载多个功能。

```
示例：api/admin/me.js
  GET /api/admin/me                → 获取用户信息
  GET /api/admin/me?action=logout  → 登出
```

#### 2. 路由分发（推荐）
在单个函数内使用简单的路由分发，按路径或 action 参数分发到不同处理函数。

```javascript
// api/admin/router.js 示例
const routes = {
  'GET /products': handleListProducts,
  'POST /products': handleCreateProduct,
  'GET /records': handleListRecords,
  'GET /stats': handleStats,
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const handler = routes[`${req.method} ${action}`];
  if (handler) return handler(req, res);
  res.status(404).json({ error: 'Not found' });
};
```

**理论上，12 个函数 × 无限 route = 无限功能。**

#### 3. 可合并空间分析

当前仍有合并空间：

| 候选合并 | 说明 |
|----------|------|
| `admin/records.js` + `admin/stats.js` | 都是数据查询，可通过 `?action=records\|stats` 区分 |
| `admin/redeem-codes.js` + `admin/products.js` | 都是资源管理，可合并 |
| `admin/health.js` + `admin/me.js` | 健康检查可并入 me（`?action=health`） |
| `oauth/login.js` + `oauth/callback.js` | OAuth 流程可合并为一个函数 |

**最保守估计：可将 12 个函数压缩到 5-6 个，释放 6-7 个名额。**

#### 4. 升级到 Pro 计划
如果功能确实需要更多独立函数，Vercel Pro 计划（$20/月）支持更多函数和更长的执行时间。

### 结论

| 维度 | 评估 |
|------|------|
| 当前状态 | 12/12 满额，但每个函数都有明确的独立职责 |
| 扩展空间 | 通过合并可释放 6-7 个名额，足够支撑 2-3 倍功能增长 |
| 架构灵活性 | 使用 action 参数分发，单函数内可实现完整 REST API |
| 推荐方案 | 优先合并同类函数，而非升级付费计划 |

**总结：12 个函数的限制不是瓶颈，合理架构下可以承载非常丰富的功能。** 当前设计已经通过合并节省了 4 个名额，未来如需更多功能，继续采用"多功能合并"或"路由分发"模式即可。

---

## 部署注意事项

1. 每次新增/删除 `api/` 目录下的 `.js` 文件，都会影响函数数量
2. 本地运行 `npx vercel build --prod` 后，检查 `.vercel/output/builds.json` 中 `@vercel/node` 类型的数量
3. 如需合并函数，更新前端调用路径（如 `admin_Dx23.html` 中的 API 地址）
4. Vercel 部署失败时不显示明确错误，需通过 API 检查 `readyState`

---

*最后更新：2026-09-02*