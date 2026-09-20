# Ev课程表导入器 — AstroBox V2 插件开发分析

> **背景**：基于 `https://github.com/guomengtao/class-schedule` 开源项目代码，分析如何在 AstroBox V2 平台上开发名为「Ev课程表导入器」的 Rust 插件。  
> **参考文档**：`https://abox.run/docs/plugin-dev`（AstroBox V2 插件开发官方文档）  
> **日期**：2026-09-20  
> **重要更正**：AstroBox V2 已推出**真正的插件系统**（Rust WASM Component），不再是单纯的 Vela QuickApp 分发工具。

---

## 零、关键认知修正

### 之前的误解 vs 实际情况

| 维度 | 之前理解（V1） | 实际情况（V2） |
|------|:-----------:|:-----------:|
| 插件系统 | ❌ 不存在，Astrobox 只是分发工具 | ✅ **真正的插件系统**，Rust WASM Component |
| 开发语言 | Vela QuickApp（`.ux` + ES5 JS） | **Rust**（编译为 wasm32-wasip2） |
| 运行位置 | 手环（Vela OS） | **Android 手机**（AstroBox 宿主内） |
| 网络能力 | `@system.fetch`（受限） | **Transport API**（完整的 HTTP 客户端） |
| UI 框架 | `.ux` 模板（类 Vue） | **声明式 UI Builder API** |
| 打包格式 | `.rpk` | **`.abp`**（AstroBox Plugin） |
| 与手环通信 | 手环直接运行 | 通过 **Interconnect API** 推送数据到手环 |

### 这对导入器意味着什么

**巨大的好消息！** 插件运行在 Android 手机上，拥有完整的网络能力和 Rust 生态，可以直接：
1. 通过 **Transport API** 发 HTTP 请求到教务系统
2. 用 **Rust HTML 解析库**（`scraper`、`select`）解析课表数据
3. 通过 **Interconnect API** 将数据推送到手环上的 EV课程表
4. 提供原生级的 **声明式 UI** 交互体验

**完整的导入链路**：
```
手机端 AstroBox 插件（Rust WASM）
  ├─ UI: 学校选择 + 账号输入
  ├─ Transport: HTTP → 教务系统（登录 + 爬取课表）
  ├─ 解析: Rust HTML parser → 结构化课程数据
  └─ Interconnect: 推送数据 → 手环 EV课程表
```

---

## 一、class-schedule 代码仓库分析

### 1.1 项目概况

`guomengtao/class-schedule` 是一款基于 **Android 平台**（Java/Kotlin）的开源课程表应用，采用 Material Design 风格。

| 属性 | 说明 |
|------|------|
| 平台 | Android（Java/Kotlin） |
| UI 框架 | Material Design |
| 核心功能 | 手动添加课程、导入课表、教务系统对接、课表分享 |
| 目标用户 | 高校学生 |

### 1.2 核心模块与导入器的对应关系

#### 方正教务系统导入（⭐ 核心导入逻辑）

这是 class-schedule 中最有价值的部分。技术原理：

```
用户输入教务系统账号密码
    → HTTP 请求 → 方正教务系统登录接口
    → 模拟登录 → 获取 Session/Cookie
    → 请求课表页面 → HTML 解析
    → 提取课程信息 → 结构化存储
```

**关键技术点**：
1. 模拟表单登录（处理 `__VIEWSTATE` 等隐藏字段）
2. HTML 爬虫解析（Jsoup 库）
3. 数据映射（教务系统格式 → App 内部格式）
4. 周次处理（单周/双周/全周）

#### 模块对应关系

| class-schedule 模块（Java） | 导入器对应实现（Rust） | 说明 |
|---|---|---|
| `JwxtClient.java` | `src/jwxt/client.rs` | HTTP 登录 + 课表请求 → `Transport API` + `reqwest` |
| `JwxtParser.java` | `src/jwxt/parser.rs` | HTML 解析 → `scraper` crate |
| `Course.java` | `src/models.rs` | 数据模型 → Rust struct |
| `ScheduleUtils.java` | `src/utils.rs` | 工具函数 |
| `ImportActivity.java` | `src/ui/sync_page.rs` | 导入 UI → 声明式 UI Builder |

### 1.3 项目结构推断（Android）

```
class-schedule/
├── app/src/main/java/com/guomengtao/schedule/
│   ├── MainActivity.java
│   ├── ImportActivity.java         # 导入课表 UI
│   ├── model/Course.java           # 课程数据模型
│   ├── parser/JwxtParser.java      # ⭐ HTML 解析器
│   ├── network/JwxtClient.java     # ⭐ HTTP 客户端
│   └── utils/ScheduleUtils.java
```

---

## 二、AstroBox V2 插件系统概述

### 2.1 插件是什么

AstroBox 插件是一个 **Rust lib**，编译为 `wasm32-wasip2` 的 **WebAssembly Component**。

```
┌─────────────────────────────────────────┐
│              AstroBox Host（Android）      │
│  ┌───────────────────────────────────┐  │
│  │        Plugin（Rust WASM）         │  │
│  │  ┌─────────┐  ┌────────────────┐  │  │
│  │  │ UI 界面  │  │  业务逻辑       │  │  │
│  │  │(声明式)  │  │  (教务系统爬虫)  │  │  │
│  │  └─────────┘  └────────────────┘  │  │
│  │         ↕ WIT 接口契约              │  │
│  ├───────────────────────────────────┤  │
│  │  Host API: Transport / UI /       │  │
│  │  Interconnect / Dialog / Timer... │  │
│  └───────────────────────────────────┘  │
│              ↕                            │
│     Android 系统能力（蓝牙、网络、存储）    │
└─────────────────────────────────────────┘
```

### 2.2 核心概念（"三相之力"）

| 概念 | 说明 |
|------|------|
| **组件边界** | Host 和 Plugin 是两个独立组件，无共享内存、无直接 syscall |
| **WIT 接口** | 插件和宿主之间的接口契约，定义所有可调用函数和数据结构 |
| **future<T>** | 跨组件边界的异步承诺，Rust 侧表现为 `FutureReader<T>` |

### 2.3 关键 API

| API | 用途 | 对导入器的意义 |
|-----|------|:------------:|
| **Transport** | HTTP 请求 | ⭐ 核心：访问教务系统 |
| **Interconnect** | 与手环通信 | ⭐ 核心：推送数据到手环 |
| **UI** | 声明式界面 | 学校选择器、账号输入、导入状态 |
| **Dialog** | 弹窗提示 | 错误提示、成功通知 |
| **Register/Event** | 事件订阅 | 生命周期管理、手环连接事件 |
| **Timer** | 定时任务 | 自动定期导入 |
| **Device** | 设备信息 | 获取已连接的手环设备 |
| **ThirdpartyApp** | 第三方应用交互 | 与 EV课程表手环 App 数据交互 |
| **I18n** | 国际化 | 多语言支持 |

### 2.4 开发环境

```bash
# 安装 Rust
# https://www.rust-lang.org/learn/get-started

# 安装 WASI 目标
rustup target add wasm32-wasip2

# 克隆插件模板
git clone --recurse-submodules https://github.com/AstralSightStudios/AstroBox-NG-Plugin-Template-Rust
cd AstroBox-NG-Plugin-Template-Rust

# 构建
python scripts/build_dist.py --release --package
# 输出: dist/*.abp
```

### 2.5 项目结构

```
ev-schedule-importer/
├── Cargo.toml
├── scripts/                    # 构建辅助脚本
├── src/
│   ├── lib.rs                  # 插件入口（on_load / on_event）
│   ├── logger.rs               # tracing 日志
│   ├── models.rs               # 课程数据模型
│   ├── jwxt/
│   │   ├── mod.rs
│   │   ├── client.rs           # 教务系统 HTTP 客户端 ⭐
│   │   └── parser.rs           # 教务系统 HTML 解析器 ⭐
│   ├── sync/
│   │   ├── mod.rs
│   │   └── engine.rs           # 导入引擎
│   └── ui/
│       ├── mod.rs
│       ├── school_picker.rs    # 学校选择 UI
│       ├── login_form.rs       # 登录表单 UI
│       └── sync_status.rs      # 导入状态 UI
└── wit/                        # (submodule) WIT 接口定义
```

---

## 三、竞品分析

### 3.1 AstroBox 生态中的课程表产品

| 产品名 | 类型 | 同步能力 | 备注 |
|--------|------|:--------:|------|
| **EV课程表** | Vela QuickApp (.rpk) | ❌ 纯手动 | 我们的手环 App |
| **Var课程表** | Vela QuickApp (.rpk) | ✅ 有开放 API | 第三方可接入 |
| 小爱课程表 | 小米官方功能 | ✅ 官方同步 | 需学校主动对接 |

### 3.2 差异化定位

| 维度 | Var课程表 | Ev课程表导入器（V2 插件） |
|------|----------|-------------------------|
| 平台 | 手环 QuickApp | **手机 AstroBox 插件** |
| 导入方式 | 需要开发者写接入代码 | **一键导入，零配置** |
| UI 能力 | 手环小屏 | **手机原生级 UI** |
| 网络能力 | 受限 | **完整 HTTP 客户端** |
| 与 EV课程表集成 | 不集成 | **深度集成**，导入后立即可用 |
| 技术栈 | ES5 JS | **Rust + WASM** |

**核心优势**：
1. **手机端运行**：屏幕大、网络好、算力强
2. **一键导入**：选学校 → 输账号 → 点导入 → 完成
3. **与 EV课程表深度集成**：数据通过 Interconnect 直接推送到手环
4. **Rust 生态**：成熟的 HTTP 客户端和 HTML 解析库

---

## 四、技术架构设计

### 4.1 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     Ev课程表导入器（AstroBox V2 插件）               │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────────────┐      Transport API（HTTP）                │
│  │  UI Layer            │      ──────────────────▶  教务系统         │
│  │  ┌───────────────┐  │                              (方正/青果)    │
│  │  │ 学校选择器     │  │                                          │
│  │  │ 账号输入表单   │  │      Interconnect API                    │
│  │  │ 导入进度条     │  │      ──────────────────▶  手环 EV课程表    │
│  │  │ 结果展示       │  │                              (.rpk)      │
│  │  └───────────────┘  │                                          │
│  └─────────────────────┘                                          │
│                                                                    │
│  ┌─────────────────────┐                                          │
│  │  Sync Engine         │                                          │
│  │  ┌───────────────┐  │                                          │
│  │  │ JwxtClient    │──┼──▶ Transport API → 教务系统登录/请求        │
│  │  │ JwxtParser    │──┼──▶ HTML 解析 → 结构化课程数据               │
│  │  │ CourseMapper  │──┼──▶ 数据映射 → EV课程表格式                  │
│  │  │ SyncScheduler │──┼──▶ Timer API → 定时自动导入               │
│  │  └───────────────┘  │                                          │
│  └─────────────────────┘                                          │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 数据流详解

```
Step 1: 用户在 AstroBox 中打开「Ev课程表导入器」插件
        └─ on_load() → 初始化 Logger → 注册事件

Step 2: UI 展示学校列表 → 用户选择学校 → 输入学号和密码 → 点击「导入」
        └─ on_ui_event("import-click") → 触发导入流程

Step 3: Sync Engine 通过 Transport API 发起 HTTP 请求
        ├─ GET  教务系统登录页 → 提取 __VIEWSTATE 等隐藏字段
        ├─ POST 登录表单 → 获取 Session Cookie
        ├─ GET  课表页面 → 获取 HTML
        └─ 返回原始 HTML

Step 4: JwxtParser 解析 HTML → 提取课程数据
        └─ Vec<Course { name, teacher, classroom, dayOfWeek, startPeriod, endPeriod, weeks }>

Step 5: CourseMapper 转换为 EV课程表数据格式
        └─ JSON 序列化

Step 6: Interconnect API 推送数据到手环
        └─ EV课程表手环 App 接收 → 写入本地存储 → 展示

Step 7: UI 显示导入结果（成功 X 门课程 / 失败原因）
```

### 4.3 关键代码结构

```rust
// src/models.rs — 课程数据模型（参考 class-schedule 的 Course.java）

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Course {
    pub name: String,           // 课程名
    pub teacher: String,        // 教师
    pub classroom: String,      // 教室
    pub day_of_week: u8,        // 1-7 (周一至周日)
    pub start_period: u8,       // 开始节次
    pub end_period: u8,         // 结束节次
    pub weeks: Vec<u16>,        // 上课周次 [1,2,3,...]
    pub week_type: WeekType,    // 单周/双周/全周
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WeekType {
    All,
    Odd,     // 单周
    Even,    // 双周
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchoolConfig {
    pub id: String,
    pub name: String,
    pub login_url: String,
    pub schedule_url: String,
    pub username_field: String,
    pub password_field: String,
    pub schedule_table_selector: String,
    pub cell_field_order: Vec<String>,
    pub hidden_fields: Vec<String>,
}
```

```rust
// src/jwxt/client.rs — HTTP 客户端（参考 class-schedule 的 JwxtClient.java）
// 使用 Transport API 发起 HTTP 请求

use psys_host::transport;

pub struct JwxtClient {
    cookies: String,
}

impl JwxtClient {
    pub async fn login(config: &SchoolConfig, username: &str, password: &str) -> Result<Self> {
        // Step 1: GET 登录页，提取隐藏字段（__VIEWSTATE 等）
        let login_page = transport::fetch(&config.login_url, None).await?;
        let view_state = extract_hidden_field(&login_page, "__VIEWSTATE")?;
        
        // Step 2: POST 登录表单
        let form_body = build_login_form(config, username, password, &view_state);
        let response = transport::fetch(
            &config.login_url,
            Some(&transport::FetchOptions {
                method: "POST",
                headers: &[("Content-Type", "application/x-www-form-urlencoded")],
                body: &form_body,
            }),
        ).await?;
        
        // Step 3: 提取 Cookie，检查登录结果
        let cookies = extract_cookies(&response)?;
        if is_login_failed(&response) {
            return Err(anyhow!("Login failed: invalid credentials"));
        }
        
        Ok(Self { cookies })
    }
    
    pub async fn fetch_schedule(&self, config: &SchoolConfig) -> Result<String> {
        transport::fetch(
            &config.schedule_url,
            Some(&transport::FetchOptions {
                method: "GET",
                headers: &[("Cookie", &self.cookies)],
                body: "",
            }),
        ).await
    }
}
```

```rust
// src/jwxt/parser.rs — HTML 解析器（参考 class-schedule 的 JwxtParser.java）
// 使用 scraper crate 解析 HTML

use scraper::{Html, Selector};

pub fn parse_schedule(html: &str, config: &SchoolConfig) -> Result<Vec<Course>> {
    let document = Html::parse_document(html);
    let table_selector = Selector::parse(&config.schedule_table_selector)?;
    let row_selector = Selector::parse("tr")?;
    let cell_selector = Selector::parse("td")?;
    
    let mut courses = Vec::new();
    
    let table = document.select(&table_selector).next()
        .ok_or_else(|| anyhow!("Schedule table not found"))?;
    
    for (row_idx, row) in table.select(&row_selector).enumerate() {
        for (col_idx, cell) in row.select(&cell_selector).enumerate() {
            let text = cell.text().collect::<String>().trim().to_string();
            if text.is_empty() || text == "&nbsp;" {
                continue;
            }
            
            if let Some(course) = parse_course_cell(&text, config) {
                let mut course = course;
                course.day_of_week = (col_idx + 1) as u8;
                course.start_period = (row_idx + 1) as u8;
                courses.push(course);
            }
        }
    }
    
    Ok(courses)
}

fn parse_course_cell(text: &str, config: &SchoolConfig) -> Option<Course> {
    let lines: Vec<&str> = text.split('\n').filter(|s| !s.trim().is_empty()).collect();
    if lines.len() < 2 {
        return None;
    }
    
    let mut course = Course::default();
    for (i, field) in config.cell_field_order.iter().enumerate() {
        let value = lines.get(i).unwrap_or(&"").trim().to_string();
        match field.as_str() {
            "name" => course.name = value,
            "teacher" => course.teacher = value,
            "classroom" => course.classroom = value,
            _ => {}
        }
    }
    Some(course)
}
```

```rust
// src/lib.rs — 插件入口

use psys_host::{lifecycle, event, ui, interconnect, dialog, transport};

struct EvScheduleImporter;

impl lifecycle::Guest for EvScheduleImporter {
    fn on_load() {
        logger::init();
        tracing::info!("EvScheduleImporter loaded");
        
        // Register event listeners
        event::register_ui_event("import-click");
        event::register_device_event();
        
        // Render main UI
        render_main_ui();
    }
}

impl event::Guest for EvScheduleImporter {
    fn on_ui_event(event_id: String, _data: String) -> FutureReader<String> {
        let (writer, reader) = wit_future::new::<String>(|| String::new());
        
        wit_bindgen::spawn(async move {
            match event_id.as_str() {
                "import-click" => {
                    // Execute import flow
                    let result = sync_engine::execute_sync().await;
                    match result {
                        Ok(count) => {
                            // Push data to band EV课程表
                            interconnect::send_to_device(
                                "ev-schedule",
                                &serde_json::to_string(&result.courses).unwrap()
                            ).await.ok();
                            
                            writer.write(format!("Success: {} courses imported", count)).await.unwrap();
                        }
                        Err(e) => {
                            writer.write(format!("Error: {}", e)).await.unwrap();
                        }
                    }
                }
                _ => {}
            }
        });
        
        reader
    }
}
```

### 4.4 异步模型关键点

AstroBox V2 插件使用 WIT `future<T>` 模型，**不使用 Tokio**：

| 场景 | 正确做法 |
|------|---------|
| 事件回调返回异步结果 | `FutureReader<T>` + `wit_bindgen::spawn` |
| 同步函数中调用异步 Host API | `wit_bindgen::block_on` |
| 发起后台任务 | ❌ 不要用 `tokio::spawn`，用 `wit_bindgen::spawn` |

```rust
// ✅ 正确：事件回调中的异步操作
fn on_ui_event(...) -> FutureReader<String> {
    let (writer, reader) = wit_future::new::<String>(|| String::new());
    wit_bindgen::spawn(async move {
        let result = do_sync().await;
        writer.write(result).await.unwrap();
    });
    reader
}

// ✅ 正确：生命周期函数中调用异步 Host API
fn on_load() {
    wit_bindgen::block_on(async {
        let devices = psys_host::device::list_devices().await;
        // ...
    });
}

// ❌ 错误：不要用 tokio
// tokio::spawn(async { ... });  // 编译目标 wasm32-wasip2 不支持
```

---

## 五、开发计划与时间估算

### 5.1 阶段划分

```
阶段 1：环境搭建 + 学习（1-2 天）
  ├─ 安装 Rust + wasm32-wasip2 target
  ├─ 克隆模板项目，跑通第一个 demo
  ├─ 理解 WIT / FutureReader / wit_bindgen 机制
  └─ 阅读 Transport / Interconnect / UI API 文档

阶段 2：教务系统爬虫移植（2-3 天）
  ├─ 分析 class-schedule 的爬虫逻辑（JwxtClient + JwxtParser）
  ├─ Java → Rust 移植（HTTP 客户端 + HTML 解析）
  ├─ 学校配置 JSON 设计（支持多学校扩展）
  └─ 单元测试（用真实教务系统 HTML 测试解析）

阶段 3：插件 UI 开发（1-2 天）
  ├─ 学校选择器（列表/搜索）
  ├─ 账号密码输入表单
  ├─ 导入进度展示
  └─ 结果页面

阶段 4：Interconnect 对接（1-2 天）
  ├─ 研究 Interconnect API 用法
  ├─ 设计插件 ↔ 手环 EV课程表 数据协议
  ├─ 手环端接收逻辑（可能需要更新 .rpk）
  └─ 联调测试

阶段 5：集成测试 + 打包（1 天）
  ├─ 真实教务系统测试（方正等）
  ├─ 错误处理与边界情况
  ├─ 构建 .abp 包
  └─ 在 AstroBox 中加载测试
```

### 5.2 总时间估算

| 阶段 | 时间 | 难度 |
|------|:----:|:----:|
| 环境搭建 + 学习 | 1-2 天 | ⭐⭐ |
| 爬虫移植（Java→Rust） | 2-3 天 | ⭐⭐⭐⭐ |
| 插件 UI | 1-2 天 | ⭐⭐⭐ |
| Interconnect 对接 | 1-2 天 | ⭐⭐⭐ |
| 集成测试 + 打包 | 1 天 | ⭐⭐ |
| **总计** | **6-10 天** | ⭐⭐⭐ |

---

## 六、竞品应对策略

### 6.1 与 Var课程表的差异化

| 维度 | Var课程表 | Ev课程表导入器（V2 插件） |
|------|----------|-------------------------|
| 运行位置 | 手环（屏幕小、算力弱） | **手机**（屏幕大、算力强） |
| 开发语言 | ES5 JavaScript | **Rust**（性能好、类型安全） |
| 接入方式 | 需要开发者写代码 | **配置化**，加学校只需改 JSON |
| 用户体验 | 手环上操作 | **手机原生 UI**，体验更好 |
| 与 EV课程表关系 | 竞品 | **配套工具**，形成生态闭环 |

### 6.2 核心竞争力

1. **手机端运行**：不受手环性能限制，可以做复杂的 HTML 解析和数据处理
2. **Rust 生态**：`scraper`、`reqwest`、`serde` 等成熟库直接使用
3. **配置化扩展**：新增学校只需添加 JSON 配置，无需发版
4. **与 EV课程表生态闭环**：导入器 → EV课程表，从数据获取到展示一站式
5. **定时自动导入**：通过 Timer API 实现每周自动更新课表

---

## 七、风险与注意事项

### 7.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 教务系统改版 | 爬虫失效 | 配置化设计，改配置而非代码 |
| 教务系统有验证码 | 无法自动登录 | 降级方案：手机浏览器手动登录后粘贴 Cookie |
| WASI 环境库兼容性 | 某些 Rust 库不可用 | 优先使用纯 Rust 库（`scraper`、`serde`），避免依赖系统调用的库 |
| Interconnect API 限制 | 数据推送不稳定 | 设计重试机制 + 本地缓存 |
| `wit_bindgen::block_on` 阻塞 | on_load 卡住 | 避免在生命周期函数中做耗时操作 |

### 7.2 WASI 环境限制

| 限制 | 说明 |
|------|------|
| 无 Tokio 运行时 | 使用 WIT future 模型代替 |
| 无文件系统访问 | 通过 Host API 操作存储 |
| 无直接网络 socket | 通过 Transport API 代理 |
| 无 std::thread | 单线程异步模型 |

### 7.3 手环端适配

EV课程表手环 App 需要配合更新，以支持通过 Interconnect 接收插件推送的数据：
- 新增数据接收接口
- 处理 JSON 格式的课程数据
- 写入本地存储并刷新 UI

---

## 八、与 class-schedule 代码的移植方案

### 8.1 可移植的代码

| class-schedule 文件 | 移植内容 | Rust 实现 |
|---|---|---|
| `JwxtClient.java` | HTTP 登录 + 请求逻辑 | `src/jwxt/client.rs`（Transport API） |
| `JwxtParser.java` | HTML 解析规则 | `src/jwxt/parser.rs`（`scraper` crate） |
| `Course.java` | 数据模型 | `src/models.rs`（Rust struct + serde） |
| `ShareActivity.java` | 数据导出格式 | `src/sync/serializer.rs` |

### 8.2 移植要点

1. **Jsoup → scraper**：两者 API 相似，都是 CSS 选择器 + DOM 遍历
2. **OkHttp → Transport API**：AstroBox Host 提供的 HTTP 能力
3. **Gson → serde_json**：Rust 标准 JSON 序列化
4. **Android SharedPreferences → Host Storage API**：持久化配置

---

## 九、总结与建议

### 9.1 核心结论

1. **AstroBox V2 的插件系统是真正的游戏规则改变者**：插件运行在手机上，拥有完整能力和 Rust 生态
2. **class-schedule 的爬虫逻辑可以直接移植**：Java → Rust，Jsoup → scraper，OkHttp → Transport API
3. **导入器作为 V2 插件是最佳形态**：比 V1 方案（Vela QuickApp + Web 后端）更简洁、更强大
4. **竞品 Var课程表运行在手环上**，而我们在手机上，体验和性能都碾压

### 9.2 推荐执行路径

```
Step 1: 搭建 Rust 开发环境 + 跑通模板项目（1天）
Step 2: 移植 class-schedule 爬虫逻辑到 Rust（3天）
Step 3: 开发插件 UI（2天）
Step 4: 对接 Interconnect API + 更新手环 .rpk（2天）
Step 5: 测试 + 打包 .abp + 发布（1天）
```

### 9.3 定价建议

| 方案 | 说明 |
|------|------|
| 插件免费 | AstroBox 插件市场免费下载 |
| EV课程表高级版收费 | 维持 ¥1 永久激活 |
| 插件引导激活 | 导入完成后引导用户激活 EV课程表高级版 |

---

## 附录 A：项目结构（最终态）

```
ev-schedule-importer/
├── Cargo.toml
├── scripts/
│   └── build_dist.py              # 构建脚本 → 输出 .abp
├── src/
│   ├── lib.rs                     # 插件入口（lifecycle + event impl）
│   ├── logger.rs                  # tracing 日志
│   ├── models.rs                  # 数据模型（Course, SchoolConfig）
│   ├── config.rs                  # 学校配置加载
│   ├── jwxt/
│   │   ├── mod.rs
│   │   ├── client.rs              # HTTP 客户端（Transport API）
│   │   └── parser.rs             # HTML 解析器（scraper）
│   ├── sync/
│   │   ├── mod.rs
│   │   ├── engine.rs             # 导入引擎（编排登录→爬取→解析→推送）
│   │   └── scheduler.rs          # 定时导入（Timer API）
│   └── ui/
│       ├── mod.rs
│       ├── main_page.rs          # 主界面
│       ├── school_picker.rs      # 学校选择器
│       ├── login_form.rs         # 登录表单
│       └── sync_result.rs        # 导入结果
├── wit/                           # (submodule) WIT 接口定义
└── schools.json                   # 学校教务系统配置列表
```

## 附录 B：关键参考链接

| 资源 | 链接 |
|------|------|
| class-schedule 源码 | `https://github.com/guomengtao/class-schedule` |
| AstroBox V2 插件文档 | `https://abox.run/docs/plugin-dev` |
| 插件模板仓库 | `https://github.com/AstralSightStudios/AstroBox-NG-Plugin-Template-Rust` |
| AstroBox 官网 | `https://astrobox.online/` |
| Rust 安装指南 | `https://www.rust-lang.org/learn/get-started` |
| WASI Preview 2 | `https://github.com/WebAssembly/WASI` |
| scraper crate | `https://crates.io/crates/scraper` |

## 附录 C：WIT 接口速查（导入器用到的）

```
// Transport — HTTP 请求
transport::fetch(url, options) -> future<string>

// Interconnect — 与手环通信
interconnect::send_to_device(app_id, data) -> future<()>
interconnect::on_device_data(callback)

// UI — 声明式界面
ui::element::new(ElementType, content)
ui::element::on(Event, event_id)
ui::render(element)

// Dialog — 弹窗
dialog::show_dialog(DialogType, DialogStyle, DialogInfo) -> future<string>

// Timer — 定时任务
timer::set_interval(ms, callback)

// Register/Event — 事件系统
event::register_ui_event(event_id)
event::register_device_event()
event::on_ui_event(event_id, data) -> future<string>
```