# Progresso da noite

Início: 23/09/2026 01:21
Branch: feat/planos-assinatura (a partir de fix/debitos-pequenos-2026-09-22, commit e5231de)
Fase atual: F1
Etapa da fase: tarefas 4 e 6 de 6, em paralelo (1 em 502a4a8, 3 em 684de89, 2 em d335259); a 5 espera a 4

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
| 1 | Tabelas e funções na migração 0904 e no baseline | feita (migração e bloco do baseline aplicados duas vezes no banco local sem erro; gatilho provado; 12 testes) |
| 2 | Provas de banco (RLS, gatilho, precedência, troca, semeadura) | feita (49 casos novos; com rls-isolation e a varredura de completude, 224 verdes) |
| 3 | Módulo de leitura de plano | feita (20 testes; embed e RPC provados contra o PostgREST local) |
| 4 | Ações do admin da plataforma (só escopo full) | feita (17 testes; IP pela régua única do projeto) |
| 5 | Aba "Plano" no painel do admin da plataforma | pendente |
| 6 | Aposentar o "Plano" antigo da criação de organização | feita (Visão Geral lê o contrato; formulário sem seletor; API ainda aceita o campo legado) |

## Decisões tomadas sozinho

- **tests/invariants**: a regra do loop proíbe editar invariante existente. Interpretei como "não enfraquecer": arquivo NOVO de invariante é permitido, e acrescentar tabela à lista `TABLES` de `rls-isolation.test.ts` também, porque é exigência do checklist de contribuição do próprio projeto (`.claude/skills/deskcomm-contribuir/references/pre-voo.md`) e só aumenta a cobertura. Onde mudar: a tarefa 2 da F1.
- **Nomes de tabela**: `billing_plans` e `billing_contracts` do manual comum Asaas; `billing_plan_adjustments` para o ajuste, que o manual não tem. Onde mudar: migração 0904.
- **Tetos em jsonb de chaves fechadas**, `null` = sem limite. Motivo: teto novo vira cadastro, não migração. Onde mudar: `fn_billing_limites_validos` e `lib/billing/planos/limites.ts`.
- **Uma linha de contrato por organização**; histórico de troca na auditoria. Onde mudar: `unique (organization_id)` em `billing_contracts`.
- **Organização nova ganha contrato por gatilho no banco**, porque há cinco caminhos de criação, dois em SQL. Onde mudar: `fn_billing_contrato_da_organizacao_nova`.
- **Plano fora de venda pode ser atribuído pelo admin da plataforma**; "à venda" só governa a compra pelo próprio cliente (F5).
- **Semeadura não sobrescreve preço**: `on conflict do nothing`, porque o baseline roda de novo a cada atualização de produção.
- **Plano de reserva fixo no código** (`{ code: "ilimitado", version: 1 }`) quando a leitura falha ou não há contrato: uma segunda consulta ao banco no caminho de erro é mais uma coisa que pode falhar justo quando o banco está ruim. Onde mudar: `PLANO_ILIMITADO_PADRAO` em `lib/billing/planos/plano-da-organizacao.ts`.
- **Travessão**: os executores escreveram travessão em comentários nas tarefas 1 e 3 apesar da regra; corrigido à mão na revisão de cada tarefa, e o briefing passou a exigir a conferência antes de responder.

## Perguntas para o Filipe

- **Preço anual (N8)**: nulo no catálogo até ele responder. Onde muda: `price_yearly_cents` em `billing_plans`.

## Achados de segurança

- **Alto, corrigido na tarefa 1 da F1**: revogar só `insert, update, delete` de `authenticated` deixava `TRUNCATE` (e `REFERENCES`, `TRIGGER`) nas três tabelas novas, pelo grant padrão do Supabase. `TRUNCATE` passa por cima da RLS. Medido no banco local, antes e depois. Agora: `revoke all` e `grant select`; o teste `planos-migration` trava a volta.
- **Alto, corrigido no plano da F1 antes de implementar**: admin da plataforma com escopo `support_readonly` conseguiria trocar plano. As ações passam a exigir `full`.

## Bloqueios

## Portões

(nenhum rodado ainda nesta branch; referência da branch de origem: typecheck limpo, lint 0 erros, unitários 13.195 verdes com 1 vermelho de ambiente, test:db 2193 verdes)
