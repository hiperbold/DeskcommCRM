#!/usr/bin/env bash
# Confere, pela API do GitHub, que os workflows de teste do MESMO commit
# terminaram em sucesso. Usado pelo deploy-easypanel.yml antes de pedir ao
# EasyPanel que baixe as imagens: o publish-image.yml roda em paralelo com o ci
# e o e2e, então imagem publicada não prova que o commit passou nos testes.
#
# Uso: GITHUB_REPOSITORY=dono/repo bash scripts/commit-passou-nos-testes.sh <sha>
# Precisa de `gh` autenticado (GH_TOKEN) e de `jq`.
#
# Regras, todas do lado seguro:
#   - sem execução do workflow para o commit: espera (o push dispara, mas a fila
#     pode atrasar o início) e, estourado o teto, REPROVA;
#   - execução em andamento: espera até o teto;
#   - execução concluída com qualquer coisa diferente de `success` (failure,
#     cancelled, timed_out, skipped): REPROVA na hora;
#   - falha ao consultar a API: conta como "ainda não sei" e espera, nunca como
#     sucesso.
# Só vale a execução mais recente de cada workflow na branch main: um "rerun"
# verde substitui o vermelho anterior do mesmo commit, como o GitHub mostra.
#
# Variáveis (para teste): WORKFLOWS_EXIGIDOS (padrão "ci.yml e2e.yml"),
# TETO_SEGUNDOS (padrão 3300), INTERVALO_SEGUNDOS (padrão 30).
set -uo pipefail

sha="${1:-}"
repo="${GITHUB_REPOSITORY:-}"
if [ -z "$sha" ] || [ -z "$repo" ]; then
  echo "uso: GITHUB_REPOSITORY=dono/repo $0 <sha>" >&2
  exit 2
fi
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "sha inválido: ${sha}" >&2
  exit 2
fi

workflows="${WORKFLOWS_EXIGIDOS:-ci.yml e2e.yml}"
teto="${TETO_SEGUNDOS:-3300}"
intervalo="${INTERVALO_SEGUNDOS:-30}"
limite=$(( $(date +%s) + teto ))

# A execução mais recente do workflow, na main, para este commit, em push.
# Devolve "status<TAB>conclusion", ou "<TAB>" quando não há execução.
filtro='[.workflow_runs[] | select(.head_branch == "main" and .event == "push")]
        | sort_by(.run_number) | last
        | [(.status // ""), (.conclusion // "")] | @tsv'

for wf in $workflows; do
  while :; do
    if resposta=$(gh api "repos/${repo}/actions/workflows/${wf}/runs?head_sha=${sha}&event=push&per_page=30" --jq "$filtro" 2>/dev/null); then
      status="${resposta%%$'\t'*}"
      conclusao="${resposta#*$'\t'}"
    else
      status=""
      conclusao=""
    fi

    if [ "$status" = "completed" ]; then
      if [ "$conclusao" = "success" ]; then
        echo "ok: ${wf} terminou em sucesso para ${sha}"
        break
      fi
      echo "::error::${wf} terminou em '${conclusao}' para o commit ${sha}: não publico código que não passou nos testes."
      exit 1
    fi

    if [ "$(date +%s)" -ge "$limite" ]; then
      echo "::error::${wf} não terminou em sucesso dentro do teto (${teto}s) para o commit ${sha} (estado: ${status:-sem execucao})."
      exit 1
    fi
    echo "esperando ${wf} (estado: ${status:-sem execucao})..."
    sleep "$intervalo"
  done
done

echo "ci e e2e verdes para ${sha}"
