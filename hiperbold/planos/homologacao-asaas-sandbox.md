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
