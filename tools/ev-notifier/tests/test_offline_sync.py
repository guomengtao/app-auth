#!/usr/bin/env python3
"""离线补拉 + 已读状态 单元测试（离线，不打网络）。

运行: python3 tools/ev-notifier/tests/test_offline_sync.py
"""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import load_ev, Checker  # noqa: E402

E = load_ev()
c = Checker()

# ══ 1. 存储 / 未读 / 已读 ══════════════════════════════════════════
E._rebuild_known_ids()
E.store_message(1700000000, "new_order", {"a": 1}, message_id="m1", seq=1)
E.store_message(1700000001, "page_visit", {"b": 2}, message_id="m2", seq=2)
c.check("store 2 条", len(E.load_messages()) == 2, len(E.load_messages()))
c.check("未读 = 2", E.count_unread() == 2, E.count_unread())

msgs = E.load_messages()
c.check("最新消息在 index 0", msgs[0].get("seq") == 2 and msgs[1].get("seq") == 1,
        [m.get("seq") for m in msgs])

# _msg_key 优先级：seq > messageId > time|type
c.check("_msg_key 优先 seq", E._msg_key({"seq": 9, "messageId": "zz"}) == "s:9")
c.check("_msg_key 次选 messageId", E._msg_key({"messageId": "zz"}) == "m:zz")
c.check("_msg_key 兜底 time|type", E._msg_key({"time": "t", "type": "x"}) == "t:t|x")

# 已读：幂等 + dirty 才落盘
real_save = E.save_messages
calls = {"n": 0}


def counting_save(data):
    calls["n"] += 1
    return real_save(data)


E.save_messages = counting_save
k_top = E._msg_key(E.load_messages()[0])
c.check("mark_read 首次变化 1 条", E.mark_read([k_top]) == 1)
calls["n"] = 0
c.check("mark_read 重复调用 0 变化", E.mark_read([k_top]) == 0)
c.check("无变化不落盘（dirty 判定）", calls["n"] == 0, calls["n"])
E.save_messages = real_save
c.check("已读后未读 = 1", E.count_unread() == 1, E.count_unread())
c.check("已读标记已持久化", E.load_messages()[0].get("read") is True)

# 存储上限 500
for i in range(520):
    E.store_message(1700001000 + i, "page_visit", {"i": i}, message_id="bulk%d" % i, seq=100 + i)
c.check("消息上限截断到 500", len(E.load_messages()) == 500, len(E.load_messages()))
c.check("截断后 JSON 仍可读", isinstance(E.load_messages(), list))

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
E._seen_ids.clear()
E._known_ids.clear()
os.remove(E.MESSAGES_FILE) if os.path.exists(E.MESSAGES_FILE) else None
E._rebuild_known_ids()

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
            len(got) == min(N_THREADS * N_EACH, 500), len(got))
except Exception as e:
    c.check("并发写后 JSON 仍合法", False, e)

# 存储 + 已读交叉并发，文件不能被写坏
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

sys.exit(c.done())
