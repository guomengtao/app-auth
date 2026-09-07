#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Load env vars from .env file (gitignored, contains real secrets)
# Use grep to parse key=value pairs, skipping comments and empty lines
while IFS='=' read -r key value; do
  if [ -n "$key" ] && [ "${key:0:1}" != "#" ]; then
    # Remove surrounding quotes from value
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    export "$key=$value"
  fi
done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env 2>/dev/null || true)

# Unset VERCEL_TOKEN to use Vercel CLI's stored auth token
unset VERCEL_TOKEN

SCOPE="guomengtaos-projects-7a91cee5"
PROJECT="app-auth"

add_env() {
  local name="$1"
  local value="$2"
  local extra_args=""
  # NEXT_PUBLIC_ prefixed vars that look like credentials need --type config
  if [[ "$name" == NEXT_PUBLIC_* ]]; then
    extra_args="--type config"
  fi
  echo "Adding: $name"
  printf "%s" "$value" | npx vercel env add "$name" production --scope "$SCOPE" --project "$PROJECT" --force --yes $extra_args 2>&1 || true
}

add_env DB_PROVIDER "${DB_PROVIDER:-supabase}"
add_env NEXT_PUBLIC_Ev_SUPABASE_URL "${NEXT_PUBLIC_Ev_SUPABASE_URL:-YOUR_SUPABASE_URL}"
add_env NEXT_PUBLIC_Ev_SUPABASE_ANON_KEY "${NEXT_PUBLIC_Ev_SUPABASE_ANON_KEY:-YOUR_ANON_KEY}"
add_env Ev_POSTGRES_DATABASE "${Ev_POSTGRES_DATABASE:-postgres}"
add_env Ev_POSTGRES_HOST "${Ev_POSTGRES_HOST:-YOUR_DB_HOST}"
add_env Ev_POSTGRES_PASSWORD "${Ev_POSTGRES_PASSWORD:-YOUR_DB_PASSWORD}"
add_env Ev_POSTGRES_USER "${Ev_POSTGRES_USER:-postgres}"
add_env Ev_POSTGRES_URL "${Ev_POSTGRES_URL:-YOUR_POSTGRES_URL}"
add_env Ev_POSTGRES_URL_NON_POOLING "${Ev_POSTGRES_URL_NON_POOLING:-YOUR_POSTGRES_URL_NON_POOLING}"
add_env Ev_POSTGRES_PRISMA_URL "${Ev_POSTGRES_PRISMA_URL:-YOUR_PRISMA_URL}"
add_env Ev_SUPABASE_PUBLISHABLE_KEY "${Ev_SUPABASE_PUBLISHABLE_KEY:-YOUR_PUBLISHABLE_KEY}"
add_env Ev_SUPABASE_SECRET_KEY "${Ev_SUPABASE_SECRET_KEY:-YOUR_SECRET_KEY}"
add_env Ev_SUPABASE_SERVICE_ROLE_KEY "${Ev_SUPABASE_SERVICE_ROLE_KEY:-YOUR_SERVICE_ROLE_KEY}"
add_env Ev_SUPABASE_JWT_SECRET "${Ev_SUPABASE_JWT_SECRET:-YOUR_JWT_SECRET}"

echo ""
echo "All Supabase env vars added to Vercel production!"