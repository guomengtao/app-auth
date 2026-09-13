#!/usr/bin/env python3
"""Ev Notifier 面板本地开发调试服务器

用法:
    python3 dev_server.py          # 启动开发服务器 (默认端口 8899)
    python3 dev_server.py 9000     # 指定端口
    然后浏览器打开: http://localhost:8899

功能:
    - 自动从 Python 模块生成最新 HTML
    - 浏览器实时预览，无需重启
    - 支持 CSS/JS 热重载 (F5 刷新即可)
    - 自动打开浏览器
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
HTML_CACHE = None
LAST_UPDATE = 0


def generate_html():
    """从 ev_notifier 模块生成最新 HTML"""
    try:
        # 临时设置环境变量避免连接 Redis
        os.environ.setdefault("UPSTASH_TOKEN", "dev_mode")

        import ev_notifier as ev

        # 创建模拟 app 引用
        class MockApp:
            pass

        dashboard = ev.DashboardWindow(MockApp())
        html = dashboard._build_current_html()
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

    # 预生成 HTML
    print("正在生成 HTML...")
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