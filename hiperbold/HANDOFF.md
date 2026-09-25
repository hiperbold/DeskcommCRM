# Handoff do fork Hiperbold

Escrito em 22/09/2026. Para quem retomar o trabalho, seja o Filipe ou outra sessão.

Leia antes: `hiperbold/status.md` (onde as coisas estão) e `hiperbold/DEBITO.md` (o que está pendente). Este arquivo diz o que fazer primeiro e por quê.

---

## 1. O que depende do Filipe, e trava o resto

### 1.1 Conferir a produção na tela (pendência antiga, de 22/09, ainda aberta)

A publicação de 22/09 foi um salto de 2298 arquivos e **não houve conferência humana antes**. Fica pendente: abrir `crm.hiperbold.com.br` e olhar Conexões, IA, funil e conversas.

Se algo estiver errado, o caminho de volta é publicar de novo o commit `9da397d`, e o backup do banco de antes está em `D:\Hiperbold\backups\hiperbold-crm\hiperbold-crm-2026-09-22_2120.dump`.

### 1.2 Decidir o que fazer com a branch `fix/debitos-pequenos-2026-09-22`

Ela tem quatro correções prontas e conferidas, sem push, e é a base da branch nova dos planos (`feat/planos-assinatura`, criada dela no commit e5231de). Publicar é: `git switch main`, `git merge --ff-only fix/debitos-pequenos-2026-09-22`, `git push origin main`. O push dispara imagem e deploy sozinho. Nenhuma dessas quatro mexe em banco, então não precisa de `prod-schema.sh`.

### 1.3 Conferir o gasto de IA em produção antes de publicar os planos (D-050)

A publicação da branch `feat/planos-assinatura` liga o resolvedor de preço que passa a enxergar modelos fora da Anthropic (GPT Luna, DeepSeek etc.). Antes de publicar, com autorização do Filipe para ler o banco de produção: conferir quanto cada organização já gastou no mês por esses modelos pelo catálogo `ai_models`, contra o `monthly_limit_cents` de `ai_budgets` dela, para nenhuma organização ter a IA parada de surpresa no meio do mês.

### 1.4 Republicar a imagem do scheduler (D-059)

Os dois conferidores diários novos (contadores de plano e carteira de tokens) só existem no código do `docker/scheduler/entrypoint.sh`. Sem publicar a imagem `deskcomm-scheduler` de novo, eles não rodam sozinhos em produção.

### 1.5 Decidir quando ligar o bloqueio (N21) e revisar as perguntas pendentes

O bloqueio (F3) está pronto e desligado, modo `avisar`. Ligar é ato do admin da plataforma pela tela da instalação (`/admin/sistema`), com carência (padrão 7 dias) por organização. Padrão hoje: não liga, fica em `avisar` até o Filipe decidir. As perguntas pendentes (algumas com padrão já aplicado, a confirmar com ele) estão no relatório final da fase e em `hiperbold/planos/progresso-da-noite.md`.

### 1.6 Responder as decisões de produto que faltam do plano de assinatura (D-045)

Estão em `hiperbold/planos/2026-09-22-planos-e-assinatura.md`, seção 12, agrupadas por assunto e com a fase que cada uma trava. A maioria tem padrão declarado para o caso de não haver resposta. As que travam de verdade, porque decidem margem e trabalho de cobrança:

1. Qual a remarcação sobre o custo (custo em dólar, preço em real, com folga de câmbio)
2. Onde o cliente digita o cartão: página hospedada do Asaas, ou dentro do CRM assumindo o escopo de PCI DSS

O crédito de IA por plano já foi decidido (3 milhões de tokens nos três planos, 23/09). Nenhuma dessas decisões trava as fases F1 a F3, já implementadas; elas travam a F4 (planos à venda) em diante.

### 1.7 Publicar a branch `feat/planos-assinatura`, quando o resto acima estiver resolvido

A publicação é: `git switch main`, junção da branch, `git push origin main` (dispara imagem e deploy), mais `prod-schema.sh` porque há migração de banco (0904 a 0907). Nada disso foi feito.

---

## 2. O que fazer em seguida, em ordem

### 2.1 Terminar a bateria completa da F3 e ligar o bloqueio quando o Filipe decidir

A bateria de portões da F3 está rodando no commit `2f4bcc3`, numa cópia separada (worktree). O resultado final vai para `hiperbold/planos/progresso-da-noite.md`. Depois dela, e da decisão da seção 1.5, seguem as fases F4 (planos à venda), F5 (Asaas) e F6 (site de vendas, pedido do Filipe em 23/09).

### 2.2 Alinhar o teste de ponta a ponta com as escolhas do fork

Ainda é o item de maior retorno, e continua pendente desde 22/09. Hoje são 11 casos vermelhos no CI, e enquanto estiverem assim ninguém vê o próximo defeito de verdade. O detalhe de cada um está no `status.md`. O trabalho:

- **Fonte**: três specs do autor exigem Atkinson no `font-family` calculado; o fork usa Inter mantendo o nome da variável. O que eles provam é "o tema carregou", então a asserção deve aceitar a fonte do fork.
- **Canal**: duas specs criam canal WAHA e esperam vê-lo na tela de Conexões. Devem criar canal UAZAPI, que é o caminho real daqui.
- **Pareamento por código**: feature do WAHA, que saiu da instalação. A spec precisa ser aposentada com a razão escrita, não apagada em silêncio.
- **D-041** (`pre-go-live-whatsapp`) morre junto com o item "canal" acima.

### 2.3 O buraco real do onboarding (ainda sem decisão do Filipe)

Numa instalação nova, o passo "Treinar" cria o atendente, não publica porque ainda não há número de WhatsApp, e **avança sem avisar que ficou rascunho**. Nos outros motivos (sem chave de IA, sem modelo) o passo para e explica, com um botão "Continuar sem publicar".

Onde está: `app/actions/onboarding/createDefaultAgent.ts` trata `reason` igual a `failed`, `sem_chave` e `no_model`; o caso "ainda não há canal" cai no `redirect` final. A tela é `app/onboarding/setup-ai/_form.tsx`.

Isso virou o caminho normal quando o passo do telefone deixou de criar canal por QR (commit `3ee4c4ec`). A decisão de produto é do Filipe: parar e explicar, ou seguir com um aviso mais claro. Não implemente sem essa decisão.

### 2.4 Dívidas pequenas que sobraram

| Dívida | Resumo | Tamanho |
|---|---|---|
| D-036 | IP do audit e do limite de tentativas vem do primeiro salto do `X-Forwarded-For`, que o cliente forja. Atrás do nosso proxy, o valor bom é o ÚLTIMO. São 6 rotas com audit (5 nossas) mais `lib/auth/rate-limit.ts` e `lib/http/ip-do-cliente.ts`. Atenção: o limite conta por IP **e** por e-mail, então o balde do e-mail continua valendo; não é portão aberto | pequeno |
| D-042 | Evento de webhook da UAZAPI pode ser reenviado: não há nonce nem janela de tempo | médio |
| D-043 | "Exigir assinatura no webhook" não chega à rota de canal. Com o WAHA fora, a opção hoje não faz nada nesta instalação. Ou passa a valer na rota de canal, ou a tela precisa dizer a que se aplica | médio |
| D-044 | `resolveSessionRef` não tem ramo para o provider `wacalls`, que veio na junção. Nada nosso depende disso hoje | pequeno |

Débitos novos desta rodada dos planos (detalhe em `hiperbold/DEBITO.md`, não repetido aqui): D-050 a D-063, com destaque para D-050 (conferir produção antes de publicar, seção 1.3), D-056 (GLM não existe no CRM; DeepSeek existe sem preço no catálogo), D-057 (conferências antigas de IA não gravam a origem da chave e não debitam), D-059 (republicar o scheduler, seção 1.4) e D-062 (deadlock possível com o bloqueio ligado).

---

## 3. Armadilhas que já custaram tempo hoje

1. **`session_ref` da UAZAPI é o `instance.id` opaco, e o `instanceName` do webhook é o NOME do painel.** Comparar um com o outro descarta todo evento legítimo, com resposta 200 que a UAZAPI não reentrega: o canal para em silêncio. Já aconteceu uma vez, e o teste que acompanhava a versão errada passava porque a ficha usava o mesmo texto nos dois campos.
2. **Toda atualização do autor precisa conferir se a UAZAPI sobreviveu.** A migração 0368 dele recriou a restrição de provider sem ela.
3. **O `gh` resolve para o repositório do autor.** Sempre `-R hiperbold/DeskcommCRM`.
4. **Não edite arquivo do projeto enquanto a bateria de testes roda.** O vitest lê o arquivo quando chega nele, e o resultado vira mentira. Isso obrigou a refazer uma bateria de uma hora hoje.
5. **Redirecionamento de saída para pasta que não existe** faz o comando morrer devolvendo sucesso. Uma suíte "verde" assim não rodou. Criar a pasta antes.
6. **Heredoc e crase passando pelo `wsl` chegam mangleados** e o conteúdo vira comando executado. Escreva arquivo com a ferramenta de escrita, ou grave um `.sh` em `F:\temp` e rode com bash.
7. **O typecheck estoura a memória** sem `NODE_OPTIONS=--max-old-space-size=6144`.
8. **Confira o que está preparado para commit antes de commitar** (`git diff --cached --stat`). Em 23/09/2026 um executor em paralelo preparou arquivos com `git add` só para contar travessões, e um commit que devia ter só o banco levou junto código da aplicação ainda sem conferência. Desfeito com `git reset --soft`, sem perda, porque nada tinha subido.
9. **Executor escreve travessão mesmo com a regra no briefing.** Aconteceu em quatro tarefas seguidas na F1. Conte na revisão de toda tarefa, só nas linhas acrescentadas (`git diff | grep '^+'`): os arquivos do autor têm centenas, e eles não são nossos.
10. **Regra de estilo não vai na lista de proibições do briefing.** Escrever "comentários em português, explicando o porquê" dentro da seção "Proibido" fez um executor ler como proibição e escrever os comentários em inglês. Regra de estilo vai numa seção "Estilo", afirmativa.
11. **O WSL tem 7 GB: typecheck e build usam até 6 GB cada.** Sempre `flock /tmp/deskcomm-typecheck.lock env NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck` (e o mesmo para `pnpm build`), senão dois ao mesmo tempo estouram a memória.
12. **A bateria completa roda numa cópia separada** (`git worktree` em `~/projects/deskcommcrm-portoes`, script em `F:\temp\...\portoes-f3.sh`), para o trabalho seguir no repositório principal sem editar arquivo que a bateria lê.
13. **O baseline aplica os blocos na ordem do arquivo, não pela numeração.** `create trigger ... of <coluna>` ou função que referencia coluna criada por bloco posterior quebra o install do zero. E o invariante do autor `comanda-invariantes-no-schema` varre do bloco financeiro até o FIM do baseline (onde ficam os blocos do fork): nenhuma declaração com `saldo`, `balance` no nome.
14. **Lógica de três valores no SQL**: `not <expressão que dá NULL>` num `if` vira falso em silêncio; funções booleanas de segurança sempre com `coalesce(..., false)`.
15. **Dentro de função `security definer`, `current_user` é o dono.** Para saber quem faz a requisição, usar `current_setting('role', true)` (é o que `fn_billing_e_servidor` faz).
16. **Gatilhos BEFORE da mesma tabela disparam em ordem alfabética do nome.** O gatilho de bloqueio de leads foi nomeado para rodar depois do gatilho do autor que fecha o lead.
17. **Gatilho AFTER ROW só dispara no fim do comando**: contador somado no AFTER não segura comando de várias linhas; e mover a soma para o BEFORE troca a ordem das travas (risco de deadlock, D-062).
18. **O Testar agente (preview) não pode fazer nenhum HTTP** (invariante do autor `autonomia-preview-core`): leitura nova no caminho do agente vai pelo pool pg, nunca pelo cliente Supabase.
19. **Os agentes executores batem no limite de passos com frequência**: o briefing deve pedir a ordem de prioridade e "se não couber, diga o que ficou de fora"; relatório de subagente nunca é prova, e a bateria completa pegou regressões que os testes dos arquivos afetados não pegavam.
20. **`git diff | grep "$T"` com a variável dentro de `bash -lc '...'` pelo WSL chega vazia e casa tudo**: contar travessão sempre por um `.sh` gravado em arquivo.
21. **O banco concede EXECUTE a `service_role` e `agent_worker` (e privilégios de tabela ao `agent_worker`) por privilégio padrão em todo objeto novo.** Função interna precisa de `revoke` explícito inclusive do `service_role`, e tabela nova precisa de `revoke` do `agent_worker`.
22. **Guardas do autor leem texto, não SQL nem TS de verdade.** Comentário com "create index" ou "drop index" na migração derruba `baseline-nao-constroi-o-que-derruba`; qualquer `resourceId:` em código conta como auditoria em `audit-resource-id-e-uuid` (usar outro nome para campos que não são auditoria); host de terceiro novo precisa entrar em `HOSTS_DECLARADOS` de `tests/unit/branding.test.ts`; tela nova precisa de porta em `lib/navigation/catalogo.ts` ou na allowlist de `tests/unit/navegacao-completude.test.ts`; copiar para a área de transferência só por `copyToClipboard` de `lib/clipboard`.
23. **Última definição vale.** Redefinir função numa parte posterior da mesma migração exige ajustar testes que ancoram na primeira ocorrência (`tests/unit/sonda-do-baseline-ancora-na-ultima-definicao.test.ts`).
24. **Vários agentes no mesmo diretório WSL: nunca `git stash`** (some com o trabalho do outro). `pnpm test:db` só com o contêiner `deskcomm-test-db` livre. Portões completos em cópia separada (`~/projects/deskcommcrm-portoes`), com o script de `F:\temp\2026-09-24\planos\portoes-f5c.sh` como molde. A máquina WSL tem 7 GB e travou uma vez com portões e agentes juntos.
25. **Dublê de teste que aceita tudo esconde defeito.** Os dublês do banco nos testes do Asaas precisam imitar as recusas reais das funções: a revisão pegou um teste verde para um fluxo que o banco real recusava.

---

## 4. Estado dos portões, para comparação futura

Medido em 22/09/2026 na branch `fix/debitos-pequenos-2026-09-22`:

- typecheck: limpo
- lint: 0 erros, 420 avisos (todos anteriores)
- lint:channels: ok, 60 arquivos de dívida conhecida
- unitários: 1294 arquivos, 13.195 testes verdes, 1 vermelho de ambiente (`e2e-parte-4`, a espera pelo Redis, 67 minutos até desistir)
- test:db: 2193 testes verdes, 9 minutos (medido na branch da junção)
- build: verde, 23 segundos de compilação

Medição mais recente, fechamento da F2-B em 23/09/2026 (19h20 às 21h05), na cópia separada, commit `3898b63`:

- typecheck, lint, lint:channels, build: verdes
- test:db: 2.407 verdes, 1 vermelho (`autonomia-preview-core`, do autor: o Testar agente fazia HTTP ao ler o catálogo de preços), corrigido em `d0a7230` e reconferido verde
- unitários: 13.595 verdes, 9 vermelhos: o de ambiente conhecido (`e2e-parte-4`, Redis); 5 testes estruturais da carteira desatualizados, corrigidos em `b5b42b7`; 3 testes do autor quebrados por código nosso, corrigidos e reconferidos verdes

A bateria completa da F3 está rodando agora no commit `2f4bcc3`, numa cópia separada. O resultado, quando terminar, vai para `hiperbold/planos/progresso-da-noite.md`.

Se algum desses números piorar muito sem explicação, é sinal antes de ser sintoma.
