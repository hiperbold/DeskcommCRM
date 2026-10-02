/**
 * O DEPLOY EM PRODUÇÃO SÓ SAI DEPOIS DE ci E e2e VERDES NO MESMO COMMIT (D-121).
 *
 * O `publish-image.yml` roda em paralelo com o `ci` e o `e2e`, e o
 * `deploy-easypanel.yml` reagia só à conclusão do publish: commit na main com
 * teste vermelho montava a imagem, o publish ficava verde e o EasyPanel publicava
 * app, worker e scheduler. Agora o deploy passa por `scripts/commit-passou-nos-testes.sh`,
 * que consulta a API do GitHub.
 *
 * O script roda DE VERDADE aqui, com um `gh` dublê no PATH que serve as respostas
 * da API a partir de arquivos JSON e aplica o filtro `--jq` com o `jq` real: o que
 * está sob teste é o filtro e a decisão, não uma string do script. Sem `jq` no
 * ambiente os casos de comportamento são pulados em voz alta (o CI do GitHub e o
 * kit já exigem `jq`).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const SCRIPT = path.join(RAIZ, "scripts/commit-passou-nos-testes.sh");
const SHA = "a".repeat(40);

const temJq = spawnSync("jq", ["--version"]).status === 0;
const itComJq = temJq ? it : it.skip;

let pasta = "";

beforeAll(() => {
  pasta = mkdtempSync(path.join(tmpdir(), "deploy-gate-"));
  mkdirSync(path.join(pasta, "bin"));
  // O `gh` dublê procura o nome do workflow no caminho da API e devolve o arquivo
  // `<workflow>.json` já filtrado pela expressão que o script passou em --jq.
  const gh = `#!/usr/bin/env bash
caminho=""; filtro=""
while [ $# -gt 0 ]; do
  case "$1" in
    api) caminho="$2"; shift ;;
    --jq) filtro="$2"; shift ;;
  esac
  shift
done
wf="$(printf '%s' "$caminho" | sed -n 's#.*workflows/\\([a-z0-9.]*\\)/runs.*#\\1#p')"
arquivo="$GH_FIXTURES/$wf.json"
if [ ! -f "$arquivo" ]; then exit 1; fi
jq -r "$filtro" "$arquivo"
`;
  const destino = path.join(pasta, "bin", "gh");
  writeFileSync(destino, gh);
  chmodSync(destino, 0o755);
});

afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

interface Execucao {
  run_number: number;
  status: string;
  conclusion: string | null;
  head_branch?: string;
  event?: string;
}

function run(n: number, status: string, conclusion: string | null, extra: Partial<Execucao> = {}): Execucao {
  return { run_number: n, status, conclusion, head_branch: "main", event: "push", ...extra };
}

/** Roda o script com as execuções dadas por workflow; devolve saída e código. */
function rodar(
  porWorkflow: Record<string, Execucao[] | "erro-da-api">,
  opcoes: { sha?: string } = {},
) {
  const fixtures = mkdtempSync(path.join(pasta, "fx-"));
  for (const [wf, runs] of Object.entries(porWorkflow)) {
    if (runs === "erro-da-api") continue; // sem arquivo: o gh dublê sai 1
    writeFileSync(path.join(fixtures, `${wf}.json`), JSON.stringify({ workflow_runs: runs }));
  }
  const r = spawnSync("bash", [SCRIPT, opcoes.sha ?? SHA], {
    env: {
      ...process.env,
      PATH: `${path.join(pasta, "bin")}:${process.env.PATH}`,
      GH_FIXTURES: fixtures,
      GITHUB_REPOSITORY: "hiperbold/DeskcommCRM",
      // Teto curto: o que não termina vira reprovação em 1 segundo, não em 55 min.
      TETO_SEGUNDOS: "1",
      INTERVALO_SEGUNDOS: "1",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

describe("commit-passou-nos-testes.sh", () => {
  itComJq("ci e e2e concluídos em sucesso: libera", () => {
    const r = rodar({
      "ci.yml": [run(1, "completed", "success")],
      "e2e.yml": [run(1, "completed", "success")],
    });
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain("ci e e2e verdes");
  });

  itComJq("e2e vermelho: reprova na hora, mesmo com o ci verde", () => {
    const r = rodar({
      "ci.yml": [run(1, "completed", "success")],
      "e2e.yml": [run(1, "completed", "failure")],
    });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("e2e.yml terminou em 'failure'");
  });

  itComJq("ci vermelho: reprova", () => {
    const r = rodar({
      "ci.yml": [run(1, "completed", "failure")],
      "e2e.yml": [run(1, "completed", "success")],
    });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("ci.yml terminou em 'failure'");
  });

  itComJq.each([["cancelled"], ["skipped"], ["timed_out"], ["action_required"]])(
    "conclusão %s não é sucesso: reprova",
    (conclusao) => {
      const r = rodar({
        "ci.yml": [run(1, "completed", conclusao)],
        "e2e.yml": [run(1, "completed", "success")],
      });
      expect(r.codigo).toBe(1);
    },
  );

  itComJq("execução ainda em andamento: espera e, estourado o teto, reprova", () => {
    const r = rodar({
      "ci.yml": [run(1, "completed", "success")],
      "e2e.yml": [run(1, "in_progress", null)],
    });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("não terminou em sucesso dentro do teto");
  });

  itComJq("nenhuma execução do workflow para o commit: reprova, não libera", () => {
    const r = rodar({
      "ci.yml": [run(1, "completed", "success")],
      "e2e.yml": [],
    });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain("sem execucao");
  });

  itComJq("falha ao consultar a API conta como 'não sei', nunca como sucesso", () => {
    const r = rodar({
      "ci.yml": "erro-da-api",
      "e2e.yml": [run(1, "completed", "success")],
    });
    expect(r.codigo).toBe(1);
  });

  itComJq("rerun verde substitui o vermelho anterior do mesmo commit", () => {
    const r = rodar({
      "ci.yml": [run(2, "completed", "success"), run(1, "completed", "failure")],
      "e2e.yml": [run(1, "completed", "success")],
    });
    expect(r.codigo, r.saida).toBe(0);
  });

  itComJq("o vermelho mais novo vence o verde antigo", () => {
    const r = rodar({
      "ci.yml": [run(1, "completed", "success"), run(2, "completed", "failure")],
      "e2e.yml": [run(1, "completed", "success")],
    });
    expect(r.codigo).toBe(1);
  });

  itComJq("só vale execução de push na main: PR e outra branch não liberam", () => {
    const r = rodar({
      "ci.yml": [
        run(3, "completed", "success", { event: "pull_request" }),
        run(2, "completed", "success", { head_branch: "outra" }),
      ],
      "e2e.yml": [run(1, "completed", "success")],
    });
    expect(r.codigo).toBe(1);
  });

  it("recusa sha malformado e falta de repositório, sem consultar nada", () => {
    expect(rodar({}, { sha: "main; rm -rf /" }).codigo).toBe(2);
    const r = spawnSync("bash", [SCRIPT, SHA], {
      env: { ...process.env, GITHUB_REPOSITORY: "" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});

describe("deploy-easypanel.yml passa pelo portão antes de tocar no EasyPanel", () => {
  const yml = readFileSync(path.join(RAIZ, ".github/workflows/deploy-easypanel.yml"), "utf8");

  it("o passo do portão vem antes do passo que fala com o EasyPanel", () => {
    const portao = yml.indexOf("scripts/commit-passou-nos-testes.sh");
    const deploy = yml.indexOf("services.app.deployService");
    expect(portao, "o deploy deixou de chamar o portão").toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(-1);
    expect(portao).toBeLessThan(deploy);
  });

  it("o portão consulta o commit que o publish construiu, e o deploy manual só vale na main", () => {
    expect(yml).toContain("github.event.workflow_run.head_sha");
    expect(yml).toContain("refs/heads/main");
  });

  it("o job pode ler as execuções (actions: read) e não ganha escrita", () => {
    expect(yml).toMatch(/permissions:\s*\n\s+actions: read/);
    expect(yml).not.toMatch(/:\s*write\b/);
  });

  it("o teto do job cobre o teto do portão", () => {
    const teto = Number(/TETO_SEGUNDOS:-(\d+)/.exec(readFileSync(SCRIPT, "utf8"))?.[1]);
    const minutos = Number(/timeout-minutes:\s*(\d+)/.exec(yml)?.[1]);
    expect(minutos * 60).toBeGreaterThan(teto);
  });
});
