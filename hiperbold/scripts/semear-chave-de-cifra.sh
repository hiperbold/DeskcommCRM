#!/usr/bin/env bash
# Semeia a chave de cifra dos segredos no banco: `private.app_secrets`, linha
# `nuvemshop_oauth_key`. É de lá que `fn_encrypt_oauth`/`fn_decrypt_oauth` leem, e
# sem ela TODA credencial cifrada (token de instância, segredo de webhook, OAuth)
# responde 422 com "cifra indisponível nesta instalação".
#
# O instalador do autor faz isto (`ensure_encryption_key`, hostgator-setup-kit),
# mas os scripts da Hiperbold não passam por ele: sem este passo o banco nasce
# sem chave, no local e na produção.
#
# Uso:
#   semear-chave-de-cifra.sh local        # lê .env.local, grava no Supabase local
#   semear-chave-de-cifra.sh producao     # lê .env.production, grava no Supabase Cloud
#
# Idempotente. NUNCA troca uma chave que o banco já tem por outra diferente: o
# que já foi cifrado com a antiga viraria ilegível. Nesse caso para e avisa.
# O valor da chave nunca é impresso.
set -euo pipefail
cd "$(dirname "$0")/../.."

alvo="${1:-}"
case "$alvo" in
  local) F=.env.local ;;
  producao) F=.env.production ;;
  *) echo "uso: $0 local|producao"; exit 2 ;;
esac
[ -r "$F" ] || { echo "falta $F"; exit 1; }

getv() { { grep -E "^$1=" "$F" || true; } | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//; s/^\"//; s/\"$//" | tr -d '\r'; }
KEY="$(getv NUVEMSHOP_OAUTH_ENCRYPTION_KEY)"
[ -n "$KEY" ] || { echo "NUVEMSHOP_OAUTH_ENCRYPTION_KEY vazia em $F"; exit 1; }

if [ "$alvo" = local ]; then
  DB=$(docker ps --format '{{.Names}}' | grep -E '^supabase_db_' | head -1)
  [ -n "$DB" ] || { echo "Supabase local não está rodando"; exit 1; }
  psqlc() { docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
else
  URL="$(getv SUPABASE_DB_ADMIN_URL)"
  [ -n "$URL" ] || URL="$(getv SUPABASE_DB_URL)"
  [ -n "$URL" ] || { echo "sem SUPABASE_DB_URL em $F"; exit 1; }
  psqlc() { docker run --rm -i postgres:17-alpine psql "$URL" -v ON_ERROR_STOP=1 -qtA "$@"; }
fi

# A chave vai por variável do psql (`:'chave'`), não interpolada no SQL: o psql
# faz a citação, e um caractere estranho na chave não quebra o comando.
estado="$(psqlc -v chave="$KEY" <<'SQL'
select case
  when not exists (select 1 from private.app_secrets where name = 'nuvemshop_oauth_key') then 'ausente'
  when (select value from private.app_secrets where name = 'nuvemshop_oauth_key') = :'chave' then 'igual'
  else 'diferente'
end;
SQL
)"

case "$estado" in
  igual) echo "chave de cifra: já estava semeada ($alvo)" ;;
  diferente)
    echo "chave de cifra: o banco ($alvo) tem OUTRA chave. Não troco: o que já foi cifrado ficaria ilegível."
    echo "Resolver à mão: alinhar NUVEMSHOP_OAUTH_ENCRYPTION_KEY de $F com a chave do banco."
    exit 1 ;;
  ausente)
    psqlc -v chave="$KEY" <<'SQL'
insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', :'chave')
on conflict (name) do nothing;
SQL
    echo "chave de cifra: semeada ($alvo)" ;;
  *) echo "chave de cifra: não consegui ler o estado ($alvo): $estado"; exit 1 ;;
esac
