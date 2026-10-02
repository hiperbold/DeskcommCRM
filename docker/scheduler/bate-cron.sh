#!/bin/sh
# Bate numa rota de cron do app e registra o resultado.
#
# Uso: bate-cron.sh <timeout-em-segundos> <url>
#
# Existe por duas razões, as duas do D-135:
#
# 1. O segredo não aparece na linha de comando. O cabeçalho vem do arquivo 0600
#    que o entrypoint escreve (`curl -H @arquivo`), então `ps` e /proc só veem o
#    caminho do arquivo.
# 2. A resposta deixa de ser jogada fora. Antes o curl ia para /dev/null, e um
#    segredo divergente (401 em todo cron) ou um app fora do ar não deixavam
#    sintoma nenhum, com o healthcheck verde. Aqui o código HTTP de cada rota é
#    gravado em um arquivo por rota (o healthcheck lê) e toda resposta que não for
#    2xx vai para o log do contêiner, uma vez por mudança de código (um 401 por
#    minuto em 40 rotas inundaria o log).
#
# SCHEDULER_AUTH_FILE, SCHEDULER_STATUS_DIR e SCHEDULER_LOG são pontos de injeção
# do teste (tests/shell/scheduler-entrypoint.test.sh); em produção valem os
# padrões abaixo.
set -u

TIMEOUT="${1:-}"
URL="${2:-}"
if [ -z "$TIMEOUT" ] || [ -z "$URL" ]; then
  echo "uso: bate-cron.sh <timeout> <url>" >&2
  exit 2
fi

ARQUIVO_DO_CABECALHO="${SCHEDULER_AUTH_FILE:-/etc/scheduler/auth.header}"
PASTA_DO_ESTADO="${SCHEDULER_STATUS_DIR:-/var/run/scheduler}"
LOG="${SCHEDULER_LOG:-/proc/1/fd/1}"

# O nome da rota sem a query: `.../storage-redaction?limit=50` vira
# `storage-redaction`.
rota="${URL%%\?*}"
rota="${rota##*/}"

mkdir -p "$PASTA_DO_ESTADO"
anterior="$(cat "$PASTA_DO_ESTADO/$rota" 2>/dev/null || true)"

# `-w` imprime o código mesmo quando a conexão falha (000). Sem `-f`: o que
# interessa é o código, e o corpo da resposta não vale a pena guardar.
codigo="$(curl -sS -m "$TIMEOUT" -H "@${ARQUIVO_DO_CABECALHO}" -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null)" || true
[ -n "$codigo" ] || codigo=000

printf '%s' "$codigo" > "$PASTA_DO_ESTADO/$rota"

case "$codigo" in
  2??) ;;
  *)
    if [ "$codigo" != "$anterior" ]; then
      echo "scheduler: ${rota} respondeu HTTP ${codigo}" >> "$LOG" 2>/dev/null || true
    fi
    ;;
esac
exit 0
