# 安卓同步器 App — 仓库选型与开发方案

> 日期：2026-09-26
> 状态：**待决策**（核心议题：同仓开发 vs 独立新仓）
> 结论速览见 §5

---

## 一、背景与目标

**目标**：做一个 **Android APK**，实现对「EV 课程表」手环快应用数据的管理与同步——导入课表 / 导出数据 / 编辑配置，能力对齐现有 `ev-schedule-sync`（AstroBox 插件），但运行在安卓手机上、可独立分发。

**本文要回答的核心问题**（用户提出）：

> 是在现有 `app-auth` 仓库的 `tools/` 里继续开发，还是**新建一个完全独立的仓库**？

之所以纠结，是因为 `app-auth` 这个仓现在已经是「一仓多组件」：

- 主网站后台（静态页 + Vercel 函数）
- EV 通知器 `ev-notifier`（macOS / Python / PyObjC）
- EV 同步器 `ev-schedule-sync`（Rust → wasm32-wasip2 / AstroBox 插件）
- `region-manager`（macOS / Python + Swift launcher）

现在再加一个 Kotlin / Gradle / Android SDK 的安卓 App，确实该先想清楚边界。

---

## 二、现状盘点（事实）

### 2.1 `app-auth` 仓库现状

| 维度 | 现状 |
|---|---|
| 仓库 | `github.com/guomengtao/app-auth`，**public** |
| 规模 | 被跟踪文件 **398 个**，约 **8.7 MB** |
| 构建模型 | 无构建：单文件静态页 + Vercel Serverless Functions |
| 部署 | `git push origin/main` → Vercel 自动 build，线上 `app-auth.gudq.com`（60–90s 生效） |
| 技术栈 | JS（Node 函数）、Python（桌面工具）、Rust（wasm 插件） —— 已经是多语言 |
| 版本管理 | `version.json`(主站 1.7.10) / `tools/ev-notifier/version.json` / `tools/ev-schedule-sync/.../manifest.json`；`scripts/bump-version.sh` 按目录自动 bump patch |
| 文档资产 | `docs/` 下 **101 个 md**，含完整 EV 协议与全部踩坑记录 |

### 2.2 已经存在「按平台分仓」的先例（重要）

| 仓库 | 内容 | 运行环境 |
|---|---|---|
| `guomengtao/app-auth` | 网站后台 + 桌面工具 + AstroBox 插件 | Vercel / macOS / AstroBox |
| `guomengtao/class-schedule` | **手环端 EV 课程表快应用**（ES5 + `.ux`，aiot-toolkit，当前 v1.4.0） | 手环 Vela 系统 |

**这条事实很关键**：你们的仓库边界**事实上已经按「运行平台 / 发布通道」在切了**——手环端一个仓，网站与桌面工具一个仓。安卓端是一个全新的运行平台，按同一逻辑应当独立。

### 2.3 构建与部署的耦合点（同仓会踩的地方）

1. **push main 就触发 Vercel build**：改一行 Kotlin 也会白 build 一次，还可能因构建环境无关而失败。
2. **`scripts/bump-version.sh` 的白名单**：`is_main_file()` 把 `tools/ev-notifier`、`tools/ev-schedule-sync` 排除在「主站文件」之外；新增组件**必须加白名单**，否则改安卓代码会误 bump 主站版本（历史上已经因为 `git add -A` 出过事，现在明令禁止）。
3. **仓库是 public**：任何密钥类文件（keystore、CI secret）不能入库。
4. **`.gitignore` 现有规则不含 Gradle 产物**（只有 `**/target/`、`node_modules`、`.env*`、`__pycache__/`）。

---

## 三、技术路线（决定仓库形态的前置问题）

### 3.1 安卓 App 连手环，绕不开这一层

通信链路：

```
Android App ──蓝牙(经典 SPP)──▶ 手环 Vela 系统 ──▶ EV 快应用 (com.application.watch.classschedule)
```

**现有插件是"寄生"在 AstroBox 宿主里的**——宿主已经实现了整条链路，插件只调用宿主暴露的 WIT 接口：

| 宿主接口 | 作用 |
|---|---|
| `transport::request(addr, bytes)` / `send` | 底层传输，协议 `XIAOMI-VELA-V5-PROTOBUF` |
| `register::register-transport-recv(addr, filter{channel-id, protobuf-typeid})` | 按 channel/type 收包 |
| `interconnect::send-qaic-message(addr, pkg, data)` | QAIC 报文通道（插件主用） |
| `register::register-interconnect-recv(addr, pkg)` | 注册接收器 |
| `thirdpartyapp::launch-qa` / `get-thirdparty-app-list` | 拉起快应用 / 列出已装应用 |
| `device::get-device-list` / `get-connected-device-list` | 设备列表 |

**一句话**：写插件 = 完全不碰蓝牙和协议栈；**写安卓 App = 上面这些全部得自己实现。**

### 3.2 三条候选路线

| 路线 | 做法 | 可行性 | 主要风险 |
|---|---|---|---|
| **A. 复用 AstroBox CoreLib** | AstroBox-NG 的 CoreLib 是 Rust、平台无关、专门做了 WASM 适配，理论可编进安卓（NDK/JNI 或 wasm 运行时） | 中—高（体积与集成成本待验证） | ⚠️ **许可证 = AGPL-3.0 + 附加署名条款**；仓库**部分开源部分闭源**（Tauri App 闭源）；协议实现是否随官方持续更新存疑 |
| **B. 自研 Vela 协议栈** | 自己实现 经典蓝牙 SPP + Vela protobuf v5 + QAIC 信封 | 低—中 | 逆向工作量以月计；固件/App 升级即可能失效；无官方文档 |
| **C. 官方穿戴 SDK** | 《小米穿戴第三方 APP 能力开放接口》的 `MessageApi.sendMessage` / `addListener`，配合 `NodeApi` / `AuthApi` | **未验证** | 官方定位是「手机 App ↔ 穿戴侧应用」消息通道，**理论上与手环 `system.interconnect` 同角色**；但**能否打到手环上任意快应用（含我们的 EV）必须实测**。该 SDK 明确不支持健康数据读写 —— 对本项目无影响（我们只要报文通道） |

> 补充：`system.interconnect` 在 Vela 官方文档里的定义正是「用于和搭配使用的手机 app 进行通信」——说明这条通道的设计意图就是被手机 App 使用，路线 C 值得优先验证。

### 3.3 必须先做的验证 Spike（建议 1–3 天，动手写 App 之前）

| # | 验证项 | 方法 | 影响 |
|---|---|---|---|
| **S1** | 官方 SDK `MessageApi` 能否让手环端 EV 收到 `{action:"ping"}` 并回包 | 最小 Android demo + 小米运动健康，向 `com.application.watch.classschedule` 发 ping | **决定生死**：通 → 走 C，全自研、无许可证问题；不通 → 只能 A 或 B |
| S2 | 若走 A：CoreLib 能否在 Android(aarch64) 编译并跑通一次 ping | 对照现有插件的 `ping` 路径 | 决定 A 的工期 |
| S3 | 通道是否也依赖手环侧「后台运行」`system.resident` | 复用现有结论验证 | 影响 App 的用户提示文案 |
| S4 | interconnect 载荷上限 | 分批发送实测 | 影响大课表导入策略 |

**S1 权重最高，是「安卓 App 完全自研」成立的唯一前提。建议作为方案启动的第 0 步。**

### 3.4 与现有资产的复用关系（无论走哪条路线都成立）

| 资产 | 能否复用 | 说明 |
|---|---|---|
| **协议语义** | ✅ 100% | action 集合、字段兼容别名、时间三种写法、`update_settings` 读-改-写、`export` 作用域白名单 —— 见 `docs/EV课程表 同步对接协议文档.md` |
| **报文踩坑经验** | ✅ | 信封 `{"data":"<JSON字符串>"}`、parse 必须要求特征字段、unwrap 不能无条件剥 `data`、课表宽容拍平 |
| **信息架构** | ✅ | 插件现有四个 Tab（设备选择 / 导入 / 导出 / 日志） |
| **后端** | ✅ 100% | `/api/ev` 设备码登录（`device-start/poll/approve/revoke`）、设备令牌、激活校验 —— 这是**运行时 HTTP 依赖**，与是否同仓无关 |
| **蓝牙与协议栈** | ❌ | 全部由 AstroBox 宿主提供，安卓端要自建 |
| **UI** | ❌ | wasm WIT UI → 原生 Compose/View，只能抄设计不能抄代码 |

---

## 四、核心议题：同仓 vs 独立仓

### 4.1 方案甲：同仓开发（`app-auth/tools/ev-schedule-android/`）

**优点**

1. 协议文档、报文样例、踩坑记录天然同源，改协议时一次 commit 两边同步，不会漂移。
2. `scripts/bump-version.sh` 只需加一行白名单即纳入多组件版本管理。
3. 后端接口改动与 App 改动可在同一个提交里一起改、一起评审。
4. 对个人开发者而言，单一 clone 最省事。

**缺点与风险**

1. **构建语义完全不同**：仓库是「静态页 + Vercel 函数」，安卓是 Gradle/Android SDK/NDK。混在一起后，每次 push 都会触发一次与安卓无关的 Vercel build；Android Studio 会在仓库根生成 `.gradle/`、`local.properties`、`.idea/`，要不停补 `.gitignore`。
2. **签名密钥 × 公开仓库**：仓库是 public。keystore、`signingConfig`、CI secret 必须严格隔离，**一旦误提交就等于把发布权交出去**。本项目已经因为 `git add -A` 出过事故（现明令禁止），同仓等于多一个踩坑面。
3. **许可证传染**：如果 §3.2 路线 A 成立，AGPL-3.0 代码会进仓库。`app-auth` 是持续在线的 Web 服务（AGPL 网络条款对后端有实质约束），同仓会把许可证问题从「安卓 App」扩散到「整个项目」。
4. **仓库体积 / 克隆速度**：安卓工程（Gradle wrapper、AAR、资源）会显著增重（现在才 8.7 MB）。
5. **发布节奏耦合**：安卓要签名 + Release APK + 分发，与主站 push 流程没有交集，却共用同一套 git 历史。
6. **对外协作边界模糊**：若将来安卓端要部分开源或找人协作，得从公开后端仓库里往外剥。

### 4.2 方案乙：独立新仓库（**推荐**）

建议 `guomengtao/ev-schedule-android`。

**优点**

1. **构建 / 发布完全独立**：自己的 GitHub Actions（build + 签名 + Release APK），不牵动 Vercel。
2. **许可证可隔离**：万一必须内嵌 AstroBox CoreLib（AGPL），污染范围只限于这一个仓。
3. **已有先例**：手环端 `class-schedule` 就是独立仓 —— 既然手环端都独立了，安卓端没有理由塞回网站仓。
4. 仓库轻、clone 快、IDE 干净，`.gitignore` 只管安卓自己的坑。
5. 版本号 / CHANGELOG / Release 页独立，用户下载入口清晰。

**缺点与对策**

| 缺点 | 对策 |
|---|---|
| 协议定义会漂移 | 协议单一真相源 + fixtures 双向校验（§5.1） |
| 后端接口契约会漂移 | 接口契约文档 + 双端契约测试（§5.2） |
| 多一套发布流程 | GitHub Actions 一次配好，之后零成本（§5.3） |

### 4.3 对比矩阵

| 维度 | 方案甲（同仓） | 方案乙（独立仓） |
|---|:---:|:---:|
| 协议一致性 | ✅ 天然 | ⚠️ 需机制 |
| 构建解耦（不牵连 Vercel） | ❌ | ✅ |
| 许可证隔离（AGPL） | ❌ | ✅ |
| 密钥安全面 | ⚠️ 较大 | ✅ 小 |
| 发布独立性 | ❌ | ✅ |
| 仓库体积 / 克隆速度 | ⚠️ 变差 | ✅ |
| 初次搭建成本 | ✅ 低 | ⚠️ 略高 |
| 长期维护成本 | ⚠️ 递增 | ✅ 平坦 |

---

## 五、推荐结论

**推荐方案乙：新建独立仓库**，同时配套三条契约机制——否则独立仓唯一那点缺点会变成真问题。

**理由（按权重）**

1. **运行平台与构建模型完全不同**。仓库边界应该切在「平台 / 发布通道」上，而不是「是不是我们写的」。你们**已经这么做了**（`class-schedule` 独立成仓）。
2. **技术路线尚未定**（§3.2 的 A/B/C 未验证），而其中 A 会引入 AGPL。**先分仓 = 保留全部选项；同仓 = 先放弃选项。**
3. **公开仓库 + 安卓签名密钥**，安全面必须最小化。
4. 安卓 App 要对外分发，必然有自己的版本 / 签名 / Release 节奏。

**唯一会让结论翻转的情况**：如果 S1（官方 SDK 打通）验证成功，**且**你确定安卓端只是**内部自用小工具**（不对外发布、代码量小、永不碰 AGPL），那么同仓成本更低。但只要涉及对外分发，独立仓就是更优解。

### 5.1 配套机制一：协议单一真相源

- 真相源留在 `app-auth`：`docs/EV课程表 同步对接协议文档.md` 升级为规范，并新增 `docs/ev-protocol/fixtures/*.json`（ping / import / export / update_settings 的请求与响应样例）。
- 安卓仓通过**固定 commit 的快照**（脚本 `scripts/sync-protocol.sh`）或 git submodule 引入 `docs/ev-protocol/`。
- **CI 校验**：安卓仓 CI 比对 fixtures 的 hash 与 app-auth 最新版；不一致 → 构建失败并提示「协议已更新，请同步」。
- 双端各写一份 **fixtures 驱动的单测**：读同一批 JSON，断言解析结果一致。协议漂移会在 CI 里立刻暴露。

### 5.2 配套机制二：后端接口契约

- 安卓 App 需要调用的接口（现阶段：`/api/ev?action=device-start|device-poll|devices`；后续：激活校验）写成契约表（路径、方法、请求/响应字段、错误码），放 `app-auth/docs/ev-protocol/backend-contract.md`，同 §5.1 机制引入安卓仓。
- 后端改动时同步更新契约；安卓仓加一个「只读冒烟」测试（参考现有 `smoke_online.py` 的做法），验证线上契约未被破坏。

### 5.3 配套机制三：版本与发布

- 安卓仓独立 SemVer（`versionName`）+ 单调递增 `versionCode`，与 `app-auth` 的 `bump-version.sh` **完全解耦**（不进 `is_main_file()` 白名单）。
- 产物：签名 APK 挂 GitHub Release；若后续要上应用商店，分发落地页可放在 `app-auth`（复用现有静态页体系）。

### 5.4（备选）如果最终选同仓，落地清单

1. 目录：`tools/ev-schedule-android/`。
2. `.gitignore` 增补：`**/build/`、`**/.gradle/`、`local.properties`、`*.jks`、`*.keystore`、`*.apk`、`*.aab`、`.idea/`（现有 `**/target/` 不覆盖 Gradle）。
3. `scripts/bump-version.sh`：`is_main_file()` 增加 `tools/ev-schedule-android`；`bump_component` 增加一行。版本文件建议放**独立 `tools/ev-schedule-android/version.json`**，避免脚本去解析 Kotlin 文件。
4. `vercel.json`：加路径级跳过部署配置，避免改 Kotlin 触发 Vercel build。
5. **签名密钥绝不入库**：走本地 `~/.gradle/gradle.properties` 或 CI secret。

---

## 六、安卓端架构建议（与仓库形态无关）

**核心分层原则：把「协议编解码」与「传输通道」彻底解耦**，因为传输通道是最大不确定项（A/B/C 三种实现可能互换）。

```
ev-schedule-android/
├── core-protocol/     # 纯 Kotlin，零 Android 依赖：报文编解码 + 兼容别名 + fixtures 单测
├── core-transport/    # interface BandTransport { suspend fun request(bytes): Result<ByteArray> }
│   ├── transport-official-sdk    # 路线 C（首选，无许可证问题）
│   ├── transport-astrobox-core   # 路线 A（单独成模块，便于识别许可证影响范围）
│   └── transport-raw-spp         # 路线 B（兜底）
├── core-storage/      # 导入导出留档、课表缓存、日志环形缓冲
├── app/               # UI / 状态机（对齐现有插件四个 Tab）
└── docs/protocol/     # §5.1 引入的协议契约快照
```

收益：
- S1 验证失败要换路线时，**只换 `core-transport` 的实现**，协议层与 UI 不动。
- 若走路线 A，AGPL 代码只出现在 `transport-astrobox-core` 一个模块。

> ⚠️ 注意：模块隔离**不能**免除 AGPL 义务（AGPL 按「整作品」分发）。这里只是把影响范围可视化，真要商用必须法务确认。

---

## 七、里程碑建议

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **M0** | **Spike S1**：官方 SDK 通道打通验证 | 一页结论：通 / 不通 | 1–3 天 |
| M1 | 仓库与脚手架（按 §5 结论） | 能跑起来的空 APK + CI | 1 天 |
| M2 | `core-protocol` + fixtures 单测 | 报文层可测、与插件对齐 | 2–3 天 |
| M3 | 传输层（按 M0 结论选路线） | 能 ping 通 EV | 3–15 天（取决于路线） |
| M4 | 导入 / 导出 / update_settings 全链路 | 功能对齐现有插件 | 3–5 天 |
| M5 | 设备码登录 + 激活校验接入 | 与后端闭环 | 1–2 天 |
| M6 | 打磨、签名、Release | 可分发的 APK | 2–3 天 |

---

## 八、风险清单

| 风险 | 影响 | 对策 |
|---|---|---|
| S1 验证失败，官方 SDK 打不通手环快应用 | 工期从「周」变「月」 | M0 先验证；失败则评估路线 A 的 AGPL 代价 |
| 走路线 A 引入 AGPL-3.0 + 署名条款 | 安卓端可能被迫开源 | 独立仓隔离；提前确认商业诉求 |
| AstroBox 协议实现随官方更新漂移 | 连接失效 | 独立 `core-transport`，可快速替换 |
| 官方 SDK 需要用户装「小米运动健康」 | 用户门槛 | 首启引导 + 检测提示 |
| 手环侧未开 `system.resident`「后台运行」 | 收不到回包 | 复用现有结论做明确提示（不静默失败） |
| 协议在两仓之间漂移 | 安卓端解析失败 | §5.1 fixtures + CI hash 校验 |
| 签名密钥误入库 | 发布权泄露 | 密钥走本地/CI secret；`.gitignore` 兜底 |

---

## 九、待决策的点

1. **仓库形态**：方案甲（同仓）还是方案乙（独立仓）？—— 本文推荐**乙**。
2. **是否先做 M0 Spike**？—— 强烈建议先做，它直接决定路线与工期量级。
3. **安卓端分发范围**：应用商店 / 官网 / 仅群内？—— 影响发布与许可证策略。
4. **若必须内嵌 AstroBox CoreLib（AGPL），能否接受安卓端整体 AGPL 开源？**
5. **后端是否需要为 App 新增接口**（如课表云备份 / 多设备管理）？
