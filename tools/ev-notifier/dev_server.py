#!/usr/bin/env python3
"""Ev Notifier 面板本地开发调试服务器

用法:
    python3 dev_server.py          # 启动开发服务器 (默认端口 8899)
    python3 dev_server.py 9000     # 指定端口
    python3 dev_server.py 8899 --debug  # 调试模式 (显示调试工具栏)
    然后浏览器打开: http://localhost:8899

功能:
    - 自动从 Python 模块生成最新 HTML
    - 浏览器实时预览，无需重启
    - 支持 CSS/JS 热重载 (F5 刷新即可)
    - 自动打开浏览器
    - 调试模式: 显示页面结构、数据、性能信息
"""

import sys
import os
import json
import subprocess
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
from datetime import datetime

# 确保能导入 ev_notifier 模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
DEBUG_MODE = "--debug" in sys.argv or "-d" in sys.argv
HTML_CACHE = None
LAST_UPDATE = 0
REQUEST_COUNT = 0


def generate_html():
    """从 ev_notifier 模块生成最新 HTML"""
    global REQUEST_COUNT
    REQUEST_COUNT += 1
    start_time = time.time()
    
    try:
        # 临时设置环境变量避免连接 Redis
        os.environ.setdefault("UPSTASH_TOKEN", "dev_mode")

        import ev_notifier as ev

        # 创建模拟 app 引用
        class MockApp:
            pass

        dashboard = ev.DashboardWindow(MockApp())
        html = dashboard._build_current_html()
        
        gen_time = time.time() - start_time
        
        if DEBUG_MODE:
            html = inject_debug_toolbar(html, gen_time, REQUEST_COUNT, dashboard)
        
        return html
    except Exception as e:
        print(f"[ERROR] 生成 HTML 失败: {e}")
        import traceback
        traceback.print_exc()
        return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body {{ background: #1a1a2e; color: #ff6b6b; font-family: system-ui; padding: 40px; }}
.error {{ background: #2a2a3e; padding: 20px; border-radius: 8px; }}
</style></head><body>
<div class="error">
<h2>生成 HTML 失败</h2>
<p>{e}</p>
<pre>{traceback.format_exc()}</pre>
</div>
</body></html>"""


def inject_debug_toolbar(html, gen_time, req_count, dashboard):
    """注入调试工具栏"""
    import ev_notifier as ev
    
    # 获取当前数据
    try:
        msgs = ev.load_messages()
        msg_count = len(msgs)
    except:
        msg_count = 0
    
    try:
        polls = ev.load_poll_log()
        poll_count = sum(len(p.get("polls", [])) for p in polls.values())
    except:
        poll_count = 0
    
    toolbar = f"""
<!-- 调试工具栏 -->
<div id="ev-debug-toolbar" style="
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 20px;
    z-index: 99999;
    border-top: 2px solid #89b4fa;
    box-shadow: 0 -4px 12px rgba(0,0,0,0.3);
">
    <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:#89b4fa;font-weight:700;">🔧 DEBUG</span>
    </div>
    <div style="display:flex;gap:16px;">
        <span>⏱️ 生成时间: <b style="color:#a6e3a1;">{gen_time:.3f}s</b></span>
        <span>📄 请求次数: <b style="color:#f9e2af;">{req_count}</b></span>
        <span>📊 HTML 大小: <b style="color:#cba6f7;">{len(html):,} bytes</b></span>
        <span>💬 消息数: <b style="color:#89dceb;">{msg_count}</b></span>
        <span>🔄 轮询数: <b style="color:#fab387;">{poll_count}</b></span>
        <span>📌 当前页: <b style="color:#f38ba8;">{dashboard._current_page}</b></span>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px;">
        <button onclick="fetch('/reload').then(()=>location.reload())" style="
            background:#89b4fa;color:#1e1e2e;border:none;padding:4px 12px;
            border-radius:4px;cursor:pointer;font-weight:600;font-size:11px;
        ">🔄 重新生成</button>
        <button onclick="document.getElementById('ev-debug-data').style.display = 
            document.getElementById('ev-debug-data').style.display === 'none' ? 'block' : 'none'" style="
            background:#cba6f7;color:#1e1e2e;border:none;padding:4px 12px;
            border-radius:4px;cursor:pointer;font-weight:600;font-size:11px;
        ">📋 查看数据</button>
        <button onclick="document.getElementById('ev-debug-toolbar').style.display='none'" style="
            background:#585b70;color:#cdd6f4;border:none;padding:4px 12px;
            border-radius:4px;cursor:pointer;font-size:11px;
        ">✕ 关闭</button>
    </div>
</div>

<!-- 数据查看面板 -->
<div id="ev-debug-data" style="
    display:none;position:fixed;bottom:40px;left:16px;right:16px;
    max-height:300px;overflow:auto;background:#181825;color:#cdd6f4;
    font-family:'SF Mono','Fira Code',monospace;font-size:11px;
    padding:12px;border-radius:8px 8px 0 0;z-index:99998;
    border:1px solid #45475a;box-shadow:0 -2px 8px rgba(0,0,0,0.4);
">
<pre id="ev-debug-data-content">加载中...</pre>
</div>

<script>
// 自动加载数据
fetch('/api/data')
    .then(r => r.json())
    .then(data => {{
        document.getElementById('ev-debug-data-content').textContent = 
            JSON.stringify(data, null, 2);
    }})
    .catch(err => {{
        document.getElementById('ev-debug-data-content').textContent = 
            '加载失败: ' + err;
    }});

// 键盘快捷键
document.addEventListener('keydown', function(e) {{
    if (e.key === 'd' && e.ctrlKey) {{
        e.preventDefault();
        var toolbar = document.getElementById('ev-debug-toolbar');
        toolbar.style.display = toolbar.style.display === 'none' ? 'flex' : 'none';
    }}
    if (e.key === 'r' && e.ctrlKey) {{
        e.preventDefault();
        fetch('/reload').then(()=>location.reload());
    }}
}});
</script>
"""
    
    # 在 </body> 前插入调试工具栏
    return html.replace("</body>", toolbar + "</body>")


class DevHandler(SimpleHTTPRequestHandler):
    """开发服务器请求处理器"""

    def do_GET(self):
        global HTML_CACHE, LAST_UPDATE

        parsed = urlparse(self.path)

        if parsed.path == "/" or parsed.path == "/index.html":
            # 检查是否需要重新生成 (每 2 秒检查一次)
            now = time.time()
            if now - LAST_UPDATE > 2:
                HTML_CACHE = generate_html()
                LAST_UPDATE = now

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(HTML_CACHE.encode("utf-8"))

        elif parsed.path == "/api/data":
            # 返回当前数据供调试
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                import ev_notifier as ev
                data = {
                    "messages": ev.load_messages()[:10],
                    "status": ev._status,
                    "new_msg_count": ev._new_msg_count,
                    "version": ev.VERSION,
                }
                self.wfile.write(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"))

        elif parsed.path == "/reload":
            # 强制刷新 HTML
            HTML_CACHE = generate_html()
            LAST_UPDATE = time.time()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status": "reloaded"}')

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        """自定义日志格式"""
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {format % args}")


def open_browser(url):
    """延迟打开浏览器"""
    time.sleep(1.5)
    subprocess.run(["open", url])


def main():
    print("=" * 60)
    print("  Ev Notifier 面板开发服务器")
    print("=" * 60)
    print()
    
    if DEBUG_MODE:
        print("🔧 调试模式: 已启用")
        print("   - 页面底部显示调试工具栏")
        print("   - Ctrl+D: 切换调试工具栏显示/隐藏")
        print("   - Ctrl+R: 强制重新生成 HTML")
        print()
    else:
        print("ℹ️  普通模式 (使用 --debug 或 -d 启用调试模式)")
        print()

    # 预生成 HTML
    print("正在生成 HTML...")
    global HTML_CACHE
    HTML_CACHE = generate_html()
    LAST_UPDATE = time.time()
    print(f"HTML 生成成功，长度: {len(HTML_CACHE)}")
    print()

    url = f"http://localhost:{PORT}"
    print(f"🌐 预览地址: {url}")
    print(f"📊 数据接口: {url}/api/data")
    print(f"🔄 强制刷新: {url}/reload")
    print()
    print("提示:")
    print("  - 浏览器中按 F5 刷新查看最新效果")
    print("  - 修改 ev_notifier.py 后访问 /reload 重新生成 HTML")
    print("  - Ctrl+C 停止服务器")
    print()

    # 启动浏览器
    threading.Thread(target=open_browser, args=(url,), daemon=True).start()

    # 启动服务器
    server = HTTPServer(("localhost", PORT), DevHandler)
    print(f"服务器启动在端口 {PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止")
        server.shutdown()


if __name__ == "__main__":
    main()