import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import {
  formatarData,
  formatarReais,
  montarEmailTransacional,
  urlSegura,
} from "@/lib/email/templates/_layout-transacional";
import { buildBoasVindasEmail } from "@/lib/email/templates/boas-vindas";
import { buildCancelamentoConfirmadoEmail } from "@/lib/email/templates/cancelamento-confirmado";
import { buildContaSuspensaEmail } from "@/lib/email/templates/conta-suspensa";
import { buildEstornoFeitoEmail } from "@/lib/email/templates/estorno-feito";
import { buildPacoteDeTokensLiberadoEmail } from "@/lib/email/templates/pacote-de-tokens-liberado";
import { buildPagamentoNaoAprovadoEmail } from "@/lib/email/templates/pagamento-nao-aprovado";
import { buildPlanoConfirmadoEmail } from "@/lib/email/templates/plano-confirmado";
import { buildReciboDePagamentoEmail } from "@/lib/email/templates/recibo-de-pagamento";
import { buildRenovacaoNoCartaoChegandoEmail } from "@/lib/email/templates/renovacao-no-cartao-chegando";
import { buildTokensDeIaAcabandoEmail } from "@/lib/email/templates/tokens-de-ia-acabando";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * Os 10 e-mails transacionais novos (fase A: só os templates, sem envio) e o layout comum. Prova o que um
 * leitor vê: assunto, valores formatados (reais e dd/mm/aaaa), escape de HTML em todo valor de fora, botão só
 * com URL http(s), o link também no texto puro e a tradução para o espanhol.
 */

const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: "https://crm.exemplo.com.br/email/logo-hipercrm.png",
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
const URL_OK = "https://crm.exemplo.com.br/app/settings/plano";
const EMPRESA = "Empresa do Diego";

function base(idioma: Idioma = "pt-BR", extra: { empresa?: string; url?: string } = {}) {
  return { marca: MARCA, idioma, empresa: extra.empresa ?? EMPRESA, url: extra.url ?? URL_OK };
}

type Saida = { subject: string; html: string; text: string };
interface Caso {
  id: string;
  assunto: string;
  /** Pedaços que têm de aparecer no texto puro (valores já formatados). */
  contem: string[];
  montar: (b: ReturnType<typeof base>) => Saida;
}

const CASOS: Caso[] = [
  {
    id: "CONTA-06",
    assunto: "Bem-vindo ao HiperCRM, Diego",
    contem: ["Bem-vindo, Diego", "Conecte seu WhatsApp", "Começar agora"],
    montar: (b) => buildBoasVindasEmail({ ...b, nome: "Diego" }),
  },
  {
    id: "COB-02",
    assunto: "Seu plano Pro está ativo",
    contem: [
      "Pro (semestral)",
      "até 08/04/2027",
      "Forma de pagamento: Cartão em 6x",
      "Acesso até: 08/04/2027",
    ],
    montar: (b) =>
      buildPlanoConfirmadoEmail({
        ...b,
        plano: "Pro",
        ciclo: "semiannual",
        formaDePagamento: { tipo: "cartao_parcelado", parcelas: 6 },
        acessoAte: "2027-04-08",
      }),
  },
  {
    id: "COB-03",
    assunto: "Recibo do seu pagamento de R$ 1.049,00",
    contem: [
      "Valor: R$ 1.049,00",
      "Data do pagamento: 08/10/2026",
      "Período: 08/10/2026 a 08/04/2027",
      "Parcela: 2 de 6",
    ],
    montar: (b) =>
      buildReciboDePagamentoEmail({
        ...b,
        valor: 104900,
        pagoEm: "2026-10-08",
        plano: "Pro",
        periodoInicio: "2026-10-08",
        periodoFim: "2027-04-08",
        formaDePagamento: { tipo: "cartao" },
        parcela: { numero: 2, total: 6 },
      }),
  },
  {
    id: "COB-04",
    assunto: "Seu plano renova em 3 dias",
    contem: ["No dia 11/10/2026 vamos cobrar R$ 349,66 no cartão final 4242", "Cartão: final 4242"],
    montar: (b) =>
      buildRenovacaoNoCartaoChegandoEmail({
        ...b,
        plano: "Pro",
        valor: 34966,
        cobrancaEm: "2026-10-11",
        cartaoFinal: "4242",
        dias: 3,
      }),
  },
  {
    id: "COB-05",
    assunto: "Não conseguimos cobrar a renovação do seu plano",
    contem: ["A cobrança de R$ 349,66 do plano Pro não foi aprovada", "Acesso até: 15/10/2026"],
    montar: (b) =>
      buildPagamentoNaoAprovadoEmail({ ...b, plano: "Pro", valor: 34966, acessoAte: "2026-10-15" }),
  },
  {
    id: "COB-06",
    assunto: "Sua conta está suspensa",
    contem: ["A conta da Empresa do Diego foi suspensa por falta de pagamento", "Regularizar"],
    montar: (b) => buildContaSuspensaEmail(b),
  },
  {
    id: "COB-07",
    assunto: "Cancelamento confirmado",
    contem: ["O plano Pro foi cancelado", "acesso até 15/10/2026", "Reativar plano"],
    montar: (b) =>
      buildCancelamentoConfirmadoEmail({ ...b, plano: "Pro", acessoAte: "2026-10-15" }),
  },
  {
    id: "COB-08",
    assunto: "Estorno de R$ 349,66 feito",
    contem: ["Estornamos R$ 349,66 referente a Pro", "Data do estorno: 09/10/2026"],
    montar: (b) =>
      buildEstornoFeitoEmail({ ...b, valor: 34966, plano: "Pro", estornadoEm: "2026-10-09" }),
  },
  {
    id: "COB-09",
    assunto: "Seu pacote de 500.000 tokens está liberado",
    contem: ["Pacote: 500.000 tokens", "Valor pago: R$ 99,90", "Válido até: 08/11/2026"],
    montar: (b) =>
      buildPacoteDeTokensLiberadoEmail({
        ...b,
        tokens: 500_000,
        valorPago: 9990,
        validoAte: "2026-11-08",
      }),
  },
  {
    id: "IA-02",
    assunto: "Seus tokens de IA estão acabando",
    contem: [
      "já usou 80% dos tokens de IA do mês",
      "Tokens usados no mês: 80%",
      "400.000 de 500.000",
    ],
    montar: (b) =>
      buildTokensDeIaAcabandoEmail({
        ...b,
        nivel: 80,
        usados: 400_000,
        total: 500_000,
        renovaEm: "2026-11-08",
      }),
  },
];

describe.each(CASOS)("$id", (caso) => {
  it("assunto em pt-BR e valores formatados no texto", () => {
    const { subject, text, html } = caso.montar(base());
    expect(subject).toBe(caso.assunto);
    for (const pedaco of caso.contem) {
      expect(text, `texto puro sem "${pedaco}"`).toContain(pedaco);
    }
    // Nada de centavo cru nem de data ISO no que o leitor vê.
    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain('name="color-scheme"');
  });

  it("sem travessão nem espaço sem quebra no assunto", () => {
    const { subject, text } = caso.montar(base());
    const travessao = String.fromCharCode(0x2014);
    const espacoSemQuebra = String.fromCharCode(0xa0);
    expect(subject).not.toContain(travessao);
    expect(subject).not.toContain(espacoSemQuebra);
    expect(text).not.toContain(travessao);
  });

  it("o botão leva ao link, e o texto puro traz o mesmo link", () => {
    const { html, text } = caso.montar(base());
    expect(html).toContain(`href="${URL_OK}"`);
    expect(html).toContain(`background:${MARCA.accent}`);
    expect(html).toContain(`color:${MARCA.accentFg}`);
    expect(text).toContain(URL_OK);
  });

  it("empresa com HTML sai escapada, no corpo e no rodapé", () => {
    const { html, text } = caso.montar(base("pt-BR", { empresa: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>alert(1)");
    // Nem todo e-mail cita a empresa no corpo, mas todos citam no rodapé.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // O texto puro não é HTML: leva o nome como veio.
    expect(text).toContain("<script>alert(1)</script>");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "ftp://exemplo.com/a",
    "não é url",
    "",
  ])("URL que não é http(s) (%s) não desenha botão nem link", (url) => {
    const { html, text } = caso.montar(base("pt-BR", { url }));
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Ou copie e cole");
    expect(html).not.toMatch(/href=/);
    if (url) expect(text).not.toContain(url);
  });

  it("em espanhol o assunto é outro e o idioma da página acompanha", () => {
    const pt = caso.montar(base("pt-BR"));
    const es = caso.montar(base("es"));
    expect(es.subject).not.toBe(pt.subject);
    expect(es.html).toContain('lang="es"');
    expect(es.text).toContain("Recibes este correo");
    expect(es.html).not.toContain("Você recebe");
  });
});

describe("detalhes por e-mail", () => {
  it("boas-vindas: nome com HTML sai escapado e o rodapé fala de quem criou a empresa", () => {
    const { html, text, subject } = buildBoasVindasEmail({ ...base(), nome: "<b>Di</b>" });
    expect(html).toContain("&lt;b&gt;Di&lt;/b&gt;");
    expect(html).not.toContain("<b>Di</b>");
    expect(subject).toBe("Bem-vindo ao HiperCRM, <b>Di</b>");
    expect(text).toContain("Você recebe este e-mail porque criou a Empresa do Diego no HiperCRM.");
    expect(html).toContain("Cada atendente entra com o próprio login.");
  });

  it("renovação no cartão: 1 dia fica no singular", () => {
    const { subject } = buildRenovacaoNoCartaoChegandoEmail({
      ...base(),
      plano: "Pro",
      valor: 34966,
      cobrancaEm: "2026-10-09",
      cartaoFinal: "4242",
      dias: 1,
    });
    expect(subject).toBe("Seu plano renova em 1 dia");
  });

  it("renovação no cartão sem os dígitos: fala do cartão cadastrado e a linha Cartão some", () => {
    const { text } = buildRenovacaoNoCartaoChegandoEmail({
      ...base(),
      plano: "Pro",
      valor: 34966,
      cobrancaEm: "2026-10-11",
      dias: 3,
    });
    expect(text).toContain("No dia 11/10/2026 vamos cobrar R$ 349,66 no cartão cadastrado para renovar o plano Pro");
    expect(text).not.toContain("Cartão:");
    expect(text).not.toContain("final");
  });

  it("pacote de tokens sem validade: o texto não promete data e a linha Válido até some", () => {
    const { text } = buildPacoteDeTokensLiberadoEmail({ ...base(), tokens: 500_000, valorPago: 9990 });
    expect(text).toContain("O pacote de 500.000 tokens já está no saldo da Empresa do Diego.");
    expect(text).toContain("Valor pago: R$ 99,90");
    expect(text).not.toContain("Válido até");
    expect(text).not.toContain("vale até");
  });

  it("plano confirmado: Pix e à vista no cartão", () => {
    const comoSai = (
      formaDePagamento: Parameters<typeof buildPlanoConfirmadoEmail>[0]["formaDePagamento"],
    ) =>
      buildPlanoConfirmadoEmail({
        ...base(),
        plano: "Pro",
        ciclo: "monthly",
        formaDePagamento,
        acessoAte: "2026-11-08",
      }).text;
    expect(comoSai({ tipo: "pix" })).toContain("Forma de pagamento: Pix");
    expect(comoSai({ tipo: "cartao" })).toContain("Forma de pagamento: Cartão");
  });

  it("recibo: sem parcela não há linha de parcela", () => {
    const { text } = buildReciboDePagamentoEmail({
      ...base(),
      valor: 19900,
      pagoEm: "2026-10-08T15:00:00+00:00",
      plano: "Pro",
      periodoInicio: "2026-10-08",
      periodoFim: "2026-11-08",
      formaDePagamento: { tipo: "pix" },
    });
    expect(text).not.toContain("Parcela");
    expect(text).toContain("Valor: R$ 199,00");
  });

  it("tokens: nível 100 usa o selo de perigo, o título de esgotado e a barra cheia", () => {
    const { subject, html, text } = buildTokensDeIaAcabandoEmail({
      ...base(),
      nivel: 100,
      usados: 500_000,
      total: 500_000,
      renovaEm: "2026-11-08",
    });
    expect(subject).toBe("Seus tokens de IA acabaram");
    expect(text).toContain("A IA parou de responder e volta em 08/11/2026");
    expect(text).toContain("Tokens usados no mês: 100%");
    expect(html).toContain("#b91c1c");
    expect(html).toContain('width="100%"');
  });

  it("tokens: nível 80 usa o selo de alerta e a barra no percentual medido", () => {
    const { html } = buildTokensDeIaAcabandoEmail({
      ...base(),
      nivel: 80,
      usados: 400_000,
      total: 500_000,
      renovaEm: "2026-11-08",
    });
    expect(html).toContain("#b45309");
    expect(html).toContain('width="80%"');
  });
});

describe("layout comum", () => {
  const minimo = {
    marca: MARCA,
    idioma: "pt-BR" as const,
    empresa: EMPRESA,
    titulo: "Título",
    paragrafos: ["Primeira frase. Segunda frase."],
  };

  it("logo em SVG não é desenhada (o Gmail não mostra): entra o nome da marca em texto", () => {
    const { html } = montarEmailTransacional({
      ...minimo,
      marca: { ...MARCA, logoUrl: "https://crm.exemplo.com.br/logo.svg?v=2" },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(`font-weight:700;color:${MARCA.accent}">HiperCRM</span>`);
  });

  it("sem logo, também entra o nome", () => {
    const { html } = montarEmailTransacional({ ...minimo, marca: { ...MARCA, logoUrl: null } });
    expect(html).not.toContain("<img");
    expect(html).toContain("HiperCRM");
  });

  it("logo PNG é desenhada com 32px de altura e o nome da marca como alt", () => {
    const { html } = montarEmailTransacional(minimo);
    expect(html).toContain(
      '<img src="https://crm.exemplo.com.br/email/logo-hipercrm.png" alt="HiperCRM" height="32"',
    );
  });

  it("o texto de pré-visualização é a primeira frase do primeiro parágrafo", () => {
    const { html } = montarEmailTransacional(minimo);
    expect(html).toMatch(/display:none[^>]*>Primeira frase\.(?!\s*Segunda)/);
  });

  it("o motivo do rodapé pode ser trocado e é escapado", () => {
    const { html, text } = montarEmailTransacional({
      ...minimo,
      motivoDoRodape: "Motivo <i>próprio</i>",
    });
    expect(html).toContain("Motivo &lt;i&gt;próprio&lt;/i&gt;");
    expect(text).toContain("Motivo <i>próprio</i>");
    expect(html).not.toContain("administra a");
  });

  it("barra de progresso corta o percentual em 0 a 100", () => {
    const acima = montarEmailTransacional({
      ...minimo,
      progresso: { percentual: 250, rotulo: "Uso" },
    });
    expect(acima.text).toContain("Uso: 100%");
    const abaixo = montarEmailTransacional({
      ...minimo,
      progresso: { percentual: -5, rotulo: "Uso" },
    });
    expect(abaixo.text).toContain("Uso: 0%");
  });

  it("formatadores: reais, data civil e instante lido em São Paulo", () => {
    expect(formatarReais(104900)).toBe("R$ 1.049,00");
    expect(formatarReais(34966)).toBe("R$ 349,66");
    expect(formatarData("2026-10-08")).toBe("08/10/2026");
    // 02:00 UTC de 9/out ainda é 8/out em São Paulo (UTC-3).
    expect(formatarData("2026-10-09T02:00:00+00:00")).toBe("08/10/2026");
    expect(formatarData("não é data")).toBe("não é data");
    expect(urlSegura("https://a.com/x")).toBe("https://a.com/x");
    expect(urlSegura("javascript:alert(1)")).toBeNull();
  });
});

describe("catálogo de idiomas", () => {
  it("todo texto novo do espanhol e do chinês existe no dicionário e em zh-CN com os mesmos placeholders", () => {
    const zh = JSON.parse(
      readFileSync(join(process.cwd(), "lib/i18n/traducoes/zh-CN.json"), "utf8"),
    ) as Record<string, string>;
    const chaves = [
      "Você recebe este e-mail porque administra a {empresa} no {crm}.",
      "Seu plano {plano} está ativo",
      "Recibo do seu pagamento de {valor}",
      "Seus tokens de IA acabaram",
      "{usados} de {total}",
      "No dia {data} vamos cobrar {valor} no cartão cadastrado para renovar o plano {plano}. Para trocar o cartão ou cancelar, use o botão abaixo.",
      "O pacote de {tokens} tokens já está no saldo da {empresa}.",
    ];
    for (const chave of chaves) {
      expect(zh[chave], `falta zh-CN: ${chave}`).toBeTruthy();
      const marcas = (t: string) => (t.match(/\{[a-z]+\}/g) ?? []).sort().join();
      expect(marcas(zh[chave]!)).toBe(marcas(chave));
    }
  });
});
