#!/bin/sh
# Entrypoint do deskcomm-scheduler: escreve o crontab e entrega o PID 1 ao crond.
#
# Por que gerar em runtime em vez de assar o arquivo na imagem: o INTERNAL_SECRET
# só existe no .env do cliente, e o busybox crond não expande variáveis dentro da
# linha do cron. Então a expansão acontece aqui, uma vez, no start.
#
# O que MUDOU em relação ao `command:` inline do compose: não há mais
# `apk add --no-cache curl tzdata` a cada start. curl e tzdata vêm na imagem. O
# cron do cliente deixa de depender de a VPS ter internet e de o mirror do Alpine
# estar de pé no momento de um restart — que é justamente o momento em que a
# máquina está se recuperando de alguma coisa.
set -eu

if [ -z "${INTERNAL_SECRET:-}" ]; then
  echo "scheduler: INTERNAL_SECRET vazio — os crons responderiam 401 em silêncio." >&2
  echo "scheduler: confira a chave no .env e suba de novo." >&2
  exit 1
fi

# Constante, não configuração: `app` é o nome do serviço na rede interna do
# compose, e o scheduler não fala com mais nada. A primeira versão disto lia um
# `SCHEDULER_APP_ORIGIN` que o compose nunca repassava e nenhum template
# documentava — controle decorativo, que é pior que controle nenhum: quem o
# encontrasse no código o definiria no `.env` e não veria efeito.
APP_ORIGIN="http://app:3000"

# O SEGREDO NÃO VAI NA LINHA DO CRON. A versão anterior o escrevia dentro do
# `curl -H 'Authorization: Bearer ...'` de cada linha, e a linha de comando de um
# processo é pública para quem lista processos no contêiner (`ps`, /proc): o
# INTERNAL_SECRET aparecia por alguns segundos a cada minuto, em cada rota
# (D-135). Agora ele vive só num arquivo 0600 com o cabeçalho pronto, que o
# `curl -H @arquivo` lê (via bate-cron.sh). Como é um arquivo e não texto
# reavaliado por `/bin/sh -c`, `$`, crase e aspas no valor passam literais,
# sem a interpolação que antes executava comando (medido com segredo hostil).
#
# Quebra de linha no segredo injetaria cabeçalho: recusa.
QUEBRA_DE_LINHA="
"
RETORNO_DE_CARRO="$(printf '\r')"
case "$INTERNAL_SECRET" in
  *"$QUEBRA_DE_LINHA"* | *"$RETORNO_DE_CARRO"*)
    echo "scheduler: INTERNAL_SECRET contém quebra de linha, recusado." >&2
    exit 1
    ;;
esac

ARQUIVO_DO_CABECALHO="${SCHEDULER_AUTH_FILE:-/etc/scheduler/auth.header}"
BATE="${BATE_CRON_PATH:-/usr/local/bin/bate-cron.sh}"
mkdir -p "$(dirname "$ARQUIVO_DO_CABECALHO")"
( umask 077; printf 'Authorization: Bearer %s\n' "$INTERNAL_SECRET" > "$ARQUIVO_DO_CABECALHO" )
chmod 600 "$ARQUIVO_DO_CABECALHO"

# minuto|timeout|caminho — uma linha por cron. O caminho vai COMPLETO de
# propósito: o literal `api/v1/cron/<rota>` é o contrato que
# tests/unit/cron-routes-scheduled.test.ts (e mais dois) leem por grep — esse
# teste compara a lista com o diretório app/api/v1/cron, e rota criada sem
# agendamento reprova o CI.
# A agenda do Google entra com DUAS cadências, e elas são diferentes de propósito.
#
# RENOVAÇÃO a cada 10 min: o access_token do Google expira em cerca de 1h, e a
# rodada só renova quem está a menos de 15 min do vencimento. Dez minutos deixa
# pelo menos uma tentativa de folga dentro da janela — a 15 min, um tick atrasado
# já deixaria o token vencer. É barata: só toca conexão perto de expirar, e
# rodada vazia não audita.
#
# SYNC a cada 15 min, e NÃO na mesma cadência. Os custos são diferentes: renovar
# é uma requisição por conexão que está vencendo; sincronizar é uma por
# calendário, sempre. Colar as duas obrigaria a escolher entre renovar raro
# demais (e a agenda morre) ou sincronizar caro demais (e gasta cota do cliente).
#
# ⚠️ E o comentário fica AQUI, fora da string: dentro de CRONS= ele não seria
# comentário, seria DADO — e crase em prosa dentro de aspas duplas o shell
# EXECUTA. Foi o que quebrou o entrypoint na primeira tentativa desta linha.
CRONS="
* * * * *|240|api/v1/cron/prospecting
* * * * *|25|api/v1/cron/agent-dispatcher
* * * * *|25|api/v1/cron/followup-flow-worker
* * * * *|45|api/v1/cron/event-log-drain
* * * * *|25|api/v1/cron/routing-worker
* * * * *|25|api/v1/cron/recover-stuck-messages
* * * * *|45|api/v1/cron/webhook-replay
*/5 * * * *|25|api/v1/cron/storage-redaction?limit=50
*/5 * * * *|25|api/v1/cron/snooze-watcher
*/5 * * * *|60|api/v1/cron/handoff-devolucao
# A CAMPANHA. Minuto a minuto, e a rodada manda no máximo uma mensagem por
# número: é o cron que dá a cadência base, e o ritmo da campanha e do canal
# (channel_knobs + pacing_ledger) só sabem torná-la mais lenta.
* * * * *|45|api/v1/cron/campaign-worker
# O PROCESSADOR DE EVENTOS DO ASAAS (F5, Tarefa 13, decisão 20). Minuto a
# minuto porque o evento confirma dinheiro ou contrato: uma cadência mais
# lenta atrasaria a liberação de acesso de quem já pagou. Timeout de 45s
# (igual à campanha, acima): o orçamento interno do processador
# (lib/billing/asaas/processar-eventos.ts) já para perto de 30s mesmo com
# eventos sobrando (o lease de 5 min garante que nada se perde entre
# rodadas). Sem ASAAS_ENABLED a rodada não reserva nada e é barata.
* * * * *|45|api/v1/cron/processar-eventos-asaas
*/5 * * * *|60|api/v1/cron/webhook-log-retention
*/5 * * * *|45|api/v1/cron/channel-health
*/10 * * * *|60|api/v1/cron/contact-avatars
*/10 * * * *|60|api/v1/cron/agenda-google-refresh
*/15 * * * *|90|api/v1/cron/agenda-google-sync
# A IDA. Cadência mais curta que a volta de propósito: quem marcou pela tela
# espera ver o compromisso no celular dele em minutos, e a ida é barata (só
# manda o que mudou). A volta é cara — varre calendário inteiro — e por isso
# roda a cada 15.
*/5 * * * *|60|api/v1/cron/agenda-google-push
# O LEMBRETE. A cada 5 minutos porque a antecedência é escolhida pelo dono no
# tipo de agendamento; uma varredura mais lenta transformaria avisar 30 minutos
# antes em avisar entre 30 e 45 minutos antes. Barato: só olha compromisso
# confirmado, futuro e ainda não avisado.
*/5 * * * *|45|api/v1/cron/agenda-reminder
*/15 * * * *|45|api/v1/cron/agenda-expira-pendentes
*/15 * * * *|60|api/v1/cron/risk-watcher
# O CASO PARADO. De hora em hora, e não a cada 5 minutos: o prazo é de 24h, e
# uma varredura mais frequente só gastaria consulta para descobrir o mesmo nada.
7 * * * *|60|api/v1/cron/case-stale-watcher
*/30 * * * *|60|api/v1/cron/contact-phones
17 * * * *|60|api/v1/cron/contact-proposals-watcher
23 * * * *|60|api/v1/cron/followup-sem-agente
# O ANIVERSÁRIO. De hora em hora, e não uma vez ao dia, porque quem decide o
# momento é o relógio de parede de CADA organização: a rodada só age naquela
# cujo fuso marca a hora de parabenizar. Uma varredura diária em UTC felicitaria
# no dia errado metade do mundo e de madrugada boa parte do resto. Barato: quem
# não configurou a automação não chega a ser varrido.
7 * * * *|60|api/v1/cron/contact-birthdays
# A DATA DO FUNIL (#989). Mesma cadência e mesmo motivo do aniversário: de hora
# em hora, e quem decide o momento é o relógio de parede de CADA organização —
# a rodada só age naquela que marca a hora da varredura. Minuto diferente do
# aniversário para as duas não disputarem a mesma batida num self-host pequeno.
23 * * * *|60|api/v1/cron/lead-date-field-due
# O canal mudo (doc 11, decisão B): varredura de banco, sem rede, com régua em
# DIAS. Diária e de madrugada porque o estado que ela lê muda em dias — de 5 em
# 5 minutos seriam 288 varreduras para nada, e o aviso chegaria na mesma hora.
50 5 * * *|60|api/v1/cron/canal-mudo-watcher
0 12 * * *|60|api/v1/cron/lgpd-sla-watcher
30 3 * * *|120|api/v1/cron/kb-conversations-batch
15 4 * * *|60|api/v1/cron/sync-model-catalog
# A CONCILIAÇÃO DIÁRIA DO ASAAS (F5, Tarefa 16, decisão 21). 04:30 UTC, ANTES
# do conferidor de vencimento (05:40): ela é a rede de segurança para o que o
# webhook (Tarefa 12) e o processador por minuto (Tarefa 13) não pegaram
# sozinhos - pedido preso sem evento aplicado, assinatura removida no Asaas
# sem o webhook ter chegado, cobrança vencida cuja remoção falhou antes.
# Teto de 200 GET ao Asaas por rodada (lib/billing/asaas/conciliar.ts):
# timeout de 120s cobre folga de sobra para essa varredura diária, sem
# disputar a mesma janela de I/O das rodadas de billing que vêm depois (04:55,
# 05:25, 05:40). Sem ASAAS_ENABLED a rodada não toca banco nem rede.
30 4 * * *|120|api/v1/cron/conciliar-asaas
40 4 * * *|120|api/v1/cron/data-retention
55 4 * * *|60|api/v1/cron/conferir-contadores-de-plano
# A CARTEIRA DE TOKENS (F2-B, Tarefa 8). 05:25 UTC (este container roda com
# TZ: UTC, docker-compose.prod.yml), que são 02:25 em América/São_Paulo:
# ainda dentro do MESMO dia civil paulista, só com 2h25 dele decorridas. Por
# isso o teto da instalação (decisão 15) confere o DIA ANTERIOR completo
# nesse fuso, nunca "hoje" (item 12 da revisão, 23/09/2026; ver
# lib/billing/tokens/conferir-carteira.ts). Meia hora depois do conferidor
# de contadores acima, para as duas rodadas diárias de billing não disputarem
# a mesma janela de I/O no banco. Teto de 90s (maior que o irmão, 60s): além
# de conferir o saldo materializado de cada organização (mesma forma do
# irmão), esta rodada também recupera débito pendente em VOLTAS por
# organização (até 20 × 500 chamadas, ver lib/billing/tokens/conferir-
# carteira.ts) antes de conferir a carteira dela, uma rodada normal fica bem
# abaixo disso (o gatilho já debita quase tudo em tempo real), mas o teto
# folgado evita o curl -m cortar uma rodada que, por algum motivo raro,
# tenha muito para recuperar.
25 5 * * *|90|api/v1/cron/conferir-carteira-de-tokens
# O VENCIMENTO DA ASSINATURA (F4, Tarefa 5). 05:40 UTC (este container roda
# com TZ: UTC, docker-compose.prod.yml), que são 02:40 em América/São_Paulo:
# ainda dentro do MESMO dia civil paulista, mesmo fuso fixo (Brasil não tem
# mais horário de verão) dos dois conferidores de billing acima. 15 minutos
# depois de conferir-carteira-de-tokens (05:25, até 90s de execução): folga
# de sobra para as três rodadas diárias de billing não disputarem a mesma
# janela de I/O no banco. Só uma RPC por organização (fn_billing_conferir_
# vencimento, ver lib/billing/assinatura/conferir-vencimentos.ts), sem passo
# extra tipo o débito pendente da carteira: teto de 60s, igual ao irmão mais
# simples (conferir-contadores-de-plano).
40 5 * * *|60|api/v1/cron/conferir-vencimentos
# A RETENÇÃO DE MÍDIA (upstream). 05:20 UTC, janela própria, antes das rodadas
# diárias de billing acima (05:25 e 05:40), para não disputar I/O com elas.
20 5 * * *|120|api/v1/cron/media-retention
# AS RECORRÊNCIAS. Uma vez ao dia é o bastante: o que ela gera é uma conta a
# pagar, e a diferença entre nascer às 5h ou às 17h não muda nada para quem paga.
# Barato: uma consulta por instalação, e quem não tem molde nenhum sai na hora.
50 5 * * *|60|api/v1/cron/recurring-entries
"

# CRONTAB_PATH é ponto de injeção do teste (tests/shell/scheduler-entrypoint.test.sh).
# Sem ele este script só seria exercitável dentro de um contêiner — e o único
# artefato executável novo desta entrega ficaria sem gate nenhum, que foi
# exatamente o achado da revisão adversarial.
DESTINO="${CRONTAB_PATH:-/etc/crontabs/root}"

umask 077
: > "$DESTINO"
echo "$CRONS" | while IFS='|' read -r quando timeout rota; do
  [ -n "$rota" ] || continue
  # O resultado de cada batida (código HTTP) é gravado e as falhas vão para o log
  # do contêiner: antes a saída ia para /dev/null e um segredo divergente dava 401
  # em todos os crons sem nenhum sintoma. Ver docker/scheduler/bate-cron.sh e o
  # healthcheck.
  printf '%s %s %s "%s/%s"\n' \
    "$quando" "$BATE" "$timeout" "$APP_ORIGIN" "$rota" >> "$DESTINO"
done

exec crond -f -l 2
