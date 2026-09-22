# ABP 插件安装排错手册

> 适用：`tools/ev-schedule-sync/astrobox-build/astrobox-plugin/`
> 背景：这个插件「以前总是装不上」，现在能稳定装上。**本文记录所有踩过的坑，按现象 → 原因 → 检查 → 修复组织**。
> 排错时先看 §0 一分钟自查，90% 的问题在那儿。
> 版本记录：v1.0.20 起，插件主界面右上角会显示版本号，可直接用它核对设备里装的是哪个版本。

---

## 目录

- [§0 一分钟自查清单](#0-一分钟自查清单先看这个)
- [§1 现象：插件列表里完全看不到](#1-现象插件列表里完全看不到)
- [§2 现象：编译就失败根本打不出包](#2-现象编译就失败根本打不出包)
- [§3 现象：装上了但界面空白没内容](#3-现象装上了但界面空白没内容)
- [§4 现象：能打开一操作就卡死崩溃](#4-现象能打开一操作就卡死崩溃)
- [§5 现象：改了代码但设备上没变化](#5-现象改了代码但设备上没变化)
- [§6 成功配方 golden recipe](#6-成功配方-golden-recipe)
- [§7 打包后必做的内容和自检命令](#7-打包后必做的内容自检命令)
- [§8 附录字段速查表](#8-附录字段速查表)

---

## 0. 一分钟自查清单（先看这个）

装不上时，按顺序过这 9 项。**前 4 项占了我遇到的绝大多数故障**。

```bash
cd tools/ev-schedule-sync/astrobox-build/astrobox-plugin
```

| # | 检查项 | 正确值 | 命令 / 位置 |
|:-:|--------|:------:|------------|
| 1 | `manifest.json` 的 `api_level` | **2**（不是 3） | `grep api_level manifest.json` |
| 2 | `Cargo.toml` 的 `edition` | **"2021"**（不是 2024） | `grep edition Cargo.toml` |
| 3 | `src/lib.rs` 末尾有没有 `export!(...)` | **必须有** | `tail -3 src/lib.rs` |
| 4 | `manifest.json` 的 `version` | 比上一版**大** | `grep '"version"' manifest.json` |
| 5 | `manifest.json` 的 `entry` | 与包内 wasm 文件名**完全一致** | `grep entry manifest.json` |
| 6 | 包内是否三件套齐全 | manifest + icon + wasm | `unzip -l dist/xxx.abp` |
| 7 | 包内 wasm 是不是**新编译**的 | md5 等于 target 里的 | 见 §7 |
| 8 | 依赖是否被精简掉了 | anyhow / serde / serde_json | `grep -A4 dependencies Cargo.toml` |
| 9 | `crate-type` | `["cdylib"]` | `grep crate-type Cargo.toml` |

> ⚠️ **第 3 项和第 8 项最容易忽略**：它们不会让"编译报错"看起来像配置问题，
> 表现往往就是「装完插件不出现」或「装上一打开就崩」。

---

## 1. 现象：插件列表里完全看不到

这是最常遇到的现象。按概率排序：

### 1.1 ⭐⭐⭐⭐⭐ `api_level` 与 WIT world 不匹配（头号杀手）

**这是本插件历史上"总是装不上"的根本原因。**

`api_level` 是给宿主的**承诺书**："请用 v3 版 API 跟我对话"。
但实际代码里 `wit_bindgen::generate!` 连的是 `psys-world`（v1/v2 接口）。
宿主按 v3 准备环境 → 插件张口要 v1 接口 → **组件实例化阶段就失败** → 插件列表里压根不出现。

| WIT world | 导入的 host API | 导出的 plugin 接口 | 配哪个 api_level |
|-----------|:--------------:|:-----------------:|:---------------:|
| `psys-world` | `ui` + `ui-v3` | `plugin-event` | **2** |
| `psys-world-v2` | `ui` + `ui-v3` | `plugin-event` | **2** |
| `psys-world-v3` | 仅 `ui-v3` | `plugin-event-v3` | 3 |

**修复（本项目采用）**：保持 `psys-world`，把 manifest 改成 `api_level: 2`。

```json
"api_level": 2
```

> 反过来也可以：改用 `psys-world-v3` + 把所有 `psys_host::ui` 换成 `psys_host::ui_v3`。
> 但那样要重写全部 UI 代码，除非平台强制，否则别走这条路。

### 1.2 ⭐⭐⭐⭐ Rust `edition = "2024"`

`wasm32-wasip2` 目标对新 edition 支持滞后，2024 edition 下生成的组件可能加载失败。

```toml
edition = "2021"   # ✅ 官方模板用的版本
```

### 1.3 ⭐⭐⭐ 版本号没自增

宿主**大概率按 package + version 判重**，同版本会被判成"已装"而跳过安装。
代码改了但版本号没动 = 装完还是旧的，看起来就像"没装成功"。

```json
"version": "1.0.20"   // 每次打包都要比上一版大
```

### 1.4 ⭐⭐ `entry` 与实际 wasm 文件名不一致

manifest 说入口是 `ev-schedule-sync.wasm`，包里如果叫别的名字，宿主找不到入口。

注意 Cargo 包名 `ev-schedule-sync` 的产物是 **下划线** `ev_schedule_sync.wasm`，
所以打包前必须把它改名复制成 `ev-schedule-sync.wasm`（中划线）：

```bash
cp target/wasm32-wasip2/release/ev_schedule_sync.wasm dist/ev-schedule-sync.wasm
```

### 1.5 ⭐⭐ ABP 包内容不全 / 用了旧 wasm

三件套缺一不可，且 wasm 必须是刚编译的。见 §7 的自检命令。

---

## 2. 现象：编译就失败，根本打不出包

### 2.1 `failed to find export of interface astrobox:psys-plugin/lifecycle function on-load`

```
error: failed to find export of interface `astrobox:psys-plugin/lifecycle` function `on-load`
```

**原因**：`src/lib.rs` **没有调用 `export!` 宏**。

`impl lifecycle::Guest for XxxPlugin` 只是实现了 trait，
**必须**在文件末尾用 `export!(XxxPlugin)` 把实现真正导出，否则 wasm 里一个 Guest 函数都没有。

```rust
// src/lib.rs 最后一行
export!(EvScheduleSyncPlugin);
```

> 这个坑特别阴：它是**链接期**错误，而且一旦 lib.rs 被改写（比如切 HelloWorld 调试版再切回来）
> 很容易把这行弄丢。每次恢复全功能版后都应 `tail -3 src/lib.rs` 确认一眼。

### 2.2 `failed to resolve: use of undeclared crate anyhow / serde`

**原因**：为了跑极简 HelloWorld 版，`Cargo.toml` 的依赖被精简过，
切回全功能代码时忘了加回来。

恢复全功能版时必须补齐：

```toml
[dependencies]
wit-bindgen = { version = "0.57", features = ["async", "async-spawn"] }
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### 2.3 宿主 API 签名不对

**DESIGN.md 里写的接口名是伪代码，照抄必错。** 真实签名（以 `wit/deps/astrobox-psys-host.wit` 为准）：

| 用途 | 真实函数 | 参数类型 |
|------|---------|---------|
| 全部已配对设备 | `device::get_device_list()` | — |
| 当前在线设备 | `device::get_connected_device_list()` | — |
| 设备已装应用列表 | `thirdpartyapp::get_thirdparty_app_list(addr)` | **`&str`** |
| 写剪贴板 | `clipboard::write_text(text)` | **`&str`** |

> ⚠️ 参数是 `&str` 不是 `String`。传 `String` 会报 mismatched types。
> ❌ WIT 里**不存在** `thirdpartyapp::is_installed()`，只能拉应用列表自己匹配包名。

**不知道某个宿主函数的签名时，用这招探测** —— 故意类型不匹配，让编译器把真实类型打印出来：

```rust
let x = crate::astrobox::psys_host::device::get_connected_device_list();
let _: () = x;   // 报错信息里会显示实际类型
```

---

## 3. 现象：装上了但界面空白、没内容

### 3.1 顶层元素是 `Span`

`Span` 是内联文本元素，没有宽度高度。作为顶层渲染目标时布局引擎可能把它算成 0 尺寸 → **看不见**。

✅ **始终用 `Div` 作为根容器**，`Span` / `Input` / `Button` 挂在它下面：

```rust
let mut root = ui::Element::new(ui::ElementType::Div, None).padding(16).bg("#1e1e1e");
root = root.child(ui::Element::new(ui::ElementType::Span, Some("内容")).size(16));
psys_host::ui::render(element_id, root);
```

### 3.2 页面配色和背景融为一体

黑色 UI 上用深色文字 = 看起来"什么都没有"。渲染时**显式指定 `text_color`**。

---

## 4. 现象：能打开，一操作就卡死 / 崩溃

### 4.1 ⭐ `std::sync::Mutex` 死锁（本插件真的踩过）

**`std::sync::Mutex` 不可重入。** 持有锁的期间不能再 lock 同一个锁，否则永久卡住。

典型错误写法：

```rust
pub fn render_main_ui(element_id: &str) {
    let state = STATE.lock().unwrap();          // ← 上锁
    let page = build_main_page();               // ← 这个函数内部又 STATE.lock() → 死锁
}
```

正确写法 —— **先取快照，释放锁，再渲染**：

```rust
pub fn render_main_ui(element_id: &str) {
    let (page, show_dialog) = {
        let state = STATE.lock().unwrap();
        (state.page.clone(), state.show_demo_dialog)
    };                                          // ← 锁在这里释放
    let container = match page { /* 这里再各自 lock */ };
}
```

配套铁律：**async handler 里绝不能跨 `.await` 持有 `MutexGuard`**。
一律用「短作用域取快照 → await → 重新 lock 写回」：

```rust
let (a, b) = { let s = STATE.lock().unwrap(); (s.a.clone(), s.b.clone()) };
host_api(&a).await;                    // 不持有锁
STATE.lock().unwrap().result = ...;    // 重新上锁写回
```

### 4.2 渲染时忘了 `render()`

事件处理返回 `true` 表示"需要重绘"，但真正要调用 `psys_host::ui::render()` 才会刷新界面。

---

## 5. 现象：改了代码，但设备上没变化

按顺序排查：

1. **版本号没自增** → 宿主跳过安装（见 §1.3）
2. **忘记 `cp` 新 wasm 到 `dist/`** → 打包的是旧产物
   ```bash
   md5 target/wasm32-wasip2/release/ev_schedule_sync.wasm dist/ev-schedule-sync.wasm
   # 两个 md5 必须一致
   ```
3. **打进了另一个 .abp 文件** —— `dist/` 里躺着一堆历史包，别装错文件
4. **`cargo build` 缓存** —— 极少数情况下需要 `cargo clean`，一般不需要

---

## 6. 成功配方（golden recipe）

**照抄这套配置，插件就能装上。** 这是目前验证通过的唯一组合：

### `manifest.json`

```json
{
  "name": "EV 课程表同步器",
  "icon": "icon.png",
  "version": "1.0.20",
  "description": "导入导出课程表 - 支持 WakeUp、sgschedule、StarLink、CSES、EV 课程表格式",
  "author": "EV Team",
  "website": "https://app-auth.gudq.com/user-guide.html?r=astrobox",
  "entry": "ev-schedule-sync.wasm",
  "wasi_version": 2,
  "api_level": 2,
  "permissions": ["network", "fs"],
  "additional_files": []
}
```

### `Cargo.toml`

```toml
[package]
name = "ev-schedule-sync"
version = "0.1.0"
edition = "2021"                 # ← 必须是 2021

[lib]
crate-type = ["cdylib"]          # ← 必须是 cdylib

[dependencies]
wit-bindgen = { version = "0.57", features = ["async", "async-spawn"] }
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### `src/lib.rs`

```rust
wit_bindgen::generate!({
    path: "wit",
    world: "psys-world",          // ← 必须配 api_level: 2
    generate_all,
});

// ... 实现 lifecycle::Guest / event::Guest ...

export!(EvScheduleSyncPlugin);    // ← 最后一行，缺了就链接失败
```

### 完整打包命令

```bash
cd tools/ev-schedule-sync/astrobox-build/astrobox-plugin

# 1. 编译
cargo build --target wasm32-wasip2 --release

# 2. 同步三件套到 dist（wasm 要改名为 manifest.entry 指定的名字）
cp manifest.json dist/
cp icon.png dist/
cp target/wasm32-wasip2/release/ev_schedule_sync.wasm dist/ev-schedule-sync.wasm

# 3. 打包（ABP 就是普通 ZIP）
cd dist
zip -X -r EV-Schedule-Sync-v1.0.20.abp manifest.json icon.png ev-schedule-sync.wasm
```

### EV 课程表的识别包名

设备端检测 EV 是否已安装，靠匹配包名（真实值，来自 `github.com/guomengtao/class-schedule`）：

```
com.application.watch.classschedule        # 应用名 "Ev课程表"
```

> ⚠️ DESIGN.md §1.4 里写的 `com.ev.schedule` 是**错的**，不要用它。

---

## 7. 打包后必做的内容自检命令

**别急着传设备，先本地验一遍。**

### 7.1 包结构与版本

```bash
unzip -l dist/EV-Schedule-Sync-v1.0.20.abp
# 必须看到：manifest.json / icon.png / ev-schedule-sync.wasm

unzip -p dist/EV-Schedule-Sync-v1.0.20.abp manifest.json | grep -E 'api_level|version|entry'
```

### 7.2 wasm 是否为最新

```bash
md5 target/wasm32-wasip2/release/ev_schedule_sync.wasm dist/ev-schedule-sync.wasm
# 两个必须一致，否则说明 dist 里是旧产物
```

### 7.3 验证新代码真的进了包

```bash
mkdir -p /tmp/chk && unzip -o -q dist/EV-Schedule-Sync-v1.0.20.abp -d /tmp/chk

python3 -c "
d = open('/tmp/chk/ev-schedule-sync.wasm','rb').read()
for t in ['选择目标设备', '未找到 EV 课程表', 'scheduleName', 'v1.0.20']:
    print(d.count(t.encode('utf-8')), '<-', t)
print('wasm size:', len(d))
"
```

> ⚠️ **重要陷阱**：macOS 的 `grep -a` 搜二进制里的中文 UTF-8 **不可靠**（能返回 0 但实际存在），
> 必须用 Python 直接按字节比对，见上面的写法。
>
> ⚠️ **另一个陷阱**：字符串**等值比较**（`x == "常量"`）会被 LLVM 内联成立即数写进 code section，
> 不在 data 段，导致搜出来是 0 次。用 `contains` 或拼进 UI 文案/错误信息里的字符串才会完整保留。
> **搜不到某个常量，不代表代码没编译进去**，别据此误判。

### 7.4 装到设备后怎么核对版本

v1.0.20 起，**插件主界面顶部会显示版本号**。打开插件看一眼，就知道设备上装的是哪一版，
不用再猜"到底装没装上"。

---

## 8. 附录：字段速查表

### manifest.json

| 字段 | 值 | 踩坑点 |
|------|:--:|--------|
| `api_level` | `2` | 配 `psys-world`；填 3 就装不上 |
| `wasi_version` | `2` | — |
| `entry` | `ev-schedule-sync.wasm` | 必须与包内实际文件名一字不差 |
| `version` | 递增 | 不递增 = 宿主判为已装，不更新 |
| `icon` | `icon.png` | 文件必须在包内 |
| `name` | 任意 | — |
| `website` | `https://app-auth.gudq.com/user-guide.html?r=astrobox` | 用户可点击查看使用说明 |

### Cargo.toml

| 字段 | 值 | 踩坑点 |
|------|:--:|--------|
| `edition` | `"2021"` | 2024 会加载失败 |
| `crate-type` | `["cdylib"]` | 不是 rlib，否则不出 wasm |
| `name` | `ev-schedule-sync` | 产物是**下划线** `ev_schedule_sync.wasm` |

### 关键接口备忘

| 项目 | 值 |
|------|:--:|
| WIT world | `psys-world` |
| 导出宏 | `export!(EvScheduleSyncPlugin);`（**必须**） |
| EV 包名 | `com.application.watch.classschedule` |
| 根 UI 容器 | `ElementType::Div`（不要用 Span 当根） |

---

## 相关文档

| 文件 | 用途 |
|------|------|
| `DESIGN.md` | 功能设计（注意：里面的 WIT 调用示例是伪代码，已加校正注释） |
| `HELLOWORLD-分析.md` | 早期排错分析存档 |
| `HELLOWORLD-成功记录.md` | v1.0.13 首次装成功的记录 |
| `helloworld-backup/` | HelloWorld 极简版源码，**排查平台兼容性时可切回去用** |

> **最后一条经验**：一旦全功能版装不上，先用 `helloworld-backup/` 的极简版（只渲染一行文字）跑一遍。
> 极简版能装上 = 平台链路（api_level / edition / 打包）没问题，问题在业务代码；
> 极简版也装不上 = 一定是 §0 那 9 项配置里的某一项。
