# Fase F2: contar cada item e travar no banco, só avisando

Parte do plano `hiperbold/planos/2026-09-22-planos-e-assinatura.md` (seção 11). Escrito em 23/09/2026 pelo loop, a partir de dois mapeamentos do código, e revisado uma vez (achados incorporados; ver "Histórico da revisão" no fim).

**Objetivo da fase:** o CRM passa a saber quanto cada organização usa de cada item da matriz, e cada item limitado ganha uma trava no banco. **Nesta fase a trava só avisa**: quando a organização passa do teto, nasce um aviso na Central e a operação segue. O bloqueio de verdade é da F3. Com todas as organizações no Ilimitado, nada avisa de fato.

## O que os mapeamentos mostraram

| Item | Tabela | O que conta como ativo | Como se entra e se sai de "ativo" |
|---|---|---|---|
| Funis | `crm_pipelines` | `is_archived = false` | criação; desarquivar por PATCH |
| Etapas por funil | `crm_stages` (`pipeline_id`) | `is_archived = false` | criação (inclusive várias num INSERT só); desarquivar |
| Leads | `crm_leads` | `status = 'open'` | criação; **mudança de etapa**, porque o gatilho do autor `trg_crm_lead_close_on_stage` troca o `status` quando a etapa é de ganho ou de perda, e reabre quando volta; reativação |
| Membros | `user_organizations` + `team_invites` | membro: `accepted_at` preenchido, `revoked_at` nulo, e não é o admin provisório (`provisional_until_handover`); convite: pendente e não vencido (`expires_at > now()`) | convite; aceite; readmissão de revogado dentro de `fn_accept_team_invite` |
| Conexões | `channel_sessions` | `archived_at` nulo | criação; desarquivar |
| Integrações webhook | `webhook_sources` | `is_active = true` | criação (pode nascer desligada); ligar por PATCH |

## Decisões de desenho

1. **Integração webhook é `webhook_sources`** (a entrada automática de leads). O webhook que SAI das automações mora em `automation_rules`, e automação não é limitada no plano do Filipe. Pergunta N5 respondida pela investigação.
2. **Lead conta só enquanto está aberto** (`status = 'open'`): a leitura que menos cobra do cliente. Pergunta nova N10.
3. **Membro conta ativo mais convite pendente não vencido; o admin provisório não conta.** O admin provisório é quem fica até entregar a conta ao dono, e ocuparia uma das 3 vagas do Pro.
4. **Configuração numa tabela nossa, `billing_settings`** (linha única), e não em `platform_settings` do autor. Modo inicial `avisar`. Valores `desligado`, `avisar`, `bloquear` (este só funciona na F3).
5. **A trava olha a TRANSIÇÃO para ativo, não só a criação.** Gatilho `before insert or update of <coluna de estado>` em cada tabela, e a conferência só roda quando o item passa de inativo para ativo. Sem isso, desarquivar, religar ou readmitir passaria por fora, o que na F3 viraria contorno trivial do bloqueio.
6. **Leads: uma coisa só num gatilho `after insert or update or delete` SEM lista de colunas**, que compara `old.status` com `new.status`, mantém o contador e confere o teto. `after` e sem lista de colunas porque quem muda o `status` na troca de etapa é o gatilho `before` do autor, e gatilho com lista de colunas não enxerga mudança feita por outro gatilho. Conferir no `after` também resolve a ordem: o lead já está com o `status` final.
7. **Contagem**: `count(*)` na hora para funis, etapas, membros, conexões e integrações; **leads por contador materializado** (`billing_usage_counters`), com conferidor diário.
8. **Lê o teto primeiro; sem teto, sai sem travar e sem contar.** Hoje todas as organizações estão no Ilimitado, e travar sem teto serializaria toda criação da organização à toa. Com teto, pega `pg_advisory_xact_lock` pela chave `(organização, item)` antes de contar.
9. **As funções que contam são `volatile`**, não `stable`: função `stable` enxerga a foto do começo do comando, e um funil criado com 20 etapas num INSERT só contaria zero em todas.
10. **Todo gatilho é `security definer` com `search_path` fixo** (regra D-049).
11. **Nada nesta fase derruba a operação do usuário.** O corpo de cada gatilho de plano captura qualquer erro e segue com `raise warning`. O contador nunca fica negativo (`greatest(valor - 1, 0)`) e só é criado por upsert ao SOMAR; ao subtrair é só `update`, para a exclusão em cascata de uma organização não recriar a linha do contador no meio da exclusão.
12. **Aviso na Central**: `kind = 'other'`, `ref_kind = 'billing_limite'`, deduplicado por organização, `ref_kind` e título enquanto aberto. A Central é vista por todos os membros da organização; aceito e registrado (é a regra da Central do autor).
13. **A tela "Plano e uso" é para admin e gerente** (pergunta nova N11).
14. **Tokens fora desta fase**: a carteira é da F2-B.
15. **O preço dos modelos NÃO é ligado nesta fase** (ver tarefa 1).

---

## Tarefa 1: preço dos modelos (investigação b), só registro

**O que a investigação achou:** o preço por token usado nas chamadas mora numa tabela escrita à mão (`lib/agent-engine/edge/llm/pricing.ts`, linhas 47 a 62), só com modelos da Anthropic. **Já existe no banco um catálogo com preço** (`ai_models.input_price_per_million_cents`, `baseline.sql` perto da linha 1164, atualizado pelo cron `sync-model-catalog`), e já existe quem o leia (`lib/ai/runtime/cost.ts:34`). Modelo fora da tabela à mão sai com `cost_cents` nulo, e o orçamento de IA soma nulo como zero: **para esses modelos, o teto de gasto de IA nunca dispara, inclusive em produção.**

**Por que NÃO ligar agora:** passar a preencher `cost_cents` pelo catálogo faz o orçamento de IA começar a contar de uma hora para outra (orçamento padrão de 5000 centavos por mês, gatilho `trg_llm_calls_budget`). Organizações com modelo fora da Anthropic podem ter a IA parada no meio do mês. Isso muda o comportamento de produção e é decisão do Filipe, não do loop.

**O que fazer:** registrar no `DEBITO.md` (com o impacto escrito) e como pergunta no progresso. O painel de margem da F2-B calcula custo por fora, pelo catálogo, sem mexer no `cost_cents` nem no orçamento. Sem código nesta tarefa.

## Tarefa 2: configuração, contador e funções de contagem (migração 0905, parte 1)

**Arquivos:** `supabase/migrations/20260923100000_0905_planos_uso_e_trava.sql` (novo), o bloco igual no `supabase/baseline.sql` (depois do da 0904, antes de `-- ---- VARREDURA anon:`), `supabase/migrations/MANIFEST.md`, `tests/unit/planos-uso-migration.test.ts` (novo).

1. `billing_settings` (linha única, `id = 1` com check): `modo text not null default 'avisar'` (check), `updated_at`. Semeadura com `on conflict do nothing`.
2. `billing_usage_counters`: `organization_id` (fk com `on delete cascade`), `item text` (check: só `leads` nesta fase), `valor bigint not null default 0 check (valor >= 0)`, `updated_at`; chave primária `(organization_id, item)`. Preenchimento inicial com a contagem real dos leads abertos.
3. **Permissões, como na 0904**: `revoke all ... from anon, authenticated` nas duas tabelas; `grant select` em `billing_usage_counters` para `authenticated` (política de leitura por organização e admin da plataforma); nada em `billing_settings`. RLS ligada nas duas.
4. `fn_billing_uso(p_org uuid) returns jsonb` e `fn_billing_pode_criar(p_org uuid, p_item text, p_pipeline uuid default null) returns jsonb` (`{pode, motivo, atual, teto}`; `motivo` em `ok`, `teto_atingido`, `sem_limite`). Ambas `volatile`, `security definer`, `search_path` fixo, `execute` só para `service_role` (as duas origens revogadas). `etapas_por_funil` em `fn_billing_uso` é o MAIOR número de etapas ativas entre os funis ativos; em `fn_billing_pode_criar`, o do funil informado. Membros com a definição da decisão 3.
5. **Bloco da role `agent_worker`**, se ela existir: revoga `insert, update, delete, truncate` nas duas tabelas novas e `execute` de TODAS as funções novas desta migração.

**Teste unitário:** bloco depois do da 0904 e antes da varredura; migração e bloco iguais sem comentários e linhas em branco; RLS; `revoke all` seguido de `grant select`; funções `volatile` e com `revoke execute`.

**Critério de pronto:** aplicada duas vezes no banco local sem erro; `fn_billing_uso` coerente com contagens feitas à mão.

## Tarefa 3: os gatilhos que avisam (migração 0905, parte 2)

**Arquivos:** os da tarefa 2, e `tests/invariants/planos-trava-avisa.test.ts` (novo), e a lista `TABLES` de `tests/invariants/rls-isolation.test.ts` (acrescentar `billing_usage_counters` com a linha semeada que o controle positivo exige, como na F1).

1. `fn_billing_conferir_teto(p_org uuid, p_item text, p_pipeline uuid)`: lê o modo; `desligado` sai; lê o teto; sem teto sai; trava; confere; passou do teto, cria o aviso da decisão 12 e segue. `bloquear` comporta-se como `avisar` nesta fase, com `raise warning`. Captura qualquer erro.
2. Gatilhos `before insert or update of <coluna de estado>`, `security definer`, que só chamam a conferência na transição para ativo (em `insert`, quando nasce ativo; em `update`, quando o antigo era inativo e o novo é ativo):
   - `crm_pipelines` (`is_archived`), `crm_stages` (`is_archived`, com o `pipeline_id`), `channel_sessions` (`archived_at`), `webhook_sources` (`is_active`);
   - `team_invites` (nasce pendente) e `user_organizations` (`accepted_at`, `revoked_at`: readmissão e aceite contam; o admin provisório não).
3. Leads, decisão 6: gatilho `after insert or update or delete` sem lista de colunas em `crm_leads`. Compara `old.status` e `new.status`: entrou em `open` soma (upsert), saiu de `open` subtrai (só `update`, com `greatest`), e confere o teto quando somou. Captura qualquer erro.
4. `fn_billing_conferir_contadores()`: por organização, trava a linha do contador (`select ... for update`) e só depois, num comando seguinte, conta e corrige. Devolve quantas divergiam. `execute` só para `service_role`.

**Teste de banco (`planos-trava-avisa.test.ts`)**, com `authenticated` e JWT real onde fizer sentido:
- organização no Pro com ajuste de funis igual a 1: criar o segundo funil passa e nasce UM aviso; o terceiro não duplica;
- desarquivar um funil acima do teto também avisa; religar uma integração desligada também avisa;
- criar funil com várias etapas num INSERT só, passando do teto de etapas, avisa (prova do `volatile`);
- modo `desligado`: nenhum aviso; organização no Ilimitado: nenhum aviso e nenhuma trava tomada;
- contador de leads coerente depois de: criar aberto, mover para etapa de ganho por `update` de `stage_id`, mover em lote por `fn_mover_leads_em_lote` para etapa de perda, voltar para etapa comum, e apagar;
- apagar a organização inteira não quebra por causa do contador;
- `fn_billing_conferir_contadores` corrige um contador adulterado e devolve 1;
- criar lead como membro comum continua funcionando (o gatilho `security definer` não quebra o insert da sessão do usuário);
- convite vencido não conta; admin provisório não conta;
- `billing_usage_counters` isolado entre organizações.

## Tarefa 4: teto técnico das conexões MCP no banco (D-034)

Acrescenta à migração 0905 e ao bloco. Gatilho `before insert` em `ai_mcp_connections`, `security definer`, com trava pela organização: a décima primeira conexão da organização é RECUSADA (teto técnico que já existia no código, não é de plano). Mensagem de erro fixa. Teste no arquivo da tarefa 3: a décima primeira é recusada.

## Tarefa 5: o conferidor diário

**Arquivos:** uma rota em `app/api/v1/cron/` no padrão das existentes (com `autorizaCron()`), o teste dela, a linha de agendamento em `docker/scheduler/entrypoint.sh` (arquivo do autor: uma linha só, para reduzir conflito de junção), e o que `tests/unit/cron-routes-scheduled.test.ts` exigir.

Horário 04:55, depois de `sync-model-catalog` (04:15) e `data-retention` (04:40). A rota chama `fn_billing_conferir_contadores()` e registra no log quantos divergiam; divergência maior que zero vira `log.warn`. **Registrar no status**: a imagem `deskcomm-scheduler` precisa ser publicada de novo para o agendamento valer em produção.

## Tarefa 6: leitura no servidor

`lib/billing/planos/uso-da-organizacao.ts` e `lib/billing/planos/pode-criar.ts`, com testes, no padrão de `plano-da-organizacao.ts`: nunca lançam; erro vira `leituraFalhou: true` com `alarme_planos_leitura`.

## Tarefa 7: a tela "Plano e uso"

Página nas configurações da organização (siga o padrão de `app/app/settings/`, inclusive o item de menu), com os textos no dicionário e a versão em espanhol. Por item, uso contra teto ("3 de 5 funis") com barra, "sem limite" quando nulo, aviso "Nesta fase nenhum limite bloqueia", tokens "medido a partir da próxima fase". Só admin e gerente (conferido no servidor). Leitura que falha mostra aviso, nunca "sem limite".

## Tarefa 8: medir o que hoje escapa

**Arquivos certos, segundo a revisão:** o embedding real passa por `lib/ai/embed.ts` (chamado de `lib/agent-engine/agent/search-knowledge.ts:60`, `workers/ai-response-worker.ts:917`, `workers/rag-indexer.ts:397`); `lib/agent-engine/edge/llm/embed.ts` não tem chamador em produção. A transcrição não recebe a organização (`lib/messaging/media/transcription.ts:30`): a gravação vai em quem chama (`lib/messaging/media/derive.ts:27` e `video-derive.ts:60`). O registro `lib/ai/pontos/registro.ts` aponta o emissor errado e precisa ser corrigido junto.

**O que fazer:** gravar em `llm_calls` as chamadas de embedding e de transcrição, com `organization_id`, os tokens que houver, e **`cost_cents` nulo** (decisão 15: preencher custo ligaria o orçamento de IA). Transcrição é por minuto: tokens zerados. Leitura de imagem: localizar e fazer igual, ou registrar como débito. Atualizar o `registraEm` e o teste que o cobra. **Uma falha ao gravar a telemetria nunca derruba a chamada**, com teste.

---

## Fechamento da fase

1. Revisor na fase inteira.
2. Auditor, com foco em: gatilhos `security definer` sem escalada; contador que o membro não adultera; aviso que não vaza dado de outra organização; rota de cron protegida; tela só para admin e gerente.
3. Portões completos.

## Para a F3 (registrado, não é desta fase)

- Quando `bloquear` levantar exceção, o aviso gravado na mesma transação volta junto: o aviso de bloqueio tem de sair pela aplicação, a partir do erro, ou por canal fora da transação.
- Estouro de `lock_timeout` (4 s para `authenticated`) hoje libera; na F3 precisa de decisão.
- O aceite de convite não é atômico (`lib/auth/aplicar-convite.ts:68` e `:102-108`): entre os dois passos a pessoa conta em dobro. Inofensivo na F2; na F3 pode recusar um aceite legítimo.
- A semeadura da organização cria 1 funil e 8 etapas. Se um dia a organização nascer num plano com menos de 8 etapas por funil, a criação da organização quebra.
- `truncate` não dispara gatilho de linha; só o conferidor diário conserta o contador.

## Perguntas novas desta fase

- **N10. Lead ganho ou perdido ocupa vaga?** Padrão: não.
- **N11. Quem vê "Plano e uso"?** Padrão: admin e gerente.
- **N12. Ligar o preço do catálogo nas chamadas de IA?** Liga junto o teto de gasto de IA, hoje cego para modelos fora da Anthropic, inclusive em produção. Padrão: não ligar; o painel de margem calcula por fora.

## Histórico da revisão

Revisão 1 (23/09/2026): 2 achados altos (contador de leads não enxergava a mudança de status feita pelo gatilho de etapa do autor; a trava só olhava criação e não reativação), 8 médios (funções `stable` num INSERT de várias linhas; conferidor diário que podia criar divergência; contador que podia derrubar exclusão; trava tomada sem teto; aviso que some junto com o bloqueio na F3; convite vencido e admin provisório contando; ligar o preço mudaria produção; cron sem o agendador) e 5 baixos. Todos incorporados acima.
