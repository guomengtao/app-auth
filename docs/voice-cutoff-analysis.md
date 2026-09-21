# say 语音播报中断问题分析

## 一、现象

在 evnotifer 设置面板点击"语音播报"的**测试**按钮，`say -v Tingting` 播报的文本始终无法完整播放，在中间位置中断。

### 测试文本

```
语音播报功能正常，这是一条中文语音测试
```

### 中断位置变化记录

| 修复尝试 | 中断位置 | 听到的内容 |
|---------|---------|-----------|
| 原始代码（timeout=5，capture_output=True） | "...这是一" | "语音播报功能正常，这是一" |
| 第一次修复（timeout=30） | "...一条了" | 多听到了"一条了" |
| 第二次修复（Popen，无 timeout，无 capture） | "...这是一条中文" | 又多听到了"中文" |

**规律**：每次改动都让播放多了一点点，但始终没完整。说明改进确实有效，但没有从根本上解决问题。

---

## 二、代码中 say 调用的所有路径

### 路径 1：测试按钮（当前代码）

`tools/ev-notifier/ev_notifier.py` `_test_notify()`:

```python
elif ntype == "voice":
    subprocess.Popen(["say", "-v", "Tingting", "语音播报功能正常，这是一条中文语音测试"])
elif ntype == "visitor_voice":
    subprocess.Popen(["say", "-v", "Tingting", "北京市朝阳区用户访问激活页面"])
```

特点：
- `subprocess.Popen` — 不阻塞，无超时
- 无 `capture_output` — stdout/stderr 继承父进程
- 无 `stdin/stdout/stderr` 显式指定 — 全部继承父进程
- **Popen 对象没有保存到变量** — 函数返回后立即被 GC

### 路径 2：事件语音播报（voice worker）

`tools/ev-notifier/ev_notifier.py` `_voice_worker()`:

```python
def _voice_worker():
    voice_chain = ["Tingting", "Sinji", "Meijia", None]
    while True:
        text = _voice_queue.get()
        if text is None:
            break
        for voice in voice_chain:
            try:
                cmd = ["say"]
                if voice:
                    cmd.extend(["-v", voice])
                cmd.append(text)
                result = subprocess.run(cmd, timeout=30, capture_output=True)
                if result.returncode == 0:
                    break
            except Exception:
                continue
```

特点：
- `subprocess.run` — 阻塞，有 30 秒超时
- `capture_output=True` — stdout/stderr 捕获到管道

### 路径 3：通知弹窗（osascript）

```python
subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)
```

- 也用 `capture_output=True`，但 `osascript` 是同步快速返回的，不受影响

### 路径 4：弹窗通知声音（afplay / terminal-notifier）

```python
subprocess.run(cmd, capture_output=True, timeout=5)
```

- 快速返回，不受影响

---

## 三、关键差异对比

| 属性 | 测试按钮 (Popen) | 事件播报 (voice worker) |
|-----|:----------------:|:---------------------:|
| 调用方式 | `subprocess.Popen` | `subprocess.run` |
| 超时 | 无 | 30s |
| 输出捕获 | 继承父进程 | `capture_output=True` |
| stdin | 继承父进程 | 继承父进程 |
| GC 风险 | 高（Popen 对象立即被丢弃） | 低（result 变量持有引用） |
| 线程 | 主线程 | 守护线程 |

---

## 四、根因分析

### 4.1 capture_output 不是罪魁祸首

第二次修复去掉了 `capture_output`，现象改善但没根治。

### 4.2 超时也不是主因

第一次修复从 5s 改到 30s，第二次直接去掉超时。每次都有改善，但都不是根本解决。

### 4.3 最可能的根因：Popen 对象被 GC + stdin 继承

```python
subprocess.Popen(["say", "-v", "Tingting", "语音播报功能正常，这是一条中文语音测试"])
```

两个问题叠加：

**问题 A：Popen 对象没有保存引用**

`Popen` 返回的对象没有赋值给任何变量，函数返回后引用计数归零。在某些 Python 版本/平台上，`Popen.__del__` 会关闭继承的 stdin/stdout/stderr 管道。即使子进程独立运行，关闭管道也可能给子进程发送信号，中断 `say` 进程。

**问题 B：stdin 继承自父进程**

`Popen` 默认 `stdin=None` 意味着子进程继承父进程的 stdin。父进程是 GUI 应用（pywebview + WKWebView），其 stdin 处于不可预测的状态。

当 Popen 对象被 GC 时：
1. `__del__` 关闭继承的 stdin 管道
2. `say` 进程的 stdin 被关闭
3. `say` 收到信号被中断
4. 播放停止

**这解释了为什么每次改进都"多播放了一点点"**：
- 改超时 → `say` 多活了 N 秒才被 stdin 关闭事件中断
- 去掉 capture → `say` 不再受管道阻塞影响，多活了更久
- 但 stdin 关闭事件最终还是会到达，所以始终无法完整播放

### 4.4 为什么不影响事件播报（voice worker）

```python
result = subprocess.run(cmd, timeout=30, capture_output=True)
```

`subprocess.run` 内部：
1. 创建 Popen 对象
2. 用 `communicate()` 等待进程结束
3. 返回 CompletedProcess 对象

Popen 对象的生命周期由 `subprocess.run` 内部管理，直到 `say` 进程正常结束才返回。stdin 在 `subprocess.run` 内部被正确管理（当 `capture_output=True` 时，`subprocess.run` 内部设置 `stdin=DEVNULL`）。

---

## 五、是否影响其他语音播放？

| 场景 | 调用路径 | 是否有此问题 |
|------|---------|:----------:|
| 新订单语音 | handle_message → enqueue_voice → voice_worker → subprocess.run | 不受影响 |
| 新激活语音 | 同上 | 不受影响 |
| 激活失败语音 | 同上 | 不受影响 |
| 购买点击语音 | 同上 | 不受影响 |
| 页面访问语音 | 同上 | 不受影响 |
| 测试按钮 | _test_notify → subprocess.Popen | 有此问题 |

**结论**：只有测试按钮受影响，实际的业务事件语音播报不受影响。因为业务事件走的是 `_voice_worker` → `subprocess.run` 路径，子进程生命周期管理正确。

---

## 六、推荐修复

让测试按钮也走 voice worker 队列，不再直接调 `say`：

`_test_notify()` 方法改为：

```python
elif ntype == "voice":
    enqueue_voice("语音播报功能正常，这是一条中文语音测试")
elif ntype == "visitor_voice":
    enqueue_voice("北京市朝阳区用户访问激活页面")
```

优点：
- 与业务事件走同一路径，行为完全一致
- 不重复创建进程管理逻辑
- 语音按队列顺序播放，不会相互打断
- subprocess.run 在内部正确管理子进程生命周期