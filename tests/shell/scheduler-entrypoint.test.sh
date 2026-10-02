#!/usr/bin/env bash
# Gate do docker/scheduler/entrypoint.sh (e do bate-cron.sh e healthcheck.sh que
# ele instala): o único artefato executável novo da doutrina de packaging, e o
# que ficou sem cobertura na primeira versão dela.
#
# O que ele guarda, e por que cada coisa:
#
# 1. O SEGREDO SOBREVIVE INTEIRO E LITERAL, E NÃO FICA NA LINHA DE COMANDO. O
#    crond executa cada linha do crontab por `/bin/sh -c`, então texto no
#    crontab é REAVALIADO na hora de disparar. A versão original interpolava o
#    INTERNAL_SECRET dentro de aspas duplas (crase virava substituição de
#    comando: execução arbitrária a cada minuto), e a seguinte o deixava na linha
#    do `curl`, visível em `ps` e /proc a cada minuto (D-135). Agora o segredo
#    vive só num arquivo 0600 lido por `curl -H @arquivo`: o teste confere que o
#    crontab NÃO o contém, que o arquivo tem o valor byte a byte, e que o
#    cabeçalho chega ao curl igual quando a linha do cron é executada de verdade.
#
# 2. NENHUMA ROTA SE PERDE. O crontab saiu do `command:` inline do compose e veio
#    para cá; a contagem tem de bater com app/api/v1/cron. (A cerca principal é
#    tests/unit/cron-routes-scheduled.test.ts; esta aqui pega o caso em que o
#    arquivo GERADO diverge da lista escrita, que aquele teste não vê.)
#
# 3. FALHA FECHADA SEM SEGREDO. Sem INTERNAL_SECRET os crons responderiam 401 e
#    nada aconteceria — sem erro, sem log, sem sintoma. O script recusa subir.
#    Segredo com quebra de linha também é recusado (injetaria cabeçalho).
#
# 4. A FALHA TEM SINTOMA. Segredo divergente do app dava 401 em todo cron com a
#    saída descartada e o healthcheck verde. O bate-cron.sh grava o código HTTP
#    por rota e loga o que não for 2xx; o healthcheck reprova quando nenhuma
#    rota respondeu 2xx nos últimos 10 minutos.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENTRYPOINT="docker/scheduler/entrypoint.sh"
BATE="$PWD/docker/scheduler/bate-cron.sh"
SAUDE="$PWD/docker/scheduler/healthcheck.sh"
fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() {
  local nome="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$nome"
  else printf '  ✗ %s\n' "$nome"; fail=1; fi
}

# `crond` dublado: o entrypoint termina em `exec crond`, que não existe no macOS
# nem no runner. Sem o dublê o script morreria DEPOIS de escrever o crontab — o
# arquivo estaria certo e o teste falharia por motivo errado.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/crond"
chmod +x "$TMP/bin/crond"

rodar() { # $1 = valor de INTERNAL_SECRET ("" = ausente)
  local out="$TMP/crontab"
  : > "$out"
  rm -f "$TMP/auth.header"
  if [ -z "$1" ]; then
    env -u INTERNAL_SECRET PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      SCHEDULER_AUTH_FILE="$TMP/auth.header" BATE_CRON_PATH="$BATE" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  else
    env INTERNAL_SECRET="$1" PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      SCHEDULER_AUTH_FILE="$TMP/auth.header" BATE_CRON_PATH="$BATE" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  fi
  echo $?
}

echo "scheduler: o crontab é gerado com todas as rotas"
RC="$(rodar 'segredo-simples')"
check "o entrypoint termina com sucesso" test "$RC" -eq 0
ROTAS_CODIGO="$(find app/api/v1/cron -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
ROTAS_CRONTAB="$(grep -oE 'api/v1/cron/[a-z0-9-]+' "$TMP/crontab" | sort -u | wc -l | tr -d ' ')"
check "as $ROTAS_CODIGO rotas do código estão no crontab (achei $ROTAS_CRONTAB)" \
  test "$ROTAS_CODIGO" -eq "$ROTAS_CRONTAB"
check "uma linha por cron, nenhuma vazia" \
  test "$(grep -c . "$TMP/crontab")" -eq "$(wc -l < "$TMP/crontab" | tr -d ' ')"

echo "scheduler: o segredo atravessa o sh do crond intacto e fora da linha de comando"
# Os três caracteres que quebram interpolação ingênua, de uma vez só.
HOSTIL='seg`whoami`redo$HOME-com'\''aspa-e-"aspas"'
RC="$(rodar "$HOSTIL")"
check "gerou o crontab mesmo com segredo cheio de metacaractere" test "$RC" -eq 0

check "o crontab NÃO contém o segredo, nem o cabeçalho Authorization" \
  bash -c '! grep -qE "Bearer|whoami|aspa-e" "$1"' _ "$TMP/crontab"
check "o arquivo do cabeçalho existe com modo 600" \
  test "$(stat -c %a "$TMP/auth.header" 2>/dev/null || stat -f %Lp "$TMP/auth.header")" = 600
ESPERADO="Authorization: Bearer ${HOSTIL}"
if [ "$(cat "$TMP/auth.header")" = "$ESPERADO" ]; then
  printf '  ✓ o arquivo guarda o cabeçalho byte a byte igual ao segredo do .env\n'
else
  printf '  ✗ o segredo foi corrompido ao ser gravado no arquivo\n'
  printf '     esperado: %s\n' "$ESPERADO"
  printf '     gravado:  %s\n' "$(cat "$TMP/auth.header")"
  fail=1
fi

# A medição que importa: pegar a PRIMEIRA linha, tirar o prefixo de agendamento,
# e mandar um `sh` de verdade avaliá-la — exatamente o que o crond faz. O `curl`
# é dublado por um script que imprime o conteúdo do arquivo passado em `-H @...`,
# que é o que o curl real mandaria como cabeçalho, e responde 200.
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "-H" ]; then
    case "$2" in @*) cat "${2#@}" > "$STUB_CABECALHO" ;; esac
  fi
  shift
done
printf '%s' "${STUB_CODIGO:-200}"
STUB
chmod +x "$TMP/bin/curl"
LINHA="$(head -1 "$TMP/crontab")"
COMANDO="${LINHA#* * * * * }"                 # tira o agendamento de 5 campos
RECEBIDO_EM="$TMP/cabecalho-recebido"
env PATH="$TMP/bin:$PATH" STUB_CABECALHO="$RECEBIDO_EM" \
  SCHEDULER_AUTH_FILE="$TMP/auth.header" SCHEDULER_STATUS_DIR="$TMP/estado" \
  SCHEDULER_LOG="$TMP/log-do-conteiner" sh -c "$COMANDO"
if [ "$(cat "$RECEBIDO_EM" 2>/dev/null)" = "$ESPERADO" ]; then
  printf '  ✓ a linha do cron, executada por sh -c, entrega o cabeçalho ao curl byte a byte\n'
else
  printf '  ✗ o segredo foi corrompido pelo caminho da linha do cron até o curl\n'
  printf '     esperado: %s\n' "$ESPERADO"
  printf '     recebido: %s\n' "$(cat "$RECEBIDO_EM" 2>/dev/null)"
  fail=1
fi
# Controle negativo do próprio instrumento: se a crase tivesse sido executada, o
# arquivo conteria a saída de `whoami` no lugar dela, não o texto literal.
check "a crase NÃO foi executada (está literal no arquivo)" \
  grep -q 'whoami' "$TMP/auth.header"

echo "scheduler: quebra de linha no segredo é recusada"
RC="$(rodar $'abc\nX-Injetado: 1')"
check "sai com código 1" test "$RC" -eq 1
check "explica o motivo" grep -q "quebra de linha" "$TMP/saida"
check "não deixou o arquivo do cabeçalho" test ! -e "$TMP/auth.header"

echo "scheduler: sem INTERNAL_SECRET, recusa em vez de subir mudo"
RC="$(rodar '')"
check "sai com código 1" test "$RC" -eq 1
check "explica o motivo na saída" grep -q "INTERNAL_SECRET" "$TMP/saida"
check "não deixou crontab pela metade" test ! -s "$TMP/crontab"

echo "scheduler: a resposta de cada rota é registrada, e a falha aparece no log"
rm -rf "$TMP/estado" "$TMP/log-do-conteiner"
bate() { # $1 = código que o curl dublê devolve, $2 = URL
  env PATH="$TMP/bin:$PATH" STUB_CABECALHO="$TMP/ignorado" STUB_CODIGO="$1" \
    SCHEDULER_AUTH_FILE="$TMP/auth.header" SCHEDULER_STATUS_DIR="$TMP/estado" \
    SCHEDULER_LOG="$TMP/log-do-conteiner" sh "$BATE" 25 "$2"
}
rodar 'segredo-simples' >/dev/null
bate 401 'http://app:3000/api/v1/cron/prospecting'
check "grava o código da rota (401)" test "$(cat "$TMP/estado/prospecting")" = 401
check "o 401 foi para o log do contêiner" grep -q 'prospecting respondeu HTTP 401' "$TMP/log-do-conteiner"
bate 401 'http://app:3000/api/v1/cron/prospecting'
check "o mesmo 401 de novo não repete a linha no log" \
  test "$(grep -c 'prospecting respondeu' "$TMP/log-do-conteiner")" -eq 1
bate 200 'http://app:3000/api/v1/cron/storage-redaction?limit=50'
check "a query sai do nome da rota" test "$(cat "$TMP/estado/storage-redaction")" = 200
check "2xx não escreve no log" bash -c '! grep -q storage-redaction "$1"' _ "$TMP/log-do-conteiner"

echo "scheduler: o healthcheck reprova quando nenhuma rota responde 2xx"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/pgrep"
chmod +x "$TMP/bin/pgrep"
saude() { env PATH="$TMP/bin:$PATH" SCHEDULER_STATUS_DIR="$1" sh "$SAUDE" >/dev/null 2>&1; echo $?; }
mkdir -p "$TMP/vazio"
check "sem registro nenhum (recém-subido): saudável" test "$(saude "$TMP/vazio")" = 0
mkdir -p "$TMP/so401"; printf 401 > "$TMP/so401/a"; printf 000 > "$TMP/so401/b"
check "só 401 e 000: NÃO saudável" test "$(saude "$TMP/so401")" = 1
mkdir -p "$TMP/misto"; printf 401 > "$TMP/misto/a"; printf 200 > "$TMP/misto/b"
check "uma rota com 2xx basta: saudável" test "$(saude "$TMP/misto")" = 0
mkdir -p "$TMP/velho"; printf 401 > "$TMP/velho/a"; touch -d '30 minutes ago' "$TMP/velho/a"
check "registro com mais de 10 min não condena sozinho: saudável" test "$(saude "$TMP/velho")" = 0
printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/pgrep"
check "crond morto: NÃO saudável, mesmo com 2xx" test "$(saude "$TMP/misto")" = 1

if [ "$fail" -eq 0 ]; then
  echo "OK — todas as provas passaram."
else
  echo "FALHOU."
fi
exit "$fail"
