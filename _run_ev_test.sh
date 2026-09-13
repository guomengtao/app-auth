#!/bin/bash
set -e
OUT=/Users/Banner/Documents/guomengtao/app-auth/_ev_test_out.txt

echo "=== $(date) ===" > $OUT

# kill old
pkill -f ev_notifier.py 2>/dev/null || true
sleep 2
echo "killed old" >> $OUT

# sync
cp /Users/Banner/Documents/guomengtao/app-auth/tools/ev-notifier/ev_notifier.py /Users/Banner/Desktop/EvNotifier.app/ev_notifier.py
echo "synced code" >> $OUT

# clear log
rm -f /Users/Banner/ev_notifier_debug.log

# start
open /Users/Banner/Desktop/EvNotifier.app
echo "started via open" >> $OUT

# wait for connection
sleep 8

# check process
ps aux | grep ev_notifier | grep -v grep >> $OUT 2>&1
echo "---" >> $OUT

# check log
cat /Users/Banner/ev_notifier_debug.log 2>&1 >> $OUT || echo "NO DEBUG LOG" >> $OUT
echo "---" >> $OUT

# send test message via curl
MSG='{"ts":'$(date +%s)',"type":"new_activation","payload":{"product_name":"DebugTest","months":1,"source":"admin-direct","activation_code":"DEBUG-001","redeem_code":"DEBUG-REDEEM","device_id":"device-debug"}}'
ENCODED=$(python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=''))" "$MSG")
curl -s --max-time 10 -X POST \
  "https://on-cat-235786.upstash.io/xadd/auth%3Anotifications%3Astream/*/data/${ENCODED}" \
  -H "Authorization: Bearer gQAAAAAAA5kKAAIgcDIwNTEzNDZiNTQxMmU0ODgyOTZmMzZkNmNjYmUwNzRhYQ" \
  >> $OUT 2>&1
echo "" >> $OUT

# wait for processing
sleep 8

# check log again
echo "=== AFTER 8S ===" >> $OUT
cat /Users/Banner/ev_notifier_debug.log 2>&1 >> $OUT || echo "STILL NO LOG" >> $OUT

# check group status
curl -s --max-time 10 -X POST \
  "https://on-cat-235786.upstash.io/xinfo/groups/auth:notifications:stream" \
  -H "Authorization: Bearer gQAAAAAAA5kKAAIgcDIwNTEzNDZiNTQxMmU0ODgyOTZmMzZkNmNjYmUwNzRhYQ" \
  >> $OUT 2>&1

echo "=== DONE ===" >> $OUT