/**
 * TODO ENVIO DE E-MAIL PASSA PELO ROTEADOR.
 *
 * `lib/email/roteador.ts` decide, por configuração, se o envio sai pelo SMTP ou
 * pela Resend. Quem importa `@/lib/email/resend` direto pula essa decisão: numa
 * instalação que só tem SMTP o e-mail nunca sai (o aviso de conexão caída ficou
 * assim até esta cerca existir). O único arquivo de produção autorizado a falar
 * com a Resend é o próprio roteador.
 *
 * A varredura é sobre o código que embarca (`lib`, `app`, `workers`, `components`,
 * `hooks`), sem os arquivos de teste, e cobre import estático, `import()` dinâmico,
 * `export ... from` e o caminho relativo `./resend` dentro de `lib/email/`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const PASTAS = ["lib", "app", "workers", "components", "hooks"];
const PERMITIDOS = new Set(["lib/email/roteador.ts"]);

function arquivos(dir: string, acc: string[] = []): string[] {
  let nomes: string[];
  try {
    nomes = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const nome of nomes) {
    if (nome === "node_modules" || nome === ".next") continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, acc);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.(test|spec)\.(ts|tsx)$/.test(nome)) acc.push(caminho);
  }
  return acc;
}

/** `from "…/resend"` ou `import("…/resend")` apontando para o módulo da Resend. */
const IMPORTA_RESEND = /(?:from\s*|import\s*\(\s*|import\s+)["'](?:@\/lib\/email\/resend|(?:\.\.?\/)+(?:lib\/)?(?:email\/)?resend)["']/;

describe("cerca: só o roteador fala com a Resend", () => {
  const todos = PASTAS.flatMap((p) => arquivos(join(RAIZ, p)));

  it("a varredura enxerga o código de produção", () => {
    expect(todos.length).toBeGreaterThan(100);
  });

  it("nenhum arquivo de produção importa o módulo da Resend, exceto o roteador", () => {
    const infratores = todos
      .map((f) => relative(RAIZ, f).split(sep).join("/"))
      .filter((rel) => !PERMITIDOS.has(rel))
      .filter((rel) => IMPORTA_RESEND.test(readFileSync(join(RAIZ, rel), "utf8")));
    expect(
      infratores,
      "Importe `sendEmail` de `@/lib/email/roteador`: importar a Resend direto ignora o SMTP configurado.",
    ).toEqual([]);
  });

  it("o detector reconhece as formas de import que ele promete pegar", () => {
    expect(IMPORTA_RESEND.test('import { sendEmail } from "@/lib/email/resend";')).toBe(true);
    expect(IMPORTA_RESEND.test('const m = await import("@/lib/email/resend");')).toBe(true);
    expect(IMPORTA_RESEND.test('import { sendEmail } from "./resend";')).toBe(true);
    expect(IMPORTA_RESEND.test('import { sendEmail } from "@/lib/email/roteador";')).toBe(false);
  });

  it("o roteador é, de fato, quem importa a Resend (a exceção não está obsoleta)", () => {
    expect(IMPORTA_RESEND.test(readFileSync(join(RAIZ, "lib/email/roteador.ts"), "utf8"))).toBe(true);
  });
});
