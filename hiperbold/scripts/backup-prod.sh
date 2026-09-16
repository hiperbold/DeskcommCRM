#!/usr/bin/env bash
# Backup diário do banco de PRODUÇÃO (Supabase Cloud) para fora da VPS e fora do
# Supabase: disco D: desta máquina. O plano Free do Supabase não guarda backup
# nenhum que se possa baixar, então sem isto um erro de banco é perda total.
#
# Diferente de `scripts/backup-db.sh` do autor, que copia só `public`: aqui vão
# também `auth` (sem ela ninguém entra depois de restaurar) e `private` (a chave
# de cifra; sem ela tokens e segredos gravados viram lixo). Os ARQUIVOS do
# Storage (mídia, logos) não estão no banco e não entram aqui.
#
# Uso: bash hiperbold/scripts/backup-prod.sh [pasta]   (padrão: D:\Hiperbold\backups\hiperbold-crm)
# Agendado no Windows pela tarefa "HiperboldCRM-BackupBanco".
set -euo pipefail
cd "$(dirname "$0")/../.."

DIR="${1:-/mnt/d/Hiperbold/backups/hiperbold-crm}"
RETENCAO_DIAS="${RETENCAO_DIAS:-30}"
F=.env.production
[ -r "$F" ] || { echo "falta $F"; exit 1; }
getv() { { grep -E "^$1=" "$F" || true; } | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//; s/^\"//; s/\"$//" | tr -d '\r'; }
URL="$(getv SUPABASE_DB_URL)"
[ -n "$URL" ] || { echo "sem SUPABASE_DB_URL em $F"; exit 1; }

# O Docker do WSL pode ainda estar subindo quando a tarefa agendada dispara.
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 5; done

mkdir -p "$DIR"
STAMP="$(date +%Y-%m-%d_%H%M)"
NOME="hiperbold-crm-$STAMP.dump"
TMP="$DIR/.$NOME.parcial"

docker run --rm -v "$DIR:/out" postgres:17-alpine \
  pg_dump "$URL" --format=custom --no-owner --no-privileges \
  --schema=public --schema=auth --schema=private \
  --file="/out/.$NOME.parcial"

# Só vira backup o que o pg_restore consegue LER: arquivo truncado por queda de
# rede no meio do dump não pode ocupar o lugar de um bom.
tabelas="$(docker run --rm -v "$DIR:/out" postgres:17-alpine pg_restore --list "/out/.$NOME.parcial" | grep -c 'TABLE DATA' || true)"
if [ "${tabelas:-0}" -lt 50 ]; then
  echo "backup INVÁLIDO: só $tabelas tabelas legíveis; mantido como $TMP para inspeção"
  exit 1
fi
mv "$TMP" "$DIR/$NOME"
echo "backup ok: $NOME ($(du -h "$DIR/$NOME" | cut -f1), $tabelas tabelas com dados)"

find "$DIR" -maxdepth 1 -name 'hiperbold-crm-*.dump' -mtime +"$RETENCAO_DIAS" -delete
echo "retenção: $(find "$DIR" -maxdepth 1 -name 'hiperbold-crm-*.dump' | wc -l) backup(s) guardado(s), até ${RETENCAO_DIAS} dias"
