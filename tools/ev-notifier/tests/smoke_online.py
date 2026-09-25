#!/usr/bin/env python3
"""线上接口冒烟测试（会打真实生产接口，只读 + 无害）。

安全说明：
- delivery-sync 全是 GET；
- delivery-callback 只用不存在的 UUID，不会改动任何真实投递记录。

访问控制：如果本机设了 EV_SYNC_TOKEN，脚本会带上它，并额外校验
「不带凭据应被拒绝」。没设则按「服务端未配置」处理（向后兼容必须放行）。

运行: python3 tools/ev-notifier/tests/smoke_online.py [base_url]
"""
import json
import os
import subprocess
import sys
import tempfile
import re
import urllib.parse

# 用 curl 而不是 urllib：与 ev_notifier 自身一致，且绕开框架版 Python 的 CA 证书问题
BASE = sys.argv[1] if len(sys.argv) > 1 else "https://app-auth.gudq.com"
API = BASE + "/api/admin/health"


def _load_token():
    """优先环境变量；否则从仓库根 .env 读（省得每次手敲）。

    与 ev_notifier.load_env() 一致：只认 ^[A-Z_]+= 形式，忽略注释/空行。
    """
    tok = (os.environ.get("EV_SYNC_TOKEN") or "").strip()
    if tok:
        return tok, "env"
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
                if m and m.group(1) == "EV_SYNC_TOKEN":
                    v = m.group(2).strip().strip("\"'")
                    if v:
                        return v, ".env"
    except Exception:
        pass
    return "", "未找到"


TOKEN, TOKEN_SRC = _load_token()

fails = []
passed = 0


def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1
        print("PASS  " + name)
    else:
        fails.append(name)
        print("FAIL  " + name + ("  → " + str(extra)[:200] if extra else ""))


def _curl(args, timeout=25, with_token=True):
    fd, tmp = tempfile.mkstemp(suffix=".json", prefix="ev_smoke_")
    os.close(fd)
    auth = ["-H", "x-ev-sync-token: " + TOKEN] if (TOKEN and with_token) else []
    try:
        p = subprocess.run(
            ["curl", "-s", "--connect-timeout", "5", "--max-time", str(timeout),
             "-w", "%{http_code}", "-o", tmp] + auth + args,
            capture_output=True, text=True, timeout=timeout + 5)
        raw = open(tmp, encoding="utf-8").read().strip()
        code = (p.stdout or "").strip().splitlines()[-1] if (p.stdout or "").strip() else "0"
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass
    try:
        return int(code), json.loads(raw or "{}")
    except Exception:
        return int(code or 0), {}


def get(params, timeout=25, with_token=True):
    return _curl([API + "?" + urllib.parse.urlencode(params)], timeout, with_token)


def post(params, body, timeout=25, with_token=True):
    return _curl(["-X", "POST", "-H", "Content-Type: application/json",
                  "-d", json.dumps(body), API + "?" + urllib.parse.urlencode(params)],
                 timeout, with_token)


print("目标: %s" % BASE)
print("EV_SYNC_TOKEN: %s（来源: %s）\n" % ("已配置" if TOKEN else "未配置", TOKEN_SRC))

# 0. 访问控制
st, _ = get({"section": "delivery-sync", "action": "head"}, with_token=False)
if TOKEN:
    check("已配置 token：不带凭据 → 401", st == 401, st)
    st2, j2 = get({"section": "delivery-sync", "action": "head"}, with_token=True)
    check("已配置 token：带对凭据 → 200", st2 == 200, st2)
    st3, _ = post({"section": "delivery-callback"},
                  {"event": "delivered", "message_id": "00000000-0000-0000-0000-000000000000"},
                  with_token=False)
    check("已配置 token：callback 不带凭据 → 401", st3 == 401, st3)
else:
    check("未配置 token：匿名可访问（向后兼容，不能因缺配置中断补拉）", st == 200, st)

# 1. head
st, j = get({"section": "delivery-sync", "action": "head"})
check("head 返回 200", st == 200, st)
check("head 返回 success", j.get("success") is True, j)
max_seq = j.get("max_seq")
check("head 返回 max_seq（整数 > 0）", isinstance(max_seq, int) and max_seq > 0, max_seq)
check("head 返回保留期", isinstance(j.get("retention_hours"), int), j.get("retention_hours"))

# 2. 追平：after = max_seq 应为空
st, j = get({"section": "delivery-sync", "client_id": "smoke", "after": max_seq, "limit": 200})
check("追平后 200", st == 200, st)
check("追平后 messages 为空", j.get("messages") == [], j.get("messages"))
check("追平后 has_more=false", j.get("has_more") is False, j.get("has_more"))
check("追平后 next_cursor == max_seq", j.get("next_cursor") == max_seq, j.get("next_cursor"))

# 3. 增量拉取结构
after = max(0, max_seq - 3)
st, j = get({"section": "delivery-sync", "client_id": "smoke", "after": after, "limit": 200})
msgs = j.get("messages") or []
check("增量返回 %d 条" % len(msgs), len(msgs) == min(3, max_seq), len(msgs))
if msgs:
    m0 = msgs[0]
    check("消息含 seq/message_id/message_type/payload/created_at",
          all(k in m0 for k in ("seq", "message_id", "message_type", "payload", "created_at")), list(m0))
    check("seq 严格递增（游标语义正确）",
          all(int(a["seq"]) < int(b["seq"]) for a, b in zip(msgs, msgs[1:])),
          [m["seq"] for m in msgs])
    check("全部 seq > after", all(int(m["seq"]) > after for m in msgs), after)
    check("next_cursor = 本批最大 seq",
          j.get("next_cursor") == max(int(m["seq"]) for m in msgs), j.get("next_cursor"))

# 4. 幂等：同一游标两次结果一致
st2, j2 = get({"section": "delivery-sync", "client_id": "smoke", "after": after, "limit": 200})
check("同一游标两次结果一致（幂等）",
      [m["message_id"] for m in (j.get("messages") or [])] == [m["message_id"] for m in (j2.get("messages") or [])])

# 5. limit 钳制
st, j = get({"section": "delivery-sync", "client_id": "smoke", "after": 0, "limit": 99999})
n = len(j.get("messages") or [])
check("limit 被钳制到 <= 500", n <= 500, n)

# 6. 方法约束
st, _ = post({"section": "delivery-sync", "action": "head"}, {})
check("delivery-sync 拒绝 POST（405）", st == 405, st)

# 7. callback 校验（用不存在的 UUID，不会动真实数据）
FAKE = "00000000-0000-0000-0000-000000000000"
st, j = post({"section": "delivery-callback"}, {"event": "delivered", "message_id": FAKE})
check("单条 delivered 回执 200", st == 200 and j.get("success") is True, (st, j))
st, j = post({"section": "delivery-callback"}, {"event": "read", "client_id": "smoke",
                                                "message_ids": [FAKE, "11111111-1111-1111-1111-111111111111"]})
check("批量 read 回执 200 且 count=2", st == 200 and j.get("count") == 2, (st, j))
st, j = post({"section": "delivery-callback"}, {"message_id": FAKE})
check("缺 event → 400", st == 400, (st, j))
st, j = post({"section": "delivery-callback"}, {"event": "delivered"})
check("缺 message_id → 400", st == 400, (st, j))
st, j = post({"section": "delivery-callback"}, {"event": "bogus", "message_id": FAKE})
check("非法 event → 400", st == 400, (st, j))
st, j = get({"section": "delivery-callback"})
check("callback 拒绝 GET（405）", st == 405, st)

print("\nPASS: %d  FAILED: %d" % (passed, len(fails)))
sys.exit(1 if fails else 0)
