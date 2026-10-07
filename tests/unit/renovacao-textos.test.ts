import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  corpoDaRenovacao,
  formatarDia,
  idiomaDoDestinatario,
  severidadeDoMarco,
  tituloDaRenovacao,
} from "@/lib/billing/assinatura/renovacao-textos";
import { buildRenovacaoDoPlanoEmail } from "@/lib/email/templates/renovacao-do-plano";
import { parcelasDoPlanoSemRenovacao } from "@/app/app/settings/plano/_logica-compra";
import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * Os textos e o e-mail da régua de renovação (D-177, parte 2): pt-BR e es servidos, zh-CN no catálogo (o
 * chinês ainda é `em_construcao`), assunto e texto curtos, sem preço, com o botão para a tela de assinar; e
 * a regra de "assinatura viva" do banco e a da tela do plano dizem a mesma coisa.
 */

const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#506d48",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
const URL_ASSINAR = "https://crm.exemplo.com.br/app/settings/plano/assinar";
const base = { planoNome: "Pro", ultimoDia: "2026-11-06", diasRestantes: 30 };

describe("o idioma de quem recebe", () => {
  it("preferência da pessoa, depois a da organização, depois pt-BR", () => {
    expect(idiomaDoDestinatario("es", "pt-BR")).toBe("es");
    expect(idiomaDoDestinatario(null, "es")).toBe("es");
    expect(idiomaDoDestinatario("fr", "es")).toBe("es");
    expect(idiomaDoDestinatario("en-US", null)).toBe("pt-BR");
    expect(idiomaDoDestinatario(null, null)).toBe("pt-BR");
  });

  it("zh-CN ainda não é servido (em construção): cai para o próximo da cadeia", () => {
    expect(idiomaDoDestinatario("zh-CN", "es")).toBe("es");
  });
});

describe("severidade e data", () => {
  it("30 e 15 informam; 7, 1 e o dia pedem ação", () => {
    expect([30, 15, 7, 1, 0].map((m) => severidadeDoMarco(m as 30))).toEqual(["info", "info", "warn", "warn", "warn"]);
  });

  it("a data civil de São Paulo vira dd/mm/aaaa", () => {
    expect(formatarDia("2026-11-06")).toBe("06/11/2026");
  });
});

describe("o e-mail", () => {
  it("pt-BR: assunto curto com o plano, parágrafo com o último dia, o plano não renova sozinho, sem preço e botão para assinar", () => {
    const e = buildRenovacaoDoPlanoEmail({ ...base, idioma: "pt-BR", assinarUrl: URL_ASSINAR, marca: MARCA });
    expect(e.subject).toBe("Faltam 30 dias para o fim do seu plano Pro");
    expect(e.text).toContain("O acesso vai até 06/11/2026 e este plano não renova sozinho");
    expect(e.text).toContain("à vista no cartão (com renovação automática) ou no Pix");
    expect(e.text).toContain("parcelado no cartão");
    expect(e.text).toContain(`Renovar meu plano: ${URL_ASSINAR}`);
    expect(e.html).toContain(`href="${URL_ASSINAR}"`);
    expect(e.html).toContain('lang="pt-BR"');
    expect(e.html + e.text).not.toMatch(/R\$|\d+,\d{2}/);
  });

  it("es: tudo em espanhol", () => {
    const e = buildRenovacaoDoPlanoEmail({ ...base, diasRestantes: 1, idioma: "es", assinarUrl: URL_ASSINAR, marca: MARCA });
    expect(e.subject).toBe("Falta 1 día para el fin de tu plan Pro");
    expect(e.text).toContain("no se renueva solo");
    expect(e.text).toContain("Renovar mi plan: ");
    expect(e.html).toContain('lang="es"');
  });

  it("o dia 0 diz que hoje é o último dia", () => {
    const e = buildRenovacaoDoPlanoEmail({ ...base, diasRestantes: 0, idioma: "pt-BR", assinarUrl: URL_ASSINAR, marca: MARCA });
    expect(e.subject).toBe("Hoje é o último dia do seu plano Pro");
  });

  it("escapa o nome do plano no HTML e nunca devolve o marcador sem trocar", () => {
    const e = buildRenovacaoDoPlanoEmail({ ...base, planoNome: '<b>"Pro"</b> $&', idioma: "pt-BR", assinarUrl: URL_ASSINAR, marca: MARCA });
    expect(e.html).toContain("&lt;b&gt;&quot;Pro&quot;&lt;/b&gt; $&amp;");
    expect(e.html).not.toContain("<b>");
    expect(e.html + e.text).not.toMatch(/\{(plano|dias|data)\}/);
  });

  it("sem travessão em nenhum idioma", () => {
    for (const idioma of ["pt-BR", "es"] as const) {
      const e = buildRenovacaoDoPlanoEmail({ ...base, idioma, assinarUrl: URL_ASSINAR, marca: MARCA });
      expect(e.subject + e.html + e.text).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe("o catálogo de chinês tem as frases (para o dia em que o idioma for servido)", () => {
  const zh = JSON.parse(readFileSync(join(process.cwd(), "lib/i18n/traducoes/zh-CN.json"), "utf8")) as Record<string, string>;
  const chaves = [
    "Hoje é o último dia do seu plano {plano}",
    "Falta 1 dia para o fim do seu plano {plano}",
    "Faltam {dias} dias para o fim do seu plano {plano}",
    corpoDaRenovacao({ ...base, idioma: "pt-BR" }).replace("06/11/2026", "{data}"),
    "Renovar meu plano",
    "Ou copie e cole este link no navegador:",
  ];

  it.each(chaves)("%s", (chave) => {
    expect(zh[chave], "falta a tradução zh-CN").toBeTruthy();
    const marcadores = (t: string) => (t.match(/\{[a-z]+\}/g) ?? []).sort().join();
    expect(marcadores(zh[chave]!)).toBe(marcadores(chave));
  });

  it("os títulos em pt-BR usam as mesmas chaves do catálogo", () => {
    expect(tituloDaRenovacao({ ...base, idioma: "pt-BR", diasRestantes: 0 })).toBe("Hoje é o último dia do seu plano Pro");
  });
});

describe("a regra de assinatura viva é a mesma do banco e da tela do plano", () => {
  // A mesma matriz está em tests/invariants/regua-de-renovacao-banco.test.ts (fn_billing_assinatura_viva).
  const pedidoParcelado = [{ tipo: "assinatura", status: "pago", parcelas: 6, pagoEm: "2026-10-01T10:00:00Z" }];

  it("sem id de assinatura: não renova sozinho (a tela avisa)", () => {
    expect(parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: null, pedidos: pedidoParcelado })).toBe(6);
  });

  it("id gravado e sem encerramento: viva, renova sozinha (a tela não avisa)", () => {
    expect(parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: { asaasSubscriptionId: "sub_x", encerradaEm: null }, pedidos: pedidoParcelado })).toBeNull();
  });

  it("id gravado e encerrada: não renova sozinho", () => {
    expect(
      parcelasDoPlanoSemRenovacao({ assinaturaDoContrato: { asaasSubscriptionId: "sub_x", encerradaEm: "2026-10-01T10:00:00Z" }, pedidos: pedidoParcelado }),
    ).toBe(6);
  });
});

describe("o agendamento da régua", () => {
  const entrypoint = readFileSync(join(process.cwd(), "docker/scheduler/entrypoint.sh"), "utf8");

  it("uma vez por dia às 11:00 UTC (08:00 em São Paulo), com timeout que cabe no orçamento da rodada", () => {
    expect(entrypoint).toMatch(/^0 11 \* \* \*\|180\|api\/v1\/cron\/avisar-renovacao$/m);
  });
});
