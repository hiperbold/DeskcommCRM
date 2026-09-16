#!/usr/bin/env bash
# Leva o schema do repositório para a PRODUÇÃO (Supabase Cloud) e garante a chave
# de cifra. Rodar ANTES de publicar código que dependa de coluna nova: o deploy
# do EasyPanel só troca a imagem, não mexe no banco.
#
# Mesmo caminho do `update.sh` do autor: re-aplica o `baseline.sql`, que é
# idempotente, e filtra o ruído esperado de objetos que já existem. Qualquer
# outro erro aparece e faz o script sair com falha.
set -euo pipefail
cd "$(dirname "$0")/../.."
F=.env.production
[ -r "$F" ] || { echo "falta $F"; exit 1; }

getv() { { grep -E "^$1=" "$F" || true; } | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//; s/^\"//; s/\"$//" | tr -d '\r'; }
URL="$(getv SUPABASE_DB_ADMIN_URL)"
[ -n "$URL" ] || URL="$(getv SUPABASE_DB_URL)"
[ -n "$URL" ] || { echo "sem SUPABASE_DB_URL em $F"; exit 1; }

echo "== extensões"
docker run --rm postgres:17-alpine psql "$URL" -q -c \
  "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;"

echo "== baseline.sql"
LOG=/tmp/deskcomm-prod-schema.log
docker run --rm -i -v "$PWD/supabase/baseline.sql:/b.sql:ro" postgres:17-alpine \
  psql "$URL" -f /b.sql > "$LOG" 2>&1 || true
benigno='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
inesperado="$(grep -iE 'ERROR|FATAL' "$LOG" | grep -viE "$benigno" || true)"
if [ -n "$inesperado" ]; then
  echo "erros que NÃO são os esperados (log completo em $LOG):"
  printf '%s\n' "$inesperado" | head -20
  exit 1
fi
echo "baseline aplicado sem erro inesperado"

echo "== chave de cifra"
bash hiperbold/scripts/semear-chave-de-cifra.sh producao
