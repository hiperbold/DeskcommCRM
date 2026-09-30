/**
 * CERCA: A SERVER ACTION QUE ESCREVE CONFIGURAÇÃO SENSÍVEL USA O PORTÃO COMUM (D-093 e D-137).
 *
 * ## Por que uma cerca, além dos testes de comportamento
 *
 * Server action não é rota: não passa por `requireRole`, e cada uma montava o
 * próprio portão. O defeito que a auditoria de 30/09/2026 mediu nasceu dessa
 * cópia: `is_platform_admin && papel < admin` repetido em 12 actions (vale para
 * o admin `support_readonly`), e 19 actions de plataforma e de organização sem
 * `mfaEmDivida()`. O comportamento das mais perigosas é provado em
 * `portao-de-escrita.test.ts`; esta cerca impede o caso que um teste por action
 * não alcança: a action NOVA (ou a antiga reescrita) que volta a montar o
 * portão na mão.
 *
 * ## O que ela afirma
 *
 *  1. Nenhuma action de `app/actions/**` escreve o atalho inline
 *     `!user.is_platform_admin && papel < admin`: é o portão de
 *     `lib/auth/portao-de-escrita.ts`, e só dele.
 *  2. Toda função exportada de `app/actions/settings` e `app/actions/admin` que
 *     chama `requirePlatformAdmin()` (o guarda de LEITURA) ou usa
 *     `requirePlatformAdminFull()`, ou confere escopo `full` e `mfaEmDivida()` na
 *     própria função (as actions de cobrança, que já faziam), ou está na lista
 *     de leitura abaixo, com o motivo.
 *  3. As actions de organização que a auditoria listou chamam
 *     `portaoDeAdminDaOrganizacao()` (uma vez por função exportada que escreve).
 *  4. Toda action do onboarding passa por `requireOnboardingCtx()`, e ele mesmo
 *     confere papel.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/acoes-de-escrita-usam-o-portao-comum.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

function arquivosDe(dir: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(join(RAIZ, dir))) {
    const rel = join(dir, nome);
    if (statSync(join(RAIZ, rel)).isDirectory()) out.push(...arquivosDe(rel));
    else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome)) out.push(rel.split(sep).join("/"));
  }
  return out;
}

const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/** Comentários não contam: a cerca lê código, não prosa. */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Corpo de cada `export async function`, com o nome. */
function funcoesExportadas(fonte: string): Array<{ nome: string; corpo: string }> {
  const codigo = semComentarios(fonte);
  const partes = codigo.split(/^export async function /m).slice(1);
  return partes.map((p) => ({ nome: p.slice(0, p.indexOf("(")).trim(), corpo: p }));
}

const ACTIONS = arquivosDe("app/actions");
const ACTIONS_DE_CONFIGURACAO = ACTIONS.filter(
  (f) => f.startsWith("app/actions/settings/") || f.startsWith("app/actions/admin/") || f === "app/actions/registration/decide.ts",
);

/**
 * Funções que chamam o guarda de LEITURA de propósito. Toda entrada tem motivo;
 * acrescentar uma aqui é decisão de revisão, não de conveniência.
 */
const SO_LEITURA: Record<string, string> = {
  "app/actions/settings/smtp.ts#checkSmtp": "testa a conexão SMTP já salva e não grava nada; o support_readonly pode olhar",
};

describe("nenhuma action escreve o atalho de plataforma na mão", () => {
  for (const f of ACTIONS) {
    it(`${f}`, () => {
      const codigo = semComentarios(ler(f));
      expect(
        codigo,
        "`is_platform_admin && papel < admin` vale para o support_readonly: use `portaoDeAdminDaOrganizacao` (lib/auth/portao-de-escrita.ts)",
      ).not.toMatch(/!\s*\w+\.is_platform_admin\s*&&/);
      expect(codigo).not.toMatch(/&&\s*!\s*\w+\.is_platform_admin/);
    });
  }
});

describe("actions de configuração da instalação exigem escopo full e MFA em dia", () => {
  for (const f of ACTIONS_DE_CONFIGURACAO) {
    const fonte = ler(f);
    for (const fn of funcoesExportadas(fonte)) {
      if (!/\brequirePlatformAdmin\(|\brequirePlatformAdminFull\(/.test(fn.corpo)) continue;
      it(`${f}#${fn.nome}`, () => {
        if (/\brequirePlatformAdminFull\(/.test(fn.corpo)) return;
        if (SO_LEITURA[`${f}#${fn.nome}`]) return;
        // As actions de cobrança conferem inline, na própria função.
        expect(fn.corpo, `${fn.nome} usa o guarda de LEITURA sem conferir o escopo full`).toMatch(
          /scope\s*(!==|===)\s*"full"/,
        );
        expect(fn.corpo, `${fn.nome} usa o guarda de LEITURA sem conferir mfaEmDivida()`).toMatch(/mfaEmDivida\(/);
      });
    }
  }

  it("a lista de leitura não tem entrada morta", () => {
    for (const chave of Object.keys(SO_LEITURA)) {
      const [arquivo, nome] = chave.split("#") as [string, string];
      const fn = funcoesExportadas(ler(arquivo)).find((x) => x.nome === nome);
      expect(fn, `${chave} não existe mais`).toBeTruthy();
      expect(fn!.corpo).toMatch(/\brequirePlatformAdmin\(/);
    }
  });

  it("as actions de escrita da instalação que a auditoria listou usam requirePlatformAdminFull", () => {
    const esperadas = [
      "app/actions/settings/smtp.ts",
      "app/actions/settings/updateSignupMode.ts",
      "app/actions/settings/updateDestinosInternos.ts",
      "app/actions/settings/updateComportamento.ts",
      "app/actions/settings/updateMetaApp.ts",
      "app/actions/settings/updateGoogleOAuth.ts",
      "app/actions/settings/updateModuloDaInstalacao.ts",
      "app/actions/settings/updateBranding.ts",
      "app/actions/admin/salvarConfiguracaoDaInstalacao.ts",
      "app/actions/registration/decide.ts",
    ];
    for (const f of esperadas) {
      expect(semComentarios(ler(f)), f).toMatch(/\brequirePlatformAdminFull\(/);
    }
  });
});

describe("actions de organização usam o portão de admin da empresa", () => {
  const COM_PORTAO: Array<[string, number]> = [
    ["app/actions/settings/apagarDadosOperacionaisDaOrganizacao.ts", 1],
    ["app/actions/settings/updateTenant.ts", 1],
    ["app/actions/settings/updatePipelineConfig.ts", 1],
    ["app/actions/settings/updateGoogleAdsConnection.ts", 1],
    ["app/actions/settings/updateAdPlatformConnection.ts", 1],
    ["app/actions/settings/updateAdInsightsConnection.ts", 2],
    ["app/actions/settings/updateCapturaDeUtm.ts", 1],
    ["app/actions/settings/updateMarcaDaOrganizacao.ts", 1],
    ["app/actions/settings/atualizarInterfaceDaEmpresa.ts", 1],
    ["app/actions/integrations/connectNuvemshop.ts", 1],
    ["app/actions/integrations/disconnectNuvemshop.ts", 1],
  ];
  for (const [f, minimo] of COM_PORTAO) {
    it(`${f} chama portaoDeAdminDaOrganizacao (${minimo}x)`, () => {
      const chamadas = semComentarios(ler(f)).match(/\bportaoDeAdminDaOrganizacao\(/g) ?? [];
      expect(chamadas.length).toBeGreaterThanOrEqual(minimo);
    });
  }

  it("apagar dados exige o segundo fator provado (aal2), sempre", () => {
    expect(semComentarios(ler("app/actions/settings/apagarDadosOperacionaisDaOrganizacao.ts"))).toMatch(
      /portaoDeAdminDaOrganizacao\([^)]*exigirAal2:\s*true/,
    );
  });

  it("definirExigenciaDeMfa confere mfaEmDivida: desligar a exigência não se faz só com a senha", () => {
    const fn = funcoesExportadas(ler("app/actions/auth/politicaDeMfa.ts")).find((x) => x.nome === "definirExigenciaDeMfa");
    expect(fn?.corpo).toMatch(/mfaEmDivida\(/);
  });
});

describe("onboarding: toda action passa pelo portão do onboarding", () => {
  const onboarding = ACTIONS.filter((f) => f.startsWith("app/actions/onboarding/") && !f.endsWith("/_shared.ts"));
  for (const f of onboarding) {
    it(`${relative("app/actions/onboarding", f)} chama requireOnboardingCtx em toda função exportada`, () => {
      for (const fn of funcoesExportadas(ler(f))) {
        expect(fn.corpo, `${fn.nome} escreve sem requireOnboardingCtx`).toMatch(/requireOnboardingCtx\(/);
      }
    });
  }

  it("requireOnboardingCtx confere papel, MFA e onboarding em curso", () => {
    const corpo = semComentarios(ler("app/actions/onboarding/_shared.ts"));
    expect(corpo).toMatch(/ROLE_RANK\[activeOrg\.role\]\s*<\s*ROLE_RANK\.admin/);
    expect(corpo).toMatch(/mfaEmDivida\(/);
    expect(corpo).toMatch(/onboardedAt/);
  });
});
