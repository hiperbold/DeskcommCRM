# Progresso da noite

Início: 23/09/2026 01:21
Branch: feat/planos-assinatura (a partir de fix/debitos-pequenos-2026-09-22, commit e5231de)
Fase atual: F2
Etapa da fase: F2 em portões completos (cópia separada `~/projects/deskcommcrm-portoes`, commit 28d21a3, resumo em F:\temp\2026-09-23\planos-noite\logs\f2-resumo.txt). F2-B já começou em paralelo no repositório principal: plano revisado (f163a7c), tarefa 1 (migração 0906 parte 1) em execução.

F2, tarefas: 1 (registro, D-050), 2 (a977b56), 3 (SQL d78572d; testes de banco c1ba1e6), 4 (d281a8f, teto MCP no banco, D-034 resolvido), 5 (ced16d1, conferidor diário), 6 (35f0ebf), 7 (db8792a, tela em /app/settings/plano), 8 (76774e6, telemetria sem custo; D-051). Correções da revisão (e3ae0bc) e da auditoria (28d21a3); test:db dos arquivos da fase 317 de 317.

F2-B, tarefas (plano em `hiperbold/planos/fase-F2-B-tarefas.md`): 1 (586a7c0), 2a (e1fb4ab), 2b (0fe1424, e corrigiu o aviso de plano da F2 que aparecia indisponível na Central) feitas; parte de banco das tarefas 4, 5 e 8 (0906 parte 4: crédito, adicional, ajuste, saldo, conferidores) em execução; depois, em paralelo por arquivos que não se cruzam: 3 (provas de banco), 4+7 (ações e aba do admin), 5+6 (leitura e tela do cliente), 8 (cron). D-050 corrigido no código (222af53; falta conferir produção antes de publicar). N1 aplicada (07af2c8: 3 milhões de tokens nos três planos). D-056 (GLM não existe; DeepSeek existe sem preço no catálogo) e D-057 (conferências antigas sem origem da chave) registrados.

Portões da F2 na cópia separada: install, test:db inteiro, typecheck, lint e lint:channels verdes; build caiu por falta de memória no passo de TypeScript (sem `NODE_OPTIONS`, ambiente, não código), a refazer com `NODE_OPTIONS=--max-old-space-size=6144` depois da bateria unitária.

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
- **Portões em cópia separada (worktree)**: a bateria de 70 minutos roda numa cópia do repositório no commit fechado, para a fase seguinte andar em paralelo sem violar a regra de não editar arquivo enquanto a bateria roda. Onde mudar: `F:\temp\2026-09-23\planos-noite\portoes-f2.sh`.
- **B5 da auditoria da F2: `billing_usage_counters` saiu de `TABLES` do `rls-isolation`** (linha que o próprio fork tinha posto) e entrou na prova própria da varredura, como `team_invites`: a leitura passou a exigir gerente e o usuário semeado lá é agent. A prova de isolamento é o caso 12 de `planos-trava-avisa.test.ts`.
- **M1 da auditoria da F2: os gatilhos em `user_organizations` ficaram sem lista de colunas**, porque `provisional_until_handover` nasce na 0237, que no baseline vem depois do bloco da 0905: `create trigger ... of` com essa coluna quebraria o install do zero. O corpo só age na transição.
- **F2: leads por contador materializado**; o resto por contagem na hora. Contar 100 mil leads a cada importação derrubaria a importação.
- **F2, tarefa 4: teto de conexões MCP com errcode PT422**, convenção do próprio repositório (migração 0363), mapeado no código para o mesmo 422 da checagem prévia. Onde mudar: `fn_billing_trava_ai_mcp_connections` e `CODIGO_LIMITE_MCP` em `lib/ai/mcp-externo/conexoes.ts`.
- **F2, tarefa 8: telemetria da transcrição só no provedor real**, embrulhado dentro de `buildDeriveDeps` do worker; sem chave ou com endereço recusado, nada é gravado. Rótulo `transcricao_propria` para serviço próprio, nunca a URL. A primeira versão gravava em `derive.ts` e contava transcrição que não aconteceu; refeita na revisão da tarefa.
- **F2, tarefa 8: linha em `llm_calls` sem custo cria linha em `ai_budgets`** para organização que não tinha (o gatilho do autor faz upsert com consumo zero). Conferido: consumo não muda, nada bloqueia.

## Perguntas para o Filipe

- **Respondidas pelo Filipe em 23/09/2026, à tarde**: N10 (só lead aberto conta, confirmado) e N13 a N17 (padrões aprovados). N1 e N12 explicadas de novo a ele; os modelos dos agentes serão baratos e fora da Anthropic (GPT Luna, DeepSeek, GLM), o que torna o D-050 mais importante: hoje o orçamento de IA não enxerga nenhum deles.
- **N13 a N17 (carteira de tokens, F2-B)**: pacote avulso não vence; tetos de segurança diários desligados e, ligados, só avisam; troca de plano no meio do mês não refaz a concessão; embedding não consome tokens do cliente (peso 0); consumo com a chave da própria organização fica fora da carteira. Detalhe e onde muda em `hiperbold/planos/fase-F2-B-tarefas.md`, "Perguntas novas desta fase".
- **Preço anual (N8)**: nulo no catálogo até ele responder. Onde muda: `price_yearly_cents` em `billing_plans`.
- **N10. Lead ganho ou perdido ocupa vaga do plano?** Padrão usado: não, conta só o lead aberto (`status = 'open'`), que é a leitura que menos cobra do cliente. Onde muda: a contagem de leads na F2.
- **N11. Quem vê a tela "Plano e uso" da organização?** Padrão usado: admin e gerente. Onde muda: a tarefa 7 da F2.
- **N12. Ligar o preço do catálogo nas chamadas de IA?** O orçamento de IA que já existe está cego para modelos fora da Anthropic, inclusive em produção. O catálogo com preço existe no banco, mas ligá-lo faz o orçamento começar a contar de uma hora para outra, e a IA pode parar no meio do mês. Padrão usado: não ligar; o painel de margem da F2-B calcula por fora. Registrado como D-050.

## Achados de segurança

- **Alto, corrigido na tarefa 1 da F1**: revogar só `insert, update, delete` de `authenticated` deixava `TRUNCATE` (e `REFERENCES`, `TRIGGER`) nas três tabelas novas, pelo grant padrão do Supabase. `TRUNCATE` passa por cima da RLS. Medido no banco local, antes e depois. Agora: `revoke all` e `grant select`; o teste `planos-migration` trava a volta.
- **Alto, corrigido no plano da F1 antes de implementar**: admin da plataforma com escopo `support_readonly` conseguiria trocar plano. As ações passam a exigir `full`.
- **Auditoria da F1 (08:40): nenhum crítico nem alto.** Médio: membro de organização grava registro falso na auditoria (política do autor, anterior à fase): virou D-046, a resolver antes da cobrança real. Baixos em correção agora: role `agent_worker` escrevia nas tabelas de plano; ações sem conferência de MFA; nota e autor do ajuste legíveis pelo membro; catálogo de planos inteiro legível por qualquer usuário; `search_path` da função de validação. Baixos anteriores à fase, registrados: D-047 (TRUNCATE em 114 tabelas) e D-048 (admin de suporte escreve em `organizations`).
- **Auditoria da F2 (23/09): nenhum crítico nem alto.** Médios, que virariam alto na F3 quando a trava bloquear: (M1) o admin da organização marca membro como `provisional_until_handover` e ele some da contagem de vagas (coluna do autor gravável por `authenticated`); (M2) qualquer membro, até viewer, forja ou apaga o aviso de plano na Central, e a deduplicação por título faz o aviso falso suprimir o verdadeiro (política FOR ALL do autor em `agent_inbox_items`). Os dois em correção na segunda leva. Baixos: convite reenviado volta a pendente sem aviso (B1, em correção); troca de `organization_id` em lead não move o contador (B2, do autor, registrado); conferidor só via organização com contador (B3, corrigido na primeira leva); desarquivar funil não confere etapas e troca de `pipeline_id` de etapa não dispara (B4, em correção); qualquer membro lê o total de leads pelo contador (B5, em correção: só gerente para cima); erro engolido no gatilho de leads sem alarme (B6, junto do D-052).
- **Revisão da F2 (23/09): nenhum alto.** Médios em correção na primeira leva: aviso falso de "gasto incompleto" no cartão de orçamento de IA causado pela telemetria sem custo; aviso de leads um lead antes do teto; conferidor diário segurando a trava de todas as organizações numa transação só; testes faltando para "falha na conferência não derruba o cliente" e para os gatilhos de membros, convites e conexões. Baixos registrados em D-052 e D-053.
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
