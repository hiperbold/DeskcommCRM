# Status do fork Hiperbold

Atualizado em 22/09/2026, fim do dia.

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

## Planos e assinatura: planejado, nada implementado

Pedido do Filipe em 22/09/2026: transformar o CRM em produto com planos, começando com tudo liberado e já com as regras de limite prontas. O plano está em `hiperbold/planos/2026-09-22-planos-e-assinatura.md`. **Nenhuma linha de código foi escrita, por instrução dele.**

O que já está decidido:

- **O plano é da organização**, não da instalação. Um lugar só decide se algo pode ser criado, com trava no banco por baixo.
- **Cliente que cai de plano nunca perde dado**: o que existe continua, o que trava é criar mais.
- **A chave de IA é da Hiperbold** e o consumo é vendido: cada plano inclui crédito, e o cliente pode comprar pacote adicional. O cliente não traz chave própria.
- **Gateway: Asaas**, escolhido em 22/09/2026, com contrato de integração comum aos três produtos da Hiperbold em `F:\github-projects\hiper-track\docs\manual-api-asaas-saas.md`. Esse manual manda em nomes de tabela, eventos e prefixo de referência (o CRM é `HC:`).

O que falta para começar: **18 decisões de produto do Filipe**, na seção 12 do plano. Elas não travam a primeira fase, e 12 delas têm um padrão meu declarado caso ele não responda. As que travam de verdade são as três que decidem margem e trabalho de cobrança: quanto de crédito entra em cada plano, qual a remarcação sobre o custo, e onde o cliente digita o cartão.

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
