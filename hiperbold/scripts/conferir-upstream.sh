#!/usr/bin/env bash
# Antes de puxar atualização do autor: quanto ele andou, quais arquivos DELE a
# Hiperbold alterou, e onde o merge daria conflito. Não mexe na árvore de
# trabalho: o merge é ensaiado numa worktree temporária e descartado.
#
# Uso: bash hiperbold/scripts/conferir-upstream.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

git fetch upstream -q
base="$(git merge-base HEAD upstream/main)"
echo "== autor à frente: $(git rev-list --count HEAD..upstream/main) commit(s)"

echo
echo "== arquivos do AUTOR alterados pela Hiperbold (conferir no merge)"
# `M` = já existia no autor e foi mudado aqui. Arquivo novo (`A`) não conflita.
git diff --name-status "$base" HEAD -- . ':(exclude)hiperbold' | awk '$1=="M"{print "  " $2}'

if [ "$(git rev-list --count HEAD..upstream/main)" = 0 ]; then
  echo
  echo "== nada para ensaiar: o fork já contém o autor"
  exit 0
fi

echo
echo "== ensaio do merge"
wt="$(mktemp -d /tmp/deskcomm-ensaio-XXXX)"
trap 'git worktree remove --force "$wt" >/dev/null 2>&1 || true; rm -rf "$wt"' EXIT
git worktree add --detach -q "$wt" HEAD
if git -C "$wt" merge --no-commit --no-ff -q upstream/main >/dev/null 2>&1; then
  echo "  sem conflito"
else
  echo "  CONFLITO em:"
  git -C "$wt" diff --name-only --diff-filter=U | sed 's/^/    /'
fi
git -C "$wt" merge --abort >/dev/null 2>&1 || true
