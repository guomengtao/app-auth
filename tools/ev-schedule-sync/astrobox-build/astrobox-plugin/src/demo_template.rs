// Demo JSON 模板 —— DESIGN.md §3.3
//
// 复制给 AI 的版本刻意带上详细注释：这是给 AI 读的「格式说明书」，
// AI 读完后只需返回合法 JSON（不含注释），用户再粘贴回插件即可导入。
// 因此这里的内容**不是**合法 JSON，不能被 demo adapter 的 detect() 识别 —— 这是预期行为。

pub const DEMO_JSON_WITH_NOTES: &str = r##"/*
 * EV 课程表导入 JSON 格式说明
 * ==========================================
 * 复制下面整段内容发给 AI，让 AI 按照你的课程表编辑好内容后粘贴回来即可导入。
 * AI 会读取这些注释并生成合法的 JSON。
 *
 * ── 必填字段 ──
 * scheduleName  : 字符串，课程表名称，最长 50 个字符
 * courses[]     : 课程数组，至少包含 1 门课程
 *
 *   每门课程的必填字段：
 *   name          : 字符串，课程名称，最长 50 个字符，例如 "高等数学"
 *   teacher       : 字符串，授课教师，最长 30 个字符，例如 "张教授"
 *   location      : 字符串，上课地点，最长 50 个字符，例如 "A楼101"
 *   day           : 整数，星期几，1-7（1=周一，7=周日）
 *   startTime     : 字符串，上课时间，"HH:MM" 24小时制，例如 "08:00"
 *   endTime       : 字符串，下课时间，"HH:MM" 24小时制，必须大于 startTime
 *   weeks         : 整数数组，上课周次，例如 [1,2,3,4,5,6,7,8]
 *   weekType      : 字符串，周类型，三选一："all"（每周）| "odd"（单周）| "even"（双周）
 *
 *   每门课程的可选字段：
 *   color         : 字符串，颜色值，#RRGGBB 格式，例如 "#F44336"
 *   credit        : 数字，学分，例如 3.0
 *   remark        : 字符串，备注，最长 200 个字符
 *
 * ── 注意事项 ──
 * - 只返回合法的 JSON，不要用 markdown 代码块包裹，不要添加额外文字
 * - startTime 和 endTime 必须是有效时间，且 startTime < endTime
 * - day 必须是 1-7 的整数
 * - weeks 必须是包含整数的非空数组
 */
{
  "scheduleName": "2026 春季学期",
  "courses": [
    {
      "name": "高等数学",
      "teacher": "张教授",
      "location": "A楼101教室",
      "day": 1,
      "startTime": "08:00",
      "endTime": "09:40",
      "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
      "weekType": "all",
      "color": "#F44336",
      "credit": 3.0,
      "remark": "这是可选备注"
    },
    {
      "name": "大学英语",
      "teacher": "李教授",
      "location": "教学楼B205",
      "day": 3,
      "startTime": "10:05",
      "endTime": "11:40",
      "weeks": [1,3,5,7,9,11,13,15],
      "weekType": "odd",
      "color": "#2196F3"
    }
  ]
}"##;

/// 对话展示的 demo_json 内容
pub fn demo_json_text() -> String {
    DEMO_JSON_WITH_NOTES.to_string()
}

// ══════════════════════════════════════════════════════════════
// 最小可用 Demo —— 不做任何修改就能直接导入成功的样例
// ══════════════════════════════════════════════════════════════

/// 生成一份**最小且必定通过校验**的 Demo JSON。
///
/// 返回 `(json, 课程表名称)`。
///
/// 课程表名称与课程名都带上随机后缀：连点几次「填入示例」也不会因同名而互相覆盖/冲突，
/// 方便反复测试导入链路。随机数取自系统时间戳（WASI 下可读），无需外部熵源。
pub fn minimal_demo_json() -> (String, String) {
    let token = random_token();
    let schedule_name = format!("示例课表-{}", token);
    let course_name = format!("示例课程-{}", token);

    let json = format!(
        concat!(
            "{{\"scheduleName\":\"{sn}\",\"courses\":[",
            "{{\"name\":\"{cn}\",\"teacher\":\"示例教师\",\"location\":\"示例教室\",",
            "\"day\":1,\"startTime\":\"08:00\",\"endTime\":\"09:40\",",
            "\"weeks\":[1,2,3,4],\"weekType\":\"all\"}}",
            "]}}"
        ),
        sn = schedule_name,
        cn = course_name
    );

    (json, schedule_name)
}

/// 4 位十六进制随机串。SystemTime 不可用时退化为固定串（仍能导入，只是不再随机）。
fn random_token() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    // 混一混低位，避免同一毫秒内连点得到相同值
    let mixed = millis ^ (millis >> 7) ^ (millis << 3);
    format!("{:04X}", (mixed % 0xFFFF) as u16)
}

// ══════════════════════════════════════════════════════════════
// 支持的导入来源与各自的样板格式
//
// 来源：`docs/astrobox-plugin-ev-schedule-sync.md`（平台清单）
//      `docs/多课程表格式导入兼容分析.md`（各格式样板 JSON）
// 这两处是权威记录，改格式时请同步这两份文档。
// ══════════════════════════════════════════════════════════════

/// 支持的导入来源（名称, 一句话说明）
pub const SUPPORTED_PLATFORMS: &[(&str, &str)] = &[
    ("时光课程表 sgschedule", "最常用，用 timeSlots 节次表换算时间"),
    ("WakeUp 课程表", "导出 .wakeup_schedule 文件"),
    ("StarLink 星链课表", "starlinkkb.cn，含 AI 排课"),
    ("CSES 标准格式", "通用课程表交换标准"),
    ("EV 课程表", "自身备份格式，换设备时用"),
];

/// 各格式的样板 JSON，供用户对照自己的导出文件
pub const FORMAT_SAMPLES: &str = r##"【1】时光课程表 sgschedule
特征字段：timeSlots + startSection
{
  "courses": [
    {"name":"高等数学","teacher":"张三","location":"A101",
     "day":1,"startSection":1,"endSection":2,
     "weeks":[1,2,3],"color":0}
  ],
  "timeSlots": [
    {"section":1,"startTime":"08:00","endTime":"08:45"}
  ]
}

【2】WakeUp 课程表
特征字段：scheduleName + courseList
{
  "scheduleName": "大二上学期",
  "courseList": [
    {"name":"高等数学","day":1,
     "start":"08:00","end":"09:40",
     "room":"教学楼A101","teacher":"张三",
     "weeks":[1,2,3],"type":"every"}
  ]
}

【3】StarLink 星链课表
特征字段：semester + subjects + oddEven
{
  "semester": "2025-2026-1",
  "subjects": [
    {"subjectName":"高等数学","weekday":1,
     "beginTime":"08:00","finishTime":"09:40",
     "place":"教学楼A101","instructor":"张三",
     "weekRange":"1-16","oddEven":0}
  ]
}

【4】CSES 标准格式
特征字段：cses_version
{
  "cses_version": "1.0",
  "export_time": "2026-09-20T12:00:00Z",
  "source_app": "ev-schedule",
  "schedules": [
    {"schedule_id":"default","schedule_name":"大二上学期",
     "courses":[
       {"course_id":"MATH201","name":"高等数学",
        "day_of_week":1,"start_time":"08:00",
        "end_time":"09:40","location":"教学楼A101",
        "teacher":"张三","weeks":[1,2,3],
        "week_type":"all","credits":4.0}
     ]}
  ]
}

【5】EV 课程表
特征字段：appName + version + schedules
{
  "version": "2.0",
  "appName": "Ev课程表",
  "schedules": [
    {"id":"schedule_001","name":"大二上学期",
     "courses":[
       {"id":"course_001","name":"高等数学",
        "day":1,"startTime":"08:00","endTime":"09:40",
        "location":"教学楼A101","teacher":"张三",
        "weeks":[1,2,3],"weekType":"all",
        "color":"#4A90D9"}
     ]}
  ]
}

粘贴后插件会自动识别格式，无需手动选择。"##;
