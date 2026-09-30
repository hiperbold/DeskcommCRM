/**
 * Avisa o DONO DA CONTA por e-mail quando os códigos de recuperação da
 * verificação em duas etapas são regenerados ou usados (D-136).
 *
 * Os dois eventos mexem no que protege a conta: regenerar invalida os códigos
 * antigos, e usar um apaga todos os fatores TOTP. Sem aviso, quem tinha a senha
 * de outra pessoa fazia as duas coisas e o dono só descobria ao perder o acesso.
 *
 * É melhor esforço e NUNCA lança: o aviso não pode desfazer nem travar a
 * operação que o motivou (a instalação pode nem ter e-mail configurado). O
 * rastro que não depende de e-mail é o `audit()` que cada chamador já grava.
 */
import { marcaDaSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";
import { logger } from "@/lib/logger";

export type EventoDeCodigos = "regenerados" | "usado";

const TEXTO: Record<EventoDeCodigos, { assunto: string; corpo: string }> = {
  regenerados: {
    assunto: "Seus códigos de recuperação foram regenerados",
    corpo:
      "Os códigos de recuperação da verificação em duas etapas da sua conta foram regenerados. Os códigos antigos deixaram de valer.",
  },
  usado: {
    assunto: "Um código de recuperação foi usado na sua conta",
    corpo:
      "Um código de recuperação foi usado na sua conta e a verificação em duas etapas foi removida. No próximo acesso você precisa cadastrá-la de novo.",
  },
};

export async function avisarSobreCodigosDeRecuperacao(args: {
  email: string | null | undefined;
  evento: EventoDeCodigos;
  ip?: string | null;
}): Promise<void> {
  if (!args.email) return;
  try {
    const marca = await marcaDaSaida(null);
    const { assunto, corpo } = TEXTO[args.evento];
    const aviso =
      "Se não foi você, troque sua senha agora e fale com o administrador da sua empresa.";
    const origem = args.ip ? ` Endereço de origem: ${args.ip}.` : "";
    const text = `${corpo}${origem}\n\n${aviso}\n`;
    const html = `<p>${corpo}${origem}</p><p><strong>${aviso}</strong></p>`;
    const r = await sendEmail({
      to: args.email,
      subject: assunto,
      html,
      text,
      fromName: marca.nome,
      tags: [{ name: "kind", value: "mfa_recovery_codes" }],
    });
    if (!r.ok) {
      logger.warn("[mfa] aviso de códigos de recuperação não saiu", {
        evento: args.evento,
        error: r.error ?? null,
      });
    }
  } catch (err) {
    logger.warn("[mfa] aviso de códigos de recuperação falhou", {
      evento: args.evento,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
