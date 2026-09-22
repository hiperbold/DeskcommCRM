# Status: conexões MCP para os agentes

Atualizado em 21/09/2026. **Implementação em andamento (retomada em 21/09).** Nada roda em segundo plano, nada foi publicado, nada foi enviado ao GitHub.

## Onde está

- Branch local: `feat/conexoes-mcp` (no repositório do WSL, `~/projects/deskcommcrm`). Sem push.
- Plano: `hiperbold/planos/2026-09-19-conexoes-mcp.md` (14 tarefas, aprovado em duas revisões).
- Débito: D-033 em `hiperbold/DEBITO.md`.
- Produção (`crm.hiperbold.com.br`): intocada, segue na versão `3ee4c4e`.

## Tarefas

| # | Tarefa | Situação | Commit |
|---|---|---|---|
| 0 | Preparar o branch | ✅ feita | `087e2cdf` |
| 1 | Tabela `ai_mcp_connections` (migration 0901) | ✅ feita e aprovada nas duas revisões, com os ajustes pedidos (teste de coluna cifrada, apelido imutável no banco) | `ae46f6a0`, `33398826` |
| 2 | Ids das ferramentas externas (`mcp_<apelido>__<nome>`) | ✅ feita e aprovada nas duas revisões | `581421ad` |
| 3 | Id externo passa na validação e conta no teto de 25 | ✅ feita | `2ca5606c` |
| 4 | Fetch seguro (só https, sem IP interno, sem redirecionamento, teto de 2 MiB) | ✅ feita, auditada e com ajustes | ver commit das Tarefas 4-5 |
| 5 | Cliente MCP (prazo de 15 s, corte de 8000 caracteres, sessão fechada em toda falha) | ✅ feita, auditada e com ajustes | ver commit das Tarefas 4-5 |
| 6 | Cadastro das conexões (só grava depois de conectar, chave cifrada, URL mascarada na tela) | ✅ feita, auditada e com ajustes | ver commit da Tarefa 6 |
| 7 | API (só admin cadastra e mexe; gerente vê as ferramentas; limite de 10 tentativas a cada 10 min) | ✅ feita, auditada e com ajustes | ver commit da Tarefa 7 |
| 8 | Publicar/duplicar/reverter aceitam ferramenta externa (e recusam se a conexão foi desligada) | ✅ feita | ver commit da Tarefa 8 |
| 9 | Ferramentas externas no turno do agente (só roda o que o admin aprovou; Testar só roda consulta; falha externa não derruba o turno; escrita auditada) | ✅ feita, revisada duas vezes e auditada | ver commit da Tarefa 9 |
| 10 | Tela de capacidades | ⏸️ não iniciada | |
| 11 | Tela "Conexões MCP" | ⏸️ não iniciada | |
| 12 | Portões completos | ⏸️ não iniciada | |
| 13 | Validação com 3 servidores MCP reais (com o Filipe) | ⏸️ não iniciada | |
| 14 | Fechar (changelog, README, débito) | ⏸️ não iniciada | |

## O que já mudou no banco LOCAL

A migration 0901 foi aplicada no Supabase local (container `supabase_db_deskcomm-crm`): existe a tabela `ai_mcp_connections`, vazia. Não afeta nada que já funcionava. Produção não tem essa tabela.

## Provas das tarefas feitas

- Suíte de banco (`pnpm test:db`): 207 arquivos, 1641 testes verdes, com instalação e atualização do baseline.
- Testes unitários novos: `mcp-externo-migration` e `mcp-externo-ids`, verdes. Typecheck limpo, lint sem erros.

## Para retomar



Pedir "retomar as conexões MCP a partir da Tarefa 3". O texto de cada tarefa está no plano; os arquivos de trabalho dos subagentes ficaram em `F:\temp\2026-09-19\mcp-tarefas\` (temporários, podem ser regerados do plano).

Observação para a retomada: o revisor da Tarefa 2 notou que o teste de ids não cobre nome remoto com `__` no meio nem o limite exato de 64 caracteres. O código trata os dois casos certo; vale acrescentar os casos se `ids.ts` for mexido de novo.

## Voltar ao main

O `main` local está em `50a97bcd`, igual ao GitHub. Para voltar a ele sem perder nada: `git switch main` (o branch `feat/conexoes-mcp` continua guardado).
