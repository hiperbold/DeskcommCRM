/**
 * Prévia dos e-mails transacionais novos: monta 4 deles (CONTA-06, COB-03, COB-05, IA-02) e grava o HTML.
 *
 *   pnpm tsx scripts/previa-emails-transacionais.mts [pasta-de-saida]
 *
 * Padrão da pasta de saída: /mnt/f/temp/2026-10-08/emails. Para cada e-mail sai `<ID>.html` (o que o cliente
 * de e-mail recebe, com a logo do endereço público) e `<ID>.local.html` (a mesma coisa com a logo embutida em
 * data URI, só para a prévia local mostrar a imagem sem depender do endereço estar no ar).
 *
 * Os valores são de exemplo; nenhum é preço de plano do catálogo. Não envia nada.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MarcaDeSaida } from "../lib/branding/saida";

// Os templates importam `lib/branding/saida`, que importa `lib/env` e este cobra as variáveis de ambiente na
// importação. A prévia não toca em banco nem em segredo: semeia os mesmos placeholders do setup dos testes
// (`??=`, então valor real de ambiente vence) e só então importa os templates.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test-placeholder.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-placeholder-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-placeholder-service-role-key";

const { buildBoasVindasEmail } = await import("../lib/email/templates/boas-vindas");
const { buildPagamentoNaoAprovadoEmail } =
  await import("../lib/email/templates/pagamento-nao-aprovado");
const { buildReciboDePagamentoEmail } = await import("../lib/email/templates/recibo-de-pagamento");
const { buildTokensDeIaAcabandoEmail } =
  await import("../lib/email/templates/tokens-de-ia-acabando");

const SAIDA = process.argv[2] ?? "/mnt/f/temp/2026-10-08/emails";
const LOGO_PUBLICA = "https://crm.hiperbold.com.br/email/logo-hipercrm.png";

const marca: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: LOGO_PUBLICA,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};

const base = { marca, idioma: "pt-BR" as const, empresa: "Empresa do Diego" };

const emails: Array<{ id: string; subject: string; html: string; text: string }> = [
  {
    id: "CONTA-06",
    ...buildBoasVindasEmail({ ...base, nome: "Diego", url: "https://crm.hiperbold.com.br/app" }),
  },
  {
    id: "COB-03",
    ...buildReciboDePagamentoEmail({
      ...base,
      valor: 34966,
      pagoEm: "2026-10-08",
      plano: "Pro",
      periodoInicio: "2026-10-08",
      periodoFim: "2027-04-08",
      formaDePagamento: { tipo: "cartao_parcelado", parcelas: 6 },
      parcela: { numero: 2, total: 6 },
      url: "https://crm.hiperbold.com.br/app/settings/plano",
    }),
  },
  {
    id: "COB-05",
    ...buildPagamentoNaoAprovadoEmail({
      ...base,
      plano: "Pro",
      valor: 34966,
      acessoAte: "2026-10-15",
      url: "https://crm.hiperbold.com.br/app/settings/plano",
    }),
  },
  {
    id: "IA-02",
    ...buildTokensDeIaAcabandoEmail({
      ...base,
      nivel: 80,
      usados: 400_000,
      total: 500_000,
      renovaEm: "2026-11-08",
      url: "https://crm.hiperbold.com.br/app/settings/plano",
    }),
  },
];

const logoLocal = `data:image/png;base64,${readFileSync(
  join(import.meta.dirname, "..", "public", "email", "logo-hipercrm.png"),
).toString("base64")}`;

mkdirSync(SAIDA, { recursive: true });
for (const email of emails) {
  writeFileSync(join(SAIDA, `${email.id}.html`), email.html);
  writeFileSync(
    join(SAIDA, `${email.id}.local.html`),
    email.html.split(LOGO_PUBLICA).join(logoLocal),
  );
  writeFileSync(join(SAIDA, `${email.id}.txt`), `Assunto: ${email.subject}\n\n${email.text}\n`);
  console.info(`${email.id}: ${email.subject}`);
}
console.info(`gravado em ${SAIDA}`);
