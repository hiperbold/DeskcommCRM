/**
 * O BACKUP DE PRODUÇÃO NÃO GUARDA A CHAVE DE CIFRA JUNTO DO DADO CIFRADO NEM
 * VAZA A SENHA DO BANCO NA LINHA DE COMANDO (D-123).
 *
 * O script fala com o banco real e não roda em teste; aqui se prende o que ele
 * escreve: sintaxe válida, dumps separados, URL por ambiente, arquivos privados e
 * cifragem por chave pública quando configurada.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CAMINHO = path.join(process.cwd(), "hiperbold/scripts/backup-prod.sh");
const fonte = readFileSync(CAMINHO, "utf8");

describe("hiperbold/scripts/backup-prod.sh", () => {
  it("é um bash válido", () => {
    const r = spawnSync("bash", ["-n", CAMINHO], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("o schema private (a chave de cifra) sai em arquivo separado de public e auth", () => {
    const dumps = fonte.match(/pg_dump[^\n]*\n?[^\n]*--schema=[a-z]+[^\n]*/g) ?? [];
    expect(dumps.length).toBe(2);
    const comPrivate = dumps.filter((d) => d.includes("--schema=private"));
    expect(comPrivate).toHaveLength(1);
    // O dump que leva `private` não leva mais nenhum outro schema.
    expect(comPrivate[0]?.match(/--schema=/g)).toHaveLength(1);
    expect(fonte).toContain("-private.dump");
  });

  it("a URL do banco vai por variável de ambiente, nunca como argumento do docker/pg_dump", () => {
    expect(fonte).toContain("-e SUPABASE_DB_URL");
    expect(fonte).toContain('pg_dump "$SUPABASE_DB_URL"');
    expect(fonte).not.toMatch(/pg_dump\s+"\$URL"/);
  });

  it("umask 077 e pasta 0700 antes do primeiro dump", () => {
    const umask = fonte.indexOf("umask 077");
    expect(umask).toBeGreaterThan(-1);
    expect(umask).toBeLessThan(fonte.indexOf("pg_dump"));
    expect(fonte).toContain('chmod 700 "$DIR"');
  });

  it("cifra com age pela chave pública e remove o arquivo em claro", () => {
    expect(fonte).toMatch(/age -r "\$RECIPIENT"/);
    expect(fonte).toContain('rm -f "$DIR/$arq"');
    // A chave privada não existe aqui: só a pública (AGE_RECIPIENT).
    expect(fonte).not.toMatch(/age\s+(-d|--decrypt)|AGE-SECRET-KEY/);
  });

  it("sem chave pública configurada avisa em voz alta, em vez de calar", () => {
    expect(fonte).toContain("AVISO: backup SEM cifra");
  });
});
