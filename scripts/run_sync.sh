#!/bin/bash
set -e
cd /Users/Banner/Documents/guomengtao/app-auth

# Load env files
set -a
source .env 2>/dev/null || true
source .env.local 2>/dev/null || true
set +a

# Run with explicit env vars
node scripts/_run-sync.js 2>&1 | tee scripts/_sync_terminal.txt
echo "Exit code: $?" >> scripts/_sync_terminal.txt