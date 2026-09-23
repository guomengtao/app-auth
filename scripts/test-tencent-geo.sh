#!/bin/bash
# 腾讯位置服务「IP 定位」命令行测试 —— 看 key 能不能用、能不能查到具体区县
#
# 用法：
#   ./scripts/test-tencent-geo.sh                        # 测一组内置样例 IP
#   ./scripts/test-tencent-geo.sh 1.2.3.4 5.6.7.8        # 测指定 IP
#   ./scripts/test-tencent-geo.sh --module 8.8.8.8       # 走项目代码 lib/geo-district.js（含 Supabase 缓存）
#
# key 从 .env 的 TENCENT_MAP_KEY / TENCENT_MAP_REFERER 读取，也可用同名环境变量覆盖。
# 注意：该 key 走「域名白名单」校验，请求必须带 Referer，否则报 status 110。
set -u
cd "$(dirname "$0")/.."

env_get() {
  local name="$1"
  local v="${!name:-}"
  if [ -z "$v" ] && [ -f .env ]; then
    v=$(grep -E "^${name}=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')
  fi
  echo "$v"
}

KEY=$(env_get TENCENT_MAP_KEY)
REFERER=$(env_get TENCENT_MAP_REFERER)
[ -z "$REFERER" ] && REFERER="https://gudq.com/"

if [ -z "$KEY" ]; then
  echo "❌ 没有找到 TENCENT_MAP_KEY（.env 或环境变量）"
  exit 1
fi

# --- 模式二：走项目真实代码路径（含落库缓存）---
if [ "${1:-}" = "--module" ]; then
  shift
  MOD_IP="${1:-36.110.9.142}"
  echo "== lib/geo-district.js getDistrict($MOD_IP) =="
  node - "$MOD_IP" <<'NODEEOF'
var fs = require('fs');
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(function (l) {
    var m = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}
var g = require('./lib/geo-district');
g.getDistrict(process.argv[2]).then(function (d) {
  console.log('=> ' + JSON.stringify(d) + (d ? '  ✅ 拿到区县' : '  ⚠️ 空（接口失败或该 IP 无区县）'));
  process.exit(0);
});
NODEEOF
  exit 0
fi

IPS=("$@")
if [ ${#IPS[@]} -eq 0 ]; then
  IPS=(36.110.9.142 220.181.38.148 183.232.231.172 119.29.29.29 202.108.22.5 114.114.114.114)
fi

echo "Referer  : $REFERER"
echo "Key      : ${KEY:0:8}...（已隐藏）"
echo ""
printf "%-17s %-7s %-30s %s\n" "IP" "STATUS" "MESSAGE" "省 / 市 / 区县"
printf -- "------------------------------------------------------------------------------\n"

for ip in "${IPS[@]}"; do
  body=$(curl -s --max-time 8 -H "Referer: $REFERER" \
    "https://apis.map.qq.com/ws/location/v1/ip?ip=${ip}&key=${KEY}")
  BODY="$body" IP="$ip" python3 - <<'PYEOF' 2>/dev/null || echo "$ip  -> 原始响应: $body"
import json, os
d = json.loads(os.environ["BODY"])
ad = (d.get("result") or {}).get("ad_info") or {}
loc = " ".join([x for x in [ad.get("province"), ad.get("city"), ad.get("district")] if x]) or "-"
line = (ad.get("province"), ad.get("city"), ad.get("district"))
print("%-17s %-7s %-30s %s" % (os.environ["IP"], d.get("status"), (d.get("message") or "")[:28], loc))
PYEOF
done

echo ""
echo "status 说明：0=成功 | 110=来源域名未授权（缺 Referer） | 121=当日调用量已达上限 | 311=key 不存在或未开通"
