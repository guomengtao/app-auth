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
