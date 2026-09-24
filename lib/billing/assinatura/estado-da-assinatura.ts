/**
 * A leitura da ASSINATURA de uma organização (fase F4, tarefa 8, migração
 * 0908): estado, ciclo, período, próximo vencimento, `cancel_at_period_end`,
 * a data prevista da suspensão (quando atrasada) e se o modo leitura está
 * valendo AGORA para ela. Também traz os pagamentos (para a aba do admin) e
 * a lista, para a tela da instalação, de toda organização atrasada ou
 * suspensa.
 *
 * ─── Por que NUNCA inventa estado numa falha de leitura ─────────────────────
 *
 * Mesma doutrina de `plano-da-organizacao.ts` e `estado-do-bloqueio.ts`: uma
 * leitura que falha aqui NÃO pode virar "em dia" nem "suspensa" por acidente,
 * as duas mentiras têm custo real (uma esconde um atraso, a outra assusta
 * um cliente em dia). `leituraFalhou: true` e `contrato: null` é o único
 * resultado possível de um erro; quem chama mostra "não foi possível ler
 * agora", nunca um estado.
 *
 * ─── Por que `modoLeituraValendo` só consulta o banco no modo `bloquear` ────
 *
 * Decisão 5 da fase: `fn_billing_modo_leitura` já lê `billing_settings`
 * ANTES de qualquer outra coisa e sai sem tocar `billing_contracts` no modo
 * `avisar`. Chamar a RPC sempre, em vez de olhar o modo primeiro aqui em
 * TypeScript, pagaria uma consulta a mais em toda carga de tela, em toda
 * instalação no modo `avisar` de hoje, só para a RPC devolver `false` sem
 * nunca olhar o contrato. Por isso o modo é lido primeiro, pelo mesmo cache
 * de 60s que `estado-do-bloqueio.ts` usa (`modoDeBillingCacheado`), e a RPC
 * só roda quando ele é `bloquear`.
 *
 * ─── `dataPrevistaDaSuspensao` é uma APROXIMAÇÃO de exibição ────────────────
 *
 * `current_period_end + grace_days` em milissegundos, não a mesma expressão
 * de `interval` que o Postgres usa no conferidor
 * (`fn_billing_conferir_vencimento`). Para exibir uma data numa tela, a
 * diferença (fuso com horário de verão, que o Brasil não usa desde 2019) não
 * importa; a autoridade sobre QUANDO a organização de fato muda de estado
 * continua sendo o banco.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { modoDeBillingCacheado } from "@/lib/billing/planos/modo-cacheado";

export const ESTADOS_DA_ASSINATURA = [
  "avaliacao",
  "ativa",
  "atrasada",
  "suspensa",
  "cancelada",
] as const;
export type EstadoContrato = (typeof ESTADOS_DA_ASSINATURA)[number];

/** Dias em milissegundos: ver o comentário do arquivo sobre a aproximação de exibição. */
const MS_POR_DIA = 24 * 60 * 60 * 1000;
const GRACE_DAYS_PADRAO = 7;

/**
 * O ÚLTIMO DIA coberto por um período cujo fim é EXCLUSIVO (migração 0908,
 * decisão 2): `current_period_end`/`billing_payments.billing_period_end`
 * gravam 00:00 em America/Sao_Paulo do dia SEGUINTE ao último dia pago (`(p_fim
 * + 1)::timestamp at time zone 'America/Sao_Paulo'`). Formatar esse instante
 * direto numa tela mostra um dia A MAIS (admin registra fim 30/10, a tela diz
 * "vence em 31/10"). Esta função devolve o instante um dia ANTES: como o
 * Brasil não tem horário de verão desde 2019 (mesma doutrina já usada acima,
 * `MS_POR_DIA`), subtrair 24h em milissegundos é exato, sem precisar de
 * biblioteca de fuso. Use para EXIBIR fim de período, "próximo vencimento" e
 * "avaliação até"; nunca para decidir o que o banco decide.
 *
 * ─── Por que NÃO se aplica a `dataPrevistaDaSuspensao` ─────────────────────
 *
 * `dataPrevistaDaSuspensao` não é o fim de um período PAGO: é o instante em
 * que `fn_billing_conferir_vencimento` de fato muda o estado para `suspensa`
 * (`current_period_end + grace_days <= now()`). Esse dia É o primeiro dia do
 * modo leitura, não o fim de um período anterior; é o mesmo valor que
 * `fn_billing_avisar_assinatura` (migração 0908) já formata SEM ajuste
 * nenhum ("... entra em modo leitura em " || to_char(v_data_suspensao ...)).
 * Passar esse valor por `ultimoDiaDoPeriodo` mostraria um dia ANTES do que o
 * conferidor realmente suspende: o mesmo bug que esta função existe para
 * corrigir, só que na direção contrária.
 */
export function ultimoDiaDoPeriodo(fimExclusivo: string | Date): Date {
  const instante = fimExclusivo instanceof Date ? fimExclusivo : new Date(fimExclusivo);
  return new Date(instante.getTime() - MS_POR_DIA);
}

/**
 * `current_period_end + grace_days`, só quando o estado é `atrasada` e o
 * período está preenchido (o único caso em que uma suspensão está prevista);
 * fora disso, `null`. Função pura, exportada para ser testada direto.
 */
export function dataPrevistaDaSuspensao(
  status: string,
  currentPeriodEnd: string | null,
  graceDays: number,
): string | null {
  if (status !== "atrasada" || !currentPeriodEnd) return null;
  return new Date(new Date(currentPeriodEnd).getTime() + graceDays * MS_POR_DIA).toISOString();
}

export interface ContratoDaAssinatura {
  status: EstadoContrato | string;
  cycle: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** `null` fora do estado `atrasada`, ou sem período gravado. */
  dataPrevistaDaSuspensao: string | null;
}

export interface ResultadoEstadoDaAssinatura {
  /** `null` só quando a organização não tem contrato gravado, ou a leitura falhou. */
  contrato: ContratoDaAssinatura | null;
  /** O modo leitura (decisão 5) está valendo AGORA para esta organização. */
  modoLeituraValendo: boolean;
  leituraFalhou: boolean;
}

interface LinhaDoContratoCru {
  status: string;
  cycle: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  billing_plans: { grace_days: number } | null;
}

const RESULTADO_EM_FALHA: ResultadoEstadoDaAssinatura = {
  contrato: null,
  modoLeituraValendo: false,
  leituraFalhou: true,
};

/**
 * O estado da assinatura de UMA organização. Nunca lança (ver o comentário
 * do arquivo). `admin` é sempre o cliente de SERVIÇO: `fn_billing_modo_leitura`
 * tem `execute` revogado de `anon`/`authenticated` (migração 0908, parte 2).
 */
export async function estadoDaAssinatura(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<ResultadoEstadoDaAssinatura> {
  try {
    const [contratoRes, { modo, error: erroModo }] = await Promise.all([
      admin
        .from("billing_contracts")
        .select(
          "status, cycle, current_period_start, current_period_end, cancel_at_period_end, billing_plans(grace_days)",
        )
        .eq("organization_id", organizationId)
        .maybeSingle(),
      modoDeBillingCacheado(admin),
    ]);

    if (contratoRes.error) {
      throw new Error(`ler billing_contracts: ${contratoRes.error.message}`);
    }
    if (erroModo) {
      throw new Error(`ler billing_settings: ${erroModo}`);
    }

    // Decisão 5: só consulta o interruptor de verdade no modo `bloquear`
    // (zero consulta a mais no modo `avisar`, o de hoje).
    let modoLeituraValendo = false;
    if (modo === "bloquear") {
      const { data: modoLeituraData, error: erroModoLeitura } = await admin.rpc(
        "fn_billing_modo_leitura" as never,
        { p_org: organizationId } as never,
      );
      if (erroModoLeitura) {
        throw new Error(`ler fn_billing_modo_leitura: ${erroModoLeitura.message}`);
      }
      modoLeituraValendo = Boolean(modoLeituraData);
    }

    const linha = contratoRes.data as unknown as LinhaDoContratoCru | null;

    if (!linha) {
      log?.warn("organização sem contrato de assinatura", { organization_id: organizationId });
      return { contrato: null, modoLeituraValendo, leituraFalhou: false };
    }

    const graceDays = linha.billing_plans?.grace_days ?? GRACE_DAYS_PADRAO;

    return {
      contrato: {
        status: linha.status,
        cycle: linha.cycle,
        currentPeriodStart: linha.current_period_start,
        currentPeriodEnd: linha.current_period_end,
        cancelAtPeriodEnd: linha.cancel_at_period_end ?? false,
        dataPrevistaDaSuspensao: dataPrevistaDaSuspensao(linha.status, linha.current_period_end, graceDays),
      },
      modoLeituraValendo,
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      etapa: "estado_da_assinatura",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return RESULTADO_EM_FALHA;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Pagamentos (para a aba do admin): decisão 1, `billing_payments`.
// ─────────────────────────────────────────────────────────────────────────

export interface PagamentoDaAssinatura {
  id: string;
  status: string;
  grossCents: number;
  paidAt: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  nota: string | null;
  /** `null` na linha REFUNDED que não estorna nada (nunca deveria acontecer) e em toda RECEIVED_IN_CASH. */
  estornaPagamentoId: string | null;
  autorId: string | null;
  /** `raw_user_meta_data.full_name`, quando o Auth tiver. */
  autorNome: string | null;
  autorEmail: string | null;
  createdAt: string;
}

export interface ResultadoPagamentosDaAssinatura {
  pagamentos: PagamentoDaAssinatura[];
  leituraFalhou: boolean;
}

interface LinhaDoPagamentoCru {
  id: string;
  status: string;
  gross_cents: number;
  paid_at: string;
  billing_period_start: string;
  billing_period_end: string;
  nota: string | null;
  estorna_pagamento_id: string | null;
  criado_por: string | null;
  created_at: string;
}

/**
 * Os pagamentos e estornos de UMA organização, mais recente primeiro, com o
 * autor resolvido pela Auth Admin API (mesmo caminho de
 * `livro-caixa-do-ciclo.ts`, decisão 7 da F2-B: enriquecimento, não dado
 * essencial, uma falha em resolver UM autor não derruba a leitura). Nunca
 * lança.
 */
export async function pagamentosDaAssinatura(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<ResultadoPagamentosDaAssinatura> {
  try {
    const { data, error } = await admin
      .from("billing_payments")
      .select(
        "id, status, gross_cents, paid_at, billing_period_start, billing_period_end, nota, estorna_pagamento_id, criado_por, created_at",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`ler billing_payments: ${error.message}`);
    }

    const linhas = (data ?? []) as unknown as LinhaDoPagamentoCru[];

    const idsDeAutor = [...new Set(linhas.map((l) => l.criado_por).filter((id): id is string => id !== null))];
    const autorPorId = new Map<string, { nome: string | null; email: string | null }>();
    await Promise.all(
      idsDeAutor.map(async (id) => {
        try {
          const { data: dadoDoAutor, error: erroDoAutor } = await admin.auth.admin.getUserById(id);
          if (erroDoAutor || !dadoDoAutor?.user) return;
          const meta = (dadoDoAutor.user.user_metadata as Record<string, unknown> | null) ?? null;
          const nome = typeof meta?.full_name === "string" ? meta.full_name : null;
          autorPorId.set(id, { nome, email: dadoDoAutor.user.email ?? null });
        } catch (err) {
          log?.warn("alarme_planos_leitura", {
            organization_id: organizationId,
            etapa: "resolver_autor_do_pagamento",
            error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          });
        }
      }),
    );

    const pagamentos: PagamentoDaAssinatura[] = linhas.map((linha) => {
      const autor = linha.criado_por ? autorPorId.get(linha.criado_por) : undefined;
      return {
        id: linha.id,
        status: linha.status,
        grossCents: linha.gross_cents,
        paidAt: linha.paid_at,
        billingPeriodStart: linha.billing_period_start,
        billingPeriodEnd: linha.billing_period_end,
        nota: linha.nota,
        estornaPagamentoId: linha.estorna_pagamento_id,
        autorId: linha.criado_por,
        autorNome: autor?.nome ?? null,
        autorEmail: autor?.email ?? null,
        createdAt: linha.created_at,
      };
    });

    return { pagamentos, leituraFalhou: false };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      etapa: "pagamentos_da_assinatura",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { pagamentos: [], leituraFalhou: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Organizações atrasadas e suspensas (tela da instalação, decisão 9).
// ─────────────────────────────────────────────────────────────────────────

export interface OrganizacaoAtrasadaOuSuspensa {
  organizationId: string;
  nome: string;
  status: "atrasada" | "suspensa";
  currentPeriodEnd: string | null;
  /** `null` para `suspensa` (a suspensão já aconteceu, não há mais "prevista"). */
  dataPrevistaDaSuspensao: string | null;
}

export interface ResultadoOrganizacoesAtrasadasESuspensas {
  organizacoes: OrganizacaoAtrasadaOuSuspensa[];
  leituraFalhou: boolean;
}

interface LinhaDaOrganizacaoCru {
  organization_id: string;
  status: string;
  current_period_end: string | null;
  billing_plans: { grace_days: number } | null;
  organizations: { display_name: string | null } | null;
}

/**
 * Toda organização com o contrato em `atrasada` ou `suspensa`, para a tela da
 * instalação (decisão 9: "a lista de atrasadas e suspensas na tela da
 * instalação"). Mais próxima do vencimento primeiro. Nunca lança.
 */
export async function organizacoesAtrasadasESuspensas(
  admin: SupabaseClient,
  log?: Logger,
): Promise<ResultadoOrganizacoesAtrasadasESuspensas> {
  try {
    const { data, error } = await admin
      .from("billing_contracts")
      .select("organization_id, status, current_period_end, billing_plans(grace_days), organizations(display_name)")
      .in("status", ["atrasada", "suspensa"])
      .order("current_period_end", { ascending: true });

    if (error) {
      throw new Error(`ler billing_contracts (atrasadas/suspensas): ${error.message}`);
    }

    const linhas = (data ?? []) as unknown as LinhaDaOrganizacaoCru[];

    const organizacoes: OrganizacaoAtrasadaOuSuspensa[] = linhas.map((linha) => {
      const graceDays = linha.billing_plans?.grace_days ?? GRACE_DAYS_PADRAO;
      return {
        organizationId: linha.organization_id,
        nome: linha.organizations?.display_name ?? linha.organization_id,
        status: linha.status as "atrasada" | "suspensa",
        currentPeriodEnd: linha.current_period_end,
        dataPrevistaDaSuspensao: dataPrevistaDaSuspensao(linha.status, linha.current_period_end, graceDays),
      };
    });

    return { organizacoes, leituraFalhou: false };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      etapa: "organizacoes_atrasadas_e_suspensas",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { organizacoes: [], leituraFalhou: true };
  }
}
