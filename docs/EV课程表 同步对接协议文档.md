# EV课程表 同步对接协议文档

> 面向 **AstroBox 同步插件（EV Schedule Sync）** 的对接说明。
> 通道：Vela `system.interconnect`；报文：**JSON 字符串**；双向通信。
> 协议版本：**v1**（当前实现）。

---

## 一、协议总览

### 1.1 插件 → 手环（请求）

```json
{ "action": "import" | "export" | "update_settings", "payload": { } }
```

| action | 作用 | payload |
|---|---|---|
| `import` | 导入课程表 | 课程数据（见 2.1） |
| `export` | 请求导出 | 可省略 |
| `update_settings` | 编辑配置（昵称/首页设置/模板/字号） | 配置字段（见 2.3） |
| `ping` | 通道探针（联调自检，**最快往返**） | 可省略 |

> **兼容规则**：不带 `action` 的报文，一律按 `import` 处理（保证旧版插件可用）。

### 1.2 手环 → 插件（响应）

| 场景 | 响应 |
|---|---|
| 导入成功 | `{ "ok": true, "count": 30 }` |
| 导入失败 | `{ "ok": false, "reason": "..." }` |
| 导出 | `{ "ok": true, "action": "export", "version": 1, "data": { ... } }` |
| 配置编辑 | `{ "ok": true, "action": "update_settings" }` |

失败原因（`reason`）取值：`no courses` / `convert empty` / `write failed` / `backup failed` / `read failed` / `empty` / `no known field`。

> **传输层约定**：以上响应在 interconnect 通道上以 `{ "data": "<JSON字符串>" }` 形式发送（`data` 字段为**字符串**，非对象）。插件侧收到后应 `JSON.parse(msg.data)` 还原为上方结构；手环侧 `send` 时也已做 `JSON.stringify`。若插件直接对 `data` 调用 `JSON.parse` 却拿到对象，说明双端字符串/对象约定不一致——这是 `export` 读取不到回包的常见根因。

---

## 二、导入课程表（import）

### 2.1 payload 支持的四种包装（手环侧全部兼容，任选其一）

```json
① [ {...}, {...} ]                                  直接数组
② { "courses": [ {...} ] }                          courses 包装
③ { "schedules": [ { "courses": [ {...} ] } ] }     schedules 包装
④ { "payload": { "courses": [ {...} ] } }           payload 嵌套
```

### 2.2 课程字段（Course）

| 字段 | 必填 | 类型 | 说明 | 兼容别名 |
|---|:--:|---|---|---|
| `name` | ✅ | string | 课程名 | `courseName` |
| `day` | ✅ | number / string | 星期：`1`~`7` 或 `"星期一"` 或 `"Monday"` | `dayOfWeek` / `day_of_week` |
| **时间**（三选一） | ✅ | — | 见 2.3 | — |
| `teacher` | ❌ | string | 教师 | — |
| `location` | ❌ | string | 教室 | `classroom` / `room` |
| `notes` | ❌ | string | 备注 | `note` |
| `weeks` / `weekType` | ❌ | array / string | 周次、单双周 | **v1 暂不使用，可发，手环忽略** |

> ⚠️ `name`、`day`、时间三者缺一，该条课程会被跳过（不会中断整批导入）。

### 2.3 时间的三种写法（任选其一）

```json
① { "time": "08:00 - 08:45" }                              直接给时间段
② { "startTime": "08:00", "endTime": "08:45" }             起止时间
③ { "start_period": 1, "end_period": 2 }                   节次（手环按默认作息表换算）
```

**默认作息表**（仅第 ③ 种使用，共 8 节）：

| 节次 | 时间 | 节次 | 时间 |
|---|---|---|---|
| 1 | 08:00 - 08:45 | 5 | 14:00 - 14:45 |
| 2 | 08:55 - 09:40 | 6 | 14:55 - 15:40 |
| 3 | 10:00 - 10:45 | 7 | 16:00 - 16:45 |
| 4 | 10:55 - 11:40 | 8 | 16:55 - 17:40 |

跨节次（如 1→2）会合并为 `08:00 - 09:40`。
**建议优先用 ① 或 ②**，避免依赖手环的作息表。

### 2.4 完整示例

```json
{
  "action": "import",
  "payload": {
    "courses": [
      { "name": "数学", "teacher": "王老师", "location": "301教室", "day": 1, "startTime": "08:00", "endTime": "08:45" },
      { "name": "英语", "teacher": "李老师", "location": "205教室", "day": "星期一", "time": "08:55 - 09:40" },
      { "name": "物理", "dayOfWeek": 3, "start_period": 1, "end_period": 1 }
    ]
  }
}
```

### 2.5 导入行为（重要）

| 行为 | 说明 |
|---|---|
| **覆盖** | 导入会**覆盖当前课表**（不是追加） |
| **自动备份** | 写盘前把旧课表备份到 `astrobox_sync_backup`，出错可回退 |
| **原子写** | 单次写盘，不会出现"写一半" |
| **去重** | v1 **不做**去重，请插件侧自行保证（插件文档已声明会自动去重） |
| **留档** | 原始报文同时存入 `astrobox_sync_data`，便于排错 |

---

## 三、导出（export）

### 3.1 请求

```json
{ "action": "export" }
```

可指定**作用域**（可选；不传则返回默认集合）：

```json
{ "action": "export", "scopes": ["schedule", "profile"] }
```

也支持单字符串简写：

```json
{ "action": "export", "scope": "pinned" }
```

### 3.2 响应

```json
{
  "ok": true,
  "action": "export",
  "version": 1,
  "data": {
    "schedule": [
      {
        "day": "星期一",
        "classes": [
          {
            "id": "1",
            "name": "数学",
            "time": "08:00 - 08:45",
            "teacher": "王老师",
            "location": "301教室",
            "notes": "第五章：三角函数"
          }
        ]
      }
    ],
    "nickname": "小明",
    "homepage": { "showTime": true, "showStatusBar": true, "timeFormat": "24" },
    "homepageTemplate": "default",
    "baseFontSize": 48,
    "versionName": "1.6.61",
    "versionCode": 890
  }
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `schedule` | `allCourses_N` | **格式 A**：按 `day` 分组，`time` 为 `"HH:MM - HH:MM"` 字符串 |
| `nickname` | `userNickname` | 用户昵称（未设置时为随机默认昵称） |
| `homepage` | `homepage_settings` | 首页设置（字段见 3.3） |
| `homepageTemplate` | `homepage_template` | 首页模板 id |
| `baseFontSize` | `baseFontSize` | 字号，范围 20~76 |
| `versionName` / `versionCode` | `data/version.js` | **版本号，只读**：插件可读取以判断版本兼容性，**不可通过 `update_settings` 写入** |

### 3.3 `homepage` 字段（以实际导出为准）

常见字段包括：`showQuickAdd`、`showCustomContent`、`customContent`、`showTime`、`showStatusBar`、`showPinnedBar`、`showDayNavZong`、`showDayNavJin`、`showDayNavMing`、`timeFormat` 等。

> ⚠️ **不要硬编码这些字段**。不同版本字段会增减，插件侧应**原样保存、原样回写**（见 4.4）。

### 3.4 作用域（scopes）与开放边界

| scope | 内容 | 是否默认开放 |
|---|---|:--:|
| `schedule` | 课表（格式 A） | ✅ 默认 |
| `profile` | 昵称 | ✅ 默认 |
| `homepage` | 首页设置 | ✅ 默认 |
| `appearance` | 首页模板 + 字号 | ✅ 默认 |
| `version` | 版本号（`versionName` / `versionCode`） | ✅ 默认（**只读**，不可写） |
| `pinned` | 钉首页列表（`pinned_pages`） | ❌ **默认不开放**，需显式传 `scopes` |
| 其他（授权 `auth`、假期 `holiday` 等） | — | ❌ **不在白名单，永远不给** |

**这是白名单模型 —— 手环侧是守门人：**

- 插件只能通过 `interconnect` 发请求，**手环决定读什么、回什么**
- 不在白名单的域（如授权状态）→ **永远拿不到**
- 在白名单但非默认的域（如 `pinned`）→ **不显式请求就拿不到**
- `update_settings` 同理，只处理白名单字段，其余一律忽略 → **改不掉**

> **一句话：不开放 = 读不到、也改不掉。这个边界 100% 由手环侧控制。**

> ⚠️ 说明：本结论针对 **interconnect 协议通道**。AstroBox 作为手机端工具理论上可能有更底层的设备访问能力；若绕过 interconnect 直接读设备存储，则不在本守门范围内。标准插件通信路径（`send_qaic_message`）下，以上结论成立。

---

## 四、编辑配置（update_settings）

### 4.1 请求（字段可选，任意组合）

```json
{
  "action": "update_settings",
  "payload": {
    "nickname": "小明",
    "homepage": { "showTime": true, "showStatusBar": false },
    "homepageTemplate": "default",
    "baseFontSize": 48
  }
}
```

| 字段 | 约束 | 说明 |
|---|---|---|
| `nickname` | string | 用户昵称（**可读可写**，见 4.3） |
| `homepage` | object | 首页设置（建议整体回写，见 4.4） |
| `homepageTemplate` | string | 首页模板 id |
| `baseFontSize` | number，**20~76** | 超出范围会被忽略 |

**响应**：`{ "ok": true, "action": "update_settings" }`

### 4.2 版本号（只读）对接方式

版本号属于 `version` 域，策略为 **`read:"always" / write:false`**——插件**默认就能读到**，但**任何 `update_settings` 都无法修改它**（手环侧会忽略 `version` 字段）。

**读取（导出，无需额外操作）：**
```json
{ "action": "export" }
// 响应 data 中即含 versionName / versionCode
```

**写入（被拒绝）：**
```json
{ "action": "update_settings", "payload": { "versionName": "9.9.9" } }
// 手环侧：version 不在可写字段 → 忽略，回包 { "ok": true } 但不生效
```

> 用途：插件读取 `versionName/versionCode` 判断手环端是否支持某特性（如旧版无 `update_settings` 时不发写请求）。**版本号由 `data/version.js` 决定，随发版更新，外部不可篡改。**

### 4.3 昵称（可读可写）对接方式

昵称属于 `profile` 域，策略为 **`read:"always" / write:true`**——既能读也能写。

**读（导出）：**
```json
{ "action": "export" }
// 响应 data.nickname = "小明"
```

**写（update_settings）：**
```json
{ "action": "update_settings", "payload": { "nickname": "新昵称" } }
// 回包 { "ok": true, "action": "update_settings" } → 手环首页昵称已更新
```

> 写昵称时**只传 `nickname` 一个字段即可**，其余配置不受影响（手环侧按字段逐个处理，互不影响）。

> **排错（实测踩坑）**：`nickname` 的值必须是**字符串**。若把 UI 表单的 change 事件对象
> `{"type":"change","value":"123","checked":false}` 整体当作 `nickname` 传入，手环会**原样存成那串
> JSON**（而非 `123`）。**正确做法**：取事件的 `.value` 后传，例如 `nickname: evt.value`。
> 手环端已加一层安全容错——检测到传入值是形如 `{"type","value","checked"}` 的 JSON 时会自动取
> `.value`；但插件侧仍应直接传字符串，避免依赖容错。

### 4.4 配置编辑的正确姿势：读 → 改 → 写

因为 `homepage` 字段会随版本变化，**强烈建议**插件侧这样做：

```
1. 发 {"action":"export"}                 拿到完整 homepage 对象
2. 只改自己关心的字段（如 showTime），其余原样保留
3. 发 {"action":"update_settings","payload":{"homepage": <改后的完整对象> }}
```

❌ 错误做法：插件本地造一个只含部分字段的 `homepage` 直接写入 —— 会**丢失其余配置**。

---

## 五、联调约束与建议

| 项 | 说明 |
|---|---|
| **后台运行** | 手环侧接收依赖 `system.resident` 后台常驻；用户未开启时可能收不到。建议插件导入前提示用户在课程表设置中开启「后台运行」 |
| **报文大小** | 一周课表 JSON 体积较小，但 interconnect 载荷上限**需真机实测确认**；如超限建议分批 |
| **幂等** | `import` 是覆盖式，重复导入结果一致 |
| **字段容错** | 未知字段会被忽略；缺失必填字段的**单条课程**会被跳过，不影响其余 |
| **同步性** | 导入/编辑后，手环页面在下次 `onShow` 时刷新 |
| **调试** | 原始报文留档 `astrobox_sync_data`，原始课表备份 `astrobox_sync_backup` |
| **响应时延** | 手环端 `export` 会聚合多个异步读取，**最长约 2 秒**（超时兜底也会回包，可能只含部分域）。插件侧等待时间建议 **≥ 3 秒**，否则可能等不到回包 |
| **响应投递** | 若插件报 `Plugin thread dropped the response`，说明宿主回话时**插件线程已结束**（插件侧调用模型/超时问题，非手环侧）；先按「六」第 0 步用 `ping` 二分定位 |

---

## 六、联调检查清单

0. **【联调第一步】`{action:"ping"}` → 收到 `{ "ok":true, "pong":true, "versionName":"1.6.62", "versionCode":891 }`**，确认通道**双向通**。收不到或报 `Plugin thread dropped the response`，就不要再往下测——那是**调用模型/超时**问题（见「五」响应时延/响应投递）
1. 手环 `manifest.json` 已声明 `system.interconnect`（✅ 已加）
2. `{action:"export"}` → 能收到 `schedule` + `nickname` + `homepage`
3. `{action:"import"}` → 手环课表**确实变化**，回包 `count` 与预期一致
4. `{action:"update_settings"}` 改昵称 → 手环首页昵称更新
5. 改 `homepage` 某字段 → 只改该字段，其余配置不丢（**读-改-写验证**）
6. `baseFontSize` 传 100（越界）→ 被忽略，回包仍 ok
7. 断连/后台未开启时，插件侧有明确提示，而非静默失败

---

## 七、版本演进

| 版本 | 内容 |
|---|---|
| v1（当前） | `import` / `export` / `update_settings`；导入宽容解析；导出含配置；写前备份 |
| 后续可加 | `restore`（回滚到 `astrobox_sync_backup`）、周次 `weeks`/`weekType` 支持、`scheduleNames` 多课表读写、模板列表导出 |

> 说明：本文档依据本仓 `src/app.ux` 当前实现撰写（2026-09-23）。字段与行为以代码为准；若插件侧有特殊格式需求，优先在插件侧转换为本文约定格式，避免手环侧硬适配多种外部格式。
