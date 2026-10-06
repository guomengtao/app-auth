# app-auth 数据分析 · 归档说明

> 归档目的：把分析报告与数据**放在被分析的代码旁边**，便于逐期核对、对比与复现。
> 迁移自 `~/Documents/guomengtao/docs/analytics-appauth/`（2026-10-06）。
> 任务单号 `evtask-D-app-auth-261006-c4htk5`

---

## ⚠️ 先读：数据安全约定

**本仓库 `github.com/guomengtao/app-auth` 是公开仓库。**

| 目录 | 是否入 git | 内容 |
|---|---|---|
| `docs/analytics/*.md` `*.png` `*.csv` | ✅ **入** | 已脱敏，可公开 |
| `docs/analytics/raw/` | ❌ **不**（已 `.gitignore`） | 原始底稿，含真实 IP/UA、明文兑换码 |

- `.vercelignore` 已排除 `docs` 与 `*.md` → **本目录不会部署到网站**（实测 `/docs/*.md` 返回 404）。
- **禁止**把 `raw/` 下的文件加入 git。若需共享，先按下方规则脱敏。

### 脱敏规则

对 `orders_clean.csv` 与两份报告中的敏感字段做**确定性哈希**（`sha256("ev2026|" + 原值)[:10]`，前缀 `h_`）：

| 字段 | 处理 |
|---|---|
| `user_id` / `user_name` | 哈希（买家标识） |
| `redeem_code` / `activation_code` | 哈希（**明文凭证，绝不可公开**） |
| `device_id` / `activation_device` | 哈希 |
| 报告正文中的 IP | `36.113.xx.xx` 形式掩码前两段后两段 |

**保留未脱敏**：`out_trade_no`、`plan_id`、`plan_title`、`total_amount`、`processed`、`paid_at`、`reason`
等分析必需字段，以及所有聚合结果。

> 哈希是确定性的：同一原始值永远得到同一 `h_xxx`，**仍可做去重与关联分析**，只是无法反推真值。
> 需要照原始值核对时，用本地 `raw/` 下的底稿（不入 git）。

---

## 目录

```
docs/analytics/
├── README-数据说明.md                       本文件
├── 分析报告.md                              主报告（订单 + 访问多维）
├── 用户访问-地域与设备维度补充分析.md        地域/设备维度（Supabase visitor_logs）
├── 01-订单与访问走势.png                    双轴走势
├── 02-访问结构与转化行为.png
├── 03-订单维度分析.png
├── 04-链路量级与星期效应.png
├── 05-网站与App拆分趋势.png
├── orders_clean.csv          (114 行)  脱敏版订单明细
├── vis_daily.csv                        网站侧按天 PV/UV/下载/跳转
├── visitors_real_daily.csv              真实访客按天趋势（已剔除开发机）
├── visitors_geo.csv                     地域明细（国家/省/市）
├── visitors_device.csv                  设备明细（机型/OS）
└── raw/                      ❌ 不入库
    ├── visitor_logs.json    (4,790 行)  Supabase 逐条访问（含真实 IP/UA）
    └── orders_clean_full.csv            订单原始底稿（含明文兑换码）
```

---

## 数据从哪来

两个数据源，**都不能用同一套方法连**：

### 1. Neon（KV 镜像，订单与统计指标）

`kv_strings` / `kv_sets` / `kv_zsets` 三张表是 Upstash KV 的镜像。
**避开坑**：`select * from kv_strings` 全表必超时 → 按 key 前缀分批拉。

| 指标 | 位置 |
|---|---|
| 订单 | `kv_strings.afdian:order:*` |
| 页面 PV | `kv_zsets.stats:pages:<日>`（**27 天全量，用它反推补齐 PV**） |
| UV | `kv_sets.stats:uv:<日>` |
| 下载 / 跳转 | `kv_strings.stats:dl\|go:*` |
| 激活码 / 失败 | `kv_sets.auth:activation_*` |

### 2. Supabase（访问明细）

⚠️ **别用 PG 直连**（`pooler.supabase.com:6543` 会被本机代理 TLS 拦截，怎么配 SSL 都过不了）。
**走 443 的 PostgREST**：

```bash
cd ~/Documents/guomengtao/ev/app-auth
SUPA_URL=$(grep -m1 '^Ev_SUPABASE_URL=' .env.local | cut -d= -f2- | sed 's/^"//; s/"$//')
KEY=$(grep -m1 '^Ev_SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2- | sed 's/^"//; s/"$//')
curl -s "$SUPA_URL/rest/v1/visitor_logs?select=*&order=id.asc" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Range: 0-999"
```

分页用 `Range: 0-999 / 1000-1999 …`（单次上限 1000）。总数用 `Prefer: count=exact` + `Range: 0-0` 看 `Content-Range`。

---

## 复现与核对时必守的口径

1. **先做自流量污染检测**：`visitor_logs` 里单 IP `36.113.xx.xx` 占 **57.3%**，UA 含 `CodeBuddyCN`
   → **开发机/AI 工具自身流量**，必须剔除后再谈趋势（本轮 4,790 → 真实 2,047 / 327 访客）。
2. **别用 PV 讲增长**：PV 易被单 IP 拉高。看唯一 `visitor_hash`，并说明基数（真实访客仅 20–35/天）。
3. **订单金额无分析价值**：113/114 笔本是同一 ¥1 档（真实业务形态，非缺陷）→ GMV ≡ 订单数。
4. **「下载 → 订单」转化率不能算**：下载埋点 09-30 才上线，分母不完整（硬算会得到 134%）。
5. **PV 必须拆分 `/apk/*`（App 内）与网站页**：否则把「App 埋点上线」误读成「用户暴增」。

---

## 关键结论索引（详见两份报告）

- 真实增长看 UV 而非 PV；总 PV 表面 +1349% 是 App 埋点上线 + 开发机流量叠加的假象。
- 订单与网站流量**不相关**（PV 峰值日仅 3 单，PV 低日反而 7 单）→ 订单来自产品内转化。
- 激活失败 285 次 > 激活码发放 195 个，45% 集中在两天，失败码全唯一 → **撞库枚举**特征。
- 地域 CN 占 92%（西安/上海/长沙/嘉兴）；有 1 个都柏林数据中心 IP 属爬虫，应剔除。
