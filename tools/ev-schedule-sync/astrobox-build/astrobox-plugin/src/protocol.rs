// EV课程表 同步对接协议 v1 —— 见仓库根 `docs/` 下的《EV课程表 同步对接协议文档》
//
// 通道：Vela `system.interconnect`；报文：JSON 字符串；双向。
//   插件 → 手环：{ "action": "import" | "export" | "update_settings", "payload": { } }
//   手环 → 插件：{ ok, count?, reason?, action?, version?, data? }
//
// 要点备忘：
// - 不带 `action` 的报文手环按 `import` 处理（兼容旧版）。
// - `import` 是**覆盖式**导入（不是追加），手环写盘前会自动备份。
// - v1 忽略 `weeks` / `weekType`，发了也没用，所以这里干脆不发。
// - `day` 支持 1~7 / "星期一" / "Monday"；时间支持三种写法，这里统一用
//   `startTime` + `endTime`（文档建议优先用这种，避免依赖手环作息表）。
// - 接收回包需要先 `register::register_interconnect_recv(addr, 包名)`。

use serde::Deserialize;
use serde_json::json;
use crate::models::{UnifiedCourse, WeekType};

// ══════════════════════════ 构造报文 ══════════════════════════

/// `{action:"import", payload:{courses:[...]}}`
pub fn build_import_message(courses: &[UnifiedCourse]) -> String {
    let arr: Vec<serde_json::Value> = courses
        .iter()
        .map(|c| {
            let mut m = serde_json::Map::new();
            m.insert("name".into(), json!(c.name));
            m.insert("day".into(), json!(c.day));
            m.insert("startTime".into(), json!(c.start_time));
            m.insert("endTime".into(), json!(c.end_time));
            if !c.teacher.is_empty() {
                m.insert("teacher".into(), json!(c.teacher));
            }
            if !c.location.is_empty() {
                m.insert("location".into(), json!(c.location));
            }
            // remark → notes（协议的备注字段名）
            if let Some(ref r) = c.remark {
                if !r.is_empty() {
                    m.insert("notes".into(), json!(r));
                }
            }
            serde_json::Value::Object(m)
        })
        .collect();

    json!({ "action": "import", "payload": { "courses": arr } }).to_string()
}

/// `{action:"export"}` —— 请求手环把当前课表与配置回传
pub fn build_export_request() -> String {
    json!({ "action": "export" }).to_string()
}

/// `{action:"ping"}` —— 通道探针（联调第一步，最快往返）
pub fn build_ping_request() -> String {
    json!({ "action": "ping" }).to_string()
}

/// `{action:"update_settings", payload:{...}}`
///
/// 只传调用方需要的字段。**改 homepage 时必须传完整对象**（读-改-写），
/// 否则会丢掉其余配置；这里用 Option 区分「不改」与「改成空」。
pub fn build_update_settings(
    nickname: Option<&str>,
    homepage_full: Option<&str>,
    homepage_template: Option<&str>,
    base_font_size: Option<u32>,
) -> String {
    let mut payload = serde_json::Map::new();

    if let Some(n) = nickname {
        payload.insert("nickname".into(), json!(n));
    }
    // homepage 是外部给的完整 JSON 文本，原样嵌入，避免插件侧重建导致丢字段
    if let Some(h) = homepage_full {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(h) {
            payload.insert("homepage".into(), v);
        }
    }
    if let Some(t) = homepage_template {
        payload.insert("homepageTemplate".into(), json!(t));
    }
    if let Some(f) = base_font_size {
        payload.insert("baseFontSize".into(), json!(f));
    }

    json!({ "action": "update_settings", "payload": payload }).to_string()
}

// ══════════════════════════ 解析回包 ══════════════════════════

/// 手环回包的通用头部（import / update_settings 都只用到这些字段）
#[derive(Debug, Deserialize, Default)]
pub struct BasicResponse {
    pub ok: Option<bool>,
    pub count: Option<u32>,
    pub reason: Option<String>,
}

impl BasicResponse {
    /// 给用户看的一行结果
    pub fn describe(&self, success_hint: &str) -> String {
        if self.ok.unwrap_or(false) {
            match self.count {
                Some(n) => format!("{}，共 {} 门", success_hint, n),
                None => success_hint.to_string(),
            }
        } else {
            let reason = self.reason.clone().unwrap_or_else(|| "未知原因".to_string());
            format!("失败：{}（{}）", reason, reason_hint(&reason))
        }
    }
}

/// 常见失败原因 → 中文提示（协议文档 §1.2 的取值）
fn reason_hint(reason: &str) -> &'static str {
    match reason {
        "no courses" => "手环没解析到课程",
        "convert empty" => "格式转换后为空",
        "write failed" => "手环写入失败",
        "backup failed" => "手环备份旧课表失败",
        "read failed" => "手环读取失败",
        "empty" => "报文为空",
        "no known field" => "没有可识别的字段",
        _ => "详见协议文档",
    }
}

/// export 回包：`{ ok, action:"export", version, scopes?, data:{...} }`
///
/// 注意：`ok` / `version` 等字段手环侧可能给数字也可能给字符串（历史上有过 `"890"` 这类），
/// 所以数值字段一律先收成 `serde_json::Value`，用 `json_u32` / `json_bool` 转换 ——
/// 一个类型不匹配会让**整个** export 回包反序列化失败，代价太大。
#[derive(Debug, Deserialize)]
pub struct ExportResponse {
    pub ok: Option<serde_json::Value>,
    pub action: Option<String>,
    pub version: Option<serde_json::Value>,
    pub data: Option<ExportData>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportData {
    pub schedule: Option<Vec<DaySchedule>>,
    pub nickname: Option<serde_json::Value>,
    /// 首页设置：字段随版本变化，**必须原样保存原样回写**，故用裸 JSON
    pub homepage: Option<serde_json::Value>,
    #[serde(rename = "homepageTemplate")]
    pub homepage_template: Option<serde_json::Value>,
    #[serde(rename = "baseFontSize")]
    pub base_font_size: Option<serde_json::Value>,
    /// 版本号（只读）：随 export 一起回传，插件用它判断手环端能力
    #[serde(rename = "versionName")]
    pub version_name: Option<serde_json::Value>,
    #[serde(rename = "versionCode")]
    pub version_code: Option<serde_json::Value>,
}

/// `Value` → `u32`：兼容数字与数字字符串
pub fn json_u32(v: &Option<serde_json::Value>) -> Option<u32> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_u64().map(|x| x as u32),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u32>().ok(),
        _ => None,
    }
}

/// `Value` → `bool`：兼容 true/false 与 "true"/"false"/1/0
pub fn json_bool(v: &Option<serde_json::Value>) -> Option<bool> {
    match v {
        Some(serde_json::Value::Bool(b)) => Some(*b),
        Some(serde_json::Value::Number(n)) => n.as_u64().map(|x| x != 0),
        Some(serde_json::Value::String(s)) => match s.trim().to_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// `Value` → `String`：数字/字符串都收（`versionName` 之类的容错）
pub fn json_string(v: &Option<serde_json::Value>) -> Option<String> {
    match v {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        Some(serde_json::Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct DaySchedule {
    pub day: Option<String>,
    pub classes: Option<Vec<ClassEntry>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ClassEntry {
    pub id: Option<String>,
    pub name: Option<String>,
    /// 形如 "08:00 - 08:45"
    pub time: Option<String>,
    pub teacher: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
}

/// 统计 export 回包里一共有多少门课
pub fn count_export_classes(data: &ExportData) -> usize {
    data.schedule
        .as_ref()
        .map(|days| {
            days.iter()
                .map(|d| d.classes.as_ref().map(|c| c.len()).unwrap_or(0))
                .sum()
        })
        .unwrap_or(0)
}

/// 把 export 回包转成一行摘要（用于状态栏）
pub fn summarize_export(data: &ExportData) -> String {
    let total = count_export_classes(data);
    let nickname = json_string(&data.nickname).unwrap_or_else(|| "未设置".to_string());
    format!("读到 {} 门课程，昵称：{}", total, nickname)
}

// ══════════════════════════ 宿主事件信封 ══════════════════════════

/// 解开宿主 `EventType::InterconnectMessage` 的事件信封，取出真正的业务报文。
///
/// 宿主给 `on_event` 的 `event_payload` **不是**业务 JSON，而是一个事件对象：
/// ```json
/// {"addr":"3333238b-…","payloadHex":"7b226f6b22…","payloadText":"{\"ok\":true,…}"}
/// ```
/// 历史 bug（v1.0.56 之前一直存在）：插件直接把整个信封当业务报文喂给各 `parse_*`，
/// 于是 export/ping/update_settings 的回包**全部**被判为「无法识别」，
/// 最后又因为 `BasicResponse` 字段全 `Option` 而被伪装成「收到 basic 回包」，
/// 表象就是"通道不通、永远读不到数据"。实际通道一直是好的。
///
/// 取值优先级：`payloadText` → `payloadHex`（hex 解码）→ 原样返回。
pub fn decode_event_payload(raw: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    if !v.is_object() {
        return raw.to_string();
    }

    if let Some(t) = v.get("payloadText").and_then(|x| x.as_str()) {
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Some(hex) = v.get("payloadHex").and_then(|x| x.as_str()) {
        if let Some(text) = hex_to_utf8(hex) {
            return text;
        }
    }
    raw.to_string()
}

/// hex 字符串 → UTF-8 字符串（宿主用 `payloadHex` 传原始字节）
pub fn hex_to_utf8(hex: &str) -> Option<String> {
    let bytes = hex_to_bytes(hex)?;
    String::from_utf8(bytes).ok()
}

fn hex_to_bytes(hex: &str) -> Option<Vec<u8>> {
    let s = hex.trim();
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = hex_val(b[i])?;
        let lo = hex_val(b[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// 解析回包字符串，失败时给出带原文的提示
pub fn parse_export_response(raw: &str) -> Result<ExportResponse, String> {
    serde_json::from_str(raw)
        .map_err(|e| format!("回包解析失败：{}（原文前 80 字：{}）", e, truncate(raw, 80)))
}

/// basic 回包：`{ ok, count?, reason? }`
///
/// ⚠️ 必须显式要求 `ok` 存在。`BasicResponse` 的字段全是 `Option`，serde 对未知字段又是忽略，
/// 所以**任何** JSON 对象（包括宿主事件信封）都能"解析成功" —— 这是历史 bug 的根源：
/// export 回包解析失败时会落到这里，被伪装成「收到 basic 回包」，错误被静默吃掉。
pub fn parse_basic_response(raw: &str) -> Result<BasicResponse, String> {
    let v: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("回包解析失败：{}（原文前 80 字：{}）", e, truncate(raw, 80)))?;
    if !v.is_object() {
        return Err(format!("回包不是 JSON 对象（原文前 80 字：{}）", truncate(raw, 80)));
    }
    if v.get("ok").is_none() {
        return Err(format!(
            "回包缺少 ok 字段，不能当作 basic 响应（原文前 80 字：{}）",
            truncate(raw, 80)
        ));
    }
    serde_json::from_value(v)
        .map_err(|e| format!("回包解析失败：{}（原文前 80 字：{}）", e, truncate(raw, 80)))
}

/// ping 回包：`{ ok, pong, versionName, versionCode }`
#[derive(Debug, Deserialize)]
pub struct PingResponse {
    pub ok: Option<serde_json::Value>,
    pub pong: Option<serde_json::Value>,
    #[serde(rename = "versionName")]
    pub version_name: Option<serde_json::Value>,
    #[serde(rename = "versionCode")]
    pub version_code: Option<serde_json::Value>,
}

pub fn parse_ping_response(raw: &str) -> Result<PingResponse, String> {
    serde_json::from_str(raw)
        .map_err(|e| format!("回包解析失败：{}（原文前 80 字：{}）", e, truncate(raw, 80)))
}

/// 剥掉 interconnect 传输层的信封。
///
/// 协议文档 §1.2：手环回包在通道上以 `{ "data": "<JSON字符串>" }` 形式发送，
/// `data` 是**字符串**。插件必须先 `JSON.parse(msg.data)` 还原出真正的业务报文
/// `{ ok, action, data? }`。同时兼容两种实现：
/// - `data` 是字符串 → 再 `JSON.parse` 一层
/// - `data` 已是对象/数字 → 直接用它
/// - 根本没有 `data` 字段 → `raw` 本身就是业务 JSON（旧实现或不包装的情况）
pub fn unwrap_envelope(raw: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(v) if v.is_object() => {
            if let Some(data) = v.get("data") {
                match data {
                    serde_json::Value::String(s) => {
                        // data 是字符串：尝试再解析一层；失败则原样返回
                        if let Ok(inner) = serde_json::from_str::<serde_json::Value>(s) {
                            return inner.to_string();
                        }
                        return s.clone();
                    }
                    other => return other.to_string(),
                }
            }
            v.to_string()
        }
        _ => raw.to_string(),
    }
}

pub fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// 把 UnifiedCourse 的周类型转成协议侧可发送的字符串（v1 手环忽略，仅留档）
#[allow(dead_code)]
pub fn week_type_str(t: &WeekType) -> &'static str {
    match t {
        WeekType::All => "all",
        WeekType::Odd => "odd",
        WeekType::Even => "even",
    }
}
