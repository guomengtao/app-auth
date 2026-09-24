# EV 课程表同步器「能启动 EV、但读不到数据」原因分析

> 分析对象：AstroBox 插件 `ev-schedule-sync`（`tools/ev-schedule-sync/astrobox-build/astrobox-plugin/`）
> 版本轨迹：问题发生在 **v1.0.55**；修复落在 **v1.0.56**（死锁/假等待/版本号）与 **v1.0.57**（信封解包/空洞成功/解析容错）
> 分析依据：用户提供的运行日志 + 插件源码 + WIT 接口定义 + `docs/EV课程表 同步对接协议文档.md`
> 日期：2026-09-24

---

## 零、结论速览

| 问题 | 结论 |
|---|---|
| AstroBox 平台**是否支持**读手环数据？ | **支持**。WIT 层有完整的双向能力：`register-interconnect-recv`（订阅回包）+ `interconnect-message`（事件回调）。见「五、证据索引」 |
| 手环上 EV 支持不支持？ | **支持**。`payloadHex` 解出来，`ping` / `export` / `update_settings` 三条回包**全部**严格符合协议 v1（见「零之五」）。EV 侧无需任何改动 |
| 那到底为什么读不到？ | **插件自己把回包认错了**：宿主 `on_event` 给的是**事件信封**（`{"addr","payloadHex","payloadText"}`），插件却把它当业务报文解析 → 三层解析器全部"解析成功但字段全空" → 最后落进 "basic 回包" 分支。数据一直在回，只是从没被解出来 |
| 为什么会瞒这么久？ | 两个 bug 叠加：① 死锁（回包一到就卡死在 `[RX]` 日志那行，见「零之四」）；② `parse_basic_response` 的**空洞成功**（字段全 `Option` + serde 忽略未知字段 → 任何 JSON 对象都"成功"），把 ① 的错误伪装成"收到 basic 回包" |
| 现在状态 | 死锁 **v1.0.56 已修**；信封解包 + 空洞成功 **v1.0.57 已修**。复测预期见「零之五」末尾 |

**一句话**：平台支持、EV 支持、通道一直是通的 —— 从头到尾都是插件在自说自话。

---

## 零之二、实测反馈与结论修正（2026-09-24 更新）

> 用户实测：**点插件里的启动按钮，手环上 EV 课程表能立即打开** —— 该点已核实。

| 项 | 原判断 | 修正后 |
|---|---|---|
| `launch-qa` 是否"假成功" | 列为头号嫌疑（R1） | **已排除**：手环确实被拉起，EV 能立即打开 |
| 那还剩什么 | — | 焦点从"EV 起没起来"转移到 **「消息有没有送进 EV 的处理函数」** 与 **「EV 有没有回、回了有没有派发回插件」** |
| R1 的残留意涵 | 整个 R1 | 只保留一个子情形：**EV 是被"热唤起"（已在运行，走 `onShow` 而非 `onCreate`）**，此时它的接收器是不是仍然有效/已注册，**仍然未知**。能立即打开 ≠ 一定重新跑过 `onCreate` |

**修正后的嫌疑排序**：

| 排名 | 候选 | 为什么现在它排前面 |
|---|---|---|
| 1 | **R2** 手环上 EV 版本较老，不认识 `action:"ping"/"export"` | 启动已排除后，这是"EV 收到但不回/不回包"最直接的解释 |
| 2 | **R7**（新增）插件只在启动后 1.5s 发**一次** ping，且**不重试** | EV 冷启动 >1.5s 时第一条必丢；后续手动 ping 是"再发一次"，但如果那次 EV 又没在前台就还是丢 |
| 3 | **R4** "等 300ms"是空操作，注册后立即发送 | 若宿主注册是异步生效的，回包会被路由丢弃（代码注释自己担心的竞态） |
| 4 | **R6** 宿主侧 `interconnect-message` 派发条件不明 | 需要反向实验才能定性（见下） |
| 5 | **R1-残余** 热唤起后接收器状态未知 | 需要 EV 侧确认注册写在哪 |

**因此下一步的关键实验不是再点 Ping，而是把方向反过来测**（原 SOP 的 S1 已被用户实测覆盖）：

| 新步骤 | 操作 | 判定 |
|---|---|---|
| **S1′（决定性）** | 让 **EV 侧主动发一条消息给插件**（EV 界面上任何会触发它 `send` 的入口，例如其自身的同步/分享/测试功能），观察插件日志是否出现 `[event] EventType::InterconnectMessage` | 出现了 → **通道可用，问题 100% 在"插件→EV"方向或 EV 的处理分支**（指向 R2）；没出现 → **问题在宿主派发/插件订阅**（指向 R4/R6），与 EV 的业务逻辑无关 |
| **S2′** | 手环上停在 EV 界面不熄屏，手机端**连续点 3~5 次** Ping（而不是只点一次） | 若"点多几次里有某次通了" → 就是 R7 的启动窗口 + 无重试问题 |
| **S3′** | 用最小 HelloWorld 插件（只 register + 打印所有事件）复测 | 它能收到 → 宿主没问题；它也收不到 → 提 AstroBox/EV 侧 issue |

---

## 零之三、实测日志 #2 分析（2026-09-24 第二轮）

### 新增事实

```
[UI] click: btn-launch-ev      → launch-qa => Ok(())        ← 手动启动，无自动 ping
[UI] click: btn-read-from-device
[TX] 注册后等待 300ms 完成 / register=Ok(()) send=Ok(()) msg={"action":"export"}   × 多次，全部无回包
[event] Timer payload="interconnect-ready" timerId 2 / 3 / 4 / 5                  ← 死 timer 持续累积
```

仍然是 **0 条 `EventType::InterconnectMessage`**。

### 这一轮排除掉的

| 假设 | 为什么被排除 |
|---|---|
| R7「1.5s 启动窗口太短」 | 用户**手动启动 EV 后立刻再读**，仍然失败；且 export 共发了 **5+ 次**、间隔跨越数十秒，如果只是时机问题总该有一次撞上 |
| 「只发一次不重试」 | 用户实际上已经手动重试了多次，等价于重试实验，仍然 0 回包 |
| 「launch 无效」 | 上一轮已实测排除 |

### 这一轮新发现的代码问题（都在插件侧）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| C1 | **手动启动分支没有自动 ping**：`btn-launch-ev` 只调 `launch_ev_app`，**不设 `auto-ping-after-launch` timer**（只有"选设备"流程会设） | `src/lib.rs:821-852` vs `:1046-1054` | 用户手动启动后必须自己记得点 Ping，体验不一致，也掩盖问题 |
| C2 | **死 timer 累积**：每次 ping/export 都 `set_timeout(300, "interconnect-ready")`，payload 无人消费 | `src/lib.rs:544-548` / `779-784` | 日志噪音，且误导排错（见「一、日志逐行解读」） |
| C3 | `PLUGIN_VERSION = "1.0.54"` 与 `manifest.json` 的 `1.0.55` **不一致** | `src/lib.rs:39` | 代码/界面显示版本与实际安装版本对不上，远程排错时容易误判 |

### 结论收窄

至此，"时机/重试/是否能启动"这三类假设全部排除。剩下只有两个方向：

```
方向 A：EV 收到了但没回（或它的 send 没到手机）   → EV 侧问题
方向 B：EV 根本没收到                             → 下发通道问题
```

**而区分 A/B 有一个零改代码的办法：用 `import` 做下行通道验证。**

理由：`import` 是协议里**最古老、必被支持**的能力（文档 §1 明确「不带 action 的报文一律按 import 处理（保证旧版插件可用）」），而 `ping` / `export` 是协议 v1 才定义的新能力。所以：

| 实验 | 操作 | 判定 |
|---|---|---|
| **E1（首要）** | 插件导入页粘一个**只有 1 门课**的 JSON → 点「导入到手环」（走 `{"action":"import",…}`）→ **看手环上 EV 课表是否真的多了这门课** | **课表变了** → 下行通道通、EV 在收 → **锁定方向 A 且 R2 成立：手环上 EV 版本不支持 `ping`/`export`**，读数据在当前版本上走不通，需要 EV 侧补实现/升级<br>**课表没变** → 方向 B：`send_qaic_message` 返回 Ok 但实际没送达 EV，问题在下发通道（宿主↔手环），与回包/注册无关 |
| **E2** | 一只手让手环停在 EV 界面**持续点亮不熄屏**，另一只手在手机上**立即**点 Ping（1 秒内） | 通了 → 是「手环息屏/回桌面后 EV 被挂起」+ 未开 `resident` 的问题（R3） |

> E1 的价值：`import` 不依赖任何回包就能看到结果（课表变了就是变了），**这是整条链路上唯一一个"肉眼可见的成功信号"**。做完 E1，A/B 立刻分家，不必再猜。

---

## 零之四、第三轮实测：点「导入到手环」直接卡死 —— 插件自身死锁（**已修复 v1.0.56**）

### 现象

按 E1 去点「导入到手环」后：**没反应、日志不动**（连 `[UI] click: xxx` 都不再新增，后续任何点击都无效）。

### 根因（插件自己的 bug，与 EV / 平台无关）

`STATE` 是一把**不可重入**的 `Mutex`，而 `push_log()` 内部也要 `STATE.lock()`：

```rust
// src/lib.rs（修复前）export-ev-btn 分支
let mut state = STATE.lock().unwrap();          // ← 第一次 lock，守卫活到本块结束
state.export_result = json;
state.last_response.clear();
push_log(format!("[TX] import send={:?}", send_result));  // ← 里面又 lock 一次 → 永久死锁
state.status_message = ...;                     // ← 守卫仍在用，说明还持有
```

wasm 单线程里没有任何人会释放那把锁 → 宿主调用**永不返回** → 此后**所有事件（含 Timer）都不再派发**，表现就像"插件死了"。

### 同类问题共 **8 处**（修复前行号）

| 位置 | 数量 | 触发场景 |
|---|---|---|
| `handle_device_message()` | 6（`303/324/385/392/401/407`） | **回包到达时** |
| `export-ev-btn`（导入到手环） | 1（`1238`） | 点一下即卡死 |
| `export-sg-btn` | 1（`1291`） | 点一下即卡死 |

> ⚠️ **这条是本次排查里最重要的发现之一**：即使手环回了包，插件也会在 `push_log("[RX] 收到回包 len=…")` 那一行**当场死锁**，日志上表现为"什么都没发生" —— 与"根本没收到回包"**完全一样的表象**。也就是说：在修掉这个死锁之前，所有"读不到数据"的结论都不可靠。

### 修复内容（v1.0.56）

| # | 改动 | 说明 |
|---|---|---|
| 1 | 新增 `push_log_locked(&mut PluginState, msg)`，8 处死锁改用该版本 | `push_log()` 保留给"未持锁"的上下文；两者都加了醒目注释说明何时用哪个 |
| 2 | `btn-launch-ev` 手动启动后补 `set_timeout(1500, "auto-ping-after-launch")` | 修 C1：手动启动分支原先不会自动 ping，行为与"选设备"流程不一致 |
| 3 | 删除两处 `set_timeout(300, "interconnect-ready")` 及"注册后等待 300ms 完成"日志 | 修 C2：它是空操作（异步立即返回 + payload 无人消费），日志是假的、误导排错；已在代码里留注释说明"真要等必须改用 timer + on_event 模式" |
| 4 | `PLUGIN_VERSION` 与 `manifest.json` 同步到 `1.0.56` | 修 C3：原为 `1.0.54` vs `1.0.55` 不一致 |

构建产物：`dist/EV-Schedule-Sync-v1.0.56.abp`（444K，`scripts/build_abp.sh`）。

### 复测步骤（重点看前两步）

1. 装上 `EV-Schedule-Sync-v1.0.56.abp`；
2. 点「导入到手环」（1 门课即可）→ 日志**应当出现** `[TX] import send=Ok(())`，**不再卡死**；
3. 看手环 EV 课表是否真的多了那门课 → 按「零之三」E1 的判定表分 A/B；
4. 再点 Ping / 读：**如果回包真的来了**，现在也会打印 `[RX] 收到回包 len=…`（之前会被死锁吞掉）；

### 零之四续：复测结果 —— 死锁修掉后，**回包立刻出现了**

装 v1.0.56 后第一次点「读」，日志立刻变成：

```
[TX] register=Ok(()) send=Ok(()) msg={"action":"export"}
[event] EventType::InterconnectMessage payload={"addr":"3333238b-…","payloadHex":"7b226f6b223a…","payloadText":"…"}
[RX] 收到回包 len=10369
[RX] 收到 basic 回包（import/update_settings）      ← ❌ 分支走错了
```

**回包一直都在，只是被死锁吞掉了。** 这一条直接推翻了此前所有"收不到回包"的判断。

---

## 零之五、真因揭晓：宿主事件信封没解包 + basic 解析"空洞成功"（**已修复 v1.0.57**）

### 证据：回包内容完全合法

把日志里的 `payloadHex` 解出来（三条都实测解过）：

| 动作 | 解出的报文（前缀） |
|---|---|
| export | `{"ok":true,"action":"export","version":1,"scopes":…` → 后面还有 `"data":{…}`（总长 10369） |
| ping | `{"ok":true,"action":"ping","pong":true,"versionNa…` |
| update_settings | `{"ok":true,"action":"update_settings"}` |

**与《EV课程表 同步对接协议文档》v1 完全一致** —— 也就是说：

- ✅ 手环上 EV **认识并正确响应** `ping` / `export` / `update_settings`（R2「EV 版本不支持」**排除**）
- ✅ 宿主**一直在把回包派发给插件**（R6「宿主不派发」**排除**）
- ❌ 是插件自己把回包认错了

### Bug 1（主因）：把**宿主的信封**当成了业务报文

`on_event(InterconnectMessage, payload)` 给的 payload **不是**业务 JSON，而是宿主的事件对象：

```json
{"addr":"3333238b-004e-58ff-d3d9-65e1a2e73f04",
 "payloadHex":"7b226f6b223a747275652c…",
 "payloadText":"{\"ok\":true,…}"}
```

而 `handle_device_message()` 直接把这个信封喂给 `parse_ping/export/basic`：

| 解析器 | 对信封的结果 |
|---|---|
| `parse_ping_response` | 反序列化"成功"（字段全 `Option`），但 `pong` 为 `None` → 跳过 |
| `parse_export_response` | 反序列化"成功"，但 `action` 为 `None` → 不走 export 分支 |
| `parse_basic_response` | 反序列化"成功"（同理）→ **落到"收到 basic 回包"** |

三层都"成功"、三层都错，最后落在一个看起来无害的分支上 —— 于是日志显示"收到 basic 回包"，UI 显示"手环已确认"，实际什么数据都没解析出来。

### Bug 2（放大器）：`parse_basic_response` 是**空洞成功**

```rust
#[derive(Deserialize, Default)]
pub struct BasicResponse { ok: Option<bool>, count: Option<u32>, reason: Option<String> }
// serde 默认忽略未知字段 + 全部 Option → 任意 JSON 对象都能 from_str 成功
```

所以任何解析不出来的东西都会"成功"变成 basic 回包 → **把 Bug 1 完全掩盖了**，让"通道不通"这个假象维持了整整几轮排查。

### 修复内容（v1.0.57）

| # | 改动 | 位置 |
|---|---|---|
| 1 | 新增 `protocol::decode_event_payload()`：`payloadText` → `payloadHex`（hex 解码）→ 原样兜底；`handle_device_message` 先解信封再用 | `protocol.rs` / `lib.rs` |
| 2 | 新增 `hex_to_utf8()`（手写 hex 解码，不引依赖） | `protocol.rs` |
| 3 | `parse_basic_response()` 强制要求存在 `ok` 字段，否则返回 Err | `protocol.rs` |
| 4 | export / ping 的数值与布尔字段改为 `serde_json::Value` + `json_u32` / `json_bool` / `json_string` 容错（避免一个类型不符就让整包解析失败） | `protocol.rs` |
| 5 | 新增「看起来是 export 但解析失败」的独立诊断分支，不再静默落到 basic | `lib.rs` |
| 6 | `[RX]` 日志打印**解码后的原文**（截断 200 字）+ 信封长度，以后排错一眼可见 | `lib.rs` |

构建产物：`dist/EV-Schedule-Sync-v1.0.57.abp`（453K）。

### 复测预期（v1.0.57）

| 操作 | 期望日志 |
|---|---|
| Ping | `[RX] 收到回包 len=…；原文：{"ok":true,"action":"ping","pong":true,"versionName":…}` + `[RX] ping 回包解析成功（通道双向通）` + 界面显示手环 EV 版本号 |
| 读（export） | `[RX] export 回包解析成功（已填充昵称/版本/课程）` + 界面显示「读到 N 门课程，昵称：xxx」 |
| 改昵称 | `[RX] 收到 basic 回包（import/update_settings）` + 界面「手环已确认」 |

---

## 一、日志逐行解读

```
[init] 插件已加载
[UI] click: btn-goto-select-device
[UI] click: btn-refresh-devices
[UI] click: btn-pick-device-3333238b-004e-58ff-d3d9-65e1a2e73f04
[REG] 已在选设备时预注册 interconnect: Ok(())
[连接] 已连接 EV 课程表：设备=Xiaomi Smart Band 10 Pro 3ADC（3333238b…），连接=在线，EV状态=已安装，
       检测EV=Ev课程表/com.application.watch.classschedule，插件用EV包名=com.application.watch.classschedule，应用数=24
[WAKE] 启动 EV 课程表 launch-qa => Ok(())
[WAKE] 已请求启动 EV 课程表，1.5s 后自动 ping
[event] EventType::Timer payload={"kind":"timeout","payload":"auto-ping-after-launch","timerId":1}
[WAKE] 延时到，自动 ping EV 课程表
[TX] 向 3333238b… 发起 ping 探针
[TX] ping register=Ok(()) send=Ok(()) msg={"action":"ping"}
[event] EventType::Timer payload={"kind":"timeout","payload":"interconnect-ready","timerId":2}
[UI] click: btn-tab-settings
[UI] click: btn-read-from-device
[TX] 向 3333238b… 发起 export 读取
[TX] 注册后等待 300ms 完成
[TX] register=Ok(()) send=Ok(()) msg={"action":"export"}
[event] EventType::Timer payload={"kind":"timeout","payload":"interconnect-ready","timerId":3}
```

| 日志行 | 实际含义 | 常见误读 |
|---|---|---|
| `[REG] 预注册 interconnect: Ok(())` | 插件已向宿主声明"我要收 `com.application.watch.classschedule` 的消息"。这是**插件侧订阅成功** | "通道已建立" ❌ |
| `[连接] … EV状态=已安装` | 只是**装了**（`get_thirdparty_app_list` 里匹配到包名/应用名），与"正在运行"无关 | "EV 已在运行" ❌ |
| `[WAKE] launch-qa => Ok(())` | 宿主**受理了启动请求**（WIT 返回 `result`，只有 Ok/Err，没有细节） | "EV 已经启动好了" ❌ |
| `[TX] ping register=Ok send=Ok` | 插件→宿主两步成功。**QAIC 没有回执**，手环收没收到从这里看不出来 | "手环收到了" ❌ |
| `[event] Timer payload="interconnect-ready"` | **只是代码里 `set_timeout(300, …)` 设的一个延时**，而且 `set_timeout` 是异步立即返回的，**没有任何地方消费这个 payload** | "interconnect 已就绪" ❌（命名极具误导性） |
| `[event] Timer payload="auto-ping-after-launch"` | 这个 payload **有**消费方（`lib.rs:211-222` → `send_ping()`），是唯一真正生效的延时逻辑 | — |
| 全程 **0 条** `EventType::InterconnectMessage`、**0 条** `[RX]` | **手环侧的回包从未到达插件** | — |

> 关键判读：`[event] EventType::Timer` 能连续到达，证明**宿主→插件的回调通路是活的、插件进程没死**。缺的只有 `InterconnectMessage` 这一种事件。所以问题不在"插件收不到任何事件"，而在"就是没有 interconnect 回包这个事件"。

---

## 二、全链路 6 段与可见性

```
① 插件注册接收  register::register_interconnect_recv(addr, pkg)   ← 可见：Ok(())
② 插件发消息    interconnect::send_qaic_message(addr, pkg, msg)   ← 可见：Ok(()) 仅=宿主受理
③ 宿主 → 手环   蓝牙/协议下发                                      ← 不可见
④ 手环分发给 EV 快应用（受 resident/前台约束）                      ← 不可见
⑤ EV 解析并 send 回包                                             ← 不可见
⑥ 手环 → 宿主 → 插件派发 interconnect-message                      ← 不可见（日志里没有）
```

| 段 | 能力提供方 | 出错的可见性 | 备注 |
|---|---|---|---|
| ① | AstroBox 宿主（WIT `register`） | 有返回值 | 日志里 Ok，排除 |
| ② | AstroBox 宿主（WIT `interconnect`） | 有返回值 | 日志里 Ok，**但不证明送达** |
| ③ | AstroBox + 手环蓝牙 | 无 | — |
| ④ | **EV 快应用**（接收器注册 + 后台常驻） | 无 | 最可疑 |
| ⑤ | **EV 快应用**（是否实现了 `ping`/`export` 分支） | 无 | 次可疑 |
| ⑥ | AstroBox 宿主（事件路由） | 无 | 需对照实验 |

**核心症结：能观测的两段（①②）都是"已受理"，真正决定成败的四段（③④⑤⑥）零观测。** 这就是为什么这个 bug 拖了这么久——日志看起来一切正常。

---

## 三、候选根因（按可能性排序）

### R1 ~~★★★★★~~ 已排除（用户实测 2026-09-24）：EV 能被拉起

- **实测**：点插件的启动按钮，手环上 EV 课程表**立即打开**。"launch 假成功"这一条不成立。
- **依据（原**）：`src/lib.rs:508-521` 注释写明 EV 只在自身 `onCreate()` 里注册 interconnect 接收器；快应用"存在"时 `send_qaic_message` 照样返回 `Ok`，但没人收。
- **保留的唯一子情形**：`launch_qa` 是"拉起/唤起"语义。**若 EV 已在前台或后台存活，唤起走的是 `onShow`，不会重跑 `onCreate`** —— 此时它的接收器"是否仍然有效"未知（JS 上下文被回收则会失效，未被回收则应该还在）。"能立即打开"无法区分这两种情况。
- **要彻底关掉这一条**，只能由 EV 侧确认：接收器注册是否只在 `onCreate`、有没有 `onShow`/`onHide` 兜底、被挂起后是否重注册。
- **顺带**：这也意味着"启动后 1.5s 自动 ping"这一次发送，正好落在 EV 冷启动/热唤起的**不确定窗口**内，且**只发一次、不重试** —— 见 R7。

### R2 ★★★★☆ 手环上的 EV 版本较老，不认识 `ping` / `export` —— **已排除（v1.0.57 复测）**

- **排除依据**：装上 v1.0.56（修掉死锁）后点一下「读」，立刻收到 `len=10369` 的回包；`payloadHex` 解出来是 `{"ok":true,"action":"export","version":1,"scopes":…}`，ping / update_settings 同样正常。**手环上 EV 的响应完全符合协议 v1**，不存在"不认识 action"。
- **依据（原）**：协议文档 §1 兼容规则写着「不带 `action` 的报文一律按 `import` 处理（保证旧版插件可用）」。反过来说：老版本 EV 可能不认识 `action:"ping"` / `action:"export"` 而不回复 —— 这个推理方向没错，只是**事实不成立**。
- **保留价值**：如果将来在**别的机型/别的 EV 版本**上出现同样现象，这一条仍值得第一个排查。

### R3 ★★★☆☆ 手环未开启「后台运行」（`system.resident`）

- **依据**：协议文档 §5 明确写了「手环侧接收依赖 `system.resident` 后台常驻；用户未开启时可能收不到。建议插件导入前提示用户开启」。
- 快应用默认进后台会暂停运行（[Vela 官方：后台运行 resident](https://doc.quickapp.cn/features/system/resident.html)），插件在手机端操作时，EV 正处于后台。
- **判定方法**：手环 EV 课程表 → 设置 → 开启「后台运行/常驻」，再重试 Ping。
- **顺带**：这也是插件该主动提示用户的一条，目前 `status_message` 只在**发送失败**时才提"请确认后台运行"，发成功就完全不提。

### R4 ★★☆☆☆ 插件侧"等 300ms"是空操作，注册/发送存在竞态窗口

- **依据**（见「六、B1」）：`set_timeout` 不阻塞，`block_on` 一返回就往下发消息。"注册后等待 300ms"这句日志和它的注释都是**假的**。
- 后果：`register_interconnect_recv` 刚返回 Ok 就发 `export`，若宿主侧注册尚未生效（代码注释自己担心的那种竞态），回包会被路由丢弃。

### R5 ★☆☆☆☆ 包名/目标不匹配

- **排除**：日志已明确 `检测EV=Ev课程表/com.application.watch.classschedule`、`插件用EV包名=com.application.watch.classschedule`，且 `lib.rs:1040-1044` 有专门的不一致告警（未触发）。这一项可以划掉。

### R6 ★★☆☆☆ 宿主侧只在特定时机派发 `interconnect-message` —— **已排除（v1.0.57 复测）**

- **排除依据**：修掉插件的 push_log 死锁后，`EventType::InterconnectMessage` **每次请求都能派发到插件**（export / ping / update_settings 三条都有 `[event] EventType::InterconnectMessage` + `[RX]`）。宿主派发完全正常。
- **反推**：之前"0 条 InterconnectMessage"其实是**死锁把插件卡住了**，卡住之后宿主自然无法再派发 —— 我们把这个现象误读成了"宿主不派发"。

### R7 ★★★★☆（新增）只发一次、不重试，发送时机落在启动窗口内

- **依据**：`src/lib.rs:1046-1054` 选设备后 `launch_qa` → `set_timeout(1500, "auto-ping-after-launch")` → `lib.rs:211-222` 收到 timer 后调 `send_ping()` **一次**。此后没有任何重试或补偿。
- **问题**：快应用冷启动（加载 wasm/js、跑 `onCreate`、注册接收器）耗时不确定，1.5s 可能不够；而 ping **没有 ACK，丢了也没人知道**。用户后续手动点 Ping 是"再发一次"，但如果那一次 EV 又不在前台/还在启动，依然丢。
- **判定方法**：手环停在 EV 界面上不动，手机端**连续点 3~5 次** Ping，看是否有某次成功 → 通了即确认是窗口问题。
- **修复方向**：启动后改为**重试式 ping**（1.5s / 4s / 8s 各一次，收到 pong 即停），并在 UI 明确显示"第 N 次尝试"。

---

## 三之二、当前状态小结（2026-09-24）

```
已确认 ✅：宿主能拉起 EV（手环立即打开）
已确认 ✅：插件侧 register / send 调用都返回 Ok
已确认 ✅：宿主→插件事件通路活着（Timer 事件连续到达）
未确认 ❓：EV 是否收到过 {action:"ping"}      ← 卡在这
未确认 ❓：EV 是否回了包
未确认 ❓：回包有没有被派发回插件
```

**下一步优先级**：先做「零之二」的 **S1′（让 EV 主动发消息给插件）**。这一步能把上面三个 ❓ 一次劈成两半：
- EV 主动发的能收到 → 插件订阅 + 宿主派发都正常 → 锁定"插件→EV"方向（R2：EV 不认识 action，或 R7：时机）；
- EV 主动发的也收不到 → 插件订阅或宿主派发有问题（R4/R6），EV 侧业务逻辑根本不是瓶颈。

---

## 四、二分定位 SOP（建议按顺序执行）

> 更新：**S1（能否拉起 EV）已由用户实测通过**，请直接执行「零之二」的 S1′ / S2′ / S3′。

| 步骤 | 操作 | 预期 / 判定 |
|---|---|---|
| **S0** | 点「Ping 探针」，看是否出现 `[RX] ping 回包解析成功` | 通了 → 通道双向没问题，直接看 export；不通 → 继续 S1′ |
| **S1** ~~手动打开 EV 再点 Ping~~ | **已实测通过**（插件能把 EV 拉到手环前台） | 不再需要执行 |
| **S2** | 手环 EV → 设置 → 开「后台运行」，再试 Ping | 不通 → 排除 R3 |
| **S3** | 确认手环上 EV 版本（用户可见的版本号 / 关于页） | 低于协议 v1 落地版本 → 根因 R2，升级 EV |
| **S4** | 换成最小 HelloWorld 插件（register + send + 打印事件）复测 | HelloWorld 能收到 → 宿主没问题，回到业务/EV 侧；HelloWorld 也收不到 → 宿主/EV 侧问题，需提 issue 给 AstroBox |
| **S5** | 让 EV 侧在"收到任何 interconnect 消息"时给出可见反馈（toast/写盘日志） | 能证明 EV 到底有没有收到 → 这是唯一能把链路从中间劈开的办法 |

> 建议：**没有完成 S0/S1/S2 之前，不要再改插件的协议逻辑**。协议报文（`{"action":"ping"}`）是最小载荷，它不通，改 export 的字段/格式毫无意义。

---

## 五、证据索引

| 结论 | 证据位置 |
|---|---|
| 平台支持订阅回包 | `wit/deps/astrobox-psys-host.wit:401` `register-interconnect-recv: func(addr, pkg-name) -> future<result>` |
| 平台支持下发消息 | `wit/deps/astrobox-psys-host.wit:433` `send-qaic-message: func(device-addr, pkg-name, data) -> future<result>` |
| 有专门的回包事件类型 | `wit/deps/astrobox-psys-plugin.wit:11` `interconnect-message, // 需plugin执行host接口register-interconnect-recv才会收到` |
| 事件回调签名 | `wit/deps/astrobox-psys-plugin.wit:20` `on-event: func(event-type, event-payload) -> future<string>` |
| 回包处理函数存在但从未被触发 | `src/lib.rs:300-409` `handle_device_message()`（日志里 0 次 `[RX]`） |
| 插件只在 InterconnectMessage 分支处理回包 | `src/lib.rs:203-210` |
| ping 流程 | `src/lib.rs:525-570` `send_ping()` |
| export 流程 | `src/lib.rs:771-812` |
| EV 接收器只在 onCreate 注册的已知根因 | `src/lib.rs:508-521`（注释 v1.0.54） |
| launch 硬编码页面名 | `src/lib.rs:514-517` `launch_qa(addr, app_info, "pages/welcome")` |
| 手环侧后台运行约束 | `docs/EV课程表 同步对接协议文档.md` §5「后台运行」 |
| 联调第一步就是 ping | 同上 §6 第 0 步 |
| EV 包名 | `src/device.rs:203` `EV_PACKAGE_NAME = "com.application.watch.classschedule"` |

---

## 六、插件侧可以直接修的 3 个问题

> 修复进度（v1.0.56）：**C1 / C2 / C3 已修**（见「零之四」）；**B1 只删掉了假等待，真正的"等注册生效"重构仍待办**；**B2（回包超时判定）仍待办**。
> 另外「零之四」里那个**死锁（当时未列入本节）也已修复** —— 它是本节之外、但优先级最高的问题。

### B1【真 bug】"等 300ms"是空操作，竞态窗口依旧存在

```rust
// src/lib.rs:544-553（ping）与 779-789（export）现状
if reg.is_ok() {
    let _ = wit_bindgen::block_on(async {
        timer::set_timeout(300, "interconnect-ready").await   // ← 异步立刻返回 timerId
    });
    push_log("[TX] 注册后等待 300ms 完成".to_string());        // ← 这句是假的
}
let send = ... send_qaic_message(...).await;                   // ← 立即发送，根本没等
```

`set_timeout` 不会阻塞，所以实际行为是**注册后立即发送**。正确写法应学 `auto-ping-after-launch` 的模式：**注册 → 设 timer → 直接 return；在 `on_event` 的对应 payload 分支里再发送**。

### B2【体验 bug】没有回包超时判定，用户永远只看到"已发送"

- 现在 `send_ping` / export 成功后 status 一律是「已发送 / 已请求手环导出」，**没有下文**。
- 建议：注册成功后即置 `pending = Some(("ping", now))`，并 `set_timeout(3000, "tx-timeout-ping")`；收到回包清除 pending；`on_event` 收到超时 payload 时把 status 改成明确结论：
  - 「3 秒内没有收到回包。请：① 手环上手动打开 EV 课程表再试；② 开启 EV 的『后台运行』；③ 确认手环上 EV 版本 ≥ x.x.x」
- 这一步的收益：**用户侧可自诊断**，你也不用再靠猜。

### B3【体验 bug】启动成功 ≠ 接收器就绪，且 ping 只发一次不重试（见 R7）

- 已实测：`launch_qa(addr, app_info, "pages/welcome")` 确实能把 EV 拉到手环前台（页面名没问题），所以**问题不在页面名**。
- 但"EV 打开了"到"它的接收器注册好了"之间没有确认环节，中间只有一次 1.5s 的定时 ping：
  - `src/lib.rs:1046-1054` 启动 → `set_timeout(1500, "auto-ping-after-launch")`
  - `src/lib.rs:211-222` 收到 timer → `send_ping()`，**只此一次**
- **建议改成重试式 ping**：1.5s / 4s / 8s 各发一次，收到 pong 立即停止；UI 显示"第 N 次尝试"；3 次都无回包时给出明确结论文案（而不是继续显示"已发送"）。
- **同时要修 C1**：这个"启动 → 重试 ping"的逻辑要抽成一个函数，**`btn-launch-ev` 手动启动分支也要复用**（现在只有"选设备"流程会自动 ping，手动启动不回 ping，见「零之三」C1）。
- 收益：能自动吃掉"启动窗口"这一整类问题，也是当前**成本最低、最可能一次生效**的改动。

> 另外建议把 timer payload 改名：`interconnect-ready` → `delay-after-register`（现在的名字让人误以为握手成功，排错时极具误导性）。

---

## 七、给 EV 快应用侧（不在本仓）的待确认项

手环端源码不在本仓库（`device.rs:201` 注释指向 `github.com/guomengtao/class-schedule`），以下 3 点必须由 EV 侧确认，否则插件侧再改也是盲改：

1. 接收器**注册时机**：是否只在 `onCreate()`？被系统挂起/回收后是否会重新注册？有没有 `onShow`/`onHide` 兜底？
2. 是否声明并启用了 `system.resident`（后台运行）？默认状态是开还是关？
3. 是否实现了 `action:"ping"` / `action:"export"` 分支？从哪个版本开始支持？——**这是判定 R2 的唯一依据**。

---

## 八、总结

| 提问 | 回答 |
|---|---|
| 是不是平台不支持？ | **不是。** WIT 明确提供 `register-interconnect-recv` + `interconnect-message` 双向能力 |
| 是不是手环上 EV 不支持？ | **不是。** 三条回包实测解出来全部符合协议 v1，EV 侧零改动 |
| 那到底卡在哪？ | **全在插件自己**：① push_log 死锁（回包一到就卡死，回包被吞）② 宿主事件信封没解包（把 `{"addr","payloadHex",…}` 当业务报文）③ `parse_basic_response` 空洞成功（把 ② 的错误伪装成"收到 basic 回包"） |
| 为什么排查了这么多轮？ | 三个 bug 互相掩护：死锁让回包"看起来不存在"；空洞成功让解析错误"看起来成功"；再加上 QAIC 无 ACK，"发出去了"与"收到了"在日志上无法区分 |
| 已修复到哪一步？ | v1.0.56 修死锁 + C1/C2/C3；v1.0.57 修信封解包 + 空洞成功 + 解析容错 + 诊断日志 |
| 还欠什么？ | B1 真正的"等注册生效"（设 timer → return → on_event 里发送）、B2 回包超时判定。二者都不是当前阻塞项 |
| 下次遇到类似问题先做什么？ | **先看 `[RX] 收到回包 len=` 有没有出现**；没有就查死锁/订阅，有就看 `[RX] 原文：` 打印的报文；**结论不要建立在"解析器说成功"上 —— 检查它是否只是"空洞成功"** |
