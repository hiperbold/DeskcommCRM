#!/usr/bin/env bash
# Emergência: redefine a senha de um usuário (ex: o dono se trancou pra fora).
# Não há reset por e-mail sem SMTP, então isto usa a admin API do Supabase.
#
#   bash hostgator-setup-kit/reset-password.sh dono@empresa.com
source "$(dirname "$0")/_common.sh"
enter_project

EMAIL="${1:-}"
[ -n "$EMAIL" ] || die "Uso: reset-password.sh <email>"

uid="$(owner_id_by_email "$EMAIL")"
[ -n "$uid" ] || die "Usuário '$EMAIL' não encontrado."

read -r -s -p "Nova senha para $EMAIL: " pw; echo
[ -n "$pw" ] || die "Senha vazia."

step "Redefinindo senha"
# Cabeçalhos por arquivo 0600 e corpo por stdin: nem a chave nem a senha entram na
# linha de comando (visível em `ps`), e a senha é escapada para o JSON (D-169).
cab="$(cabecalhos_admin_em_arquivo)"
if printf '{"password":"%s"}' "$(json_escape "$pw")" \
  | curl -fsS -X PUT "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${uid}" \
      -H @"$cab" --data-binary @- >/dev/null; then
  rm -f "$cab"
  c_grn "✓ senha redefinida para $EMAIL"
else
  rm -f "$cab"
  die "Falha ao redefinir. Confira a service_role key."
fi
