# Fase F3: o bloqueio de verdade

Plano mestre: `hiperbold/planos/2026-09-22-planos-e-assinatura.md`, seções 7, 11 e 12. Escrito em 23/09/2026, na sessão do loop, sem o Filipe; decisões de produto pelo padrão da seção 12 ou, sem padrão, pela opção mais conservadora (não cobra a mais, não bloqueia cliente sem aviso, não apaga dado). Revisado antes de implementar (histórico no fim).

**A F3 constrói o bloqueio, mas não o liga.** `billing_settings.modo` continua `avisar` ao fim da fase, em qualquer banco. Ligar é um ato do admin da plataforma, pela tela, com carência para cada organização. No modo `avisar` a fase não pode mudar NADA: nem comportamento, nem consulta a mais no caminho do agente.

## O que já existe e é a base

- Gramática do orçamento de IA do autor, a copiar: `decidirOrcamento` em `lib/agent-engine/edge/llm/orcamento.ts` (modos, carência por `enforcement_effective_at` com nulo = não bloqueia, piso do teto, chave da instalação, `PURPOSES_ISENTOS`, "avisou antes neste mês"); `aplicarOrcamento` em `lib/agent-engine/edge/llm/run-model-call.ts` (atalho sem consulta quando o modo não bloqueia; aviso crítico na Central; `LlmBudgetExceededError` com `terminal = true`, que a fila cancela em vez de repetir e que a escolta e o handoff reconhecem pela classe em `lib/agent-engine/agent/inbound-turn.ts`, `stage-classifier.ts`, `guardrails/jailbreak/classifier.ts`, `lib/ai/conversa-do-caso/motivo.ts` e no `error_code` do próprio `run-model-call`).
- O `db` do `run-model-call` é o pool de `SUPABASE_DB_URL`; na Hiperbold, o papel `agent_worker` (bypassrls, ganha execute em função nova por `alter default privileges`).
- F2: `billing_settings.modo` (`desligado`, `avisar`, `bloquear`), gatilhos `trg_billing_trava_*` que só avisam e engolem todo erro, `fn_billing_pode_criar` e `lib/billing/planos/pode-criar.ts` (sem chamador), a trava `pg_advisory_xact_lock(hashtextextended('billing:'||org||':'||item, 0))`.
- F2-B: a carteira, `fn_billing_garantir_concessoes` (preguiçosa), `fn_billing_saldo_da_carteira`, `llm_calls.origem_da_chave`.

## Decisões de desenho

1. **O modo é da instalação** (`billing_settings.modo`). Mapeamento dos nomes: banco `desligado`/`avisar`/`bloquear`; variável de ambiente `PLANOS_BLOQUEIO` com `off`/`avisar`/`on` (padrão `on`, que significa "obedece o banco"). **A variável só alcança o que roda no Node**: o bloqueio da IA e o `podeCriar` dos caminhos de lead. Os gatilhos do banco não leem variável de ambiente; a emergência para eles é passar o modo para `avisar` pela tela do admin ou, sem tela, por `update billing_settings set modo = 'avisar' where id = 1`. Esse procedimento vai escrito no HANDOFF e provado na tarefa 3.
2. **Carência por organização**: `billing_contracts.bloqueio_a_partir_de timestamptz`, **nulo = não bloqueia** (mesma regra de `enforcement_effective_at`). `fn_billing_definir_modo(p_modo, p_actor)` preenche `now() + carencia_dias` (`billing_settings.carencia_dias`, padrão 7, N19) em toda organização sem data ao passar para `bloquear`, com aviso na Central. Organização criada com o modo já em `bloquear` recebe a carência por um gatilho NOSSO em `billing_contracts` (after insert), sem editar o gatilho da 0904. Troca para plano de teto menor dá carência a partir da troca.
3. **Bloqueio no banco** (funis, etapas por funil, conexões, integrações webhook, e membros pela decisão 4): em cada gatilho, uma checagem de bloqueio SEPARADA da de aviso, que roda antes. Ela pega a MESMA trava bloqueante da conferência (`pg_advisory_xact_lock`, nunca `try`: com `try`, duas criações simultâneas no teto menos um passariam as duas), conta DEPOIS da trava (`fn_billing_pode_criar` é VOLATILE e enxerga a linha já commitada, em READ COMMITTED), calcula o veredito dentro de um bloco `begin/exception` que em falha interna devolve "libera" (com `raise warning`), e só DEPOIS do bloco faz `raise exception ... using errcode = 'PT402'` com mensagem fixa. O raise nunca fica dentro de um `exception when others`. No modo `bloquear`, o aviso da Central daquele insert é desfeito junto com a transação recusada: o aviso do bloqueio é o de `fn_billing_definir_modo` e o erro na tela; está declarado.
4. **Membros**: bloqueia convite novo, convite renovado e vínculo direto acima do teto. **Aceite de convite nunca bloqueia**: o gatilho de `user_organizations` (em insert e em update, porque a readmissão passa pelo update de `fn_accept_team_invite`) isenta o vínculo quando existe convite pendente e válido para o e-mail do usuário (`auth.users.email` contra `team_invites.email`, sem diferença de maiúsculas, `accepted_at` e `revoked_at` nulos, `expires_at > now()`; o `aplicar-convite.ts` só marca o convite depois, então no gatilho ele ainda está pendente). Convite sem linha (token antigo, caso válido declarado em `aplicar-convite.ts`): isento quando o vínculo nasce dentro de `fn_accept_team_invite`; o critério para reconhecer isso sem editar a função do autor é escolhido e provado na tarefa 2 (na dúvida, isenta: bloquear o aceite de quem foi convidado é o erro mais caro). O dono no provisionamento (`lib/auth/provision.ts`) é isento. A mesma isenção vale na checagem de AVISO, o que resolve o item 1 do D-053.
5. **Leads não bloqueiam no banco** (receber mensagem nunca para, seção 12, pergunta 7). No modo `bloquear`, o limite de leads vale nos caminhos que uma PESSOA dispara, pelo `podeCriar` nas ROTAS, nunca dentro do `createLeadHandler`/`moveLeadHandler` compartilhados (que o webhook de entrada e o MCP também usam):
   - bloqueia: criar pela tela e pela API (`app/api/v1/leads/route.ts`), clonar, importar planilha, reabrir à mão (mover para etapa aberta pela rota de mover, pelo quadro do funil, pelo lote, e `lib/leads/reactivation.ts`), e as ferramentas MCP de criar e mover lead (são a API pública por token);
   - só avisa: mensagem que chega (`lib/channels/pos-entrada.ts`), webhook de entrada, automações, agente de IA e de voz movendo card, retorno de follow-up, e a campanha de prospecção (N22);
   - em lote e importação, a checagem é da QUANTIDADE (`atual + n <= teto`), não de mais um;
   - sem trava de banco nesses caminhos, uma corrida entre duas pessoas pode passar do teto por pouco: aceito e declarado.
6. **A IA para quando o saldo de tokens acaba**: `fn_billing_ia_pode_responder(p_org uuid) returns jsonb`, `security definer` (precisa chamar a concessão, cujo execute foi tirado do `agent_worker`), executável por `service_role` e pelo `agent_worker`, e FORA do bloco de revoke do `agent_worker` (escrito no comentário, para ninguém copiar o bloco por reflexo). **Nunca bloqueia por falta de linha de concessão**: sem linha de `plano` no ciclo atual, conta o teto efetivo de tokens como creditado. Responde `seguir`, `avisar_e_seguir` ou `bloquear` com o motivo. No TypeScript, a chamada só acontece quando: a variável e o modo (lido com cache curto em memória, como a chave do orçamento) permitem bloquear, `origemDaChave === 'chave_da_instalacao'`, e o propósito não está em `PURPOSES_ISENTOS`. No modo `avisar`, zero consulta a mais.
7. **O desfecho é o do orçamento, com identidade própria**: `class LlmCarteiraEsgotadaError extends LlmBudgetExceededError` (a fila cancela, a escolta e o handoff reconhecem), com mensagem própria, título e corpo próprios na Central ("os tokens de IA do mês acabaram; contrate mais tokens"), e `ref_kind` próprio (`billing_carteira`) para a deduplicação não se misturar com o `budget_exceeded` do orçamento em dólar. Os cinco consumidores que reconhecem a classe são conferidos na tarefa. O motivo do handoff (`last_handoff_reason`) ganha valor próprio se o vocabulário do autor permitir; senão reaproveita `orcamento_de_ia` e o registro diz por quê.
8. **Mídia não para** (N20): transcrição, visão e embedding continuam com o saldo zerado.
9. **Servidor**: cada caminho de criação e reativação dos itens bloqueados reconhece o erro pelo `code === 'PT402'` (não pelo status HTTP: os caminhos por `pg.Pool` não têm status) e devolve 402 com frase fixa, nunca o texto do Postgres (hoje os handlers devolvem `insErr.message` num 500).
10. **Tela**: botões de criar funil, etapa, lead, convite, conexão e integração desabilitados com o motivo quando o bloqueio vale para a organização; a tela "Plano e uso" mostra o modo e a carência.
11. **Admin da plataforma**: modo, dias de carência e carência extra para uma organização, na tela da instalação (`app/admin/sistema`), escopo `full`, MFA, auditoria.
12. **Folgas declaradas**: o débito com trava ocupada fica para o conferidor da noite, então o saldo pode atrasar e o bloqueio da IA entrar um pouco depois do fim real; o caminho legado `workers/ai-response-worker.ts` e as conferências por `log-invocation` não gravam origem (D-057) e ficam fora do débito e do bloqueio.

## Tarefas

1. **Banco: modo, carência e bloqueio de funis, etapas, conexões e webhooks** (migração 0907, parte 1). Provas à mão, com concorrência.
2. **Banco: bloqueio de membros com as isenções** (parte 2). Provas dos quatro casos da decisão 4.
3. **Banco: `fn_billing_ia_pode_responder`** (parte 3). Provas: sem linha de concessão não bloqueia; Ilimitado; chave da organização; carência; desempenho.
4. **Provas de banco**: `tests/invariants/planos-bloqueio.test.ts` (concorrência, carência nula e vencida, organização nova com o modo ligado, aceite de convite, emergência pelo modo, e o modo `avisar` sem mudança nenhuma).
5. **Servidor, funis, etapas, conexões e webhooks**: tratamento do `PT402` em cada caminho.
6. **Servidor, membros**: convite, reenvio, vínculo direto.
7. **Servidor, leads**: `podeCriar` nas rotas de pessoa, com quantidade em lote e importação.
8. **IA**: o bloqueio no `run-model-call` (decisões 6 e 7).
9. **Tela do cliente**: botões e estado.
10. **Admin da plataforma**: o controle do modo e da carência.

## Perguntas novas desta fase

- **N18. Lead que chega sozinho (mensagem, webhook de entrada, automação) é bloqueado quando passa do teto?** Padrão: não; só avisa.
- **N19. Quantos dias de carência?** Padrão: 7.
- **N20. Com o saldo de tokens zerado, a transcrição e a leitura de imagem param também?** Padrão: não.
- **N21. Quando ligar o bloqueio em produção?** Padrão: não liga; fica em `avisar` até o Filipe ligar pela tela.
- **N22. A campanha de prospecção (uma pessoa dispara, o sistema cria leads em massa) respeita o teto de leads?** Padrão: não bloqueia, só avisa, como os caminhos automáticos.

## Histórico da revisão

Revisado em 23/09/2026 antes de implementar. Altos incorporados: a IA bloquearia no dia 1 do mês por falta de linha de concessão (conta o teto efetivo); um erro novo não teria o desfecho do orçamento (subclasse de `LlmBudgetExceededError`, `ref_kind` próprio); a variável de emergência não alcança os gatilhos (procedimento pelo modo). Médios incorporados: isenção do aceite por e-mail, com readmissão, convite sem linha e dono no provisionamento, também na checagem de aviso; trava bloqueante e raise fora do bloco que engole; carência nula = não bloqueia e organização nova com o modo ligado; mapa real dos caminhos de lead, checagem por quantidade; atalho sem consulta no modo `avisar`; papel do worker; `PT402` pelo código. Tarefas divididas.
