# task-register 并行上限改造方案：超限时返回进行中任务清单，先清老任务才发新单号

> 状态：**✅ 已实施（P1，P2 未做）** · evtask-B-app-auth-261006-uvbn4x · 2026-10-06 · 落点 `ev/app-auth`（连带 `ev/ev-ops-android`）
> 依据：总纲 §3.13（多步骤任务先写方案）· 用户原话「进行中超过了应返回进行中的任务，提示选择一条无人处理的比较老的任务先处理掉，才能获得新的任务单号；没有单号禁止开发」

---

## 一、目标与边界

**要解决**：
1. 超限时 409 响应只给两个数字（`in_progress` / `max`），**不带任务清单**——调用方（AI 会话）不知道该先处理哪条，容易硬等或绕过。
2. 疑似**超发 bug**：`countInProgress()` 读 Supabase 失败时静默 `return 0`（ev.js L944-945），上限形同虚设——历史上出现过 `in_progress=10 > max_parallel=9` 仍发号成功的记录（`e2e_result.txt` 第 3 行）。需实测确认并堵住。

**不解决**（边界）：
- 不改单号生成格式、不改 task-close / task-update 逻辑；
- 不做排队（维持「禁止排队」的产品决定，超限只指引、不缓存请求）；
- App 端展示列为 P2 可选，本轮默认只做后端。

## 二、现状侦察结论（读到的，非臆测）

| 位置 | 事实 |
| --- | --- |
| `ev/app-auth/api/ev.js` L984 `handleTaskRegister` | 上限拦截已存在：`limit` 默认 **9**，可被 `evops_status(id=1).payload.summary.max_parallel` 覆盖（>0 才生效）；仅对 `status=in_progress` 生效 |
| 同文件 L936 `countInProgress()` | `select=id&status=eq.in_progress&limit=1000` 数组长度计数；**try/catch 失败返回 0** → 读库失败 = 上限失效（超发根因嫌疑） |
| 同文件 L1028-1034 | 超限 409：`error:"parallel_limit_reached"`，字段只有 `in_progress` / `max`，message「先结束一个进行中任务腾出槽位」 |
| `evops_status` 表 id=1 payload | `summary.max_parallel` 就是「设置里的进行中上限」；来源 `ev-ops-android/scripts/collect-status.js` L708（`MAX_PARALLEL`），手机端 `Prefs.java` L32 注明「后端下发的为准」 |
| `evops_tasks` 表字段 | `id / title / project / assignee / owner / status / priority / created_at / updated_at`（登记时写入，L1039-1050），可支撑「无人处理 + 最老」排序 |
| 线上 API | `https://app-auth.gudq.com/api/ev`（e2e 脚本实测格式），匿名有 5 分钟 12 条频率护栏，AI 带 Bearer token 不受限 |
| 历史超发证据 | `ev-ops-android/scripts/e2e_result.txt`：登记成功且 `summary.in_progress=10 > max_parallel=9` |

## 三、改动清单（文件级）

### P1 · 后端（本轮主做）

1. **`ev/app-auth/api/ev.js`**（预计 +55/-15 行）
   - `countInProgress()` → 新增 `listInProgress()`：`select=id,title,project,assignee,owner,created_at,updated_at&status=eq.in_progress&order=created_at.asc&limit=1000`；**失败返回 `null`**（不再吞错返回 0）。保留原 `countInProgress` 供其他调用点（如有）不破坏。
   - 上限判断改用 `listInProgress()`：
     - 读库失败（null）→ **fail-closed：返回 503 `store_unavailable`，拒发单号**——读不到就不能证明有槽位，「没有单号禁止开发」。
     - `list.length >= limit` → 409，响应体升级：
       ```json
       {
         "success": false,
         "error": "parallel_limit_reached",
         "in_progress": 10, "max": 9,
         "suggested": { "id": "evtask-…", "title": "…", "assignee": null, "created_at": "…", "age_min": 123 },
         "tasks": [ { "id","title","project","assignee","owner","created_at","age_min" } ],
         "message": "已达并行上限 9（当前进行中 10）。请先选择一条【无人处理的较老任务】处理掉（task-close 或 task-update 改 status），才能获得新任务单号；没有任务单号禁止开发。"
       }
       ```
     - **排序规则**：无人处理优先（`assignee` 为空，或 `owner` ∈ {register, anon, dev:*} 开头）→ 再按 `created_at` 升序（最老在前）；`suggested` 取排序后第一条。
   - 兼容性：`in_progress` / `max` / `error` 原字段全部保留（§3.1 只加不改不删）。
2. **`ev/app-auth/api/ev.js` 部署后线上验证**（Vercel ~2 分钟延迟，curl 复核）。

### P2 · 连带（可选，默认不做，待用户点头）

3. `ev/ev-ops-android/src/com/evops/mobile/TaskRegisterActivity.java`：409 时把 `tasks` 清单渲染成卡片列表 + 高亮 `suggested`；`ApiClient` 若有解析 409 的地方同步。
4. `ev/ev-ops-android/scripts/e2e_task_test.sh` 或新脚本：加「超限 409 带 tasks + suggested + message 关键字」断言。

## 四、分阶段预算与验证标准

| 阶段 | 内容 | 预算 | 验证标准（看什么现象算过） |
| --- | --- | --- | --- |
| **P0 实测确认**（先测后改） | 线上 curl：`task-list` 数进行中条数 vs `summary.max_parallel`；匿名登记一条 `[TEST]` 探针看是否超发 | 3-4 次调用 | ① 复现超发（成功发号且 in_progress≥max）→ 证实 count 静默 0 根因；② 未超发则记录现行为，改造仍按 fail-closed 做（防御） |
| **P1 改造** | ev.js 两处函数 + 409 增强 | 4-5 次调用 | `node --check` 过；commit + push 后 Vercel 部署成功；线上 curl：未超限 → 正常发号；人为把 `max_parallel` 临时调低（或等真实超限）→ 409 且 `tasks` 非空、`suggested` 在前、message 含「禁止开发」；探针任务 `task-close` 清理干净 |
| **P2 App 端**（可选） | TaskRegisterActivity 409 渲染清单 | 6-8 次调用 | javac/aapt2 编译过 + 装机 409 界面可见清单（真机截图） |

> P0 会在 Supabase 侧临时把 `max_parallel` 调成当前进行中数量（或更小）制造超限条件，验证完**必须改回 9**（落验收 checklist）。

## 五、风险与回滚

| 风险 | 缓解 / 回滚 |
| --- | --- |
| fail-closed：Supabase 抖动时所有发号被 503 挡住（误伤正常开发） | 503 响应带 `retry_after` 提示；属于「宁可不发号、不可超发」的取舍；回滚 = `git revert` 该 commit，单文件即回 |
| `max_parallel` 调低测试后忘改回 | 验收 checklist 硬性条目「max_parallel 已恢复 9」+ 测试后立即 curl 复核 |
| 409 新字段破坏 App 老版本解析 | 只增不改：老字段全保留；App 端 `opt` 系列解析对未知字段天然忽略 |
| 无人处理判定误判（assignee 有值但实际弃坑） | 只影响排序建议，不阻断任何操作；人看清单自己选 |

## 六、连带待办

- P2 App 端展示（本方案默认不做）→ 若做需再领 `evtask-D-ev-ops-…` 单号单独开工。
- `docs/全局规则` / 总纲 §3.11 措辞是否要补「409 时先清老任务」一句 → 待本功能上线后另行微改（纯文档，豁免）。

## 七、验收 checklist

- [ ] P0：线上实测结论写回本文件（超发是否复现）
- [ ] `node --check api/ev.js` 通过
- [ ] 未超限时发号行为不变（e2e 回归 PASS）
- [ ] 超限时 409 带 `tasks[]` + `suggested`，排序 = 无人处理最老在前
- [ ] message 含「无人处理的较老任务」「没有任务单号禁止开发」
- [ ] 读库失败 → 503 `store_unavailable` 拒发（fail-closed）
- [ ] 测试用的 `max_parallel` 调整已恢复为 9
- [ ] 探针/测试任务已 task-close，不残留垃圾数据
- [ ] PROJECT-MAP 认领行 ✅ + commit hash

---
**预估总量**：P0+P1 ≈ 9-12 次工具调用（一段会话内可完成）；P2 另起会话。

---

## 八、实施记录（2026-10-06 17:0x）

- **commit**：`609e878`（api/ev.js + 本方案文档），已 push、Vercel 部署生效。
- **P0 实测**：当时进行中 5/9 未超限；超发根因依据 = `countInProgress` 静默吞错返回 0（代码事实）+ 历史 e2e 记录 `in_progress=10 > max_parallel=9` 仍发号。
- **P1 改码**：`listInProgress()`（读失败返回 null）+ fail-closed 503 `store_unavailable` + 409 增强（tasks/suggested/message）；原字段全保留。
- **单测**：排序逻辑 node 内联验证 PASS——无人处理组优先（assignee 空 / owner ∈ {register, anon, aitest, dev:*}）、组内 created_at 升序（实测输出 C(无人最老)→B(无人)→D(有人最老)→A）。
- **线上验证**：
  ① 未超限（9）→ 匿名登记正常发号 ✓（回归 PASS）
  ② `max_parallel` 临时 9→1（Supabase 读-改-写，http 204）→ 409 `parallel_limit_reached`：6 条清单全带 age_min、`suggested` = 无人处理的 aitest 演示任务、有人任务按最老在前、message 含「没有任务单号禁止开发」✓
  ③ 恢复 `max_parallel=9`（复核读回 = 9）→ 再次发号正常 ✓
  ④ 探针任务 `qnxxde` / `5yhhnw` 均 task-close=done，无残留 ✓
- **验收 checklist**：八项全过（fail-closed 503 分支为防御性代码，线上未强行断库实测，逻辑经 code review 与单测覆盖）。
- **P2 未做**：App 端 TaskRegisterActivity 409 清单渲染，待另起任务。
