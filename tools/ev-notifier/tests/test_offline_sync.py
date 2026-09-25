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


def reset_cache():
    """消息走内存缓存后，测试之间必须显式清缓存 + 清磁盘，否则会互相污染。"""
    if os.path.exists(E.MESSAGES_FILE):
        os.remove(E.MESSAGES_FILE)
    E._MSG_CACHE = None
    E._known_ids.clear()
    E._seen_ids.clear()
    E._unread_cache = None
    E._MSG_DIRTY = False


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
E._sync_state["last_seq"] = 10
E._sync_inflight = True
E._advance_seq(999)
c.check("补拉进行中：实时消息不推进游标", E._sync_state["last_seq"] == 10, E._sync_state["last_seq"])
E._sync_inflight = False
E._sync_pending = True
E._advance_seq(999)
c.check("补拉排队中：实时消息不推进游标", E._sync_state["last_seq"] == 10, E._sync_state["last_seq"])
E._sync_pending = False
E._advance_seq(999)
c.check("补拉结束后可推进", E._sync_state["last_seq"] == 999)
E._advance_seq(500)
c.check("游标只增不减", E._sync_state["last_seq"] == 999)
E._advance_seq(-1)
c.check("非法 seq 被忽略", E._sync_state["last_seq"] == 999)

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
    return {
        "success": True,
        "messages": [{"seq": str(seq_cursor["v"] - 10 + i), "message_id": "s%d" % (seq_cursor["v"] - 10 + i),
                      "message_type": "page_visit", "payload": {}, "created_at": "2026-09-25T00:00:00Z"}
                     for i in range(10)],
        "next_cursor": seq_cursor["v"],
        "has_more": True,
    }


E._api_get_json = fake_api
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
E._api_get_json = lambda url, timeout=10: None
E._sync_state["last_seq"] = 0
E.sync_since("test-fallback")
c.check("冷启动 head 不可用 → 降级 legacy", legacy["n"] == 1, legacy["n"])

E._sync_state["last_seq"] = 0
E._startup_recovery = fake_legacy
E._api_get_json = lambda url, timeout=10: {"success": True, "max_seq": 777}
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

# ══ 7. 共享密钥（与服务端 EV_SYNC_TOKEN 配对）══════════════════════
E.SYNC_TOKEN = None
c.check("未配 token：不带鉴权 header", E._auth_headers() == [])
E.SYNC_TOKEN = "abc123"
c.check("配了 token：带 x-ev-sync-token header",
        E._auth_headers() == ["-H", "x-ev-sync-token: abc123"], E._auth_headers())
E.SYNC_TOKEN = None

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

sys.exit(c.done())
