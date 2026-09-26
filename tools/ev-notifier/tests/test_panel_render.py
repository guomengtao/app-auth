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
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import load_ev, Checker  # noqa: E402

E = load_ev(home="/tmp/ev_notifier_render_home")
c = Checker()

# ⚠️ 门禁会读设备令牌 → 必须打桩钥匙串：否则会去读**真实**钥匙串（可能弹权限框/读到真令牌）
E._keychain_get_token = lambda: "test-device-token"
E._keychain_set_token = lambda tok: True
E._keychain_delete_token = lambda: None
E._load_device_token()          # 载入桩令牌 → 已登录，8 个数据页才渲染得出来
E._session_logged_out = False

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

# ══ 账号区（左下角）+ 设置页账号区块 ══════════════════════════════
E._save_account({"email": "foo@bar.com", "label": "MacBook-Air.local",
                 "created_at": 1790300000, "last_seen_at": 1790346360,
                 "fetched_at": int(time.time())})
dash._current_page = "messages"
html = E.DashboardWindow._build_current_html(dash)
c.check("左下角账号区存在", 'id="accountBox"' in html)
c.check("已登录：账号区显示邮箱", "foo@bar.com" in html)
c.check("账号小菜单里有版本号", ("v" + E.VERSION) in html)
c.check("账号小菜单里有最后活跃（北京时间）", "最后活跃" in html and "2026-" in html)
c.check("已登录：账号区动作是「退出登录」", "ev://logout" in html)
c.check("已登录：导航可点（带 data-tab）", 'data-tab="settings"' in html)
c.check("账号小菜单样式已定义", ".account-menu {" in html and ".account-box {" in html)

dash._current_page = "settings"
shtml = E.DashboardWindow._build_current_html(dash)
c.check("设置页有「账号」区块", "登录账号" in shtml and "foo@bar.com" in shtml)
c.check("设置页有软登出（ev://logout）", 'href="ev://logout"' in shtml)
c.check("设置页有硬登出「清除本机登录信息」", "ev://clear-login" in shtml)
c.check("设置页有开机自启开关（写偏好而非只说路径）", "ev://setting=auto_start" in shtml)

# ══ 未登录门禁：任何页面（含设置页）都只渲染登录页 ═══════════════════
E.DEVICE_TOKEN = None
E._device_token_probed = True
E._session_logged_out = True
E._keychain_get_token = lambda: ""          # 本机没有保存的登录信息
for page in ("messages", "orders", "visitors", "settings"):
    dash._current_page = page
    g = E.DashboardWindow._build_current_html(dash)
    c.check("未登录时页面 %s 只渲染登录页" % page,
            "登录后即可使用" in g and "gateLogin()" in g, page)
g = E.DashboardWindow._build_current_html(dash)
c.check("登录页有「保存登录信息」勾选", 'id="gateSaveLogin"' in g)
c.check("登录页有「我已授权，重新检查」", "gateRecheck()" in g)
c.check("未登录时不渲染任何业务数据",
        'class="msg-card' not in g and "订单总量" not in g, len(g))
c.check("未登录时左侧导航锁定（nav-locked）", "nav-locked" in g)
c.check("未登录时账号区提示登录", "未登录，点这里登录" in g and "ev://login" in g)
c.check("无保存信息时不显示「直接登录」按钮", 'onclick="gateDirectLogin()"' not in g)
c.check("登录页样式已定义", ".login-gate {" in g and ".gate-btn {" in g)

E._keychain_get_token = lambda: "test-device-token"   # 有保存的登录信息
c.check("有保存信息时登录页显示「直接登录」按钮",
        'onclick="gateDirectLogin()"' in E.DashboardWindow._build_current_html(dash))

# 门禁下切页无效（防前端 JS 绕过）
d2 = E.DashboardWindow(None)
d2._current_page = "messages"
E.DashboardWindow._switch_to(d2, "orders")
c.check("未登录时切页无效", d2._current_page == "messages", d2._current_page)

print("\n共校验 script 块: %d" % total_blocks)
sys.exit(c.done())
