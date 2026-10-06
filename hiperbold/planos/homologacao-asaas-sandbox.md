# Homologação do Asaas no sandbox, parte 1 (comportamento da API)

Data: 30/09/2026. Ambiente: `https://api-sandbox.asaas.com/v3`, conta sandbox do CRM (chave em `.env.local`, nunca copiada para cá). Branch `feat/planos-assinatura`. Ligada ao D-071.

Script: `hiperbold/scripts/homologar-asaas-sandbox.mts` (cabeçalho traz como rodar e a trava: recusa qualquer base que não seja a de sandbox e qualquer chave que não comece por `$aact_hmlg_`). Usa o cliente HTTP do próprio projeto (`lib/billing/asaas/cliente.ts`, `criarClienteAsaas`, com `fetch` injetado) para cliente, assinatura mensal, listagem de cobranças, Pix, QR e remoções; chamadas diretas onde o cliente do projeto não cobre (ver "Achados no nosso código"). Saída crua (sem segredo) ficou em `F:\temp\2026-09-30\asaas\homologacao-crm\resultados.json` (temporário, não é fonte de verdade).

Cartão de teste (documentação): 4444 4444 4444 4444, CCV 123, validade futura (https://docs.asaas.com/docs/faq-sandbox.md). Cartões recusados: 5184019740373151 e 4916561358240741 (https://docs.asaas.com/docs/testando-pagamento-com-cartão-de-crédito.md).

## Limite principal desta rodada: a fatura hospedada não pôde ser paga por automação

A fatura (`invoiceUrl`, `https://sandbox.asaas.com/i/...`) abre normalmente, pede número, titular, validade e CCV, depois uma segunda etapa com dados do titular (nome, e-mail e CPF já vêm preenchidos do cliente; faltam celular, CEP, número). Ao confirmar, `POST /creditCard/pay` responde `success:false`, "Ocorreu um erro desconhecido", com `recaptchaV2Enabled: true` (reCAPTCHA Enterprise). Repeti com puppeteer headless, com Chrome de verdade em modo visível, com o Chrome iniciado à parte e conectado por CDP, com movimento de mouse, dois cartões (4444 e 4111) e dados de titular completos: mesmo erro sempre, tanto na fatura de assinatura quanto numa cobrança avulsa. O mesmo cartão e os mesmos dados de titular passam pela API (`payWithCreditCard`), então o problema não é a conta nem o cartão. Nenhum desafio visível apareceu na tela. Conclusão: a fatura só se paga em navegador de gente. O item 3 (a fatura guarda o cartão?) ficou sem medida direta; ver abaixo o que foi medido pelo caminho da API e o passo manual que fecha a pergunta.

## Resultado por item

### 1. Cliente
- Feito: criado por chamada direta (`POST /customers`) com CPF gerado (dígito verificador), nome "Homologação HiperCRM 2026-09-30", e-mail `homolog-<ts>@example.com`, `externalReference` `HC:homolog:cli:<ts>`, `notificationDisabled: true`. Busca por `externalReference` feita pelo cliente do projeto (`buscarClientePorReferencia`).
- Devolvido: 200, `notificationDisabled: true`, 30 campos (`id`, `cpfCnpj`, `externalReference`, `deleted`, etc.). A busca pelo cliente do projeto achou o mesmo `id`.
- Conclusão: cliente e busca por referência funcionam. Não usei `criarCliente` do projeto porque `criarClienteRequestSchema` descarta `notificationDisabled` (zod sem passthrough): o cliente criado por ele receberia os e-mails do Asaas. Ver "Achados".
- Id: `cus_000009287353`.

### 2. Assinatura mensal CREDIT_CARD sem cartão
- Feito: `criarAssinatura` do projeto, `billingType CREDIT_CARD`, `MONTHLY`, R$ 10, `nextDueDate` = hoje, `externalReference` `HC:homolog:1790785128378`. Depois `GET /subscriptions/{id}/payments`.
- Devolvido: assinatura `ACTIVE`, `creditCard: null`, campos `checkoutSession`, `paymentLink`, `fine`, `interest`, `split`. A cobrança já nasce na criação: `PENDING`, `billingType CREDIT_CARD`, `subscription` preenchido, `invoiceUrl`, `dueDate "2026-09-30"`, `paymentDate/confirmedDate/clientPaymentDate/creditDate null`. O `nextDueDate` da assinatura já vem do ciclo SEGUINTE (`2026-10-30`), não da cobrança que acabou de nascer. Parse do projeto (`listaCobrancasSchema`) aceitou a lista.
- Conclusão: a cobrança HERDA o `externalReference` da assinatura (valor idêntico, conferido nas duas assinaturas). Formato de data `YYYY-MM-DD`.
- Ids: `sub_efezj1cwizgb921e` (removida), cobrança `pay_o55qzq8il73rzfo3` (paga, fica).

### 3. N30: a fatura guarda o cartão?
- Feito: tentativa de pagar a fatura no navegador (falhou por reCAPTCHA, ver acima). Plano B: paguei a cobrança da assinatura por `POST /payments/{id}/payWithCreditCard` (cartão de teste + `creditCardHolderInfo` + `remoteIp`). Isto NÃO é o caminho da fatura.
- Devolvido pelo caminho da API: a cobrança fica `CONFIRMED` e ganha `creditCard: { creditCardNumber: "4444", creditCardBrand: "VISA", creditCardToken: <token de 26 caracteres> }`. O `GET` da assinatura, que antes tinha `creditCard: null`, passou a mostrar o MESMO objeto `creditCard` (`creditCardNumber`, `creditCardBrand`, `creditCardToken`), `billingType` continua `CREDIT_CARD`. Ou seja: pagar a primeira cobrança de uma assinatura com cartão pela API grava o cartão na assinatura.
- Documentação: a página https://docs.asaas.com/docs/criando-assinatura-com-cartao-de-credito.md diz (resumo, não citação literal) que a plataforma guarda o cartão validado para as cobranças recorrentes, aceita `creditCardToken` do mesmo cliente e que `PUT /subscriptions/{id}/creditCard` troca o cartão da assinatura e das cobranças pendentes. Nenhuma página que li descreve o caso da FATURA HOSPEDADA.
- Conclusão: FICA EM ABERTO para a fatura. O que ficou provado é o caminho da API. Para fechar: rodar `fatura-manual`, pagar a URL impressa à mão num navegador normal com o cartão de teste e rodar `fatura-manual-ler` (mostra `creditCard` da assinatura e da cobrança).

### 4. Dia 31
- Feito: assinatura `MONTHLY` com `nextDueDate 2026-10-31` (próximo dia 31). Lida antes e depois de pagar a primeira cobrança (pela API, plano B).
- Devolvido: primeira cobrança com `dueDate "2026-10-31"`; `nextDueDate` da assinatura `2026-11-30` já na resposta da criação, e igual depois do pagamento.
- Conclusão: o mês seguinte a 31/10 é 30/11 (o dia é ajustado para o último dia do mês; não vai para 01/12). Não medi o mês depois (dezembro: 30/12 ou 31/12), porque a cobrança de 30/11 só é gerada perto do vencimento (por padrão 40 dias antes, https://docs.asaas.com/docs/faq-assinaturas.md); fica como risco de deriva para o dia 30 se o Asaas encadear a partir da data já ajustada.
- Ids: `sub_udxqlgvttu2wpqyf` (removida), cobrança `pay_qbzbaimanczbfr5t` (paga, fica).

### 5. Semestral e anual
- Feito: `POST /subscriptions` CREDIT_CARD sem cartão, `SEMIANNUALLY` e `YEARLY`, leitura, listagem de cobranças e `DELETE`.
- Devolvido: 200 nos dois. `cycle` devolvido igual ao pedido. `SEMIANNUALLY`: `nextDueDate 2027-03-30`; `YEARLY`: `nextDueDate 2027-09-30`; cada uma gerou uma cobrança `PENDING` com `dueDate 2026-09-30`. `DELETE` respondeu `{deleted:true}`.
- Conclusão: a API aceita os dois ciclos em CREDIT_CARD. O nosso `cicloAsaasSchema` só tem `MONTHLY` e `YEARLY` e rejeita `SEMIANNUALLY` na criação.
- Ids removidos: `sub_03sv65n3po5oxzd4`, `sub_7vx7j3n8wnj2nz13`.

### 6. Parcelamento 12x de R$ 1.899,00
- Feito: `POST /payments` avulso CREDIT_CARD, `installmentCount 12`, `totalValue 1899.00`, sem cartão. Não paguei. Leitura de `/installments/{id}` e `/installments/{id}/payments`. Complemento: um parcelamento separado de 3x R$ 30 pago pela API para ver o crédito de cada parcela (ver abaixo).
- Devolvido: a resposta de criação é a PRIMEIRA cobrança (`pay_uiwy7e77rs4nymsu`, `installmentNumber 1`, `value 158.25`, `dueDate 2026-10-01`) com `installment` = UUID (`7315c152-a55f-4727-aa6c-d48249df28d4`, sem prefixo `inst_`). O objeto do parcelamento traz `value 1899`, `netValue 1841.76`, `paymentValue 158.25`, `installmentCount 12`, `expirationDay 1`. Foram criadas 12 cobranças, cada uma com valor 158.25 (soma 1899.00), `netValue 153.48`, vencimentos mensais no dia 1 (2026-10-01 a 2027-09-01), todas `PENDING`, todas com o `externalReference` do pedido, cada uma com a sua própria `invoiceUrl`.
- Conclusão: a API entrega 12 cobranças de 158,25, não uma cobrança de 1.899. O que o cliente vê e paga na fatura de uma dessas (todas as 12 de uma vez no cartão, ou só uma parcela) NÃO foi medido, porque a fatura não é paga por automação. Isto pesa no desenho do anual em 12x e precisa do teste manual.
- Máximo de parcelas (https://docs.asaas.com/docs/criar-uma-cobranca-parcelada.md): "até 21 parcelas para cartões Visa e Mastercard; até 12 parcelas para as demais bandeiras". A mesma página diz que com `totalValue` o Asaas calcula as parcelas e a diferença de arredondamento vai para a última.
- Quando o lojista recebe: as páginas que li (parcelamento, antecipação) não dizem. Medido no sandbox com o 3x de R$ 30 pago pela API (`0904f65e-903e-401a-86d6-6ec66ccb9afd`): as três parcelas ficaram `CONFIRMED` na hora, e o crédito é escalonado: parcela 1 em 2026-11-02 (32 dias), parcela 2 em 2026-12-03, parcela 3 em 2027-01-04, cada uma com `netValue 9.60` de R$ 10. Regra de produção não confirmada por documentação; tratar como o comportamento do sandbox.
- Limpeza: o 12x foi removido (`DELETE /installments/{id}` devolveu `{deleted:true}`).

### 7. Estorno parcial e total
- Feito: `POST /payments/{id}/refund` com `value 4.00` na cobrança da N30 (paga hoje, R$ 10).
- Devolvido: 400 `invalid_action`, "Esta transação só pode ser estornada parcialmente no próximo dia." A cobrança seguiu `CONFIRMED`, `refunds: null`. O estorno do restante nem foi tentado (depende do parcial). `GET /payments/{id}/refunds` devolveu lista vazia.
- Estorno TOTAL no mesmo dia (sem `value`), numa cobrança de sonda de R$ 5 paga pela API: 200, `status REFUNDED` já na resposta e nas leituras seguintes (3 s e 8 s depois), `refunds[0]`: `{dateCreated: "2026-09-30 13:31:19", status: "DONE", value: 5, endToEndIdentifier: null, transactionReceiptUrl, description: null, refundedSplits: null}`. Não vi `REFUND_REQUESTED` nem `REFUND_IN_PROGRESS` no sandbox (a documentação https://docs.asaas.com/reference/estornar-cobranca.md cita esses status intermediários).
- Conclusão: parcial de cartão só a partir do dia seguinte ao pagamento; o status da cobrança depois de um parcial NÃO foi medido (o que a nossa lista de status assumida do D-071 precisa). Fica para amanhã (01/10/2026): rodar `estornar` (a cobrança `pay_o55qzq8il73rzfo3` foi mantida de propósito, sem estorno). Total no mesmo dia: instantâneo, `REFUNDED`.
- Ids: `pay_o55qzq8il73rzfo3` (parcial pendente de teste), `pay_9fqskobr8b3er24v` (estornada em total).

### 8. Pix
- Feito: cobrança PIX avulsa R$ 5 pelo cliente do projeto (`criarCobranca`) e `qrPix`.
- Devolvido: cobrança `PENDING`, `billingType PIX`, `netValue 4.01`. QR (`GET /payments/{id}/pixQrCode`): campos `encodedImage` (base64), `payload` (copia e cola, 189 caracteres, começa com `00020101021226820014br.gov.bcb`), `expirationDate "2027-10-01 23:59:59"`. O parse do projeto (`qrPixAsaasSchema`) aceitou.
- Confirmação: `POST /sandbox/payment/{id}/confirm` (https://docs.asaas.com/reference/confirmar-pagamento.md, corpo `{}`) numa Pix nova: 200, `status RECEIVED`, `paymentDate`, `confirmedDate`, `clientPaymentDate` e `creditDate` todos `2026-09-30`. Por engano, na primeira Pix usei antes `POST /payments/{id}/receiveInCash`: virou `RECEIVED_IN_CASH` (`paymentDate` preenchido, `netValue 5`, sem taxa), que NÃO simula o Pix de verdade.
- Conclusão: o sandbox tem confirmação pela API; para simular Pix pago use o endpoint de sandbox, não `receiveInCash`.
- Ids: `pay_ojpx6geev810y5n8` (RECEIVED), `pay_wswk8bnfgo4q7jri` (RECEIVED_IN_CASH).

### 9. Webhooks
- Feito: `GET /webhooks`. Devolvido: 200, `totalCount 0`, lista vazia. Conclusão: a conta sandbox não tem webhook nenhum. Nada foi criado.

### 10. Limpeza
- Removidas: as duas assinaturas mensais (`sub_efezj1cwizgb921e`, `sub_udxqlgvttu2wpqyf`), as duas de ciclo (já no item 5), o parcelamento 12x, a cobrança avulsa pendente `pay_jc5g64vexp35l75d`. Depois: `GET /subscriptions?customer=...` devolve lista vazia.
- Ficaram (pagas, estornadas ou recebidas, servem de histórico): `pay_o55qzq8il73rzfo3` e `pay_qbzbaimanczbfr5t` (CONFIRMED, R$ 10 cada), `pay_9fqskobr8b3er24v` (REFUNDED), `pay_wswk8bnfgo4q7jri` (RECEIVED_IN_CASH), `pay_ojpx6geev810y5n8` (RECEIVED), e as três parcelas CONFIRMED do 3x (`pay_t8l58iq9885a3kaq`, `pay_pwvnxd7tlj15nzxj`, `pay_b74egq6w5ukj3kxp`). Cliente `cus_000009287353` mantido.

## Respostas diretas às perguntas do D-071

| Pergunta | Resposta |
|---|---|
| A fatura guarda o cartão (N30)? | Pela fatura hospedada: NÃO MEDIDO (a fatura recusa navegador automatizado). Pela API: pagar a cobrança de uma assinatura CREDIT_CARD com `payWithCreditCard` faz a assinatura passar de `creditCard: null` para `creditCard: {creditCardNumber, creditCardBrand, creditCardToken}`. Fechar com `fatura-manual` + `fatura-manual-ler`. |
| A cobrança da assinatura herda o `externalReference`? | SIM, valor idêntico, nas duas assinaturas. |
| Formato de `dueDate` / `paymentDate`? | `YYYY-MM-DD`. Em cartão, depois de pago: `status CONFIRMED`, `paymentDate` continua `null`; vêm `confirmedDate` e `clientPaymentDate` (`2026-09-30`) e `creditDate` 32 dias depois (`2026-11-02`). Em Pix confirmado: `paymentDate`, `confirmedDate`, `clientPaymentDate` preenchidos, `RECEIVED`. Datas de hora (`refunds[].dateCreated`, `expirationDate` do QR) usam `YYYY-MM-DD HH:MM:SS`. |
| Dia 31? | 31/10 vira 30/11 (último dia do mês); a cobrança de 31/10 nasce com `dueDate 2026-10-31`. Não medido: o mês seguinte a 30/11. |
| Status de estorno parcial? | O parcial de cartão é RECUSADO no dia do pagamento (400 `invalid_action`, "só pode ser estornada parcialmente no próximo dia"). O status depois do parcial fica para o dia seguinte (`estornar`). Estorno total no mesmo dia: `REFUNDED` imediato. |

## Achados no nosso código (não alterei nada)

1. `criarClienteRequestSchema` descarta `notificationDisabled`; se o CRM quiser silenciar os e-mails do Asaas para o cliente, o schema precisa do campo.
2. `cicloAsaasSchema` só tem `MONTHLY` e `YEARLY`; a API aceita `SEMIANNUALLY` em CREDIT_CARD (N8 pede semestral).
3. `criarCobrancaRequestSchema` não tem `installmentCount`, `totalValue` nem `installmentValue`: o anual em 12x hoje não passa pelo nosso cliente. A resposta de criação é a primeira parcela, com `installment` em formato UUID.
4. `cobrancaAsaasSchema` e o processador já tratam `CONFIRMED` como dinheiro e `paymentDate` como opcional/nulo, o que bate com o cartão medido.
5. O `server-only` dos módulos de billing exige um alias fora do Next; o script usa `module.registerHooks` (Node 22.15+) apontando para o módulo vazio do próprio Next.

## Não medido e por quê

- Fatura hospedada paga (item 3, e o 12x pela fatura no item 6): reCAPTCHA Enterprise recusa navegador automatizado. Passo manual: `tsx hiperbold/scripts/homologar-asaas-sandbox.mts fatura-manual`, pagar a URL impressa, `fatura-manual-ler`. Depois `limpar`.
- Estorno parcial de cartão: só a partir de 01/10/2026 (`estornar`, usa `pay_o55qzq8il73rzfo3`).
- Dia 31 depois de novembro: exige esperar a geração da cobrança de 30/11.
- Quando o lojista recebe cada parcela em produção: a documentação que li não diz; só o comportamento do sandbox está registrado.
- Webhook: nenhum criado, por instrução; portanto nenhum evento (`PAYMENT_CONFIRMED`, `PAYMENT_PARTIALLY_REFUNDED`, etc.) foi observado.

---

# Parte 2, ponta a ponta (fluxo de compra do CRM contra o sandbox)

Data: 30/09/2026. Mesmo sandbox da parte 1, branch `feat/planos-assinatura`, banco LOCAL (Supabase do WSL). Script: `hiperbold/scripts/homologar-asaas-e2e-sandbox.mts` (cabeçalho traz como rodar e as travas: recusa base/chave que não sejam de sandbox, recusa banco que não seja o local, recusa rodar sem o backup do banco, nunca imprime segredo, só escreve nas duas organizações de teste e nas chaves de teste de `billing_settings`). Saída crua sem segredo: `F:\temp\2026-09-30\asaas\e2e\resultados.json` e `estado.json` (temporários, não são fonte de verdade). Última execução de cada etapa: 75 checagens, 75 ok (uma checagem do próprio script estava errada e foi corrigida, ver "Passo 4").

O que roda é o código do CRM com dependências reais: `iniciarCompra` e `cancelarAssinaturaDoCliente` (`lib/billing/asaas/compra.ts`) com `dbCompraSupabase` (banco local) e `criarClienteAsaas` (HTTP do sandbox); o HANDLER `POST` de `app/api/v1/webhooks/asaas/route.ts` chamado no processo com um `NextRequest`; `processarEventosAsaas` com `criarDbEventosAsaasSobre` e o mesmo cliente HTTP. Nenhum servidor Next foi subido. O pagamento do cartão é feito pela API do sandbox (a fatura hospedada tem reCAPTCHA, parte 1). Os eventos de webhook foram montados por mim (o sandbox não tem webhook configurado, parte 1, item 9): o Asaas nunca entregou nada.

## Ambiente e pré-condições (passo 1)

- Backup antes de escrever qualquer coisa: `F:\temp\2026-09-30\asaas\banco-local-antes-e2e.dump` (`pg_dump -Fc`, 3.244.486 bytes). O script recusa rodar sem ele.
- Estado do banco local ANTES: `billing_settings.compra_pelo_cliente = false`, `asaas_sandbox_concede = false`, planos Pro/Max/Escale com `for_sale = false`, 1 organização (`hiperbold`, plano Ilimitado), 0 pedidos, 0 eventos.
- Ligado SÓ no banco local (pelas funções oficiais `fn_billing_definir_compra_pelo_cliente` e `fn_billing_definir_a_venda`): `compra_pelo_cliente = true`; `for_sale = true` em `pro`, `max`, `escale`. Mais `billing_settings.asaas_sandbox_concede = true` (NÃO estava no roteiro, mas sem ela o pagamento de sandbox nunca concede, ver passo 4; ligada só depois de medir o comportamento desligada). Continuam ligadas no banco local; para voltar ao estado anterior: `fn_billing_definir_compra_pelo_cliente(false, null)`, `fn_billing_definir_a_venda('pro'|'max'|'escale', false, null)` e `update billing_settings set asaas_sandbox_concede = false where id = 1`.
- Organizações de teste criadas pelo script (insert em `organizations`; o gatilho cria o contrato Ilimitado): A = `25365bf8-5698-4581-94a9-ffaa2afe7e69` ("Homologação Asaas 2026-09-30"), B = `742c82b8-ba00-4f58-9aa9-80e1b6e3dd6e` ("Homologação Asaas 2026-09-30 (dia 31)"). A organização `hiperbold` não foi tocada (contrato com o mesmo `updated_at` de 24/09).
- Problema de ambiente, não de código: o container `supabase_kong_deskcomm-crm` estava sem rede Docker e sem a porta 54321 publicada (mesmo sintoma de reinício do WSL já conhecido), então a API do Supabase local recusava conexão. Corrigido com `docker network connect --alias kong supabase_network_deskcomm-crm supabase_kong_deskcomm-crm` e `docker restart supabase_kong_deskcomm-crm` (não mexe em dado). O container `supabase_inbucket_deskcomm-crm` também está sem rede (não usado aqui, não mexi).
- O `ASAAS_WEBHOOK_TOKEN` do ambiente tinha formato válido (32 a 255 caracteres, diferente da chave); foi usado sem imprimir.

## Passo 2. Compra mensal do Pro no cartão (organização A)

- Feito: `iniciarCompra` com `tipo assinatura`, `planCode pro`, `ciclo monthly`, `metodo CREDIT_CARD`, pagador com CPF gerado e e-mail `@example.com`. Depois do `POST /customers` do próprio CRM, o script faz um `PUT` com `notificationDisabled: true` (o schema do CRM descarta o campo, achado 1 da parte 1).
- Devolvido: `{ tipo: "redirecionar", url: "https://sandbox.asaas.com/i/..." }`. Chamadas do CRM ao Asaas, nesta ordem: `GET /customers?externalReference=HC:org:<org>`, `POST /customers`, `POST /subscriptions`, `GET /subscriptions/{id}/payments`. Pedido em `billing_orders`: `aguardando_pagamento`, `monthly`, `CREDIT_CARD`, `sandbox`, `amount_cents 19900`, `external_reference = HC:ord:2da4a31c-fa0c-47c4-999b-e54a65207b07`, com `asaas_subscription_id`, `asaas_payment_id` e `invoice_url` gravados. Cliente no Asaas: `externalReference = HC:org:<org>`, `notificationDisabled true`; `billing_customers` vincula. Assinatura no Asaas: `MONTHLY`, `CREDIT_CARD`, `value 199`, `description "HiperCRM, plano Pro mensal"`, `externalReference` igual ao do pedido, `nextDueDate 2026-10-30`, `creditCard null`. Primeira cobrança: `dueDate 2026-09-30` (hoje), herda o `externalReference` do pedido, e a fatura devolvida ao cliente é exatamente a `invoiceUrl` dela. O contrato continua Ilimitado (a assinatura só entra no contrato no pagamento).
- Conclusão: o caminho de compra funciona do clique ao redirecionamento, com banco e Asaas reais. Sem nenhum `POST` repetido.
- Ids: pedido `2da4a31c-fa0c-47c4-999b-e54a65207b07`, cliente `cus_000009287644`, assinatura `sub_rh2p22y2r26qpjtm` (removida no passo 9), cobrança `pay_6dknzoz2kly6esh9`.

## Passo 3. Pagamento pela API do sandbox

- Feito: `POST /payments/{id}/payWithCreditCard` com o cartão de teste 4444 4444 4444 4444 e dados de titular gerados.
- Devolvido: 200, cobrança `CONFIRMED`, `confirmedDate 2026-09-30`, `paymentDate null`, `creditDate 2026-11-02`, `netValue 194.55` de R$ 199. A assinatura passou a mostrar `creditCard` (final 4444, VISA, token), como na parte 1.
- Conclusão: igual ao medido na parte 1; a cobrança da assinatura fica `CONFIRMED` (não `RECEIVED`) e sem `paymentDate`.

## Passo 4. Webhook: handler, processador, idempotência

- Feito (pela ordem): (4a) `PAYMENT_CONFIRMED` (id de evento `evt_<hex>&<número>`, `event`, `dateCreated`, `payment` = o objeto devolvido pelo `GET /payments/{id}`) entregue ao handler com o cabeçalho `asaas-access-token` certo, com `asaas_sandbox_concede` AINDA DESLIGADA; processador. (5) token errado, ver passo 5. (4b) liga `asaas_sandbox_concede`, `fn_billing_asaas_reprocessar_evento` no mesmo evento, processador. (4c) reentrega do MESMO evento. (4d) `PAYMENT_RECEIVED` (id de evento diferente, mesma cobrança).
- Devolvido:
  - Handler: 200 com corpo `{"recebido":true}`; evento gravado em `asaas_webhook_events` (`aguardando`, `sandbox`, `origem webhook`, `resource_id = pay_...`); o payload guardado não tem nenhuma chave com "card" (conferido por psql nos 2 eventos de pagamento).
  - 4a: o processador reservou 1 evento e fez `GET /payments/{id}` e `GET /subscriptions/{id}` (só GET, nenhum POST/DELETE). Resultado `ignorado`, `erro_codigo sandbox_nao_concede`. Pedido continua `aguardando_pagamento`, contrato, pagamentos e carteira sem nenhuma mudança.
  - 4b: depois do reprocesso, o mesmo par de GET e resultado `aplicado` (1 aplicado na rodada, evento ligado à organização A). `billing_orders`: `pago`, `pago_em` preenchido. `billing_contracts`: plano Pro, `monthly`, `ativa`, `gateway asaas`, `asaas_subscription_id` e `asaas_ambiente sandbox` gravados, `cancel_at_period_end false`, `current_period_start = 2026-09-30 00h SP` (03:00Z), `current_period_end = 2026-10-31 00h SP`. `billing_payments`: 1 linha `origem asaas`, `CONFIRMED`, `gross_cents 19900`, ligada ao pedido, mesmo período do contrato. `billing_contract_eventos`: `periodo` e `plano` (motivo `pay_primeiro_pagamento`). O fim do período do CRM é igual ao `nextDueDate` do Asaas (30/10) mais 1 dia, como o desenho manda (limite exclusivo).
  - Tokens: o pagamento da assinatura NÃO grava nada em `billing_token_ledger` nem em `billing_token_wallets` (as duas tabelas ficam vazias). A concessão é preguiçosa: na primeira leitura de `fn_billing_saldo_da_carteira` o Pro concede 3.000.000 tokens (fonte `plano`, ciclo `2026-09-01`, linha `plano:2026-09-01` no livro e `creditado 3000000` na carteira).
  - 4c: reentrega do mesmo evento: 200, nenhuma linha nova (contagem de eventos igual), o log do handler marca `novo: false`; o processador reservou 0 e não chamou o Asaas; banco idêntico.
  - 4d: `PAYMENT_RECEIVED` entra como evento novo, o processador consulta por GET de novo, resultado `ja_aplicado`; continua 1 pagamento, mesmo contrato, mesma carteira.
- Conclusão: a cadeia webhook, fila, GET de confirmação e aplicação funciona e é idempotente nos dois níveis (id do evento e id do pagamento). A trava `asaas_sandbox_concede` funciona como desenhada (sem ela, pagamento de sandbox não concede e o evento pode ser reprocessado depois). Uma checagem do próprio script estava errada (tratava o VALOR `CREDIT_CARD` do payload como se fosse campo de cartão); corrigida para olhar só nomes de chave, e conferida por psql.
- Limite: no cartão o `creditDate` cai 32 dias depois do pagamento, que é quando se espera o `PAYMENT_RECEIVED` real (não observado); o 4d usa o `GET` de hoje (ainda `CONFIRMED`), então prova a idempotência por pagamento, não o `RECEIVED` real.
- Eventos no banco local ao fim (5): organização A teve `PAYMENT_CONFIRMED` (aplicado), `PAYMENT_RECEIVED` (`ja_aplicado`) e `PAYMENT_REFUNDED` (aplicado); organização B teve `PAYMENT_CONFIRMED` (aplicado) e `SUBSCRIPTION_DELETED` (aplicado). Os ids de evento estão em `estado.json`.

## Passo 5. Token errado

- Feito: o mesmo corpo de `PAYMENT_CONFIRMED`, com id de evento novo, entregue com (a) token errado do mesmo tamanho, (b) token curto, (c) sem o cabeçalho.
- Devolvido: 401 com corpo vazio nos três. Contagem de `asaas_webhook_events` igual antes e depois e o evento forjado não existe na tabela.
- Conclusão: falha fechada, nada gravado, sem eco do corpo.

## Passo 6. Vencimento no dia 31 (organização B)

- Como o CRM define o vencimento: o cliente NÃO escolhe o dia. `criarAssinaturaEDevolver` (`lib/billing/asaas/compra.ts:862`) usa `nextDueDate = proximaCobrancaEm ?? hoje (São Paulo)`; `proximaCobrancaEm` é a data civil de SP de `current_period_end` do contrato quando o período ainda vale (`fn_billing_criar_pedido`, decisão 26, migração 0909 linhas 694 a 698). Sem período em curso, vence hoje. O dia 31 só aparece quando o período pago termina em 30/10.
- Feito: a organização B recebeu um período pago até 30/10 pela função oficial do registro manual (`fn_billing_registrar_pagamento`, `p_fim 2026-10-30`, R$ 1,00 simbólico, `RECEIVED_IN_CASH`; o `service_role` não tem `UPDATE` direto em `billing_contracts`), e depois passou pelos passos 2, 3 e 4 (já com a chave de sandbox ligada).
- Devolvido: pedido igual ao de A; assinatura com `nextDueDate 2026-11-30` logo na criação; primeira cobrança com `dueDate 2026-10-31`, paga pela API (cobrança de vencimento futuro aceita o pagamento). Evento aplicado; `billing_payments` (linha `asaas`) e contrato: `current_period_start = 2026-10-31 00h SP`, `current_period_end = 2026-12-01 00h SP`. Organização tem 2 linhas em `billing_payments` (a manual do ajuste e a do Asaas). Tokens: mesmo comportamento de A (vazio até a primeira leitura, depois 3.000.000).
- Comparação: CRM calcula 31/10 mais 1 mês pelo `interval` do Postgres, que prende no último dia do mês (30/11), mais 1 dia de limite exclusivo, dá 01/12 00h SP. O Asaas fez 31/10 virar 30/11 no `nextDueDate` (igual à parte 1). Os dois batem: o período do CRM termina no dia seguinte ao próximo vencimento do Asaas, exatamente como no caso do dia 30 (passo 4, A).
- Não medido: o mês depois (30/12 ou 31/12 no Asaas). O CRM calcula cada período a partir do `dueDate` da cobrança paga, sem encadear, então não acumula deriva; o que pode aparecer é uma folga de 1 dia a mais ou a menos na renovação, sem perder acesso (o fim usa `greatest`).
- Ids: pedido `0d47ab9a-2e80-49f0-8a94-fbe99c0eaf72`, cliente `cus_000009287669`, assinatura `sub_pt8qr32wsvgljydx`, cobrança `pay_61zk56ghsiw7h5rf` (`CONFIRMED`, R$ 199, fica como histórico).

## Passo 7. Estorno total pelo Asaas (organização A)

- Feito: `POST /payments/pay_6dknzoz2kly6esh9/refund` sem `value`, depois `PAYMENT_REFUNDED` montado com o objeto `GET` (já `REFUNDED`), handler, processador, e reentrega do mesmo evento. Extra: nova tentativa de compra na organização A.
- Devolvido: Asaas 200, cobrança `REFUNDED`, `refunds[0] = { status DONE, value 199 }`. O processador fez só `GET /payments/{id}` e aplicou (`aplicado`, alarme `estorno_confirmado`). `billing_orders`: `estornado`. `billing_payments`: nova linha `REFUNDED`, `gross_cents 19900`, `estorna_pagamento_id` do pagamento original, período nulo. `billing_contracts`: NADA muda (continua Pro, `ativa`, mesmo período até 31/10, `cancel_at_period_end false`, assinatura viva, `asaas_assinatura_encerrada_em` nulo). Carteira e livro: NADA muda (3.000.000 tokens continuam). Reentrega do mesmo evento: sem evento novo, sem reserva, banco idêntico. Extra: `iniciarCompra` de A depois do estorno devolve "Sua organização já tem uma assinatura ativa." (código 22023) e não chama o Asaas.
- Conclusão: o estorno vindo do Asaas NÃO passa por `fn_billing_estornar_pagamento` (essa função recusa `origem asaas`, `billing_pagamento_nao_e_manual`); passa por `fn_billing_asaas_aplicar_estorno`, que por desenho (N31/N32/N43, `hiperbold/planos/fase-F5-tarefas.md` linha 36) só registra, marca o pedido e alarma. Funciona como desenhado, mas as consequências práticas estão em "Defeitos e riscos".
- Ids: cobrança `pay_6dknzoz2kly6esh9` (`REFUNDED`).

## Passo 8. Cancelamento pelo cliente (organização B)

- Feito: `cancelarAssinaturaDoCliente`; depois `SUBSCRIPTION_DELETED` montado no formato do Asaas e entregue ao handler.
- Devolvido: `{ tipo: "ok", cancelAtPeriodEnd: true }`. O CRM fez `DELETE /subscriptions/{id}` (200). No Asaas, um `GET` depois devolve 200 com `deleted: true` e `status INACTIVE` (não 404). No banco: `asaas_assinatura_encerrada_em` preenchido, `cancel_at_period_end true`, status `ativa` e período preservados (acesso até 01/12), evento de auditoria `cancelar_no_fim` (`false` para `true`, motivo `asaas_delete_confirmado_pelo_crm`), pedido continua `pago`. Segunda chamada: recusada ("Esta organização não tem uma assinatura Asaas ativa para cancelar."), sem novo `DELETE`. `SUBSCRIPTION_DELETED`: handler 200, o processador fez `GET /subscriptions/{id}` e fechou `aplicado` sem mudar o contrato já marcado.
- Conclusão: cancelamento correto e idempotente; vale até o fim do período pago, sem estorno (N34).

## Passo 9. Limpeza

- Feito: no Asaas, listadas e removidas as assinaturas ainda abertas dos dois clientes de teste. Só a de A (`sub_rh2p22y2r26qpjtm`) estava aberta (200, `deleted true`); a de B já tinha sido cancelada pelo CRM no passo 8. Depois: nenhuma assinatura aberta para os dois clientes.
- Ficam no Asaas como histórico: clientes `cus_000009287644` e `cus_000009287669`; cobranças `pay_6dknzoz2kly6esh9` (`REFUNDED`) e `pay_61zk56ghsiw7h5rf` (`CONFIRMED`).
- Banco local: nada apagado. As duas organizações de teste ficam como registro (ids no passo 1). A assinatura de A foi removida no Asaas pelo script (não pelo CRM), então o contrato de A no banco local continua mostrando a assinatura como viva, sem o marcador de encerramento: é artefato do teste.

## Defeitos e riscos achados (nada foi alterado no código do CRM)

1. Estorno total não corta nada e deixa a pessoa presa (desenho N31/N43, mas com efeito prático a decidir). Depois de `PAYMENT_REFUNDED` aplicado, o contrato segue Pro `ativa`, a assinatura continua `ACTIVE` no Asaas (vai cobrar de novo no mês seguinte), os tokens ficam, e o cliente não consegue comprar de novo porque `fn_billing_criar_pedido` bloqueia enquanto houver assinatura sem marcador de encerramento (`supabase/migrations/20260924140000_0909_planos_asaas.sql:685` a `687`). O processador só trata os alarmes `remover_cobranca_pendente` e `remover_assinatura_pendente` (`lib/billing/asaas/processar-eventos.ts:633` a `638`); o alarme `estorno_confirmado` não dispara nenhuma ação, e `fn_billing_asaas_aplicar_estorno` só atualiza o pedido (migração linhas `5037` a `5040`). Quem decide é o admin da plataforma: `fn_billing_corrigir_periodo`, `fn_billing_ajustar_tokens` e a ação `cancelarAssinaturaNoAsaas` (`app/actions/admin/cobrancaAsaas.ts:534`), que já existe. O que falta é nada disso acontecer sozinho e ninguém ser avisado de que a assinatura segue cobrando; não conferi se a tela do admin exibe o alarme `estorno_confirmado` (não medi tela). Decisão de produto: no estorno total, cancelar a assinatura junto (chamar `removerAssinatura` e o marcador), ou garantir que o alarme chegue ao admin com esse pedido de ação.
2. O CRM cria o cliente no Asaas sem `notificationDisabled` (`lib/billing/asaas/compra.ts:665` a `671`; `lib/billing/asaas/contratos.ts:33` a `40` descarta o campo). O cliente real vai receber os e-mails de cobrança do Asaas, além dos do CRM. Nos testes desta parte o script desligou por `PUT` logo depois da criação. Decisão de produto (achado 1 da parte 1, confirmado no fluxo real).
3. Ambiente: o container `kong` do Supabase local fica sem rede e sem a porta 54321 depois de reinício (já conhecido); aqui foi religado à mão, ver "Ambiente".

Não são defeitos, mas vale saber: (a) sem `asaas_sandbox_concede` o evento de sandbox fecha `ignorado` e o pedido fica `aguardando_pagamento` para sempre até alguém reprocessar (por desenho, só para instalação de teste); (b) o pagamento da assinatura não concede tokens, a primeira leitura de saldo (ou o primeiro consumo) concede.

## Não medido e por quê

- A fatura hospedada (`invoiceUrl`) não foi paga: reCAPTCHA (parte 1). Continua em aberto se ela guarda o cartão para as próximas cobranças (N30); aqui o pagamento foi pela API, que guarda. O "redirecionar" foi provado só até a URL correta.
- Entrega real do webhook pelo Asaas: o sandbox não tem webhook configurado e nada foi criado. Os eventos foram montados por mim no formato documentado, com o objeto `payment` real do `GET`; o formato do `id` do evento (`evt_<hex>&<número>`) e de `dateCreated` segue a documentação, não foi observado. A camada HTTP (Next, `Content-Length`, reentrega automática, fila `SEQUENTIALLY`, pausa por falha) não foi exercida: o handler foi chamado direto no processo. O cron (`app/api/v1/cron/processar-eventos-asaas`) e a conciliação diária (`lib/billing/asaas/conciliar.ts`) também não.
- `ASAAS_ENABLED` e `compraLigada()` (as duas chaves da decisão 18 lidas do ambiente e do banco) não foram exercitadas: a configuração foi injetada com `habilitado: true`. A tela e a ação do cliente (`app/actions/settings/compraDoPlano.ts`), sessão e permissão não foram exercitadas: `iniciarCompra` foi chamada direto.
- Pix e pacote de tokens pelo fluxo real (só a parte 1 mediu o Pix, sem CRM); anual (`price_yearly_cents` ainda nulo, o plano anual não é vendável); semestral; renovação mensal de verdade (a segunda cobrança só nasce perto do vencimento); `PAYMENT_RECEIVED` real do cartão (32 dias depois); estorno parcial (só a partir de 01/10, continua pendente da parte 1 com `pay_o55qzq8il73rzfo3`); o mês depois do dia 31 (ver passo 6).
- Organização nova com compra concorrente (dois cliques): coberto por testes do CRM, não repetido aqui.

## Fechamento em 05/10/2026

- Item 3 medido: a fatura hospedada paga à mão (cartão 4444, `pay_sk4k22lsiobuzrw3`) deixou a assinatura `ACTIVE` com `creditCard` preenchido (bandeira, final e `creditCardToken`), então a renovação cobra o cartão sozinha. Na cobrança: `status: CONFIRMED`, `paymentDate` nulo, `confirmedDate` e `clientPaymentDate` no dia, `creditDate` 32 dias depois.
- Item 7: o estorno parcial do cartão de `pay_o55qzq8il73rzfo3`, paga em 30/09, CONTINUA recusado em 05/10 com a mesma mensagem (400 `invalid_action`, "só pode ser estornada parcialmente no próximo dia"). A cobrança segue `CONFIRMED` até o `creditDate` (02/11); o sandbox não avança sozinho. O status depois de um parcial não é medível no sandbox: fica para a compra real de baixo valor em produção (D-071).
- Limpeza (`limpar`) feita: as três assinaturas de teste removidas e o parcelamento apagado; o que já estava pago fica como histórico.

## Ciclos semestral e anual (D-176), 06/10/2026

Rodado com `homologar-asaas-e2e-sandbox.mts` (etapas de ciclo), chave sandbox do CRM, banco local com backup antes (`F:/temp/2026-10-06/asaas/banco-local-antes-ciclos.dump`) e baseline reaplicado até a 0944. Organizações de teste C (semestral) e D (anual).

- Semestral no cartão (C): assinatura `SEMIANNUALLY` de R$ 1.049,00, próximo vencimento 2027-04-06; pagamento confirmado e webhook aplicado; contrato Pro semestral ativo de 06/10/2026 a 07/04/2027 (vencimento + 6 meses + 1 dia), igual ao Asaas.
- Anual no cartão (D): assinatura `YEARLY` de R$ 1.899,00, próximo vencimento 2027-10-06; contrato Pro anual ativo até 07/10/2027.
- Tokens: a primeira concessão do mês é proporcional aos dias restantes (D-106): 2.516.129 de 3.000.000 em 06/10 (26 de 31 dias). A checagem antiga do script esperava 3.000.000 cheio e foi ajustada à regra.
- Troca de ciclo: com o anual ativo, mensal e semestral são recusados com a mensagem de troca de ciclo e sem nenhuma chamada ao Asaas; o mesmo anual de novo é recusado por assinatura ativa. Nenhum pedido criado.
- Estorno total do semestral: cobrança `REFUNDED`, pedido estornado, contrato cancelado na hora, assinatura removida no Asaas, tokens do plano zerados por lançamento negativo, carência zerada no corte (`bloqueio_a_partir_de` igual ao instante do estorno). A checagem da carência falhou por defeito do script (a foto do contrato não trazia o campo); conferido direto no banco e corrigido no script.
- Cancelamento do anual pelo cliente: DELETE da assinatura no Asaas, marcador de encerramento, acesso mantido até o fim do período; segunda tentativa recusada; `SUBSCRIPTION_DELETED` não muda o contrato.
- Limpeza: nenhuma assinatura aberta sobrou para C e D; as cobranças ficam como histórico. Nada apagado no banco local.
- Não homologado ponta a ponta: Pix semestral e anual e a renovação depois de 6 e 12 meses (cobertos por `tests/invariants/venda-semestral-e-anual-banco.test.ts`).
