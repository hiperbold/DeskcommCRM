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

# D-123: o dump leva hash de senha, dado pessoal e (no schema `private`) a chave de
# cifra dos tokens. Pasta só do dono, e arquivos 0600.
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date +%Y-%m-%d_%H%M)"
NOME="hiperbold-crm-$STAMP.dump"
NOME_PRIVATE="hiperbold-crm-$STAMP-private.dump"
TMP="$DIR/.$NOME.parcial"
TMP_PRIVATE="$DIR/.$NOME_PRIVATE.parcial"

# A URL do banco (com a senha) vai por VARIÁVEL DE AMBIENTE: `-e NOME` sem valor
# repassa a do host, e a senha não aparece na linha de comando do `docker run`
# (visível em `ps`). Antes ia como argumento do `pg_dump`.
export SUPABASE_DB_URL="$URL"

# `private` (a chave de cifra) sai em ARQUIVO SEPARADO do dado cifrado
# (`public`, `auth`): quem só tem o primeiro não decifra tokens de WhatsApp, chaves
# de IA e OAuth. Guarde o segundo com outra proteção (de preferência fora desta
# máquina). O restore precisa dos dois.
docker run --rm -e SUPABASE_DB_URL -v "$DIR:/out" postgres:17-alpine \
  sh -c 'pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
    --schema=public --schema=auth --file="/out/$0"' ".$NOME.parcial"
docker run --rm -e SUPABASE_DB_URL -v "$DIR:/out" postgres:17-alpine \
  sh -c 'pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
    --schema=private --file="/out/$0"' ".$NOME_PRIVATE.parcial"
chmod 600 "$TMP" "$TMP_PRIVATE" 2>/dev/null || true

# Só vira backup o que o pg_restore consegue LER: arquivo truncado por queda de
# rede no meio do dump não pode ocupar o lugar de um bom.
tabelas="$(docker run --rm -v "$DIR:/out" postgres:17-alpine pg_restore --list "/out/.$NOME.parcial" | grep -c 'TABLE DATA' || true)"
if [ "${tabelas:-0}" -lt 50 ]; then
  echo "backup INVÁLIDO: só $tabelas tabelas legíveis; mantido como $TMP para inspeção"
  exit 1
fi
mv "$TMP" "$DIR/$NOME"
mv "$TMP_PRIVATE" "$DIR/$NOME_PRIVATE"
echo "backup ok: $NOME ($(du -h "$DIR/$NOME" | cut -f1), $tabelas tabelas com dados) e $NOME_PRIVATE (chave de cifra, guardar à parte)"

# Cifragem com `age` e chave PÚBLICA: o que fica no disco não se lê sem a chave
# privada, que NÃO fica nesta máquina. Liga quando AGE_RECIPIENT (a chave pública,
# `age1...`) está no ambiente ou em hiperbold/backup-age-recipient.txt. Sem ela os
# arquivos ficam em claro (só 0600 numa pasta 0700) e o script AVISA em voz alta:
# gerar o par de chaves e guardar a privada é decisão do Filipe (D-123).
RECIPIENT="${AGE_RECIPIENT:-}"
[ -n "$RECIPIENT" ] || { [ -r hiperbold/backup-age-recipient.txt ] && RECIPIENT="$(head -1 hiperbold/backup-age-recipient.txt | tr -d '\r')"; }
if [ -n "$RECIPIENT" ] && command -v age >/dev/null 2>&1; then
  for arq in "$NOME" "$NOME_PRIVATE"; do
    age -r "$RECIPIENT" -o "$DIR/$arq.age" "$DIR/$arq"
    chmod 600 "$DIR/$arq.age"
    rm -f "$DIR/$arq"
  done
  echo "cifrados com age: $NOME.age e $NOME_PRIVATE.age (os arquivos em claro foram removidos)"
else
  echo "AVISO: backup SEM cifra. Defina AGE_RECIPIENT (chave pública age) e instale o age para cifrar (D-123)." >&2
fi

find "$DIR" -maxdepth 1 -name 'hiperbold-crm-*.dump*' -mtime +"$RETENCAO_DIAS" -delete
echo "retenção: $(find "$DIR" -maxdepth 1 -name 'hiperbold-crm-*.dump*' | wc -l) arquivo(s) guardado(s), até ${RETENCAO_DIAS} dias"
