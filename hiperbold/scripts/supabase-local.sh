#!/usr/bin/env bash
# Sobe o Supabase local do zero do jeito que o e2e.yml do autor faz: a cadeia de
# migrations não monta banco novo, então ela sai do caminho, entra o baseline.sql
# e o Realtime reinicia para enxergar a publication criada pelo baseline.
# APAGA os dados locais (stop --no-backup).
set -uo pipefail
cd "$(dirname "$0")/../.."
SB="npx --yes supabase@2.117.0"
OFF=/tmp/deskcomm-migrations-off

restore() {
  if [ -d "$OFF" ]; then
    mv supabase/migrations "/tmp/deskcomm-migrations-empty-$(date +%s)"
    mv "$OFF" supabase/migrations
    echo "migrations restauradas: $(ls supabase/migrations | wc -l) arquivos"
  fi
}

$SB stop --no-backup || true
mv supabase/migrations "$OFF" && mkdir supabase/migrations
trap restore EXIT
$SB start || { echo "START FALHOU"; exit 1; }
restore
trap - EXIT

DB=$(docker ps --format '{{.Names}}' | grep -E '^supabase_db_' | head -1)
psqlc() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

psqlc <<'SQL'
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
SQL
echo "extensoes exit=$?"

psqlc < supabase/baseline.sql > /tmp/deskcomm-baseline.log 2>&1
echo "baseline exit=$?"

IDS=$(docker ps -q --filter name=supabase_realtime)
docker restart $IDS > /dev/null
s=x
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' $IDS 2>/dev/null || echo x)
  [ "$s" = healthy ] && break
  sleep 2
done
echo "realtime=$s"
# Sem a chave, toda credencial cifrada responde 422 (D-021). Na primeira vez o
# .env.local ainda não existe: o dev-env.sh semeia depois de gerá-lo.
if [ -r .env.local ]; then
  bash hiperbold/scripts/semear-chave-de-cifra.sh local || echo "AVISO: chave de cifra não semeada"
fi
echo "tabelas em public: $(docker exec -i "$DB" psql -U postgres -d postgres -tAc "select count(*) from pg_tables where schemaname='public'")"
