# Ev Notifier · Mac 原生通知器

菜单栏常驻的 Python 应用，通过 Upstash Redis Pub/Sub 实时接收 Vercel 服务端的订单、激活事件，弹 macOS 系统原生通知。

- **仅菜单栏**：不显示在 Dock 栏，只占用顶部菜单栏一个小图标
- **双击运行**：构建 `.app` 后像普通 Mac 应用一样双击启动
- **零轮询**：基于 Redis 原生 TLS TCP 长连接
- **零延迟**：消息发布后毫秒级到达 Mac
- **零额外费用**：利用现有 Upstash Redis

## 原理

```
Vercel Serverless                  Upstash Redis                Mac 本地
┌──────────────────┐              ┌─────────────┐              ┌──────────────┐
│ activate.js      │──PUBLISH────►│             │              │              │
│ afdian/orders.js │              │ auth:push    │──SUBSCRIBE──►│ ev_notifier  │
│ redeem-codes.js  │              │ _channel     │   (TLS TCP)  │   .py        │
└──────────────────┘              └─────────────┘              └──────┬───────┘
                                                                     │
                                                              ┌──────▼───────┐
                                                              │ macOS 通知   │
                                                              │ + 菜单栏图标 │
                                                              └──────────────┘
```

## 快速开始（推荐：双击运行）

### 1. 安装依赖

```bash
pip3 install rumps --break-system-packages
```

### 2. 配置环境变量

在 `~/.ev-notifier.env` 写入 Upstash Redis 连接信息：

```bash
KV_REST_API_URL=https://your-db.upstash.io
KV_REST_API_TOKEN=your-token-here
```

> 这两项在 Vercel 项目 Settings → Environment Variables 里可以找到。

### 3. 构建桌面 App

```bash
bash tools/ev-notifier/build_app.sh
```

生成 `tools/ev-notifier/EvNotifier.app`。

### 4. 双击启动

在 Finder 中找到 `EvNotifier.app`，双击即可启动。

菜单栏出现 `📦 Ev` 图标，Dock 栏不会显示任何图标。

> 也可以拖入 `/Applications/` 文件夹，像普通 App 一样从启动台打开：
> ```bash
> cp -r tools/ev-notifier/EvNotifier.app /Applications/
> ```

### 退出

点击菜单栏图标 → 退出。

---

## 命令行方式（备选）

如果不需要桌面 App，也可以直接在终端运行：

```bash
python3 tools/ev-notifier/ev_notifier.py &
```

按 `Ctrl+C` 停止。

## 菜单栏功能

| 菜单项 | 功能 |
|--------|------|
| 📦 Ev(数字) | 图标，数字表示本次运行收到的消息数 |
| 查看状态 | 弹窗显示连接状态、今日消息数、上次消息时间 |
| 暂停/恢复 | 暂停通知弹窗（消息仍计数但不出通知） |
| 重置计数 | 清零消息计数和去重缓存 |
| 退出 | 关闭通知器，同时停止网络连接 |

## 通知类型

### 新爱发电订单

```
💰 新爱发电订单
套餐名称 · ¥金额
兑换码: ABCD
时长: 12个月
用户: 用户名
✅ 私信已发送
⏱ 14:32:05
```

### 兑换码已激活

```
🎫 兑换码已激活
产品名 12个月
激活码: XXXX-XXXX-XXXX-XXXX
兑换码: ABCD
设备: A1b2
来源: 用户自助兑换
⏱ 14:35:22
```

### 兑换失败

```
❌ 兑换失败
兑换码已过期
兑换码: ABCD
设备: X1y2
IP: 1.2.3.4
⏱ 14:38:10
```

## 开机自启

### 方式一：登录项（最简单）

1. 系统设置 → 通用 → 登录项与扩展
2. 点 `+`，选择 `EvNotifier.app`
3. 设为在后台打开

### 方式二：launchd（更稳定）

```bash
cp tools/ev-notifier/com.ev.notifier.plist.example ~/Library/LaunchAgents/com.ev.notifier.plist
```

编辑 plist，将 `__SCRIPT_PATH__` 替换为 `ev_notifier.py` 的绝对路径，`__LOG_DIR__` 替换为日志目录。

```bash
launchctl load ~/Library/LaunchAgents/com.ev.notifier.plist     # 加载
launchctl unload ~/Library/LaunchAgents/com.ev.notifier.plist   # 停止
```

## 故障排查

### 启动报错 "not found"

检查是否安装了 `rumps`：
```bash
pip3 list | grep rumps
```

### 一直显示 "📡 连接中..."

1. 确认 `~/.ev-notifier.env` 配置正确
2. 测试网络连通：`nc -zv your-db.upstash.io 6379`
3. 查看日志（如果配置了 launchd）：
```bash
tail -f tools/ev-notifier/ev_notifier.log
```

### 菜单栏图标不出现

macOS 可能隐藏了菜单栏图标（刘海屏 Mac 常见），尝试关闭其他菜单栏应用腾出空间，或用 Bartender 等工具管理。

### 收到消息但不弹通知

检查 macOS 系统设置 → 通知 → 脚本编辑器(Script Editor)，确保允许通知。

## 技术细节

| 项目 | 说明 |
|------|------|
| 语言 | Python 3 |
| GUI 框架 | [rumps](https://github.com/jaredks/rumps) (Ridiculously Uncomplicated macOS Python Statusbar apps) |
| 通信协议 | Redis 原生协议 (RESP) over TLS，非 HTTP |
| 频道 | `auth:push_channel` |
| 去重 | 内存缓存最近 500 条消息 ID (`ts_type`)，避免重复通知 |
| 重连 | 指数退避 1s → 2s → 4s → ... → 30s 上限 |
| 心跳 | 90 秒无数据自动重连 |
| 配置路径 | `~/.ev-notifier.env` / 项目 `.env` / 项目 `.env.local` |