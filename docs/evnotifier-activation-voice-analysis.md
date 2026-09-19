# EvNotifier 激活语音通知分析

> 问题：激活成功没发语音，激活失败却有语音。分析原因及修复方案。

---

## 一、语音播报代码位置

文件：`tools/ev-notifier/ev_notifier.py`，`handle_message()` 函数第 813 行。

语音播报的触发条件：

```python
if nsettings.get("voice", True) and mtype != "page_visit":
```

即：只要 `voice` 设置开启，且不是 `page_visit` 类型，就会语音播报。

---

## 二、激活成功 vs 激活失败的语音代码对比

### 激活成功（new_activation）— 第 819-820 行

```python
elif mtype == "new_activation":
    prod = p.get("product_name", "") or ""
    voice_text = f"新设备激活：{prod}" if prod else "新设备激活"
```

### 激活失败（activation_failure）— 第 822-823 行

```python
elif mtype == "activation_failure":
    prod = p.get("product_name", "") or ""
    voice_text = f"激活失败：{prod}" if prod else "激活失败"
```

### 结论：代码逻辑完全一致，没有区别对待。

两条分支结构相同，都用了 `say -v Tingting` 命令播报（第 831 行）。

---

## 三、服务端推送的 payload 对比

### 激活成功 — `api/activate.js`

```javascript
notify.pushNotification("new_activation", {
    redeem_code: code,
    activation_code: activationCode,
    product_id: productId,      // ← 只有 product_id，没有 product_name
    device_id: device,
    months: months,
    source: "user",
    ip: "...",
    user_agent: "...",
    visitor_info: visitorInfo || {},
    device_info: deviceInfo || {},
});
```

### 激活失败 — `api/activate.js`

```javascript
notify.pushNotification("activation_failure", {
    reason: "...",
    redeem_code: "...",
    device_id: "...",
    source: "user",
    ip: "...",
    user_agent: "...",
    visitor_info: visitorInfo || {},
    device_info: deviceInfo || {},
});
```

### 🔴 关键发现：两份 payload 都缺少 `product_name` 字段

服务端只传了 `product_id`（如 `ev-timetable`），没传 `product_name`（如 `课程表高级版`）。

因此 ev_notifier 中的 `p.get("product_name", "")` 永远返回空字符串。

---

## 四、推论：为什么用户感知"激活失败有语音、激活成功没有"

代码中语音功能对两者**都执行了**，差异在于实际听到的内容：

| 场景 | voice_text | 实际 TTS 输出推测 |
|------|-----------|-------------------|
| 激活成功 | `"新设备激活："`（prod 为空） | 一个带冒号的短句，瞬间说完，用户可能没察觉 |
| 激活失败 | `"激活失败"` | 同样很短，但结合弹窗+提示音更明显 |

**最大可能的原因：**

### 原因 1：文字太短，TTS 瞬间说完

- `"新设备激活："` 和 `"激活失败"` 都只有 6-7 个音节
- macOS `say` 命令对这种极短文本存在已知问题：说完前半段就被系统截断，或者音量渐入还没到最大就已经结束
- 激活失败因为同时有**弹窗红字 + 提示音 + 心理预期（失败更紧急）**，用户更容易注意到；激活成功弹窗是正常提示，语音又短，容易被忽略

### 原因 2：语音名称可能不准确（次要因素）

- 代码第 831 行：`["say", "-v", "Tingting", voice_text]`
- 测试代码第 3412 行：`["say", "-v", "Ting-Ting", "语音播报功能正常..."]`

macOS 中文语音的真实名称是 **`Ting-Ting`**（带连字符），而不是 `Tingting`。

当语音名称无效时，`say` 会 fallback 到系统默认语音。如果默认语音不是中文，可能：
- 完全无法朗读中文 → 无声音
- 用英文腔调读中文 → 发音不准，用户没注意到
- 读出来了但音量太低 → 用户没听到

由于 `_run_and_ignore_timeout` 吞掉所有错误，这种情况下不会有任何报错提示。

### 原因 3：产品名缺失导致语音信息量不足

正常情况下的语音应该是：
- `"新设备激活：课程表高级版"` — 有信息量，一听就知道是什么产品
- `"激活失败：课程表高级版"` — 同上

但因为没有 `product_name`，实际播报内容是：
- `"新设备激活："` — 说了跟没说一样
- `"激活失败"` — 同样缺少信息

---

## 五、修复方案

### 5.1 修复语音名称（推荐优先级：最高）

**文件**：`tools/ev-notifier/ev_notifier.py`，第 831 行

```python
# 改前
threading.Thread(target=lambda: _run_and_ignore_timeout(["say", "-v", "Tingting", voice_text]), daemon=True).start()

# 改后
threading.Thread(target=lambda: _run_and_ignore_timeout(["say", "-v", "Ting-Ting", voice_text]), daemon=True).start()
```

> 注：第 3412 行测试代码已使用 `Ting-Ting`，只改第 831 行即可。

### 5.2 修复服务端 payload 缺少 product_name（推荐优先级：高）

**文件**：`api/activate.js`

在 pushNotification 的 payload 中增加 `product_name` 字段：

```javascript
// new_activation 和 activation_failure 的 pushNotification 中，增加：
product_name: productName,  // 与已有 product_id 同级

// 例：从兑换码数据中获取
var productName = (info.product_name) || "";
```

这样 ev_notifier 的 `prod = p.get("product_name", "")` 就能拿到产品中文名，语音播报变为：
- `"新设备激活：课程表高级版"`
- `"激活失败：课程表高级版"`

### 5.3 语音文本增加 fallback（推荐优先级：中）

**文件**：`tools/ev-notifier/ev_notifier.py`，第 819-823 行

在拿不到 `product_name` 时，用 `product_id` 做简略标识，避免播报内容过短：

```python
elif mtype == "new_activation":
    prod = p.get("product_name", "") or ""
    pid = p.get("product_id", "") or ""
    if prod:
        voice_text = f"新设备激活：{prod}"
    elif pid:
        voice_text = f"新设备激活：{pid}"
    else:
        voice_text = "新设备激活"
elif mtype == "activation_failure":
    prod = p.get("product_name", "") or ""
    pid = p.get("product_id", "") or ""
    reason = p.get("reason", "") or ""
    parts = []
    if prod:
        parts.append(prod)
    elif pid:
        parts.append(pid)
    if reason:
        parts.append(reason[:30])
    voice_text = "激活失败：" + "，".join(parts) if parts else "激活失败"
```

### 5.4 为极短语音增加前置填充（推荐优先级：低）

如果 `say` 命令对极短文本仍不稳定，可在文本前加一个短暂的静音字符或引导词：

```python
voice_text = "通知，" + voice_text  # 加一个引导词，让 TTS 有更多时间进入稳定状态
```

---

## 六、总结

| 项目 | 结论 |
|------|------|
| 激活成功有没有语音代码？ | ✅ **有**，第 819-820 行 |
| 激活失败有没有语音代码？ | ✅ **有**，第 822-823 行 |
| 代码逻辑有区别对待吗？ | ❌ **没有**，结构完全一致 |
| 那为什么用户感觉不一样？ | ① 语音名称可能不对（Tingting → Ting-Ting）② product_name 缺失导致语音内容过短 ③ 极短文本 TTS 不稳定 |
| 推荐的修复顺序 | ① 改语音名称为 `Ting-Ting` ② 服务端补充 `product_name` ③ 客户端增加 fallback |