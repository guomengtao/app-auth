# Ev Notifier 语音/弹窗深度分析（第2版）

> 分析日期：2026-09-18
> 问题：提示音真实消息不响、弹窗和语音完全不出来

---

## 一、已验证的事实

### 1.1 已验证可在 ev_notifier 外正常工作的操作

| 操作 | 测试命令 | 结果 |
|------|---------|------|
| `osascript display notification` + 中文 | 终端直接执行 | ✅ rc=0，通知正常弹出 |
| `osascript display notification` + 中文 | Python `subprocess.run` | ✅ rc=0，通知正常弹出 |
| `osascript display notification` + 中文 | Python daemon thread | ✅ rc=0，通知正常弹出 |
| `say "中文语音测试"` | 终端直接执行 | ✅ 正常朗读 |
| `afplay Ping.aiff` | 终端直接执行 | ✅ 播放正常 |

**结论：** `osascript`、`say`、`afplay` 在独立 Python 进程/终端中均完美运行。

### 1.2 设置状态

```json
{ "popup": true, "sound": true, "voice": true }
```

所有通知方式均已开启。`handle_message` 确实会被调用（stderr 中可见 Delivery callback）。

---

## 二、问题根因分析

### 2.1 问题架构图

```
真实消息流程：
  Redis PUB/SUB → redis_loop() [daemon thread]
    → handle_message(msg)
      → if do_popup: notify_macos(title, subtitle, body, sound=do_sound)  ← ⚠️
      → if voice: say voice_text  [daemon thread]

测试按钮流程：
  WebView 点击 → WebNavDelegate [main thread]
    → _test_notify(ntype) [main thread]
      → popup: threading.Thread → notify_macos(...)  ← ⚠️
      → sound: threading.Thread → afplay Ping.aiff   ← ✅
      → voice: threading.Thread → say "语音测试..."   ← ⚠️
```

### 2.2 核心发现：`notify_macos` 静默吞掉所有错误

```python
def notify_macos(title, subtitle, body, sound=False):
    try:
        safe_title = title.replace('"', "'")
        safe_body = (subtitle + "\n" + body).replace('"', "'")
        if sound:
            script = f'display notification "{safe_body}" with title "{safe_title}" sound name "default"'
        else:
            script = f'display notification "{safe_body}" with title "{safe_title}"'
        subprocess.run(["osascript", "-e", script], timeout=3)
    except Exception:
        pass  # ❌ 静默吞掉所有异常，无法定位问题
```

**这个 `except Exception: pass` 是整个问题的核心：**
- 如果 `osascript` 成功（rc=0）但通知不显示 → 无声无息
- 如果 `osascript` 失败（rc≠0）→ `subprocess.run(check=False)` 不抛异常 → 无声无息
- 如果 `osascript` 超时 → `TimeoutExpired` 被捕获 → 无声无息
- 如果构造 script 时出错 → 被捕获 → 无声无息

### 2.3 为什么测试提示音能响，但真实消息提示音不响？

**这是最大的线索！**

| 场景 | 声音产生方式 | 工作机制 |
|------|-------------|---------|
| 测试按钮-声音 | `afplay /System/Library/Sounds/Ping.aiff` | **独立的**音频播放器，直接调用 CoreAudio |
| 真实消息-声音 | `osascript display notification ... sound name "default"` | **依赖**通知中心系统声音 |

测试声音使用 `afplay` 直接播放音频文件 → 不依赖通知系统 → ✅ 总是能响。

真实消息的声音是 `osascript display notification ... sound name "default"`，声音是通知的附属品。**如果通知本身没弹出来，声音也不会播放。**

### 2.4 为什么弹窗从不出现？（最可能的根因）

`osascript display notification` 在以下情况会静默失败：

1. **进程没有通知权限**：macOS 要求发送通知的进程有用户授权。Python/rumps 进程可能不在"允许通知"的列表中。

2. **`osascript` 没有与窗口服务器连接**：后台 daemon 线程中调用的 `osascript` 可能无法连接到 macOS 的窗口服务器（WindowServer），导致 `display notification` 被系统忽略。

3. **通知被系统抑制**：如果用户在"系统设置 → 通知"中禁用了"脚本编辑器"或"终端"的通知，`osascript` 的通知会被静默丢弃。

4. **Focus/勿扰模式**：macOS 的专注模式会静默丢弃通知。用户可能在不知情的情况下开启了。

### 2.5 为什么语音从不出现？

`say` 命令同样包装在 `threading.Thread` 中。如果 `say` 失败：
- 子进程可能找不到合适的语音引擎（中文需要 Ting-Ting 或其他中文语音）
- `subprocess.run(say, timeout=3)` 在 Python 3.14 中，如果语音合成未完成就超时，`TimeoutExpired` 会导致线程崩溃
- stderr 中目前**没有看到 `say` 的错误**，说明要么 `say` 执行了，要么线程创建失败了

### 2.6 stderr 中的关键线索

```
subprocess.TimeoutExpired: Command '['afplay', '/System/Library/Sounds/Ping.aiff']' timed out after 2 seconds
```

`afplay` 被调用后**超时**了。这说明：
- ✅ 线程正确创建
- ✅ 子进程正常启动
- ❌ 但子进程没有在 2 秒内退出

可能原因：`afplay` 在等待音频设备释放，而音频设备被其他进程占用（可能与 `say` 竞争）。

---

## 三、根因确认

### 3.1 `terminal-notifier` 明确报错

```bash
$ terminal-notifier -title "test" -message "hello"
Could not request notification permission: Notifications are not allowed for this application
rc=3
```

**这是确定性的证据：macOS 拒绝了通知权限。**

### 3.2 完整问题链

```
handle_message(msg)
  → notify_macos() → terminal-notifier → macOS 拒绝 → rc=3
  → osascript display notification → rc=0 → 通知中心接收但静默丢弃（无权限）
  → 声音（afplay）→ ✅ 不依赖通知权限，正常播放
  → 语音（say）→ 语音名拼写错误 Ting-Ting → Tingting
```

### 3.3 为什么 osascript rc=0 但通知不显示？

`osascript display notification` 返回 rc=0 只表示 AppleScript 语法正确并成功提交到通知中心。**macOS 通知中心在接收后，如果进程没有授权，会静默丢弃通知**，不报任何错误。这是 macOS 的设计行为。

`terminal-notifier` 主动检测权限并报错 rc=3，所以能看到真实原因。

### 3.4 为什么提示音测试能响但真实消息不行？

| 来源 | 机制 | 权限依赖 |
|------|------|---------|
| 测试提示音 | `afplay Ping.aiff` → 直接播放音频 | 无 |
| 真实消息提示音 | 之前依赖 `osascript ... sound name "default"` | 需要通知权限 |

**已修复**：将真实消息提示音改为独立的 `afplay`，不再依赖通知系统。

### 3.5 为什么语音不工作？

`say -v "Ting-Ting"` → **拼写错误**，正确名称是 `Tingting`（无连字符）。这导致 `say` 找不到语音而失败。

**已修复**：改为 `say -v "Tingting"`。

### 3.1 紧急：给 `notify_macos` 增加调试日志

在修复前必须先确认 `notify_macos` 是否被成功调用：

```python
def notify_macos(title, subtitle, body, sound=False):
    try:
        safe_title = title.replace('"', "'")
        safe_body = (subtitle + "\n" + body).replace('"', "'")
        safe_body = safe_body.replace("\\", "\\\\")  # 转义反斜杠
        if sound:
            script = f'display notification "{safe_body}" with title "{safe_title}" sound name "default"'
        else:
            script = f'display notification "{safe_body}" with title "{safe_title}"'
        r = subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)
        _debug_log(f"notify_macos: rc={r.returncode} stdout={r.stdout[:100]} stderr={r.stderr[:100]}")
    except Exception as e:
        _debug_log(f"notify_macos FAILED: {e}")
```

### 3.2 备选方案：终端通知（Terminal-notifier）

如果 `osascript display notification` 确实在 rumps 环境中无法工作，可以改用 `terminal-notifier`：

```bash
brew install terminal-notifier
```

```python
subprocess.run(["terminal-notifier", "-title", title, "-message", subtitle + "\n" + body, "-sound", "default"])
```

`terminal-notifier` 是专门为命令行/脚本设计的通知工具，有独立的 bundle identifier，可以单独获取通知权限。

### 3.3 备选方案：AppScript dialog

```python
osascript -e 'display dialog "新订单\n用户xxx\n金额CNY100" with title "Ev Notifier" buttons {"确定"} default button "确定" giving up after 10'
```

`giving up after N` 可以让对话框在 N 秒后自动消失，避免永久阻塞。

### 3.4 声音修复

对于声音，应该**始终使用 `afplay` 直接播放**，不依赖 `display notification` 的声音参数：

```python
if nsettings.get("sound", True):
    threading.Thread(target=lambda: subprocess.run(["afplay", "/System/Library/Sounds/Ping.aiff"], timeout=3), daemon=True).start()
```

### 3.5 语音修复

语音 `say` 应指定中文语音：

```python
subprocess.run(["say", "-v", "Ting-Ting", voice_text], timeout=5, ...)
```

---

## 四、当前状态 vs 目标

| 功能 | 当前 | 目标 |
|------|------|------|
| 真实消息弹窗 | ❌ 从不出现 | ✅ macOS 通知中心横幅 |
| 测试弹窗 | ❌ 从不出现 | ✅ macOS 通知中心横幅 |
| 真实消息提示音 | ❌ 不响（依赖通知） | ✅ 独立 afplay 播放 |
| 测试提示音 | ✅ 能响（afplay） | ✅ 保持 |
| 真实消息语音 | ❌ 从不出现 | ✅ 中文语音播报 |
| 测试语音 | ❌ 从不出现 | ✅ 中文语音播报 |