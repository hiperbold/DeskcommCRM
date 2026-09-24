# Fase F4: a assinatura ganha vida (estados, cobrança na mão, modo leitura)

Plano mestre: `hiperbold/planos/2026-09-22-planos-e-assinatura.md`, seções 4.2, 4.6, 6.6, 8, 9, 11 e 12. Escrito em 24/09/2026 com autorização do Filipe para seguir sem parar ("anote todas as dúvidas mas avance"); toda decisão de produto usa o padrão da seção 12 ou, sem padrão, a opção mais conservadora (não cobra a mais, não bloqueia cliente sem aviso, não apaga dado).

**Nada muda em produção enquanto `billing_settings.modo` não for `bloquear`.** Os efeitos da assinatura atrasada, suspensa ou cancelada (modo leitura) só valem com o bloqueio ligado, a mesma chave da F3. Com o modo em `avisar`, os estados existem, aparecem nas telas e geram aviso, mas nada para.

## O que já existe

- `billing_contracts` já tem `status` (`avaliacao`, `ativa`, `atrasada`, `suspensa`, `cancelada`, padrão `ativa`), `cycle` (`monthly`/`yearly`), `current_period_start`/`_end`, `cancel_at_period_end`, `gateway` e `asaas_subscription_id` (nulos). `billing_plans` tem `grace_days` (padrão 7) e `for_sale` (falso nos três planos).
- F3: `fn_billing_bloqueio_ativo`, `fn_billing_bloqueia`, `fn_billing_ia_pode_responder`, o gate da IA no `run-model-call`, as pré-checagens e os botões desabilitados, a tela da instalação.
- Carteira (F2-B): crédito avulso e adicional pelo admin, com `valor_cents` informado na mão.

## Decisões de desenho

1. **Estados e transições no banco**, por funções `service_role` com auditoria no servidor: `fn_billing_registrar_pagamento_manual(p_org, p_periodo_ate, p_valor_cents, p_chave uuid, p_nota, p_actor)` (renova o período, volta para `ativa`, idempotente pela chave), `fn_billing_mudar_estado(p_org, p_estado, p_motivo, p_actor)` (atrasada, suspensa, cancelada, ativa; regras de transição válidas), e um conferidor diário `fn_billing_conferir_vencimentos()` por organização: período vencido e sem pagamento vira `atrasada`; `atrasada` há mais de `grace_days` do plano vira `suspensa`; `cancel_at_period_end` com período vencido vira `cancelada`. Organização no Ilimitado sem período (as de hoje) nunca muda de estado sozinha: sem `current_period_end`, não há vencimento.
2. **Tabela de pagamentos manuais** no molde do contrato comum (`billing_payments`, nomes do manual Asaas em `F:\github-projects\hiper-track\docs\manual-api-asaas-saas.md`; confira as colunas lá e crie só o que a cobrança na mão usa, com os campos do gateway nulos), só de acréscimo, chave única por pagamento e período.
3. **Modo leitura** (só com o bloqueio ligado, decisão da seção 12, pergunta 7): na organização `suspensa` ou `cancelada`, param a IA (o gate da carteira ganha o motivo "assinatura suspensa"), as automações, as campanhas de disparo e a prospecção, e a criação de funis, etapas, conexões, integrações e convites; continuam receber mensagem, responder à mão, ler tudo e criar lead (a regra do Filipe: o chat nunca para; lead que chega sozinho continua nascendo; o lead criado por pessoa também continua, porque atender à mão sem poder registrar o cliente quebraria o atendimento). `atrasada` funciona normal e avisa. Pergunta nova N23.
4. **Avisos**: na Central da organização (gerente para cima), "pagamento em atraso, a conta será suspensa em DD/MM" na entrada em `atrasada` e três dias antes da suspensão, "conta suspensa" na suspensão; deduplicados por estado e período. Na plataforma, a lista de organizações atrasadas e suspensas na tela da instalação.
5. **Catálogo de pacotes de tokens** vendidos na mão (`billing_token_pacotes`: código, nome, tokens, `preco_cents` nulo até o Filipe definir, ativo), e a aba do admin ganha "creditar pacote do catálogo" (usa o crédito da F2-B, com o preço do catálogo quando houver; preço nulo pede o valor na hora). Pergunta N9 continua aberta; nenhum preço é inventado.
6. **Planos à venda**: continuam `for_sale = false` até a F5 (compra pelo próprio cliente). O admin atribui plano e período na mão. Preço anual nulo (N8).
7. **Avaliação**: o estado `avaliacao` é suportado (com data de fim), mas nenhuma organização entra nele sozinha (pergunta 4 da seção 12: sem avaliação por padrão). O admin pode pôr uma organização em avaliação com data de fim; vencida, vira `atrasada`.
8. **D-046 resolvido antes da cobrança real**: qualquer membro grava registro falso na auditoria (`api_audit_log`, política do autor). A F4 acrescenta uma política restritiva que exige `actor_user_id = auth.uid()`, `acting_as_platform_admin = false` e `organization_id` não nulo para `authenticated` (acrescentar, não editar a do autor), depois de mapear quem grava auditoria pela sessão do usuário (se algum fluxo legítimo quebrar, ajustar o fluxo ou a política, com prova).
9. **Tela do cliente**: "Plano e uso" mostra o estado da assinatura, o período e o próximo vencimento. **Tela do admin**: a aba "Plano" mostra estado, período e histórico de pagamentos, com as ações de registrar pagamento, mudar estado e pôr em avaliação.

## Tarefas

1. **Banco**: migração 0908 com `billing_payments`, `billing_token_pacotes`, as funções da decisão 1, os efeitos do modo leitura nas travas existentes (decisão 3; os gatilhos de criação da F3 passam a recusar também por estado da assinatura quando o bloqueio vale) e no `fn_billing_ia_pode_responder`. Provas à mão.
2. **Banco: D-046** (decisão 8), com o mapa de quem grava auditoria pela sessão.
3. **Provas de banco**: transições, idempotência do pagamento, conferidor, modo leitura por item (inclui: mensagem que chega e lead continuam), modo `avisar` sem mudança.
4. **Servidor**: as ações do admin (registrar pagamento, mudar estado, avaliação, creditar pacote do catálogo), a rota do conferidor diário e a linha do scheduler, os avisos da Central.
5. **Automações, campanhas e prospecção param no modo leitura**: onde cada uma dispara (motor de automação, envio de campanha, worker de prospecção), a checagem de estado da assinatura com o bloqueio valendo, sem perder evento (a automação registra "parada por assinatura suspensa" em vez de falhar em silêncio).
6. **Telas**: cliente e admin (decisão 9), dicionário com espanhol.
7. **Fechamento**: revisão, auditoria, portões completos.

## Perguntas novas desta fase

- **N23. No modo leitura (conta suspensa), a pessoa ainda pode criar lead à mão?** Padrão: pode, e o lead que chega sozinho também continua nascendo; param IA, automações, campanhas, prospecção e a criação dos outros itens.
- **N24. Quem registra o pagamento enquanto não há Asaas?** Padrão: o admin da plataforma, na aba Plano, com valor, período e nota.
