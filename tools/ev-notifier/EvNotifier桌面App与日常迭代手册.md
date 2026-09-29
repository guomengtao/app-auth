# EvNotifier 桌面 App（Mac bundle）与日常迭代手册

> 适用范围：`app-auth/tools/ev-notifier`（Mac 常驻通知客户端）。
> 版本：本手册对应 **v2.3.45**（2026-09-29 落地）。
> 作用：**以后改功能、排查“退出又回来 / 点了没反应 / 双实例”等问题，先看这份**。

---

## 一、现状一览

| 项 | 值 |
|---|---|
| 桌面 App | `/Applications/EvNotifier.app`（约 66MB，ad-hoc 已签名） |
| LaunchAgent | `~/Library/LaunchAgents/com.evnotifier.agent.plist`（标签 `com.evnotifier.agent`） |
| plist 指向 | `/Applications/EvNotifier.app/Contents/Resources/venv/bin/python` + `/Applications/EvNotifier.app/Contents/Resources/ev_notifier.py` |
| 常驻实例 | 单实例、受 launchd 托管（`KeepAlive=true`，崩溃自愈） |
| 构建脚本 | `tools/ev-notifier/build_app.sh` |
| 依赖清单 | `tools/ev-notifier/requirements.txt`（rumps / pywebview / redis / edge-tts） |
| 版本号来源 | `tools/ev-notifier/version.json`（App 标题栏与 `Info.plist` 都读它） |

bundle 结构（正规 `Contents/` 布局，不要再往 bundle 根目录丢文件）：

```
EvNotifier.app/Contents/
├── Info.plist              # LSUIElement=1（不进 Dock/启动台）、版本号取自 version.json
├── MacOS/EvNotifier        # sh 启动器：相对 $0 解析路径 → exec Resources/venv/bin/python
├── Resources/
│   ├── venv/               # bundle 自带虚拟环境
│   ├── ev_notifier.py      # 主脚本（--sync 会覆盖；--link 后为软链）
│   ├── version.json
│   ├── README.md
│   └── EvNotifier.icns
└── _CodeSignature/
```

---

## 二、三条命令（按改动大小选）

在 `tools/ev-notifier/` 目录下执行：

| 场景 | 命令 | 耗时 | 做了什么 |
|---|---|---|---|
| **改功能 / 修 bug**（日常 99%） | `./build_app.sh --sync` | ~2 秒 | 拷贝源码进 bundle → `launchctl kickstart -k` 重启客户端 → 打印最新日志 |
| 想连这一步都省 | `./build_app.sh --link`（设置一次即可） | 0 | bundle 脚本改为软链到仓库源文件，之后改完只需重启客户端 |
| 依赖/图标/版本变了 | `./build_app.sh --install` | ~40 秒 | 完整重建 bundle 并安装到 `/Applications`（venv 有缓存复用） |
| **给别人装 / 换机** | `./build_app.sh --dmg` | ~10 秒 | 产出 `dist/EvNotifier-v{版本}-macos-arm64.dmg`（自持 Python，对方拖 Applications 即用） |
| 只出 portable App 不打 dmg | `./build_app.sh --portable` | ~8 秒 | 产出 `dist/EvNotifier.app`（可直接整个拷走） |

### 可分发版（portable / dmg）说明（v2.3.46）

- 运行时用的是 **python-build-standalone（uv 托管的 CPython 3.12）**，官方设计为可重定位：
  已实测「拷走 + 隐藏原始路径」仍能正常 import ssl/sqlite。**不能用 Homebrew Python** ——
  其 `_ssl/_hashlib/_decimal` 依赖 openssl / mpdecimal 等外部 dylib（`otool -L` 可证）。
- 依赖装进运行时自己的 `lib/python3.12/site-packages`（缓存于 `/tmp/evnotifier-portable-runtime`，
  `requirements.txt` mtime 变化才重装）。uv 运行时带 PEP 668 标记，缓存副本里已删 `EXTERNALLY-MANAGED`。
- 运行时放在 `Contents/Resources/python/` 而**不是** `Frameworks/`：
  codesign 会把 `Frameworks/*` 当嵌套代码扫描，python 目录不是合法 bundle 结构 → 签名报错；
  Resources 只做哈希密封，`codesign --verify --deep --strict` 全绿。
- **换机安装**：dmg 双击 → 拖 EvNotifier.app 到 Applications → 打开（Gatekeeper 未公证，
  首次需右键→打开，或 `xattr -dr com.apple.quarantine /Applications/EvNotifier.app`）→
  写 `~/.ev-notifier.env`（KV_REST_API_URL / KV_REST_API_TOKEN）→ 首次面板登录（Keychain 存 token）。
- ⚠️ **从 dmg 挂载卷里直接跑不会移交 LaunchAgent**（`handover_to_launchd()` 对 `/Volumes/` 路径直接跳过），
  必须先拖进 Applications 再启动，否则重启后卷弹出 App 就没了。
- ⚠️ **PUB/SUB 是广播**：多台机器同时在线，同一条推送会两边都弹窗+语音。要么别同时开，要么做消息定向过滤。

> ⚠️ bundle 里默认是**拷贝**不是软链 —— 改了仓库源码后不 `--sync`（或不 `--link`），App 跑的还是旧代码。
> ⚠️ `--link` 的代价：仓库被挪走或删掉，App 直接打不开。介意就用默认的拷贝模式。

---

## 三、核心机制（改这块代码前必须懂）

### 3.1 退出后不再被自动拉起（v2.3.43）
`quit_app()`：写干净退出标记 → **`stop_launchd_job()`（`launchctl bootout`）** → `NSApp.terminate_`。
只摘本次 job，**plist 保留**，所以「开机自启」偏好不变，下次登录 `RunAtLoad` 照常起来；崩溃自愈也不受影响。

> 刻意没改成 `KeepAlive={"SuccessfulExit": False}` —— 那样会把运维常用的
> `launchctl kickstart -k`（重启客户端的唯一手段）一起废掉。

### 3.2 启动路径自动移交 `handover_to_launchd()`（v2.3.44）
启动早期（拿到 PID 锁之后、`load_env()` 之前）执行，保证**最终只有一个受 launchd 托管的实例**：

1. 15 秒内已尝试过移交 → 跳过（防 bootstrap 失败时的无限退场循环）
2. `auto_start` 偏好为 OFF → 不动 plist
3. 「当前 job 的 PID == 自己」→ 说明自己就是被托管的那个，什么都不做
4. 否则：写 plist（指向当前 `sys.executable` + 当前脚本）→ **延迟 2 秒 bootstrap** → **自己立即退场**（并且**保留 pid 文件**给即将被拉起的新实例）

配套：`ensure_auto_start()` **只写 plist，不再 bootstrap**（见坑 2）。

### 3.3 PID 锁与重实例提示
- 单实例靠 `~/.ev_notifier.pid`：进程存在 → 新实例退出。
- 重复启动不再静默：`notify_macos("Ev Notifier 已在运行")`（双击 App / 又跑一遍脚本时最直观）。

---

## 四、踩过的坑（都是真翻车留下的，别再踩）

1. **`os.getppid() == 1` 不是「被 launchd 拉起」的判据。**
   Finder / LaunchServices 双击启动的进程，父进程同样是 1。用它判断会让 App 实例跳过移交，直接跑成没人托管的野进程。
   ✅ 正解：`launchctl list`（**不带参数**）取到 job 的 PID，与 `os.getpid()` 比对。

2. **进程还活着时绝不能 `launchctl bootstrap`。**
   注册 job 会让 launchd 立刻再拉一个实例 → 抢不到 PID 锁就退出 → `KeepAlive` 再补位 → **秒退秒起的死循环**（stdout 刷屏 `Another instance is already running`）。
   ✅ 所以 `ensure_auto_start()` 只写 plist；注册交给 `handover_to_launchd()` 的「退场后延迟 bootstrap」。

3. **`launchctl list <label>` 打印的是 plist 字典，没有 PID。**
   只有 **无参数** `launchctl list` 才是 `PID\tStatus\tLabel` 行。Python 解析和 shell 都要走这条。

4. **shell 里 `awk -F'\t'` 在 macOS BSD awk 上不稳。**
   ✅ 用默认分隔符：`launchctl list | awk -v l="$LABEL" '$3==l{print $1}'`。

---

## 五、运维命令速查

```bash
G="gui/$(id -u)"; L="com.evnotifier.agent"

launchctl list | awk -v l="$L" '$3==l{print $1}'   # 看当前受托管实例的 PID
launchctl kickstart -k "$G/$L"                     # 重启客户端（日常重启手段↑）
launchctl bootout "$G/$L"                          # 摘掉 job（会让实例退出；plist 保留）
launchctl bootstrap "$G" "$HOME/Library/LaunchAgents/$L.plist"   # 重新注册并启动
open /Applications/EvNotifier.app                  # 双击等价（会触发移交逻辑）
```

日志与状态：

| 路径 | 内容 |
|---|---|
| `~/.ev_debug.log` | 主调试日志（含 `handover` / `takeover` / `signal 15` 等） |
| `~/.ev_notifier_stdout.log` | 标准输出（重实例提示 `Another instance…` 在这） |
| `~/.ev_notifier_state.json` | 版本、PID、`boot_count`、`abnormal_exit_count`、`last_exit_reason` |
| `~/.ev_launch_handover.stamp` | 移交时间戳（防 15 秒内重复尝试） |
| `~/Library/LaunchAgents/com.evnotifier.agent.plist` | 开机自启配置 |

---

## 六、排障清单

| 症状 | 先看 | 大概率原因 |
|---|---|---|
| 改了代码没生效 | 有没有 `--sync`；bundle 里脚本 mtime | bundle 是拷贝，忘了同步 |
| 点了 App 没反应（麦栏没图标） | `~/.ev_debug.log` 最后几行、`Another instance…` | 已有实例在跑（应弹「已在运行」通知） |
| 退出后自己回来 | `quit_app()` 是否走到 `stop_launchd_job()` | plist 的 KeepAlive 与退出逻辑不一致 |
| 进程数 >1 / 日志反复 `Another instance` | `launchctl list` 的 PID 与实际进程 | 有人在活着时 bootstrap → 重启循环（坑 2） |
| App 打不开（一闪而过） | `--link` 模式 + 仓库是否被移动 | 软链失效 |
| 启动即退出（ImportError） | bundle 内 venv 是否装齐、日志里的 import 报错 | 改了 `requirements.txt` 但没 `--install` |

---

## 七、相关文件

| 文件 | 职责 |
|---|---|
| `tools/ev-notifier/ev_notifier.py` | 主程序：`stop_launchd_job()`、`handover_to_launchd()`、`ensure_auto_start()`、`_launchd_job_pid()`、PID 锁、`quit_app()` |
| `tools/ev-notifier/build_app.sh` | 构建 / `--install` / `--sync` / `--link` |
| `tools/ev-notifier/requirements.txt` | bundle venv 依赖（改动后必须完整重建） |
| `tools/ev-notifier/version.json` | 版本号（改功能建议顺手 +1） |
| `tools/ev-notifier/README.md` | 面向使用者的安装与退出说明 |
| `运维手册-换机器与排障.md` | 换机器部署、pid 文件陈旧等历史坑 |

---

## 八、遗留

- 启动自检偶发 `notify_macos EXCEPTION: osascript timed out after 5 seconds`：不影响后续流程，未处理。
