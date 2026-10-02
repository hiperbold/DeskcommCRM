/**
 * SCRIPTS DE EMERGÊNCIA DO KIT NÃO MONTAM SQL NEM JSON COM TEXTO DO OPERADOR (D-169).
 *
 * - `reset-mfa.sh` montava `where email = '${EMAIL}'`: `x' or true or '` apagava os
 *   fatores MFA de todos. Agora o e-mail vai por variável do psql (`:'email'`).
 * - `reset-password.sh` e o bootstrap do `install.sh` montavam o JSON da senha à mão
 *   e passavam a chave e a senha na linha do `curl` (visível em `ps`). Agora o corpo
 *   vai por stdin, escapado, e os cabeçalhos por arquivo 0600.
 * - `backup.sh` deixava dump e sessão do WhatsApp em 0644.
 *
 * O escape de JSON é exercitado DE VERDADE: a função sai do `_common.sh`, roda no
 * bash, e a saída tem de voltar igual ao texto original pelo `JSON.parse`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const KIT = path.join(process.cwd(), "hostgator-setup-kit");
const ler = (f: string) => readFileSync(path.join(KIT, f), "utf8");

/** O corpo de uma função do `_common.sh`, extraído por nome. */
function funcao(nome: string): string {
  const fonte = ler("_common.sh");
  const ini = fonte.indexOf(`${nome}() {`);
  expect(ini, `${nome} sumiu do _common.sh`).toBeGreaterThan(-1);
  const fim = fonte.indexOf("\n}\n", ini);
  return fonte.slice(ini, fim + 3);
}

function jsonEscapeNoBash(texto: string): string {
  const r = spawnSync("bash", ["-c", `${funcao("json_escape")}\njson_escape "$1"`, "_", texto], {
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe("json_escape", () => {
  it.each([
    ['aspas "duplas" e barra \\ invertida'],
    ['"}, "admin": true, "x": "'],
    ["linha1\nlinha2\ttab\rretorno"],
    ["acentuação: ção, ñ, 日本"],
    ["$HOME `whoami` $(id)"],
    [""],
  ])("o corpo montado com %j volta igual pelo JSON.parse", (senha) => {
    const corpo = `{"password":"${jsonEscapeNoBash(senha)}"}`;
    expect(JSON.parse(corpo)).toEqual({ password: senha });
  });
});

describe("reset-mfa.sh", () => {
  const fonte = ler("reset-mfa.sh");
  it("passa o e-mail como variável do psql, citada pelo próprio psql", () => {
    expect(fonte).toContain("psql_run -v email=\"$EMAIL\"");
    expect(fonte).toContain(":'email'");
  });
  it("não interpola o e-mail dentro do SQL", () => {
    const ini = fonte.indexOf("<<'SQL'");
    const sql = fonte.slice(ini, fonte.indexOf("\nSQL\n", ini));
    expect(sql).not.toContain("${EMAIL}");
    expect(sql).not.toContain("$EMAIL");
    // O heredoc é citado: o shell não expande nada dentro dele.
    expect(fonte).toContain("<<'SQL'");
  });
});

describe("reset-password.sh e bootstrap do install.sh", () => {
  it.each([["reset-password.sh"], ["install.sh"]])(
    "%s: nem a chave nem a senha entram na linha do curl",
    (arquivo) => {
      const fonte = ler(arquivo);
      expect(fonte).toContain("cabecalhos_admin_em_arquivo");
      expect(fonte).toContain("json_escape");
      expect(fonte).toContain("--data-binary @-");
      expect(fonte).not.toContain('-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}"');
      expect(fonte).not.toMatch(/-d "\{\\"password\\"/);
      expect(fonte).not.toMatch(/-d "\{\\"email\\"/);
    },
  );

  it("o arquivo de cabeçalhos nasce 0600", () => {
    const f = funcao("cabecalhos_admin_em_arquivo");
    expect(f).toContain("umask 077");
    expect(f).toContain("chmod 600");
  });
});

describe("backup.sh", () => {
  it("define umask 077 antes de criar a pasta e fecha a pasta em 0700", () => {
    const fonte = ler("backup.sh");
    const umask = fonte.indexOf("umask 077");
    const mkdir = fonte.indexOf('mkdir -p "$BACKUP_DIR"');
    expect(umask).toBeGreaterThan(-1);
    expect(umask).toBeLessThan(mkdir);
    expect(fonte).toContain('chmod 700 "$BACKUP_DIR"');
  });
});
