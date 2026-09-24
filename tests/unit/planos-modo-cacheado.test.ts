/**
 * Revisão da F3 (achado baixo 4): `modoDeBillingCacheado`
 * (`lib/billing/planos/modo-cacheado.ts`) é o cache de 60s compartilhado por
 * `estado-do-bloqueio.ts` e `bloqueio-vale.ts`, mesmo padrão de
 * `modoDeBillingPeloDb` (`run-model-call.ts`). Este arquivo prova a peça em
 * si, sem passar pelos dois consumidores.
 */
import { describe, expect, it } from "vitest";

import { modoDeBillingCacheado } from "@/lib/billing/planos/modo-cacheado";

function adminFalso(modo: string | null, erro?: string) {
  let leituras = 0;
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            leituras += 1;
            return erro ? { data: null, error: { message: erro } } : { data: { modo }, error: null };
          },
        }),
      }),
    }),
  };
  return { admin: admin as never, contarLeituras: () => leituras };
}

describe("modoDeBillingCacheado", () => {
  it("duas chamadas seguidas com o MESMO client leem uma vez só", async () => {
    const { admin, contarLeituras } = adminFalso("bloquear");

    const r1 = await modoDeBillingCacheado(admin);
    const r2 = await modoDeBillingCacheado(admin);

    expect(r1).toEqual({ modo: "bloquear", error: null });
    expect(r2).toEqual({ modo: "bloquear", error: null });
    expect(contarLeituras()).toBe(1);
  });

  it("clients DIFERENTES nunca compartilham cache", async () => {
    const a = adminFalso("avisar");
    const b = adminFalso("bloquear");

    const ra = await modoDeBillingCacheado(a.admin);
    const rb = await modoDeBillingCacheado(b.admin);

    expect(ra.modo).toBe("avisar");
    expect(rb.modo).toBe("bloquear");
    expect(a.contarLeituras()).toBe(1);
    expect(b.contarLeituras()).toBe(1);
  });

  it("leitura que falha NÃO é cacheada: a próxima chamada tenta de novo", async () => {
    const { admin, contarLeituras } = adminFalso(null, "conexão recusada");

    const r1 = await modoDeBillingCacheado(admin);
    const r2 = await modoDeBillingCacheado(admin);

    expect(r1.error).toBe("conexão recusada");
    expect(r2.error).toBe("conexão recusada");
    expect(contarLeituras()).toBe(2);
  });
});
