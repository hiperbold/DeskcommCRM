import { describe, expect, it, vi } from "vitest";

import { comTravaDeRegistro } from "@/lib/channels/meta/trava-de-registro";

/**
 * A trava do registro do número (D-174, achado 6): um segundo pedido de registro da MESMA sessão de canal,
 * enquanto o primeiro fala com a Meta, não pode seguir (gastaria tentativas do PIN e poderia gerar dois PINs
 * diferentes). A trava é um advisory lock de SESSÃO do Postgres: segura enquanto a conexão que a tomou
 * existe, e solta sozinha se o processo morrer. Aqui o `pg.Pool` é um dublê que devolve o que o Postgres
 * devolveria; o que se prova é o uso: quem pega a trava solta no fim (inclusive em erro), e quem não pega
 * não executa nada.
 */

interface Chamada {
  sql: string;
  valores: unknown[];
}

function poolDeMentira(opcoes: { livre: boolean; falhaAoSoltar?: boolean }) {
  const chamadas: Chamada[] = [];
  const release = vi.fn();
  const cliente = {
    query: async (sql: string, valores: unknown[] = []) => {
      chamadas.push({ sql, valores });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: opcoes.livre }] };
      if (/pg_advisory_unlock/.test(sql) && opcoes.falhaAoSoltar) throw new Error("conexão caiu");
      return { rows: [] };
    },
    release,
  };
  return { pool: { connect: async () => cliente } as never, chamadas, release };
}

const SESSAO = "11111111-1111-4111-8111-111111111111";
const OUTRA_SESSAO = "22222222-2222-4222-8222-222222222222";

describe("comTravaDeRegistro", () => {
  it("⭐ trava livre: executa, devolve o valor e SOLTA a trava e a conexão", async () => {
    const { pool, chamadas, release } = poolDeMentira({ livre: true });
    const fn = vi.fn(async () => "feito");

    const r = await comTravaDeRegistro(pool, SESSAO, fn);

    expect(r).toEqual({ ocupado: false, valor: "feito" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(chamadas.map((c) => (/try_advisory_lock/.test(c.sql) ? "pega" : "solta"))).toEqual(["pega", "solta"]);
    expect(release).toHaveBeenCalledWith(false);
  });

  it("⭐ trava ocupada: NÃO executa, diz ocupado, não tenta soltar o que não tomou e devolve a conexão", async () => {
    const { pool, chamadas, release } = poolDeMentira({ livre: false });
    const fn = vi.fn(async () => "nunca");

    const r = await comTravaDeRegistro(pool, SESSAO, fn);

    expect(r).toEqual({ ocupado: true });
    expect(fn).not.toHaveBeenCalled();
    expect(chamadas.some((c) => /pg_advisory_unlock/.test(c.sql))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("⭐ erro dentro da função: a trava é solta mesmo assim e o erro sobe", async () => {
    const { pool, chamadas, release } = poolDeMentira({ livre: true });

    await expect(
      comTravaDeRegistro(pool, SESSAO, async () => {
        throw new Error("a Meta caiu");
      }),
    ).rejects.toThrow("a Meta caiu");

    expect(chamadas.some((c) => /pg_advisory_unlock/.test(c.sql))).toBe(true);
    expect(release).toHaveBeenCalledWith(false);
  });

  it("não conseguiu soltar: a conexão é DESTRUÍDA (release com erro), o que derruba a trava de sessão", async () => {
    const { pool, release } = poolDeMentira({ livre: true, falhaAoSoltar: true });
    const r = await comTravaDeRegistro(pool, SESSAO, async () => 1);
    expect(r).toEqual({ ocupado: false, valor: 1 });
    expect(release).toHaveBeenCalledWith(true);
  });

  it("a chave da trava é POR SESSÃO de canal: sessões diferentes não se bloqueiam", async () => {
    const a = poolDeMentira({ livre: true });
    const b = poolDeMentira({ livre: true });
    await comTravaDeRegistro(a.pool, SESSAO, async () => 1);
    await comTravaDeRegistro(b.pool, OUTRA_SESSAO, async () => 1);

    const chaveA = a.chamadas.find((c) => /try_advisory_lock/.test(c.sql))!.valores[0];
    const chaveB = b.chamadas.find((c) => /try_advisory_lock/.test(c.sql))!.valores[0];
    expect(chaveA).toContain(SESSAO);
    expect(chaveB).toContain(OUTRA_SESSAO);
    expect(chaveA).not.toBe(chaveB);
    // E quem solta usa a MESMA chave de quem pegou.
    const solta = a.chamadas.find((c) => /pg_advisory_unlock/.test(c.sql))!.valores[0];
    expect(solta).toBe(chaveA);
  });
});
