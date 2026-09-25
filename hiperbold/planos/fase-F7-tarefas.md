# Fase F7: saneamento técnico (dívidas resolvíveis sem decisão do Filipe)

Aberta em 25/09/2026 com autorização do Filipe para seguir a noite toda sem perguntar ("entregar todas as fases possíveis; qualquer questão fica anotada"). Entra aqui só o que é técnico, local e reversível: nada que dependa de decisão de produto, de conta ou chave de terceiro, de produção ou de dado real. Tudo em commits locais na branch feat/planos-assinatura, sem push.

Fica de fora, com o motivo: D-008 (validação manual do Filipe), D-028 (puxar 63 commits do autor: merge grande que mexe em tudo; pede a atenção do Filipe e portões dedicados), D-045 e D-067 (decisões de produto), D-050 (leitura do banco de produção), D-056 (escolha de modelos), D-057 (depende de D-056 e do desenho de chave por origem), D-059 (republicar imagem em produção), D-064 (MFA exige o Filipe cadastrar o fator antes), D-071 (Asaas real).

## Lotes

1. **Banco do módulo de planos** (migração 0910, com MANIFEST e bloco na baseline): D-069 (tirar a escrita direta do `service_role` em `billing_payments` e `billing_contracts`, deixando só as funções; conferir antes todo caminho TS que escreve direto nessas tabelas); D-070 e D-060 (conferir se quem executa essas funções já tem `bypassrls`; se tiver, fechar com a justificativa escrita; se não, restringir); D-047 (`revoke truncate` de `anon` e `authenticated` em todas as tabelas do schema public, idempotente, com teste); D-055 (gatilho de leads que engole erro passa a deixar rastro); D-068 (prova de atualização da 0905 antiga para a 0908).
2. **TS do módulo de planos**: D-072 (segunda validação da URL da fatura marca o pedido), D-065 (bootstrap do agente de voz atrás de guarda de entrada e teste do portão da conta suspensa), D-066 (auditoria da pausa de prospecção por conta suspensa).
3. **Segurança no código do autor**: D-035 (`requireRole` com frase fixa em vez do texto do banco), D-036 (IP da auditoria de fonte confiável), D-043 ("exigir assinatura no webhook" chegando à rota de canal), D-048 (política de escrita em `organizations` respeitando o escopo do admin de suporte).
4. **Robustez no código do autor**: D-040 (ferramenta MCP com nome repetido), D-044 (`resolveSessionRef` para `wacalls`), D-061 (reserva de canal com sessão arquivada), D-042 (reenvio de evento da UAZAPI), D-062 e D-063 (analisar e corrigir se couber sem mudar comportamento no modo `avisar`).
5. **Site de vendas**: subir o Astro de versão principal para fechar os alertas do `npm audit` (D-073), com build e as quatro páginas conferidas; se a subida quebrar algo que não se resolve com segurança, voltar e registrar.

Cada lote: executor, leitura do diff pela sessão principal, revisão (e auditoria nos lotes 1 e 3), correções, commit. No fim: portões completos na cópia separada, DEBITO, HANDOFF e progresso atualizados.

## Perguntas novas desta fase

Nenhuma até agora; as que surgirem entram aqui com o padrão adotado.
