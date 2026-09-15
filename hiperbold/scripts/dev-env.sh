#!/usr/bin/env bash
# Gera o .env.local de desenvolvimento a partir do Supabase local. Nunca sobrescreve um existente.
set -euo pipefail
cd "$(dirname "$0")/../.."

F=.env.local
git check-ignore -q "$F" || { echo "$F NAO esta ignorado pelo Git, abortando"; exit 1; }
# `pnpm worker` e `pnpm dev:crons` usam tsx --env-file=.env, que falha se o arquivo não existir.
[ -e .env ] || : > .env

if [ -e "$F" ]; then
  echo "$F ja existe, nao sobrescrevo"
  exit 0
fi

SBENV="$(mktemp)"
trap 'rm -f "$SBENV"' EXIT
npx --yes supabase@2.117.0 status -o env > "$SBENV"
val() { grep -E "^$1=" "$SBENV" | head -1 | cut -d= -f2- | tr -d '"'; }

G=/mnt/c/Users/nucle/.claude/.env
gval() { if [ -r "$G" ]; then grep -E "^$1=" "$G" | head -1 | cut -d= -f2- | tr -d '"\r'; fi; }

umask 077
h() { openssl rand -hex 32; }
b() { openssl rand -base64 32; }
WK="$(h)"
SRH="$(h)"

cat > "$F" <<EOF
# DeskcommCRM Hiperbold, DESENVOLVIMENTO no WSL. Nunca commitar. Gerado em $(date -Iseconds).
NEXT_PUBLIC_SUPABASE_URL=$(val API_URL)
NEXT_PUBLIC_SUPABASE_ANON_KEY=$(val ANON_KEY)
SUPABASE_SERVICE_ROLE_KEY=$(val SERVICE_ROLE_KEY)
SUPABASE_DB_URL=$(val DB_URL)
NEXT_PUBLIC_APP_URL=http://localhost:3300
NEXT_PUBLIC_ADMIN_URL=http://localhost:3300
INTERNAL_SECRET=$(h)
CPF_ENCRYPTION_KEY=$(b)
AI_CRED_AES_KEY=$(b)
WAHA_BYO_ENCRYPTION_KEY=$(b)
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=$(b)
IMPERSONATE_COOKIE_SECRET=$(h)
LGPD_SIGNING_KEY=$(h)
WAHA_API_BASE_URL=http://localhost:3230
WAHA_WEBHOOK_BASE_URL=http://host.docker.internal:3300
WAHA_API_KEY=${WK}
WAHA_API_KEY_SHA512=$(printf %s "$WK" | sha512sum | cut -d' ' -f1)
WAHA_HMAC_SECRET=$(h)
UPSTASH_REDIS_REST_URL=http://localhost:8090
SRH_TOKEN=${SRH}
UPSTASH_REDIS_REST_TOKEN=${SRH}
ANTHROPIC_API_KEY=$(gval ANTHROPIC_API_KEY)
OPENAI_API_KEY=$(gval OPENAI_API_KEY)
AGENT_DISPATCH_CONSUMER=engine
NUVEMSHOP_ENABLED=false
INTERNAL_AGENT_RUN_STUB=false
SENTRY_DSN=off
APP_NAME=Hiperbold CRM
EOF
chmod 600 "$F"

echo "ok: $(grep -cE '^[A-Z0-9_]+=' "$F") chaves"
echo "vazias: $(grep -E '^[A-Z0-9_]+=\s*$' "$F" | cut -d= -f1 | tr '\n' ' ')"
