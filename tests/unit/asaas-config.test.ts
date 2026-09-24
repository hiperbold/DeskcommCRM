/**
 * `lib/billing/asaas/config.ts`: fase F5, Tarefa 10, decisão 14 e 18.
 *
 * `configDoAsaas()` lê `lib/env.ts`, que congela `process.env` na importação
 * do módulo, e por isso todo caso troca a variável ANTES de importar, com
 * `vi.resetModules()`, no mesmo padrão de `tests/unit/agenda-google-config.test.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

async function importarComEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return import("@/lib/billing/asaas/config");
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("configDoAsaas: ASAAS_ENABLED desligado (o estado de toda instalação nesta fase)", () => {
  it("devolve habilitado:false e NÃO valida base/chave, mesmo incoerentes", async () => {
    const { configDoAsaas } = await importarComEnv({
      ASAAS_ENABLED: "false",
      ASAAS_BASE_URL: "https://qualquer-coisa.invalid",
      ASAAS_API_KEY: "lixo-nenhum-prefixo",
    });
    const config = configDoAsaas();
    expect(config.habilitado).toBe(false);
    expect(config.ambiente).toBe("sandbox");
  });

  it("é o padrão quando ASAAS_ENABLED não está setada", async () => {
    const { configDoAsaas } = await importarComEnv({});
    expect(configDoAsaas().habilitado).toBe(false);
  });
});

describe("configDoAsaas: ASAAS_ENABLED ligado, combinação coerente", () => {
  it("sandbox: base oficial + chave $aact_hmlg_ -> ambiente sandbox", async () => {
    const { configDoAsaas, ASAAS_BASE_URL_SANDBOX } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
      ASAAS_API_KEY: "$aact_hmlg_000MzkwODY2MDAwMDAw",
    });
    const config = configDoAsaas();
    expect(config.habilitado).toBe(true);
    expect(config.ambiente).toBe("sandbox");
    expect(config.baseUrl).toBe(ASAAS_BASE_URL_SANDBOX);
  });

  it("produção: base oficial + chave $aact_prod_ -> ambiente producao", async () => {
    const { configDoAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api.asaas.com/v3",
      ASAAS_API_KEY: "$aact_prod_000MzkwODY2MDAwMDAw",
    });
    expect(configDoAsaas().ambiente).toBe("producao");
  });

  it("chave escapada como o .env.example documenta (\\$aact_...) chega ao processo já com o $ literal", async () => {
    // O .env.example instrui escapar o `$` (`\$aact_hmlg_...`) para o SHELL
    // não tentar expandir o resto como variável. O valor que sobra em
    // `process.env` depois dessa resolução é o mesmo `$aact_hmlg_...` sem a
    // barra: é esse valor, já resolvido, que `configDoAsaas()` precisa
    // aceitar (nenhum código aqui faz unescaping: quem escapa é o shell).
    const { configDoAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
      ASAAS_API_KEY: "$aact_hmlg_valorJaResolvidoPeloShell",
    });
    expect(configDoAsaas().habilitado).toBe(true);
  });
});

describe("configDoAsaas: ASAAS_ENABLED ligado, combinação incoerente", () => {
  it("base fora das duas oficiais -> ErroConfiguracaoAsaas, sem chamada nenhuma", async () => {
    const { configDoAsaas, ErroConfiguracaoAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api-sandbox.asaas.com.evil.example/v3",
      ASAAS_API_KEY: "$aact_hmlg_x",
    });
    expect(() => configDoAsaas()).toThrow(ErroConfiguracaoAsaas);
  });

  it("chave sem prefixo reconhecido -> ErroConfiguracaoAsaas", async () => {
    const { configDoAsaas, ErroConfiguracaoAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
      ASAAS_API_KEY: "chave-sem-prefixo-nenhum",
    });
    expect(() => configDoAsaas()).toThrow(ErroConfiguracaoAsaas);
  });

  it("base de sandbox com chave de produção -> ErroConfiguracaoAsaas (ambientes cruzados)", async () => {
    const { configDoAsaas, ErroConfiguracaoAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
      ASAAS_API_KEY: "$aact_prod_x",
    });
    expect(() => configDoAsaas()).toThrow(ErroConfiguracaoAsaas);
  });

  it("base de produção com chave de sandbox -> ErroConfiguracaoAsaas (ambientes cruzados)", async () => {
    const { configDoAsaas, ErroConfiguracaoAsaas } = await importarComEnv({
      ASAAS_ENABLED: "true",
      ASAAS_BASE_URL: "https://api.asaas.com/v3",
      ASAAS_API_KEY: "$aact_hmlg_x",
    });
    expect(() => configDoAsaas()).toThrow(ErroConfiguracaoAsaas);
  });
});

// ─── compraLigada: a SEGUNDA chave da decisão 18 ───────────────────────────

interface DbFalso {
  db: unknown;
  chamadas: number;
}

function dbFalso(resultado: { data: unknown; error: unknown }): DbFalso {
  let chamadas = 0;
  const db = {
    from(tabela: string) {
      expect(tabela).toBe("billing_settings");
      return {
        select(colunas: string) {
          expect(colunas).toBe("compra_pelo_cliente");
          return {
            eq(coluna: string, valor: number) {
              expect(coluna).toBe("id");
              expect(valor).toBe(1);
              return {
                async maybeSingle() {
                  chamadas += 1;
                  return resultado;
                },
              };
            },
          };
        },
      };
    },
  };
  return { db, get chamadas() { return chamadas; } };
}

describe("compraLigada", () => {
  it("nunca consulta o banco quando ASAAS_ENABLED (habilitado) é falso", async () => {
    const { compraLigada } = await importarComEnv({});
    const falso = dbFalso({ data: { compra_pelo_cliente: true }, error: null });
    const ligada = await compraLigada(falso.db as unknown as SupabaseClient, false);
    expect(ligada).toBe(false);
    expect(falso.chamadas).toBe(0);
  });

  it("ligada só quando habilitado E o banco também diz sim", async () => {
    const { compraLigada } = await importarComEnv({});
    const falso = dbFalso({ data: { compra_pelo_cliente: true }, error: null });
    expect(await compraLigada(falso.db as unknown as SupabaseClient, true)).toBe(true);
  });

  it("desligada quando o banco diz não, mesmo habilitado", async () => {
    const { compraLigada } = await importarComEnv({});
    const falso = dbFalso({ data: { compra_pelo_cliente: false }, error: null });
    expect(await compraLigada(falso.db as unknown as SupabaseClient, true)).toBe(false);
  });

  it("fail-closed: erro de leitura vira false, nunca lança", async () => {
    const { compraLigada } = await importarComEnv({});
    const falso = dbFalso({ data: null, error: { message: "conexão recusada" } });
    await expect(compraLigada(falso.db as unknown as SupabaseClient, true)).resolves.toBe(false);
  });

  it("linha ausente (billing_settings ainda não migrada) vira false, não lança", async () => {
    const { compraLigada } = await importarComEnv({});
    const falso = dbFalso({ data: null, error: null });
    expect(await compraLigada(falso.db as unknown as SupabaseClient, true)).toBe(false);
  });
});
