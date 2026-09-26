#!/usr/bin/env python3
"""离线补拉 + 已读状态 单元测试（离线，不打网络）。

运行: python3 tools/ev-notifier/tests/test_offline_sync.py
"""
import json
import os
import shutil
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import load_ev, Checker  # noqa: E402

E = load_ev()
c = Checker()

# 全局兜底：测试期间绝不发起真实补拉线程（会打生产接口）。
# 需要观测调用参数的用例（§12）会自己替换掉它。
E._request_sync = lambda reason="", force=False: None


def reset_cache():
    """消息走内存缓存后，测试之间必须显式清缓存 + 清磁盘，否则会互相污染。

    ⚠️ 必须持 `_MSG_LOCK`：§5 会真的启动后台 writer 线程（`_message_writer_loop`），
    它随时可能在 `save_messages()` 里把旧缓存写到磁盘上 —— 不持锁的话会出现
    「刚清空又被写回」的偶发脏数据（实测踩到过：上一节的消息在新一节里复活）。
    """
    with E._MSG_LOCK:
        if os.path.exists(E.MESSAGES_FILE):
            os.remove(E.MESSAGES_FILE)
        E._MSG_CACHE = None
        E._known_ids.clear()
        E._seen_ids.clear()
        E._unread_cache = None
        E._MSG_DIRTY = False


def set_cursor(seq, cid="cursor-test"):
    """同时设置内存与磁盘上的游标值（测试专用）。

    ⚠️ 不能只改内存：`_save_sync_state()` 在 `client_id` 为空时会先调用
    `_ensure_sync_state_loaded()`，把磁盘上的旧 `last_seq` 用 max() 合并回内存 ——
    上一轮测试遗留的 state 文件（例如 777）会把本节的期望值覆盖掉，造成偶发失败。
    这里把 client_id 一并设上（非空即跳过合并），并同步写盘，做到确定性。
    """
    E._sync_state.update({"client_id": cid, "last_seq": seq, "last_sync_at": 0})
    try:
        with open(E.SYNC_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"client_id": cid, "last_seq": seq, "last_sync_at": 0}, f)
    except Exception:
        pass


# ══ 1. 存储 / 未读 / 已读 ══════════════════════════════════════════
reset_cache()
E.store_message(1700000000, "new_order", {"a": 1}, message_id="m1", seq=1)
E.store_message(1700000001, "page_visit", {"b": 2}, message_id="m2", seq=2)
c.check("store 2 条", len(E.load_messages()) == 2, len(E.load_messages()))
c.check("未读 = 2", E.count_unread() == 2, E.count_unread())

msgs = E.load_messages()
# 存储按时间升序追加（append 是 O(1)），读取侧用 recent_messages() 取「最新在前」
c.check("存储为时间升序（老的在前）", msgs[0].get("seq") == 1 and msgs[-1].get("seq") == 2,
        [m.get("seq") for m in msgs])
recent = E.recent_messages(10)
c.check("recent_messages 最新在前", recent[0].get("seq") == 2 and recent[1].get("seq") == 1,
        [m.get("seq") for m in recent])

# _msg_key 优先级：seq > messageId > time|type
c.check("_msg_key 优先 seq", E._msg_key({"seq": 9, "messageId": "zz"}) == "s:9")
c.check("_msg_key 次选 messageId", E._msg_key({"messageId": "zz"}) == "m:zz")
c.check("_msg_key 兜底 time|type", E._msg_key({"time": "t", "type": "x"}) == "t:t|x")

# 已读：幂等 + dirty 才落盘
real_awj = E._atomic_write_json
writes = {"n": 0}


def counting_awj(path, data):
    writes["n"] += 1
    return real_awj(path, data)


E._atomic_write_json = counting_awj
k_top = E._msg_key(E.recent_messages(1)[0])
c.check("mark_read 首次变化 1 条", E.mark_read([k_top]) == 1)
writes["n"] = 0
c.check("mark_read 重复调用 0 变化", E.mark_read([k_top]) == 0)
c.check("无变化不落盘（dirty 判定）", writes["n"] == 0, writes["n"])
E.save_messages()
c.check("显式落盘生效", writes["n"] == 1, writes["n"])
E._atomic_write_json = real_awj
c.check("已读后未读 = 1", E.count_unread() == 1, E.count_unread())
c.check("已读标记已持久化", E.recent_messages(1)[0].get("read") is True)

# ══ 1b. 消息全量保留（取消 500 条上限）════════════════════════════
reset_cache()
N_BULK = 1200
for i in range(N_BULK):
    E.store_message(1700001000 + i, "page_visit", {"i": i}, message_id="bulk%d" % i, seq=100 + i)
c.check("消息全量保留（%d 条不截断）" % N_BULK, len(E.load_messages()) == N_BULK, len(E.load_messages()))
E.save_messages()
disk = json.load(open(E.MESSAGES_FILE, encoding="utf-8"))
c.check("落盘后磁盘同样是 %d 条" % N_BULK, len(disk) == N_BULK, len(disk))
c.check("超出旧上限 500 后 JSON 仍合法", isinstance(disk, list))

# 落盘节流：高频写入不能每条都全量重写
reset_cache()
E._atomic_write_json = counting_awj
writes["n"] = 0
for i in range(100):
    E.store_message(1700020000 + i, "page_visit", {"i": i}, message_id="thr%d" % i, seq=30000 + i)
c.check("连续 100 条写入被合并（未逐条落盘）", writes["n"] == 0, writes["n"])
c.check("dirty 标记已置位", E._MSG_DIRTY is True)
E.save_messages()
c.check("合并后一次落盘", writes["n"] == 1, writes["n"])
E._atomic_write_json = real_awj

# 缓存：第二次读取不应再解析文件
c.check("load_messages 走内存缓存（同一对象）", E.load_messages() is E.load_messages())

# ══ 2. 幂等入口 _claim_message ════════════════════════════════════
E._sync_state["last_seq"] = 0
E._seen_ids.clear()
E._known_ids.clear()
c.check("claim 新消息通过", E._claim_message(3, "s:3", "m3") is True)
c.check("claim 同 seq 重复被拒", E._claim_message(3, "s:3", "m3") is False)
E._known_ids.add("known-1")
c.check("claim 已入库 messageId 被拒", E._claim_message(0, "x", "known-1") is False)
E._sync_state["last_seq"] = 10
c.check("claim seq <= 游标被拒", E._claim_message(9, "s:9", "m9") is False)
c.check("claim seq > 游标通过", E._claim_message(11, "s:11", "m11") is True)

# LRU：满容量后淘汰最旧，而不是整体清空
E._seen_ids.clear()
oldest = "k_old"
E._claim_message(0, oldest, "")
for i in range(E._MAX_SEEN + 50):
    E._claim_message(0, "k%d" % i, "")
c.check("LRU 不超过上限", len(E._seen_ids) <= E._MAX_SEEN, len(E._seen_ids))
c.check("LRU 淘汰的是最旧项", E._seen_ids.get(oldest) is None)
c.check("LRU 保留较新项", E._seen_ids.get("k%d" % (E._MAX_SEEN + 49)) is True)

# ══ 3. 水位线 ═════════════════════════════════════════════════════
# ⚠️ 语义自 2026-09-26 起收紧：实时消息**只能连续推进**游标（跨空洞不推进，见 §12）。
#    所以这里用「连续 seq（11/12）」验证推进/幂等，用 999 这种大跳验证"不推"。
set_cursor(10)
E._gap_start = 0
E._sync_inflight = True
E._advance_seq(11)
c.check("补拉进行中：实时消息不推进游标", E._sync_state["last_seq"] == 10, E._sync_state["last_seq"])
E._sync_inflight = False
E._sync_pending = True
E._advance_seq(11)
c.check("补拉排队中：实时消息不推进游标", E._sync_state["last_seq"] == 10, E._sync_state["last_seq"])
E._sync_pending = False
E._advance_seq(11)
c.check("补拉结束后可推进（连续 seq）", E._sync_state["last_seq"] == 11, E._sync_state["last_seq"])
E._advance_seq(11)
c.check("游标只增不减", E._sync_state["last_seq"] == 11)
E._advance_seq(-1)
c.check("非法 seq 被忽略", E._sync_state["last_seq"] == 11)
E._gap_start = 0
E._advance_seq(999)
c.check("跨空洞的实时 seq 不推进游标（§12 详测）",
        E._sync_state["last_seq"] == 11, E._sync_state["last_seq"])
E._gap_start = 0

# ══ 4. client_id 稳定性 ═══════════════════════════════════════════
cid1 = E._get_client_id()
c.check("client_id 非空", bool(cid1), cid1)
c.check("client_id 幂等", E._get_client_id() == cid1)
E._sync_state["client_id"] = ""
c.check("client_id 可从磁盘恢复", E._get_client_id() == cid1, cid1)

# ══ 5. 并发安全（I4）══════════════════════════════════════════════
E._sync_state["last_seq"] = 0
reset_cache()
if os.path.exists(E.MESSAGES_FILE):
    os.remove(E.MESSAGES_FILE)

errors = []
N_THREADS, N_EACH = 8, 25


def writer(tid):
    try:
        for i in range(N_EACH):
            E.store_message(1700010000 + tid * 100 + i, "page_visit",
                            {"t": tid, "i": i}, message_id="c%d-%d" % (tid, i),
                            seq=10000 + tid * 100 + i)
    except Exception as e:
        errors.append("%s: %s" % (type(e).__name__, e))


threads = [threading.Thread(target=writer, args=(t,)) for t in range(N_THREADS)]
for t in threads:
    t.start()
for t in threads:
    t.join()
c.check("并发写无异常", not errors, errors)
try:
    got = E.load_messages()
    c.check("并发写后 JSON 仍合法", isinstance(got, list))
    c.check("并发写不丢消息（%d 条）" % (N_THREADS * N_EACH),
            len(got) == N_THREADS * N_EACH, len(got))
except Exception as e:
    c.check("并发写后 JSON 仍合法", False, e)

# 存储 + 已读交叉并发，文件不能被写坏
# 真的把后台落盘线程跑起来（间隔调小，制造高频写入）
E.MSG_SAVE_INTERVAL = 0.05
E.save_messages()          # 先保证文件存在
threading.Thread(target=E._message_writer_loop, daemon=True).start()
stop = {"v": False}
read_errors = []


def reader_loop():
    while not stop["v"]:
        try:
            json.load(open(E.MESSAGES_FILE))
        except FileNotFoundError:
            pass
        except Exception as e:
            read_errors.append("%s: %s" % (type(e).__name__, e))
        time.sleep(0.001)


r = threading.Thread(target=reader_loop, daemon=True)
r.start()
w = threading.Thread(target=lambda: [E.store_message(1700020000 + i, "page_visit",
                                                     {"i": i}, message_id="rw%d" % i,
                                                     seq=20000 + i) for i in range(60)])
w.start()
m = threading.Thread(target=lambda: [E.mark_read([E._msg_key(x) for x in E.load_messages()[:5]])
                                     for _ in range(20)])
m.start()
w.join()
m.join()
stop["v"] = True
r.join(timeout=2)
c.check("读写并发时始终读到合法 JSON（原子落盘）", not read_errors, read_errors[:3])

# ══ 6. 补拉：分页上限 / 降级 / 回执批量 ═══════════════════════════
E._sync_state["last_seq"] = 5
E._seen_ids.clear()
E._known_ids.clear()
E._rebuild_known_ids()
api_calls = {"n": 0}
seq_cursor = {"v": 5}


def fake_api(url, timeout=10):
    api_calls["n"] += 1
    seq_cursor["v"] += 10
    return 200, {
        "success": True,
        "messages": [{"seq": str(seq_cursor["v"] - 10 + i), "message_id": "s%d" % (seq_cursor["v"] - 10 + i),
                      "message_type": "page_visit", "payload": {}, "created_at": "2026-09-25T00:00:00Z"}
                     for i in range(10)],
        "next_cursor": seq_cursor["v"],
        "has_more": True,
    }


E._api_get_status = fake_api
added = E.sync_since("test-paging")
c.check("分页循环受 SYNC_MAX_PAGES 限制", api_calls["n"] == E.SYNC_MAX_PAGES, api_calls["n"])
c.check("分页补回条数 = 页数 × 页大小", added == E.SYNC_MAX_PAGES * 10, added)

# 回执：批量而非逐条
cb_calls = []


def fake_cb(message_id, event="delivered", batch_ids=None):
    cb_calls.append((event, len(batch_ids) if batch_ids else 1))


E._delivery_callback = fake_cb
E._pending_receipts = []
for i in range(250):
    E._enqueue_receipt("id%d" % i, "delivered")
E._flush_receipts()
c.check("250 条回执分 3 批（100/100/50）", len(cb_calls) == 3, cb_calls)
c.check("分片大小正确", [n for _, n in cb_calls] == [100, 100, 50], cb_calls)
c.check("回执队列已清空", E._pending_receipts == [])

E._pending_receipts = []
E._flush_receipts()
c.check("空队列 flush 不发请求", len(cb_calls) == 3, len(cb_calls))

# 降级：head 不可用 → 回退 _startup_recovery
legacy = {"n": 0}


def fake_legacy():
    legacy["n"] += 1


E._startup_recovery = fake_legacy
E._api_get_status = lambda url, timeout=10: (0, None)
E._sync_state["last_seq"] = 0
E.sync_since("test-fallback")
c.check("冷启动 head 不可用 → 降级 legacy", legacy["n"] == 1, legacy["n"])

E._sync_state["last_seq"] = 0
E._startup_recovery = fake_legacy
E._api_get_status = lambda url, timeout=10: (200, {"success": True, "max_seq": 777})
E.sync_since("test-bootstrap")
c.check("冷启动 bootstrap 跳到 max_seq", E._sync_state["last_seq"] == 777, E._sync_state["last_seq"])
c.check("bootstrap 不重放历史（不调 legacy）", legacy["n"] == 1, legacy["n"])

# sync 来源不弹窗 / 不念语音
popup = {"notify": 0, "voice": 0}
E.notify_macos = lambda *a, **k: popup.__setitem__("notify", popup["notify"] + 1)
E.enqueue_voice = lambda *a, **k: popup.__setitem__("voice", popup["voice"] + 1)
E._seen_ids.clear()
E._known_ids.clear()
E._rebuild_known_ids()
E.handle_message({"ts": 1700000010, "type": "new_activation", "payload": {"product_name": "EV"},
                  "messageId": "quiet-1", "seq": 90001}, skip_notify=True, source="sync")
c.check("补拉来源不弹窗", popup["notify"] == 0, popup)
c.check("补拉来源不念语音", popup["voice"] == 0, popup)
c.check("补拉消息已入库", any(m.get("messageId") == "quiet-1" for m in E.load_messages()))

# ══ 7. 凭据与请求头（设备令牌优先，共享密钥回退）══════════════════
E.DEVICE_TOKEN = None
E.SYNC_TOKEN = None
c.check("都没配：不带鉴权 header", E._auth_headers() == [])
E.SYNC_TOKEN = "abc123"
c.check("只有共享密钥：带 x-ev-sync-token",
        E._auth_headers() == ["-H", "x-ev-sync-token: abc123"], E._auth_headers())
E.DEVICE_TOKEN = "dev-token-xyz"
c.check("★有设备令牌：优先用 x-ev-device-token（不再发共享密钥）",
        E._auth_headers() == ["-H", "x-ev-device-token: dev-token-xyz"], E._auth_headers())
E.DEVICE_TOKEN = None
E.SYNC_TOKEN = None

# _on_auth_failed：401 时清凭据 + 置状态 + 只提示一次
notified = {"n": 0}
E.notify_macos = lambda *a, **k: notified.__setitem__("n", notified["n"] + 1)
deleted = {"n": 0}
E._keychain_delete_token = lambda: deleted.__setitem__("n", deleted["n"] + 1)
E.DEVICE_TOKEN = "stale-token"
E._auth_state = "ok"
E._on_auth_failed("test 401")
c.check("401 后清掉设备令牌", E.DEVICE_TOKEN is None, E.DEVICE_TOKEN)
c.check("401 后删除钥匙串条目", deleted["n"] == 1, deleted["n"])
c.check("401 后状态置为 invalid", E._auth_state == "invalid", E._auth_state)
c.check("401 后提示用户一次", notified["n"] == 1, notified["n"])
E._on_auth_failed("test 401 again")
c.check("重复 401 不再刷屏（只提示一次）", notified["n"] == 1, notified["n"])
E._auth_state = "ok"

# 未登录状态判定（redis_loop 启动逻辑的等价形式）
E.DEVICE_TOKEN = None
E.SYNC_TOKEN = None
c.check("无任何凭据时判为未登录", (bool(E.DEVICE_TOKEN) or bool(E.SYNC_TOKEN)) is False)

# ══ 8. 性能门槛（消息全量保留后必须仍然流畅）══════════════════════
# 历史 bug：取消 500 上限后，insert(0) 是 O(n) + store_visitor 每条都全量读写文件
# → 存量 10000 条时构建要 181s。改成 append + 缓存 + 合并落盘后是 0.05s。
reset_cache()
E.MSG_SAVE_INTERVAL = 999  # 关掉后台落盘，单独测逻辑耗时
t0 = time.time()
for i in range(8000):
    E.store_message(1700030000 + i, "page_visit", {"i": i, "page": "/activate.html"},
                    message_id="perf%d" % i, seq=400000 + i)
build = time.time() - t0
c.check("存量 8000 条构建 < 5s（防 O(n) 回归）", build < 5, "%.2fs" % build)

t0 = time.time()
for i in range(200):
    E.store_message(1700040000 + i, "page_visit", {"i": i}, message_id="perf2-%d" % i, seq=500000 + i)
inc = time.time() - t0
c.check("存量 8000 时新增 200 条 < 1s", inc < 1, "%.3fs" % inc)

t0 = time.time()
E.save_messages()
E.save_visitors()
c.check("全量落盘 < 5s", time.time() - t0 < 5)

d = E.DashboardWindow(None)
d._current_page = "messages"
t0 = time.time()
h = E.DashboardWindow._build_current_html(d)
render = time.time() - t0
c.check("存量 8000 时渲染消息页 < 2s", render < 2, "%.3fs" % render)
c.check("渲染 HTML 体积受控 < 500KB（否则 WebKit 加载失败）",
        len(h) < 500 * 1024, "%.0f KB" % (len(h) / 1024))
c.check("面板只渲染最新 N 条，不是全量", h.count('class="msg-card') <= E.MSG_RENDER_LIMIT,
        h.count('class="msg-card'))

# ══ 9. SIGTERM 也必须落盘（Python 的 SIGTERM 不走 atexit）══════════
# 真实场景：launchd 重启 / 系统关机 / kill 都发 SIGTERM，不挂 handler 会丢最后 2 秒消息。
import subprocess  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
child_home = "/tmp/ev_notifier_sigterm_home"
shutil.rmtree(child_home, ignore_errors=True)
os.makedirs(child_home, exist_ok=True)

child_code = (
    "import sys, os, signal\n"
    "sys.path.insert(0, %r)\n"
    "from _harness import load_ev\n"
    "E = load_ev(home=%r)\n"
    "E.store_message(1700099999, 'new_order', {'x': 1}, message_id='sigterm1', seq=999)\n"
    "E._install_signal_flush()\n"
    "os.kill(os.getpid(), signal.SIGTERM)\n"
    "print('STILL_ALIVE')\n"
) % (HERE, child_home)

r = subprocess.run([sys.executable, "-c", child_code], capture_output=True, text=True, timeout=40)
c.check("SIGTERM 后进程已退出（未继续执行）", "STILL_ALIVE" not in (r.stdout or ""), (r.stdout or "")[-80:])
msg_file = os.path.join(child_home, ".ev_messages.json")
try:
    saved = json.load(open(msg_file, encoding="utf-8"))
    c.check("SIGTERM 时消息已落盘", len(saved) == 1 and saved[0].get("messageId") == "sigterm1",
            saved if not saved else len(saved))
except Exception as e:
    c.check("SIGTERM 时消息已落盘", False, e)
try:
    st = json.load(open(os.path.join(child_home, ".ev_sync_state.json"), encoding="utf-8"))
    c.check("SIGTERM 时同步状态文件是合法 JSON", isinstance(st, dict) and "last_seq" in st, st)
except Exception as e:
    c.check("SIGTERM 时同步状态文件是合法 JSON", False, e)

# ══ 10. 未初始化时保存不得覆盖磁盘状态（client_id 漂移防护）════════
# 真实 bug：_save_sync_state() 是「内存全量写盘」，若内存还没初始化
# （信号处理窗口期就是），会把磁盘上的 client_id / last_seq 清空成空值。
E._sync_state.update({"client_id": "", "last_seq": 0, "last_sync_at": 0})
E._sync_dirty = True
with open(E.SYNC_STATE_FILE, "w", encoding="utf-8") as f:
    json.dump({"client_id": "preexisting-client", "last_seq": 123, "last_sync_at": 111}, f)
E._save_sync_state(force=True)
st = json.load(open(E.SYNC_STATE_FILE, encoding="utf-8"))
c.check("未初始化时保存不清空磁盘 client_id", st.get("client_id") == "preexisting-client", st)
c.check("未初始化时保存不清空磁盘 last_seq", st.get("last_seq") == 123, st)
c.check("保存时会把磁盘状态合并回内存", E._sync_state.get("client_id") == "preexisting-client",
        E._sync_state)

# 磁盘已有 client_id 时，_get_client_id 必须复用它（不能生成新的）
E._sync_state.update({"client_id": "", "last_seq": 0, "last_sync_at": 0})
c.check("复用磁盘上的 client_id（不漂移）",
        E._get_client_id() == "preexisting-client", E._get_client_id())

# ══ 11. 关窗 → 自动全部已读（见 关闭面板自动已读设计.md）══════════════
# 需求：用户关掉面板 = "这些消息我都不看了" → 关窗瞬间把本地消息全标已读 + 补发 read 回执。
# 关键约束：关窗后**新到**的消息必须仍然是未读（不能被顺手标掉）。
reset_cache()
E.store_message(1700050000, "new_order", {"a": 1}, message_id="close-1", seq=600001)
E.store_message(1700050001, "new_order", {"a": 2}, message_id="close-2", seq=600002)
c.check("关窗前未读 = 2", E.count_unread() == 2, E.count_unread())

sent = []
E._delivery_callback = lambda mid, event="delivered", batch_ids=None: sent.append(event)
E._pending_receipts = []
c.check("关窗标记返回变更数", E.mark_all_read_on_close("test") == 2)
time.sleep(0.3)   # 回执走 daemon 线程，不阻塞调用方
c.check("关窗后未读 = 0", E.count_unread() == 0, E.count_unread())
E.save_messages()
disk = json.load(open(E.MESSAGES_FILE, encoding="utf-8"))
c.check("关窗已读已落盘（read + read_at）",
        all(m.get("read") is True and m.get("read_at") for m in disk), disk)
c.check("关窗补发 read 回执", bool(sent) and all(e == "read" for e in sent), sent)
c.check("关窗补发不阻塞：回执队列已清空", E._pending_receipts == [], E._pending_receipts)
c.check("关窗标记幂等（无变更不再补发）", E.mark_all_read_on_close("test") == 0)

# 关窗后新到的消息必须仍是未读
E.store_message(1700050002, "new_order", {"a": 3}, message_id="close-3", seq=600003)
c.check("关窗后新到的消息仍是未读", E.count_unread() == 1, E.count_unread())

# 轮询兜底走「关窗瞬间快照」：快照外的消息（关窗后才到）不能被标已读
keys = E.close_keys_snapshot()
E.store_message(1700050003, "new_order", {"a": 4}, message_id="close-4", seq=600004)
marked = E.mark_read_on_close_snapshot(keys, "test")
c.check("快照标记只标快照内的消息", marked == 1, marked)
c.check("快照外的（关窗后新到）仍未被标已读", E.count_unread() == 1, E.count_unread())
c.check("未读的那条正是 close-4",
        [m.get("messageId") for m in E.load_messages() if not m.get("read")] == ["close-4"])

# ── 触发链路（无 GUI，直接驱动判定函数）─────────────────────────────
calls = []
E.mark_all_read_on_close = lambda reason="x": calls.append(("all", reason)) or 0
E.mark_read_on_close_snapshot = lambda keys, reason="poll": calls.append(("snap", reason)) or 0

d = E.DashboardWindow(None)
refreshed = []
d._refresh_content = lambda: refreshed.append(1)   # 关窗路径绝不能刷新 UI
d._on_window_closed("delegate")
d._on_window_closed("poll")
c.check("delegate 之后轮询不再重复处理（门闩）", calls == [("all", "delegate")], calls)
c.check("关窗路径不刷新 UI（防往已关闭 WebView 灌 data URL）", refreshed == [], refreshed)
c.check("关窗后窗口引用已丢弃（下次打开重建）",
        d._window is None and d._window_delegate is None)
c.check("WindowDelegate 存在且转发关窗事件", hasattr(E, "WindowDelegate"))
wd = E.WindowDelegate.__new__(E.WindowDelegate)


class _FakeDash:
    def __init__(self):
        self.reasons = []

    def _on_window_closed(self, reason="delegate"):
        self.reasons.append(reason)


wd._dashboard = _FakeDash()
wd.windowWillClose_(None)
c.check("WindowDelegate.windowWillClose_ 转发到 DashboardWindow",
        wd._dashboard.reasons == ["delegate"], wd._dashboard.reasons)


class _FakeWin:
    def __init__(self):
        self.vis = True
        self.mini = False

    def isVisible(self):
        return self.vis

    def isMiniaturized(self):
        return self.mini


d2 = E.DashboardWindow(None)
d2._window = _FakeWin()
d2._poll_window_closed()
c.check("首次轮询只记基线，不触发关窗已读",
        d2._close_marked is False and d2._last_visible is True,
        (d2._close_marked, d2._last_visible))
d2._window.mini = True
d2._poll_window_closed()
c.check("最小化（收起来）不算关窗", not any(r == "poll" for _, r in calls), calls)
d2._window.mini = False
d2._poll_window_closed()
c.check("从最小化还原不触发", not any(r == "poll" for _, r in calls), calls)
d2._window.vis = False
d2._poll_window_closed()
c.check("可见性 True→False 触发关窗已读（轮询兜底）", ("snap", "poll") in calls, calls)

# ══ 12. 游标不跨空洞（睡眠丢消息根因，2026-09-26）══════════════════
# 真实事故：睡眠唤醒后第一条实时消息（seq 349）把 last_seq 从 330 推到 349，
# 331..348（18 条）永久丢失。这里固化"实时消息不得跨空洞推游标"这条铁律。
reset_cache()
set_cursor(100, "gap-test")
E._gap_start = 0
sync_calls = []
E._request_sync = lambda reason="", force=False: sync_calls.append((reason, force)) or None

E.handle_message({"ts": 1700050000, "type": "new_order", "payload": {}, "messageId": "gap-1", "seq": 120},
                 skip_notify=True)
c.check("跨空洞的实时消息：消息仍入库",
        any(m.get("messageId") == "gap-1" for m in E.load_messages()))
c.check("跨空洞的实时消息：游标原地不动（不跳洞）",
        E._sync_state["last_seq"] == 100, E._sync_state["last_seq"])
c.check("跨空洞的实时消息：记录空洞起点", E._gap_start == 101, E._gap_start)
c.check("跨空洞的实时消息：触发强制补拉", sync_calls == [("gap", True)], sync_calls)

sync_calls.clear()
E.handle_message({"ts": 1700050001, "type": "new_order", "payload": {}, "messageId": "gap-2", "seq": 121},
                 skip_notify=True)
c.check("空洞未补齐前，后续实时消息也不推游标",
        E._sync_state["last_seq"] == 100 and E._gap_start == 101,
        (E._sync_state["last_seq"], E._gap_start))
c.check("空洞存续期间重复请求走节流（force=False，不绕过 SYNC_MIN_INTERVAL）",
        sync_calls == [("gap", False)], sync_calls)

# 连续消息（无空洞）照常推进
set_cursor(121, "gap-test")
E._gap_start = 0
E.handle_message({"ts": 1700050002, "type": "new_order", "payload": {}, "messageId": "gap-3", "seq": 122},
                 skip_notify=True)
c.check("连续消息照常推进游标", E._sync_state["last_seq"] == 122, E._sync_state["last_seq"])

# 补拉路径（force）越过空洞起点 → 空洞闭合
E._gap_start = 101
E._advance_seq(150, force=True)
c.check("补拉推进可越过空洞（force）", E._sync_state["last_seq"] == 150, E._sync_state["last_seq"])
c.check("补拉越过空洞起点后自动闭合", E._gap_start == 0, E._gap_start)

# head 对账（不依赖实时消息也能发现落后；连接假死 + 无消息时唯一的报警来源）
E._api_get_status = lambda url, timeout=10: (200, {"success": True, "max_seq": 5000})
set_cursor(100, "gap-test")
sync_calls.clear()
c.check("head 对账：算出落后条数", E._check_cursor_lag() == 4900, E._cursor_lag)
c.check("head 对账：落后超阈值 → 强制补拉", ("lag", True) in sync_calls, sync_calls)
set_cursor(4990, "gap-test")
sync_calls.clear()
c.check("head 对账：差值小于阈值不打扰",
        E._check_cursor_lag() == 10 and sync_calls == [], sync_calls)

# ══ 13. 补拉来源不做「seq <= 游标」判拒（防"防重复防到防修复"）══════
set_cursor(200, "gap-test")
c.check("补拉来源：游标之后的老 seq 仍可入库",
        E._claim_message(150, "sync-mid-1", "sync-mid-1", source="sync") is True)
c.check("补拉来源：同一条重复仍被去重",
        E._claim_message(150, "sync-mid-1", "sync-mid-1", source="sync") is False)
c.check("实时来源：seq <= 游标依旧判拒",
        E._claim_message(150, "live-mid-1", "live-mid-1", source="live") is False)

# ══ 14. 时间解析 / 北京时间（修「订单时间 58647 年」）══════════════
c.check("_parse_ts_any 毫秒 → 秒", E._parse_ts_any(1790346360000) == 1790346360,
        E._parse_ts_any(1790346360000))
c.check("_parse_ts_any 秒原样返回", E._parse_ts_any(1790346360) == 1790346360)
c.check("_parse_ts_any 字符串秒", E._parse_ts_any("1790346360") == 1790346360)
c.check("_parse_ts_any ISO(UTC) → 北京 22:26",
        E._fmt_bj(E._parse_ts_any("2026-09-25T14:26:00Z")) == "2026-09-25 22:26:00",
        E._fmt_bj(E._parse_ts_any("2026-09-25T14:26:00Z")))
c.check("_parse_ts_any 越界/垃圾值 → 0",
        E._parse_ts_any(12345) == 0 and E._parse_ts_any("abc") == 0 and E._parse_ts_any(None) == 0)
c.check("_fmt_bj 用 +8h 读 UTC 分量（与机器时区无关）",
        E._fmt_bj(0) == "1970-01-01 08:00:00", E._fmt_bj(0))
c.check("_bj_today_str 长度正确", len(E._bj_today_str()) == 10, E._bj_today_str())

# 存储消息必须带 ts（排序唯一依据）+ 北京时间渲染
reset_cache()
E.store_message(1790346360, "new_order", {"out_trade_no": "t1"}, message_id="ts-1", seq=900)
m_last = E.recent_messages(1)[0]
c.check("store_message 落 ts 字段", m_last.get("ts") == 1790346360, m_last.get("ts"))
c.check("store_message 用北京时间渲染 time",
        m_last.get("time") == E._fmt_bj(1790346360), m_last.get("time"))
E.store_message(1790346360000, "new_order", {"out_trade_no": "t2"}, message_id="ts-2", seq=901)
c.check("store_message 收到毫秒也不会写成 58647 年",
        E.recent_messages(1)[0].get("ts") == 1790346360
        and E.recent_messages(1)[0].get("time", "").startswith("2026-"),
        E.recent_messages(1)[0].get("time"))

# ══ 15. 订单列表：最新第一 + 历史脏时间修复 ════════════════════════
reset_cache()
if os.path.exists(E.TIME_REPAIR_FLAG):
    os.remove(E.TIME_REPAIR_FLAG)
E.store_message(1790300000, "new_order", {"out_trade_no": "old", "total_amount": "10.00"},
                message_id="o-old", seq=910)
E.store_message(1790346360, "new_order", {"out_trade_no": "new", "total_amount": "20.00"},
                message_id="o-new", seq=911)
# 注入一条历史脏数据（毫秒当秒渲染出来的 5 位年份）
E.load_messages().append({
    "time": "58647-12-15 08:50:41", "type": "new_order",
    "payload": {"out_trade_no": "dirty", "paid_at": 1788583423841, "total_amount": "30.00"},
    "messageId": "o-dirty", "read": True,
})
orders = E._build_order_list()
c.check("订单列表：最新订单在第一名",
        orders and orders[0].get("trade_no") == "new", [o.get("trade_no") for o in orders])
c.check("订单列表：严格按时间倒序",
        all((orders[i].get("ts") or 0) >= (orders[i + 1].get("ts") or 0) for i in range(len(orders) - 1)),
        [o.get("ts") for o in orders])

fixed = E._repair_message_times()
c.check("历史脏时间被修复（含 ts 补齐）", fixed >= 1, fixed)
dirty = [m for m in E.load_messages() if m.get("messageId") == "o-dirty"][0]
c.check("脏时间年份回到 2026（且用 payload.paid_at 权威值）",
        dirty.get("time", "")[:4] == "2026" and dirty.get("ts") == 1788583423,
        (dirty.get("time"), dirty.get("ts")))
c.check("修复后所有订单都有 ts", all(m.get("ts") for m in E.load_messages()))
c.check("修复程序幂等（标记文件存在则跳过）", E._repair_message_times() == 0)
orders2 = E._build_order_list()
c.check("修复后脏订单不再排在最前",
        orders2[-1].get("trade_no") == "dirty", [o.get("trade_no") for o in orders2])
c.check("修复后列表仍严格倒序",
        all((orders2[i].get("ts") or 0) >= (orders2[i + 1].get("ts") or 0)
            for i in range(len(orders2) - 1)), [o.get("ts") for o in orders2])
c.check("_ts_from_time_str 可反解 5 位年份（strptime/timegm 会抛异常）",
        E._ts_from_time_str("58647-12-15 08:50:41") > 10 ** 11,
        E._ts_from_time_str("58647-12-15 08:50:41"))

d3 = E.DashboardWindow(None)   # 窗口引用为 None（测试环境）时轮询不得抛异常
d3._poll_window_closed()
c.check("无窗口引用时轮询安全退出", d3._last_visible is None)

# ══ 16. 顶部菜单：顺序 + 登录/退出互斥（顺序唯一真源 = _menu_spec）════════
def _label_for(spec, action):
    for _k, label, act, _key in spec:
        if act == action:
            return label
    return None


spec = E._menu_spec()
labels = [s[1] for s in spec if s[1]]

c.check("菜单第一项是「打开面板」", spec[0][1] == "打开面板", spec[0])
c.check("菜单最后一项是「退出」（关闭软件，防误点）",
        spec[-1][1] == "退出" and spec[-1][2] == "quit_app", spec[-1])
c.check("第二项是灰显状态行", spec[1][0] == "status", spec[1])
c.check("版本行在「退出」之前",
        [s[0] for s in spec][-2:] == ["version", "item"], [s[0] for s in spec])
c.check("顺序：打开面板 → 截图 → 退出",
        labels.index("打开面板") < labels.index("截图") < labels.index("退出"), labels)
c.check("菜单里不再有登录/退出登录项（已移入面板账号区）",
        not any(("登录" in x) for x in labels), labels)

# 暂停文案随状态变化
c.check("未暂停 → 「暂停接收」", _label_for(E._menu_spec(False), "toggle_pause") == "暂停接收")
c.check("已暂停 → 「恢复接收」", _label_for(E._menu_spec(True), "toggle_pause") == "恢复接收")

# 菜单回调必须都真实存在（防改名字改出一个点了没反应的菜单项）
missing_cb = [act for _k, _l, act, _key in spec if act and not hasattr(E.EvNotifier, act)]
c.check("菜单回调方法都存在", not missing_cb, missing_cb)
c.check("截图保留快捷键 key=4",
        [s[3] for s in spec if s[2] == "start_screenshot"] == ["4"])

# 回归：EvNotifier 里不许再调 self._refresh_content()（那是 DashboardWindow 的方法，
# 历史上登录/退出后必抛 AttributeError: 'EvNotifier' object has no attribute '_refresh_content'）
import inspect  # noqa: E402
_app_src = inspect.getsource(E.EvNotifier)
c.check("EvNotifier 不再误调 self._refresh_content()",
        "self._refresh_content()" not in _app_src)
c.check("登录/退出走 _refresh_panel()", hasattr(E.EvNotifier, "_refresh_panel"))

# ══ 17. 登录态判定：只认设备令牌（共享密钥 = 运维通道，不算登录）════════
store = {"tok": ""}
calls = {"delete": 0, "set": 0}
E._keychain_get_token = lambda: store["tok"]
E._keychain_set_token = lambda t: (store.__setitem__("tok", t), calls.__setitem__("set", calls["set"] + 1), True)[2]
E._keychain_delete_token = lambda: (store.__setitem__("tok", ""), calls.__setitem__("delete", calls["delete"] + 1))
E.DEVICE_TOKEN = None
E._device_token_probed = True
E._session_logged_out = False
E._auth_state = "unknown"
E.SYNC_TOKEN = "shared-secret-key"

c.check("只有共享密钥 → 不算已登录（严格）", E._is_logged_in() is False)
c.check("共享密钥的文案标明是运维通道", "运维通道" in E._auth_label(), E._auth_label())
c.check("登录页状态 = shared_key_only", E._login_state_reason() == "shared_key_only",
        E._login_state_reason())
c.check("未保存登录信息时不显示「直接登录」", E._has_saved_login() is False)

E.DEVICE_TOKEN = "fake-device-token"
c.check("有设备令牌 → 已登录", E._is_logged_in() is True)
c.check("已登录文案 = 设备令牌", "设备令牌" in E._auth_label(), E._auth_label())
c.check("登录页状态 = ok", E._login_state_reason() == "ok")
E.DEVICE_TOKEN = None


class _FakeApp(E.EvNotifier):
    """继承 EvNotifier 拿到全部方法，但**不跑 __init__**（不起线程、不连 Redis）。

    这些方法（logout_soft / clear_saved_login）只用 notify_macos + _refresh_panel，
    在测试里都安全。
    ⚠️ 必须显式覆盖 __init__：否则会调父类构造 → 起 `_run_event_loop` 线程（连 Redis）
       还会 `ensure_auto_start()` 往临时 HOME 里写 LaunchAgent。
    """

    def __init__(self):
        pass


fake_app = _FakeApp()

# 软登出：清内存会话、保留钥匙串、不自动恢复
store["tok"] = "fake-device-token"
E.EvNotifier.logout_soft(fake_app)
c.check("软登出 → 内存令牌清空", E.DEVICE_TOKEN is None)
c.check("软登出 → 不自动从钥匙串恢复（否则一进登录页就被自动登录）", E._is_logged_in() is False)
c.check("软登出 → 钥匙串保留（可以「直接登录」）", E._has_saved_login() is True)
c.check("软登出 → 没有删钥匙串", calls["delete"] == 0, calls)

# 直接登录：用保存的登录信息恢复会话
ok, msg = E.direct_login()
c.check("直接登录成功（无需浏览器）", ok is True and E.DEVICE_TOKEN == "fake-device-token", (ok, msg))
c.check("直接登录后状态 = ok", E._is_logged_in() is True and E._auth_state == "ok", E._auth_state)

# 硬登出：真删钥匙串（设置页入口）
E.EvNotifier.clear_saved_login(fake_app)
c.check("硬登出 → 删了钥匙串", calls["delete"] >= 1, calls)
c.check("硬登出 → 不再有可用的登录信息", E._has_saved_login() is False)
c.check("硬登出 → 内存令牌也清了", E.DEVICE_TOKEN is None)

# 401 处理：软登出状态下的 401 不能删钥匙串、也不该报警
store["tok"] = "fake-device-token"
E._session_logged_out = True
E._auth_state = "missing"
E.DEVICE_TOKEN = None
before = calls["delete"]
E._on_auth_failed("test-401-after-logout")
c.check("软登出后的 401 不删钥匙串（否则毁掉「直接登录」）", calls["delete"] == before, calls)
c.check("软登出后的 401 不改状态为 invalid", E._auth_state == "missing", E._auth_state)
E.SYNC_TOKEN = None
E._session_logged_out = False
E._auth_state = "unknown"

sys.exit(c.done())
