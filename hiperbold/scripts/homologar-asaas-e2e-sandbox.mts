/**
 * Homologação PONTA A PONTA do fluxo de compra do CRM contra o SANDBOX do Asaas
 * (D-071, parte 2). Complementa `homologar-asaas-sandbox.mts` (parte 1, que mediu
 * o comportamento da API). Aqui o que roda é o código do PRÓPRIO CRM, com as
 * dependências reais: `iniciarCompra` (banco local + cliente Asaas de sandbox),
 * o HANDLER da rota `/api/v1/webhooks/asaas` chamado direto no processo (sem
 * subir servidor), `processarEventosAsaas` e `cancelarAssinaturaDoCliente`.
 *
 * ═══ Travas (não negociáveis; o script RECUSA e sai com código 2 se alguma falhar) ═══
 *  1. `ASAAS_BASE_URL` precisa ser exatamente https://api-sandbox.asaas.com/v3 e
 *     `ASAAS_API_KEY` precisa começar por `$aact_hmlg_`.
 *  2. `NEXT_PUBLIC_SUPABASE_URL` precisa apontar para o host LOCAL (127.0.0.1 ou
 *     localhost). Nunca fala com um banco remoto nem com produção.
 *  3. O backup do banco local precisa existir e ter tamanho > 0
 *     (BACKUP_DUMP, padrão /mnt/f/temp/2026-09-30/asaas/banco-local-antes-e2e.dump).
 *     Gerar com: docker exec supabase_db_deskcomm-crm pg_dump -U postgres -d postgres -Fc > <arquivo>
 *  4. O script só ESCREVE no banco em: (a) `billing_settings` (chaves de teste,
 *     valor anterior anotado em estado.json), (b) `billing_plans.for_sale` pela
 *     função oficial, (c) as organizações de teste criadas por ele ("Homologação
 *     Asaas <data>": A e B no roteiro mensal; C e D nas etapas de ciclo) e nas tabelas
 *     dessas organizações e de `asaas_webhook_events`.
 *     Nunca apaga nada, nunca toca em organização ou usuário existente. O
 *     processador de eventos é global por natureza: antes de cada rodada o script
 *     confere que não há evento pendente que não seja dele e aborta se houver.
 *  5. Nunca imprime nem grava a chave do Asaas, o token do webhook, a service role
 *     key nem o conteúdo do `.env.local` (toda saída passa por `redigir()`).
 *     O ambiente é carregado por `@next/env`, sem ler o arquivo à mão. Se o
 *     ASAAS_WEBHOOK_TOKEN do ambiente não tiver formato válido (32 a 255
 *     caracteres e diferente da chave), o script gera um em MEMÓRIA, só para a
 *     execução, e anota isso (não grava em lugar nenhum).
 *  6. Cliente de teste: CPF gerado (dígito verificador), e-mail em example.com,
 *     `notificationDisabled: true` (aplicado por PUT logo depois de o CRM criar o cliente,
 *     porque o schema do CRM descarta o campo, ver achado 1 da parte 1).
 *
 * ═══ Como rodar (no WSL, na raiz do repositório) ═══
 *   node_modules/.bin/tsx hiperbold/scripts/homologar-asaas-e2e-sandbox.mts <etapa>
 *
 * Etapas (a ordem é a do roteiro; `tudo` roda todas em sequência, parando no primeiro erro):
 *   preparar       passo 1: backup conferido, pré-condições no banco local, cria as 2 organizações.
 *   compra-a       passo 2: iniciarCompra do Pro mensal no cartão (organização A).
 *   pagar-a        passo 3: paga a primeira cobrança pela API do sandbox (payWithCreditCard).
 *   webhook-a      passos 4 e 5: PAYMENT_CONFIRMED no handler (antes com a chave de sandbox
 *                  desligada, depois ligada + reprocesso), token errado, reentrega, PAYMENT_RECEIVED.
 *   dia31-b        passo 6: organização B com período pago até 30/10 (vencimento no dia 31),
 *                  compra + pagamento + webhook, e compara com o Asaas.
 *   estornar-a     passo 7: estorno total pelo Asaas + PAYMENT_REFUNDED no handler.
 *   recompra-a     extra do passo 7: depois do estorno, a organização A consegue comprar de novo? (sem chamar o Asaas)
 *   cancelar-b     passo 8: cancelarAssinaturaDoCliente na organização B (+ SUBSCRIPTION_DELETED).
 *   limpar         passo 9: remove no Asaas as assinaturas de teste abertas (não apaga nada no banco).
 *
 * Etapas de ciclo (D-176, venda semestral e anual à vista). Rodam sozinhas, SEM as etapas acima, com
 * `ciclos` (todas em sequência) ou uma a uma. Cada uma cria a compra pelo fluxo do CRM (iniciarCompra),
 * paga a primeira cobrança pela API do sandbox e entrega PAYMENT_CONFIRMED ao handler, como o roteiro mensal:
 *   preparar-ciclos  confere os preços do catálogo (Pro 104900 e 189900), liga compra, venda do Pro e
 *                    asaas_sandbox_concede no banco LOCAL e cria as organizações C e D.
 *   semestral-c      Pro semestral no cartão: assinatura SEMIANNUALLY de R$ 1.049,00, nextDueDate 6 meses
 *                    adiante, contrato semiannual com período de 6 meses mais 1 dia, tokens do plano.
 *   anual-d          Pro anual no cartão: assinatura YEARLY de R$ 1.899,00, período de 12 meses mais 1 dia.
 *   troca-de-ciclo   a organização D (anual ativa) tenta mensal e semestral: recusada com a mensagem de
 *                    troca de ciclo e SEM nenhuma chamada ao Asaas; tentar o mesmo anual de novo recusa
 *                    por assinatura ativa.
 *   estornar-c       estorno total da cobrança do semestral: corta o contrato e zera os tokens do mês.
 *   cancelar-d       cancelamento do anual pelo cliente (DELETE da assinatura, acesso até o fim do período).
 *   parcelado-semestral-e  D-177: Pro semestral em 4x (com juros) na organização E: cobrança PARCELADA avulsa
 *                    (sem assinatura) de R$ 1.101,72, paga pela API (payWithCreditCard na primeira parcela), os
 *                    PAYMENT_CONFIRMED de TODAS as parcelas entregues ao handler; confere período concedido uma
 *                    vez, total, tokens e que nada renova (contrato sem assinatura do Asaas).
 *   parcelado-semestral-3x-f  D-177: Pro semestral em 3x (sem juros) na organização F, mesma conferência. O total de
 *                    R$ 1.049,00 NÃO divide por 3 (o anual, R$ 1.899,00, dividia: 3 x R$ 633,00, e não provava
 *                    nada): a etapa confere e registra o `value` de GET /installments contra o totalValue enviado
 *                    (tem de ser o TOTAL, não a soma das parcelas arredondadas) e registra o estado de TODAS as
 *                    parcelas logo depois de pagar a primeira por API (prova se o cartão autoriza o total de uma vez:
 *                    a concessão do período exige todas as parcelas CONFIRMED ou RECEIVED, D-177 M2).
 *                    Se a API do sandbox não pagar o parcelamento, a etapa imprime a fatura para pagar à mão
 *                    (como a `fatura-manual` do roteiro mensal) e para; rodar de novo a etapa depois de pagar.
 *   limpar           o mesmo do roteiro mensal, agora para A, B, C, D, E e F (e remove parcelamentos pendentes).
 * A renovação do semestral e do anual (cobrança nova daqui a 6 e 12 meses) não dá para observar no sandbox:
 * ela é coberta pelos testes de banco (tests/invariants/venda-semestral-e-anual-banco.test.ts).
 *
 * Variáveis: HOMOLOG_E2E_DIR (padrão /mnt/f/temp/2026-09-30/asaas/e2e), BACKUP_DUMP.
 * Estado em $HOMOLOG_E2E_DIR/estado.json; resultados (sem segredo) em resultados.json.
 * O `server-only` do projeto não existe fora do Next: um hook de resolução o aponta
 * para o módulo vazio do próprio Next (mesmo truque da parte 1).
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import * as nodeModule from "node:module";

const require = createRequire(import.meta.url);
const RAIZ = process.cwd();

// ─── server-only -> módulo vazio ──────────────────────────────────────────
const VAZIO = pathToFileURL(join(RAIZ, "node_modules/next/dist/compiled/server-only/empty.js")).href;
(nodeModule as unknown as {
  registerHooks: (h: {
    resolve: (spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) => unknown;
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
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

function recusar(motivo: string): never {
  console.error(`[homologar-e2e] RECUSADO: ${motivo} Nada foi chamado.`);
  process.exit(2);
}

// Trava 1: só sandbox.
if (BASE !== BASE_SANDBOX || !CHAVE.startsWith("$aact_hmlg_")) {
  recusar(`só roda com ASAAS_BASE_URL=${BASE_SANDBOX} e ASAAS_API_KEY começando com $aact_hmlg_.`);
}
// Trava 2: só banco local.
{
  let host = "";
  try {
    host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    /* host vazio */
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    recusar("NEXT_PUBLIC_SUPABASE_URL não aponta para o host local (127.0.0.1 ou localhost).");
  }
  if (!SERVICE_KEY) recusar("SUPABASE_SERVICE_ROLE_KEY ausente.");
}
// Trava 3: backup feito.
const BACKUP = process.env.BACKUP_DUMP ?? "/mnt/f/temp/2026-09-30/asaas/banco-local-antes-e2e.dump";
if (!existsSync(BACKUP) || statSync(BACKUP).size <= 0) {
  recusar(`backup do banco local ausente ou vazio (${BACKUP}). Faça o pg_dump antes.`);
}
const BACKUP_BYTES = statSync(BACKUP).size;

// Token do webhook: o do ambiente se tiver formato válido; senão um em memória (antes de importar lib/env).
let tokenEmMemoria = false;
{
  const t = (process.env.ASAAS_WEBHOOK_TOKEN ?? "").trim();
  if (t.length < 32 || t.length > 255 || t === CHAVE) {
    process.env.ASAAS_WEBHOOK_TOKEN = randomBytes(24).toString("hex");
    tokenEmMemoria = true;
  }
}
const TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN ?? "").trim();
const SEGREDOS = [CHAVE, TOKEN, SERVICE_KEY].filter((s) => s.length > 0);

// ─── Saída sem segredo ────────────────────────────────────────────────────
function redigir(texto: string): string {
  let t = texto;
  for (const s of SEGREDOS) t = t.split(s).join("<segredo>");
  return t;
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
function sanitizar(valor: unknown): unknown {
  const texto = redigir(JSON.stringify(valor ?? null));
  return mascarar(JSON.parse(texto));
}
function log(msg: string): void {
  console.log(redigir(msg));
}

// ─── Estado e resultados ──────────────────────────────────────────────────
type Dict = Record<string, unknown>;
/** A, B: roteiro original (mensal). C, D: etapas de ciclo (semestral e anual, D-176). E, F: parcelado (D-177). */
type Letra = "A" | "B" | "C" | "D" | "E" | "F";
type CicloDeTeste = "monthly" | "semiannual" | "yearly";
interface OfertaDeTeste {
  ciclo: CicloDeTeste;
  cicloAsaas: "MONTHLY" | "SEMIANNUALLY" | "YEARLY";
  meses: number;
  /** O preço do período no catálogo (centavos), da decisão do Filipe em 29/09/2026 para o Pro. */
  valorCents: number;
  nome: string;
}
const OFERTAS: Record<CicloDeTeste, OfertaDeTeste> = {
  monthly: { ciclo: "monthly", cicloAsaas: "MONTHLY", meses: 1, valorCents: 19900, nome: "mensal" },
  semiannual: { ciclo: "semiannual", cicloAsaas: "SEMIANNUALLY", meses: 6, valorCents: 104900, nome: "semestral" },
  yearly: { ciclo: "yearly", cicloAsaas: "YEARLY", meses: 12, valorCents: 189900, nome: "anual" },
};
const reais = (centavos: number): string => `R$ ${(centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
const DIR = process.env.HOMOLOG_E2E_DIR ?? "/mnt/f/temp/2026-09-30/asaas/e2e";
mkdirSync(DIR, { recursive: true });
const ARQ_ESTADO = join(DIR, "estado.json");
const ARQ_RESULT = join(DIR, "resultados.json");
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
  log(`[${chave}] ${JSON.stringify(sanitizar(valor)).slice(0, 1500)}`);
}
const checagens: Array<{ nome: string; ok: boolean; detalhe?: unknown }> = (estado.checagens as never) ?? [];
estado.checagens = checagens;
function checar(nome: string, ok: boolean, detalhe?: unknown): boolean {
  checagens.push({ nome, ok, detalhe: sanitizar(detalhe) });
  salvarEstado();
  log(`  ${ok ? "OK    " : "FALHOU"} ${nome}${ok || detalhe === undefined ? "" : ` -> ${JSON.stringify(sanitizar(detalhe)).slice(0, 400)}`}`);
  return ok;
}

// ─── Datas (fuso do Brasil) e CPF gerado ──────────────────────────────────
function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}
function agoraAsaas(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}
function partesData(d: string): [number, number, number] {
  const [a, m, dia] = d.split("-").map(Number) as [number, number, number];
  return [a, m, dia];
}
function fmt(a: number, m: number, d: number): string {
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** due + N meses "por calendário, com clamp no último dia do mês" (o que o interval do Postgres faz). */
function maisMeses(d: string, n: number): string {
  const [a, m, dia] = partesData(d);
  const total = a * 12 + (m - 1) + n;
  const na = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(na, nm, 0)).getUTCDate();
  return fmt(na, nm, Math.min(dia, ultimo));
}
function maisUmDia(d: string): string {
  const [a, m, dia] = partesData(d);
  const t = new Date(Date.UTC(a, m - 1, dia) + 86_400_000);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/** Meia-noite de São Paulo (sem horário de verão desde 2019: UTC-3) como instante em ms. */
function meiaNoiteSP(d: string): number {
  return new Date(`${d}T00:00:00-03:00`).getTime();
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
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP do Asaas: registro de TODA chamada do cliente do projeto ────────
const httpLog: string[] = [];
const fetchRegistrado: typeof fetch = async (url, init) => {
  const u = new URL(String(url));
  httpLog.push(`${(init?.method ?? "GET").toUpperCase()} ${u.pathname.replace("/v3", "")}${u.search}`);
  return fetch(url, init);
};

/** Chamada direta (o que o cliente do projeto não cobre): status + corpo cru sanitizado. */
async function direto(metodo: "GET" | "POST" | "DELETE" | "PUT", caminho: string, corpo?: unknown) {
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { access_token: CHAVE, "Content-Type": "application/json", "User-Agent": "HiperCRM/1.0" },
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

// ─── Projeto: módulos reais ───────────────────────────────────────────────
const imp = (p: string) => import(pathToFileURL(join(RAIZ, p)).href);
const { criarClienteAsaas } = (await imp("lib/billing/asaas/cliente.ts")) as typeof import("../../lib/billing/asaas/cliente");
const { iniciarCompra, cancelarAssinaturaDoCliente, MENSAGEM_TROCA_DE_CICLO } = (await imp("lib/billing/asaas/compra.ts")) as typeof import("../../lib/billing/asaas/compra");
const { dbCompraSupabase } = (await imp("lib/billing/asaas/db-compra-supabase.ts")) as typeof import("../../lib/billing/asaas/db-compra-supabase");
const { VERSAO_DOS_TERMOS } = (await imp("lib/legal/versao-dos-termos.ts")) as typeof import("../../lib/legal/versao-dos-termos");
const { criarDbEventosAsaasSobre, processarEventosAsaas } = (await imp("lib/billing/asaas/processar-eventos.ts")) as typeof import("../../lib/billing/asaas/processar-eventos");
const { createAdminClient } = (await imp("lib/supabase/admin.ts")) as typeof import("../../lib/supabase/admin");
const rotaWebhook = (await imp("app/api/v1/webhooks/asaas/route.ts")) as typeof import("../../app/api/v1/webhooks/asaas/route");
const { NextRequest } = require(require.resolve("next/server", { paths: [RAIZ] })) as typeof import("next/server");

type ClienteAsaasHttp = ReturnType<typeof criarClienteAsaas>;

const admin = createAdminClient();
const ATOR = "00000000-0000-4000-8000-0000000e2e00";
const config = {
  habilitado: true,
  baseUrl: BASE,
  apiKey: CHAVE,
  webhookToken: "",
  webhookId: "",
  ambiente: "sandbox" as const,
};

const avisos: string[] = [];
const loggerCap = {
  warn: (m: string, c?: Record<string, unknown>) => avisos.push(`warn ${m} ${JSON.stringify(c ?? {})}`),
  error: (m: string, c?: Record<string, unknown>) => avisos.push(`error ${m} ${JSON.stringify(c ?? {})}`),
};

const chamadasCliente: string[] = [];
function gravandoChamadas(c: ClienteAsaasHttp): ClienteAsaasHttp {
  const saida = {} as Record<string, unknown>;
  for (const [k, fn] of Object.entries(c)) {
    saida[k] = (...args: unknown[]) => {
      const strs = args.filter((a) => typeof a === "string") as string[];
      chamadasCliente.push(`${k}(${strs.join(",")})`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return saida as unknown as ClienteAsaasHttp;
}
const clienteReal = criarClienteAsaas({ fetch: fetchRegistrado, config, logger: loggerCap });
/** O CRM cria o cliente sem `notificationDisabled` (schema descarta); aqui o PUT logo depois desliga os e-mails do Asaas. */
const clienteDeTeste: ClienteAsaasHttp = {
  ...clienteReal,
  async criarCliente(dados) {
    const criado = await clienteReal.criarCliente(dados);
    await direto("PUT", `/customers/${criado.id}`, { notificationDisabled: true });
    return criado;
  },
};
const asaas = gravandoChamadas(clienteDeTeste);
const depsCompra = { db: dbCompraSupabase(admin), asaas, config, logger: loggerCap };
const dbEventos = criarDbEventosAsaasSobre(admin);

// ─── Banco: leituras (service role, só das organizações de teste) ─────────
async function sel(tabela: string, org: string, colunas = "*"): Promise<Dict[]> {
  const { data, error } = await admin.from(tabela).select(colunas).eq("organization_id", org);
  if (error) throw new Error(`select ${tabela}: ${error.message}`);
  return (data ?? []) as unknown as Dict[];
}
async function foto(org: string): Promise<Dict> {
  return {
    contrato: (await sel("billing_contracts", org))[0] ?? null,
    pedidos: await sel("billing_orders", org),
    pagamentos: await sel("billing_payments", org),
    clientes: await sel("billing_customers", org),
    carteiras: await sel("billing_token_wallets", org),
    livro: await sel("billing_token_ledger", org),
    eventosDoContrato: await sel("billing_contract_eventos", org),
  };
}
async function evento(eventId: string): Promise<Dict | null> {
  const { data, error } = await admin
    .from("asaas_webhook_events")
    .select("id, event_id, event_type, resource_id, ambiente, origem, resultado, erro_codigo, tentativas, organization_id, alarme, processado_em, payload")
    .eq("event_id", eventId);
  if (error) throw new Error(`select asaas_webhook_events: ${error.message}`);
  return ((data ?? [])[0] as Dict | undefined) ?? null;
}
async function contarEventos(): Promise<number> {
  const { count, error } = await admin.from("asaas_webhook_events").select("id", { count: "exact", head: true });
  if (error) throw new Error(`count asaas_webhook_events: ${error.message}`);
  return count ?? 0;
}
/** Há alguma CHAVE (em qualquer profundidade) com "card" no nome? (valores como "CREDIT_CARD" não contam.) */
function temChaveDeCartao(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(temChaveDeCartao);
  if (v && typeof v === "object") {
    return Object.entries(v as Dict).some(([k, x]) => k.toLowerCase().includes("card") || temChaveDeCartao(x));
  }
  return false;
}
function resumoEvento(e: Dict | null): Dict | null {
  if (!e) return null;
  const { payload: _p, ...resto } = e;
  return resto;
}
function ms(v: unknown): number {
  return v ? new Date(String(v)).getTime() : Number.NaN;
}
function iso(v: unknown): string | null {
  return v ? new Date(String(v)).toISOString() : null;
}

const org = (l: Letra): string => {
  const id = estado[`org${l}`] as string | undefined;
  if (!id) throw new Error(`sem organização ${l}: rode "preparar" antes`);
  return id;
};

// ─── Webhook: monta o evento no formato real e entrega ao HANDLER ─────────
function novoEventoId(): string {
  return `evt_${randomBytes(16).toString("hex")}&${Math.floor(Math.random() * 900_000_000 + 100_000_000)}`;
}
function montarEvento(tipo: string, recurso: Dict, chave: "payment" | "subscription", id = novoEventoId()): Dict {
  return { id, event: tipo, dateCreated: agoraAsaas(), [chave]: recurso };
}
async function entregar(evt: Dict, token: string | null | "sem-cabecalho" = null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== "sem-cabecalho") headers["asaas-access-token"] = token ?? TOKEN;
  const req = new NextRequest("http://localhost:3300/api/v1/webhooks/asaas", {
    method: "POST",
    headers,
    body: JSON.stringify(evt),
  });
  const res = await rotaWebhook.POST(req);
  return { status: res.status, corpo: await res.text() };
}

/** Roda UMA rodada do processador real; confere antes que não há evento pendente alheio. */
async function processar(): Promise<{ resumo: Dict; http: string[]; chamadas: string[]; avisos: string[] }> {
  const meus = new Set((estado.eventIds as string[] | undefined) ?? []);
  const { data, error } = await admin.from("asaas_webhook_events").select("event_id").eq("resultado", "aguardando");
  if (error) throw new Error(`conferir pendentes: ${error.message}`);
  const alheios = (data ?? []).map((r) => (r as { event_id: string }).event_id).filter((id) => !meus.has(id));
  if (alheios.length > 0) throw new Error(`há ${alheios.length} evento(s) pendente(s) que não são deste script; abortado para não processar dado alheio`);
  httpLog.length = 0;
  chamadasCliente.length = 0;
  avisos.length = 0;
  const resumo = await processarEventosAsaas({ db: dbEventos, asaas, config, logger: loggerCap, limite: 50 });
  return { resumo: resumo as unknown as Dict, http: [...httpLog], chamadas: [...chamadasCliente], avisos: [...avisos] };
}
function guardarEvento(id: string): void {
  const l = ((estado.eventIds as string[] | undefined) ?? []).slice();
  if (!l.includes(id)) l.push(id);
  estado.eventIds = l;
  salvarEstado();
}

function pagadorDeTeste(ts: number) {
  return {
    nome: `Homologação HiperCRM ${hojeBR()}`,
    documento: cpfGerado(),
    email: `homolog-e2e-${ts}@example.com`,
    celular: "11988887777",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Passo 1: pré-condições e organizações de teste
// ═══════════════════════════════════════════════════════════════════════════
async function etapaPreparar(): Promise<void> {
  const ts = Date.now();
  const antes = await admin.from("billing_settings").select("compra_pelo_cliente, asaas_sandbox_concede").eq("id", 1).maybeSingle();
  const planosAntes = await admin.from("billing_plans").select("code, for_sale, price_monthly_cents, price_yearly_cents, active").eq("active", true);
  const cfgAntes = antes.data as { compra_pelo_cliente: boolean; asaas_sandbox_concede: boolean } | null;
  const ligou: string[] = [];

  if (!cfgAntes?.compra_pelo_cliente) {
    const r = await admin.rpc("fn_billing_definir_compra_pelo_cliente" as never, { p_sim: true, p_actor: ATOR } as never);
    if (r.error) throw new Error(`definir_compra_pelo_cliente: ${r.error.message}`);
    ligou.push("billing_settings.compra_pelo_cliente (estava false)");
  }
  for (const code of ["pro", "max", "escale"]) {
    const p = ((planosAntes.data ?? []) as Array<{ code: string; for_sale: boolean }>).find((x) => x.code === code);
    if (p && !p.for_sale) {
      const r = await admin.rpc("fn_billing_definir_a_venda" as never, { p_plan_code: code, p_sim: true, p_actor: ATOR } as never);
      if (r.error) throw new Error(`definir_a_venda ${code}: ${r.error.message}`);
      ligou.push(`billing_plans.for_sale ${code} (estava false)`);
    }
  }
  // `asaas_sandbox_concede` NÃO é ligado aqui: o passo 4 mede primeiro o comportamento com ele desligado.

  const data = hojeBR();
  const nomes: Array<["A" | "B", string]> = [
    ["A", `Homologação Asaas ${data}`],
    ["B", `Homologação Asaas ${data} (dia 31)`],
  ];
  const criadas: Dict = {};
  for (const [l, nome] of nomes) {
    if (estado[`org${l}`]) {
      criadas[l] = { jaExistia: estado[`org${l}`] };
      continue;
    }
    const slug = `homolog-asaas-${ts}-${l.toLowerCase()}`;
    const ins = await admin.from("organizations").insert({ slug, legal_name: nome, display_name: nome }).select("id").single();
    if (ins.error) throw new Error(`criar organização ${l}: ${ins.error.message}`);
    estado[`org${l}`] = (ins.data as { id: string }).id;
    estado[`slug${l}`] = slug;
    criadas[l] = { id: estado[`org${l}`], slug, nome };
  }
  const planos = await admin.from("billing_plans").select("id, code").eq("active", true).in("code", ["pro", "max", "escale", "ilimitado"]);
  estado.planos = Object.fromEntries(((planos.data ?? []) as Array<{ id: string; code: string }>).map((p) => [p.code, p.id]));
  estado.preCondicoes = {
    antes: { ...cfgAntes, planos: planosAntes.data },
    ligado: ligou,
  };
  salvarEstado();

  const depois = await admin.from("billing_settings").select("compra_pelo_cliente, asaas_sandbox_concede").eq("id", 1).maybeSingle();
  const contratos = await Promise.all((["A", "B"] as const).map(async (l) => ({ l, contrato: (await sel("billing_contracts", org(l)))[0] })));
  registrar("passo1_preparar", {
    backup: { arquivo: BACKUP, bytes: BACKUP_BYTES },
    tokenDoWebhookGeradoEmMemoria: tokenEmMemoria,
    ligadoNoBancoLocal: ligou,
    settingsDepois: depois.data,
    organizacoes: criadas,
    contratosIniciais: contratos.map((c) => ({
      org: c.l,
      plano: Object.entries(estado.planos as Record<string, string>).find(([, id]) => id === c.contrato?.plan_id)?.[0],
      status: c.contrato?.status,
      cycle: c.contrato?.cycle,
      asaas_subscription_id: c.contrato?.asaas_subscription_id,
      period_end: c.contrato?.current_period_end,
    })),
  });
  checar("passo1: compra_pelo_cliente ligada no banco local", (depois.data as { compra_pelo_cliente?: boolean } | null)?.compra_pelo_cliente === true);
  checar("passo1: asaas_sandbox_concede começa desligada (padrão seguro)", (depois.data as { asaas_sandbox_concede?: boolean } | null)?.asaas_sandbox_concede === false);
  checar("passo1: duas organizações de teste com contrato inicial", contratos.every((c) => Boolean(c.contrato)));
}

// ═══════════════════════════════════════════════════════════════════════════
// Passo 2: compra (iniciarCompra com dependências reais)
// ═══════════════════════════════════════════════════════════════════════════
async function comprar(l: Letra, rotulo: string, vencimentoEsperado: string, oferta: OfertaDeTeste = OFERTAS.monthly): Promise<void> {
  const organizationId = org(l);
  const ts = Date.now();
  chamadasCliente.length = 0;
  httpLog.length = 0;
  avisos.length = 0;
  const chave = randomUUID();
  const resultado = await iniciarCompra(depsCompra, {
    organizationId,
    actorId: ATOR,
    tipo: "assinatura",
    planCode: "pro",
    ciclo: oferta.ciclo,
    metodo: "CREDIT_CARD",
    chave,
    pagador: pagadorDeTeste(ts),
    termosVersao: VERSAO_DOS_TERMOS,
  });
  const http = [...httpLog];
  const chamadas = [...chamadasCliente];
  const f = await foto(organizationId);
  const pedido = (f.pedidos as Dict[])[0] ?? {};
  const vinculo = (f.clientes as Dict[])[0] ?? {};
  estado[`pedido${l}`] = pedido.id;
  estado[`chave${l}`] = chave;
  estado[`clienteAsaas${l}`] = vinculo.asaas_customer_id;
  estado[`sub${l}`] = pedido.asaas_subscription_id;
  estado[`cobranca${l}`] = pedido.asaas_payment_id;
  salvarEstado();

  const cliente = vinculo.asaas_customer_id ? await direto("GET", `/customers/${vinculo.asaas_customer_id as string}`) : null;
  const sub = pedido.asaas_subscription_id ? await direto("GET", `/subscriptions/${pedido.asaas_subscription_id as string}`) : null;
  const cobs = pedido.asaas_subscription_id ? await direto("GET", `/subscriptions/${pedido.asaas_subscription_id as string}/payments`) : null;
  const cobranca = ((cobs?.corpo.data as Dict[] | undefined) ?? [])[0] ?? null;

  registrar(`${rotulo}_compra`, {
    resultadoDoIniciarCompra: resultado,
    chamadasDoClienteAsaas: chamadas,
    httpParaOAsaas: http,
    pedido: { id: pedido.id, status: pedido.status, tipo: pedido.tipo, ciclo: pedido.ciclo, metodo: pedido.metodo, ambiente: pedido.ambiente, amount_cents: pedido.amount_cents, external_reference: pedido.external_reference, asaas_payment_id: pedido.asaas_payment_id, asaas_subscription_id: pedido.asaas_subscription_id, invoice_url: pedido.invoice_url },
    vinculoDoCliente: { asaas_customer_id: vinculo.asaas_customer_id, ambiente: vinculo.ambiente },
    clienteNoAsaas: cliente && { status: cliente.status, id: cliente.corpo.id, externalReference: cliente.corpo.externalReference, notificationDisabled: cliente.corpo.notificationDisabled, email: cliente.corpo.email },
    assinaturaNoAsaas: sub && { status: sub.status, id: sub.corpo.id, billingType: sub.corpo.billingType, cycle: sub.corpo.cycle, value: sub.corpo.value, nextDueDate: sub.corpo.nextDueDate, externalReference: sub.corpo.externalReference, description: sub.corpo.description, creditCard: sub.corpo.creditCard },
    primeiraCobrancaNoAsaas: cobranca && { id: cobranca.id, status: cobranca.status, billingType: cobranca.billingType, value: cobranca.value, dueDate: cobranca.dueDate, externalReference: cobranca.externalReference, subscription: cobranca.subscription, invoiceUrl: cobranca.invoiceUrl },
    avisosDoLogger: avisos,
    contratoDepois: { status: (f.contrato as Dict).status, plan_id: (f.contrato as Dict).plan_id, asaas_subscription_id: (f.contrato as Dict).asaas_subscription_id },
  });

  checar(`${rotulo}: iniciarCompra devolve redirecionar para a fatura do sandbox`, resultado.tipo === "redirecionar" && /^https:\/\/sandbox\.asaas\.com\//.test(resultado.url), resultado);
  checar(`${rotulo}: pedido em aguardando_pagamento, Pro ${oferta.nome}, cartão, ${reais(oferta.valorCents)} (${oferta.valorCents}) do banco`, pedido.status === "aguardando_pagamento" && pedido.ciclo === oferta.ciclo && pedido.metodo === "CREDIT_CARD" && pedido.amount_cents === oferta.valorCents && pedido.ambiente === "sandbox", pedido);
  checar(`${rotulo}: external_reference do pedido é HC:ord:<id>`, pedido.external_reference === `HC:ord:${String(pedido.id)}`, pedido.external_reference);
  checar(`${rotulo}: pedido guarda assinatura, cobrança e fatura do Asaas`, Boolean(pedido.asaas_subscription_id && pedido.asaas_payment_id && pedido.invoice_url));
  checar(`${rotulo}: cliente no Asaas com externalReference HC:org:<org> e sem notificações`, cliente?.corpo.externalReference === `HC:org:${organizationId}` && cliente?.corpo.notificationDisabled === true, cliente?.corpo);
  checar(`${rotulo}: assinatura no Asaas ${oferta.cicloAsaas} CREDIT_CARD ${reais(oferta.valorCents)} com o externalReference do pedido`, sub?.corpo.cycle === oferta.cicloAsaas && sub?.corpo.billingType === "CREDIT_CARD" && sub?.corpo.value === oferta.valorCents / 100 && sub?.corpo.externalReference === pedido.external_reference, sub?.corpo);
  checar(`${rotulo}: primeira cobrança vence em ${vencimentoEsperado} e herda o externalReference`, cobranca?.dueDate === vencimentoEsperado && cobranca?.externalReference === pedido.external_reference, cobranca && { dueDate: cobranca.dueDate, externalReference: cobranca.externalReference });
  checar(`${rotulo}: o próximo vencimento da assinatura no Asaas é ${oferta.meses} mês(es) depois do primeiro (${maisMeses(vencimentoEsperado, oferta.meses)})`, sub?.corpo.nextDueDate === maisMeses(vencimentoEsperado, oferta.meses), { nextDueDate: sub?.corpo.nextDueDate });
  checar(`${rotulo}: a fatura devolvida é a da cobrança do Asaas`, resultado.tipo === "redirecionar" && resultado.url === cobranca?.invoiceUrl);
  checar(`${rotulo}: contrato ainda não muda antes do pagamento (assinatura Asaas só entra no pagamento)`, (f.contrato as Dict).asaas_subscription_id === null, (f.contrato as Dict).asaas_subscription_id);
}

async function etapaCompraA(): Promise<void> {
  await comprar("A", "passo2", hojeBR());
}

// ═══════════════════════════════════════════════════════════════════════════
// Passo 3: pagamento pela API do sandbox
// ═══════════════════════════════════════════════════════════════════════════
async function pagar(l: Letra, rotulo: string): Promise<void> {
  const cobrancaId = estado[`cobranca${l}`] as string;
  const r = await direto("POST", `/payments/${cobrancaId}/payWithCreditCard`, {
    creditCard: { holderName: "HOMOLOGACAO HIPERCRM", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" },
    creditCardHolderInfo: { name: "Homologação HiperCRM", email: `homolog-e2e-${Date.now()}@example.com`, cpfCnpj: cpfGerado(), postalCode: "01001000", addressNumber: "1", phone: "1133334444", mobilePhone: "11988887777" },
    remoteIp: "203.0.113.10",
  });
  await dormir(1500);
  const depois = await direto("GET", `/payments/${cobrancaId}`);
  const sub = await direto("GET", `/subscriptions/${estado[`sub${l}`] as string}`);
  estado[`pagamentoAsaas${l}`] = depois.corpo;
  salvarEstado();
  registrar(`${rotulo}_pagamento`, {
    cobranca: cobrancaId,
    payWithCreditCard: { status: r.status, statusDaCobranca: r.corpo.status, erros: r.status === 200 ? undefined : r.corpo.errors },
    cobrancaDepois: { status: depois.corpo.status, dueDate: depois.corpo.dueDate, paymentDate: depois.corpo.paymentDate, confirmedDate: depois.corpo.confirmedDate, creditDate: depois.corpo.creditDate, value: depois.corpo.value, netValue: depois.corpo.netValue, externalReference: depois.corpo.externalReference, subscription: depois.corpo.subscription, customer: depois.corpo.customer },
    assinaturaDepois: { status: sub.corpo.status, nextDueDate: sub.corpo.nextDueDate, creditCard: sub.corpo.creditCard },
  });
  checar(`${rotulo}: payWithCreditCard respondeu 200 e a cobrança ficou CONFIRMED`, r.status === 200 && depois.corpo.status === "CONFIRMED", { status: r.status, cobranca: depois.corpo.status });
}
async function etapaPagarA(): Promise<void> {
  await pagar("A", "passo3");
}

// ═══════════════════════════════════════════════════════════════════════════
// Passos 4 e 5: webhook -> handler -> processador
// ═══════════════════════════════════════════════════════════════════════════
function esperadoDoPeriodo(due: string, meses = 1): { inicio: number; fim: number; fimData: string } {
  const fimData = maisUmDia(maisMeses(due, meses));
  return { inicio: meiaNoiteSP(due), fim: meiaNoiteSP(fimData), fimData };
}

async function aplicarEsperado(l: Letra, rotulo: string, due: string, plano: "pro", oferta: OfertaDeTeste = OFERTAS.monthly): Promise<void> {
  const f = await foto(org(l));
  const c = f.contrato as Dict;
  const pedido = (f.pedidos as Dict[])[0] ?? {};
  const pags = (f.pagamentos as Dict[]).filter((p) => p.origem === "asaas");
  const esp = esperadoDoPeriodo(due, oferta.meses);
  const sub = await direto("GET", `/subscriptions/${estado[`sub${l}`] as string}`);
  const nextDueAsaas = sub.corpo.nextDueDate as string;

  checar(`${rotulo}: billing_orders ficou pago com pago_em`, pedido.status === "pago" && Boolean(pedido.pago_em), { status: pedido.status, pago_em: pedido.pago_em });
  checar(`${rotulo}: contrato virou plano Pro, ${oferta.nome}, ativa, gateway asaas, assinatura e ambiente gravados`, c.plan_id === (estado.planos as Dict)[plano] && c.cycle === oferta.ciclo && c.status === "ativa" && c.gateway === "asaas" && c.asaas_subscription_id === estado[`sub${l}`] && c.asaas_ambiente === "sandbox" && c.asaas_assinatura_encerrada_em === null && c.cancel_at_period_end === false, { plan_id: c.plan_id, cycle: c.cycle, status: c.status, gateway: c.gateway, sub: c.asaas_subscription_id, ambiente: c.asaas_ambiente });
  checar(`${rotulo}: current_period_start = ${due} 00h de São Paulo`, ms(c.current_period_start) === esp.inicio, { gravado: iso(c.current_period_start), esperado: new Date(esp.inicio).toISOString() });
  checar(`${rotulo}: current_period_end = ${esp.fimData} 00h de São Paulo (vencimento + ${oferta.meses} mês(es) + 1 dia)`, ms(c.current_period_end) === esp.fim, { gravado: iso(c.current_period_end), esperado: new Date(esp.fim).toISOString() });
  checar(`${rotulo}: uma linha em billing_payments, origem asaas, CONFIRMED, ${oferta.valorCents}, ligada ao pedido, mesmo período`, pags.length === 1 && pags[0]!.origem === "asaas" && pags[0]!.status === "CONFIRMED" && pags[0]!.gross_cents === oferta.valorCents && pags[0]!.order_id === pedido.id && pags[0]!.asaas_payment_id === estado[`cobranca${l}`] && ms(pags[0]!.billing_period_start) === esp.inicio && ms(pags[0]!.billing_period_end) === esp.fim, pags.map((p) => ({ origem: p.origem, status: p.status, gross: p.gross_cents, ini: iso(p.billing_period_start), fim: iso(p.billing_period_end) })));
  checar(`${rotulo}: fim do período do CRM = nextDueDate da assinatura no Asaas (${nextDueAsaas}) + 1 dia`, maisUmDia(nextDueAsaas) === esp.fimData, { nextDueDateAsaas: nextDueAsaas, fimDoCrm: esp.fimData });
  registrar(`${rotulo}_estado_do_banco_apos_aplicar`, {
    pedido: { status: pedido.status, pago_em: pedido.pago_em },
    contrato: { plan_id: c.plan_id, cycle: c.cycle, status: c.status, gateway: c.gateway, asaas_subscription_id: c.asaas_subscription_id, asaas_ambiente: c.asaas_ambiente, current_period_start: iso(c.current_period_start), current_period_end: iso(c.current_period_end), cancel_at_period_end: c.cancel_at_period_end },
    pagamentos: pags.map((p) => ({ status: p.status, origem: p.origem, gross_cents: p.gross_cents, billing_period_start: iso(p.billing_period_start), billing_period_end: iso(p.billing_period_end), nota: p.nota })),
    eventosDoContrato: (f.eventosDoContrato as Dict[]).map((e) => ({ tipo: e.tipo, de: e.de, para: e.para, motivo: e.motivo })),
    asaas: { nextDueDate: nextDueAsaas },
    esperadoPeloCalculo: { inicio: new Date(esp.inicio).toISOString(), fim: new Date(esp.fim).toISOString() },
  });
}

async function tokensDoPlano(l: Letra, rotulo: string): Promise<void> {
  const antes = await foto(org(l));
  const saldo = await admin.rpc("fn_billing_saldo_da_carteira" as never, { p_org: org(l) } as never);
  const depois = await foto(org(l));
  registrar(`${rotulo}_tokens`, {
    antesDaPrimeiraLeituraDeSaldo: { carteiras: antes.carteiras, livro: antes.livro },
    saldoDaCarteira: saldo.error ? { erro: saldo.error.message } : saldo.data,
    depois: { carteiras: (depois.carteiras as Dict[]).map((w) => ({ fonte: w.fonte, ciclo: w.ciclo, creditado: w.creditado, consumido: w.consumido })), livro: (depois.livro as Dict[]).map((x) => ({ fonte: x.fonte, tokens: x.tokens, chave: x.chave, ciclo: x.ciclo, nota: x.nota })) },
  });
  checar(`${rotulo}: o pagamento da assinatura NÃO grava nada na carteira sozinho (concessão é preguiçosa)`, (antes.carteiras as Dict[]).length === 0 && (antes.livro as Dict[]).length === 0, { carteiras: (antes.carteiras as Dict[]).length, livro: (antes.livro as Dict[]).length });
  const plano = (depois.carteiras as Dict[]).find((w) => w.fonte === "plano");
  // D-106 (0931): a primeira concessão de um período pago que começou neste mês é proporcional aos dias
  // que restam do mês (do dia do início até o fim, em São Paulo), com divisão inteira como no banco.
  const hojeSp = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const [ano, mes, dia] = hojeSp.split("-").map(Number);
  const diasDoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const esperado = Math.floor((3_000_000 * (diasDoMes - dia + 1)) / diasDoMes);
  checar(`${rotulo}: na primeira leitura do saldo o Pro concede 3.000.000 proporcional aos dias restantes do mês (${esperado}, fonte plano, ciclo atual) no livro e na carteira`, Number(plano?.creditado) === esperado && (depois.livro as Dict[]).some((x) => x.fonte === "plano" && Number(x.tokens) === esperado), { esperado, carteira: plano && { creditado: plano.creditado, ciclo: plano.ciclo }, livro: (depois.livro as Dict[]).length });
}

async function etapaWebhookA(): Promise<void> {
  const organizationId = org("A");
  const pagamentoAsaas = estado.pagamentoAsaasA as Dict | undefined;
  if (!pagamentoAsaas) throw new Error("rode pagar-a antes");
  const due = pagamentoAsaas.dueDate as string;

  // ── 4a: evento PAYMENT_CONFIRMED, chave de sandbox DESLIGADA ──
  const evtConfirmado = montarEvento("PAYMENT_CONFIRMED", pagamentoAsaas, "payment");
  const idConfirmado = evtConfirmado.id as string;
  estado.eventoConfirmadoA = evtConfirmado;
  guardarEvento(idConfirmado);

  const antesEntrega = await foto(organizationId);
  const eventosAntes = await contarEventos();
  const entrega1 = await entregar(evtConfirmado);
  const eventosDepois = await contarEventos();
  const linha1 = await evento(idConfirmado);
  registrar("passo4a_entrega_confirmed", {
    resposta: entrega1,
    eventosNaTabelaAntes: eventosAntes,
    eventosNaTabelaDepois: eventosDepois,
    eventoRegistrado: resumoEvento(linha1),
    payloadGuardadoTemChaveDeCartao: temChaveDeCartao(linha1?.payload ?? {}),
    chavesDoPagamentoNoPayloadGuardado: Object.keys(((linha1?.payload as Dict | undefined)?.payment as Dict | undefined) ?? {}).sort(),
  });
  checar("passo4: handler respondeu 200 {recebido:true} com o token certo", entrega1.status === 200 && entrega1.corpo === JSON.stringify({ recebido: true }), entrega1);
  checar("passo4: evento registrado em asaas_webhook_events como aguardando, ambiente sandbox, origem webhook, resource_id = pay_", linha1?.resultado === "aguardando" && linha1?.ambiente === "sandbox" && linha1?.origem === "webhook" && linha1?.resource_id === pagamentoAsaas.id && eventosDepois === eventosAntes + 1, resumoEvento(linha1));
  checar("passo4: payload guardado sem nenhuma chave de cartão (creditCard, creditCardToken etc.)", !temChaveDeCartao(linha1?.payload ?? {}));

  const proc1 = await processar();
  const linha1b = await evento(idConfirmado);
  const depois1 = await foto(organizationId);
  registrar("passo4a_processador_sem_concessao_de_sandbox", { rodada: proc1, evento: resumoEvento(linha1b) });
  checar("passo4a: o processador consultou o Asaas por GET (pagamento e assinatura) antes de aplicar", proc1.http.some((h) => h === `GET /payments/${String(pagamentoAsaas.id)}`) && proc1.http.every((h) => h.startsWith("GET ")), proc1.http);
  checar("passo4a: sem asaas_sandbox_concede o evento fecha ignorado/sandbox_nao_concede", linha1b?.resultado === "ignorado" && linha1b?.erro_codigo === "sandbox_nao_concede", resumoEvento(linha1b));
  checar("passo4a: nada mudou no banco (pedido, contrato, pagamentos, tokens)", JSON.stringify(pick(antesEntrega)) === JSON.stringify(pick(depois1)), { antes: pick(antesEntrega), depois: pick(depois1) });

  // ── 5: token errado ──
  const eventosAntes5 = await contarEventos();
  const evtForjado = montarEvento("PAYMENT_CONFIRMED", pagamentoAsaas, "payment");
  guardarEvento(evtForjado.id as string);
  const tentativas: Dict[] = [];
  for (const [rotulo, tok] of [["token errado com o mesmo tamanho", "x".repeat(TOKEN.length)], ["token curto", "abc"], ["sem cabeçalho", "sem-cabecalho" as const]] as const) {
    const r = await entregar(evtForjado, tok);
    tentativas.push({ caso: rotulo, status: r.status, corpo: r.corpo });
  }
  const eventosDepois5 = await contarEventos();
  const linhaForjada = await evento(evtForjado.id as string);
  registrar("passo5_token_errado", { tentativas, eventosNaTabelaAntes: eventosAntes5, eventosNaTabelaDepois: eventosDepois5, eventoForjadoGravado: Boolean(linhaForjada) });
  checar("passo5: token errado, curto ou ausente devolvem 401 com corpo vazio", tentativas.every((t) => t.status === 401 && t.corpo === ""), tentativas);
  checar("passo5: nada foi gravado (mesma contagem de eventos, o evento forjado não existe)", eventosDepois5 === eventosAntes5 && !linhaForjada, { antes: eventosAntes5, depois: eventosDepois5 });

  // ── 4b: liga a chave de sandbox, reprocessa o MESMO evento ──
  const liga = await admin.from("billing_settings").update({ asaas_sandbox_concede: true }).eq("id", 1);
  if (liga.error) throw new Error(`ligar asaas_sandbox_concede: ${liga.error.message}`);
  estado.ligouSandboxConcede = true;
  salvarEstado();
  const rep = await admin.rpc("fn_billing_asaas_reprocessar_evento" as never, { p_evento: linha1!.id, p_actor: ATOR } as never);
  if (rep.error) throw new Error(`reprocessar_evento: ${rep.error.message}`);
  const proc2 = await processar();
  const linha2 = await evento(idConfirmado);
  registrar("passo4b_processador_com_concessao", { reprocessar: rep.data, rodada: proc2, evento: resumoEvento(linha2) });
  checar("passo4b: reprocesso aceito e o processador aplicou o evento (aplicado, 1 aplicado na rodada)", linha2?.resultado === "aplicado" && proc2.resumo.aplicados === 1 && linha2?.organization_id === organizationId, { evento: resumoEvento(linha2), rodada: proc2.resumo });
  checar("passo4b: o processador fez GET /payments e GET /subscriptions antes de aplicar, e nenhum POST", proc2.http.some((h) => h.startsWith("GET /payments/")) && proc2.http.some((h) => h.startsWith("GET /subscriptions/")) && proc2.http.every((h) => h.startsWith("GET ")), proc2.http);
  await aplicarEsperado("A", "passo4b", due, "pro");
  await tokensDoPlano("A", "passo4b");

  // ── 4c: reentrega do MESMO evento (idempotência) ──
  const snapAntes = pick(await foto(organizationId));
  const eventosAntes4c = await contarEventos();
  const entrega2 = await entregar(estado.eventoConfirmadoA as Dict);
  const eventosDepois4c = await contarEventos();
  const proc3 = await processar();
  const snapDepois = pick(await foto(organizationId));
  registrar("passo4c_reentrega_do_mesmo_evento", { resposta: entrega2, eventosAntes: eventosAntes4c, eventosDepois: eventosDepois4c, rodada: proc3, eventoAposReentrega: resumoEvento(await evento(idConfirmado)) });
  checar("passo4c: reentrega do mesmo evento responde 200 e não cria linha nova", entrega2.status === 200 && eventosDepois4c === eventosAntes4c, { eventosAntes4c, eventosDepois4c });
  checar("passo4c: o processador não reservou nada e não chamou o Asaas", proc3.resumo.reservados === 0 && proc3.http.length === 0, { resumo: proc3.resumo, http: proc3.http });
  checar("passo4c: banco idêntico (1 pagamento, mesmo contrato, mesmos tokens)", JSON.stringify(snapAntes) === JSON.stringify(snapDepois));

  // ── 4d: PAYMENT_RECEIVED depois do CONFIRMED (id de evento diferente, mesma cobrança) ──
  const evtRecebido = montarEvento("PAYMENT_RECEIVED", pagamentoAsaas, "payment");
  guardarEvento(evtRecebido.id as string);
  const entrega3 = await entregar(evtRecebido);
  const proc4 = await processar();
  const linha4 = await evento(evtRecebido.id as string);
  const snap4 = pick(await foto(organizationId));
  registrar("passo4d_payment_received_depois_do_confirmed", { resposta: entrega3, rodada: proc4, evento: resumoEvento(linha4) });
  checar("passo4d: PAYMENT_RECEIVED é gravado como evento novo e o processador consulta o Asaas por GET", entrega3.status === 200 && linha4 !== null && proc4.http.some((h) => h.startsWith("GET /payments/")), { http: proc4.http });
  checar("passo4d: resultado ja_aplicado e nada duplicado (continua 1 pagamento e mesmos tokens)", linha4?.resultado === "ja_aplicado" && JSON.stringify(snapAntes) === JSON.stringify(snap4), { evento: resumoEvento(linha4) });
}

/** O recorte do banco que as checagens de idempotência comparam. */
function pick(f: Dict): Dict {
  const c = f.contrato as Dict;
  return {
    contrato: { plan_id: c.plan_id, status: c.status, cycle: c.cycle, asaas_subscription_id: c.asaas_subscription_id, current_period_start: iso(c.current_period_start), current_period_end: iso(c.current_period_end), cancel_at_period_end: c.cancel_at_period_end, encerrada: c.asaas_assinatura_encerrada_em, bloqueio_a_partir_de: c.bloqueio_a_partir_de },
    pedidos: (f.pedidos as Dict[]).map((p) => ({ id: p.id, status: p.status })),
    pagamentos: (f.pagamentos as Dict[]).map((p) => ({ status: p.status, gross_cents: p.gross_cents, asaas_payment_id: p.asaas_payment_id })),
    carteiras: (f.carteiras as Dict[]).map((w) => ({ fonte: w.fonte, creditado: w.creditado, consumido: w.consumido })),
    livro: (f.livro as Dict[]).map((x) => ({ chave: x.chave, tokens: x.tokens })),
    eventosDoContrato: (f.eventosDoContrato as Dict[]).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Passo 6: vencimento no dia 31 (organização B)
// ═══════════════════════════════════════════════════════════════════════════
async function etapaDia31B(): Promise<void> {
  const organizationId = org("B");
  // Como o CRM define o vencimento: `nextDueDate = proximaCobrancaEm ?? hoje (SP)` (compra.ts,
  // criarAssinaturaEDevolver). `proximaCobrancaEm` = data civil de SP de `current_period_end` do
  // contrato quando o período ainda vale (fn_billing_criar_pedido, decisão 26). Não há escolha
  // de dia pelo cliente. Para cair no dia 31, a organização B recebe um período já pago até
  // 30/10 inclusive (current_period_end = 31/10 00h SP), o caso real de "assinar de novo com
  // período pago em curso".
  // O período pago vem pela função oficial do registro manual (`fn_billing_registrar_pagamento`,
  // 0908): p_fim = 30/10 => current_period_end = 31/10 00h SP. O service_role não tem UPDATE direto
  // em billing_contracts (só pelas funções), então esta é a única porta.
  const alvo = "2026-10-31";
  if (!estado.fixtureB) {
    const fix = await admin.rpc("fn_billing_registrar_pagamento" as never, {
      p_org: organizationId,
      p_fim: "2026-10-30",
      p_valor_cents: 100,
      p_chave: randomUUID(),
      p_nota: "Homologação Asaas: período pago de teste (fixture do dia 31)",
      p_actor: ATOR,
    } as never);
    if (fix.error) throw new Error(`fixture da organização B: ${fix.error.message}`);
    estado.fixtureB = fix.data;
    salvarEstado();
  }

  await comprar("B", "passo6", alvo);
  await pagar("B", "passo6");

  const pagamentoAsaas = estado.pagamentoAsaasB as Dict;
  const evt = montarEvento("PAYMENT_CONFIRMED", pagamentoAsaas, "payment");
  guardarEvento(evt.id as string);
  estado.eventoConfirmadoB = evt;
  salvarEstado();
  const entrega = await entregar(evt);
  const proc = await processar();
  const linha = await evento(evt.id as string);
  registrar("passo6_webhook", { resposta: entrega, rodada: proc, evento: resumoEvento(linha) });
  checar("passo6: handler 200 e evento aplicado", entrega.status === 200 && linha?.resultado === "aplicado", resumoEvento(linha));
  checar("passo6: o processador consultou o Asaas por GET", proc.http.some((h) => h.startsWith("GET /payments/")) && proc.http.every((h) => h.startsWith("GET ")), proc.http);
  await aplicarEsperado("B", "passo6", pagamentoAsaas.dueDate as string, "pro");
  await tokensDoPlano("B", "passo6");

  const c = (await sel("billing_contracts", organizationId))[0]!;
  const sub = await direto("GET", `/subscriptions/${estado.subB as string}`);
  registrar("passo6_comparacao_com_o_asaas", {
    comoOCrmDefineOVencimento: "nextDueDate = proximaCobrancaEm (data civil SP de current_period_end do contrato, se ainda vale) ou hoje (SP); o cliente não escolhe o dia",
    vencimentoDaPrimeiraCobranca: pagamentoAsaas.dueDate,
    crmPeriodo: { inicio: iso(c.current_period_start), fimExclusivo: iso(c.current_period_end) },
    asaasNextDueDate: sub.corpo.nextDueDate,
    leitura: "CRM: 31/10 + 1 mês = 30/11 (clamp do Postgres) + 1 dia = 01/12 00h SP (limite exclusivo, cobre o dia 30/11). Asaas: próximo vencimento 30/11. Período do CRM termina no dia seguinte ao próximo vencimento do Asaas, igual ao caso do dia 30.",
    naoMedido: "a cobrança de 30/11 só nasce perto do vencimento; o mês depois (30/12 ou 31/12 no Asaas) não foi observado. O CRM calcula cada período a partir do dueDate da cobrança paga, sem encadear, então não acumula deriva.",
  });
  checar("passo6: Asaas ajustou o vencimento seguinte para 30/11 (último dia do mês), não 01/12", sub.corpo.nextDueDate === "2026-11-30", sub.corpo.nextDueDate);
}

// ═══════════════════════════════════════════════════════════════════════════
// Passo 7: estorno total pelo Asaas (organização A)
// ═══════════════════════════════════════════════════════════════════════════
async function estornar(l: Letra, oferta: OfertaDeTeste, rotulo = "passo7"): Promise<void> {
  const organizationId = org(l);
  const cobrancaId = estado[`cobranca${l}`] as string;
  const antes = await foto(organizationId);
  const snapAntes = pick(antes);
  const r = await direto("POST", `/payments/${cobrancaId}/refund`, { description: "Homologação: estorno total" });
  await dormir(2000);
  const depois = await direto("GET", `/payments/${cobrancaId}`);
  registrar(`${rotulo}_estorno_no_asaas`, { refund: { status: r.status, statusDaCobranca: r.corpo.status, erros: r.status === 200 ? undefined : r.corpo.errors }, cobrancaDepois: { status: depois.corpo.status, refunds: depois.corpo.refunds } });
  checar(`${rotulo}: estorno total (sem value) no Asaas devolve 200 e a cobrança fica REFUNDED`, r.status === 200 && depois.corpo.status === "REFUNDED", { status: r.status, cobranca: depois.corpo.status });

  const evt = montarEvento("PAYMENT_REFUNDED", depois.corpo, "payment");
  guardarEvento(evt.id as string);
  estado[`eventoEstorno${l}`] = evt;
  salvarEstado();
  const entrega = await entregar(evt);
  const proc = await processar();
  const linha = await evento(evt.id as string);
  const f = await foto(organizationId);
  const snapDepois = pick(f);
  const pags = f.pagamentos as Dict[];
  const original = pags.find((p) => p.asaas_payment_id === cobrancaId);
  const estorno = pags.find((p) => p.status === "REFUNDED");
  registrar(`${rotulo}_webhook_estorno`, {
    resposta: entrega,
    rodada: proc,
    evento: resumoEvento(linha),
    pedidoDepois: (f.pedidos as Dict[]).map((p) => ({ id: p.id, status: p.status })),
    contratoAntes: snapAntes.contrato,
    contratoDepois: snapDepois.contrato,
    pagamentosDepois: pags.map((p) => ({ status: p.status, origem: p.origem, gross_cents: p.gross_cents, asaas_payment_id: p.asaas_payment_id, estorna: p.estorna_pagamento_id === original?.id, periodo_nulo: p.billing_period_start === null })),
    tokensAntes: { carteiras: snapAntes.carteiras, livro: snapAntes.livro },
    tokensDepois: { carteiras: snapDepois.carteiras, livro: snapDepois.livro },
    observacao: "fn_billing_estornar_pagamento (estorno MANUAL) recusa origem asaas (billing_pagamento_nao_e_manual); o estorno vindo do Asaas passa por fn_billing_asaas_aplicar_estorno.",
  });
  // D-086 (migration 0916): o estorno total é cancelamento. O banco devolve os alarmes de corte e o
  // processador remove a assinatura no Asaas (DELETE, fora de transação) e só depois grava o marcador.
  checar(`${rotulo}: handler 200; o processador fez GET da cobrança e aplicou PAYMENT_REFUNDED (alarmes estorno_confirmado, estorno_cortou_acesso, remover_assinatura_pendente)`, entrega.status === 200 && proc.http.some((h) => h.startsWith("GET /payments/")) && linha?.resultado === "aplicado" && linha?.alarme === "estorno_confirmado,estorno_cortou_acesso,remover_assinatura_pendente", { http: proc.http, evento: resumoEvento(linha) });
  checar(`${rotulo}: pedido passou a estornado`, (f.pedidos as Dict[]).every((p) => p.status === "estornado"), (f.pedidos as Dict[]).map((p) => p.status));
  checar(`${rotulo}: nova linha REFUNDED em billing_payments ligada ao pagamento original, valor ${oferta.valorCents}, sem período`, Boolean(estorno) && estorno?.estorna_pagamento_id === original?.id && estorno?.gross_cents === oferta.valorCents && estorno?.billing_period_start === null, estorno);
  // D-086: contrato cancelado na hora, com o fim do período em now e a carência zerada.
  const cAntes = snapAntes.contrato as Dict;
  const cDepois = snapDepois.contrato as Dict;
  const agoraMs = Date.now();
  const fimMs = new Date(cDepois.current_period_end as string).getTime();
  const carenciaMs = cDepois.bloqueio_a_partir_de ? new Date(cDepois.bloqueio_a_partir_de as string).getTime() : Number.NaN;
  checar(`${rotulo}: o contrato foi cancelado na hora (status cancelada, cancel_at_period_end ligado, fim do período em now, não mais o de 31/10)`, cDepois.status === "cancelada" && cDepois.cancel_at_period_end === true && fimMs <= agoraMs && fimMs > agoraMs - 10 * 60 * 1000, { antes: cAntes, depois: cDepois });
  checar(`${rotulo}: a carência foi zerada no mesmo corte (bloqueio_a_partir_de <= agora), então fn_billing_modo_leitura vale na hora quando a plataforma está em bloquear`, Number.isFinite(carenciaMs) && carenciaMs <= agoraMs, { bloqueio_a_partir_de: cDepois.bloqueio_a_partir_de });
  checar(`${rotulo}: o processador removeu a assinatura no Asaas (DELETE /subscriptions) e DEPOIS gravou o marcador de encerramento`, proc.http.some((h) => h.startsWith("DELETE /subscriptions/")) && cDepois.asaas_assinatura_encerrada_em !== null, { http: proc.http, marcador: cDepois.asaas_assinatura_encerrada_em });
  const evs = (f.eventosDoContrato as Dict[]).filter((e) => e.motivo === "estorno_asaas");
  checar(`${rotulo}: o corte deixou eventos do contrato com motivo estorno_asaas (estado, periodo, cancelar_no_fim, carencia)`, ["estado", "periodo", "cancelar_no_fim"].every((tipo) => evs.some((e) => e.tipo === tipo)), evs.map((e) => e.tipo));
  const planoDepois = (snapDepois.carteiras as Dict[]).find((c) => c.fonte === "plano");
  const corte = (snapDepois.livro as Dict[]).find((l) => typeof l.chave === "string" && (l.chave as string).startsWith("ajuste:estorno-plano:"));
  checar(`${rotulo}: os tokens do plano foram zerados por lançamento NEGATIVO no livro-caixa (saldo do ciclo = 0) e nenhuma linha do livro sumiu`, Boolean(planoDepois) && (planoDepois?.creditado as number) === (planoDepois?.consumido as number) && Boolean(corte) && (corte?.tokens as number) < 0 && (snapDepois.livro as Dict[]).length >= (snapAntes.livro as Dict[]).length + 1, { carteira: planoDepois, corte });

  // Idempotência do estorno: mesma entrega de novo.
  const snapA = pick(await foto(organizationId));
  const evN = await contarEventos();
  const entrega2 = await entregar(evt);
  const proc2 = await processar();
  const snapB = pick(await foto(organizationId));
  checar(`${rotulo}: reentrega do mesmo PAYMENT_REFUNDED não cria evento, não reserva nada e não muda o banco`, entrega2.status === 200 && (await contarEventos()) === evN && proc2.resumo.reservados === 0 && JSON.stringify(snapA) === JSON.stringify(snapB));
}

async function etapaEstornarA(): Promise<void> {
  await estornar("A", OFERTAS.monthly);
}

/**
 * Extra do passo 7 (D-086): depois do estorno e da remoção da assinatura, a organização A pode
 * comprar de novo? A trava da recompra (0909, fn_billing_criar_pedido) só recusa enquanto há
 * assinatura sem o marcador de encerramento; o passo 7 já gravou o marcador. Aqui só se confere o
 * estado que a libera. NÃO chama iniciarCompra: uma compra real criaria outra assinatura no
 * sandbox. Para provar a compra de ponta a ponta, rodar a etapa de compra numa organização nova.
 */
async function etapaRecompraA(): Promise<void> {
  const organizationId = org("A");
  const c = (await foto(organizationId)).contrato as Dict;
  registrar("passo7_extra_recompra_apos_estorno", { asaas_subscription_id: c.asaas_subscription_id, asaas_assinatura_encerrada_em: c.asaas_assinatura_encerrada_em, status: c.status });
  checar("passo7 extra: após o estorno a recompra está liberada (contrato cancelada, assinatura com o marcador de encerramento gravado; a trava da 0909 não recusa mais)", c.status === "cancelada" && c.asaas_assinatura_encerrada_em !== null, c);
}

// ═══════════════════════════════════════════════════════════════════════════
// Passo 8: cancelamento pelo cliente (organização B)
// ═══════════════════════════════════════════════════════════════════════════
async function cancelar(l: Letra, rotulo = "passo8"): Promise<void> {
  const organizationId = org(l);
  const subId = estado[`sub${l}`] as string;
  const antes = await foto(organizationId);
  const subAntes = await direto("GET", `/subscriptions/${subId}`);
  chamadasCliente.length = 0;
  httpLog.length = 0;
  const r1 = await cancelarAssinaturaDoCliente(depsCompra, organizationId, ATOR);
  const http = [...httpLog];
  const subDepois = await direto("GET", `/subscriptions/${subId}`);
  const f = await foto(organizationId);
  const c = f.contrato as Dict;
  const r2 = await cancelarAssinaturaDoCliente(depsCompra, organizationId, ATOR);
  registrar(`${rotulo}_cancelamento`, {
    resultado: r1,
    httpParaOAsaas: http,
    assinaturaAntes: { status: subAntes.status === 200 ? subAntes.corpo.status : subAntes.status, deleted: subAntes.corpo.deleted },
    assinaturaDepois: { httpStatus: subDepois.status, status: subDepois.corpo.status, deleted: subDepois.corpo.deleted },
    contratoAntes: pick(antes).contrato,
    contratoDepois: pick(f).contrato,
    eventosDoContrato: (f.eventosDoContrato as Dict[]).map((e) => ({ tipo: e.tipo, de: e.de, para: e.para, motivo: e.motivo })),
    pedidos: (f.pedidos as Dict[]).map((p) => ({ id: p.id, status: p.status })),
    segundaChamada: r2,
  });
  checar(`${rotulo}: cancelarAssinaturaDoCliente devolve ok com cancelAtPeriodEnd`, r1.tipo === "ok" && r1.cancelAtPeriodEnd === true, r1);
  checar(`${rotulo}: o CRM chamou DELETE /subscriptions/{id} no Asaas`, http.some((h) => h === `DELETE /subscriptions/${subId}`), http);
  checar(`${rotulo}: no Asaas a assinatura foi removida (deleted ou 404)`, subDepois.status === 404 || subDepois.corpo.deleted === true, { status: subDepois.status, deleted: subDepois.corpo.deleted });
  checar(`${rotulo}: contrato com marcador de encerramento, cancel_at_period_end true, status e período preservados (acesso até o fim)`, c.asaas_assinatura_encerrada_em !== null && c.cancel_at_period_end === true && c.status === "ativa" && iso(c.current_period_end) === iso((antes.contrato as Dict).current_period_end), { encerrada: c.asaas_assinatura_encerrada_em, cancel: c.cancel_at_period_end, status: c.status });
  checar(`${rotulo}: evento de auditoria cancelar_no_fim gravado`, (f.eventosDoContrato as Dict[]).some((e) => e.tipo === "cancelar_no_fim" && e.para === "true"), (f.eventosDoContrato as Dict[]).map((e) => e.tipo));
  checar(`${rotulo}: segunda chamada é recusada (já encerrada) sem novo DELETE`, r2.tipo === "erro", r2);

  // O Asaas manda SUBSCRIPTION_DELETED depois do DELETE: entrega ao handler e processa.
  const recurso = { ...(subAntes.corpo as Dict), deleted: true, status: "INACTIVE" };
  const evt = montarEvento("SUBSCRIPTION_DELETED", recurso, "subscription");
  guardarEvento(evt.id as string);
  const snapA = pick(f);
  const entrega = await entregar(evt);
  const proc = await processar();
  const linha = await evento(evt.id as string);
  const snapB = pick(await foto(organizationId));
  registrar(`${rotulo}_subscription_deleted`, { resposta: entrega, rodada: proc, evento: resumoEvento(linha), contratoAntes: snapA.contrato, contratoDepois: snapB.contrato });
  checar(`${rotulo}: SUBSCRIPTION_DELETED: handler 200, processador faz GET /subscriptions e fecha o evento sem erro`, entrega.status === 200 && proc.http.some((h) => h === `GET /subscriptions/${subId}`) && linha !== null && linha.resultado !== "erro" && linha.resultado !== "aguardando", { http: proc.http, evento: resumoEvento(linha) });
  checar(`${rotulo}: SUBSCRIPTION_DELETED não muda o contrato já marcado`, JSON.stringify(snapA.contrato) === JSON.stringify(snapB.contrato), { antes: snapA.contrato, depois: snapB.contrato });
}

async function etapaCancelarB(): Promise<void> {
  await cancelar("B");
}

// ═══════════════════════════════════════════════════════════════════════════
// Etapas de ciclo (D-176): venda semestral e anual à vista
// ═══════════════════════════════════════════════════════════════════════════
async function etapaPrepararCiclos(): Promise<void> {
  const ts = Date.now();
  const planos = await admin.from("billing_plans").select("id, code, for_sale, price_monthly_cents, price_semiannual_cents, price_yearly_cents").eq("active", true).in("code", ["pro", "max", "escale"]);
  const linhas = (planos.data ?? []) as Array<{ id: string; code: string; for_sale: boolean; price_monthly_cents: number; price_semiannual_cents: number | null; price_yearly_cents: number | null }>;
  const decididos: Record<string, [number, number]> = { pro: [104900, 189900], max: [214900, 379900], escale: [319900, 574900] };
  for (const [code, [semestral, anual]] of Object.entries(decididos)) {
    const p = linhas.find((x) => x.code === code);
    checar(`ciclos: ${code} tem semestral ${semestral} e anual ${anual} no catálogo (decisão de 29/09/2026)`, p?.price_semiannual_cents === semestral && p?.price_yearly_cents === anual, p);
  }
  estado.planos = Object.fromEntries(linhas.map((p) => [p.code, p.id]));

  const antes = await admin.from("billing_settings").select("compra_pelo_cliente, asaas_sandbox_concede").eq("id", 1).maybeSingle();
  const cfg = antes.data as { compra_pelo_cliente: boolean; asaas_sandbox_concede: boolean } | null;
  const ligou: string[] = [];
  if (!cfg?.compra_pelo_cliente) {
    const r = await admin.rpc("fn_billing_definir_compra_pelo_cliente" as never, { p_sim: true, p_actor: ATOR } as never);
    if (r.error) throw new Error(`definir_compra_pelo_cliente: ${r.error.message}`);
    ligou.push("billing_settings.compra_pelo_cliente (estava false)");
  }
  if (!linhas.find((p) => p.code === "pro")?.for_sale) {
    const r = await admin.rpc("fn_billing_definir_a_venda" as never, { p_plan_code: "pro", p_sim: true, p_actor: ATOR } as never);
    if (r.error) throw new Error(`definir_a_venda pro: ${r.error.message}`);
    ligou.push("billing_plans.for_sale pro (estava false)");
  }
  if (!cfg?.asaas_sandbox_concede) {
    // Sem esta chave o pagamento de sandbox nunca concede (por desenho, só para instalação de teste).
    const r = await admin.from("billing_settings").update({ asaas_sandbox_concede: true }).eq("id", 1);
    if (r.error) throw new Error(`ligar asaas_sandbox_concede: ${r.error.message}`);
    estado.ligouSandboxConcede = true;
    ligou.push("billing_settings.asaas_sandbox_concede (estava false)");
  }

  const data = hojeBR();
  const criadas: Dict = {};
  for (const [l, nome] of [["C", `Homologação Asaas ${data} (semestral)`], ["D", `Homologação Asaas ${data} (anual)`], ["E", `Homologação Asaas ${data} (semestral parcelado)`], ["F", `Homologação Asaas ${data} (semestral parcelado 3x)`]] as Array<[Letra, string]>) {
    if (estado[`org${l}`]) {
      criadas[l] = { jaExistia: estado[`org${l}`] };
      continue;
    }
    const slug = `homolog-asaas-${ts}-${l.toLowerCase()}`;
    const ins = await admin.from("organizations").insert({ slug, legal_name: nome, display_name: nome }).select("id").single();
    if (ins.error) throw new Error(`criar organização ${l}: ${ins.error.message}`);
    estado[`org${l}`] = (ins.data as { id: string }).id;
    estado[`slug${l}`] = slug;
    criadas[l] = { id: estado[`org${l}`], slug, nome };
  }
  salvarEstado();
  registrar("ciclos_preparar", { backup: { arquivo: BACKUP, bytes: BACKUP_BYTES }, ligadoNoBancoLocal: ligou, organizacoes: criadas, precos: linhas });
  checar("ciclos: organizações C, D, E e F criadas com contrato inicial", (await Promise.all((["C", "D", "E", "F"] as const).map((l) => sel("billing_contracts", org(l))))).every((c) => c.length === 1));
  const cfgParcelas = await admin.from("billing_settings").select("parcelamento_taxa_mensal, parcelamento_sem_juros_ate, parcelamento_max_semestral, parcelamento_max_anual").eq("id", 1).maybeSingle();
  const pc = cfgParcelas.data as Dict | null;
  checar("ciclos: parâmetros de parcelamento semeados (1,99% ao mês, 3x sem juros, semestral até 6x, anual até 12x)", Number(pc?.parcelamento_taxa_mensal) === 0.0199 && pc?.parcelamento_sem_juros_ate === 3 && pc?.parcelamento_max_semestral === 6 && pc?.parcelamento_max_anual === 12, pc);
}

/** PAYMENT_CONFIRMED da primeira cobrança no handler real, processador, e conferência de período e tokens. */
async function confirmarPagamento(l: Letra, rotulo: string, oferta: OfertaDeTeste): Promise<void> {
  const pagamentoAsaas = estado[`pagamentoAsaas${l}`] as Dict | undefined;
  if (!pagamentoAsaas) throw new Error(`sem pagamento da organização ${l}: a compra e o pagamento rodam antes`);
  const evt = montarEvento("PAYMENT_CONFIRMED", pagamentoAsaas, "payment");
  guardarEvento(evt.id as string);
  estado[`eventoConfirmado${l}`] = evt;
  salvarEstado();
  const entrega = await entregar(evt);
  const proc = await processar();
  const linha = await evento(evt.id as string);
  registrar(`${rotulo}_webhook`, { resposta: entrega, rodada: proc, evento: resumoEvento(linha) });
  checar(`${rotulo}: handler 200 e evento aplicado`, entrega.status === 200 && linha?.resultado === "aplicado", resumoEvento(linha));
  checar(`${rotulo}: o processador consultou o Asaas só por GET`, proc.http.some((h) => h.startsWith("GET /payments/")) && proc.http.every((h) => h.startsWith("GET ")), proc.http);
  await aplicarEsperado(l, rotulo, pagamentoAsaas.dueDate as string, "pro", oferta);
  await tokensDoPlano(l, rotulo);
}

async function etapaSemestralC(): Promise<void> {
  await comprar("C", "semestral", hojeBR(), OFERTAS.semiannual);
  await pagar("C", "semestral");
  await confirmarPagamento("C", "semestral", OFERTAS.semiannual);
}

async function etapaAnualD(): Promise<void> {
  await comprar("D", "anual", hojeBR(), OFERTAS.yearly);
  await pagar("D", "anual");
  await confirmarPagamento("D", "anual", OFERTAS.yearly);
}

/** Quem já tem o anual em andamento não troca de ciclo: a recusa é do banco e nada chega ao Asaas. */
async function etapaTrocaDeCiclo(): Promise<void> {
  const organizationId = org("D");
  const antes = await foto(organizationId);
  const tentativas: Dict[] = [];
  for (const ciclo of ["monthly", "semiannual", "yearly"] as const) {
    httpLog.length = 0;
    chamadasCliente.length = 0;
    const r = await iniciarCompra(depsCompra, { organizationId, actorId: ATOR, tipo: "assinatura", planCode: "pro", ciclo, metodo: "CREDIT_CARD", chave: randomUUID(), pagador: pagadorDeTeste(Date.now()), termosVersao: VERSAO_DOS_TERMOS });
    tentativas.push({ ciclo, resultado: r, chamadasAoAsaas: [...httpLog] });
    if (ciclo === "yearly") {
      checar("troca-de-ciclo: o mesmo anual de novo é recusado por já haver assinatura ativa (mensagem de assinatura ativa, não a de troca)", r.tipo === "erro" && r.mensagem === "Sua organização já tem uma assinatura ativa." && httpLog.length === 0, { r, http: [...httpLog] });
    } else {
      checar(`troca-de-ciclo: ${ciclo} sobre o anual ativo é recusado com a mensagem de troca de ciclo e sem chamar o Asaas`, r.tipo === "erro" && r.mensagem === MENSAGEM_TROCA_DE_CICLO && httpLog.length === 0, { r, http: [...httpLog] });
    }
  }
  const depois = await foto(organizationId);
  registrar("troca_de_ciclo", { tentativas, pedidosAntes: (antes.pedidos as Dict[]).length, pedidosDepois: (depois.pedidos as Dict[]).length });
  checar("troca-de-ciclo: nenhum pedido novo foi criado e o contrato não mudou", (depois.pedidos as Dict[]).length === (antes.pedidos as Dict[]).length && JSON.stringify(pick(antes).contrato) === JSON.stringify(pick(depois).contrato));
}

async function etapaEstornarC(): Promise<void> {
  await estornar("C", OFERTAS.semiannual, "semestral_estorno");
}

async function etapaCancelarD(): Promise<void> {
  await cancelar("D", "anual_cancelamento");
}

// ═══════════════════════════════════════════════════════════════════════════
// D-177: compra parcelada no cartão (organizações E e F)
// ═══════════════════════════════════════════════════════════════════════════
const { calcularParcelamento } = (await imp("lib/billing/asaas/parcelamento.ts")) as typeof import("../../lib/billing/asaas/parcelamento");

/**
 * Compra (iniciarCompra com `parcelas`), paga pela API e entrega ao handler o PAYMENT_CONFIRMED de TODAS as
 * parcelas. Confere o total, o período concedido uma vez, as linhas de billing_payments, os tokens e que o
 * contrato fica sem assinatura (não renova sozinho). Roda em duas passadas se o pagamento por API não existir:
 * a primeira imprime a fatura; depois de pagar à mão, a mesma etapa continua do pagamento.
 */
async function parcelado(l: Letra, rotulo: string, oferta: OfertaDeTeste, parcelas: number): Promise<void> {
  const organizationId = org(l);
  const cfg = await admin.from("billing_settings").select("parcelamento_taxa_mensal, parcelamento_sem_juros_ate, parcelamento_max_semestral, parcelamento_max_anual").eq("id", 1).maybeSingle();
  const c = cfg.data as { parcelamento_taxa_mensal: number | string; parcelamento_sem_juros_ate: number; parcelamento_max_semestral: number; parcelamento_max_anual: number };
  const esperado = calcularParcelamento(oferta.valorCents, parcelas, {
    taxaMensal: Number(c.parcelamento_taxa_mensal),
    semJurosAte: c.parcelamento_sem_juros_ate,
    maxSemestral: c.parcelamento_max_semestral,
    maxAnual: c.parcelamento_max_anual,
  });

  if (!estado[`pedido${l}`]) {
    chamadasCliente.length = 0;
    httpLog.length = 0;
    avisos.length = 0;
    const resultado = await iniciarCompra(depsCompra, {
      organizationId,
      actorId: ATOR,
      tipo: "assinatura",
      planCode: "pro",
      ciclo: oferta.ciclo,
      metodo: "CREDIT_CARD",
      parcelas,
      chave: randomUUID(),
      pagador: pagadorDeTeste(Date.now()),
      termosVersao: VERSAO_DOS_TERMOS,
    });
    const f = await foto(organizationId);
    const pedido = (f.pedidos as Dict[])[0] ?? {};
    const vinculo = (f.clientes as Dict[])[0] ?? {};
    estado[`pedido${l}`] = pedido.id;
    estado[`clienteAsaas${l}`] = vinculo.asaas_customer_id;
    estado[`parcelamento${l}`] = pedido.asaas_installment_id;
    estado[`cobranca${l}`] = pedido.asaas_payment_id;
    salvarEstado();
    const inst = pedido.asaas_installment_id ? await direto("GET", `/installments/${pedido.asaas_installment_id as string}`) : null;
    const parcs = pedido.asaas_installment_id ? await direto("GET", `/installments/${pedido.asaas_installment_id as string}/payments`) : null;
    const lista = ((parcs?.corpo.data as Dict[] | undefined) ?? []).slice().sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    registrar(`${rotulo}_compra`, {
      resultadoDoIniciarCompra: resultado,
      chamadasDoClienteAsaas: [...chamadasCliente],
      pedido: { id: pedido.id, status: pedido.status, ciclo: pedido.ciclo, metodo: pedido.metodo, parcelas: pedido.parcelas, amount_cents: pedido.amount_cents, asaas_payment_id: pedido.asaas_payment_id, asaas_subscription_id: pedido.asaas_subscription_id, asaas_installment_id: pedido.asaas_installment_id },
      parcelamentoNoAsaas: inst && { value: inst.corpo.value, paymentValue: inst.corpo.paymentValue, installmentCount: inst.corpo.installmentCount },
      parcelasNoAsaas: lista.map((p) => ({ id: p.id, installmentNumber: p.installmentNumber, value: p.value, dueDate: p.dueDate, status: p.status, externalReference: p.externalReference })),
      avisosDoLogger: avisos,
    });
    checar(`${rotulo}: iniciarCompra devolve redirecionar para a fatura do sandbox`, resultado.tipo === "redirecionar" && /^https:\/\/sandbox\.asaas\.com\//.test(resultado.url), resultado);
    checar(`${rotulo}: pedido aguardando_pagamento, ${parcelas}x, total ${reais(esperado.totalCents)} do cálculo do servidor, sem assinatura`, pedido.status === "aguardando_pagamento" && pedido.parcelas === parcelas && pedido.amount_cents === esperado.totalCents && pedido.asaas_subscription_id === null && Boolean(pedido.asaas_installment_id), pedido);
    checar(`${rotulo}: o Asaas criou ${parcelas} cobranças que somam o total (${reais(esperado.totalCents)}) e levam o externalReference do pedido`, lista.length === parcelas && Math.round(lista.reduce((t, p) => t + Number(p.value) * 100, 0)) === esperado.totalCents && lista.every((p) => p.externalReference === pedido.external_reference), lista.map((p) => p.value));
    // A regra de arredondamento assumida (parcela ao centavo mais próximo, sobra na última) contra o que o Asaas fez.
    checar(`${rotulo}: arredondamento do Asaas = parcelas de ${reais(esperado.parcelaCents)} e última de ${reais(esperado.ultimaParcelaCents)}`, lista.every((p, i) => Math.round(Number(p.value) * 100) === (i === lista.length - 1 ? esperado.ultimaParcelaCents : esperado.parcelaCents)), lista.map((p) => p.value));
    checar(`${rotulo}: o total do parcelamento no Asaas (GET /installments) é ${reais(esperado.totalCents)}`, Math.round(Number(inst?.corpo.value) * 100) === esperado.totalCents && inst?.corpo.installmentCount === parcelas, inst?.corpo);
    // D-177 B5: o `value` de GET /installments contra o totalValue que o CRM enviou (amount_cents / 100). Só prova
    // alguma coisa quando o total NÃO divide exato pelas parcelas (senão a soma das parcelas e o total coincidem).
    const totalValueEnviado = Number(pedido.amount_cents) / 100;
    const divideExato = esperado.totalCents % parcelas === 0;
    registrar(`${rotulo}_total_do_parcelamento`, {
      totalValueEnviado,
      valueDoGetInstallments: inst?.corpo.value,
      paymentValueDoGetInstallments: inst?.corpo.paymentValue,
      valoresDasParcelas: lista.map((p) => p.value),
      somaDasParcelas: lista.reduce((t, p) => t + Number(p.value), 0),
      totalDivideExatoPelasParcelas: divideExato,
    });
    checar(`${rotulo}: o value de GET /installments (${String(inst?.corpo.value)}) é o totalValue enviado (${totalValueEnviado}), não o valor de uma parcela`, Number(inst?.corpo.value) === totalValueEnviado && Number(inst?.corpo.value) !== Number(lista[0]?.value), { enviado: totalValueEnviado, value: inst?.corpo.value, paymentValue: inst?.corpo.paymentValue });
    checar(`${rotulo}: o total ${reais(esperado.totalCents)} NÃO divide exato por ${parcelas} (só assim a conferência prova a regra de arredondamento)`, !divideExato, { totalCents: esperado.totalCents, parcelas });
    if (resultado.tipo === "redirecionar") estado[`faturaParcelado${l}`] = resultado.url;
    salvarEstado();
  }

  // Pagamento: pela API na primeira parcela. Se não pagar o parcelamento inteiro, imprime a fatura e para.
  const instId = estado[`parcelamento${l}`] as string;
  const parcs = await direto("GET", `/installments/${instId}/payments`);
  let lista = ((parcs.corpo.data as Dict[]) ?? []).slice().sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  if (!lista.every((p) => p.status === "CONFIRMED" || p.status === "RECEIVED")) {
    const primeira = estado[`cobranca${l}`] as string;
    const r = await direto("POST", `/payments/${primeira}/payWithCreditCard`, {
      creditCard: { holderName: "HOMOLOGACAO HIPERCRM", number: "4444444444444444", expiryMonth: "12", expiryYear: "2030", ccv: "123" },
      creditCardHolderInfo: { name: "Homologação HiperCRM", email: `homolog-e2e-${Date.now()}@example.com`, cpfCnpj: cpfGerado(), postalCode: "01001000", addressNumber: "1", phone: "1133334444", mobilePhone: "11988887777" },
      remoteIp: "203.0.113.10",
    });
    // O estado de TODAS as parcelas logo depois de pagar a primeira: prova se o cartão autoriza o total de uma vez
    // (todas CONFIRMED) ou só a primeira parcela (as outras ficam PENDING até o vencimento). A concessão do período
    // (D-177 M2) depende disso. Lido sem espera e de novo depois de 2 s, para separar atraso de comportamento.
    const lerParcelas = async (): Promise<Dict[]> => {
      const resp = await direto("GET", `/installments/${instId}/payments`);
      return ((resp.corpo.data as Dict[]) ?? []).slice().sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    };
    const resumoDasParcelas = (ps: Dict[]) => ps.map((p) => ({ n: p.installmentNumber, id: p.id, status: p.status, dueDate: p.dueDate, netValue: p.netValue, creditDate: p.creditDate }));
    const logoDepois = await lerParcelas();
    await dormir(2000);
    lista = await lerParcelas();
    const confirmadas = (ps: Dict[]) => ps.filter((p) => p.status === "CONFIRMED" || p.status === "RECEIVED" || p.status === "RECEIVED_IN_CASH").length;
    registrar(`${rotulo}_pagamento`, {
      payWithCreditCard: { status: r.status, erros: r.status === 200 ? undefined : r.corpo.errors },
      parcelasLogoDepoisDePagarAPrimeira: resumoDasParcelas(logoDepois),
      parcelasDepoisDe2s: resumoDasParcelas(lista),
      confirmadasLogoDepois: confirmadas(logoDepois),
      confirmadasDepoisDe2s: confirmadas(lista),
      totalDeParcelas: lista.length,
      cartaoAutorizouOTotalDeUmaVez: lista.length === parcelas && confirmadas(lista) === parcelas,
    });
    log(`[${rotulo}] payWithCreditCard ${r.status}: ${confirmadas(logoDepois)}/${logoDepois.length} parcelas confirmadas logo depois, ${confirmadas(lista)}/${lista.length} depois de 2 s`);
    if (!lista.every((p) => p.status === "CONFIRMED" || p.status === "RECEIVED")) {
      if (r.status === 200) log(`[${rotulo}] ATENÇÃO: o pagamento da primeira parcela foi aceito, mas só ${confirmadas(lista)} de ${lista.length} parcelas ficaram confirmadas. O cartão NÃO autorizou o total de uma vez; a concessão do período (D-177 M2) espera todas as parcelas confirmadas.`);
      log(`\n[PAGAR A MÃO] A API do sandbox não pagou o parcelamento inteiro (payWithCreditCard respondeu ${r.status}).`);
      log(`Fatura (cartão de teste 4444 4444 4444 4444, qualquer validade futura, CCV 123): ${String(estado[`faturaParcelado${l}`])}`);
      log(`Depois de pagar, rode de novo a mesma etapa: ela continua daqui (não cria outra compra).`);
      checar(`${rotulo}: parcelamento pago (pela API ou à mão)`, false, { status: r.status, parcelas: lista.map((p) => p.status) });
      return;
    }
  }
  checar(`${rotulo}: as ${parcelas} parcelas ficaram CONFIRMED`, lista.length === parcelas && lista.every((p) => p.status === "CONFIRMED" || p.status === "RECEIVED"), lista.map((p) => p.status));

  // Webhook: o PAYMENT_CONFIRMED de CADA parcela, no handler real, e o processador.
  const ids: string[] = [];
  for (const parcela of lista) {
    const evt = montarEvento("PAYMENT_CONFIRMED", parcela, "payment");
    guardarEvento(evt.id as string);
    ids.push(evt.id as string);
    const entrega = await entregar(evt);
    checar(`${rotulo}: handler 200 para a parcela ${String(parcela.installmentNumber)}`, entrega.status === 200, entrega);
  }
  salvarEstado();
  const proc = await processar();
  const linhas = await Promise.all(ids.map((id) => evento(id)));
  registrar(`${rotulo}_webhook`, { rodada: proc, eventos: linhas.map((e) => resumoEvento(e)) });
  checar(`${rotulo}: todos os eventos aplicados`, linhas.every((e) => e?.resultado === "aplicado"), linhas.map((e) => e?.resultado));
  checar(`${rotulo}: o processador consultou /installments/{id} para conferir o total e só fez GET`, proc.http.some((h) => h.startsWith("GET /installments/")) && proc.http.every((h) => h.startsWith("GET ")), proc.http);

  const f = await foto(organizationId);
  const ct = f.contrato as Dict;
  const pedido = (f.pedidos as Dict[])[0] ?? {};
  const pags = (f.pagamentos as Dict[]).filter((p) => p.origem === "asaas");
  const due = String(lista[0]!.paymentDate ?? lista[0]!.dueDate);
  const esp = esperadoDoPeriodo(due, oferta.meses);
  checar(`${rotulo}: pedido pago, ${parcelas}x, total ${reais(esperado.totalCents)}`, pedido.status === "pago" && pedido.parcelas === parcelas && pedido.amount_cents === esperado.totalCents, { status: pedido.status, amount: pedido.amount_cents });
  checar(`${rotulo}: ${parcelas} linhas em billing_payments ligadas ao pedido, somando ${reais(esperado.totalCents)}`, pags.length === parcelas && pags.every((p) => p.order_id === pedido.id) && pags.reduce((t, p) => t + Number(p.gross_cents), 0) === esperado.totalCents, pags.map((p) => p.gross_cents));
  checar(`${rotulo}: o período foi concedido UMA vez (só uma linha com período)`, pags.filter((p) => p.billing_period_end !== null).length === 1, pags.map((p) => iso(p.billing_period_end)));
  checar(`${rotulo}: contrato Pro ${oferta.nome}, ativa, período de ${oferta.meses} meses mais 1 dia (${esp.fimData})`, ct.status === "ativa" && ct.cycle === oferta.ciclo && ms(ct.current_period_end) === esp.fim, { status: ct.status, cycle: ct.cycle, fim: iso(ct.current_period_end), esperado: new Date(esp.fim).toISOString() });
  checar(`${rotulo}: NADA renova sozinho (contrato sem assinatura do Asaas, gateway asaas)`, ct.asaas_subscription_id === null && ct.gateway === "asaas", { sub: ct.asaas_subscription_id, gateway: ct.gateway });
  const subs = await direto("GET", `/subscriptions?customer=${estado[`clienteAsaas${l}`] as string}`);
  checar(`${rotulo}: nenhuma assinatura existe no Asaas para o cliente`, ((subs.corpo.data as Dict[]) ?? []).filter((s) => s.deleted !== true).length === 0, subs.corpo.data);
  const saldo = await admin.rpc("fn_billing_saldo_da_carteira" as never, { p_org: organizationId } as never);
  const conc = (await sel("billing_token_ledger", organizationId)).filter((e) => String(e.chave).startsWith("plano:"));
  registrar(`${rotulo}_tokens`, { saldo: saldo.error ? saldo.error.message : "ok", concessoesDoPlano: conc.length });
  checar(`${rotulo}: tokens do plano concedidos uma vez, não por parcela`, conc.length === 1, conc.map((e) => e.chave));
}

async function etapaParceladoSemestralE(): Promise<void> {
  await parcelado("E", "parcelado_semestral", OFERTAS.semiannual, 4);
}

async function etapaParceladoSemestral3xF(): Promise<void> {
  await parcelado("F", "parcelado_semestral_3x", OFERTAS.semiannual, 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// Passo 9: limpeza no Asaas
// ═══════════════════════════════════════════════════════════════════════════
async function etapaLimpar(): Promise<void> {
  const saida: Dict = {};
  for (const l of ["A", "B", "C", "D", "E", "F"] as const) {
    const cid = estado[`clienteAsaas${l}`] as string | undefined;
    if (!cid) continue;
    // D-177: parcelamento ainda pendente é removido INTEIRO (DELETE /installments/{id}); parcela já paga fica.
    const pagsAntes = await direto("GET", `/payments?customer=${cid}&limit=100`);
    const parcelamentosPendentes = [...new Set(((pagsAntes.corpo.data as Dict[]) ?? []).filter((p) => p.installment && p.deleted !== true && p.status === "PENDING").map((p) => p.installment as string))];
    const parcelamentosRemovidos: Dict[] = [];
    for (const inst of parcelamentosPendentes) {
      const d = await direto("DELETE", `/installments/${inst}`);
      parcelamentosRemovidos.push({ id: inst, delete: d.status, corpo: d.corpo });
    }
    const lista = await direto("GET", `/subscriptions?customer=${cid}`);
    const subs = ((lista.corpo.data as Dict[]) ?? []).filter((s) => s.deleted !== true);
    const removidas: Dict[] = [];
    for (const s of subs) {
      const d = await direto("DELETE", `/subscriptions/${s.id as string}`);
      removidas.push({ id: s.id, statusAntes: s.status, delete: d.status, corpo: d.corpo });
    }
    const depois = await direto("GET", `/subscriptions?customer=${cid}`);
    const pags = await direto("GET", `/payments?customer=${cid}&limit=100`);
    saida[l] = {
      cliente: cid,
      assinaturasAbertasAntes: subs.map((s) => s.id),
      removidas,
      parcelamentosRemovidos,
      assinaturasAposLimpeza: ((depois.corpo.data as Dict[]) ?? []).map((s) => ({ id: s.id, status: s.status, deleted: s.deleted })),
      cobrancasQueFicam: ((pags.corpo.data as Dict[]) ?? []).map((p) => ({ id: p.id, status: p.status, value: p.value, deleted: p.deleted })),
    };
    checar(`passo9: nenhuma assinatura aberta sobrou no Asaas para o cliente ${l}`, ((depois.corpo.data as Dict[]) ?? []).every((s) => s.deleted === true || s.status === "INACTIVE"), saida[l]);
  }
  saida.bancoLocal = { organizacoesDeTesteMantidas: { A: estado.orgA, B: estado.orgB, C: estado.orgC, D: estado.orgD, E: estado.orgE, F: estado.orgF }, observacao: "nada foi apagado no banco local" };
  registrar("passo9_limpeza", saida);
}

// ═══════════════════════════════════════════════════════════════════════════
const etapas: Record<string, () => Promise<void>> = {
  preparar: etapaPreparar,
  "compra-a": etapaCompraA,
  "pagar-a": etapaPagarA,
  "webhook-a": etapaWebhookA,
  "dia31-b": etapaDia31B,
  "estornar-a": etapaEstornarA,
  "recompra-a": etapaRecompraA,
  "cancelar-b": etapaCancelarB,
  limpar: etapaLimpar,
  "preparar-ciclos": etapaPrepararCiclos,
  "semestral-c": etapaSemestralC,
  "anual-d": etapaAnualD,
  "troca-de-ciclo": etapaTrocaDeCiclo,
  "estornar-c": etapaEstornarC,
  "cancelar-d": etapaCancelarD,
  "parcelado-semestral-e": etapaParceladoSemestralE,
  "parcelado-semestral-3x-f": etapaParceladoSemestral3xF,
};
const ORDEM = ["preparar", "compra-a", "pagar-a", "webhook-a", "dia31-b", "estornar-a", "recompra-a", "cancelar-b", "limpar"];
const ORDEM_CICLOS = ["preparar-ciclos", "semestral-c", "anual-d", "troca-de-ciclo", "estornar-c", "cancelar-d", "parcelado-semestral-e", "parcelado-semestral-3x-f", "limpar"];

const pedida = process.argv[2];
if (!pedida || (pedida !== "tudo" && pedida !== "ciclos" && !etapas[pedida])) {
  console.error(`uso: tsx hiperbold/scripts/homologar-asaas-e2e-sandbox.mts <${["tudo", "ciclos", ...new Set([...ORDEM, ...ORDEM_CICLOS])].join("|")}>`);
  process.exit(1);
}
const lista = pedida === "tudo" ? ORDEM : pedida === "ciclos" ? ORDEM_CICLOS : [pedida];
try {
  for (const nome of lista) {
    log(`\n=== ${nome} ===`);
    await etapas[nome]!();
  }
} catch (err) {
  log(`\n[ERRO] ${(err as Error).stack ?? String(err)}`);
  salvarEstado();
  log(`Avisos do logger: ${JSON.stringify(avisos.slice(-10))}`);
  process.exit(3);
}
const falhas = checagens.filter((c) => !c.ok);
log(`\nChecagens: ${checagens.length - falhas.length} ok, ${falhas.length} falhou(aram).`);
for (const f of falhas) log(`  FALHOU: ${f.nome}`);
process.exit(falhas.length > 0 ? 4 : 0);
