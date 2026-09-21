# HelloWorld 插件安装成功 — 经验记录

> 日期：2026-09-21
> 版本：1.0.13
> 问题：HelloWorld 极简版插件打包后安装到 AstroBox，插件列表不显示

---

## 一、问题根因

| 配置项 | 错误值 | 正确值 | 所在文件 |
|--------|:-----:|:-----:|------|
| `api_level` | `3` | `2` | `manifest.json` |
| `edition` | `"2024"` | `"2021"` | `Cargo.toml` |
| WIT world | `psys-world` | ✅ 不变 | `src/lib.rs` |

核心矛盾：`api_level: 3` 告诉 AstroBox 宿主“用 v3 版 API”，但代码里 `wit_bindgen::generate!` 连接的是 `psys-world`（v1/v2 版 API）。宿主只给 v3 接口，插件却要调 v1 接口，加载阶段就失败了。

---

## 二、修复步骤

### 第 1 步：对齐 api_level

`manifest.json`：

```json
"api_level": 2  // 原来是 3，改为 2 以匹配 psys-world
```

### 第 2 步：回退 Rust edition

`Cargo.toml`：

```toml
edition = "2021"  // 原来是 "2024"，2021 是 wasm32-wasip2 的稳定版本
```

### 第 3 步：版本号自增

`manifest.json` 和 `dist/manifest.json`：

```json
"version": "1.0.13"  // 原来是 1.0.12
```

### 第 4 步：编译 + 打包

```bash
cd tools/ev-schedule-sync/astrobox-build/astrobox-plugin

# 编译 wasm
cargo build --target wasm32-wasip2 --release

# 复制 wasm 到 dist
cp target/wasm32-wasip2/release/ev_schedule_sync.wasm dist/

# 打包 ABP
cd dist
zip EV-Schedule-Sync.abp manifest.json icon.png ev-schedule-sync.wasm
```

输出：

```
adding: manifest.json (deflated 30%)
adding: icon.png (deflated 0%)
adding: ev-schedule-sync.wasm (deflated 68%)
-rw-r--r--  241319 bytes  EV-Schedule-Sync.abp
```

---

## 三、验证结果

- 打包出的 `EV-Schedule-Sync.abp`（241KB）安装到 AstroBox 后，插件列表**正常显示**
- HelloWorld 界面渲染正常

---

## 四、关键教训

### 4.1 api_level 与 WIT world 必须匹配

| api_level | 对应 WIT world | 说明 |
|:---------:|:-------------:|------|
| `2` | `psys-world` / `psys-world-v2` | 导入 `ui` + `ui-v3`，导出 `plugin-event` |
| `3` | `psys-world-v3` | 仅导入 `ui-v3`，导出 `plugin-event-v3` |

混用 = 插件不可见或崩溃。这是最常见也最隐蔽的错误。

### 4.2 不要用太新的 Rust edition

`wasm32-wasip2` 目标对 Rust 新 edition 的支持有滞后。`edition = "2021"` 是最安全的选择。

### 4.3 极简 HelloWorld 是调试利器

一旦全功能版本出问题，先用最小代码（只渲染一段文字）验证 WIT 接口、api_level、编译链是否正常，能快速定位问题到底是“代码逻辑错误”还是“平台兼容性错误”。

### 4.4 ABP = ZIP

ABP 就是普通 ZIP 文件，包含：
- `manifest.json` — 声明 api_level、版本、入口 wasm 文件名
- `icon.png` — 插件图标
- `*.wasm` — 编译产物，文件名必须与 manifest 中 `entry` 一致

可以用 `unzip -l xxx.abp` 或 Python `zipfile` 检查内容。

---

## 五、相关文件

| 文件 | 说明 |
|------|------|
| `HELLOWORLD-分析.md` | 详细分析文档（所有可能原因逐一排查） |
| `manifest.json` | 插件声明（api_level=2, v1.0.13） |
| `Cargo.toml` | Rust 构建配置（edition=2021） |
| `src/lib.rs` | HelloWorld 极简版代码 |
| `dist/EV-Schedule-Sync.abp` | 修复后的可安装包 |