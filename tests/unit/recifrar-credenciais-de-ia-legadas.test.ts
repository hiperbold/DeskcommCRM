import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-168, parte 2: o recifrador leva as credenciais de IA do formato antigo (iv de 12 bytes, sem dado
 * adicional) para o novo (aad com a organização e a linha, versão da chave no envelope), e o interruptor
 * `AI_CRED_RECUSAR_LEGADO` recusa o formato antigo DEPOIS que o recifrador zerou o que sobrava.
 * Cripto real: o único dublê é o banco (um repositório em memória que imita a regra do "só troca se o iv
 * ainda for o que li").
 */

vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: Buffer.alloc(32, 7).toString("base64") } }));

const { recifrarCredenciaisLegadas, repositorioDeRecifraSobre } = await import("@/lib/ai/credenciais/recifrar");
const { decifrarColunasDaCredencial } = await import("@/lib/ai/credenciais/cifra");
const { bufToBytea, byteaToBuffer } = await import("@/lib/crypto/aes_gcm");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Linha {
  id: string;
  organization_id: string;
  api_key_encrypted: string;
  api_key_iv: string;
  api_key_tag: string;
}

/** Como o código ANTIGO cifrava: iv de 12 bytes, sem dado adicional, chave de versão 1. */
function legada(id: string, org: string, segredo: string): Linha {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), iv);
  const ciphertext = Buffer.concat([cipher.update(segredo, "utf8"), cipher.final()]);
  return {
    id,
    organization_id: org,
    api_key_encrypted: bufToBytea(ciphertext),
    api_key_iv: bufToBytea(iv),
    api_key_tag: bufToBytea(cipher.getAuthTag()),
  };
}

/** Banco em memória: `trocar` só grava se o iv gravado ainda for o que o recifrador leu. */
function bancoEmMemoria(linhas: Linha[]) {
  const antesDeGravar: Array<(id: string) => void> = [];
  const repo = {
    async listar(depoisDe: string | null, tamanho: number) {
      return linhas
        .filter((l) => depoisDe === null || l.id > depoisDe)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, tamanho)
        .map((l) => ({ ...l }));
    },
    async trocar(
      id: string,
      org: string,
      ivAntigo: unknown,
      novas: { api_key_encrypted: string; api_key_iv: string; api_key_tag: string },
    ) {
      for (const g of antesDeGravar) g(id);
      const alvo = linhas.find((l) => l.id === id && l.organization_id === org);
      if (!alvo || byteaToBuffer(alvo.api_key_iv).compare(byteaToBuffer(ivAntigo)) !== 0) return false;
      Object.assign(alvo, novas);
      return true;
    },
  };
  return { repo, antesDeGravar };
}

const tamanhoDoIv = (l: Linha) => byteaToBuffer(l.api_key_iv).length;

beforeEach(() => {
  delete process.env.AI_CRED_RECUSAR_LEGADO;
  delete process.env.AI_CRED_AES_KEY_VERSAO_ATUAL;
});
afterEach(() => {
  delete process.env.AI_CRED_RECUSAR_LEGADO;
});

describe("recifrador: o formato antigo vira o novo, com o mesmo segredo", () => {
  it("⭐ recifra a linha legada: iv de 13 bytes, e a chave decifra IGUAL com o aad da linha", async () => {
    const linhas = [legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-da-a-1234")];
    const { repo } = bancoEmMemoria(linhas);
    const r = await recifrarCredenciaisLegadas({ repo });

    expect(r).toMatchObject({ varridas: 1, recifradas: 1, falhas: 0, restantes: 0, jaNoFormatoNovo: 0 });
    expect(tamanhoDoIv(linhas[0]!)).toBe(13);
    expect(decifrarColunasDaCredencial(linhas[0]!, ORG_A)).toBe("sk-chave-da-a-1234");
  });

  it("⭐ a cifra nova fica presa à organização e à linha: copiada para outra organização, não abre", async () => {
    const linhas = [legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-da-a-1234")];
    await recifrarCredenciaisLegadas({ repo: bancoEmMemoria(linhas).repo });
    expect(() => decifrarColunasDaCredencial(linhas[0]!, ORG_B)).toThrow();
    expect(() => decifrarColunasDaCredencial({ ...linhas[0]!, id: "00000000-0000-4000-8000-0000000000ff" }, ORG_A)).toThrow();
  });

  it("⭐ idempotente: a segunda rodada não toca em nada (linha nova fica como está)", async () => {
    const linhas = [
      legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-1111"),
      legada("00000000-0000-4000-8000-000000000002", ORG_B, "sk-chave-2222"),
    ];
    const { repo } = bancoEmMemoria(linhas);
    await recifrarCredenciaisLegadas({ repo });
    const depoisDaPrimeira = JSON.stringify(linhas);

    const r = await recifrarCredenciaisLegadas({ repo });
    expect(r).toMatchObject({ varridas: 2, recifradas: 0, jaNoFormatoNovo: 2, restantes: 0, falhas: 0 });
    expect(JSON.stringify(linhas)).toBe(depoisDaPrimeira);
  });

  it("lote pequeno: recifra só até o limite e diz quantas faltam", async () => {
    const linhas = [1, 2, 3, 4, 5].map((n) =>
      legada(`00000000-0000-4000-8000-00000000000${n}`, ORG_A, `sk-chave-numero-${n}`),
    );
    const { repo } = bancoEmMemoria(linhas);
    const r = await recifrarCredenciaisLegadas({ repo, lote: 2 });

    expect(r).toMatchObject({ varridas: 5, recifradas: 2, restantes: 3 });
    expect(linhas.filter((l) => tamanhoDoIv(l) === 13)).toHaveLength(2);

    const r2 = await recifrarCredenciaisLegadas({ repo, lote: 10 });
    expect(r2).toMatchObject({ recifradas: 3, restantes: 0, jaNoFormatoNovo: 2 });
    expect(linhas.every((l) => tamanhoDoIv(l) === 13)).toBe(true);
  });

  it("varre em páginas: com página menor que o total, nenhuma linha fica de fora", async () => {
    const linhas = [1, 2, 3, 4, 5].map((n) => legada(`00000000-0000-4000-8000-00000000000${n}`, ORG_A, `sk-chave-${n}-xx`));
    const r = await recifrarCredenciaisLegadas({ repo: bancoEmMemoria(linhas).repo, pagina: 2 });
    expect(r).toMatchObject({ varridas: 5, recifradas: 5, restantes: 0 });
  });

  it("⭐ a chave trocada no meio da rodada (rotação) NÃO é sobrescrita com a cifra velha", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const linhas = [legada(id, ORG_A, "sk-chave-antiga-1111")];
    const { repo, antesDeGravar } = bancoEmMemoria(linhas);
    const nova = legada(id, ORG_A, "sk-chave-ROTACIONADA-9999");
    // Entre a leitura e a gravação do recifrador, alguém rotaciona a chave (outro iv).
    antesDeGravar.push(() => Object.assign(linhas[0]!, nova));

    const r = await recifrarCredenciaisLegadas({ repo });
    expect(r).toMatchObject({ recifradas: 0, mudaramNoMeio: 1, falhas: 0 });
    expect(decifrarColunasDaCredencial(linhas[0]!, ORG_A)).toBe("sk-chave-ROTACIONADA-9999");
  });

  it("linha que não abre (cifrada com outra chave) conta como falha, fica intocada e não derruba a rodada", async () => {
    const ruim = legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-que-nao-abre");
    ruim.api_key_tag = bufToBytea(randomBytes(16));
    const boa = legada("00000000-0000-4000-8000-000000000002", ORG_A, "sk-chave-boa-3333");
    const ruimAntes = JSON.stringify(ruim);
    const linhas = [ruim, boa];

    const r = await recifrarCredenciaisLegadas({ repo: bancoEmMemoria(linhas).repo });
    expect(r).toMatchObject({ recifradas: 1, falhas: 1 });
    expect(JSON.stringify(linhas[0])).toBe(ruimAntes);
    expect(decifrarColunasDaCredencial(linhas[1]!, ORG_A)).toBe("sk-chave-boa-3333");
  });

  it("o resumo nunca carrega segredo nem cifra", async () => {
    const linhas = [legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-segredo-que-nao-vaza")];
    const r = await recifrarCredenciaisLegadas({ repo: bancoEmMemoria(linhas).repo });
    const texto = JSON.stringify(r);
    expect(texto).not.toContain("sk-segredo");
    expect(texto).not.toContain(linhas[0]!.api_key_encrypted);
  });

  it("funciona com o interruptor LIGADO: o recifrador lê o formato antigo de propósito", async () => {
    process.env.AI_CRED_RECUSAR_LEGADO = "1";
    const linhas = [legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-1111-aa")];
    const r = await recifrarCredenciaisLegadas({ repo: bancoEmMemoria(linhas).repo });
    expect(r.recifradas).toBe(1);
  });
});

describe("interruptor AI_CRED_RECUSAR_LEGADO: recusa o iv de 12 bytes só quando ligado", () => {
  it("⭐ desligado (padrão): a linha legada segue sendo lida", () => {
    const l = legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-legada-1");
    expect(decifrarColunasDaCredencial(l, ORG_A)).toBe("sk-chave-legada-1");
  });

  it.each(["1", "true", "TRUE", "sim"])("⭐ ligado com %s: a linha legada é recusada", (valor) => {
    process.env.AI_CRED_RECUSAR_LEGADO = valor;
    const l = legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-legada-2");
    expect(() => decifrarColunasDaCredencial(l, ORG_A)).toThrow(/formato antigo/);
  });

  it.each(["0", "false", "", "talvez"])("valor %s não liga o interruptor", (valor) => {
    process.env.AI_CRED_RECUSAR_LEGADO = valor;
    const l = legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-legada-3");
    expect(decifrarColunasDaCredencial(l, ORG_A)).toBe("sk-chave-legada-3");
  });

  it("ligado, a linha NOVA (recifrada) continua abrindo", async () => {
    const linhas = [legada("00000000-0000-4000-8000-000000000001", ORG_A, "sk-chave-nova-4444")];
    await recifrarCredenciaisLegadas({ repo: bancoEmMemoria(linhas).repo });
    process.env.AI_CRED_RECUSAR_LEGADO = "1";
    expect(decifrarColunasDaCredencial(linhas[0]!, ORG_A)).toBe("sk-chave-nova-4444");
  });
});

describe("repositório sobre o cliente do Supabase: a troca é condicionada ao iv lido", () => {
  function clienteQueGrava(resposta: { data: unknown; error: unknown }) {
    const chamadas: Array<[string, ...unknown[]]> = [];
    const cadeia: Record<string, unknown> = {};
    for (const nome of ["select", "update", "eq", "gt", "order", "limit"]) {
      cadeia[nome] = (...args: unknown[]) => {
        chamadas.push([nome, ...args]);
        return cadeia;
      };
    }
    cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok);
    return { admin: { from: () => cadeia } as never, chamadas };
  }

  it("⭐ o update filtra por id, organização E pelo iv antigo, e devolve true só se alguma linha mudou", async () => {
    const iv = randomBytes(12);
    const { admin, chamadas } = clienteQueGrava({ data: [{ id: "x" }], error: null });
    const ok = await repositorioDeRecifraSobre(admin).trocar("id-1", ORG_A, bufToBytea(iv), {
      api_key_encrypted: "\\x01",
      api_key_iv: "\\x02",
      api_key_tag: "\\x03",
    });
    expect(ok).toBe(true);
    expect(chamadas).toContainEqual(["eq", "id", "id-1"]);
    expect(chamadas).toContainEqual(["eq", "organization_id", ORG_A]);
    expect(chamadas).toContainEqual(["eq", "api_key_iv", bufToBytea(iv)]);

    const vazio = clienteQueGrava({ data: [], error: null });
    expect(
      await repositorioDeRecifraSobre(vazio.admin).trocar("id-1", ORG_A, bufToBytea(iv), {
        api_key_encrypted: "\\x01",
        api_key_iv: "\\x02",
        api_key_tag: "\\x03",
      }),
    ).toBe(false);
  });

  it("erro do banco na troca lança (a rodada o conta como falha, sem texto do banco no resumo)", async () => {
    const { admin } = clienteQueGrava({ data: null, error: { message: "boom do postgres" } });
    await expect(
      repositorioDeRecifraSobre(admin).trocar("id-1", ORG_A, bufToBytea(randomBytes(12)), {
        api_key_encrypted: "\\x01",
        api_key_iv: "\\x02",
        api_key_tag: "\\x03",
      }),
    ).rejects.toThrow();
  });
});
