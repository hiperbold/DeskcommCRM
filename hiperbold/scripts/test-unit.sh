#!/usr/bin/env bash
# `pnpm test:unit` no WSL, nas condições do CI. Rodar direto dá falsos vermelhos
# que NÃO são defeito de código, medidos em 16/09/2026 (D-026):
#
# 1. Redis de verdade. O setup dos testes carrega o `.env.local`, que aponta para
#    o Redis do compose de dev. `rate-limit` e `recoverOrganization` esperam o
#    contador em memória (é o que o CI tem, sem Redis) e passam a contar janelas
#    reais que sobrevivem entre execuções: `rate_limited` onde se espera sucesso.
#    Valor em branco (e não vazio: o setup preenche variável vazia) faz a
#    validação do Redis recusar e cair na memória.
#
# 2. Porta fechada demora 10 s. Com `networkingMode=mirrored` no .wslconfig, um
#    `fetch` do Node para uma porta sem ninguém em 127.0.0.1 só desiste depois de
#    10 s (no CI, recusa na hora). `inbox-unread-send` chama um WAHA inexistente
#    duas vezes e estoura os 15 s do teste. O teto maior só vale aqui.
set -euo pipefail
cd "$(dirname "$0")/../.."
UPSTASH_REDIS_REST_URL=" " UPSTASH_REDIS_REST_TOKEN=" " exec pnpm test:unit --testTimeout=60000 "$@"
