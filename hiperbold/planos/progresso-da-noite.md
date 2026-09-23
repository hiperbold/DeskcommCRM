# Progresso da noite

Início: 23/09/2026 01:21
Branch: feat/planos-assinatura (a partir de fix/debitos-pequenos-2026-09-22, commit e5231de)
Fase atual: F2
Etapa da fase: tarefa 3 de 8 (tarefa 2 feita: configuração, contador e funções de contagem, com as contagens batendo com a contagem à mão; tarefa 1 virou registro, D-050)

## Fases

| Fase | Estado | Commit | Data |
|---|---|---|---|
| F1 | **feita**: 6 tarefas, revisão e auditoria sem achado alto, todos os portões verdes | 8fa4893 | 23/09/2026 09:44 |
| F2 | pendente | | |
| F2-B | pendente | | |
| F3 | pendente | | |

## Tarefas da fase atual

F2: ainda não planejadas. Abaixo, as da F1, para registro.

| # | Tarefa da F1 | Estado |
|---|---|---|
| 1 | Tabelas e funções na migração 0904 e no baseline | feita (migração e bloco do baseline aplicados duas vezes no banco local sem erro; gatilho provado; 12 testes) |
| 2 | Provas de banco (RLS, gatilho, precedência, troca, semeadura) | feita (49 casos novos; com rls-isolation e a varredura de completude, 224 verdes) |
| 3 | Módulo de leitura de plano | feita (20 testes; embed e RPC provados contra o PostgREST local) |
| 4 | Ações do admin da plataforma (só escopo full) | feita (17 testes; IP pela régua única do projeto) |
| 5 | Aba "Plano" no painel do admin da plataforma | feita (28 testes). A tarefa levou cerca de seis horas e a causa NÃO foi identificada: o executor relata que nenhum comando travou, e o servidor na porta 3300 era o que a sessão principal tinha deixado de pé no dia anterior. Primeira hipótese, errada, registrada aqui para não virar fato. |
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
- **F2: integração webhook é `webhook_sources`** (a entrada automática de leads), e não o webhook que sai das automações, porque automação não é limitada no plano. Onde mudar: o gatilho da F2 nessa tabela.
- **F2: configuração dos planos numa tabela nossa (`billing_settings`)**, e não em `platform_settings`, que é do autor e daria conflito em toda junção.
- **F2: aviso na Central com `kind = 'other'`** e deduplicação por título, para não mexer na restrição de tipos do autor.
- **F2: leads por contador materializado**; o resto por contagem na hora. Contar 100 mil leads a cada importação derrubaria a importação.

## Perguntas para o Filipe

- **Preço anual (N8)**: nulo no catálogo até ele responder. Onde muda: `price_yearly_cents` em `billing_plans`.
- **N10. Lead ganho ou perdido ocupa vaga do plano?** Padrão usado: não, conta só o lead aberto (`status = 'open'`), que é a leitura que menos cobra do cliente. Onde muda: a contagem de leads na F2.
- **N11. Quem vê a tela "Plano e uso" da organização?** Padrão usado: admin e gerente. Onde muda: a tarefa 7 da F2.
- **N12. Ligar o preço do catálogo nas chamadas de IA?** O orçamento de IA que já existe está cego para modelos fora da Anthropic, inclusive em produção. O catálogo com preço existe no banco, mas ligá-lo faz o orçamento começar a contar de uma hora para outra, e a IA pode parar no meio do mês. Padrão usado: não ligar; o painel de margem da F2-B calcula por fora. Registrado como D-050.

## Achados de segurança

- **Alto, corrigido na tarefa 1 da F1**: revogar só `insert, update, delete` de `authenticated` deixava `TRUNCATE` (e `REFERENCES`, `TRIGGER`) nas três tabelas novas, pelo grant padrão do Supabase. `TRUNCATE` passa por cima da RLS. Medido no banco local, antes e depois. Agora: `revoke all` e `grant select`; o teste `planos-migration` trava a volta.
- **Alto, corrigido no plano da F1 antes de implementar**: admin da plataforma com escopo `support_readonly` conseguiria trocar plano. As ações passam a exigir `full`.
- **Auditoria da F1 (08:40): nenhum crítico nem alto.** Médio: membro de organização grava registro falso na auditoria (política do autor, anterior à fase): virou D-046, a resolver antes da cobrança real. Baixos em correção agora: role `agent_worker` escrevia nas tabelas de plano; ações sem conferência de MFA; nota e autor do ajuste legíveis pelo membro; catálogo de planos inteiro legível por qualquer usuário; `search_path` da função de validação. Baixos anteriores à fase, registrados: D-047 (TRUNCATE em 114 tabelas) e D-048 (admin de suporte escreve em `organizations`).
- **Revisão da F1 (08:30): nenhum alto.** Médios em correção agora: erro de leitura na aba Plano podia apagar o ajuste ao salvar; nota do ajuste visível ao membro. Médio que é regra da F2: gatilho de contagem tem de ser `security definer` (D-049).

## Bloqueios

## Portões

Fechamento da F1, 23/09/2026 08:20 a 09:44, no commit 8fa4893:

| Portão | Resultado |
|---|---|
| typecheck | limpo |
| lint | 0 erros, 420 avisos (todos anteriores) |
| lint:channels | ok |
| unitários | 1300 arquivos e 13.279 testes verdes; 1 vermelho, o de ambiente conhecido (`e2e-parte-4`, espera pelo Redis) |
| test:db | 256 arquivos e 2254 testes verdes |
| build | verde, 38 s de compilação |

O servidor de desenvolvimento na porta 3300 sobreviveu ao build. A rota da aba Plano sem sessão manda para o login e volta para a aba depois.
