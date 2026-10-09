import "server-only";

/**
 * Schemas zod dos requests, responses e do envelope do webhook do Asaas que
 * este app usa: fase F5, Tarefa 10. Nomes de campo, formatos e enums seguem
 * o manual comum (`F:\github-projects\hiper-track\docs\manual-api-asaas-saas.md`,
 * seções 3 a 7), que manda nisso para os três apps (HiperTrack, HiperCRM,
 * HiperStudio).
 *
 * Todo schema usa `.passthrough()`: o manual avisa que "as respostas e
 * webhooks podem acrescentar campos" (seção 2). Recusar um campo novo
 * derrubaria a integração no dia em que o Asaas acrescentar algo que este
 * app não usa. Só os campos que o app LÊ são validados.
 */
import { z } from "zod";

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

// ─── Cliente (customer) ──────────────────────────────────────────────────

export const clienteAsaasSchema = z
  .object({
    id: z.string().regex(/^cus_[A-Za-z0-9]+$/),
    name: z.string().optional(),
    cpfCnpj: z.string().optional(),
    email: z.string().nullable().optional(),
    externalReference: z.string().nullable().optional(),
    /** D-087: `true` = o Asaas não manda e-mail/SMS de cobrança ao pagador (os do CRM é que valem). */
    notificationDisabled: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .passthrough();
export type ClienteAsaas = z.infer<typeof clienteAsaasSchema>;

export const criarClienteRequestSchema = z.object({
  name: z.string().min(1),
  cpfCnpj: z.string().min(11),
  email: z.string().optional(),
  phone: z.string().optional(),
  mobilePhone: z.string().optional(),
  externalReference: z.string().min(1).max(200).optional(),
  /** D-087: `true` desliga as notificações de cobrança do Asaas (docs.asaas.com, `POST /v3/customers`). */
  notificationDisabled: z.boolean().optional(),
});
export type CriarClienteRequest = z.infer<typeof criarClienteRequestSchema>;

/** D-087: `PUT /v3/customers/{id}` só com o que este app muda (docs.asaas.com, "Atualizar cliente existente"). */
export const atualizarClienteRequestSchema = z.object({
  notificationDisabled: z.boolean(),
});
export type AtualizarClienteRequest = z.infer<typeof atualizarClienteRequestSchema>;

// ─── Assinatura (subscription) ───────────────────────────────────────────

// SEMIANNUALLY entra na D-176 (venda semestral): a homologação de 30/09/2026
// mediu no sandbox que a API aceita o ciclo em CREDIT_CARD e devolve o mesmo
// `cycle` pedido, com `nextDueDate` seis meses adiante.
export const cicloAsaasSchema = z.enum(["MONTHLY", "SEMIANNUALLY", "YEARLY"]);
export type CicloAsaas = z.infer<typeof cicloAsaasSchema>;

export const assinaturaAsaasSchema = z
  .object({
    id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
    customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
    // O manual lista ACTIVE/EXPIRED/INACTIVE, mas não garante que a lista é
    // fechada; um `status` de valor novo não pode derrubar o parse.
    status: z.string(),
    billingType: z.string(),
    cycle: z.string(),
    value: z.number(),
    nextDueDate: z.string().regex(DATA_ISO).optional(),
    externalReference: z.string().nullable().optional(),
    deleted: z.boolean().optional(),
  })
  .passthrough();
export type AssinaturaAsaas = z.infer<typeof assinaturaAsaasSchema>;

export const criarAssinaturaRequestSchema = z.object({
  customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
  // Só CREDIT_CARD (decisão 1: cartão sempre pela fatura hospedada) e PIX
  // entram nesta fase; BOLETO/UNDEFINED ficam fora do escopo de venda.
  billingType: z.enum(["CREDIT_CARD", "PIX"]),
  value: z.number().positive(),
  nextDueDate: z.string().regex(DATA_ISO),
  cycle: cicloAsaasSchema,
  description: z.string().max(500).optional(),
  externalReference: z.string().min(1).max(200).optional(),
});
export type CriarAssinaturaRequest = z.infer<typeof criarAssinaturaRequestSchema>;

// ─── Cobrança (payment) ──────────────────────────────────────────────────

export const cobrancaAsaasSchema = z
  .object({
    id: z.string().regex(/^pay_[A-Za-z0-9]+$/),
    customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
    subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/).nullable().optional(),
    status: z.string(),
    billingType: z.string(),
    value: z.number(),
    // `coalesce(originalValue, value)` fixado aqui, uma vez só (decisão M5):
    // quem lê `cobranca.valorConfirmado` nunca reimplementa o coalesce.
    originalValue: z.number().nullable().optional(),
    dueDate: z.string().regex(DATA_ISO),
    paymentDate: z.string().regex(DATA_ISO).nullable().optional(),
    confirmedDate: z.string().regex(DATA_ISO).nullable().optional(),
    externalReference: z.string().nullable().optional(),
    invoiceUrl: z.string().nullable().optional(),
    /** D-177: id do parcelamento (UUID, sem prefixo) quando a cobrança é uma parcela. */
    installment: z.string().nullable().optional(),
    installmentNumber: z.number().nullable().optional(),
    deleted: z.boolean().optional(),
  })
  .passthrough()
  .transform((cobranca) => ({
    ...cobranca,
    valorConfirmado: cobranca.originalValue ?? cobranca.value,
  }));
export type CobrancaAsaas = z.infer<typeof cobrancaAsaasSchema>;

export const criarCobrancaRequestSchema = z.object({
  customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
  billingType: z.enum(["PIX", "CREDIT_CARD"]),
  value: z.number().positive(),
  dueDate: z.string().regex(DATA_ISO),
  description: z.string().max(500).optional(),
  externalReference: z.string().min(1).max(200).optional(),
});
export type CriarCobrancaRequest = z.infer<typeof criarCobrancaRequestSchema>;

// ─── Cobrança parcelada (D-177) ───────────────────────────────────────────

/**
 * `POST /payments` com `installmentCount` e `totalValue` cria N cobranças e devolve a PRIMEIRA (com
 * `installment`). O Asaas divide o `totalValue` e joga a diferença de arredondamento na última parcela.
 */
export const criarCobrancaParceladaRequestSchema = z.object({
  customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
  billingType: z.literal("CREDIT_CARD"),
  installmentCount: z.number().int().min(2).max(12),
  totalValue: z.number().positive(),
  dueDate: z.string().regex(DATA_ISO),
  description: z.string().max(500).optional(),
  externalReference: z.string().min(1).max(200).optional(),
});
export type CriarCobrancaParceladaRequest = z.infer<typeof criarCobrancaParceladaRequestSchema>;

/** `GET /installments/{id}`: `value` é o total do parcelamento e `paymentValue` o de cada parcela. */
export const parcelamentoAsaasSchema = z
  .object({
    id: z.string().min(8),
    value: z.number(),
    paymentValue: z.number().nullable().optional(),
    installmentCount: z.number().int(),
    deleted: z.boolean().optional(),
  })
  .passthrough();
export type ParcelamentoAsaas = z.infer<typeof parcelamentoAsaasSchema>;

// ─── QR Pix ───────────────────────────────────────────────────────────────

export const qrPixAsaasSchema = z
  .object({
    encodedImage: z.string(),
    payload: z.string(),
    expirationDate: z.string().nullable().optional(),
  })
  .passthrough();
export type QrPixAsaas = z.infer<typeof qrPixAsaasSchema>;

// ─── Listas paginadas ────────────────────────────────────────────────────

export function listaPaginadaSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      object: z.literal("list").optional(),
      hasMore: z.boolean().optional(),
      totalCount: z.number().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
      data: z.array(item),
    })
    .passthrough();
}

export const listaClientesSchema = listaPaginadaSchema(clienteAsaasSchema);
export const listaAssinaturasSchema = listaPaginadaSchema(assinaturaAsaasSchema);
export const listaCobrancasSchema = listaPaginadaSchema(cobrancaAsaasSchema);

// ─── Cadastro do webhook (GET /webhooks/{id}) ──────────────────────────────

/**
 * Resposta de `GET /webhooks/{id}` (Tarefa 16, decisão 21): a conciliação
 * diária confere se o Asaas marcou a fila do webhook como `interrupted`
 * (entregas falhando em sequência) e alarma quando sim. Só o campo que a
 * conciliação lê é validado; o resto passa por `.passthrough()`.
 */
export const webhookAsaasSchema = z
  .object({
    id: z.string().min(1),
    interrupted: z.boolean().optional(),
  })
  .passthrough();
export type WebhookAsaas = z.infer<typeof webhookAsaasSchema>;

// ─── Envelope do webhook ──────────────────────────────────────────────────

/**
 * `payment`/`subscription` DENTRO DO ENVELOPE do webhook: campos usados só
 * para o pré-roteamento e para extrair `resource_id` (`id`, `subscription`,
 * `customer`, `externalReference`), com `.passthrough()` para o resto. De
 * propósito MAIS TOLERANTE que `cobrancaAsaasSchema`/`assinaturaAsaasSchema`
 * (usados para validar a RESPOSTA de verdade da API em `lib/billing/asaas/
 * cliente.ts`): um subcampo do CORPO DO WEBHOOK fora do formato esperado
 * (`dueDate` com formato estranho, um id sem o prefixo de sempre, o Asaas
 * mandando algo novo) nunca pode jogar um evento AUTENTICADO inteiro para a
 * quarentena. Quem decide se aplica ou não é sempre o objeto CONFIRMADO por
 * `GET` (decisão 3), nunca o corpo do webhook - a validação estrita continua
 * de pé só para a resposta real da API.
 */
const envelopePagamentoSchema = z
  .object({
    id: z.string().optional(),
    subscription: z.string().nullable().optional(),
    customer: z.string().nullable().optional(),
    externalReference: z.string().nullable().optional(),
  })
  .passthrough();

const envelopeAssinaturaSchema = z
  .object({
    id: z.string().optional(),
    customer: z.string().nullable().optional(),
    externalReference: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Envelope do webhook (manual, seção 7 e 19 do plano). Só `id` e `event` são
 * exigidos; `payment`/`subscription` são objetos tolerantes (acima) porque o
 * mesmo formato serve eventos de cobrança e de assinatura, e o processador
 * (Tarefa 13, fora deste arquivo) é quem decide qual olhar a partir de
 * `event`.
 */
export const envelopeWebhookAsaasSchema = z
  .object({
    id: z.string().min(1).max(100),
    event: z.string().regex(/^[A-Z_]{3,64}$/),
    payment: envelopePagamentoSchema.optional(),
    subscription: envelopeAssinaturaSchema.optional(),
  })
  .passthrough();
export type EnvelopeWebhookAsaas = z.infer<typeof envelopeWebhookAsaasSchema>;
