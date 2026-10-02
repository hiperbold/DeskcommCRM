#!/bin/sh
# Saúde do scheduler: o crond está de pé E o app aceita o que ele manda.
#
# Só `pgrep crond` (a versão anterior) dava verde com o segredo divergente do
# app: o crond rodava, cada cron respondia 401 e a saída era descartada (D-135).
# Agora o bate-cron.sh grava o código HTTP de cada rota, e aqui se exige que ao
# menos UMA rota tenha respondido 2xx nos últimos 10 minutos.
#
# Sem nenhum registro recente (contêiner recém-subido, a primeira batida ainda
# não aconteceu) não há o que condenar: sai 0, e o `start-period` do HEALTHCHECK
# cobre o resto.
#
# SCHEDULER_STATUS_DIR é ponto de injeção do teste.
PASTA_DO_ESTADO="${SCHEDULER_STATUS_DIR:-/var/run/scheduler}"

pgrep crond >/dev/null || exit 1

recentes="$(find "$PASTA_DO_ESTADO" -type f -mmin -10 2>/dev/null)"
[ -n "$recentes" ] || exit 0

for arquivo in $recentes; do
  case "$(cat "$arquivo" 2>/dev/null)" in
    2??) exit 0 ;;
  esac
done

echo "scheduler: nenhuma rota respondeu 2xx nos últimos 10 minutos (segredo divergente do app ou app fora do ar)" >&2
exit 1
