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
import { esquemaDoAjusteDeLimites, type AjusteDeLimites } from "@/lib/billing/planos/limites";

/**
 * As duas escritas do admin da plataforma sobre o plano de uma organização
 * (fase F1, tarefa 4): trocar o plano contratado e ajustar os tetos por cima
 * dele. As duas seguem a mesma forma que `salvarConfiguracaoDaInstalacao.ts`
 * e `updateComportamento.ts`.
 *
 * ── Por que o gate confere o escopo, e não só `requirePlatformAdmin()` ──────
 *
 * `requirePlatformAdmin()` garante que a sessão é de ALGUM admin da
 * plataforma, `full` ou `support_readonly`. O plano de uma organização é
 * ESCRITA de negócio (preço, teto): a mesma régua de
 * `app/api/v1/admin/tenants/route.ts:166`, onde suporte lê e nunca escreve.
 * Sem essa segunda checagem, um admin de suporte trocaria o plano de
 * qualquer cliente por um POST direto na action.
 *
 * ── Por que as duas conferem `mfaEmDivida()`, e não só o escopo ─────────────
 *
 * Achado da auditoria: a criação de organização já exige a verificação em
 * duas etapas provada NA SESSÃO (`app/api/v1/admin/tenants/route.ts`, mesma
 * régua de `mfaEmDivida()`), e trocar o plano ou abrir uma exceção de teto é
 * escrita de negócio do mesmo porte. Sem a checagem, uma sessão de admin
 * `full` com o segundo fator pendente (ex.: sessão antiga que ainda não caiu)
 * faria a mesma escrita sem provar de novo que é quem diz ser.
 *
 * ── Por que o "antes"/"depois" vêm da FUNÇÃO SQL, nunca de uma leitura à parte ──
 *
 * `fn_billing_trocar_plano` e `fn_billing_ajustar_limites` travam a linha
 * (`for update`) antes de gravar e devolvem o que ficou persistido. Uma
 * leitura separada depois do `rpc()` correria atrás de uma troca concorrente
 * e a auditoria mentiria sobre o que realmente mudou nesta chamada.
 *
 * ── Por que o erro do banco nunca vira `error.message` na resposta ──────────
 *
 * A mensagem de erro do Postgres pode conter nome de coluna, de tabela ou
 * fragmento de SQL, e nada disso é para a tela. Só os dois erros com
 * `errcode = 'P0002'` que as funções levantam de propósito viram frase fixa
 * reconhecível; qualquer outro vira uma frase genérica e o texto cru vai só
 * para o log do servidor.
 */

const entradaTrocarPlano = z.object({
  organizationId: z.string().uuid(),
  planCode: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
});

const entradaAjustarLimites = z.object({
  organizationId: z.string().uuid(),
  limites: esquemaDoAjusteDeLimites,
  nota: z.string().trim().max(500).optional(),
});

/**
 * `novaData` chega como "AAAA-MM-DD" (o valor cru de um `<input type="date">`)
 * e é lida como meia-noite UTC daquele dia, o mesmo horário para qualquer
 * fuso de quem administra, e evita que a validação de "no máximo 90 dias"
 * mude conforme o fuso do navegador.
 */
const entradaCarenciaExtra = z.object({
  organizationId: z.string().uuid(),
  novaData: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de data inválido"),
});

const MS_POR_DIA = 24 * 60 * 60 * 1000;
const MAXIMO_DE_DIAS_DE_CARENCIA_EXTRA = 90;

export type ResultadoDaAcaoDoPlano =
  | { ok: true; antes: unknown; depois: unknown }
  | { ok: false; error: string };

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    // Pela régua única do projeto, não lendo o cabeçalho à mão: quando a
    // leitura do IP for endurecida (D-036), esta auditoria acompanha sozinha.
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

function caminhoDaAbaDePlano(organizationId: string): string {
  return `/admin/tenants/${organizationId}/plano`;
}

/**
 * Traduz o erro de `fn_billing_trocar_plano` / `fn_billing_ajustar_limites`
 * para a frase que a tela mostra. Os dois códigos de negócio são fixos
 * (`organizacao_nao_encontrada`, `plano_nao_encontrado_ou_inativo`), sempre
 * com `errcode = 'P0002'`; qualquer outra coisa é falha inesperada do banco,
 * e o texto original nunca sai daqui.
 */
function mensagemDoErroDeEscrita(error: { code?: string; message?: string } | null): string {
  if (error?.code === "P0002") {
    if (error.message?.includes("organizacao_nao_encontrada")) return "Organização não encontrada.";
    if (error.message?.includes("plano_nao_encontrado_ou_inativo")) return "Plano não encontrado.";
  }
  logger.error("[planoDaOrganizacao] erro na escrita do plano", {
    code: error?.code ?? null,
    message: error?.message ?? null,
  });
  return "Não foi possível salvar. Tente de novo.";
}

/**
 * Compara o `antes`/`depois` que `fn_billing_ajustar_limites` devolveu. Os
 * dois só existem como `null` (sem ajuste) ou como um objeto raso de
 * `chave -> número | null` (o formato de `AjusteDeLimites`), então a
 * comparação campo a campo é suficiente; não há aninhamento a percorrer.
 */
function ajusteAntesEDepoisIguais(antes: unknown, depois: unknown): boolean {
  if (antes === depois) return true;
  if (antes === null || depois === null) return false;
  if (typeof antes !== "object" || typeof depois !== "object") return false;
  const objAntes = antes as Record<string, unknown>;
  const objDepois = depois as Record<string, unknown>;
  const chaves = new Set([...Object.keys(objAntes), ...Object.keys(objDepois)]);
  for (const chave of chaves) {
    if (objAntes[chave] !== objDepois[chave]) return false;
  }
  return true;
}

export async function trocarPlanoDaOrganizacao(input: {
  organizationId: string;
  planCode: string;
}): Promise<ResultadoDaAcaoDoPlano> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite trocar o plano." };
  }

  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaTrocarPlano.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_trocar_plano", {
    p_org: parsed.data.organizationId,
    p_plan_code: parsed.data.planCode,
    p_actor: user.id,
  });

  if (error) {
    return { ok: false, error: mensagemDoErroDeEscrita(error) };
  }

  const resultado = data as { antes: unknown; depois: unknown };
  const { requestId, ip, userAgent } = await contextoDaRequisicao();

  await audit({
    action: "billing.plan_changed",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organizationId,
    resourceType: "organization",
    resourceId: parsed.data.organizationId,
    metadata: { antes: resultado.antes, depois: resultado.depois },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, antes: resultado.antes, depois: resultado.depois };
}

/**
 * A carência extra de UMA organização (fase F3, tarefa 10, decisão 11):
 * adia `billing_contracts.bloqueio_a_partir_de` para uma data futura
 * informada, no máximo 90 dias a partir de agora. Só ADIA, nunca antecipa
 * uma carência que a organização já tem, e nunca cria carência do nada para
 * quem não bloqueia hoje (organização com `bloqueio_a_partir_de` nulo não
 * bloqueia, decisão 2 da fase; "estender" sem uma data para estender não
 * tem sentido, e a ação recusa com frase fixa).
 *
 * ── Por que não existe função nova no banco aqui ─────────────────────────────
 *
 * `billing_contracts` tem `grant all ... to service_role` desde a migration
 * 0904, o mesmo caso de `definirDiasDeCarencia` em `bloqueioDosPlanos.ts`: o
 * `service_role` ignora RLS, e o cliente admin já escreve direto em tabela
 * protegida por RLS em outros pontos do repositório (`platform_settings`,
 * `platform_config`). Uma função dedicada, com `for update`, evitaria a
 * janela entre a leitura do `antes` e a escrita do `depois` numa troca
 * concorrente; para uma ação rara e feita por um humano (o admin da
 * plataforma abrindo uma exceção pontual), o mesmo risco que
 * `gravarComportamentoDaInstalacao` já assume pareceu aceitável, e não vi
 * motivo para propor uma migration nesta tarefa (proibida de tocar
 * `supabase/`).
 */
export async function darCarenciaExtra(input: {
  organizationId: string;
  novaData: string;
}): Promise<ResultadoDaAcaoDoPlano> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite estender a carência." };
  }

  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaCarenciaExtra.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const alvo = new Date(`${parsed.data.novaData}T00:00:00.000Z`);
  const agora = Date.now();

  if (Number.isNaN(alvo.getTime())) {
    return { ok: false, error: "Dados inválidos." };
  }
  if (alvo.getTime() <= agora) {
    return { ok: false, error: "A nova data precisa estar no futuro." };
  }
  if (alvo.getTime() > agora + MAXIMO_DE_DIAS_DE_CARENCIA_EXTRA * MS_POR_DIA) {
    return { ok: false, error: "A carência extra vai no máximo até 90 dias a partir de hoje." };
  }

  const admin = createAdminClient();

  const { data: linha, error: erroLeitura } = await admin
    .from("billing_contracts")
    .select("id, bloqueio_a_partir_de")
    .eq("organization_id", parsed.data.organizationId)
    .maybeSingle();

  if (erroLeitura) {
    logger.error("[planoDaOrganizacao] erro ao ler a carência atual", {
      code: erroLeitura.code ?? null,
      message: erroLeitura.message ?? null,
    });
    return { ok: false, error: "Não foi possível salvar. Tente de novo." };
  }

  const contrato = linha as { id: string; bloqueio_a_partir_de: string | null } | null;

  if (!contrato) {
    return { ok: false, error: "Organização não encontrada." };
  }
  if (!contrato.bloqueio_a_partir_de) {
    return {
      ok: false,
      error: "Esta organização não tem bloqueio programado; não há carência para estender.",
    };
  }
  if (alvo.getTime() <= new Date(contrato.bloqueio_a_partir_de).getTime()) {
    return { ok: false, error: "A nova data precisa ser depois da carência atual." };
  }

  const antes = contrato.bloqueio_a_partir_de;
  const depois = alvo.toISOString();

  const { error: erroEscrita } = await admin
    .from("billing_contracts")
    .update({ bloqueio_a_partir_de: depois })
    .eq("id", contrato.id);

  if (erroEscrita) {
    logger.error("[planoDaOrganizacao] erro ao gravar a carência extra", {
      code: erroEscrita.code ?? null,
      message: erroEscrita.message ?? null,
    });
    return { ok: false, error: "Não foi possível salvar. Tente de novo." };
  }

  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: "billing.grace_extended",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    organizationId: parsed.data.organizationId,
    resourceType: "organization",
    resourceId: parsed.data.organizationId,
    metadata: { antes, depois },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, antes, depois };
}

export async function ajustarLimitesDaOrganizacao(input: {
  organizationId: string;
  limites: AjusteDeLimites;
  nota?: string;
}): Promise<ResultadoDaAcaoDoPlano> {
  const { user, platformAdmin } = await requirePlatformAdmin();

  if (platformAdmin.scope !== "full") {
    return { ok: false, error: "Seu acesso de suporte não permite ajustar limites." };
  }

  if (await mfaEmDivida()) {
    return { ok: false, error: "Confirme a verificação em duas etapas." };
  }

  const parsed = entradaAjustarLimites.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_ajustar_limites", {
    p_org: parsed.data.organizationId,
    p_limits: parsed.data.limites,
    p_note: parsed.data.nota ?? null,
    p_actor: user.id,
  });

  if (error) {
    return { ok: false, error: mensagemDoErroDeEscrita(error) };
  }

  const resultado = data as { antes: unknown; depois: unknown };

  // Remover o ajuste não é conceder um (achado da revisão). Sem esta
  // distinção, "Remover ajuste" gravava sempre `adjustment_granted`, até
  // numa organização que já não tinha ajuste nenhum, o que auditava um evento
  // vazio (`antes: null, depois: null`). Agora: nada mudou não audita nada
  // (inclusive os dois `null`); `depois: null` com `antes` que existia é
  // remoção; qualquer outra mudança é concessão, e só ela carrega a nota.
  if (!ajusteAntesEDepoisIguais(resultado.antes, resultado.depois)) {
    const foiRemocao = resultado.depois === null && resultado.antes !== null;
    const { requestId, ip, userAgent } = await contextoDaRequisicao();

    await audit({
      action: foiRemocao ? "billing.adjustment_removed" : "billing.adjustment_granted",
      actorUserId: user.id,
      actingAsPlatformAdmin: true,
      organizationId: parsed.data.organizationId,
      resourceType: "organization",
      resourceId: parsed.data.organizationId,
      metadata: foiRemocao
        ? { antes: resultado.antes, depois: resultado.depois }
        : { antes: resultado.antes, depois: resultado.depois, nota: parsed.data.nota ?? null },
      requestId,
      ip,
      userAgent,
    });
  }

  revalidatePath(caminhoDaAbaDePlano(parsed.data.organizationId));
  return { ok: true, antes: resultado.antes, depois: resultado.depois };
}
