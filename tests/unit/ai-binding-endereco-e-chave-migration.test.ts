import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0915 (D-084, B1, fork Hiperbold): `ai_purpose_bindings.base_url` e
 * `credential_id` só são gravados pelo servidor da aplicação. Este arquivo cobre
 * a FORMA (migration e baseline dizem a mesma coisa, no lugar certo, com as
 * garantias de segurança da função, e a rota grava pelo cliente de serviço); o
 * COMPORTAMENTO em banco (authenticated admin recusado, service_role grava) é
 * provado por `tests/invariants/ai-binding-endereco-e-chave-so-pelo-servidor.test.ts`,
 * que precisa de Docker (`pnpm test:db`).
 *
 * Cobre também o B3 na 0914 e na 0915: o `create trigger` vai entre
 * `set lock_timeout = '5s'` e `reset lock_timeout`.
 */

const MIGRATION_0915 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930130000_0915_ai_binding_endereco_e_chave_so_pelo_servidor.sql"),
  "utf8",
);
const MIGRATION_0914 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930120000_0914_uazapi_servidor_so_pelo_servidor.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ROTA = readFileSync(join(process.cwd(), "app/api/v1/ai/providers/route.ts"), "utf8");

const MARCADOR_0914 = "-- ---- o servidor da conexão UAZAPI só é gravado pelo servidor da aplicação (migration 0914";
const MARCADOR_0915 = "-- ---- endereço próprio e chave de um ponto de IA só são gravados pelo servidor (migration 0915";

const SET_LOCK_TIMEOUT = "set lock_timeout = '5s';";

/** Do marcador até (sem incluir) o cabeçalho do PRÓXIMO bloco. */
function extraiBloco(marcador: string): string {
  const posicaoMarcador = BASELINE.indexOf(marcador);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador + marcador.length);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0915: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0914 e antes da VARREDURA anon", () => {
    const inicio0914 = BASELINE.indexOf(MARCADOR_0914);
    const inicio0915 = BASELINE.indexOf(MARCADOR_0915);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0914).toBeGreaterThan(-1);
    expect(inicio0915).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicio0914).toBeLessThan(inicio0915);
    // A VARREDURA anon é o último bloco de propósito: função criada depois dela
    // nasceria exposta a anon em quem atualiza.
    expect(inicio0915).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco(MARCADOR_0915))).toBe(semComentariosEBrancas(MIGRATION_0915));
  });

  it("o SQL da 0914 e o do bloco dela no baseline continuam iguais depois do lock_timeout", () => {
    expect(semComentariosEBrancas(extraiBloco(MARCADOR_0914))).toBe(semComentariosEBrancas(MIGRATION_0914));
  });

  it("está registrada no MANIFEST", () => {
    expect(MANIFEST).toMatch(
      /\| `20260930130000` \| `0915_ai_binding_endereco_e_chave_so_pelo_servidor` \|/,
    );
  });

  it("nenhuma linha das migrações nem dos blocos usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [MIGRATION_0915, extraiBloco(MARCADOR_0915), MIGRATION_0914, extraiBloco(MARCADOR_0914)]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });
});

describe("0915: o que o gatilho faz", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION_0915],
    ["bloco do baseline", extraiBloco(MARCADOR_0915)],
  ] as const) {
    describe(nome, () => {
      const codigo = semComentariosEBrancas(sql);

      it("gatilho BEFORE INSERT OR UPDATE OF base_url, credential_id, por linha, em ai_purpose_bindings", () => {
        expect(codigo).toMatch(
          /create or replace trigger trg_ai_purpose_bindings_trava_endereco_e_chave\s+before insert or update of base_url, credential_id on public\.ai_purpose_bindings\s+for each row\s+execute function public\.fn_ai_purpose_bindings_trava_endereco_e_chave\(\);/,
        );
      });

      it("decide pelo critério do servidor (fn_billing_e_servidor), recusa com 42501 e mensagem fixa", () => {
        expect(codigo).toMatch(/if not public\.fn_billing_e_servidor\(\) then/);
        expect(codigo).toMatch(/tg_op = 'INSERT'/);
        expect(codigo).toMatch(/new\.base_url is not null or new\.credential_id is not null/);
        expect(codigo).toMatch(/new\.base_url is distinct from old\.base_url/);
        expect(codigo).toMatch(
          /new\.credential_id is distinct from old\.credential_id and new\.credential_id is not null/,
        );
        expect(codigo).toMatch(
          /new\.credential_id is null and old\.credential_id is not null and new\.base_url is not null/,
        );
        const recusas = codigo.match(
          /raise exception 'base_url e credential_id do ponto de IA só podem ser alterados pelo servidor' using errcode = '42501';/g,
        );
        expect(recusas).toHaveLength(2);
      });

      it("security definer, search_path fixo, execute só para service_role", () => {
        expect(codigo).toMatch(
          /^create or replace function public\.fn_ai_purpose_bindings_trava_endereco_e_chave\(\)\s*returns trigger\s*language plpgsql\s*security definer\s*set search_path = public, pg_temp/,
        );
        expect(codigo).toMatch(
          /revoke execute on function public\.fn_ai_purpose_bindings_trava_endereco_e_chave\(\) from public, anon, authenticated;/,
        );
        expect(codigo).toMatch(
          /grant execute on function public\.fn_ai_purpose_bindings_trava_endereco_e_chave\(\) to service_role;/,
        );
      });

      it("reaplicável com o app no ar: só create or replace, sem tabela, constraint, índice nem reescrita de linha", () => {
        expect(codigo).not.toMatch(/alter table/);
        expect(codigo).not.toMatch(/create table/);
        expect(codigo).not.toMatch(/create index/);
        expect(codigo).not.toMatch(/drop trigger/);
        expect(codigo).not.toMatch(/\bupdate public\./);
        expect(codigo).not.toMatch(/\bdelete from\b/);
        expect(codigo).not.toMatch(/add constraint/);
      });
    });
  }
});

describe("B3: o create trigger nasce sob lock_timeout, nas duas migrações e nos dois blocos do baseline", () => {
  const casos = [
    ["0914, migração", MIGRATION_0914, "trg_channel_sessions_trava_uazapi_base_url"],
    ["0914, baseline", extraiBloco(MARCADOR_0914), "trg_channel_sessions_trava_uazapi_base_url"],
    ["0915, migração", MIGRATION_0915, "trg_ai_purpose_bindings_trava_endereco_e_chave"],
    ["0915, baseline", extraiBloco(MARCADOR_0915), "trg_ai_purpose_bindings_trava_endereco_e_chave"],
  ] as const;

  for (const [nome, sql, gatilho] of casos) {
    it(`${nome}: set lock_timeout = '5s' imediatamente antes do create trigger, reset depois`, () => {
      const codigo = semComentariosEBrancas(sql);
      const inicio = codigo.indexOf(SET_LOCK_TIMEOUT);
      const gatilhoPos = codigo.indexOf(`create or replace trigger ${gatilho}`);
      const reset = codigo.indexOf("reset lock_timeout;");
      expect(inicio, "sem set lock_timeout").toBeGreaterThan(-1);
      expect(inicio).toBeLessThan(gatilhoPos);
      expect(gatilhoPos).toBeLessThan(reset);
      // Nenhuma outra instrução entre o set e o create trigger: o prazo vale
      // para o gatilho, e só para ele.
      expect(codigo.slice(inicio + SET_LOCK_TIMEOUT.length, gatilhoPos).trim()).toBe("");
      // `set local` não vale fora de transação, que é como o baseline é aplicado.
      expect(codigo).not.toMatch(/set local lock_timeout/);
    });
  }
});

describe("B1: o PUT grava o binding pelo cliente de serviço", () => {
  it("o upsert de ai_purpose_bindings sai de createAdminClient(), depois das checagens da rota", () => {
    const upsert = ROTA.indexOf('.from("ai_purpose_bindings")\n    .upsert(');
    expect(upsert, "upsert de ai_purpose_bindings não encontrado").toBeGreaterThan(-1);
    const antes = ROTA.slice(Math.max(0, upsert - 60), upsert);
    expect(antes).toMatch(/createAdminClient\(\)/);
    // As checagens que o gatilho protege continuam ANTES da gravação.
    for (const checagem of [
      'requireRole("admin"',
      "motivoDaRecusaDeDestino(corpo.base_url",
      "base_url_exige_chave_da_empresa",
      "credencial_invalida",
    ]) {
      const pos = ROTA.indexOf(checagem);
      expect(pos, `${checagem} sumiu`).toBeGreaterThan(-1);
      expect(pos).toBeLessThan(upsert);
    }
  });
});
