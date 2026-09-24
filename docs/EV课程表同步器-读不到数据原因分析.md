# EV 课程表同步器「能启动 EV、但读不到数据」原因分析

> 分析对象：AstroBox 插件 `ev-schedule-sync`（`tools/ev-schedule-sync/astrobox-build/astrobox-plugin/`，manifest v1.0.55）
> 分析依据：用户提供的运行日志 + 插件源码 + WIT 接口定义 + `docs/EV课程表 同步对接协议文档.md`
> 日期：2026-09-24

---

## 零、结论速览

| 问题 | 结论 |
|---|---|
| AstroBox 平台**是否支持**读手环数据？ | **支持**。WIT 层有完整的双向能力：`register-interconnect-recv`（订阅回包）+ `interconnect-message`（事件回调）。见「五、证据索引」 |
| 插件调用有没有失败？ | **没有**。日志里 `register=Ok(())`、`send=Ok(())`，说明插件→宿主两步都过了 |
| 那为什么读不到？ | 因为 **`Ok` 只代表"宿主受理了"，不代表"手环收到了"**。QAIC 是**无 ACK 的单向下发**，链路后半段（蓝牙下发 → 手环分发给快应用 → 快应用回包 → 宿主路由回插件）**完全不可观测**，日志里 0 条 `InterconnectMessage` 就是断在这段的证据 |
| 最可能的原因 | ① EV 快应用**没真正在跑**（`launch-qa` 返回 Ok ≠ 已拉起，且已运行实例不会重跑 `onCreate`，接收器不重新注册）；② 手环上 EV **版本较老**，不认识 `action:"ping"/"export"`（协议 v1 是后加的）；③ 手环未开「后台运行」`system.resident` |
| 插件自身有没有 bug？ | **有两个，且都直接影响读数据**：`interconnect-ready` 的"等 300ms"是**空操作**（`set_timeout` 不阻塞，实际是注册后立即发送），以及全程**没有回包超时判定**（用户永远只看到"已发送"）。详见「六」 |

**一句话**：不是平台不支持，是"消息发出去了，但没有任何一方告诉我们它到没到"。

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

### R1 ★★★★★ EV 快应用根本没在运行（`launch-qa` 假成功）

- **依据**：`src/lib.rs:508-521` 注释已写明：EV 只在自身 `onCreate()` 里注册 interconnect 接收器；快应用"存在"时 `send_qaic_message` 照样返回 `Ok`，但没人收。
- **更麻烦的一点**：`launch_qa` 属于**拉起/唤起**语义。若 EV 已在后台（或被系统挂起但未销毁），**不会重新走 `onCreate`**，接收器不会重新注册；若 JS 上下文已被回收，接收器也随之失效。
- **判定方法**：手环上**手动打开** EV 课程表、停在它自己的界面上，然后立刻点插件里的 Ping 探针。
  - 手环前台手动打开 → Ping 通了 = 就是"启动/常驻"问题（R1）；
  - 手动打开也 Ping 不通 = 往下看 R2/R3。

### R2 ★★★★☆ 手环上的 EV 版本较老，不认识 `ping` / `export`

- **依据**：协议文档 §1 兼容规则写着「不带 `action` 的报文一律按 `import` 处理（保证旧版插件可用）」。反过来说：**老版本 EV 不认识 `action:"ping"` / `action:"export"`，很可能不回复**（或按 import 解析后直接静默返回）。
- `ping` / `export` 是协议 v1（`docs/EV课程表 同步对接协议文档.md`）才定义的；该文档依据的 EV 版本示例是 `versionName: 1.6.61 / 1.6.62`（§3.2、§6）。
- **判定方法**：把 EV 课程表升级到与协议文档同代的版本；或让 EV 端用 `data/version.js` 的版本号对照确认 `< 该能力引入版本`。
- **注意**：插件目前**拿不到**手环上 EV 的版本号（版本号本来要靠 ping/export 回包拿），所以这是**死循环**——必须先在设备侧确认版本。

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

### R6 ★★☆☆☆ 宿主侧只在特定时机派发 `interconnect-message`

- **依据**：协议文档 §5 提到过 `Plugin thread dropped the response`（宿主回话时插件线程已结束）。虽然日志显示 Timer 事件能到达（说明插件还活着），但**每次事件回调都是独立生命周期**，回包如果在回调窗口之外到达，是否会被丢弃取决于宿主实现。
- **判定方法**：对照实验——用最小 HelloWorld 插件（只做 register + send + 打印事件）复测，排除业务代码干扰。

---

## 四、二分定位 SOP（建议按顺序执行）

| 步骤 | 操作 | 预期 / 判定 |
|---|---|---|
| **S0** | 点「Ping 探针」，看是否出现 `[RX] ping 回包解析成功` | 通了 → 通道双向没问题，直接看 export；不通 → 继续 S1 |
| **S1** | 手环上**手动打开** EV 课程表并停留在其界面，**保持手环屏幕不熄**，再点 Ping | 通了 → 根因 R1（launch 假成功 / 未常驻），去修启动逻辑 |
| **S2** | 手环 EV → 设置 → 开「后台运行」，再试 S1 | 不通 → 排除 R3 |
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

### B3【体验 bug】`launch-qa` 的页面名硬编码 + 启动无验证

- `launch_qa(addr, app_info, "pages/welcome")` 里 `pages/welcome` 是写死的。若 EV 侧没有这个页面，宿主很可能仍然返回 `Ok`（只校验 app-info，不校验 page），于是又是一次"假成功"。
- 建议：把页面名做成常量/配置并在日志里打印；启动后再补一次 Ping（已有 auto-ping），**并把"启动后 Ping 未回包"单独作为一条排查结论输出**。

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
| 是不是平台不支持？ | **不是。** WIT 明确提供 `register-interconnect-recv` + `interconnect-message` 双向能力，日志也证明插件侧订阅/发送都成功 |
| 那到底卡在哪？ | 卡在**不可观测的半段**：宿主→手环→EV→回包。`Ok` 只表示受理，QAIC 无 ACK |
| 最该先做什么？ | 按 S0→S3 二分：**先在手环上手动打开 EV + 开后台运行 + Ping**。这一步就能把 R1/R2/R3 分辨出来 |
| 插件能立刻改善什么？ | 修 B1（把"等 300ms"做成真的等待）、B2（加超时结论）、B3（页面名可配 + 启动失败可诊断），让"读不到"从静默变成有结论 |
