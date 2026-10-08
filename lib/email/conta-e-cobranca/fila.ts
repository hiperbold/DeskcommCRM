/**
 * O ENFILEIRAMENTO dos e-mails de conta e de cobrança (CONTA-06, COB-02 a COB-09, IA-02).
 *
 * Quem dispara um fato (um pagamento aplicado, um cancelamento, uma suspensão, um cadastro, um limiar de tokens)
 * só chama `enfileirarEmailDeConta`: um `insert ... on conflict do nothing` em `billing_emails_enviados`
 * (migration 0952) com os DADOS DO MOMENTO do evento. Nada aqui fala com servidor de e-mail, então o gatilho é
 * rápido e o fluxo que o chamou (processador de pagamento, cadastro, cron) não espera SMTP. Quem envia é o cron
 * `enviar-emails-de-conta` (`enviar.ts`), com nova tentativa quando o servidor falha.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 *
 * `unique (organization_id, email_id, chave)`: evento do Asaas repetido, processador rodando duas vezes ou duas
 * telas disparando o mesmo fato batem na unicidade e não enfileiram de novo. Um fato enfileirado e já enviado
 * (ou falhado) continua registrado, então não volta a sair.
 *
 * ─── Nunca derruba quem chamou ──────────────────────────────────────────────
 *
 * Nada daqui lança: banco fora do ar ou `dados` fora do formato viram log estruturado e o desfecho `falhou`.
 * O log leva a organização e o código do e-mail, nunca endereço.
 *
 * `billing_emails_enviados` não está em `lib/database.types.ts`: mesmo tratamento das tabelas irmãs
 * (`as never`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { codigoConhecido, DADOS_DO_EMAIL, type CodigoDeEmail, type DadosDoEmail } from "./montar";

export type DestinoDoEmail = "admins" | "criador";

type EntradaDoCodigo<K extends CodigoDeEmail> = {
  organizationId: string;
  /** O código do e-mail (`ID_DO_EMAIL` do template): CONTA-06, COB-02... */
  emailId: K;
  /** O fato que dispara, estável: `organizacao:<id>`, `pedido:<id>`, `pagamento:<id do Asaas>`. */
  chave: string;
  destino: DestinoDoEmail;
  /** Obrigatório com `destino: "criador"`. */
  criadorUserId?: string;
  /** Tudo que o template precisa, capturado NA HORA do evento. Nunca o endereço de e-mail de ninguém. */
  dados: DadosDoEmail<K>;
  copiaParaOperador: boolean;
};

/** O que o gatilho entrega ao enfileiramento: um código de e-mail e os `dados` do formato dele. */
export type EmailParaEnfileirar = { [K in CodigoDeEmail]: EntradaDoCodigo<K> }[CodigoDeEmail];

export type DesfechoDoEnfileiramento = "enfileirado" | "ja_existia" | "falhou";

export type Enfileirador = (entrada: EmailParaEnfileirar) => Promise<DesfechoDoEnfileiramento>;

/**
 * Enfileira o e-mail. `enfileirado` = a linha é nova; `ja_existia` = o fato já estava na fila (ou já saiu);
 * `falhou` = não deu para gravar (o motivo vai ao log). Nunca lança.
 */
export async function enfileirarEmailDeConta(
  entrada: EmailParaEnfileirar,
  admin: SupabaseClient = createAdminClient(),
): Promise<DesfechoDoEnfileiramento> {
  const base = { organization_id: entrada.organizationId, email_id: entrada.emailId };
  try {
    if (!codigoConhecido(entrada.emailId)) {
      logger.warn("[email-de-conta] código de e-mail desconhecido, nada enfileirado", base);
      return "falhou";
    }
    if (entrada.destino === "criador" && !entrada.criadorUserId) {
      logger.warn("[email-de-conta] destino criador sem criador, nada enfileirado", base);
      return "falhou";
    }
    const dados = DADOS_DO_EMAIL[entrada.emailId].safeParse(entrada.dados);
    if (!dados.success) {
      logger.warn("[email-de-conta] dados fora do formato, nada enfileirado", base);
      return "falhou";
    }

    const { data, error } = await admin
      .from("billing_emails_enviados" as never)
      .upsert(
        {
          organization_id: entrada.organizationId,
          email_id: entrada.emailId,
          chave: entrada.chave,
          destino: entrada.destino,
          criador_user_id: entrada.destino === "criador" ? entrada.criadorUserId : null,
          copia_para_operador: entrada.copiaParaOperador,
          dados: dados.data,
          status: "pendente",
        } as never,
        { onConflict: "organization_id,email_id,chave", ignoreDuplicates: true },
      )
      .select("id");
    if (error) {
      logger.warn("[email-de-conta] não deu para enfileirar", { ...base, codigo: (error as { code?: string }).code });
      return "falhou";
    }
    return ((data as { id: string }[] | null) ?? []).length > 0 ? "enfileirado" : "ja_existia";
  } catch (erro) {
    logger.warn("[email-de-conta] enfileirar lançou", {
      ...base,
      motivo: erro instanceof Error ? erro.message.replace(/\S+@\S+/g, "***").slice(0, 120) : "erro",
    });
    return "falhou";
  }
}
