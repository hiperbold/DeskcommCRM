import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0919 (D-099, D-110, D-149, fork Hiperbold). Este arquivo cobre a FORMA:
 * migration e baseline dizem a mesma coisa, no lugar certo, e a migração é
 * reaplicável com o app no ar. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/midia-e-storage-isolamento.test.ts` (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20260930170000_0919_midia_e_storage_isolamento_entre_membros.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0918 = "-- ---- sessão sem o segundo fator não grava em api_tokens nem em user_organizations (migration 0918";
const MARCADOR_0919 = "-- ---- mídia e Storage: o que um membro grava não alcança o arquivo de outra empresa (migration 0919";

function extraiBloco(marcador: string): string {
  const inicio = BASELINE.lastIndexOf(marcador);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + marcador.length);
  return BASELINE.slice(inicio, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0919: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0918 e antes da VARREDURA anon, uma vez só", () => {
    const inicio0918 = BASELINE.lastIndexOf(MARCADOR_0918);
    const inicio0919 = BASELINE.lastIndexOf(MARCADOR_0919);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0918).toBeGreaterThan(-1);
    expect(inicio0919).toBeGreaterThan(inicio0918);
    expect(inicio0919).toBeLessThan(varreduraAnon);
    expect(BASELINE.split(MARCADOR_0919).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco(MARCADOR_0919))).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("está registrada no MANIFEST, depois da 0918", () => {
    expect(MANIFEST).toMatch(/\| `20260930170000` \| `0919_midia_e_storage_isolamento_entre_membros` \|/);
    expect(MANIFEST.indexOf("`0918_sessao_aal1")).toBeLessThan(MANIFEST.indexOf("`0919_midia_e_storage"));
  });

  it("nenhuma linha da migração nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [MIGRATION, extraiBloco(MARCADOR_0919)]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });
});

describe("0919: reaplicável com o app no ar e fechando o que diz", () => {
  for (const [nome, sql] of [
    ["migração", MIGRATION],
    ["bloco do baseline", extraiBloco(MARCADOR_0919)],
  ] as const) {
    describe(nome, () => {
      const codigo = semComentariosEBrancas(sql);

      it("só create or replace, drop policy if exists, revoke e lock_timeout curto; não apaga nem reescreve linha", () => {
        expect(codigo).toMatch(/set_config\('lock_timeout','3s',true\)/);
        expect(codigo).not.toMatch(/drop table|drop function|alter table|delete from|update public\./);
        expect(codigo).not.toMatch(/drop policy (?!if exists)/);
        expect(codigo).not.toMatch(/drop trigger/);
      });

      it("D-099: o authenticated perde a escrita da fila de apagamento", () => {
        expect(codigo).toMatch(
          /revoke insert, update, delete, truncate, references, trigger on public\.storage_redaction_queue from authenticated, anon;/,
        );
      });

      it("D-110: sem policy de escrita em ai-policy e leitura de lgpd-exports só do admin", () => {
        expect(codigo).toMatch(/drop policy if exists "tenant_write_ai_policy" on storage\.objects;/);
        expect(codigo).toMatch(/drop policy if exists "tenant_delete_ai_policy" on storage\.objects;/);
        expect(codigo).toMatch(
          /bucket_id = 'lgpd-exports'\s+and public\.fn_role_at_least\(\(split_part\(name, '\/', 1\)\)::uuid, 'admin'\)/,
        );
        expect(codigo).not.toMatch(/create policy "tenant_(write|delete)_ai_policy"/);
      });

      it("D-149: gatilhos de insert e de troca do valor, só quando a coluna vem preenchida", () => {
        expect(codigo).toMatch(/create or replace trigger trg_messages_media_path_insert\s+before insert on public\.messages/);
        expect(codigo).toMatch(/before update of media_storage_path on public\.messages/);
        expect(codigo).toMatch(/when \(new\.media_storage_path is not null\)/);
        expect(codigo).toMatch(/new\.media_storage_path is distinct from old\.media_storage_path/);
        // normalização: prefixo exato e recusa de .., //, barra invertida, % e controle
        expect(codigo).toMatch(/v_prefixo text := new\.organization_id::text \|\| '\/' \|\| new\.conversation_id::text \|\| '\/'/);
        expect(codigo).toContain("strpos(new.media_storage_path, chr(92)) = 0");
        expect(codigo).toContain("strpos(new.media_storage_path, '%') = 0");
        expect(codigo).toContain("!~ '[[:cntrl:]]'");
        expect(codigo).toContain("!~ '//'");
      });

      it("a função do gatilho não fica executável por quem consulta", () => {
        expect(codigo).toMatch(
          /revoke all on function public\.fn_messages_media_path_da_conversa\(\) from public, anon, authenticated;/,
        );
      });
    });
  }

  it("fn_role_at_least existe no baseline ANTES do bloco que a usa", () => {
    const definicao = BASELINE.indexOf('CREATE OR REPLACE FUNCTION "public"."fn_role_at_least"');
    expect(definicao).toBeGreaterThan(-1);
    expect(definicao).toBeLessThan(BASELINE.lastIndexOf(MARCADOR_0919));
  });

  it("os blocos originais do baseline (0014 e 0017) não recriam mais as policies frouxas", () => {
    const antesDasMigracoesDoFork = BASELINE.slice(0, BASELINE.lastIndexOf(MARCADOR_0919));
    expect(antesDasMigracoesDoFork).not.toMatch(/create policy "tenant_write_ai_policy"/);
    expect(antesDasMigracoesDoFork).not.toMatch(/create policy "tenant_delete_ai_policy"/);
    expect(antesDasMigracoesDoFork).not.toMatch(/create policy "tenant_read_lgpd_exports"/);
  });
});
