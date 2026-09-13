#!/bin/bash
ps aux | grep ev_notifier | grep -v grep
echo "---"
cat /Users/Banner/ev_notifier_debug.log 2>/dev/null || echo "no log"
echo "DONE"