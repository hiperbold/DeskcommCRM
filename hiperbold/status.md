# Status do fork Hiperbold

Atualizado em 22/09/2026.

## Onde está tudo agora

- **Produção** (`crm.hiperbold.com.br`): versão `02e4797`, publicada em 22/09/2026 às 21h37, saudável. Traz a release 1.42.0 do autor original, as correções de segurança do webhook UAZAPI e a trava de dado de cliente nas conexões MCP.
- **`main` do fork**: igual à produção, `02e4797`.
- Antes dessa publicação a produção estava em `9da397d`. O backup do banco de antes é `hiperbold-crm-2026-09-22_2120.dump`, em `D:\Hiperbold\backups\hiperbold-crm`.

## O que essa publicação levou

**A atualização do autor (D-028).** Release 1.42.0, 2298 arquivos, merge `65ca0a253`. 18 conflitos resolvidos. A migração dele tinha derrubado a UAZAPI da regra de canais, e a nossa migração 0903 devolve os dois lados.

**Quatro correções de segurança no webhook da UAZAPI**, achadas em auditoria: o token da instância era gravado em claro no log de webhooks e qualquer membro da organização podia lê-lo; o token passou a ser obrigatório no evento de mensagem; o payload passou a ser conferido contra a sessão; e a leitura do log de webhooks passou a exigir papel de gerente (migração 0902).

**Uma regressão grave, pega pela revisão antes de publicar.** A conferência nova comparava o NOME da instância contra o ID dela. Como os dois quase nunca são iguais, todo evento legítimo viraria "evento de outra conta", com resposta 200, que a UAZAPI não reentrega: o canal pararia de receber mensagem em silêncio. A conferência passou a usar só o número dono, e há um teste que falharia com o código de antes.

**A trava de dado de cliente nas conexões MCP (D-037).** `lib/ai/mcp-externo/sem-dado-de-cliente.ts` limpa o argumento antes de sair para o servidor de terceiro. Campo de código (`sku`, `ean`, `placa`) fica fora da regra de dígitos, senão código de barras seria confundido com telefone.

## Bateria final, rodada em 22/09 às 19h47

| Passo | Resultado |
|---|---|
| typecheck | verde |
| unitários | 1293 arquivos verdes, 1 vermelho |
| test:db | verde, 2193 testes, 9 min |
| build | verde |

O único vermelho é `tests/unit/e2e-parte-4-fala-com-os-servicos-do-runner.test.ts`, no caso "a espera pelo Redis falha FECHADO quando o serviço não responde". É defeito de ambiente, não de código: o teste aponta para uma porta que, no WSL, não recusa conexão na hora e fica pendurada, e o caso levou 67 minutos para desistir. Fora do WSL ele passa.

## Para retomar

1. **Conferir a produção na tela** (o Filipe): é um salto grande de versão, e a conferência não aconteceu antes da publicação. Olhar Conexões, IA, funil e conversas. Se algo estiver errado, o caminho de volta é publicar o commit `9da397d` de novo, e o backup do banco de antes está guardado.
2. **Débitos pequenos** para emendar: D-034, D-035, D-036, D-038, D-039, D-040, D-041, D-042, D-043, D-044.
3. **Planos e assinatura**: o plano está escrito em `hiperbold/planos/2026-09-22-planos-e-assinatura.md` e espera as 13 respostas do Filipe. Nada implementado.

## Ambiente local

O WSL desliga junto com a máquina. Se o CRM local não abrir, o banco do Supabase costuma voltar sem rede Docker: `docker network connect supabase_network_deskcomm-crm supabase_db_deskcomm-crm`, esperar, e `docker restart supabase_rest_deskcomm-crm`. O servidor de desenvolvimento na porta 3300 precisa de uma sessão WSL aberta o tempo todo. O typecheck precisa de `NODE_OPTIONS=--max-old-space-size=6144`.

## Fluxo de teste no n8n

"TESTE CRM - MCP imóveis (Claude, 22/09/2026)", id `GeotyR9EyKzuJpF9`. **Desligado** a pedido do Filipe. Nenhum outro fluxo foi tocado.

## Histórico

O status detalhado das 14 tarefas das conexões MCP ficou em `hiperbold/status-anterior-mcp.md`.
