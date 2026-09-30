/**
 * Homologação REAL no SANDBOX do Asaas (D-071, parte 1: comportamento da API).
 *
 * ═══ Trava de sandbox (não negociável) ═══
 * O script RECUSA rodar se `ASAAS_BASE_URL` não for exatamente
 * https://api-sandbox.asaas.com/v3 ou se `ASAAS_API_KEY` não começar com
 * `$aact_hmlg_`. Nunca fala com produção. Nunca imprime nem grava a chave, o
 * token de webhook nem o `.env.local`: toda saída passa por `sanitizar()`, que
 * troca qualquer ocorrência da chave por `<chave>` e mascara `creditCardToken`.
 *
 * ═══ Como rodar (no WSL, na raiz do repositório) ═══
 *   node_modules/.bin/tsx hiperbold/scripts/homologar-asaas-sandbox.mts <etapa>
 *
 * Etapas (a ordem usada em 30/09/2026 está em hiperbold/planos/homologacao-asaas-sandbox.md):
 *   criar               itens 1, 2, 4 (assinatura do dia 31), 5, 6 (12x sem pagar), 8 (cria o Pix) e 9.
 *   status              lê o status das cobranças das duas assinaturas (não grava nada).
 *   cartao-api          sonda: cobrança avulsa de R$ 5 paga por `payWithCreditCard` (a conta aceita cartão?).
 *   pagar-api           paga as duas cobranças de assinatura pela API (plano B: a fatura hospedada
 *                       recusa navegador automatizado, ver abaixo). Não mede o item 3.
 *   verificar           itens 3 e 4 depois do pagamento + item 7 (estorno parcial e do restante).
 *   estornar            só o item 7. O parcial é RECUSADO no dia do pagamento (400 invalid_action):
 *                       rode no dia seguinte.
 *   estornar-total-sonda estorno total (sem `value`) da cobrança de sonda.
 *   pix-confirmar       item 8: Pix novo confirmado por POST /sandbox/payment/{id}/confirm.
 *   parcelado-pago      complemento do item 6: 3x de R$ 30 paga pela API, para ver o creditDate de cada parcela.
 *   fatura-manual       item 3 de verdade: cria assinatura sem cartão e imprime a URL da fatura, para
 *                       PAGAR À MÃO num navegador normal (cartão de teste do sandbox).
 *   fatura-manual-ler   lê a assinatura e a cobrança depois do pagamento à mão (campo `creditCard`).
 *   limpar              item 10: remove assinaturas e cobranças de teste ainda abertas.
 *
 * Navegador automatizado: F:/temp/2026-09-30/asaas/homologacao-crm/pagar-fatura.mjs (puppeteer, Windows)
 * preenche a fatura hospedada, mas o Asaas responde "erro desconhecido" em /creditCard/pay
 * (`recaptchaV2Enabled: true`, reCAPTCHA Enterprise): não serve para pagar a fatura.
 *
 * Variáveis: HOMOLOG_DIR (padrão /mnt/f/temp/2026-09-30/asaas/homologacao-crm).
 * Cada etapa acrescenta em $HOMOLOG_DIR/resultados.json (sem segredo).
 *
 * O `server-only` do projeto não existe fora do Next: um hook de resolução
 * (module.registerHooks, Node 22.15+) o aponta para o módulo vazio do próprio
 * Next, como faz o `vitest.config.ts`.
 *
 * Dados de teste: CPF válido GERADO (dígito verificador), nome "Homologação
 * HiperCRM <data>", e-mail em example.com, notificationDisabled: true. Nenhum
 * dado real de pessoa.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as nodeModule from "node:module";

const require = createRequire(import.meta.url);
const RAIZ = process.cwd();

// ─── server-only -> módulo vazio ──────────────────────────────────────────
const VAZIO = pathToFileURL(join(RAIZ, "node_modules/next/dist/compiled/server-only/empty.js")).href;
(nodeModule as unknown as {
  registerHooks: (h: {
    resolve: (
      spec: string,
      ctx: unknown,
      next: (s: string, c: unknown) => unknown,
    ) => unknown;
  }) => void;
}).registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "server-only") return { url: VAZIO, shortCircuit: true, format: "commonjs" };
    return next(spec, ctx);
  },
});

// ─── Carga do ambiente (sem ler o arquivo à mão) ──────────────────────────
const { loadEnvConfig } = require(
  require.resolve("@next/env", { paths: [require.resolve("next", { paths: [RAIZ] })] }),
) as { loadEnvConfig: (dir: string, dev: boolean, log: { info(): void; error(): void }) => unknown };
loadEnvConfig(RAIZ, true, { info() {}, error() {} });

const BASE_SANDBOX = "https://api-sandbox.asaas.com/v3";
const CHAVE = (process.env.ASAAS_API_KEY ?? "").trim();
const BASE = (process.env.ASAAS_BASE_URL ?? "").trim();

if (BASE !== BASE_SANDBOX || !CHAVE.startsWith("$aact_hmlg_")) {
  console.error(
    "[homologar-asaas] RECUSADO: só roda com ASAAS_BASE_URL=" +
      BASE_SANDBOX +
      " e ASAAS_API_KEY começando com $aact_hmlg_. Nada foi chamado.",
  );
  process.exit(2);
}

// ─── Saída sem segredo ────────────────────────────────────────────────────
function sanitizar(valor: unknown): unknown {
  const texto = JSON.stringify(valor ?? null);
  const limpo = texto.split(CHAVE).join("<chave>");
  const obj = JSON.parse(limpo) as unknown;
  return mascarar(obj);
}
function mascarar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(mascarar);
  if (v && typeof v === "object") {
    const saida: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/token/i.test(k) && typeof x === "string") saida[k] = `<mascarado, ${x.length} caracteres>`;
      else saida[k] = mascarar(x);
    }
    return saida;
  }
  return v;
}
function log(msg: string): void {
  console.log(msg.split(CHAVE).join("<chave>"));
}

// ─── Estado e resultados ──────────────────────────────────────────────────
const DIR = process.env.HOMOLOG_DIR ?? "/mnt/f/temp/2026-09-30/asaas/homologacao-crm";
mkdirSync(DIR, { recursive: true });
const ARQ_ESTADO = join(DIR, "estado.json");
const ARQ_RESULT = join(DIR, "resultados.json");

type Dict = Record<string, unknown>;
function ler(arq: string): Dict {
  return existsSync(arq) ? (JSON.parse(readFileSync(arq, "utf8")) as Dict) : {};
}
const estado = ler(ARQ_ESTADO);
const resultados = ler(ARQ_RESULT);
function salvarEstado(): void {
  writeFileSync(ARQ_ESTADO, JSON.stringify(sanitizar(estado), null, 2));
}
function registrar(chave: string, valor: unknown): void {
  resultados[chave] = valor;
  writeFileSync(ARQ_RESULT, JSON.stringify(sanitizar(resultados), null, 2));
  log(`[${chave}] ${JSON.stringify(sanitizar(valor)).slice(0, 700)}`);
}

// ─── Datas (fuso do Brasil) e CPF gerado ──────────────────────────────────
function hojeBR(deslocaDias = 0): string {
  const d = new Date(Date.now() + deslocaDias * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}
function proximoDia31(): string {
  const hoje = hojeBR();
  let [a, m] = hoje.split("-").map(Number) as [number, number];
  for (let i = 0; i < 14; i += 1) {
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    if (ultimo === 31) {
      const data = `${a}-${String(m).padStart(2, "0")}-31`;
      if (data >= hoje) return data;
    }
    m += 1;
    if (m > 12) {
      m = 1;
      a += 1;
    }
  }
  throw new Error("sem dia 31 nos próximos 14 meses");
}
function cpfGerado(): string {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (n.every((x) => x === n[0])) n[8] = (n[8]! + 1) % 10;
  const dv = (arr: number[]): number => {
    let s = 0;
    for (let i = 0; i < arr.length; i += 1) s += arr[i]! * (arr.length + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(n);
  const d2 = dv([...n, d1]);
  return [...n, d1, d2].join("");
}

// ─── fetch que grava a resposta CRUA da última chamada ────────────────────
let ultimaResposta: { status: number; corpo: unknown } | null = null;
const fetchGravando: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const copia = res.clone();
  const texto = await copia.text();
  let corpo: unknown = texto;
  try {
    corpo = JSON.parse(texto);
  } catch {
    /* corpo não é JSON */
  }
  ultimaResposta = { status: res.status, corpo };
  return res;
};

/** Chamada direta (para o que o cliente do projeto não cobre). Devolve status + corpo cru. */
async function direto(metodo: "GET" | "POST" | "DELETE" | "PUT", caminho: string, corpo?: unknown) {
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      access_token: CHAVE,
      "Content-Type": "application/json",
      "User-Agent": "HiperCRM/1.0",
    },
    ...(metodo === "GET" || metodo === "DELETE" ? {} : { body: JSON.stringify(corpo ?? {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await res.text();
  let json: unknown = texto;
  try {
    json = JSON.parse(texto);
  } catch {
    /* não JSON */
  }
  return { status: res.status, corpo: sanitizar(json) as Dict };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Campos que interessam de uma cobrança, mais a lista completa de chaves. */
function resumoCobranca(p: Dict): Dict {
  return {
    id: p.id,
    status: p.status,
    billingType: p.billingType,
    value: p.value,
    netValue: p.netValue,
    originalValue: p.originalValue,
    totalValue: p.totalValue,
    installment: p.installment,
    installmentNumber: p.installmentNumber,
    subscription: p.subscription,
    externalReference: p.externalReference,
    dueDate: p.dueDate,
    originalDueDate: p.originalDueDate,
    paymentDate: p.paymentDate,
    confirmedDate: p.confirmedDate,
    clientPaymentDate: p.clientPaymentDate,
    creditDate: p.creditDate,
    estimatedCreditDate: p.estimatedCreditDate,
    refunds: p.refunds,
    invoiceUrl: p.invoiceUrl,
    chaves: Object.keys(p).sort(),
  };
}
function resumoAssinatura(s: Dict): Dict {
  return {
    id: s.id,
    status: s.status,
    billingType: s.billingType,
    cycle: s.cycle,
    value: s.value,
    nextDueDate: s.nextDueDate,
    endDate: s.endDate,
    externalReference: s.externalReference,
    creditCard: s.creditCard,
    chaves: Object.keys(s).sort(),
  };
}

// ─── Cliente HTTP do PROJETO ──────────────────────────────────────────────
const { criarClienteAsaas } = (await import(
  pathToFileURL(join(RAIZ, "lib/billing/asaas/cliente.ts")).href
)) as typeof import("../../lib/billing/asaas/cliente");

const cliente = criarClienteAsaas({
  fetch: fetchGravando,
  config: {
    habilitado: true,
    baseUrl: BASE,
    apiKey: CHAVE,
    webhookToken: "",
    webhookId: "",
    ambiente: "sandbox",
  },
  logger: {
    warn: (m, c) => log(`[aviso] ${m} ${JSON.stringify(c ?? {})}`),
    error: (m, c) => log(`[erro] ${m} ${JSON.stringify(c ?? {})}`),
  },
});

/** Roda uma chamada do cliente do projeto e devolve resultado ou o erro tipado, nunca lança. */
async function tentar<T>(rotulo: string, fn: () => Promise<T>): Promise<{ ok: boolean; valor?: T; erro?: unknown; cru?: unknown }> {
  try {
    const valor = await fn();
    return { ok: true, valor, cru: sanitizar(ultimaResposta?.corpo) };
  } catch (err) {
    const e = err as { erro?: unknown; message?: string };
    log(`[${rotulo}] falhou: ${JSON.stringify(sanitizar(e.erro ?? e.message ?? String(err)))}`);
    return { ok: false, erro: sanitizar(e.erro ?? e.message ?? String(err)), cru: sanitizar(ultimaResposta) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 1: criar
// ═══════════════════════════════════════════════════════════════════════════
async function etapaCriar(): Promise<void> {
  const ts = Date.now();
  const hoje = hojeBR();
  estado.timestamp = ts;

  // Item 1: cliente. Criado por chamada direta porque `criarClienteRequestSchema`
  // (zod, sem .passthrough) REMOVE `notificationDisabled`; achado registrado.
  const cpf = cpfGerado();
  const refCliente = `HC:homolog:cli:${ts}`;
  const criado = await direto("POST", "/customers", {
    name: `Homologação HiperCRM ${hoje}`,
    cpfCnpj: cpf,
    email: `homolog-${ts}@example.com`,
    externalReference: refCliente,
    notificationDisabled: true,
  });
  if (criado.status !== 200) throw new Error(`criar cliente: ${criado.status} ${JSON.stringify(criado.corpo)}`);
  const clienteId = criado.corpo.id as string;
  estado.clienteId = clienteId;
  estado.refCliente = refCliente;
  salvarEstado();
  const achado = await tentar("buscarClientePorReferencia", () => cliente.buscarClientePorReferencia(refCliente));
  registrar("item1_cliente", {
    criacaoDireta: { status: criado.status, notificationDisabled: criado.corpo.notificationDisabled, chaves: Object.keys(criado.corpo).sort() },
    buscaPorReferenciaViaClienteDoProjeto: {
      ok: achado.ok,
      achouOMesmo: achado.ok && (achado.valor as { id?: string } | null)?.id === clienteId,
      erro: achado.erro,
    },
    observacao:
      "criarClienteRequestSchema (zod) descarta notificationDisabled; para desligar o e-mail do Asaas o schema precisa ganhar o campo.",
  });

  // Item 2: assinatura mensal CREDIT_CARD SEM dados de cartão (via cliente do projeto).
  const refSub = `HC:homolog:${ts}`;
  const subN30 = await tentar("criarAssinatura", () =>
    cliente.criarAssinatura({
      customer: clienteId,
      billingType: "CREDIT_CARD",
      value: 10,
      nextDueDate: hoje,
      cycle: "MONTHLY",
      description: "Homologação HiperCRM (sandbox), assinatura mensal",
      externalReference: refSub,
    }),
  );
  if (!subN30.ok) throw new Error("criarAssinatura do projeto falhou; ver log acima");
  const subId = (subN30.valor as { id: string }).id;
  estado.subN30 = subId;
  estado.refSubN30 = refSub;
  salvarEstado();
  await dormir(1500);
  const subLida = await direto("GET", `/subscriptions/${subId}`);
  const pagsRaw = await direto("GET", `/subscriptions/${subId}/payments`);
  const cobs = ((pagsRaw.corpo.data as Dict[]) ?? []).map(resumoCobranca);
  const viaProjeto = await tentar("listarCobrancasDaAssinatura", () => cliente.listarCobrancasDaAssinatura(subId));
  estado.subN30Cobrancas = cobs.map((c) => ({ id: c.id, invoiceUrl: c.invoiceUrl }));
  salvarEstado();
  registrar("item2_assinatura_n30", {
    respostaDaCriacao: resumoAssinatura(sanitizar(subN30.cru) as Dict),
    assinaturaLida: resumoAssinatura(subLida.corpo),
    cobrancasDaAssinatura: cobs,
    herdaExternalReference: cobs.map((c) => ({ id: c.id, externalReference: c.externalReference, igualAoDaAssinatura: c.externalReference === refSub })),
    parseDoProjetoAceitouALista: viaProjeto.ok,
    erroDoParse: viaProjeto.erro,
  });

  // Item 4 (criação): assinatura com nextDueDate no próximo dia 31.
  const dia31 = proximoDia31();
  const ref31 = `HC:homolog:d31:${ts}`;
  const sub31 = await tentar("criarAssinatura31", () =>
    cliente.criarAssinatura({
      customer: clienteId,
      billingType: "CREDIT_CARD",
      value: 10,
      nextDueDate: dia31,
      cycle: "MONTHLY",
      description: "Homologação HiperCRM (sandbox), assinatura dia 31",
      externalReference: ref31,
    }),
  );
  if (!sub31.ok) throw new Error("criarAssinatura dia 31 falhou");
  const sub31Id = (sub31.valor as { id: string }).id;
  estado.sub31 = sub31Id;
  estado.ref31 = ref31;
  salvarEstado();
  await dormir(1500);
  const sub31Lida = await direto("GET", `/subscriptions/${sub31Id}`);
  const pags31 = await direto("GET", `/subscriptions/${sub31Id}/payments`);
  const cobs31 = ((pags31.corpo.data as Dict[]) ?? []).map(resumoCobranca);
  estado.sub31Cobrancas = cobs31.map((c) => ({ id: c.id, invoiceUrl: c.invoiceUrl }));
  salvarEstado();
  registrar("item4_dia31_antes_de_pagar", {
    nextDueDatePedido: dia31,
    respostaDaCriacao: resumoAssinatura(sanitizar(sub31.cru) as Dict),
    assinaturaLida: resumoAssinatura(sub31Lida.corpo),
    cobrancas: cobs31,
  });

  // Item 5: semestral e anual, só criar, ler e remover.
  const ciclos: Dict = {};
  for (const ciclo of ["SEMIANNUALLY", "YEARLY"]) {
    const c = await direto("POST", "/subscriptions", {
      customer: clienteId,
      billingType: "CREDIT_CARD",
      value: 10,
      nextDueDate: hoje,
      cycle: ciclo,
      description: `Homologação HiperCRM (sandbox), ciclo ${ciclo}`,
      externalReference: `HC:homolog:${ciclo}:${ts}`,
    });
    const item: Dict = { statusCriacao: c.status, corpoCriacao: c.status === 200 ? resumoAssinatura(c.corpo) : c.corpo };
    if (c.status === 200) {
      const id = c.corpo.id as string;
      const lida = await direto("GET", `/subscriptions/${id}`);
      item.leitura = { status: lida.status, cycle: lida.corpo.cycle, nextDueDate: lida.corpo.nextDueDate };
      const pg = await direto("GET", `/subscriptions/${id}/payments`);
      item.cobrancasGeradas = ((pg.corpo.data as Dict[]) ?? []).map((p) => ({ id: p.id, dueDate: p.dueDate, value: p.value, status: p.status }));
      const del = await direto("DELETE", `/subscriptions/${id}`);
      item.remocao = { status: del.status, corpo: del.corpo };
    }
    ciclos[ciclo] = item;
  }
  registrar("item5_ciclos", ciclos);

  // Item 6: cobrança parcelada em 12x, total 1899,00 (não é paga).
  const refParc = `HC:homolog:parc:${ts}`;
  const parc = await direto("POST", "/payments", {
    customer: clienteId,
    billingType: "CREDIT_CARD",
    installmentCount: 12,
    totalValue: 1899.0,
    dueDate: hojeBR(1),
    description: "Homologação HiperCRM (sandbox), anual do Pro em 12x",
    externalReference: refParc,
  });
  const parcItem: Dict = { status: parc.status, corpoCriacao: parc.status === 200 ? resumoCobranca(parc.corpo) : parc.corpo };
  if (parc.status === 200) {
    const instId = parc.corpo.installment as string | undefined;
    estado.parcelamento = instId ?? null;
    estado.parcelaPrimeira = parc.corpo.id;
    salvarEstado();
    if (instId) {
      const inst = await direto("GET", `/installments/${instId}`);
      const parcelas = await direto("GET", `/installments/${instId}/payments?limit=100`);
      parcItem.installmentObjeto = inst.corpo;
      parcItem.parcelas = ((parcelas.corpo.data as Dict[]) ?? []).map((p) => ({
        id: p.id, installmentNumber: p.installmentNumber, value: p.value, netValue: p.netValue, dueDate: p.dueDate, status: p.status, externalReference: p.externalReference,
      }));
      parcItem.totalDeParcelas = (parcelas.corpo.data as unknown[] | undefined)?.length;
      const soma = ((parcelas.corpo.data as Dict[]) ?? []).reduce((s, p) => s + Number(p.value), 0);
      parcItem.somaDasParcelas = Math.round(soma * 100) / 100;
    }
  }
  registrar("item6_parcelamento_12x", parcItem);

  // Item 8 (criação): Pix avulso + QR (via cliente do projeto).
  const refPix = `HC:homolog:pix:${ts}`;
  const pix = await tentar("criarCobranca(PIX)", () =>
    cliente.criarCobranca({
      customer: clienteId,
      billingType: "PIX",
      value: 5,
      dueDate: hojeBR(1),
      description: "Homologação HiperCRM (sandbox), Pix",
      externalReference: refPix,
    }),
  );
  const item8: Dict = { criacaoOk: pix.ok, erro: pix.erro };
  if (pix.ok) {
    const pixId = (pix.valor as { id: string }).id;
    estado.pix = pixId;
    salvarEstado();
    item8.cobranca = resumoCobranca(sanitizar(pix.cru) as Dict);
    const qr = await tentar("qrPix", () => cliente.qrPix(pixId));
    item8.qr = qr.ok
      ? {
          chaves: Object.keys((qr.cru as Dict) ?? {}).sort(),
          payloadComeco: String((qr.valor as { payload: string }).payload).slice(0, 30),
          tamanhoDoPayload: String((qr.valor as { payload: string }).payload).length,
          tamanhoDaImagemBase64: String((qr.valor as { encodedImage: string }).encodedImage).length,
          expirationDate: (qr.valor as { expirationDate?: string | null }).expirationDate,
        }
      : { erro: qr.erro };
  }
  registrar("item8_pix_criacao", item8);

  // Item 9: webhooks já existentes (endereço pode aparecer, token não).
  const wh = await direto("GET", "/webhooks");
  const lista = ((wh.corpo.data as Dict[]) ?? []).map((w) => ({
    id: w.id, name: w.name, url: w.url, enabled: w.enabled, interrupted: w.interrupted, apiVersion: w.apiVersion, sendType: w.sendType,
    eventos: Array.isArray(w.events) ? (w.events as unknown[]).length : w.events,
  }));
  registrar("item9_webhooks", { status: wh.status, totalCount: wh.corpo.totalCount, webhooks: lista });

  log("\nEtapa criar concluída. Próximo: pagar as faturas no navegador (pagar-fatura.mjs) e rodar a etapa verificar.");
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 2: verificar (depois do pagamento no navegador)
// ═══════════════════════════════════════════════════════════════════════════
async function etapaVerificar(): Promise<void> {
  const subN30 = estado.subN30 as string;
  const sub31 = estado.sub31 as string;

  // Item 3: a assinatura passou a guardar o cartão?
  for (const [rotulo, subId] of [["item3_n30_depois_de_pagar", subN30], ["item4_dia31_depois_de_pagar", sub31]] as const) {
    const sub = await direto("GET", `/subscriptions/${subId}`);
    const pgs = await direto("GET", `/subscriptions/${subId}/payments`);
    const cobs = ((pgs.corpo.data as Dict[]) ?? []).map(resumoCobranca);
    const viaProjeto = await tentar("listarCobrancasDaAssinatura", () => cliente.listarCobrancasDaAssinatura(subId));
    // Pagamento completo da primeira cobrança, para os campos de data e de cartão.
    const primeiraId = (cobs[0]?.id as string | undefined) ?? "";
    const detalhe = primeiraId ? await direto("GET", `/payments/${primeiraId}`) : null;
    registrar(rotulo, {
      assinatura: resumoAssinatura(sub.corpo),
      creditCardDaAssinatura: sub.corpo.creditCard ?? "(ausente)",
      cobrancas: cobs,
      cobrancaPrimeiraDetalhe: detalhe ? { ...resumoCobranca(detalhe.corpo), creditCard: detalhe.corpo.creditCard ?? "(ausente)", transactionReceiptUrl: detalhe.corpo.transactionReceiptUrl } : null,
      parseDoProjetoAceitouALista: viaProjeto.ok,
      erroDoParse: viaProjeto.erro,
    });
  }

  await estornoParcialEDepoisTotal();

  // Item 8 fica na etapa própria `pix-confirmar` (confirmação pelo endpoint de sandbox).
}

/**
 * Item 7: estorno parcial (R$ 4 de R$ 10) e depois do restante, na cobrança paga da N30.
 * Achado de 30/09/2026: no dia do pagamento o Asaas responde 400 `invalid_action`
 * ("só pode ser estornada parcialmente no próximo dia"). Por isso a etapa `estornar` existe
 * sozinha: rode de novo no dia seguinte ao pagamento. O restante só é tentado se o parcial passou.
 */
async function estornoParcialEDepoisTotal(): Promise<void> {
  const primeira = ((estado.subN30Cobrancas as Dict[]) ?? [])[0]?.id as string | undefined;
  if (!primeira) {
    registrar("item7_estorno", { pulado: "sem cobrança da N30 em estado.json" });
    return;
  }
  const antes = await direto("GET", `/payments/${primeira}`);
  const parcial = await direto("POST", `/payments/${primeira}/refund`, { value: 4.0, description: "Homologação: estorno parcial" });
  await dormir(2000);
  const depoisParcial = await direto("GET", `/payments/${primeira}`);
  const saida: Dict = {
    cobranca: primeira,
    data: hojeBR(),
    antes: resumoCobranca(antes.corpo),
    estornoParcial: { status: parcial.status, statusDaCobranca: parcial.corpo.status, refunds: parcial.corpo.refunds, erros: parcial.status === 200 ? undefined : parcial.corpo.errors },
    depoisDoParcial: resumoCobranca(depoisParcial.corpo),
  };
  if (parcial.status === 200) {
    const restante = await direto("POST", `/payments/${primeira}/refund`, { value: 6.0, description: "Homologação: estorno do restante" });
    await dormir(2000);
    const depoisTotal = await direto("GET", `/payments/${primeira}`);
    saida.estornoDoRestante = { status: restante.status, statusDaCobranca: restante.corpo.status, refunds: restante.corpo.refunds, erros: restante.status === 200 ? undefined : restante.corpo.errors };
    saida.depoisDoTotal = resumoCobranca(depoisTotal.corpo);
  } else {
    saida.estornoDoRestante = "não tentado: o parcial foi recusado";
  }
  const lista = await direto("GET", `/payments/${primeira}/refunds`);
  saida.endpointRefunds = { status: lista.status, corpo: lista.corpo };
  registrar("item7_estorno", saida);
}

/** Estorno TOTAL (sem `value`) da cobrança de sonda, paga hoje pela API: prova o status final do estorno total no mesmo dia. */
async function etapaEstornoTotalSonda(): Promise<void> {
  const id = estado.sonda as string | undefined;
  if (!id) throw new Error("sem estado.sonda (rode cartao-api antes)");
  const antes = await direto("GET", `/payments/${id}`);
  const r = await direto("POST", `/payments/${id}/refund`, { description: "Homologação: estorno total" });
  const respostas: Dict[] = [{ momento: "logo após", status: r.status, statusDaCobranca: r.corpo.status, refunds: r.corpo.refunds, erros: r.status === 200 ? undefined : r.corpo.errors }];
  for (const espera of [3000, 8000]) {
    await dormir(espera);
    const d = await direto("GET", `/payments/${id}`);
    respostas.push({ aposMs: espera, status: d.corpo.status, refunds: d.corpo.refunds });
  }
  const lista = await direto("GET", `/payments/${id}/refunds`);
  registrar("estorno_total_sonda", { cobranca: id, antes: resumoCobranca(antes.corpo), respostas, endpointRefunds: lista.corpo });
}

/** Pix: cria uma cobrança nova e confirma pelo endpoint de simulação do sandbox (POST /sandbox/payment/{id}/confirm). */
async function etapaPixConfirmar(): Promise<void> {
  const ts = Date.now();
  const c = await tentar("criarCobranca(PIX)", () =>
    cliente.criarCobranca({
      customer: estado.clienteId as string,
      billingType: "PIX",
      value: 5,
      dueDate: hojeBR(1),
      description: "Homologação HiperCRM (sandbox), Pix para confirmar",
      externalReference: `HC:homolog:pixc:${ts}`,
    }),
  );
  if (!c.ok) throw new Error("criar Pix falhou");
  const id = (c.valor as { id: string }).id;
  estado.pixConfirmar = id;
  salvarEstado();
  const conf = await direto("POST", `/sandbox/payment/${id}/confirm`, {});
  await dormir(2000);
  const depois = await direto("GET", `/payments/${id}`);
  registrar("item8_pix_confirmacao_sandbox", {
    cobranca: id,
    confirm: { status: conf.status, statusDaCobranca: conf.corpo.status, corpo: conf.status === 200 ? undefined : conf.corpo },
    depois: resumoCobranca(depois.corpo),
  });
}

/**
 * Complemento do item 6 (NÃO é o 12x de R$ 1.899, que fica sem pagar): um parcelamento pequeno
 * (3x, R$ 30) com o cartão de teste na criação, para ver o `creditDate` de cada parcela.
 */
async function etapaParceladoPago(): Promise<void> {
  const ts = Date.now();
  const r = await direto("POST", "/payments", {
    customer: estado.clienteId,
    billingType: "CREDIT_CARD",
    installmentCount: 3,
    totalValue: 30,
    dueDate: hojeBR(),
    description: "Homologação HiperCRM (sandbox), 3x paga pela API",
    externalReference: `HC:homolog:parc3:${ts}`,
    creditCard: { holderName: "HOMOLOGACAO HIPERCRM", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" },
    creditCardHolderInfo: {
      name: "Homologação HiperCRM",
      email: `homolog-${ts}@example.com`,
      cpfCnpj: cpfGerado(),
      postalCode: "01001000",
      addressNumber: "1",
      phone: "1133334444",
      mobilePhone: "11988887777",
    },
    remoteIp: "203.0.113.10",
  });
  const saida: Dict = { status: r.status, erros: r.status === 200 ? undefined : r.corpo.errors };
  if (r.status === 200) {
    const inst = r.corpo.installment as string;
    estado.parcelado3 = inst;
    salvarEstado();
    await dormir(2000);
    const parcelas = await direto("GET", `/installments/${inst}/payments?limit=100`);
    saida.parcelas = ((parcelas.corpo.data as Dict[]) ?? []).map((p) => ({
      installmentNumber: p.installmentNumber, status: p.status, value: p.value, netValue: p.netValue, dueDate: p.dueDate,
      confirmedDate: p.confirmedDate, paymentDate: p.paymentDate, creditDate: p.creditDate, estimatedCreditDate: p.estimatedCreditDate,
    }));
  }
  registrar("parcelado_3x_pago_pela_api", saida);
}

/**
 * Item 3 de verdade: a fatura hospedada só se paga em navegador de gente (reCAPTCHA Enterprise
 * recusa o automatizado). Esta etapa cria uma assinatura CREDIT_CARD sem cartão e imprime a URL
 * da fatura; pague à mão com o cartão de teste e rode `fatura-manual-ler` para ver se a
 * assinatura passou a guardar o cartão (campo `creditCard`).
 */
async function etapaFaturaManual(): Promise<void> {
  const ts = Date.now();
  const sub = await tentar("criarAssinatura(manual)", () =>
    cliente.criarAssinatura({
      customer: estado.clienteId as string,
      billingType: "CREDIT_CARD",
      value: 10,
      nextDueDate: hojeBR(),
      cycle: "MONTHLY",
      description: "Homologação HiperCRM (sandbox), fatura paga à mão",
      externalReference: `HC:homolog:manual:${ts}`,
    }),
  );
  if (!sub.ok) throw new Error("criar assinatura manual falhou");
  const id = (sub.valor as { id: string }).id;
  estado.subManual = id;
  await dormir(1500);
  const cobs = await cliente.listarCobrancasDaAssinatura(id);
  estado.manualCobranca = cobs[0]?.id;
  estado.manualInvoiceUrl = cobs[0]?.invoiceUrl;
  salvarEstado();
  log(`
Pague à mão (cartão de teste do sandbox, ex. 4444 4444 4444 4444, CCV 123, validade futura):
${String(cobs[0]?.invoiceUrl)}
Depois rode: fatura-manual-ler`);
}

async function etapaFaturaManualLer(): Promise<void> {
  const id = estado.subManual as string | undefined;
  if (!id) throw new Error("sem estado.subManual (rode fatura-manual antes)");
  const sub = await direto("GET", `/subscriptions/${id}`);
  const pg = await direto("GET", `/payments/${estado.manualCobranca as string}`);
  registrar("item3_fatura_paga_a_mao", {
    assinatura: resumoAssinatura(sub.corpo),
    creditCardDaAssinatura: sub.corpo.creditCard ?? "(ausente)",
    cobranca: { ...resumoCobranca(pg.corpo), creditCard: pg.corpo.creditCard ?? "(ausente)" },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapa 3: limpar (item 10)
// ═══════════════════════════════════════════════════════════════════════════
async function etapaLimpar(): Promise<void> {
  const saida: Dict = {};
  for (const [rotulo, id] of [["subN30", estado.subN30], ["sub31", estado.sub31], ["subManual", estado.subManual]] as const) {
    if (!id) continue;
    const r = await tentar(`removerAssinatura(${rotulo})`, () => cliente.removerAssinatura(id as string));
    const depois = await tentar("buscarAssinatura", () => cliente.buscarAssinatura(id as string));
    saida[rotulo] = { removida: r.ok, aposRemocao: depois.valor, id };
  }
  // Cobranças abertas que sobraram (as pagas/estornadas ficam como histórico).
  const abertas: Dict[] = [];
  const restos: string[] = [];
  const parcelamento = estado.parcelamento as string | undefined;
  if (parcelamento) {
    const del = await direto("DELETE", `/installments/${parcelamento}`);
    abertas.push({ rota: `DELETE /installments/${parcelamento}`, status: del.status, corpo: del.corpo });
  }
  for (const k of ["pix", "pixConfirmar", "sonda", "manualCobranca"]) if (estado[k]) restos.push(estado[k] as string);
  if ((estado.avulsa as Dict | undefined)?.id) restos.push((estado.avulsa as Dict).id as string);
  for (const id of restos) {
    const p = await direto("GET", `/payments/${id}`);
    if (p.corpo.status === "PENDING" || p.corpo.status === "OVERDUE") {
      const d = await tentar(`removerCobranca(${id})`, () => cliente.removerCobranca(id));
      abertas.push({ id, statusAntes: p.corpo.status, removida: d.ok });
    } else {
      abertas.push({ id, statusAntes: p.corpo.status, removida: false, motivo: "não está aberta, fica como histórico" });
    }
  }
  saida.cobrancas = abertas;

  // O que sobrou nesta conta para o cliente de teste.
  const cid = estado.clienteId as string;
  const subsRest = await direto("GET", `/subscriptions?customer=${cid}`);
  const pagsRest = await direto("GET", `/payments?customer=${cid}&limit=100`);
  saida.sobras = {
    assinaturas: ((subsRest.corpo.data as Dict[]) ?? []).map((s) => ({ id: s.id, status: s.status, deleted: s.deleted })),
    cobrancas: ((pagsRest.corpo.data as Dict[]) ?? []).map((p) => ({ id: p.id, status: p.status, billingType: p.billingType, value: p.value, deleted: p.deleted })),
  };
  registrar("item10_limpeza", saida);
}

/** Leitura rápida: status das cobranças de teste (não grava nada). */
async function etapaStatus(): Promise<void> {
  const ids = [
    ...((estado.subN30Cobrancas as Dict[]) ?? []),
    ...((estado.sub31Cobrancas as Dict[]) ?? []),
  ].map((c) => c.id as string);
  for (const id of ids) {
    const p = await direto("GET", `/payments/${id}`);
    log(`${id}: status=${String(p.corpo.status)} paymentDate=${String(p.corpo.paymentDate)} confirmedDate=${String(p.corpo.confirmedDate)}`);
  }
}

/**
 * Sonda: a conta sandbox aceita pagamento com cartão pela API? Cria uma cobrança
 * avulsa CREDIT_CARD de R$ 5 e tenta `payWithCreditCard` com os cartões de teste.
 * Serve para separar "fatura hospedada recusa automação (reCAPTCHA)" de "conta sem cartão".
 */
async function etapaCartaoApi(): Promise<void> {
  const ts = Date.now();
  const criada = await direto("POST", "/payments", {
    customer: estado.clienteId,
    billingType: "CREDIT_CARD",
    value: 5,
    dueDate: hojeBR(),
    description: "Homologação HiperCRM (sandbox), sonda de cartão pela API",
    externalReference: `HC:homolog:sonda:${ts}`,
  });
  if (criada.status !== 200) throw new Error(`sonda: ${criada.status} ${JSON.stringify(criada.corpo)}`);
  const id = criada.corpo.id as string;
  estado.sonda = id;
  salvarEstado();
  const saida: Dict = { cobranca: id, tentativas: [] };
  for (const numero of ["4444444444444444", "4111111111111111"]) {
    const r = await direto("POST", `/payments/${id}/payWithCreditCard`, {
      creditCard: { holderName: "HOMOLOGACAO HIPERCRM", number: numero, expiryMonth: "12", expiryYear: "2030", ccv: "123" },
      creditCardHolderInfo: {
        name: "Homologação HiperCRM",
        email: `homolog-${ts}@example.com`,
        cpfCnpj: cpfGerado(),
        postalCode: "01001000",
        addressNumber: "1",
        phone: "1133334444",
        mobilePhone: "11988887777",
      },
      remoteIp: "203.0.113.10",
    });
    (saida.tentativas as Dict[]).push({
      cartaoTermina: numero.slice(-4),
      status: r.status,
      statusDaCobranca: r.corpo.status,
      chavesCreditCard: r.corpo.creditCard,
      erros: r.status === 200 ? undefined : r.corpo.errors,
    });
    if (r.status === 200) break;
  }
  const depois = await direto("GET", `/payments/${id}`);
  saida.cobrancaDepois = resumoCobranca(depois.corpo);
  saida.creditCardDaCobranca = depois.corpo.creditCard ?? "(ausente)";
  registrar("sonda_cartao_api", saida);
}

/** Cobrança avulsa CREDIT_CARD de R$ 5 só para pagar na fatura hospedada (compara com a da assinatura). */
async function etapaAvulsaFatura(): Promise<void> {
  const ts = Date.now();
  const c = await direto("POST", "/payments", {
    customer: estado.clienteId,
    billingType: "CREDIT_CARD",
    value: 5,
    dueDate: hojeBR(),
    description: "Homologação HiperCRM (sandbox), avulsa para a fatura",
    externalReference: `HC:homolog:avulsa:${ts}`,
  });
  if (c.status !== 200) throw new Error(`avulsa: ${c.status} ${JSON.stringify(c.corpo)}`);
  estado.avulsa = { id: c.corpo.id, invoiceUrl: c.corpo.invoiceUrl };
  salvarEstado();
  registrar("avulsa_para_fatura", resumoCobranca(c.corpo));
}

/**
 * Plano B do pagamento: a fatura hospedada do sandbox usa reCAPTCHA Enterprise e recusa
 * navegador automatizado ("erro desconhecido" em /creditCard/pay). Esta etapa paga as duas
 * cobranças de assinatura por `POST /payments/{id}/payWithCreditCard` (cartão de teste na
 * chamada). ATENÇÃO: isso NÃO mede o que a fatura hospedada faz com o cartão (item 3); mede
 * datas, status e o efeito na assinatura quando o cartão entra pela API.
 */
async function etapaPagarApi(): Promise<void> {
  const alvos: Array<[string, string]> = [
    ["n30", ((estado.subN30Cobrancas as Dict[]) ?? [])[0]?.id as string],
    ["d31", ((estado.sub31Cobrancas as Dict[]) ?? [])[0]?.id as string],
  ];
  const saida: Dict = {};
  for (const [rotulo, id] of alvos) {
    if (!id) continue;
    const r = await direto("POST", `/payments/${id}/payWithCreditCard`, {
      creditCard: { holderName: "HOMOLOGACAO HIPERCRM", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" },
      creditCardHolderInfo: {
        name: "Homologação HiperCRM",
        email: `homolog-${estado.timestamp as number}@example.com`,
        cpfCnpj: cpfGerado(),
        postalCode: "01001000",
        addressNumber: "1",
        phone: "1133334444",
        mobilePhone: "11988887777",
      },
      remoteIp: "203.0.113.10",
    });
    saida[rotulo] = { cobranca: id, status: r.status, statusDaCobranca: r.corpo.status, creditCard: r.corpo.creditCard, erros: r.status === 200 ? undefined : r.corpo.errors };
  }
  registrar("pagamento_pela_api", saida);
}

const etapa = process.argv[2];
if (etapa === "criar") await etapaCriar();
else if (etapa === "verificar") await etapaVerificar();
else if (etapa === "avulsa-fatura") await etapaAvulsaFatura();
else if (etapa === "pagar-api") await etapaPagarApi();
else if (etapa === "estornar") await estornoParcialEDepoisTotal();
else if (etapa === "estornar-total-sonda") await etapaEstornoTotalSonda();
else if (etapa === "pix-confirmar") await etapaPixConfirmar();
else if (etapa === "parcelado-pago") await etapaParceladoPago();
else if (etapa === "fatura-manual") await etapaFaturaManual();
else if (etapa === "fatura-manual-ler") await etapaFaturaManualLer();
else if (etapa === "status") await etapaStatus();
else if (etapa === "cartao-api") await etapaCartaoApi();
else if (etapa === "limpar") await etapaLimpar();
else {
  console.error("uso: tsx hiperbold/scripts/homologar-asaas-sandbox.mts <criar|status|cartao-api|pagar-api|pix-confirmar|verificar|estornar|estornar-total-sonda|parcelado-pago|fatura-manual|fatura-manual-ler|limpar>");
  process.exit(1);
}
