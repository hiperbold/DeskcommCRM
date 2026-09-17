/**
 * O aviso de conexão caída que sai do navegador.
 *
 * ─── O buraco que isto fecha ────────────────────────────────────────────────
 *
 * O CRM já tinha DOIS lugares onde a queda aparece: o item na Central
 * (`agent_inbox_items`) e a faixa vermelha do topo. Os dois exigem alguém com o
 * produto ABERTO. A queda que dói é a outra: 19h, time fora, número parado a
 * noite inteira, e a descoberta acontece pelo cliente reclamando no dia
 * seguinte. Esse é o caso que só o e-mail alcança.
 *
 * ─── Quem recebe ────────────────────────────────────────────────────────────
 *
 * Os `admin` da organização, que são exatamente quem a faixa deixa clicar em
 * "Ver conexões" (`ConexaoCaidaBanner`). Avisar quem não pode reconectar
 * transforma o alarme em ruído — e ruído ensina a ignorar alarme.
 *
 * ─── O que este módulo NUNCA faz ────────────────────────────────────────────
 *
 * Lançar. Ele é chamado de dentro do vigia de saúde, que roda de 5 em 5 minutos
 * para TODAS as sessões de TODOS os tenants: uma exceção aqui derrubaria a
 * rodada e deixaria as outras conexões sem vigia — trocando um aviso perdido
 * por vigilância nenhuma. Toda falha vira log e um desfecho nomeado.
 *
 * O dedup não mora aqui: quem chama só chama quando o episódio MUDA
 * (`escalated_status` em `lib/channels/health.ts`), então o e-mail sai uma vez
 * por queda e uma vez por volta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcaDaSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/resend";
import { buildConexaoCaidaEmail, buildConexaoVoltouEmail } from "@/lib/email/templates/conexao-caida";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/** Teto de destinatários por aviso. Organização grande não vira disparo em massa. */
const TETO = 10;

export type DesfechoDoAviso =
  | "enviado"
  | "sem_destinatario"
  | "email_nao_configurado"
  | "falhou";

export interface EventoDeConexao {
  tipo: "caiu" | "voltou";
  /** O MESMO título do item da Central — duas redações divergiriam. */
  titulo?: string;
  corpo?: string | null;
}

/**
 * Os e-mails dos `admin` ativos da organização.
 *
 * O endereço mora no GoTrue, não numa tabela nossa: `user_organizations` só
 * guarda o vínculo. É o mesmo caminho que `app/api/v1/team/route.ts` já usa.
 */
async function destinatarios(admin: SupabaseClient, organizationId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null)
    .limit(TETO);
  if (error || !data) return [];

  const emails: string[] = [];
  for (const linha of data as { user_id: string }[]) {
    const { data: u } = await admin.auth.admin.getUserById(linha.user_id);
    const email = u?.user?.email?.trim();
    if (email) emails.push(email);
  }
  return [...new Set(emails)];
}

async function nomeDaOrganizacao(admin: SupabaseClient, organizationId: string): Promise<string> {
  const { data } = await admin
    .from("organizations")
    .select("display_name")
    .eq("id", organizationId)
    .maybeSingle();
  return ((data as { display_name: string | null } | null)?.display_name ?? "").trim() || "sua organização";
}

export async function avisarConexaoPorEmail(
  admin: SupabaseClient,
  input: { organizationId: string; apelido: string; evento: EventoDeConexao },
): Promise<DesfechoDoAviso> {
  try {
    const para = await destinatarios(admin, input.organizationId);
    if (para.length === 0) return "sem_destinatario";

    const [marca, orgName] = await Promise.all([
      marcaDaSaida(input.organizationId),
      nomeDaOrganizacao(admin, input.organizationId),
    ]);
    const conexoesUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/app/connections`;

    const email =
      input.evento.tipo === "caiu"
        ? buildConexaoCaidaEmail({
            apelido: input.apelido,
            orgName,
            titulo: input.evento.titulo ?? `WhatsApp "${input.apelido}" está desconectado`,
            corpo: input.evento.corpo ?? null,
            conexoesUrl,
            marca,
          })
        : buildConexaoVoltouEmail({ apelido: input.apelido, orgName, conexoesUrl, marca });

    const r = await sendEmail({
      to: para,
      subject: email.subject,
      html: email.html,
      text: email.text,
      fromName: marca.nome,
      tags: [{ name: "tipo", value: `conexao_${input.evento.tipo}` }],
    });

    if (r.ok) return "enviado";
    // `not_configured` é o estado NORMAL de quem instalou sem e-mail: não é
    // erro de operação e não merece log de erro a cada queda.
    if (r.error === "not_configured") return "email_nao_configurado";
    logger.warn("[conexao] aviso por e-mail não saiu", {
      organizationId: input.organizationId,
      motivo: r.error,
      detail: r.details,
    });
    return "falhou";
  } catch (err) {
    logger.warn("[conexao] aviso por e-mail falhou", {
      organizationId: input.organizationId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return "falhou";
  }
}
