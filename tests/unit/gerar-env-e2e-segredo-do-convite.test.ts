import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVITE_SECRET_MIN_LENGTH } from "@/lib/auth/invite-token";

const raiz = path.resolve(__dirname, "../..");

/**
 * D-126 fez o convite recusar, em produção, segredo com menos de 32 caracteres. O
 * servidor do E2E roda `next start` (NODE_ENV=production) e o `INTERNAL_SECRET` do
 * `.env.e2e` é um rótulo de 29 caracteres: criar convite respondia 500 no CI e
 * derrubava quatro specs (invite-lifecycle, organizacoes-criacao-convite-e-cache,
 * interface-por-vinculo e a que dependia do link). A regra está certa; o ambiente da
 * suíte é que precisa de um segredo de convite do tamanho exigido.
 */
describe("o .env.e2e entrega ao convite um segredo que a regra de produção aceita", () => {
  it("INVITE_TOKEN_SECRET (ou, na falta dele, o INTERNAL_SECRET) tem o tamanho mínimo", () => {
    const destino = mkdtempSync(path.join(tmpdir(), "deskcomm-env-convite-"));
    try {
      mkdirSync(path.join(destino, "scripts"));
      mkdirSync(path.join(destino, "bin"));
      const script = path.join(destino, "scripts/gerar-env-e2e.sh");
      copyFileSync(path.join(raiz, "scripts/gerar-env-e2e.sh"), script);
      writeFileSync(
        path.join(destino, "bin/supabase"),
        `#!/usr/bin/env bash
set -eu
if [ "$*" = 'status' ]; then exit 0; fi
if [ "$*" = 'status -o env' ]; then
  printf '%s\n' 'API_URL="http://127.0.0.1:54321"' 'ANON_KEY="synthetic-anon"' 'SERVICE_ROLE_KEY="synthetic-service"' 'DB_URL="postgresql://postgres:senha-sintetica@127.0.0.1:54322/postgres"'
  exit 0
fi
exit 2
`,
        { mode: 0o700 },
      );
      const chave = Buffer.alloc(32, 1).toString("base64");
      writeFileSync(
        path.join(destino, ".env.e2e"),
        ["CPF_ENCRYPTION_KEY", "WAHA_BYO_ENCRYPTION_KEY", "AI_CRED_AES_KEY"]
          .map((nome) => `${nome}=${chave}\n`)
          .join(""),
        { mode: 0o600 },
      );
      execFileSync("bash", [script], {
        cwd: destino,
        env: { ...process.env, PATH: `${destino}/bin:${process.env.PATH}` },
        stdio: "pipe",
        timeout: 10_000,
      });
      const linhas = readFileSync(path.join(destino, ".env.e2e"), "utf8").split("\n");
      const valor = (nome: string) =>
        linhas.find((l) => l.startsWith(`${nome}=`))?.slice(nome.length + 1) ?? "";
      // Mesma resolução de `lib/auth/invite-token.ts`: o primeiro não vazio.
      const segredo = valor("INVITE_TOKEN_SECRET") || valor("INTERNAL_SECRET");
      expect(segredo.length).toBeGreaterThanOrEqual(INVITE_SECRET_MIN_LENGTH);
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });
});
