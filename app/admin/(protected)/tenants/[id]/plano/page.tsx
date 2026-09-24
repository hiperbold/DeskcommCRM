import { createLogger } from "@/lib/agent-engine/obs/logger";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import {
  estadoDaAssinatura,
  pagamentosDaAssinatura,
} from "@/lib/billing/assinatura/estado-da-assinatura";
import { estadoDoBloqueio } from "@/lib/billing/planos/estado-do-bloqueio";
import {
  CHAVES_DE_LIMITE,
  esquemaDoAjusteDeLimites,
  esquemaDoPlanoDeLimites,
  type AjusteDeLimites,
  type Limites,
} from "@/lib/billing/planos/limites";
import { planoDaOrganizacao } from "@/lib/billing/planos/plano-da-organizacao";
import { algumaLeituraFalhou, podeEscreverNaAba } from "@/lib/billing/planos/pode-escrever-na-aba";
import { livroCaixaDoCiclo } from "@/lib/billing/tokens/livro-caixa-do-ciclo";
import { painelDeMargem } from "@/lib/billing/tokens/margem";
import { saldoDaOrganizacao } from "@/lib/billing/tokens/saldo-da-organizacao";
import { createAdminClient } from "@/lib/supabase/admin";

import { TenantPlanoClient, type AdicionalAtivo, type PlanoAtivo } from "./_client";

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
 * decide o que a tela MOSTRA, e essa decisão, extraída para
 * `podeEscreverNaAba` (`lib/billing/planos/pode-escrever-na-aba.ts`), também
 * cai para leitura quando QUALQUER uma das quatro leituras abaixo falhou:
 * escrever por cima de um estado que a própria tela não conseguiu ler
 * apagaria, no upsert de `fn_billing_ajustar_limites`, exatamente a chave que
 * ninguém leu direito.
 *
 * ─── A seção "Tokens de IA" (fase F2-B, tarefa 7) ───────────────────────────
 *
 * Saldo, livro-caixa (com nota e autor, por isso é uma leitura PRÓPRIA desta
 * aba: `extratoDoCiclo`, tarefa 6, é para a tela do CLIENTE e nunca lê nota
 * nem autor) e o painel de margem, só para a plataforma. `saldoDaOrganizacao`
 * roda sozinha primeiro porque ela CONCEDE o ciclo atual (decisão 9) e
 * devolve o ciclo que `livroCaixaDoCiclo` e `painelDeMargem` reaproveitam, o
 * mesmo racional de `app/app/settings/plano/page.tsx`. Cada leitura tem seu
 * PRÓPRIO estado de falha na tela (não entra no `podeEscrever` do plano
 * acima): os quatro formulários da carteira são só ADITIVOS (creditar,
 * contratar, ajustar nunca sobrescrevem um estado não lido, ao contrário do
 * upsert de limites) e continuam liberados quando o escopo é `full`, mesmo
 * que o painel de margem, por exemplo, não tenha carregado.
 */
export default async function TenantPlanoPage({ params }: TenantPlanoPageProps) {
  const { id } = await params;
  const { platformAdmin } = await requirePlatformAdmin();
  const admin = createAdminClient();
  const log = createLogger();

  const [
    resultado,
    contratoCruRes,
    ajusteRes,
    planosRes,
    saldoResultadoRaw,
    bloqueio,
    assinatura,
    pagamentosResultado,
    pacotesAtivosRes,
  ] = await Promise.all([
    planoDaOrganizacao(admin, id, log),
    // Os limites CRUS do plano CONTRATADO (coluna "do plano" da tabela),
    // separados dos limites EM VIGOR (que já aplicam o ajuste) que
    // `planoDaOrganizacao` devolve.
    admin
      .from("billing_contracts")
      // `bloqueio_a_partir_de` (fase F3, tarefa 10) entra na MESMA leitura dos
      // limites crus: é a mesma linha de `billing_contracts`, e não vale abrir
      // um round trip a mais só para ela.
      .select("billing_plans(limits), bloqueio_a_partir_de")
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
    // A carteira de tokens de IA (fase F2-B, tarefa 7): saldo primeiro,
    // sozinha, porque ela é quem CONCEDE o ciclo atual (decisão 9 da fase) e
    // devolve o ciclo que as duas leituras seguintes reaproveitam. Mesmo
    // racional de `app/app/settings/plano/page.tsx` (tarefa 6): as três
    // nunca podem discordar sobre "que mês é este".
    saldoDaOrganizacao(admin, id, log),
    // Fase F3, tarefa 9: o estado real do bloqueio para ESTA organização
    // (desligado, em carência, ou valendo), para o texto fixo da aba parar de
    // dizer "nenhum limite bloqueia" quando o admin já ligou o bloqueio.
    estadoDoBloqueio(admin, id, {}, log),
    // Fase F4, tarefa 8: estado da assinatura (estado, período,
    // cancel_at_period_end, modo leitura) e os pagamentos/estornos.
    estadoDaAssinatura(admin, id, log),
    pagamentosDaAssinatura(admin, id, log),
    // Catálogo de pacotes ATIVOS (decisão 10), para "creditar pacote do
    // catálogo": mesmo padrão de `planosAtivos` acima (só o que pode ser
    // vendido hoje entra no formulário).
    admin
      .from("billing_token_pacotes")
      .select("id, codigo, nome, tokens, preco_cents")
      .eq("ativo", true)
      .order("nome", { ascending: true }),
  ]);

  const cicloDoSaldo =
    saldoResultadoRaw.status === "leitura_falhou" ? undefined : saldoResultadoRaw.ciclo;

  const [livroCaixaResultado, margemResultado, adicionaisAtivosRes] = await Promise.all([
    livroCaixaDoCiclo(admin, id, cicloDoSaldo, log),
    painelDeMargem(admin, id, cicloDoSaldo, log),
    admin
      .from("billing_token_adicionais")
      .select("id, tokens_por_ciclo, valor_cents, nota, created_at")
      .eq("organization_id", id)
      .eq("ativo", true)
      .order("created_at", { ascending: false }),
  ]);

  if (adicionaisAtivosRes.error) {
    log.error("alarme_planos_leitura", {
      organization_id: id,
      etapa: "adicionais_ativos_da_carteira",
      error: adicionaisAtivosRes.error.message.slice(0, 300),
    });
  }
  const leituraDosAdicionaisFalhou = Boolean(adicionaisAtivosRes.error);
  const adicionaisAtivos: AdicionalAtivo[] = leituraDosAdicionaisFalhou
    ? []
    : ((adicionaisAtivosRes.data ?? []) as AdicionalAtivo[]);

  const limitesTodosSemLimite = Object.fromEntries(
    CHAVES_DE_LIMITE.map((chave) => [chave, null]),
  ) as Limites;

  // Sem contrato, não existe "plano contratado" de verdade: a organização já
  // segue o mesmo caminho de fallback que `planoDaOrganizacao` usa (Ilimitado,
  // que É todo `null`), então a coluna "do plano" usa os mesmos limites em vez
  // de ficar vazia: o valor bate com o que a organização recebe na prática.
  const linhaContratoCru = contratoCruRes.data as
    | { billing_plans: { limits: unknown } | null; bloqueio_a_partir_de: string | null }
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

  // As três leituras que este componente faz direto (a quarta, o plano
  // efetivo, já vem resolvida em `resultado.leituraFalhou`). O erro do banco
  // vai só para o log: nunca para a tela, e nunca impede a tela de decidir
  // corretamente que não pode escrever.
  if (contratoCruRes.error) {
    log.error("alarme_planos_leitura", {
      organization_id: id,
      etapa: "limites_crus_do_plano_contratado",
      error: contratoCruRes.error.message.slice(0, 300),
    });
  }
  if (ajusteRes.error) {
    log.error("alarme_planos_leitura", {
      organization_id: id,
      etapa: "ajuste_de_limites",
      error: ajusteRes.error.message.slice(0, 300),
    });
  }
  if (planosRes.error) {
    log.error("alarme_planos_leitura", {
      organization_id: id,
      etapa: "lista_de_planos_ativos",
      error: planosRes.error.message.slice(0, 300),
    });
  }

  const leituras = {
    leituraDoPlanoFalhou: resultado.leituraFalhou,
    leituraDosLimitesDoPlanoFalhou: Boolean(contratoCruRes.error),
    leituraDoAjusteFalhou: Boolean(ajusteRes.error),
    leituraDosPlanosAtivosFalhou: Boolean(planosRes.error),
  };

  // Fase F4, tarefa 8: pacotes ATIVOS do catálogo, para "creditar pacote do
  // catálogo". Mesma régua ADITIVA dos adicionais de tokens acima: uma falha
  // aqui não tira a escrita do resto da aba, só esvazia esta lista própria.
  if (pacotesAtivosRes.error) {
    log.error("alarme_planos_leitura", {
      organization_id: id,
      etapa: "pacotes_ativos_do_catalogo",
      error: pacotesAtivosRes.error.message.slice(0, 300),
    });
  }
  const leituraDosPacotesFalhou = Boolean(pacotesAtivosRes.error);
  const pacotesAtivos = leituraDosPacotesFalhou
    ? []
    : ((pacotesAtivosRes.data ?? []) as {
        id: string;
        codigo: string;
        nome: string;
        tokens: number;
        preco_cents: number | null;
      }[]);

  return (
    <TenantPlanoClient
      organizationId={id}
      podeEscrever={podeEscreverNaAba(platformAdmin.scope, leituras)}
      plano={resultado.plano}
      contrato={resultado.contrato}
      assinatura={assinatura}
      pagamentos={pagamentosResultado.pagamentos}
      leituraDosPagamentosFalhou={pagamentosResultado.leituraFalhou}
      pacotesAtivos={pacotesAtivos}
      leituraDosPacotesFalhou={leituraDosPacotesFalhou}
      leituraFalhou={algumaLeituraFalhou(leituras)}
      limitesEmVigor={resultado.limites}
      limitesDoPlano={limitesDoPlano}
      carenciaAtual={linhaContratoCru?.bloqueio_a_partir_de ?? null}
      bloqueio={bloqueio}
      ajusteAtual={ajusteAtual}
      notaAtual={ajusteRow?.note ?? null}
      planosAtivos={planosAtivos}
      saldo={saldoResultadoRaw}
      livroCaixa={livroCaixaResultado}
      margem={margemResultado}
      adicionaisAtivos={adicionaisAtivos}
      leituraDosAdicionaisFalhou={leituraDosAdicionaisFalhou}
    />
  );
}
