/**
 * As duas bordas reais da régua de aviso de renovação (D-177, parte 2): o banco (`fn_billing_renovacao_*`,
 * migration 0946) e o que sai do processo (e-mail pelo roteador SMTP/Resend e quem recebe). A ordem das
 * chamadas e o resultado de cada canal estão em `avisar-renovacao.ts`, que só conhece as interfaces.
 *
 * `fn_billing_renovacao_*` e `billing_avisos_de_renovacao` são novas (0946) e não estão em
 * `lib/database.types.ts`: mesmo tratamento que os conferidores irmãos dão à função recém-nascida.
 *
 * Quem recebe o e-mail: o dono e os admins ativos da organização. O projeto não tem papel `owner`
 * (`user_organizations.role` é viewer, agent, manager ou admin; quem cria a organização entra como
 * admin), e "ativo" é `revoked_at` nulo, a mesma régua de `fn_user_role_in_org`. O endereço mora no GoTrue,
 * não numa tabela nossa. Teto de 10 por aviso: organização grande não vira disparo em massa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcaDaSaida, type MarcaDeSaida } from "@/lib/branding/saida";
import { buildRenovacaoDoPlanoEmail } from "@/lib/email/templates/renovacao-do-plano";
import { emailConfigurado, sendEmail } from "@/lib/email/roteador";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import type {
  AvisadorDeRenovacaoDb,
  AvisadorDeRenovacaoServicos,
  DestinatarioDeRenovacao,
  PendenteDeRenovacao,
  ReservaDeRenovacao,
} from "./avisar-renovacao";
import { idiomaDoDestinatario, type MarcoDaRenovacao } from "./renovacao-textos";

const TETO_DE_DESTINATARIOS = 10;

interface LinhaPendente {
  organization_id: string;
  contract_id: string;
  fim_do_periodo: string;
  ultimo_dia: string;
  dias_restantes: number;
  marco: number;
  plano_nome: string | null;
  ciclo: string | null;
  org_nome: string | null;
  org_locale: string | null;
}

interface LinhaReserva {
  reserva_id: string;
  enviar_email: boolean;
  criar_aviso: boolean;
}

export function avisadorDeRenovacaoSobre(admin: SupabaseClient): AvisadorDeRenovacaoDb {
  return {
    async encerrarAvisosDeQuemRenovou(agora) {
      const { data, error } = await admin.rpc("fn_billing_renovacao_encerrar_avisos" as never, {
        p_agora: agora.toISOString(),
      } as never);
      return { data: typeof data === "number" ? data : null, error };
    },

    async listarPendentes(agora, limite) {
      const { data, error } = await admin.rpc("fn_billing_renovacao_pendentes" as never, {
        p_agora: agora.toISOString(),
        p_limite: limite,
      } as never);
      if (error) return { data: null, error };
      const linhas = (data as LinhaPendente[] | null) ?? [];
      return {
        data: linhas.map((l) => ({
          organizationId: l.organization_id,
          contractId: l.contract_id,
          fimDoPeriodo: l.fim_do_periodo,
          ultimoDia: l.ultimo_dia,
          diasRestantes: l.dias_restantes,
          marco: l.marco as MarcoDaRenovacao,
          planoNome: l.plano_nome ?? "",
          ciclo: l.ciclo,
          orgNome: l.org_nome ?? "",
          orgLocale: l.org_locale,
        })),
        error: null,
      };
    },

    async reservar(p, agora) {
      const { data, error } = await admin.rpc("fn_billing_renovacao_reservar" as never, {
        p_org: p.organizationId,
        p_contract: p.contractId,
        p_fim: p.fimDoPeriodo,
        p_marco: p.marco,
        p_agora: agora.toISOString(),
      } as never);
      if (error) return { data: null, error };
      const linha = ((data as LinhaReserva[] | null) ?? [])[0];
      const reserva: ReservaDeRenovacao | null = linha
        ? { reservaId: linha.reserva_id, enviarEmail: linha.enviar_email, criarAviso: linha.criar_aviso }
        : null;
      return { data: reserva, error: null };
    },

    async gravarEmail(reservaId, resultado, enviados, falhas, agora) {
      const { error } = await admin
        .from("billing_avisos_de_renovacao" as never)
        .update({
          email_resultado: resultado,
          email_enviados: enviados,
          email_falhas: falhas,
          atualizado_em: agora.toISOString(),
        } as never)
        .eq("id", reservaId)
        .eq("email_resultado", "pendente");
      return { error };
    },

    async criarAviso(reservaId, titulo, corpo, severidade) {
      const { data, error } = await admin.rpc("fn_billing_renovacao_criar_aviso" as never, {
        p_reserva: reservaId,
        p_titulo: titulo,
        p_corpo: corpo,
        p_severidade: severidade,
      } as never);
      return { data: typeof data === "string" ? data : null, error };
    },

    async marcarAvisoFalhou(reservaId, agora) {
      const { error } = await admin
        .from("billing_avisos_de_renovacao" as never)
        .update({ aviso_resultado: "falhou", atualizado_em: agora.toISOString() } as never)
        .eq("id", reservaId)
        .eq("aviso_resultado", "pendente");
      return { error };
    },
  };
}

export function servicosDeRenovacaoSobre(admin: SupabaseClient): AvisadorDeRenovacaoServicos {
  const marcas = new Map<string, Promise<MarcaDeSaida>>();
  const marcaDaOrganizacao = (organizationId: string): Promise<MarcaDeSaida> => {
    let marca = marcas.get(organizationId);
    if (!marca) {
      marca = marcaDaSaida(organizationId);
      marcas.set(organizationId, marca);
    }
    return marca;
  };

  return {
    emailConfigurado,

    async destinatarios(organizationId) {
      const { data, error } = await admin
        .from("user_organizations")
        .select("user_id")
        .eq("organization_id", organizationId)
        .eq("role", "admin")
        .is("revoked_at", null)
        .order("created_at", { ascending: true })
        .limit(TETO_DE_DESTINATARIOS);
      if (error) throw new Error(`user_organizations: ${error.message}`);

      const vistos = new Set<string>();
      const lista: DestinatarioDeRenovacao[] = [];
      for (const linha of (data as { user_id: string }[] | null) ?? []) {
        const { data: u } = await admin.auth.admin.getUserById(linha.user_id);
        const email = u?.user?.email?.trim();
        if (!email || vistos.has(email.toLowerCase())) continue;
        vistos.add(email.toLowerCase());
        const locale = (u?.user?.user_metadata as { locale?: unknown } | undefined)?.locale;
        lista.push({ email, locale: typeof locale === "string" ? locale : null });
      }
      return lista;
    },

    async enviarEmail(p: PendenteDeRenovacao, para: DestinatarioDeRenovacao) {
      const marca = await marcaDaOrganizacao(p.organizationId);
      const mensagem = buildRenovacaoDoPlanoEmail({
        planoNome: p.planoNome,
        ultimoDia: p.ultimoDia,
        diasRestantes: p.diasRestantes,
        idioma: idiomaDoDestinatario(para.locale, p.orgLocale),
        assinarUrl: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/app/settings/plano/assinar`,
        marca,
      });
      const r = await sendEmail({
        to: para.email,
        subject: mensagem.subject,
        html: mensagem.html,
        text: mensagem.text,
        fromName: marca.nome,
        tags: [
          { name: "tipo", value: "renovacao_do_plano" },
          { name: "marco", value: String(p.marco) },
        ],
      });
      if (!r.ok && r.error !== "not_configured") {
        // Sem o endereço no log: só a organização e o motivo.
        logger.warn("[avisar-renovacao] e-mail não saiu", {
          organization_id: p.organizationId,
          motivo: r.error,
          via: r.via,
        });
      }
      return { ok: r.ok };
    },
  };
}
