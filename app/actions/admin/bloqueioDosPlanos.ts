"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { MODOS_DE_BLOQUEIO } from "@/lib/billing/planos/bloqueio-da-instalacao";

/**
 * O controle do bloqueio de verdade dos planos pelo admin da plataforma
 * (fase F3, tarefa 10, decisão 11 de `hiperbold/planos/fase-F3-tarefas.md`).
 * As duas escritas seguem a MESMA forma de `planoDaOrganizacao.ts` (fase F1,
 * tarefa 4): escopo `full`, MFA em dia, zod no servidor, erro do banco nunca
 * vira `error.message` cru na resposta, sucesso audita e revalida a tela.
 *
 * ── Por que o gate confere o escopo, e não só `requirePlatformAdmin()` ──────
 *
 * Ligar o bloqueio de verdade é a escrita mais cara desta fase inteira: um
 * erro aqui trava a criação de funil, etapa, conexão, webhook, membro e lead
 * de TODA organização hospedada nesta instalação, para todo mundo. A mesma
 * régua de `trocarPlanoDaOrganizacao`: suporte lê, nunca liga bloqueio.
 *
 * ── Por que não existe função nova no banco para `definirDiasDeCarencia` ────
 *
 * `carencia_dias` é uma coluna solta de `billing_settings` (linha única,
 * id=1), e essa tabela tem `grant all ... to service_role` desde a migration
 * 0905: RLS está ligado, mas o `service_role` do Supabase ignora RLS (é
 * assim que `gravarComportamentoDaInstalacao`, em `platform_settings`, já
 * escreve direto pelo mesmo cliente admin, sem RPC). Uma função dedicada só
 * se justificaria para travar a linha (`for update`) contra duas trocas
 * concorrentes; para um número que só o admin da plataforma muda, e raras
 * vezes, a leitura-depois-escrita direta é o mesmo risco que já existe em
 * `gravarComportamentoDaInstalacao`, e não pareceu motivo para propor uma
 * migration nesta tarefa (que está proibida de tocar `supabase/`).
 */
const entradaModo = z.object({
  modo: z.enum(MODOS_DE_BLOQUEIO),
});

const entradaCarenciaDias = z.object({
  dias: z.number().int().min(0).max(90),
});

export type ResultadoDoModoDeBloqueio =
  | { ok: true; modoAnterior: string; modoNovo: string; organizacoesComCarencia: number }
  | { ok: false; error: string };

export type ResultadoDosDiasDeCarencia =
  | { ok: true; antes: number; depois: number }
  | { ok: false; error: string };

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

/**
 * Liga, avisa ou desliga o bloqueio de verdade (`fn_billing_definir_modo`,
 * migration 0907). A função SQL trava `billing_settings` (`for update`) e,
 * ao ENTRAR em `bloquear`, dá carência a toda organização sem data: o
 * `antes`/`depois` da auditoria vem exatamente do que ela devolveu, nunca de
 * uma releitura à parte (mesmo racional do comentário de `planoDaOrganizacao.ts`).
 */
export async function definirModoDeBloqueio(input: {
  modo: (typeof MODOS_DE_BLOQUEIO)[number];
}): Promise<ResultadoDoModoDeBloqueio> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite mudar o bloqueio dos planos." };
  }

  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaModo.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_definir_modo", {
    p_modo: parsed.data.modo,
    p_actor: user.id,
  });

  if (error) {
    logger.error("[bloqueioDosPlanos] erro ao definir o modo de bloqueio", {
      code: error.code ?? null,
      message: error.message ?? null,
    });
    return { ok: false, error: "Não foi possível salvar. Tente de novo." };
  }

  const resultado = data as {
    modo_anterior: string;
    modo_novo: string;
    organizacoes_com_carencia: number;
  };

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.mode_changed",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "billing_settings",
    metadata: {
      modo_anterior: resultado.modo_anterior,
      modo_novo: resultado.modo_novo,
      organizacoes_com_carencia: resultado.organizacoes_com_carencia,
    },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath("/admin/sistema");
  return {
    ok: true,
    modoAnterior: resultado.modo_anterior,
    modoNovo: resultado.modo_novo,
    organizacoesComCarencia: resultado.organizacoes_com_carencia,
  };
}

/**
 * Muda quantos dias de carência uma organização ganha ao entrar no modo
 * `bloquear` (`billing_settings.carencia_dias`, 0 a 90). NÃO retroage: não
 * recalcula `bloqueio_a_partir_de` de quem já tem data (comentário da coluna,
 * migration 0907).
 */
export async function definirDiasDeCarencia(input: {
  dias: number;
}): Promise<ResultadoDosDiasDeCarencia> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite mudar a carência." };
  }

  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCarenciaDias.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Informe um número inteiro de 0 a 90." };
  }

  const admin = createAdminClient();

  // O valor ANTERIOR entra na auditoria (sem ele a linha não responde "de
  // quanto para quanto"). Sem função de troca com `for update` (ver o
  // comentário do arquivo), é uma leitura seguida de escrita, mesmo padrão
  // de `gravarComportamentoDaInstalacao`.
  const { data: linhaAnterior, error: erroLeitura } = await admin
    .from("billing_settings")
    .select("carencia_dias")
    .eq("id", 1)
    .maybeSingle();

  if (erroLeitura) {
    logger.error("[bloqueioDosPlanos] erro ao ler os dias de carência atuais", {
      code: erroLeitura.code ?? null,
      message: erroLeitura.message ?? null,
    });
    return { ok: false, error: "Não foi possível salvar. Tente de novo." };
  }

  const antes = (linhaAnterior as { carencia_dias: number } | null)?.carencia_dias ?? 7;

  const { error: erroEscrita } = await admin
    .from("billing_settings")
    .update({ carencia_dias: parsed.data.dias })
    .eq("id", 1);

  if (erroEscrita) {
    logger.error("[bloqueioDosPlanos] erro ao gravar os dias de carência", {
      code: erroEscrita.code ?? null,
      message: erroEscrita.message ?? null,
    });
    return { ok: false, error: "Não foi possível salvar. Tente de novo." };
  }

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.grace_days_changed",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "billing_settings",
    metadata: { antes, depois: parsed.data.dias },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath("/admin/sistema");
  return { ok: true, antes, depois: parsed.data.dias };
}
