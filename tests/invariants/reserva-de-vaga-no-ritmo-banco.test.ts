/**
 * Migração 0944: reserva atômica de vaga no ritmo de envio por token (D-167). Provado no Postgres
 * real, chamando as funções como o servidor chama:
 *   1. a primeira reserva grava a vaga no pacing_ledger;
 *   2. a segunda, logo em seguida, NÃO passa junto: o espaçamento curto reserva a vaga para o
 *      instante em que o número libera (sent_at depois da primeira), o longo recusa sem gravar;
 *   3. o teto do dia recusa sem gravar;
 *   4. devolver a vaga apaga a linha, e só a da organização e do canal certos;
 *   5. canal de outra organização é recusado;
 *   6. só service_role executa.
 *
 * Roda via `pnpm test:db tests/invariants/reserva-de-vaga-no-ritmo-banco.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0944a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(1);
const OUTRA_ORG = U(2);
const CANAL = U(10);
const CANAL_TETO = U(11);

const reservar = (org: string, canal: string, teto: string, esperaMs: number, maximaMs: number) =>
  JSON.parse(
    sql(
      `select public.fn_pacing_reservar_vaga('${org}'::uuid, '${canal}'::uuid, now(), date_trunc('day', now()), ${teto}, ${esperaMs}, ${maximaMs})::text;`,
    ),
  ) as { liberado: boolean; motivo?: string; vaga_id?: string; libera_em?: string };
const linhas = (canal: string) => sql(`select count(*) from public.pacing_ledger where channel_session_id = '${canal}';`);

describe("0944: setup", () => {
  it("cria as organizações e os canais", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG}', 'i944-a', 'i944 LTDA', 'i944'), ('${OUTRA_ORG}', 'i944-b', 'i944 LTDA', 'i944') on conflict (id) do nothing;
      insert into public.channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
        values ('${CANAL}', '${ORG}', 'i944-c1', 'WORKING', decode('00', 'hex')), ('${CANAL_TETO}', '${ORG}', 'i944-c2', 'WORKING', decode('00', 'hex')) on conflict (id) do nothing;
    `);
    expect(sql(`select count(*) from public.channel_sessions where id in ('${CANAL}', '${CANAL_TETO}');`)).toBe("2");
  });
});

describe("0944: reserva", () => {
  it("a primeira reserva libera e grava a vaga", () => {
    const r = reservar(ORG, CANAL, "null", 1500, 5000);
    expect(r.liberado).toBe(true);
    expect(r.vaga_id).toBeTruthy();
    expect(linhas(CANAL)).toBe("1");
  });

  it("a segunda, logo depois, não passa junto: reserva a vaga do instante seguinte, depois da primeira", () => {
    const r = reservar(ORG, CANAL, "null", 1500, 5000);
    expect(r.liberado).toBe(true);
    expect(linhas(CANAL)).toBe("2");
    const diferencaMs = Number(sql(`select round(extract(epoch from (max(sent_at) - min(sent_at))) * 1000) from public.pacing_ledger where channel_session_id = '${CANAL}';`));
    expect(diferencaMs).toBeGreaterThanOrEqual(1400);
  });

  it("espaçamento acima da espera máxima recusa sem gravar nada", () => {
    const antes = linhas(CANAL);
    const r = reservar(ORG, CANAL, "null", 60_000, 1000);
    expect(r).toMatchObject({ liberado: false, motivo: "espacamento" });
    expect(r.libera_em).toBeTruthy();
    expect(linhas(CANAL)).toBe(antes);
  });

  it("o teto do dia recusa sem gravar", () => {
    expect(reservar(ORG, CANAL_TETO, "1", 0, 5000).liberado).toBe(true);
    const r = reservar(ORG, CANAL_TETO, "1", 0, 5000);
    expect(r).toMatchObject({ liberado: false, motivo: "teto_diario" });
    expect(linhas(CANAL_TETO)).toBe("1");
  });

  it("canal de outra organização é recusado", () => {
    const erro = (() => {
      try {
        reservar(OUTRA_ORG, CANAL, "null", 0, 5000);
        return null;
      } catch (e) {
        return motivoDoErro(e);
      }
    })();
    expect(erro).toContain("pacing_canal_inexistente");
  });
});

describe("0944: devolução da vaga", () => {
  it("apaga a linha reservada, e só com a organização e o canal certos", () => {
    const r = reservar(ORG, CANAL, "null", 0, 5000);
    const antes = linhas(CANAL);
    expect(sql(`select public.fn_pacing_liberar_vaga('${OUTRA_ORG}'::uuid, '${CANAL}'::uuid, '${r.vaga_id}'::uuid)::text;`)).toBe("false");
    expect(sql(`select public.fn_pacing_liberar_vaga('${ORG}'::uuid, '${CANAL_TETO}'::uuid, '${r.vaga_id}'::uuid)::text;`)).toBe("false");
    expect(linhas(CANAL)).toBe(antes);
    expect(sql(`select public.fn_pacing_liberar_vaga('${ORG}'::uuid, '${CANAL}'::uuid, '${r.vaga_id}'::uuid)::text;`)).toBe("true");
    expect(Number(linhas(CANAL))).toBe(Number(antes) - 1);
  });
});

describe("0944: forma", () => {
  it("só service_role executa as duas funções", () => {
    for (const f of ["fn_pacing_reservar_vaga", "fn_pacing_liberar_vaga"]) {
      const acl = sql(`select has_function_privilege('anon', p.oid, 'execute')::text || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text || '|' || has_function_privilege('service_role', p.oid, 'execute')::text from pg_proc p where proname = '${f}' and pronamespace = 'public'::regnamespace;`);
      expect(acl).toBe("false|false|true");
    }
  });
});
