/**
 * Gera os lançamentos dos moldes recorrentes.
 *
 * Roda uma vez por dia. Para cada molde ativo, calcula a competência do mês
 * corrente e insere a linha PENDENTE se ela ainda não existir.
 *
 * ⚠️ A IDEMPOTÊNCIA NÃO É DESTA ROTINA. Ela é do índice único
 * `(recurring_entry_id, entry_date)`. Aqui o erro `23505` é tratado como
 * "já existia", que é o desfecho correto: duas execuções simultâneas passam
 * pela mesma checagem e só uma grava.
 *
 * ⚠️ NASCE PENDENTE, NUNCA PAGA. O sistema sabe que a conta vence; ele não sabe
 * se alguém pagou. Marcar como paga automaticamente encheria o caixa de dinheiro
 * que não saiu, e o saldo do relatório passaria a mentir todo dia 5.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * A data da competência deste mês para um molde.
 *
 * ⚠️ ONZE MESES DO ANO NÃO TÊM TODOS OS DIAS. Um molde de dia 31 em fevereiro
 * não pode ser pulado (deixaria de cobrar o aluguel) nem empurrado para março
 * (mudaria a competência): ele cai no último dia do mês.
 *
 * Pura e exportada porque é a regra inteira, e esperar fevereiro para testá-la
 * seria absurdo.
 */
export function competenciaDoMes(ano: number, mes: number, diaDoMes: number): string {
  // Dia 0 do mês seguinte é o último dia deste. `Date.UTC` porque a competência
  // é uma data civil, não um instante: usar o fuso local do servidor faria a
  // mesma instalação gerar dias diferentes conforme onde ela roda.
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const dia = Math.min(diaDoMes, ultimoDia);
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/**
 * A data civil de hoje NO FUSO da organização (D-161).
 *
 * Em UTC, às 21h de Brasília do último dia do mês já é dia 1 do mês seguinte, e a
 * rotina gerava o lançamento do mês que ainda não começou para o cliente. O mês e
 * o dia da competência são os da organização.
 */
export function dataCivilNoFuso(
  agora: Date,
  timezone: string | null | undefined,
): { ano: number; mes: number; hoje: string } {
  const partes = (tz: string) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(agora);
    const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return { ano: Number(v("year")), mes: Number(v("month")), dia: v("day") };
  };
  let r;
  try {
    r = partes(timezone || "America/Sao_Paulo");
  } catch {
    r = partes("America/Sao_Paulo");
  }
  return { ano: r.ano, mes: r.mes, hoje: `${r.ano}-${String(r.mes).padStart(2, "0")}-${r.dia}` };
}

/** Página de leitura dos moldes: o PostgREST corta em 1000 linhas (`max_rows`). */
const PAGINA_DE_MOLDES = 500;
const MAX_PAGINAS_DE_MOLDES = 100;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  // Todos os moldes, em páginas ordenadas: além de 1000 o PostgREST cortava e os
  // moldes excedentes nunca geravam lançamento (D-161).
  const moldes: Array<Record<string, unknown>> = [];
  for (let pagina = 0; pagina < MAX_PAGINAS_DE_MOLDES; pagina++) {
    const { data: lote, error } = await admin
      .from("recurring_entries")
      .select(
        "id, organization_id, account_id, account_plan_id, direction, amount_cents, currency, name, day_of_month",
      )
      .eq("is_active", true)
      .order("id", { ascending: true })
      .range(pagina * PAGINA_DE_MOLDES, pagina * PAGINA_DE_MOLDES + PAGINA_DE_MOLDES - 1);
    if (error) {
      logger.error("[recurring-entries] consulta falhou", { error: error.message, requestId });
      return fail("internal_error", "Falha ao buscar recorrências.", 500, { requestId });
    }
    moldes.push(...(lote ?? []));
    if ((lote ?? []).length < PAGINA_DE_MOLDES) break;
  }

  // O fuso de cada organização que tem molde (consulta em blocos: o filtro `in` vai na URL).
  const fusoDaOrg = new Map<string, string | null>();
  const orgIds = [...new Set(moldes.map((m) => m.organization_id as string))];
  for (let i = 0; i < orgIds.length; i += 100) {
    const { data: orgs, error: erroDeFuso } = await admin
      .from("organizations")
      .select("id, timezone")
      .in("id", orgIds.slice(i, i + 100));
    if (erroDeFuso) {
      logger.warn("[recurring-entries] não consegui ler o fuso das organizações; usando o padrão", {
        error: erroDeFuso.message,
        requestId,
      });
      break;
    }
    for (const o of (orgs ?? []) as Array<{ id: string; timezone: string | null }>) fusoDaOrg.set(o.id, o.timezone);
  }

  let gerados = 0;
  let jaExistiam = 0;
  let falharam = 0;

  for (const molde of moldes) {
    const { ano, mes, hoje } = dataCivilNoFuso(agora, fusoDaOrg.get(molde.organization_id as string));
    const competencia = competenciaDoMes(ano, mes, molde.day_of_month as number);

    // Só gera quando a data já chegou. Sem isto, no dia 1 nasceriam as doze
    // contas do mês inteiro e a tela de pendências viraria uma lista de coisas
    // que ainda não venceram.
    if (competencia > hoje) continue;

    const { error: erroInsert } = await admin.from("financial_entries").insert({
      organization_id: molde.organization_id,
      account_id: molde.account_id,
      account_plan_id: molde.account_plan_id,
      direction: molde.direction,
      amount_cents: molde.amount_cents,
      currency: molde.currency,
      description: molde.name,
      entry_date: competencia,
      status: "pending",
      origin: "recurring",
      recurring_entry_id: molde.id,
    });

    if (!erroInsert) {
      gerados += 1;
      continue;
    }
    // 23505 = o índice único pegou. É o desfecho esperado em toda rodada depois
    // da primeira do mês, e não é erro.
    if (erroInsert.code === "23505") {
      jaExistiam += 1;
      continue;
    }
    falharam += 1;
    logger.error("[recurring-entries] insert falhou", {
      recurring_entry_id: molde.id,
      organization_id: molde.organization_id,
      error: erroInsert.message,
      requestId,
    });
  }

  // Rodada que não gerou nada NÃO é mutação, e não audita — a lei está no
  // CLAUDE.md §Audit log, e `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`
  // varre o AST de toda rota deste diretório atrás de `audit` incondicional.
  if (gerados > 0) {
    await audit({
      action: "financeiro.recorrencia_gerada",
      resourceType: "financial_entry",
      requestId,
      metadata: { gerados, ja_existiam: jaExistiam, falharam },
    });
  }

  return ok(
    { moldes: moldes.length, gerados, ja_existiam: jaExistiam, falharam },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
