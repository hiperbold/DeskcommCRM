#!/usr/bin/env bash
# Produção: cria o projeto Supabase Cloud (São Paulo), grava as 4 credenciais no
# .env.production, aplica extensões + baseline.sql, configura os e-mails de login
# e cria o primeiro dono. Idempotente: pula o que já estiver feito.
# Precisa de SUPABASE_ACCESS_TOKEN em C:\Users\nucle\.claude\.env.
set -euo pipefail
cd "$(dirname "$0")/../.."
F=.env.production
KIT=hostgator-setup-kit
DADOS_WIN=/mnt/f/github-projects/hiperbold-crm-data.md
OWNER_EMAIL="${OWNER_EMAIL:-oliveira@hiperbold.com.br}"

[ -e "$F" ] || { echo "falta $F (rode a geração de segredos antes)"; exit 1; }
G=/mnt/c/Users/nucle/.claude/.env
SUPABASE_ACCESS_TOKEN="$(grep -E '^SUPABASE_ACCESS_TOKEN=' "$G" | head -1 | cut -d= -f2- | tr -d '"\r')"
[ -n "$SUPABASE_ACCESS_TOKEN" ] || { echo "SUPABASE_ACCESS_TOKEN ausente no .env global"; exit 1; }
export SUPABASE_ACCESS_TOKEN

getv() { grep -E "^$1=" "$F" | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//"; }

echo "== 1. projeto Supabase"
if [ -n "$(getv NEXT_PUBLIC_SUPABASE_URL)" ]; then
  echo "credenciais já presentes no $F, não crio outro projeto"
else
  OUT="$(mktemp)"
  trap 'rm -f "$OUT"' EXIT
  bash "$KIT/supabase-provision.sh" "hiperbold-crm" sa-east-1 > "$OUT"
  for k in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL; do
    v="$(grep -E "^$k=" "$OUT" | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//")"
    [ -n "$v" ] || { echo "provisionamento não devolveu $k"; exit 1; }
    printf '%s=%s\n' "$k" "$v" >> "$F"
  done
  echo "4 credenciais gravadas no $F"
fi

set -a
# shellcheck disable=SC1090
. <(grep -E '^[A-Z0-9_]+=' "$F")
set +a

PSQL=(docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q)

echo "== 2. extensões + baseline"
"${PSQL[@]}" -c "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;"
docker run --rm -i -v "$PWD/supabase/baseline.sql:/baseline.sql:ro" postgres:17-alpine \
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f /baseline.sql > /tmp/deskcomm-prod-baseline.log 2>&1
echo "baseline ok, tabelas em public: $("${PSQL[@]}" -tAc "select count(*) from pg_tables where schemaname='public'")"

echo "== 3. e-mails de login (Site URL, Redirect URLs, modelos com a marca)"
bash "$KIT/marca-emails.sh" --env "$PWD/$F" || echo "AVISO: marca-emails não concluiu, ver saída acima"

echo "== 4. primeiro dono ($OWNER_EMAIL)"
if "${PSQL[@]}" -tAc "select 1 from auth.users where email='${OWNER_EMAIL}'" | grep -q 1; then
  echo "usuário já existe no Auth, não gero senha nova"
else
  OWNER_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 512 /dev/urandom) | head -c 24)"
  curl -fsS -X POST "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${OWNER_EMAIL}\",\"password\":\"${OWNER_PASSWORD}\",\"email_confirm\":true,\"user_metadata\":{\"locale\":\"pt-BR\"}}" \
    > /dev/null
  umask 077
  {
    [ -s "$DADOS_WIN" ] || printf '# Hiperbold CRM (DeskcommCRM) · acessos\n\nNão colar em chat nem em commit.\n'
    printf '\n## Produção\n\nEndereço: https://crm.hiperbold.com.br\nE-mail: %s\nSenha inicial: %s\nCriado em %s. Trocar a senha no primeiro acesso.\n' \
      "$OWNER_EMAIL" "$OWNER_PASSWORD" "$(date -Iseconds)"
  } >> "$DADOS_WIN"
  echo "senha inicial gravada em F:\\github-projects\\hiperbold-crm-data.md"
fi

"${PSQL[@]}" <<SQL
do \$\$
declare v_org uuid; v_uid uuid;
begin
  select id into v_uid from auth.users where email = '${OWNER_EMAIL}';
  if v_uid is null then
    raise exception 'usuário % não encontrado no auth.users', '${OWNER_EMAIL}';
  end if;
  select id into v_org from public.organizations where slug = 'hiperbold';
  if v_org is null then
    insert into public.organizations (slug, display_name, legal_name, locale, created_by)
    values ('hiperbold', 'Hiperbold', 'Hiperbold', 'pt-BR', v_uid)
    returning id into v_org;
  end if;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
  values (v_uid, v_org, 'admin', now())
  on conflict (user_id, organization_id) do update set role = 'admin', revoked_at = null;
  if not exists (select 1 from public.platform_admins where user_id = v_uid and revoked_at is null) then
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
    values (v_uid, v_uid, 'full', false, 'Bootstrap inicial Hiperbold');
  end if;
end \$\$;
SQL
echo "dono promovido: organização Hiperbold + super-admin"
