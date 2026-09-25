#!/bin/bash
# EvNotifier 离线补拉 / 已读 相关测试一键运行（全部离线，不打网络）
set -e
cd "$(dirname "$0")/../../.."

echo "===== 1/4 静态 lint（被丢弃的字符串 / 未声明 global）====="
python3 tools/ev-notifier/tests/test_static_lint.py

echo
echo "===== 2/4 服务端单测 lib/message-delivery.js（mock Postgres）====="
node test/message-delivery.sync.test.js

echo
echo "===== 3/4 客户端单测（幂等 / 水位线 / 并发 / 已读 / 补拉）====="
python3 tools/ev-notifier/tests/test_offline_sync.py

echo
echo "===== 4/4 面板渲染 + 内嵌 JS 语法校验 ====="
python3 tools/ev-notifier/tests/test_panel_render.py

echo
echo "全部通过。"
echo "（线上接口冒烟需显式执行，会打生产只读接口：python3 tools/ev-notifier/tests/smoke_online.py）"
