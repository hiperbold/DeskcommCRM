/**
 * TenantOverview — o cartão que o admin de plataforma lê sobre um tenant.
 *
 * O defeito guardado aqui é de SAÍDA VISÍVEL: a tela comparava o status da
 * integração com `"active"`, valor que `tenant_integrations_status_check` não
 * admite. A integração saudável que o callback do OAuth grava (`healthy`) caía
 * no ramo final, e o admin lia a string crua do banco num badge de alerta —
 * enquanto `token_expired`, o estado que exige ação, era inalcançável por
 * construção.
 *
 * Dois níveis de guarda, de propósito:
 *  - os casos nomeados, que fixam o que o admin lê (rótulo + variante);
 *  - a cobertura contra o CHECK do `supabase/baseline.sql` — o arquivo que o
 *    self-hoster realmente aplica. Migration que acrescente um status ao banco
 *    sem atualizar os mapas da tela reprova aqui, que é exatamente o modo de
 *    falha que produziu este bug (o TypeScript não enxerga o CHECK).
 */
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";

import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { valoresDoCheckNoBaseline } from "@/tests/helpers/baseline-check";
import type { TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";

import {
  NUVEMSHOP_LABEL,
  NUVEMSHOP_VARIANT,
  TenantOverview,
} from "./TenantOverview";

/**
 * Vocabulário que o banco aceita, lido do baseline. A leitura (e o "falha alto
 * em vez de devolver lista vazia") mora em `tests/helpers/baseline-check.ts`,
 * compartilhada com a rota que alimenta esta tela: dois leitores escritos à mão
 * seriam a duplicação contra a qual esta guarda existe.
 */
const STATUS_NO_BANCO = valoresDoCheckNoBaseline(
  "tenant_integrations_status_check",
);

const ORG: TenantOrganization = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "acme",
  display_name: "Acme",
  legal_name: "Acme Comércio LTDA",
  cnpj: "00.000.000/0001-00",
  status: "active",
  onboarded_at: "2026-01-02T12:00:00.000Z",
  suspended_at: null,
  created_at: "2026-01-01T12:00:00.000Z",
  // `settings.plan` é campo legado: desde a Tarefa 6 da fase F1 dos planos de
  // assinatura, a tela não lê mais daqui (a fonte é `billing_contracts`, via
  // a prop `plano`). O valor fica só para provar que a tela IGNORA esta chave.
  settings: { plan: "pro" },
};

/** O plano do contrato, como a rota `/api/v1/admin/tenants/[id]` devolve hoje. */
const PLANO_ILIMITADO = { name: "Ilimitado", leituraFalhou: false };

const COUNTS: TenantCounts = {
  user_count: 3,
  conversations_count: 10,
  messages_count: 100,
  leads_count: 5,
  orders_count: 2,
  lgpd_requests_pending: 0,
  ai_invocations_30d: 42,
  waha_sessions_count: 1,
};

/**
 * O badge que a linha "Nuvemshop" exibe — o pedaço de tela em disputa.
 *
 * Ancora no rótulo da linha (e não numa classe) porque há outro badge no
 * cartão, o do plano. Se a marcação mudar a ponto de a linha não ter badge,
 * estoura em vez de devolver um elemento qualquer.
 */
function badgeNuvemshop(status: string | null): HTMLElement {
  const { container } = render(
    <TenantOverview
      organization={ORG}
      counts={COUNTS}
      integrations={{ nuvemshop_status: status, nuvemshop_connected_at: null }}
      plano={PLANO_ILIMITADO}
    />,
  );
  const badge = within(container).getByText("Nuvemshop").nextElementSibling
    ?.firstElementChild;
  if (!(badge instanceof HTMLElement)) {
    throw new Error("a linha 'Nuvemshop' não renderizou um badge");
  }
  return badge;
}

/** Classe que o `Badge` produz para uma variante — evita fixar tokens do tema. */
function classeDaVariante(
  variante: "success" | "warning" | "error" | "neutral",
): string {
  return cn(badgeVariants({ variant: variante }));
}

describe("TenantOverview — status da Nuvemshop", () => {
  it("integração saudável lê 'Conectado', não a string do banco", () => {
    const badge = badgeNuvemshop("healthy");
    expect(badge).toHaveTextContent("Conectado");
    expect(badge.textContent).not.toContain("healthy");
    expect(badge.className).toBe(classeDaVariante("success"));
  });

  it("token vencido é erro visível, o ramo que era inalcançável", () => {
    const badge = badgeNuvemshop("token_expired");
    expect(badge).toHaveTextContent("Token expirado");
    expect(badge.className).toBe(classeDaVariante("error"));
    // Antes do conserto, TODO status conhecido caía no ramo final e saía com
    // cara de alerta genérico.
    expect(badge.className).not.toBe(classeDaVariante("warning"));
  });

  it("tenant sem integração diz 'Não integrado' em tom neutro", () => {
    const badge = badgeNuvemshop(null);
    expect(badge).toHaveTextContent("Não integrado");
    expect(badge.className).toBe(classeDaVariante("neutral"));
  });

  it("nenhum status que o banco aceita vaza cru para a tela", () => {
    for (const status of STATUS_NO_BANCO) {
      const texto = (badgeNuvemshop(status).textContent ?? "").trim();
      expect(texto, `status '${status}' sem rótulo em NUVEMSHOP_LABEL`).not.toBe(
        status,
      );
      expect(texto.length).toBeGreaterThan(0);
    }
  });

  it("os mapas cobrem o CHECK do banco — rótulo E variante", () => {
    // Rótulo e variante são mapas independentes: um status com rótulo e sem
    // variante sai com o fallback de alerta, e isso não aparece no texto.
    for (const status of STATUS_NO_BANCO) {
      expect(Object.keys(NUVEMSHOP_LABEL)).toContain(status);
      expect(Object.keys(NUVEMSHOP_VARIANT)).toContain(status);
    }
  });

  it("status fora do vocabulário aparece cru, mas nunca com cara de saudável", () => {
    // Exibir o valor desconhecido é decisão registrada no componente: esconder
    // um estado que a tela não sabe nomear é pior que mostrá-lo. O ramo é
    // inalcançável para qualquer valor real — quem garante isso é o teste de
    // cobertura acima. O que ele não pode é ler como "tudo certo".
    const badge = badgeNuvemshop("quota_exceeded");
    expect(badge).toHaveTextContent("quota_exceeded");
    expect(STATUS_NO_BANCO).not.toContain("quota_exceeded");
    expect(badge.className).not.toBe(classeDaVariante("success"));
  });
});

/**
 * TenantOverview, linha "Plano" (Tarefa 6, fase F1 dos planos de assinatura).
 *
 * O campo antigo `organizations.settings.plan` foi aposentado como fonte de
 * plano (hiperbold/planos/fase-F1-tarefas.md, decisão de desenho 12): a fonte
 * agora é o contrato em `billing_contracts`, lido no servidor por
 * `planoDaOrganizacao` e passado a este componente pela prop `plano`. `ORG`
 * acima ainda traz `settings.plan: "pro"` de propósito, para provar que a
 * tela IGNORA esse valor.
 */
function linhaPlano(plano: { name: string; leituraFalhou: boolean }): HTMLElement {
  const { container } = render(
    <TenantOverview
      organization={ORG}
      counts={COUNTS}
      integrations={{ nuvemshop_status: null, nuvemshop_connected_at: null }}
      plano={plano}
    />,
  );
  const badge = within(container).getByText("Plano").nextElementSibling?.firstElementChild;
  if (!(badge instanceof HTMLElement)) {
    throw new Error("a linha 'Plano' não renderizou um badge");
  }
  return badge;
}

describe("TenantOverview, Plano vem do contrato, não de settings.plan", () => {
  it("mostra o nome do plano do contrato, e não organization.settings.plan", () => {
    const badge = linhaPlano({ name: "Scale", leituraFalhou: false });
    expect(badge).toHaveTextContent("Scale");
    // ORG.settings.plan é "pro": se a tela ainda lesse dali, o texto seria "pro".
    expect(badge.textContent).not.toContain("pro");
  });

  it("leitura do plano falhou: mostra 'Plano indisponível', nunca 'Ilimitado'", () => {
    // O fallback de erro de `planoDaOrganizacao` é o plano Ilimitado com
    // `leituraFalhou: true`; a tela não pode repetir "Ilimitado" nesse caso,
    // porque confundiria erro de leitura com plano contratado.
    const badge = linhaPlano({ name: "Ilimitado", leituraFalhou: true });
    expect(badge).toHaveTextContent("Plano indisponível");
    expect(badge.textContent).not.toContain("Ilimitado");
  });
});
