import { createLogger } from "@/lib/agent-engine/obs/logger";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import {
  CHAVES_DE_LIMITE,
  esquemaDoAjusteDeLimites,
  esquemaDoPlanoDeLimites,
  type AjusteDeLimites,
  type Limites,
} from "@/lib/billing/planos/limites";
import { planoDaOrganizacao } from "@/lib/billing/planos/plano-da-organizacao";
import { createAdminClient } from "@/lib/supabase/admin";

import { TenantPlanoClient, type PlanoAtivo } from "./_client";

interface TenantPlanoPageProps {
  params: Promise<{ id: string }>;
}

/**
 * A aba "Plano" no painel do admin da plataforma (fase F1, tarefa 5).
 *
 * ─── Por que lê direto com o cliente de serviço, ao contrário de Saúde e Agente ──
 *
 * As abas Saúde e Agente buscam pelo cliente, via React Query, numa rota
 * `/api/v1/admin/tenants/[id]/...`. Esta lê no servidor e passa tudo pronto
 * ao client component, no mesmo padrão de `/admin/meta` e `/admin/google`
 * (leitura de tabela protegida por RLS sem policy de escrita, servida só pelo
 * admin da plataforma). É a forma pedida pela especificação da tarefa, e
 * evita abrir uma rota de API nova só para repassar o que o servidor já lê.
 *
 * A tela NÃO é a barreira: toda escrita (`trocarPlanoDaOrganizacao`,
 * `ajustarLimitesDaOrganizacao`) confere de novo `requirePlatformAdmin()` e o
 * escopo `full` dentro da própria server action. Aqui `podeEscrever` só
 * decide o que a tela MOSTRA.
 */
export default async function TenantPlanoPage({ params }: TenantPlanoPageProps) {
  const { id } = await params;
  const { platformAdmin } = await requirePlatformAdmin();
  const admin = createAdminClient();
  const log = createLogger();

  const [resultado, contratoCruRes, ajusteRes, planosRes] = await Promise.all([
    planoDaOrganizacao(admin, id, log),
    // Os limites CRUS do plano CONTRATADO (coluna "do plano" da tabela),
    // separados dos limites EM VIGOR (que já aplicam o ajuste) que
    // `planoDaOrganizacao` devolve.
    admin
      .from("billing_contracts")
      .select("billing_plans(limits)")
      .eq("organization_id", id)
      .maybeSingle(),
    admin
      .from("billing_plan_adjustments")
      .select("limits, note")
      .eq("organization_id", id)
      .maybeSingle(),
    // Só planos ATIVOS entram no seletor de troca: `active` é a versão em
    // vigor de cada `code` (índice único parcial na migration 0904).
    admin
      .from("billing_plans")
      .select("code, name, version, price_monthly_cents, for_sale")
      .eq("active", true)
      .order("price_monthly_cents", { ascending: true }),
  ]);

  const limitesTodosSemLimite = Object.fromEntries(
    CHAVES_DE_LIMITE.map((chave) => [chave, null]),
  ) as Limites;

  // Sem contrato, não existe "plano contratado" de verdade: a organização já
  // segue o mesmo caminho de fallback que `planoDaOrganizacao` usa (Ilimitado,
  // que É todo `null`), então a coluna "do plano" usa os mesmos limites em vez
  // de ficar vazia: o valor bate com o que a organização recebe na prática.
  const linhaContratoCru = contratoCruRes.data as
    | { billing_plans: { limits: unknown } | null }
    | null;
  const limitesDoPlanoParseados = esquemaDoPlanoDeLimites.safeParse(
    linhaContratoCru?.billing_plans?.limits,
  );
  const limitesDoPlano: Limites = limitesDoPlanoParseados.success
    ? limitesDoPlanoParseados.data
    : limitesTodosSemLimite;

  const ajusteRow = ajusteRes.data as { limits: unknown; note: string | null } | null;
  const ajusteAtualParseado = esquemaDoAjusteDeLimites.safeParse(ajusteRow?.limits ?? {});
  const ajusteAtual: AjusteDeLimites = ajusteAtualParseado.success ? ajusteAtualParseado.data : {};

  const planosAtivos: PlanoAtivo[] = (planosRes.data ?? []) as PlanoAtivo[];

  return (
    <TenantPlanoClient
      organizationId={id}
      podeEscrever={platformAdmin.scope === "full"}
      plano={resultado.plano}
      contrato={resultado.contrato}
      leituraFalhou={resultado.leituraFalhou}
      limitesEmVigor={resultado.limites}
      limitesDoPlano={limitesDoPlano}
      ajusteAtual={ajusteAtual}
      notaAtual={ajusteRow?.note ?? null}
      planosAtivos={planosAtivos}
    />
  );
}
