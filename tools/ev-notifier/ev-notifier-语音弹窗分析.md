# Ev Notifier 语音/弹窗问题分析

> 分析日期：2026-09-18

---

## 一、卡顿/死机/转圈原因

### 根因：主线程阻塞

所有 `_test_notify` 方法的调用都在 **WebKit 导航委托线程**（等价于 UI 主线程）上执行，因为 `webView_decidePolicyForNavigationAction_` 是 WebKit 在主线程上的回调。

```python
# WebNavDelegate 中的调用链路：
webView_decidePolicyForNavigationAction_  ← WebKit 主线程
  → self._dashboard._test_notify(ntype)
    → subprocess.run(["osascript", "-e", 'display dialog ...'], timeout=3)  # ❌ 阻塞！
    → subprocess.run(["say", "..."], timeout=3)                             # ❌ 阻塞！
    → subprocess.run(["afplay", "..."], timeout=2)                          # ❌ 阻塞！
```

### 具体问题

| 问题 | 原因 | 影响 |
|------|------|------|
| `display dialog` | osascript 的 dialog 是模态的，会阻塞直到用户点击"确定" | WebView 整个 UI 线程被挂起，出现彩虹转圈 |
| `say` 中文语音 | `subprocess.run(say, timeout=3)` 同步等待直到语音播报完成 | 最长阻塞 3 秒，中文语音合成更慢 |
| `afplay` 提示音 | 同上，同步等待音频播放完成 | 最长阻塞 2 秒 |

**结论：** 测试按钮直接在 WebKit 主线程上执行 `subprocess.run()`，任何耗时的同步操作都会导致 UI 卡死。

---

## 二、语音播报问题

### 问题 1：英文播报

语音播报的逻辑：
```python
if mtype == "new_order" and user_name:
    voice_text = f"收到新订单，用户{user_name}，金额{amount_str}"   # ✅ 已改为中文
else:
    voice_text = f"{title}, {subtitle}".replace("[", "").replace("]", "")
    # ❌ title/subtitle 是英文："Page Visit", "Activation Failed", "New Order"...
```

所有**非订单消息**的 `title` 和 `subtitle` 都是英文常量，例如：
- `"Page Visit"` / `"IP: 1.2.3.4"`
- `"Activation Failed"` / `"Invalid code"`
- `"Test"` / `"curl test"`

这些直接拼接成英文语音文本，`say` 命令会直接用英文发音。

### 问题 2：仅订单有播报（误判）

实际上**所有消息类型都会进入语音播报**（只要 `voice` 开关开启），因为 `else` 分支处理了其他类型。但用户感觉只有订单有播报，原因可能是：

1. 其他类型的语音是英文，用户没意识到那是语音播报
2. 中文环境下的 `say` 命令遇到英文文本发音很轻/很快，不易察觉

### 问题 3：语音对中文的支持

`say` 命令默认使用系统语音。在中文 macOS 上默认可能是 "Ting-Ting" 中文语音，但遇到英文文本时：
- 会尝试用英文发音
- 英文 + 中文混读效果差
- 切换语音需要指定 `-v` 参数

---

## 三、弹窗通知问题

### 问题 1：弹窗不弹出（日常消息）

`notify_macos()` 使用 `display notification`：
```python
osascript -e 'display notification "xxx" with title "xxx"'
```
这不是真正的弹窗，而是 **macOS 通知中心横幅**：
- 出现在右上角
- 2-3 秒自动消失
- 如果开启了"勿扰模式"完全不显示
- 用户容易错过

### 问题 2：测试弹窗导致闪退

测试按钮的是用 `display dialog`：
```python
osascript -e 'display dialog "xxx" with title "xxx" buttons {"确定"}'
```
这是在 WebKit 主线程上同步调用，导致：
1. 对话框弹出 → WebView 主线程被阻塞 → 彩虹转圈
2. 用户点击"确定"→ 对话框关闭 → 线程恢复
3. 如果对话框和 WebView 的窗口模态逻辑冲突 → 闪退

### 问题 3：弹窗感觉在面板内部

`osascript` 的 `display dialog` 默认是**独立 macOS 窗口**，不是 WebView 内部的内容。但由于 WebView UI 线程被阻塞：
- WebView 无法重绘
- 看起来像是面板"卡住"了
- dialog 在前面，面板在后面变灰，用户误以为 dialog 是面板的一部分

---

## 四、架构问题总结

### 关键瓶颈

```
WebKit 主线程（NSRunLoop）
├── 页面渲染
├── URL 导航处理（webView_decidePolicyForNavigationAction_）
├── 设置切换
└── 测试通知 ← 同步执行 subprocess，阻塞 UI
```

### 根因一览

| 问题 | 根因 | 修复方向 |
|------|------|---------|
| 卡顿转圈 | 主线程同步执行 `say`/`afplay`/`osascript` | 改用 `threading.Thread` 异步执行 |
| 语音英文 | `title`/`subtitle` 是英文常量 | 将英文标题映射为中文语音文本 |
| 弹窗不弹 | `display notification` 是通知中心横幅 | 和"弹窗"预期不符，需改用 `display dialog` 或说明机制 |
| 测试闪退 | `display dialog` 在主线程阻塞 UI | 异步执行，或仅用 `display notification` |
| 面板内弹窗 | dialog 模态框让 WebView 失去响应 | 同上 |

### 内存/性能开销分析

| 操作 | CPU | 内存 | 耗时 |
|------|-----|------|------|
| `say` 中文语音 | 中等（语音合成） | ~20MB | 0.5-3s |
| `afplay` 音频 | 低 | ~2MB | 0.5-2s |
| `osascript display notification` | 极低 | 忽略 | 0.1s |
| `osascript display dialog` | 极低 | 忽略 | 阻塞直到用户操作 |

语音合成是唯一有实际开销的操作，但已用 `Thread(target=lambda: ...).start()` 异步执行。问题是**测试按钮**没有异步化。

---

## 五、修复建议

### 紧急修复（避免卡顿）

所有 `_test_notify` 中的 `subprocess.run()` 改为线程异步执行：

```python
def _test_notify(self, ntype):
    if ntype == "popup":
        threading.Thread(target=lambda: notify_macos("测试通知", "弹窗通知功能正常", "这是一条测试弹窗消息"), daemon=True).start()
    elif ntype == "sound":
        threading.Thread(target=lambda: subprocess.run(["afplay", "/System/Library/Sounds/Ping.aiff"], timeout=2), daemon=True).start()
    elif ntype == "voice":
        threading.Thread(target=lambda: subprocess.run(["say", "语音播报功能正常"], timeout=3), daemon=True).start()
```

### 语音中文化

在 `handle_message` 中添加中文语音映射表：

```python
VOICE_MAP = {
    "new_order": lambda p: f"收到新订单，用户{p.get('user_name','')}，金额...",
    "page_visit": lambda p: f"有新的页面访问：{p.get('page','')}",
    "activation_failure": lambda p: f"激活失败：{p.get('product_name','')}",
    "test_curl": lambda p: "收到测试消息",
}
```

### 弹窗说明

目前的 `notify_macos()` 使用的是 `display notification`（通知中心横幅），这是 macOS 的标准通知方式。如果需要真正的模态弹窗，应使用 `display dialog`，但必须在**子线程**中调用，不能阻塞 WebKit 主线程。

---

## 六、当前状态快照

| 功能 | 状态 | 备注 |
|------|------|------|
| 弹窗通知（通知中心） | ✅ 正常工作 | `display notification` 异步 |
| 弹窗通知（模态框） | ⚠️ 测试可用但卡 UI | `display dialog` 同步阻塞 |
| 提示音 | ✅ 正常工作 | 子线程异步 |
| 语音播报-订单 | ✅ 中文已修复 | 子线程异步 |
| 语音播报-其他 | ❌ 仍是英文 | 需添加中文映射 |
| 测试按钮-弹窗 | ❌ 卡顿/闪退 | 主线程 `display dialog` |
| 测试按钮-提示音 | ❌ 卡顿 | 主线程 `afplay` |
| 测试按钮-语音 | ❌ 卡顿 | 主线程 `say` |