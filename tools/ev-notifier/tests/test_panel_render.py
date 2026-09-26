#!/usr/bin/env python3
"""面板渲染冒烟测试 + 内嵌 JS 语法校验。

为什么需要：面板的 JS 藏在 Python 字符串常量里，py_compile 永远查不出来；
只有 WebKit 真正加载时才炸，表现为「面板空白 / 打不开」。
这里把每个页面真实渲染出来，逐块 <script> 跑 node --check。

运行: python3 tools/ev-notifier/tests/test_panel_render.py
"""
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import load_ev, Checker  # noqa: E402

E = load_ev(home="/tmp/ev_notifier_render_home")
c = Checker()

tmpdir = tempfile.mkdtemp(prefix="ev_panel_")
dash = E.DashboardWindow(None)

total_blocks = 0
for page, builder in E.DashboardWindow._TAB_BUILDERS.items():
    dash._current_page = page
    try:
        html = E.DashboardWindow._build_current_html(dash)
    except Exception as e:
        c.check("渲染页面 %s" % page, False, "%s: %s" % (type(e).__name__, e))
        continue
    c.check("渲染页面 %s" % page, "<html" in html and "</html>" in html, "%d bytes" % len(html))
    blocks = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
    bad = []
    for i, js in enumerate(blocks):
        if len(js.strip()) < 20:
            continue
        p = os.path.join(tmpdir, "%s_%d.js" % (page, i))
        with open(p, "w", encoding="utf-8") as f:
            f.write(js)
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        total_blocks += 1
        if r.returncode != 0:
            bad.append("script#%d: %s" % (i, (r.stderr.strip().splitlines() or ["?"])[0][:180]))
    c.check("页面 %s 内嵌 JS 语法（%d 块）" % (page, len(blocks)), not bad, "; ".join(bad))

# 消息页专项：改动点必须出现在产物里（需要有消息，否则列表是空态）
E.store_message(1700000000, "new_order", {"a": 1}, message_id="r1", seq=1)
E.store_message(1700000001, "new_order", {"a": 2}, message_id="r2", seq=2)
dash._current_page = "messages"
html = E.DashboardWindow._build_current_html(dash)
c.check("消息卡片带 data-mid（可见即已读依赖）", 'data-mid="' in html)
c.check("单条已读入口存在", "markOneRead(" in html)
c.check("可见即已读上报存在", "reportVisibleRead" in html)
c.check("默认筛选为 all（不再默认 unread）", "filterMessages('all')" in html)
c.check("焦点判定存在（后台面板不误标已读）", "document.hasFocus()" in html)
c.check("未读空态文案存在", "没有未读消息" in html)
c.check("统计卡用未读口径", "未读消息" in html)
c.check("同步状态行存在", "游标" in html)

# 已读/未读样式类仍然正确
html = E.DashboardWindow._build_current_html(dash)
c.check("新消息渲染为未读样式", "msg-unread" in html)
# 未读标识（All 视图里快速看出哪些是新的）：NEW 胶囊 + 左侧蓝条
c.check("未读卡片带 NEW 胶囊", 'class="msg-new"' in html)
c.check("未读样式含左侧蓝条（扫一眼可辨）", "inset 3px 0 0" in html)
c.check("NEW 胶囊有独立样式定义", ".msg-new {" in html and ".msg-new::before" in html)
E.mark_read([E._msg_key(m) for m in E.load_messages()])
html = E.DashboardWindow._build_current_html(dash)
c.check("标记后渲染为已读样式", "msg-read" in html)
c.check("已标记的卡片不再出现 NEW 胶囊", 'class="msg-new"' not in html)
c.check("已读后未读计数为 0", E.count_unread() == 0, E.count_unread())

print("\n共校验 script 块: %d" % total_blocks)
sys.exit(c.done())
