import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A lista CRONS de docker/scheduler/entrypoint.sh fica entre aspas duplas:
// crase ou `$(` ali dentro, mesmo num comentário, é EXECUTADA pelo shell no
// boot. Em 29/09/2026 um comentário com o texto do curl entre crases rodou o
// curl sem argumento e o scheduler morreu ao subir, barrando a publicação.
describe("lista de crons do scheduler", () => {
  const script = readFileSync(join(process.cwd(), "docker/scheduler/entrypoint.sh"), "utf8");
  const inicio = script.indexOf('CRONS="');
  const fim = script.indexOf('\n"\n', inicio);
  const bloco = script.slice(inicio + 'CRONS="'.length, fim);

  it("acha o bloco", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    expect(bloco).toContain("api/v1/cron/");
  });

  it("não tem crase nem substituição de comando", () => {
    const linhas = bloco
      .split("\n")
      .map((linha, i) => ({ linha, n: i + 1 }))
      .filter(({ linha }) => linha.includes("`") || linha.includes("$("));
    expect(linhas).toEqual([]);
  });
});
