#!/bin/bash
# 消息投递 / 离线补拉 / 已读 / 鉴权 相关测试一键运行（全部离线，不打网络）
#
# 覆盖的是「EvNotifier 通知链路 + 后台鉴权」这一整条：服务端 lib/*、api/admin/health.js、
# 后台面板 admin_Dx23.html、客户端 tools/ev-notifier/ev_notifier.py。
set -e
cd "$(dirname "$0")/../../.."

echo "===== 1/8 静态 lint（被丢弃的字符串 / 未声明 global）====="
python3 tools/ev-notifier/tests/test_static_lint.py

echo
echo "===== 2/8 鉴权回归（伪造 _vercel_jwt 必须被拒）====="
node test/auth-forged-cookie.test.js

echo
echo "===== 3/8 服务端 lib/device-token.js（设备令牌：只存哈希/撤销/节流）====="
node test/device-token.test.js

echo
echo "===== 4/8 服务端 lib/message-delivery.js（mock Postgres，断言 SQL）====="
node test/message-delivery.sync.test.js

echo
echo "===== 5/8 服务端 api/admin/health.js 客户端访问控制 ====="
node test/admin-client-access.test.js

echo
echo "===== 6/8 后台面板 admin_Dx23.html 内联 JS 语法 ====="
node test/admin-panel.inline-js.test.js

echo
echo "===== 7/8 客户端（幂等 / 水位线 / 并发 / 已读 / 补拉 / 凭据 / 性能门槛）====="
python3 tools/ev-notifier/tests/test_offline_sync.py

echo
echo "===== 8/8 客户端面板渲染 + 内嵌 JS 语法校验 ====="
python3 tools/ev-notifier/tests/test_panel_render.py

echo
echo "全部通过。"
echo "（线上接口冒烟需显式执行，会打生产只读接口：python3 tools/ev-notifier/tests/smoke_online.py）"
