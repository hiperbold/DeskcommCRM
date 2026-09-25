# Progresso da noite

Início: 23/09/2026 01:21
Branch: feat/planos-assinatura (a partir de fix/debitos-pequenos-2026-09-22, commit e5231de)
Fase atual: F7 fechada; próximo passo depende do Filipe (respostas, revisão visual do site, checklist de publicação D-075). F4, F5 e F7 fechadas ou em fechamento; F6 entregue para revisão visual do Filipe.
Etapa da fase: F5 fechada, 22 tarefas do plano `hiperbold/planos/fase-F5-tarefas.md` feitas entre os commits ce99bf7 e c6caa73, revisão de código e auditoria de segurança do núcleo concluídas, mais duas rodadas de revisão das correções, todos os achados corrigidos. F6 entregue para revisão visual em `http://localhost:4321/`, projeto `F:\github-projects\hipercrm-site`, commit local 2ba4c37, sem remoto.

F2, tarefas: 1 (registro, D-050), 2 (a977b56), 3 (SQL d78572d; testes de banco c1ba1e6), 4 (d281a8f, teto MCP no banco, D-034 resolvido), 5 (ced16d1, conferidor diário), 6 (35f0ebf), 7 (db8792a, tela em /app/settings/plano), 8 (76774e6, telemetria sem custo; D-051). Correções da revisão (e3ae0bc) e da auditoria (28d21a3); test:db dos arquivos da fase 317 de 317.

F2-B, tarefas (plano em `hiperbold/planos/fase-F2-B-tarefas.md`): 1 (586a7c0), 2a (e1fb4ab), 2b (0fe1424, e corrigiu o aviso de plano da F2 que aparecia indisponível na Central) feitas; parte de banco das tarefas 4, 5 e 8 (0906 parte 4: crédito, adicional, ajuste, saldo, conferidores) em execução; depois, em paralelo por arquivos que não se cruzam: 3 (provas de banco), 4+7 (ações e aba do admin), 5+6 (leitura e tela do cliente), 8 (cron). D-050 corrigido no código (222af53; falta conferir produção antes de publicar). N1 aplicada (07af2c8: 3 milhões de tokens nos três planos). D-056 (GLM não existe; DeepSeek existe sem preço no catálogo) e D-057 (conferências antigas sem origem da chave) registrados.

Portões da F2 na cópia separada: install, test:db inteiro, typecheck, lint e lint:channels verdes; build caiu por falta de memória no passo de TypeScript (sem `NODE_OPTIONS`, ambiente, não código), a refazer com `NODE_OPTIONS=--max-old-space-size=6144` depois da bateria unitária.

## Fases

| Fase | Estado | Commit | Data |
|---|---|---|---|
| F1 | **feita**: 6 tarefas, revisão e auditoria sem achado alto, todos os portões verdes | 8fa4893 | 23/09/2026 09:44 |
| F2 | **feita**: 8 tarefas, revisão e auditoria sem achado alto (médios corrigidos em duas levas), todos os portões verdes | 28d21a3 | 23/09/2026 15:20 |
| F2-B | **feita**: 8 tarefas, revisão (2 altos) e auditoria (1 alto) corrigidas; portões no commit 3898b63 com os vermelhos abaixo, todos corrigidos e reconferidos | a0f7d60 | 23/09/2026 21:05 |
| F3 | **feita**: 10 tarefas; auditoria (3 altos) e revisão (3 médios) corrigidas e provadas no banco; portões no commit 2f4bcc3 com 2 vermelhos de teste do autor, corrigidos e reconferidos | ver abaixo | 24/09/2026 04:05 |
| F4 | fechada em 24/09/2026: 8 tarefas, revisão, auditoria, duas rodadas de correção, portões completos verdes em de8ed83 (só o vermelho de ambiente do Redis) | de8ed83 | 24/09 |
| F5 | **feita**: 22 tarefas, revisão e auditoria do núcleo, todas as correções aplicadas | c6caa73 | 25/09/2026 |
| F6 | registrada (pedido do Filipe, 23/09 à tarde): site de vendas, `/precos`, Termos e Privacidade. Fica depois das fases do loop; não começa sem confirmação | ff34e69 | |
| F7 | em fechamento: saneamento técnico, 5 lotes | ver abaixo | 25/09/2026 |

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
- **Consolidado em 24/09/2026, madrugada (Filipe mandou anotar todas e seguir sem parar)**: abertas N3 (cache a 10% e conferências contam), N8 (preço anual), N9 (preço e tamanho do pacote de tokens), N19 (7 dias de carência), N20 (mídia não para com tokens zerados), N21 (quando ligar o bloqueio), N23 e N24 (F4), as antigas A a D da seção 12 do plano mestre (suspensão, avaliação, contatos, onde digitar o cartão, tolerância, cancelamento, estorno), F6 (quando e com quais dados da empresa), D-056 (integrar GLM), D-050 (autorizar a leitura do banco de produção antes de publicar). Cada uma segue com o padrão declarado.
- **Respondidas pelo Filipe em 23/09/2026, fim da tarde**: N18 e N22: toda criação de lead para no teto, qualquer origem (automação, webhook, prospecção inclusive); o chat ao vivo nunca para, porque conversa não é lead. Prospecção (função do autor, chegou na junção de 22/09): fica disponível; a busca usa a chave do Apify da PRÓPRIA organização (conferido: `credential(db, admin, org)` em `lib/prospecting/store.ts`), por conta do cliente, fora dos planos e dos tokens. As mensagens que o agente de IA manda na campanha consomem tokens como qualquer resposta, e os leads criados contam no teto.
- **N13 a N17 (carteira de tokens, F2-B)**: pacote avulso não vence; tetos de segurança diários desligados e, ligados, só avisam; troca de plano no meio do mês não refaz a concessão; embedding não consome tokens do cliente (peso 0); consumo com a chave da própria organização fica fora da carteira. Detalhe e onde muda em `hiperbold/planos/fase-F2-B-tarefas.md`, "Perguntas novas desta fase".
- **Preço anual (N8)**: nulo no catálogo até ele responder. Onde muda: `price_yearly_cents` em `billing_plans`.
- **N10. Lead ganho ou perdido ocupa vaga do plano?** Padrão usado: não, conta só o lead aberto (`status = 'open'`), que é a leitura que menos cobra do cliente. Onde muda: a contagem de leads na F2.
- **N11. Quem vê a tela "Plano e uso" da organização?** Padrão usado: admin e gerente. Onde muda: a tarefa 7 da F2.
- **N12. Ligar o preço do catálogo nas chamadas de IA?** O orçamento de IA que já existe está cego para modelos fora da Anthropic, inclusive em produção. O catálogo com preço existe no banco, mas ligá-lo faz o orçamento começar a contar de uma hora para outra, e a IA pode parar no meio do mês. Padrão usado: não ligar; o painel de margem da F2-B calcula por fora. Registrado como D-050.

## Achados de segurança

- **Alto, corrigido na tarefa 1 da F1**: revogar só `insert, update, delete` de `authenticated` deixava `TRUNCATE` (e `REFERENCES`, `TRIGGER`) nas três tabelas novas, pelo grant padrão do Supabase. `TRUNCATE` passa por cima da RLS. Medido no banco local, antes e depois. Agora: `revoke all` e `grant select`; o teste `planos-migration` trava a volta.
- **Alto, corrigido no plano da F1 antes de implementar**: admin da plataforma com escopo `support_readonly` conseguiria trocar plano. As ações passam a exigir `full`.
- **Auditoria da F1 (08:40): nenhum crítico nem alto.** Médio: membro de organização grava registro falso na auditoria (política do autor, anterior à fase): virou D-046, a resolver antes da cobrança real. Baixos em correção agora: role `agent_worker` escrevia nas tabelas de plano; ações sem conferência de MFA; nota e autor do ajuste legíveis pelo membro; catálogo de planos inteiro legível por qualquer usuário; `search_path` da função de validação. Baixos anteriores à fase, registrados: D-047 (TRUNCATE em 114 tabelas) e D-048 (admin de suporte escreve em `organizations`).
- **Revisão da F3 (24/09, madrugada): nenhum alto; 3 médios.** (1) a correção A1 levou a soma do contador de leads para o BEFORE e, no modo `avisar` (o de produção), um lote que reabre leads passou a poder travar em deadlock com um arrasto de card simultâneo: regressão no modo que não podia mudar; correção: no modo `avisar` a soma volta ao AFTER, e só com o bloqueio valendo ela fica no BEFORE; (2) a deduplicação diária do aviso de lead recusado se desfaz sozinha depois do primeiro par simultâneo; (3) `darCarenciaExtra` lê e grava sem conferir que nada mudou, aceita 31/02 e grava meia-noite UTC (véspera em Brasília). Baixos: uma consulta a mais por carga em sete telas no modo `avisar`; janela de contagem durante a primeira aplicação do baseline; Execuções sem orientação para a recusa da carteira; aviso da carteira aberto para sempre; importação sem resumo quando a corrida estoura no meio; `billing_carteira` fora das políticas que protegem o aviso de plano contra o membro.
- **Auditoria da F3 (24/09, madrugada): 3 ALTOS, provados no banco local, bloqueiam ligar o bloqueio.** (A1) vários leads num comando só (insert em massa, reabertura em massa pelo PostgREST, `fn_mover_leads_em_lote`) passavam por cima do teto, porque o contador só soma no AFTER ROW, no fim do comando; (A2) a suspeita abaixo se confirmou: o admin da organização fura o teto de membros gravando `invited_at` pelo PostgREST; (A3) trocar o e-mail de um convite pendente recicla a mesma vaga sem fim. Médio: D-054 (troca de `organization_id`) vira escape com o bloqueio ligado. Baixos: o worker lê o saldo de qualquer organização pela função da IA; reaproveitamento de sessão WAHA arquivada (improvável). Em correção. Conferido correto: quem liga o bloqueio e dá carência, nenhuma falha que libera provocável pela organização, modo `avisar` sem mudança nenhuma, origem da chave não forjável.
- **Para a auditoria da F3 olhar (suspeita da sessão principal, não provada)**: a isenção 2 do bloqueio de membros aceita qualquer vínculo inserido com `invited_by` ou `invited_at` preenchido; se o admin da organização consegue inserir em `user_organizations` pela política do autor (`user_orgs_insert`), ele contornaria o teto de membros gravando essas colunas. Conferir quem pode inserir e, se for o caso, exigir que a marca venha de `fn_accept_team_invite` (papel da sessão).
- **Portões da F2-B pegaram uma regressão**: o invariante do autor `autonomia-preview-core` (o Testar agente não pode fazer HTTP) falhou porque o custo pelo catálogo lia `ai_models` pelo PostgREST; corrigido em d0a7230 (o agente lê pelo pool pg). Cinco testes estruturais da carteira estavam desatualizados depois da correção da revisão; atualizados em b5b42b7.
- **Auditoria da F2-B (23/09): 1 ALTO, anterior à fase e agravado por ela**: qualquer membro, até viewer, escreve em `llm_calls` (política FOR ALL e grants do autor); provado que apagar ou reescrever a própria chamada fazia o conferidor devolver os tokens, e que uma linha falsa com custo enorme estoura `ai_budgets` e derruba toda chamada legítima da organização. Em correção: revogar escrita de `authenticated` em `llm_calls` e conferidor pelo livro-caixa, sem depender de `llm_calls`. Médios: débito em dobro quando a divisão entre fontes muda (conferidor em paralelo); preço nulo no catálogo virando custo zero. Baixos: adicional reenviado com chave de outra organização, estorno repetido da mesma linha, `agent_worker` lendo o livro-caixa de todas as organizações.
- **Revisão da F2-B (23/09): 2 altos**: extrato, livro-caixa, margem e estimativa sem paginação (o PostgREST corta em 1000 linhas e os totais saem menores); custo de modelo servido pela OpenRouter com prefixo de fabricante virou nulo (regressão da correção do D-050). Médios: avulso de toda a vida entrando na porcentagem do mês; teto da instalação conferido às 2h25 de São Paulo com o dia quase vazio; leitura do catálogo sem prazo no caminho do agente; débito pendente recalculado com o peso atual; organização Ilimitado com crédito avulso perdendo saldo e recebendo avisos; conferidor que cresce com o histórico; margem sem estimar custo nulo.
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

O servidor de desenvolvimento na porta 3300 sobreviveu ao build.

Fechamento da F3, 24/09/2026 02:25 a 03:50, na cópia separada, no commit 2f4bcc3:

| Portão | Resultado |
|---|---|
| typecheck, lint, lint:channels, build | verdes |
| test:db | 260 arquivos, 2.438 testes verdes |
| unitários | 13.817 verdes, 3 vermelhos: o de ambiente (`e2e-parte-4`, Redis) e 2 testes do autor quebrados por código nosso: `i18n-a-data-segue-o-idioma` (data com "pt-BR" fixo no título do aviso de lead recusado) e `motivo-de-parada-tem-frase` (motivo `plano_limite_atingido` da automação sem frase na aba Atividade). Os dois corrigidos logo depois e reconferidos verdes |

Depois do commit dos portões entrou só a prova de banco do aviso de tokens esgotados (5d0f31a, 75 testes verdes no arquivo) e as duas correções acima.

Fechamento da F2-B, 23/09/2026 19:20 a 21:05, na cópia separada, no commit 3898b63:

| Portão | Resultado |
|---|---|
| typecheck, lint, lint:channels, build | verdes |
| test:db | 2.407 verdes, 1 vermelho: `autonomia-preview-core` (do autor: o Testar agente fazia HTTP ao ler o catálogo de preços). Corrigido em d0a7230 (leitura pelo pool pg) e reconferido verde |
| unitários | 13.595 verdes, 9 vermelhos: o de ambiente (`e2e-parte-4`, Redis); 5 testes estruturais da carteira desatualizados (corrigidos em b5b42b7); 3 testes do autor quebrados por código nosso: `comanda-invariantes-no-schema` (variável `v_saldo`, a0f7d60), `random-id` e `tailwind-tokens` (aba do admin, bbe5607). Todos reconferidos verdes nos arquivos afetados |

A bateria inteira volta a rodar no fechamento da F3, cobrindo tudo junto.

Fechamento da F2, 23/09/2026 13:40 a 15:20, no commit 28d21a3, numa cópia separada (`~/projects/deskcommcrm-portoes`):

| Portão | Resultado |
|---|---|
| typecheck | limpo |
| lint | 0 erros |
| lint:channels | ok |
| unitários | 1307 arquivos, 13.379 testes verdes; 1 vermelho, o de ambiente conhecido (`e2e-parte-4`, espera pelo Redis) |
| test:db | 257 arquivos, 2.323 testes verdes |
| build | verde na segunda tentativa; a primeira caiu por falta de memória no passo de TypeScript (o WSL tem 7 GB e o build rodou junto de outro typecheck). Agora todo typecheck e build passam por `flock /tmp/deskcomm-typecheck.lock` com `NODE_OPTIONS=--max-old-space-size=6144` | A rota da aba Plano sem sessão manda para o login e volta para a aba depois.

## F4: revisão e auditoria (24/09/2026)

- Revisão (faixa 2ec5b4c..03093e0): 2 altos (relógio HTTP sem portão nos follow-ups; consumidor de `followup_turn` envia texto fixo e template sem portão), 6 médios (agente de voz sem portão; enrollment vira `followup_dead` com aviso falso; campanha e prospecção só represam e retomam com mensagem velha; data de vencimento um dia a mais nas telas; estorno repetido sem frase; textos dos avisos afirmam efeito que o modo `avisar` não tem), 5 baixos (avaliação com período vencido; ativa para ativa; idempotência do crédito de pacote; fuso da chave de dedup; MANIFEST e 0905 editada no lugar).
- Auditoria: sem crítico nem alto. Médios: `agent_worker` com UPDATE/DELETE em `billing_payments` e INSERT em `api_audit_log` (privilégio padrão do provisionamento; D-046 ainda aberto por essa role). Baixos: `agent_worker` apaga o catálogo de pacotes; reenvio de webhook de automação ignora o modo leitura; avaliação tira a conta do modo leitura sem data futura; autor e motivo de mudança de estado só no audit fora da transação.
- Correções em execução: banco (0908), produtores (relógio, consumidor do follow-up, encerrar enrollment com motivo, pausar campanha e prospecção, reenvio de webhook, agente de voz), datas e frases (telas e ações do admin), frase e botões de "conta suspensa".
- Perguntas novas (padrão adotado): **N27** envio pela API key e pelas ferramentas MCP continua na conta suspensa? Padrão: continua (é ação de pessoa, como responder à mão). **N28** chamadas de IA que não respondem ao cliente (descrição de mídia, montagem do quadro no onboarding, embeddings) continuam na conta suspensa? Padrão: continuam (servem a quem atende à mão). **N29** exigir MFA (aal2) em toda escrita de cobrança do admin? Padrão: não agora, porque trava o admin sem fator cadastrado; vai para o DEBITO.

## Ponto de retomada (24/09/2026, antes do limite de sessão)

Commits locais da F4 até aqui (sem push): a0bbc02 provas de banco, a7ad236 follow-ups, 03093e0 telas, b1e23d2 conta suspensa na recusa e nos botões (e plano F5 rascunho), 15e7ad3 datas e frases.

Em andamento quando a sessão parou (mudanças NÃO commitadas na árvore de trabalho; conferir com `git status` e `git diff --stat` antes de qualquer coisa):
1. **Correções de banco da F4** (só `supabase/migrations/*0908*`, bloco da 0908 na baseline, MANIFEST, `tests/unit/planos-assinatura-migration.test.ts`, `tests/invariants/planos-assinatura-estados.test.ts`, `tests/invariants/rls-completude-varredura.test.ts`): revogar tudo do `agent_worker` em `billing_payments`, `billing_token_pacotes` e escrita em `api_audit_log`; avaliação só com fim futuro (`billing_avaliacao_sem_data_futura`); ativa para ativa sem erro; tabela `billing_contract_eventos` gravada dentro das funções de estado, período, cancelar no fim e conferidor; idempotência de `fn_billing_creditar_pacote` antes de validar o pacote; dedup no fuso de São Paulo; textos dos avisos conforme o efeito real; a 0908 redefine os gatilhos e proteções editados na 0905; MANIFEST completo; reaplicar a 0908 no banco local. Terminar: `pnpm test:db` dos quatro arquivos de invariantes de planos, diff arquivo x bloco da baseline vazio, `comanda-invariantes-no-schema`.
2. **Correções dos produtores** (`lib/relogio/executar.ts`, `lib/agent-engine/agent/followup-turn.ts`, `lib/followup/enviar-texto-fixo.ts`, `lib/followup/encerrar-por-assinatura-suspensa.ts` novo, `app/api/v1/cron/followup-flow-worker/route.ts`, `lib/campanhas/rodada.ts`, `lib/prospecting/worker.ts`, `app/api/v1/automation-rules/runs/[runId]/resend/route.ts`, `workers/voice-agent/*`, testes novos): portão no relógio HTTP e no consumidor de `followup_turn`; enrollment encerrado com motivo `assinatura_suspensa` sem aviso `followup_dead`; campanha e prospecção PAUSADAS (voltar exige alguém retomar à mão); reenvio de webhook responde 402; agente de voz não abre sessão de IA na conta suspensa.
3. **Plano da F5 reescrito** com as 22 correções da revisão do plano (em `hiperbold/planos/fase-F5-tarefas.md`; perguntas N30 a N43).

Depois disso, na ordem: commit de cada frente (só os arquivos dela), revisão curta das correções, portões completos da F4 no worktree `~/projects/deskcommcrm-portoes` (`F:	emp6-09-23\planos-noite\portoes-f3.sh` com COMMIT novo), fechar F4 aqui, registrar no DEBITO: N29 (MFA aal2 nas escritas de cobrança), D-047 (TRUNCATE de authenticated em `agent_inbox_items`), N27/N28 (envio por API key/MCP e IA que não responde ao cliente continuam na suspensão). Então F5 pelas tarefas do plano revisado e F6 (site de vendas em `F:\github-projects\`).

## F4 fechada (24/09/2026)

Portões completos na cópia separada, commit de8ed83 (logs em `F:	emp6-09-24\planos\logs4b-*.log`):

| Portão | Resultado |
|---|---|
| install | ok |
| test:db | ok |
| typecheck | ok |
| lint | ok |
| lint:channels | ok |
| build | ok |
| unitários | 14.065 verdes; 1 vermelho de ambiente aceito (`e2e-parte-4-fala-com-os-servicos-do-runner`, Redis) |

F6: 3 modelos da página de vendas no canvas https://claude.ai/artifact/5dXN2LREhJNpTpmEm3QiE2 (A Clareza azul, B Editorial creme, C Produto em blocos), 3 seções claras para cada escura por pedido do Filipe; aguardando a escolha dele.

## F5: revisão e auditoria do núcleo (24/09/2026, noite)

Faixa 8ea9098..9afb775 (tarefas 1 a 6 e 10 a 18). Commits: ce99bf7, b04bfba, 8487304, 97e7be9, 73973bc, 5cbb69d, 0a750ec, c14e510, eeb261b, 7186080, 889aac0, 107538e, 3345adc, 9afb775.

- Auditoria: sem crítico. Altos: o processador não confirma por GET os eventos que não são pagamento (estorno, chargeback, vencimento, fim de assinatura morrem em `aguardando`/`erro`); o estorno confia no tipo do evento e não no status confirmado. Médios: retentativa com consulta falha faz POST (cobrança dobrada); cancelar pedido sem recurso registrado deixa assinatura viva; N39 não remove a assinatura do primeiro pagamento vencido e o primeiro pagamento sobrescreve assinatura viva; evento de produção gravado como sandbox; pagamento sandbox concede plano real. Baixos: id `conc:` sequestrável, rota do pedido para viewer, payload de outro app guardado, retomada de pedido de outra oferta, escrita direta do service_role em `billing_payments`/`billing_contracts` (vai para o DEBITO), gate do admin da plataforma na compra, tamanho do token, `pedido_marcar` reabrindo.
- Revisão: além dos mesmos, renovação fechada como `outro_app` quando a leitura falha, evento preso por `resultado` fora do CHECK, pedido estornado casando como primeiro pagamento, pedido sem fatura travado, alarme de 3 dias por organização, contrato voltando a `ativa` vencido, estados definitivos tratados como espera.
- Correções em execução: SQL (parte 7), TS do processador e conciliação, TS da compra e ações. Decisões novas: `billing_settings.asaas_sandbox_concede` (padrão falso: pagamento de sandbox não concede em produção); `billing_contracts.asaas_ambiente`; N39 passa a "remove sozinho" também no processador.

## F5 fechada

As 22 tarefas do plano `hiperbold/planos/fase-F5-tarefas.md` feitas entre os commits ce99bf7 e c6caa73. Revisão de código e auditoria de segurança do núcleo feitas, mais duas rodadas de revisão das correções, todos os achados corrigidos (partes 7 e 8 da migração 0909 e correções de TS). Nenhuma chamada real ao Asaas nem ao sandbox: tudo testado com dublês. A compra pelo cliente nasce desligada por duas chaves (`ASAAS_ENABLED` e `billing_settings.compra_pelo_cliente`); pagamento de ambiente sandbox não concede sem `billing_settings.asaas_sandbox_concede`.

Commits da faixa: ce99bf7, b04bfba, 8487304, 97e7be9, 73973bc, 5cbb69d, 0a750ec, c14e510, eeb261b, 7186080, 889aac0, 107538e, 3345adc, 9afb775, até c6caa73 (correções finais das partes 7 e 8 da 0909 e de TS).

| Portão | Resultado |
|---|---|
| portões completos em c6caa73 | verdes em 25/09/2026 às 03:11 (install, test:db, typecheck, lint, lint:channels, build ok; unitários 14.540 verdes; só o vermelho de ambiente do Redis em `e2e-parte-4-fala-com-os-servicos-do-runner`) |

## Perguntas em aberto para o Filipe (consolidado final)

- **N3.** Cache de saldo a 10% e conferências internas de IA (visão, embedding, transcrição) devem contar no gasto. Ainda sem resposta (D-057).
- **N8.** Preço anual dos planos. Padrão usado: nulo no catálogo (`price_yearly_cents`) até o Filipe responder.
- **N9.** Preço e tamanho do pacote de tokens. Padrão usado: sem preço até o Filipe definir; plano ou pacote sem preço não aparece para compra.
- **N19.** Carência de 7 dias antes da suspensão. Padrão usado: `grace_days` padrão de 7 dias por organização.
- **N20.** Mídia não para quando os tokens do mês zeram. Padrão usado: mídia continua, só a IA para.
- **N21.** Quando ligar o bloqueio, hoje em `avisar`. Sem padrão, decisão do Filipe.
- **A a D (seção 12 do plano mestre)**: suspensão, avaliação, contatos, onde digitar o cartão, tolerância, cancelamento, estorno. Ainda abertas.
- **N23.** Na conta suspensa, a pessoa ainda cria lead à mão? Padrão usado: sim, e o lead que chega sozinho também.
- **N24.** Quem registra o pagamento enquanto não há Asaas? Padrão usado: o admin da plataforma, na aba Plano.
- **N25.** O lembrete de agendamento ao cliente final continua na conta suspensa? Padrão usado: continua, porque atende o cliente do cliente.
- **N26.** Eventos de automação durante a suspensão se perdem? Padrão usado: sim, são consumidos e registrados como parados; reativar não dispara mensagem velha.
- **N27.** Envio pela API key e pelas ferramentas MCP continua na conta suspensa? Padrão usado: continua, por ser ação de pessoa.
- **N28.** Chamadas de IA que não respondem ao cliente (descrição de mídia, montagem do quadro, embeddings) continuam na conta suspensa? Padrão usado: continuam, porque servem a quem atende à mão.
- **N29.** Exigir MFA (aal2) em toda escrita de cobrança do admin? Padrão usado: não agora, porque travaria o admin sem fator cadastrado. Registrada como D-064.
- **N30.** Cartão pela fatura hospedada ou pelo Checkout Asaas? Padrão usado: fatura hospedada (`invoiceUrl`).
- **N31.** Estorno ou chargeback corta o acesso sozinho? Padrão usado: não, registra e avisa o admin, que decide.
- **N32.** Pacote de tokens estornado tira os tokens? Padrão usado: não sozinho, o admin ajusta.
- **N33.** Trocar de plano com assinatura Asaas ativa? Padrão usado: não pela tela nesta fase, o admin cancela e o cliente assina de novo, sem pró-rata.
- **N34.** O cliente cancela pela tela? Padrão usado: sim, vale no fim do período pago, sem estorno.
- **N35.** Quem é o pagador, e o CRM guarda o CPF/CNPJ? Padrão usado: o que o admin da organização informar na primeira compra; o documento fica só no Asaas.
- **N36.** Organização nova começa em avaliação? Padrão usado: não, nasce no Ilimitado e o onboarding não muda.
- **N37.** Suspender ou arquivar a organização cancela a assinatura no Asaas? Padrão usado: não sozinho, a tela avisa e apagar com assinatura ativa é recusado.
- **N38.** Por quanto tempo guardar o payload dos eventos? Padrão usado: 180 dias, depois só os metadados.
- **N39.** Assinatura que nunca recebeu o primeiro pagamento? Padrão usado: `PAYMENT_OVERDUE` libera pedido novo e o processador remove a assinatura sozinho no Asaas, sem cobrar a mais.
- **N40.** Notificações do Asaas ao pagador (e-mail e SMS de fatura)? Padrão usado: o padrão da conta; o CRM não manda `notificationDisabled`.
- **N41.** Quem compra e cancela na organização? Padrão usado: só o papel admin.
- **N42.** Assinar com período já pago? Padrão usado: `nextDueDate` nasce no dia seguinte a `current_period_end`; a troca de plano espera o primeiro pagamento.
- **N43.** Chargeback revertido devolve algo sozinho? Padrão usado: não, fica registrado com alarme e o admin decide.
- **F6, decisões para conferir** (`hiperbold/planos/fase-F6-tarefas.md`): a seção "03 · Funil e agenda" virou versão clara em vez de escura, para manter a regra de três seções claras para uma escura; essa seção usa o quadro de funil da opção A sem a agenda; a paleta da página inteira segue a base da opção B (creme, azul-marinho, azul, verde), inclusive nas seções vindas da opção A; falta menu recolhível para o celular.
- **F6, espaços reservados do site**: razão social, CNPJ, endereço, e-mail, WhatsApp, encarregado de dados, link de cadastro, preço do pacote de tokens, regra de fidelidade e data dos textos legais.
- **D-050.** Autorizar a leitura do banco de produção antes de publicar, para conferir o gasto de IA de cada organização contra o teto antes de ligar o catálogo de preço.
- **D-056.** Integrar o provedor GLM e cadastrar preço de GLM e DeepSeek em `ai_models`.
- **Quando publicar**: push na `main` dispara o deploy sozinho. Nada desta branch foi publicado.

## F7: saneamento técnico (25/09/2026)

Aberta com autorização do Filipe para seguir a noite toda sem perguntar. Plano em `hiperbold/planos/fase-F7-tarefas.md`, 5 lotes, tudo em commits locais na branch feat/planos-assinatura, sem push. Ficaram de fora, por dependerem de decisão do Filipe, produção ou terceiro: D-008, D-028, D-045, D-050, D-056, D-057, D-059, D-064, D-067, D-071.

Commits da fase: c1e736f, 0743180, 9044ae2, 9a85be9, 085e217, 0fe488c, ac261c4, ed1e77d.

Achados da auditoria da F7 e o que foi feito com cada um:

- **D-069** (`service_role` com escrita direta em `billing_payments` e `billing_contracts`): revogada; a carência passou para `fn_billing_estender_carencia` (0743180, ed1e77d, migração 0910).
- **D-070 e D-060** (funções com `p_org` qualquer): sem vetor de ataque, as únicas roles que as executam (`postgres`, `service_role`, `agent_worker`) já têm `bypassrls` (0743180, prova em `tests/invariants/planos-saneamento.test.ts`).
- **D-047** (TRUNCATE de `anon`/`authenticated`): revogado nas tabelas atuais e futuras, inclusive no privilégio padrão do `supabase_admin` (0743180, ed1e77d).
- **D-055** (gatilho de leads engolindo erro): falha passou a gravar em `billing_trigger_alarmes`, sem impedir o lead (0743180).
- **D-068** (prova de atualização da 0905 antiga para a 0908): prova manual em transação com rollback, roteiro em `F:\temp\2026-09-25\f7\prova-d068.sql` (0743180).
- **D-072** (segunda validação da URL da fatura): quando falha, remove o recurso no Asaas e marca o pedido (c1e736f).
- **D-065** (agente de voz sem teste do portão da conta suspensa): guarda de entrada e teste do portão feitos (c1e736f).
- **D-066** (pausa de prospecção sem auditoria): auditada como `prospecting.paused` (c1e736f).
- **D-035**: já resolvido desde ca31fb5 (22/09); só o registro estava aberto.
- **D-040**: já resolvido desde ca31fb5 (22/09); só o registro estava aberto.
- **D-043** (opção "exigir assinatura no webhook" sem chegar à rota de canal): a rota de canal passou a ler a opção no processo frio; vale para os servidores que assinam o corpo (a UAZAPI não assina e segue protegida pelo token da instância), e a tela passou a dizer isso (9044ae2, 0fe488c).
- **D-044** (`resolveSessionRef` sem ramo para `wacalls`): passou a cobrir `wacalls` (9a85be9).
- **D-048** (admin de suporte escrevendo em `organizations`): escrita passou a exigir escopo `full`; suspender, reativar organização e resolver incidente também passaram a exigir escopo `full` e MFA (085e217, 0fe488c).
- **D-061** (falso positivo): `fn_finish_channel_connection` já limpa `archived_at`, o gatilho de teto já disparava ali; a tentativa de correção foi revertida para o corpo da 0232 (ed1e77d).
- **D-063** (janela de contagem no baseline): o recálculo do contador na reaplicação da baseline nunca diminui um valor que um incremento concorrente elevou; a direção oposta continua coberta pelo conferidor diário (085e217).

Continuam abertos, com atualização: D-036 (IP da auditoria já passa pelo helper único, falta medir o cabeçalho real em produção antes de declarar `TRUSTED_PROXY_COUNT`), D-042 (dedup de evento da UAZAPI por processo, não cobre várias réplicas), D-062 (sem correção, análise na 0910 e no MANIFEST), D-073 (menu recolhível do site feito, subida do Astro em avaliação).

Novos: D-074 (`billing_trigger_alarmes` sem retenção nem tela), D-075 (checklist de publicação da branch, alta prioridade).

portões completos da F7 em ed1e77d: verdes em 25/09/2026 às 08:03 no commit 8c1d56b (a rodada em ed1e77d pegou dois testes de cerca, corrigidos em 8c1d56b: constraint de tipo reconstruída num bloco só e contagem de inserts sem a definição superada); install, test:db, typecheck, lint, lint:channels e build ok; unitários 14.633 verdes; só o vermelho de ambiente do Redis
