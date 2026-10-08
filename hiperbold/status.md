# Status do fork Hiperbold

Atualizado em 27/09/2026, noite. As seções abaixo desta são de 25/09 e continuam valendo para produção e para as fases F1 a F7.

## Publicado em 29/09/2026 (versão c3b02ec)

Autorizado pelo Filipe. crm.hiperbold.com.br roda a branch feat/planos-assinatura inteira: planos e assinatura (F1 a F8, cobrança pelo Asaas desligada, bloqueio em "avisar"), a junção do autor 1.57.0 e a página de vendas como raiz (/ e /precos, botão Entrar para /login, logo do Hiperbold CRM).

- Backup antes: `D:\Hiperboldackups\hiperbold-crm\hiperbold-crm-2026-09-29_1405.dump`.
- D-050 conferido só lendo: nenhuma chamada de IA sem custo no mês; uma organização, consumo zero.
- Banco: o baseline em transação única deu deadlock duas vezes com o app no ar (nada gravado); aplicado pelo `hiperbold/scripts/prod-schema.sh`, sem erro inesperado. 16 tabelas de billing e os 4 planos conferidos.
- Primeira publicação barrada pelo CI: o scheduler morria no boot por uma crase num comentário dentro da lista CRONS (corrigido em c3b02ec, com teste de cerca). A imagem do app montou no runner do GitHub sem problema de memória.
- Conferido no ar: health ok (supabase, redis), / com o logo, /precos 200, Entrar leva a /login, /app sem sessão manda ao login, sem erro de console.
- Pendente: o cadastro na produção está em `so_convite`, então "Assinar" leva a um cadastro fechado (decisão do Filipe); o commit 8b98d2c (documento) ainda não foi para a main.

## Ponto de retomada (28/09/2026, fase F8)

Nada foi publicado nem enviado ao GitHub. Plano da fase: `hiperbold/planos/fase-F8-tarefas.md`.

**Junção do autor 1.57.0 (D-028) dentro de `feat/planos-assinatura`:**
- `feat/planos-assinatura` avançou até o merge `6e13392` (junção `ba92828`, correções `6b4f42c` e `ca58118`, mais os documentos da F8). A worktree `~/projects/deskcommcrm-merge` e a branch `merge/upstream-2026-09-27` podem ser apagadas quando quiser; estão iguais a `feat`.
- Portões em `ca58118`: install, test:db (307 arquivos), typecheck, lint, lint:channels e build verdes. Unitários: 1.631 de 1.634 arquivos; o do Redis é de ambiente, e os dois do autor em D-077 só falham com o `.env.local` de desenvolvimento presente (sem ele, 11 de 11). Os unitários passam a rodar sem o `.env` de desenvolvimento, como no GitHub.
- Memória: o Filipe autorizou, e o WSL passou para 16 GB com 8 GB de swap em `F:\DevTools\WSL\swap.vhdx` (`.wslconfig`). O build passou com pico de 10,8 GB no WSL inteiro. O fork é público, então o runner do GitHub tem 16 GB; risco que sobra está em D-076 (heap de 4096 MB no `Dockerfile`).
- Banco local atualizado pelo `baseline.sql` novo numa transação única (`psql -1 -v ON_ERROR_STOP=1`), sem erro e sem perder dado. Backup de antes: `F:\temp\2026-09-28\crm\banco-local-antes-da-juncao.dump` (formato custom do pg_dump).
- CRM local rodando a versão juntada em localhost:3300, saudável.

**Telas de plano conferidas** (prints em `F:\temp\2026-09-28\crm-prints\`): 8 telas, todas 200, sem erro de console e sem rolagem lateral, em 390 e 1440 px. Detalhes baixos em D-078. A bolinha com coqueiro nos prints é o ReactQueryDevtools, só em desenvolvimento.

**Site de vendas** (`F:\github-projects\hipercrm-site`, master): `bd94ce6` (busca do Google sem domínio inventado, 404, og.png, botão do cabeçalho) e `5531869` (Astro 7.3.5, `npm audit` zerado, HTML e prints iguais aos da versão 5). `ec9727b` (acessibilidade: axe-core zerado nas 5 páginas em 390 e 1440 px; menu na ordem do Tab; botão "Assinar" dos cartões claros de /precos estava claro sobre branco e foi corrigido). A frente 1 da F8 está fechada.

**Próximo passo quando o Filipe responder:** as perguntas de `hiperbold/planos/progresso-da-noite.md`, na ordem de prioridade que ele recebeu. Publicar exige o checklist de D-075 e a conferência de D-076.

## Onde está tudo agora

- **Produção** (`crm.hiperbold.com.br`): versão `02e4797`, publicada às 21h37, saudável. Traz a release 1.42.0 do autor original, as correções de segurança do webhook UAZAPI e a trava de dado de cliente nas conexões MCP.
- **`main` do fork**: `7f35a92` (a versão de produção mais o registro da publicação).
- **Branch `fix/debitos-pequenos-2026-09-22`**: quatro dívidas fechadas e os documentos do dia, commitados, **sem push e sem ir para produção**. Push no `main` dispara deploy sozinho, então essa branch espera decisão do Filipe.
- Backup do banco de antes da publicação: `hiperbold-crm-2026-09-22_2120.dump`, em `D:\Hiperbold\backups\hiperbold-crm`.

## O que foi publicado hoje

A junção com o autor (D-028), 2298 arquivos, 18 conflitos resolvidos. Junto foram:

- **Quatro correções de segurança no webhook da UAZAPI**: o token da instância era gravado em claro no log de webhooks e qualquer membro da organização lia; o token virou obrigatório no evento de mensagem; o payload passou a ser conferido contra a sessão; a leitura do log passou a exigir gerente.
- **A trava de dado de cliente nas conexões MCP (D-037)**: telefone, e-mail, CPF, CNPJ e endereço de WhatsApp não saem mais nos argumentos que vão para servidor de terceiro. Campo de código (`sku`, `ean`, `placa`) fica fora da regra de dígitos, senão código de barras seria confundido com telefone.
- **Uma regressão grave, pega pela revisão antes de publicar**: a conferência nova comparava o NOME da instância contra o ID dela. Como os dois quase nunca são iguais, todo evento legítimo viraria "evento de outra conta", com resposta 200 que a UAZAPI não reentrega: o canal pararia de receber mensagem em silêncio.

## O que está commitado e ainda não publicado

Na branch `fix/debitos-pequenos-2026-09-22`, commit `ca31fb5`:

| Dívida | O que mudou |
|---|---|
| D-035 | Mensagem de erro do Postgres não sai mais na resposta HTTP de rota protegida |
| D-038 | Hash dos argumentos na auditoria deixou de ser reversível por força bruta |
| D-039 | A Central passa a avisar do segundo problema em vez de ficar muda |
| D-040 | Ferramenta MCP com nome repetido é marcada na leitura, e a aprovação volta a funcionar |

Portões dessa branch: typecheck limpo, lint com 0 erros, `lint:channels` ok, unitários com **13.195 testes verdes**. O único vermelho é `e2e-parte-4-fala-com-os-servicos-do-runner`, que espera uma porta que no WSL não recusa conexão na hora. É ambiente, não código, e o caso leva 67 minutos para desistir.

## O teste de ponta a ponta do CI está vermelho, e importa

Comparação entre as duas versões de produção:

| Versão | Casos vermelhos |
|---|---|
| `9da397d` (antes) | 3 |
| `02e4797` (agora) | 11 |

Os 8 novos vieram da junção, e a maioria é colisão com escolhas nossas, não defeito de produto:

1. **Três** conferem se a fonte da interface é a Atkinson. Trocamos por Inter (mantendo o nome da variável, que outro teste dele exige). O que eles querem provar, "o tema carregou", continua verdade.
2. **Dois** criam número de WhatsApp pelo caminho do WAHA, que saiu da instalação em 16/09: o canal existe no banco e não aparece na tela.
3. **Um** é conectar WhatsApp por código de pareamento, feature do WAHA, que não existe mais aqui.
4. **Um é real e é nosso**: `vps-fresh-onboarding` J1.7. Numa instalação nova, o passo "Treinar" cria o atendente, não consegue publicar porque ainda não há número conectado, e **avança sem dizer que ficou como rascunho**. Nos outros motivos (sem chave, sem modelo) ele para e explica. Isso virou o caminho normal quando o passo do telefone deixou de criar canal por QR. A tela seguinte diz "seu funcionário ainda não está no ar", então não é mudo, mas é fraco.
5. Os outros dois (`degradacao-silenciosa`, `logo-moldura-no-tema-escuro`) já eram vermelhos antes.

**Por que isso importa**: CI permanentemente vermelho é CI que ninguém lê, e o próximo defeito de verdade entra sem alarme.

## Planos e assinatura: F1 a F5 fechadas, F6 em revisão visual, nada em produção

Branch `feat/planos-assinatura`, criada de `fix/debitos-pequenos-2026-09-22` (commit e5231de). Tudo em commit local, sem push e sem nada em produção. Migrações novas: 0904 (planos), 0905 (uso e trava), 0906 (carteira de tokens), 0907 (bloqueio), 0908 (estados da assinatura, F4), 0909 (cobrança pelo Asaas, F5, com as partes 1 a 8). O banco local de desenvolvimento está no modo `avisar`.

- F1, F2, F2-B, F3: fechadas.
- F4 (estados da assinatura, pagamento registrado pelo admin, modo leitura, catálogo de pacotes, D-046): fechada em 24/09/2026 às 16:51. Portões completos verdes no commit de8ed83 (só o vermelho de ambiente do Redis).
- F5 (cobrança pelo Asaas): as 22 tarefas do plano `hiperbold/planos/fase-F5-tarefas.md` feitas entre os commits ce99bf7 e c6caa73. Revisão de código e auditoria de segurança do núcleo feitas, mais duas rodadas de revisão das correções, todos os achados corrigidos. Portões completos rodando no commit c6caa73. Nenhuma chamada real ao Asaas nem ao sandbox: tudo testado com dublês. A compra pelo cliente nasce desligada por duas chaves (`ASAAS_ENABLED` e `billing_settings.compra_pelo_cliente`); pagamento de ambiente sandbox não concede sem `billing_settings.asaas_sandbox_concede`.
- F6 (site de vendas): projeto separado `F:\github-projects\hipercrm-site` (Astro, estático, sem CMS), commit local 2ba4c37, sem remoto. Homepage na composição escolhida pelo Filipe, mais `/precos`, `/termos` e `/privacidade` em rascunho para revisão jurídica. Build ok, revisão visual pelo Filipe em `http://localhost:4321/`.

**O que depende do Filipe**: ativar o Asaas de verdade (conta, chaves de sandbox e produção, webhook, homologação no sandbox, preços N8 e N9, `for_sale` plano a plano); as decisões de produto ainda abertas (ver `hiperbold/planos/progresso-da-noite.md`); revisar a homepage e as decisões da F6; e autorizar a leitura do banco de produção antes de publicar (D-050). Detalhe completo em `hiperbold/HANDOFF.md` e `hiperbold/DEBITO.md`.

O que o módulo faz hoje:

- Catálogo com os planos Pro (R$ 199), Max (R$ 399) e Scale (R$ 599), mais o Ilimitado. Todas as organizações estão no Ilimitado. Os três planos têm 3 milhões de tokens de IA por mês (decisão do Filipe em 23/09).
- O admin da plataforma troca o plano de uma organização e dá ajuste de limite na aba "Plano" do painel.
- O CRM conta o uso de cada item (funis, etapas por funil, leads abertos, membros, conexões, integrações webhook) e avisa na Central quando passa do teto.
- Carteira de tokens de IA: toda chamada paga pela chave da Hiperbold debita da carteira da organização (plano, depois adicional, depois pacote avulso), com livro-caixa que ninguém consegue alterar; avisos a 50, 80 e 100% do mês; o admin credita pacote, contrata adicional e faz ajuste; painel de margem (receita em reais contra custo em dólares, sem converter câmbio); o cliente vê saldo, estimativa de respostas e extrato na tela "Plano e uso".
- Bloqueio: pronto e desligado. Quando o admin ligar na tela da instalação (`/admin/sistema`), cada organização ganha carência (padrão 7 dias) e, vencida a carência, criar acima do teto é recusado com mensagem clara, os botões ficam desabilitados com o motivo e a IA para quando os tokens do mês acabam (a conversa passa para humano). O chat ao vivo nunca para; um lead recusado não derruba a mensagem.
- Chave de emergência: voltar o modo para `avisar` na mesma tela solta todas as travas do banco na hora. A variável `PLANOS_BLOQUEIO` do servidor só alcança a IA.
- O custo das chamadas de IA passou a vir do catálogo de preços `ai_models` (antes só a Anthropic tinha preço; D-050). Isso faz o orçamento de IA existente passar a contar os modelos baratos (GPT Luna etc.) quando publicado.

O que já estava decidido desde 22/09:

- **O plano é da organização**, não da instalação. Um lugar só decide se algo pode ser criado, com trava no banco por baixo.
- **Cliente que cai de plano nunca perde dado**: o que existe continua, o que trava é criar mais.
- **A chave de IA é da Hiperbold** e o consumo é vendido: cada plano inclui crédito, e o cliente pode comprar pacote adicional. O cliente não traz chave própria.
- **Gateway: Asaas**, escolhido em 22/09/2026, com contrato de integração comum aos três produtos da Hiperbold em `F:\github-projects\hiper-track\docs\manual-api-asaas-saas.md`. Esse manual manda em nomes de tabela, eventos e prefixo de referência (o CRM é `HC:`).

Achados de segurança desta rodada, todos corrigidos e provados no banco local: qualquer membro escrevia em `llm_calls` e podia devolver os próprios tokens ou travar a IA da organização; o admin da organização furava o teto de membros gravando `invited_at`; um comando com vários leads passava por cima do teto; trocar o e-mail de um convite pendente reciclava a vaga; `organization_id` podia ser trocado entre organizações (D-054, resolvido); a função `fn_billing_e_servidor` devolvia NULL para a sessão comum e desarmava duas travas (achado pelos testes).

**O que depende do Filipe antes de publicar** e **o que fazer em seguida**: ver `hiperbold/HANDOFF.md`.

**O aviso que vale repetir**: colocar campo de cartão dentro do CRM põe a Hiperbold no escopo de PCI DSS, e a certificação do Asaas não cobre a gente. A recomendação é usar a página hospedada do Asaas para cartão e manter o Pix com QR dentro do app.

## Para retomar

Ver `hiperbold/HANDOFF.md`, que tem a ordem sugerida e o contexto de cada item.

## Ambiente local

O WSL desliga junto com a máquina. Se o CRM local não abrir, o banco do Supabase costuma voltar sem rede Docker: `docker network connect supabase_network_deskcomm-crm supabase_db_deskcomm-crm`, esperar, e `docker restart supabase_rest_deskcomm-crm`. O servidor de desenvolvimento (`PORT=3300 pnpm dev`) precisa de uma sessão WSL aberta o tempo todo. O typecheck precisa de `NODE_OPTIONS=--max-old-space-size=6144`.

O `gh` no repositório resolve para o remoto do AUTOR: sempre passar `-R hiperbold/DeskcommCRM`, senão você lê os fluxos dele achando que são nossos.

## Fluxo de teste no n8n

"TESTE CRM - MCP imóveis (Claude, 22/09/2026)", id `GeotyR9EyKzuJpF9`. **Desligado** a pedido do Filipe. Nenhum outro fluxo foi tocado.

## Histórico

O status detalhado das 14 tarefas das conexões MCP ficou em `hiperbold/status-anterior-mcp.md`.
