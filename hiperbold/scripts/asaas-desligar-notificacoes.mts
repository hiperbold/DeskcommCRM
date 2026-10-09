/**
 * D-087: desliga as notificações de cobrança do Asaas (e-mail e SMS ao pagador) nos clientes que o
 * CRM já criou, porque agora quem avisa o cliente é a fila do CRM (`lib/email/conta-e-cobranca/`).
 * Clientes novos já nascem com `notificationDisabled: true` (`lib/billing/asaas/compra.ts`).
 *
 * Documentação do campo: https://docs.asaas.com/reference/create-new-customer
 *   `notificationDisabled` (boolean): "true to disable sending billing notifications".
 * Atualização: `PUT /v3/customers/{id}` https://docs.asaas.com/reference/update-existing-customer
 *
 * ═══ Como rodar (WSL, na raiz do repositório) ═══
 *   node_modules/.bin/tsx hiperbold/scripts/asaas-desligar-notificacoes.mts            # dry-run (padrão)
 *   node_modules/.bin/tsx hiperbold/scripts/asaas-desligar-notificacoes.mts --aplicar  # executa
 *
 * - Ambiente (sandbox ou produção) vem de `ASAAS_BASE_URL`, e a chave tem de ter o prefixo do mesmo
 *   ambiente. Só os vínculos de `billing_customers` DESSE ambiente entram.
 * - Dry-run: lê o banco (service role) e faz `GET /customers/{id}` (só leitura) para saber quais ainda
 *   têm notificações ligadas; lista a contagem e os ids (`cus_...`). Nada é alterado.
 * - `--aplicar`: faz o `PUT` só nos que ainda estão ligados. Idempotente: rodar de novo não faz nada.
 * - 429: espera `RateLimit-Reset`/`Retry-After` (ou 5 s) e repete, até 6 vezes por chamada.
 * - Log: só ids de cliente Asaas e contagens. Nunca e-mail, CPF/CNPJ, nome, chave nem service role.
 * - Variáveis lidas pelo carregador do Next (`@next/env`), sem abrir arquivo .env à mão.
 */
import { createRequire } from "node:module";

import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const RAIZ = process.cwd();

const { loadEnvConfig } = require(
  require.resolve("@next/env", { paths: [require.resolve("next", { paths: [RAIZ] })] }),
) as { loadEnvConfig: (dir: string, dev: boolean, log: { info(): void; error(): void }) => unknown };
loadEnvConfig(RAIZ, true, { info() {}, error() {} });

const BASE_SANDBOX = "https://api-sandbox.asaas.com/v3";
const BASE_PRODUCAO = "https://api.asaas.com/v3";
const CHAVE = (process.env.ASAAS_API_KEY ?? "").trim();
const BASE = (process.env.ASAAS_BASE_URL ?? "").trim();
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const SEGREDOS = [CHAVE, SERVICE_KEY].filter((s) => s.length > 0);

const APLICAR = process.argv.includes("--aplicar");
const MAX_429 = 6;
const ESPERA_PADRAO_429_MS = 5_000;
const PAUSA_ENTRE_CHAMADAS_MS = 150;

function limpar(texto: string): string {
  let t = texto;
  for (const s of SEGREDOS) t = t.split(s).join("<segredo>");
  return t;
}
function log(msg: string): void {
  console.info(limpar(msg));
}
function recusar(motivo: string): never {
  console.error(limpar(`[asaas-notificacoes] RECUSADO: ${motivo} Nada foi chamado.`));
  process.exit(2);
}
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const argsConhecidos = new Set(["--aplicar", "--dry-run"]);
for (const a of process.argv.slice(2)) {
  if (!argsConhecidos.has(a)) recusar(`argumento desconhecido (${a}). Use --dry-run (padrão) ou --aplicar.`);
}
if (process.argv.includes("--aplicar") && process.argv.includes("--dry-run")) {
  recusar("--aplicar e --dry-run juntos.");
}

const ambiente: "sandbox" | "producao" | null =
  BASE === BASE_SANDBOX ? "sandbox" : BASE === BASE_PRODUCAO ? "producao" : null;
if (!ambiente) recusar("ASAAS_BASE_URL não é a base oficial do sandbox nem a da produção.");
const prefixoEsperado = ambiente === "sandbox" ? "$aact_hmlg_" : "$aact_prod_";
if (!CHAVE.startsWith(prefixoEsperado)) recusar(`ASAAS_API_KEY não tem o prefixo do ambiente ${ambiente}.`);
if (!SUPABASE_URL || !SERVICE_KEY) recusar("NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente.");

interface RespostaAsaas {
  status: number;
  corpo: { notificationDisabled?: boolean; deleted?: boolean } | null;
}

/** Uma chamada ao Asaas com a espera de 429. Nunca imprime o corpo (tem dado pessoal). */
async function chamar(metodo: "GET" | "PUT", caminho: string, corpo?: unknown): Promise<RespostaAsaas> {
  for (let tentativa = 0; ; tentativa += 1) {
    const res = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers: { access_token: CHAVE, "Content-Type": "application/json", "User-Agent": "HiperCRM/1.0" },
      ...(metodo === "GET" ? {} : { body: JSON.stringify(corpo ?? {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429) {
      if (tentativa >= MAX_429) throw new Error(`429 persistente em ${metodo} ${caminho.split("?")[0]}`);
      const bruto = Number(res.headers.get("RateLimit-Reset") ?? res.headers.get("Retry-After"));
      const ms = Number.isFinite(bruto) && bruto > 0 ? Math.min(bruto * 1000, 60_000) : ESPERA_PADRAO_429_MS;
      log(`  429, aguardando ${Math.round(ms / 1000)}s (tentativa ${tentativa + 1}/${MAX_429})`);
      await esperar(ms);
      continue;
    }
    const json = (await res.json().catch(() => null)) as RespostaAsaas["corpo"];
    return { status: res.status, corpo: json };
  }
}

async function idsVinculados(): Promise<string[]> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const todos: string[] = [];
  const PAGINA = 1000;
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await admin
      .from("billing_customers")
      .select("asaas_customer_id")
      .eq("ambiente", ambiente)
      .order("created_at", { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) throw new Error(`ler billing_customers: ${error.code ?? "erro"}`);
    const lote = (data ?? []).map((l) => String(l.asaas_customer_id));
    todos.push(...lote);
    if (lote.length < PAGINA) break;
  }
  return [...new Set(todos)];
}

async function main(): Promise<void> {
  log(`[asaas-notificacoes] ambiente=${ambiente} modo=${APLICAR ? "APLICAR" : "dry-run"}`);
  const vinculados = await idsVinculados();
  log(`clientes vinculados no CRM (${ambiente}): ${vinculados.length}`);

  const pendentes: string[] = [];
  let jaDesligados = 0;
  const semLeitura: string[] = [];
  for (const id of vinculados) {
    const r = await chamar("GET", `/customers/${encodeURIComponent(id)}`);
    await esperar(PAUSA_ENTRE_CHAMADAS_MS);
    if (r.status !== 200 || r.corpo?.deleted === true) {
      semLeitura.push(id);
      log(`  ${id}: ${r.status === 200 ? "removido no Asaas" : `GET respondeu ${r.status}`}, ignorado`);
      continue;
    }
    if (r.corpo?.notificationDisabled === true) jaDesligados += 1;
    else pendentes.push(id);
  }
  log(
    `já desligados: ${jaDesligados} | com notificações ligadas: ${pendentes.length} | removidos ou ilegíveis: ${semLeitura.length}`,
  );
  if (pendentes.length > 0) log(`ids que mudariam: ${pendentes.join(", ")}`);

  if (!APLICAR) {
    log("dry-run: nada foi alterado. Rode com --aplicar para executar.");
    return;
  }

  let ok = 0;
  const falhas: string[] = [];
  for (const id of pendentes) {
    const r = await chamar("PUT", `/customers/${encodeURIComponent(id)}`, { notificationDisabled: true });
    await esperar(PAUSA_ENTRE_CHAMADAS_MS);
    if (r.status === 200 && r.corpo?.notificationDisabled === true) {
      ok += 1;
    } else {
      falhas.push(id);
      log(`  ${id}: PUT respondeu ${r.status}${r.status === 200 ? " sem confirmar o campo" : ""}`);
    }
  }
  log(`desligados agora: ${ok} | falhas: ${falhas.length}${falhas.length ? ` (${falhas.join(", ")})` : ""}`);
  if (falhas.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : "erro";
  console.error(limpar(`[asaas-notificacoes] falhou: ${msg}`));
  process.exit(1);
});
