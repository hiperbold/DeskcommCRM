#!/usr/bin/env bash
# Liga o SMTP da SendKit (conta da Hiperbold) nos e-mails de login do Supabase de
# PRODUÇÃO: confirmação de conta, recuperação de senha, convite. Sem isto o
# Supabase envia cerca de 2 e-mails por hora, e quem pediu o link fica esperando
# um e-mail que não chega.
#
# Lê SUPABASE_ACCESS_TOKEN e SENDKIT_SMTP_* do .env global. Nenhum valor é
# impresso; a senha vai num arquivo temporário com permissão 600, apagado logo.
#
# Uso: bash hiperbold/scripts/prod-smtp.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
G=/mnt/c/Users/nucle/.claude/.env
gv() { { grep -E "^$1=" "$G" || true; } | head -1 | cut -d= -f2- | tr -d '"\r'; }

T="$(gv SUPABASE_ACCESS_TOKEN)"
[ -n "$T" ] || { echo "SUPABASE_ACCESS_TOKEN ausente no .env global"; exit 1; }
REF="$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.production | cut -d= -f2- | sed -E "s#^'?https://([^.]+)\..*#\1#")"
for k in SENDKIT_SMTP_HOST SENDKIT_SMTP_PORT SENDKIT_SMTP_USERNAME SENDKIT_SMTP_PASSWORD SENDKIT_SENDER; do
  [ -n "$(gv $k)" ] || { echo "$k ausente no .env global"; exit 1; }
done

umask 077
CORPO="$(mktemp)"
trap 'rm -f "$CORPO"' EXIT
python3 - "$(gv SENDKIT_SMTP_HOST)" "$(gv SENDKIT_SMTP_PORT)" "$(gv SENDKIT_SMTP_USERNAME)" "$(gv SENDKIT_SMTP_PASSWORD)" "$(gv SENDKIT_SENDER)" > "$CORPO" <<'PY'
import json, sys
host, porta, usuario, senha, remetente = sys.argv[1:]
print(json.dumps({
    "smtp_host": host, "smtp_port": porta, "smtp_user": usuario, "smtp_pass": senha,
    "smtp_admin_email": remetente, "smtp_sender_name": "Hiperbold CRM",
    # Com SMTP próprio o teto deixa de ser o do Supabase: 30/h cobre convite e
    # recuperação de senha sem abrir espaço para disparo em massa.
    "rate_limit_email_sent": 30,
}))
PY

code="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $T" -H "content-type: application/json" \
  --data @"$CORPO" "https://api.supabase.com/v1/projects/$REF/config/auth")"
echo "configuração de SMTP: http $code"
[ "$code" = 200 ] || exit 1

curl -s -m 30 -H "Authorization: Bearer $T" "https://api.supabase.com/v1/projects/$REF/config/auth" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ["smtp_host","smtp_port","smtp_admin_email","smtp_sender_name","rate_limit_email_sent"]})'
