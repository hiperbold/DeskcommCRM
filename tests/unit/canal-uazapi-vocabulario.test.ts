import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * O vocabulário do QUINTO canal — o que entra ANTES do transporte.
 *
 * Mesmo lugar do irmão intermediado (`canal-zernio-vocabulario.test.ts`) e pelo
 * mesmo motivo: tipo, matriz de capabilities, coluna de ref e CHECKs do banco
 * nascem juntos. Quem inverte a ordem paga com uma migration de correção sobre
 * dados que já existem — e é aí que o clone de um self-hoster quebra.
 *
 * O TRANSPORTE (formato do corpo, headers, respostas da API) está em
 * `channel-adapter-uazapi.test.ts`; a leitura dos eventos, nos três arquivos de
 * webhook. Aqui é só o vocabulário e o encanamento até o adapter.
 */
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_UAZAPI,
  capabilitiesOf,
} from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";

const UAZAPI = CHANNEL_PROVIDER_UAZAPI;

describe("capabilities da instância em servidor próprio", () => {
  it("descreve o PERMITIDO — e ele é o do canal por QR, não o do oficial", () => {
    expect(capabilitiesOf(UAZAPI)).toEqual({
      freeformOutsideWindow: true,
      requiresTemplates: false,
      canManageTemplates: false,
      banRisk: true,
      minIntervalMs: null,
      voiceNote: "server-convert",
      groups: "full",
      costPerMessage: false,
    });
  });

  it("banRisk=true é o bit que arma o anti-ban — declarar false aqui derruba o número do cliente", () => {
    // É o mesmo perfil de risco do canal por QR: quem parear um número neste
    // transporte está usando o WhatsApp comum, e a plataforma bane por volume.
    // O canal oficial e o intermediado NÃO têm esse risco, e é justamente por
    // isso que copiar a linha deles seria o defeito caro.
    expect(capabilitiesOf(UAZAPI).banRisk).toBe(true);
    expect(CHANNEL_CAPABILITIES.waha.banRisk).toBe(true);
    expect(CHANNEL_CAPABILITIES.meta_cloud.banRisk).toBe(false);
    expect(CHANNEL_CAPABILITIES.zernio.banRisk).toBe(false);
  });

  it("não exige modelo e não os gerencia — pedir template aqui trava o envio sem motivo", () => {
    expect(capabilitiesOf(UAZAPI).requiresTemplates).toBe(false);
    expect(capabilitiesOf(UAZAPI).canManageTemplates).toBe(false);
    expect(capabilitiesOf(UAZAPI).freeformOutsideWindow).toBe(true);
  });

  it("voiceNote é server-convert: MEDIDO, o servidor entrega opus a partir do que a gente manda", () => {
    // Provado no teste ao vivo: o navegador gravou `audio/webm;codecs=opus`, o
    // envio foi por `ptt`, e a mensagem chegou do outro lado como
    // `audio/ogg; codecs=opus` — bolha de voz, não anexo de música.
    // Declarar `opus-only` obrigaria uma conversão nossa que o servidor já faz.
    expect(capabilitiesOf(UAZAPI).voiceNote).toBe("server-convert");
  });
});

describe("identificador da sessão", () => {
  it("resolve pela instância, não pelo telefone nem pelo servidor", () => {
    expect(
      resolveSessionRef({ provider: UAZAPI as "uazapi", uazapi_instance_id: "rc08ad65e0e52c8" }),
    ).toBe("rc08ad65e0e52c8");
  });

  it("a coluna entra no select — sem ela o ref volta indefinido em runtime", () => {
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("uazapi_instance_id");
  });

  it("cada canal resolve pela SUA coluna — nenhum cai na do outro", () => {
    expect(resolveSessionRef({ provider: "waha", waha_session_name: "s1" })).toBe("s1");
    expect(resolveSessionRef({ provider: "zernio", zernio_account_id: "acc_1" })).toBe("acc_1");
  });
});

describe("o canal tem transporte", () => {
  it("getAdapter devolve o adapter deste canal, não o de outro", () => {
    // Cair no canal por QR por default seria pior que lançar: o número é outro,
    // e enviar pelo canal errado é pior que não enviar.
    expect(getAdapter(UAZAPI).provider).toBe(UAZAPI);
  });

  it("os códigos de erro nomeiam o canal — o operador precisa saber qual falhou", () => {
    expect(getAdapter(UAZAPI).codes.sendFailed).toContain("uazapi");
  });
});

describe("banco e TypeScript falam o mesmo vocabulário", () => {
  // O `pnpm test:db` prova isto contra um Postgres real; aqui é a leitura do
  // artefato que o self-hoster de fato aplica — o baseline, não as migrations.
  const baseline = readFileSync("supabase/baseline.sql", "utf8");

  it("o CHECK de provider do baseline conhece o canal novo", () => {
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,400}'uazapi'/);
  });

  it("o CHECK de ref exige as DUAS colunas — instância sem servidor não endereça nada", () => {
    // O servidor é da CONEXÃO, não da instalação: duas organizações podem ter
    // instâncias em servidores diferentes. Guardar só o id da instância deixaria
    // o envio sem para onde ir.
    expect(baseline).toMatch(/provider = 'uazapi'\s+and uazapi_instance_id\s+is not null/);
    expect(baseline).toMatch(/uazapi_base_url\s+is not null/);
  });

  it("os CHECKs são RECRIADOS, não protegidos por duplicate_object", () => {
    // Num clone eles já existem na versão de quatro providers. `exception when
    // duplicate_object` engoliria a versão nova em silêncio: `update.sh` verde e
    // o banco recusando a sessão do canal novo.
    expect(baseline).toContain("drop constraint if exists channel_sessions_provider_check");
    expect(baseline).toContain("drop constraint if exists channel_sessions_provider_ref_check");
  });

  it("as colunas nascem antes do CHECK que as referencia", () => {
    const col = baseline.indexOf("add column if not exists uazapi_instance_id");
    const check = baseline.indexOf("provider = 'uazapi'");
    expect(col).toBeGreaterThan(-1);
    expect(col).toBeLessThan(check);
  });

  it("o arquivo do webhook aceita o canal — sem isso o evento vira linha de erro", () => {
    expect(baseline).toMatch(/webhook_events_log_provider_check[\s\S]{0,300}'uazapi'/);
  });

  it("a migration versionada existe junto do apêndice — clone atualiza pelas duas vias", () => {
    const mig = readFileSync("supabase/migrations/20260916000000_0261_canal_uazapi.sql", "utf8");
    expect(mig).toContain("uazapi_instance_id");
    expect(mig).toContain("uazapi_base_url");
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain("0261_canal_uazapi");
  });

  it("o token da instância tem coluna PRÓPRIA e cifrada — ele não é o segredo do webhook", () => {
    // São dois papéis: o token AUTENTICA os nossos envios no servidor, e o
    // segredo do webhook autentica o que CHEGA. Guardar um só faria a troca de
    // um girar o outro sem querer.
    expect(baseline).toContain("uazapi_token_encrypted");
  });
});
