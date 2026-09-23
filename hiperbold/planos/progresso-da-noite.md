# Progresso da noite

Início: 23/09/2026 01:21
Branch: feat/planos-assinatura (a partir de fix/debitos-pequenos-2026-09-22, commit e5231de)
Fase atual: F1
Etapa da fase: revisar-plano (plano em hiperbold/planos/fase-F1-tarefas.md, com o revisor)

## Fases

| Fase | Estado | Commit | Data |
|---|---|---|---|
| F1 | em andamento | | |
| F2 | pendente | | |
| F2-B | pendente | | |
| F3 | pendente | | |

## Tarefas da fase atual

| # | Tarefa | Estado |
|---|---|---|
| 1 | Tabelas na migração 0904 e no baseline | pendente |
| 2 | Provas de banco (RLS, gatilho, semeadura) | pendente |
| 3 | Módulo de leitura de plano | pendente |
| 4 | Ações do admin da plataforma | pendente |
| 5 | Aba "Plano" no painel do admin da plataforma | pendente |

## Decisões tomadas sozinho

- **tests/invariants**: a regra do loop proíbe editar invariante existente. Interpretei como "não enfraquecer": arquivo NOVO de invariante é permitido, e acrescentar tabela à lista `TABLES` de `rls-isolation.test.ts` também, porque é exigência do checklist de contribuição do próprio projeto (`.claude/skills/deskcomm-contribuir/references/pre-voo.md`) e só aumenta a cobertura. Onde mudar: a tarefa 2 da F1.
- **Nomes de tabela**: `billing_plans` e `billing_contracts` do manual comum Asaas; `billing_plan_adjustments` para o ajuste, que o manual não tem. Onde mudar: migração 0904.
- **Tetos em jsonb de chaves fechadas**, `null` = sem limite. Motivo: teto novo vira cadastro, não migração. Onde mudar: `fn_billing_limites_validos` e `lib/billing/planos/limites.ts`.
- **Uma linha de contrato por organização**; histórico de troca na auditoria. Onde mudar: `unique (organization_id)` em `billing_contracts`.
- **Organização nova ganha contrato por gatilho no banco**, porque há cinco caminhos de criação, dois em SQL. Onde mudar: `fn_billing_contrato_da_organizacao_nova`.
- **Plano fora de venda pode ser atribuído pelo admin da plataforma**; "à venda" só governa a compra pelo próprio cliente (F5).
- **Semeadura não sobrescreve preço**: `on conflict do nothing`, porque o baseline roda de novo a cada atualização de produção.

## Perguntas para o Filipe

- **Preço anual (N8)**: nulo no catálogo até ele responder. Onde muda: `price_yearly_cents` em `billing_plans`.

## Achados de segurança

## Bloqueios

## Portões

(nenhum rodado ainda nesta branch; referência da branch de origem: typecheck limpo, lint 0 erros, unitários 13.195 verdes com 1 vermelho de ambiente, test:db 2193 verdes)
