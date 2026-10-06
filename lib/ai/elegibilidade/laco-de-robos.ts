/**
 * Proteção contra dois robôs conversando entre si (D-158).
 *
 * ─── O cenário ──────────────────────────────────────────────────────────────
 *
 * Dois números da mesma instalação com agente, ou o agente e a resposta
 * automática de outra empresa, trocam mensagens sem fim, e cada mensagem
 * recebida gera um turno pago. No canal por QR o teto diário do anti-ban acaba
 * parando; na Cloud API (`banRisk` falso) não há teto nenhum.
 *
 * ─── As duas travas ─────────────────────────────────────────────────────────
 *
 *  - A CAUSA, quando é nossa: o remetente é o número de um canal da instalação
 *    (desta organização ou de outra). Quem escreve é outro agente nosso, e a IA
 *    não responde (`numeroEhDeCanalDaInstalacao`).
 *  - A REDE, para o robô que não é nosso: no máximo N turnos de IA por contato
 *    por hora. A contagem sai de `llm_calls` (um turno = um `job_id` do
 *    propósito `agent_turn`), sem tabela nova. Ao estourar, a IA para NAQUELA
 *    conversa e um aviso abre na Central; o recebimento da mensagem não é
 *    bloqueado, só o turno pago.
 *
 * A decisão em si mora em `gate.ts` (regra pura, a mesma para o drain e para o
 * turno). Aqui só a leitura do banco e o aviso.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

/** Padrão conservador: 20 turnos de IA por contato por hora. */
export const TETO_DE_TURNOS_POR_CONTATO_POR_HORA_PADRAO = 20;

export const JANELA_DO_DISJUNTOR_MS = 60 * 60 * 1000;

/** Título fixo: é ele que deduplica o aviso por conversa enquanto estiver aberto. */
export const TITULO_DO_AVISO_DO_DISJUNTOR =
  "A IA parou de responder esta conversa: turnos demais em uma hora";

/** Só dígitos de cada grafia do número (com e sem o nono dígito brasileiro). */
function digitosDasVariantes(telefone: string | null | undefined): string[] {
  if (!telefone) return [];
  return phoneLookupVariants(telefone).map((v) => v.replace(/\D/g, "")).filter((d) => d.length > 0);
}

/**
 * O telefone é o de algum canal da instalação? Qualquer organização conta, e o
 * próprio canal da conversa também. Canal arquivado não conta: o número deixou
 * de ser um robô nosso.
 *
 * Compara só os dígitos: `channel_sessions.phone_number` guarda `+55...` ou o
 * número cru conforme o provedor que conectou.
 */
export async function numeroEhDeCanalDaInstalacao(
  pool: Pick<pg.Pool, "query">,
  telefone: string | null | undefined,
): Promise<boolean> {
  const digitos = digitosDasVariantes(telefone);
  if (digitos.length === 0) return false;
  const { rows } = await pool.query<{ achou: boolean }>(
    `select exists (
       select 1 from channel_sessions
        where archived_at is null
          and phone_number is not null
          and regexp_replace(phone_number, '\\D', '', 'g') = any($1::text[])
     ) as achou`,
    [digitos],
  );
  return rows[0]?.achou === true;
}

/**
 * Mesma pergunta pelo supabase-js (caminhos de retaguarda sem pool `pg`). O
 * PostgREST não faz a regex, então o casamento é pelas grafias `+dígitos` e
 * `dígitos`, as duas que os conectores gravam.
 */
export async function numeroEhDeCanalDaInstalacaoViaSupabase(
  admin: SupabaseClient,
  telefone: string | null | undefined,
): Promise<boolean> {
  const digitos = digitosDasVariantes(telefone);
  if (digitos.length === 0) return false;
  const grafias = digitos.flatMap((d) => [d, `+${d}`]);
  const { count, error } = await admin
    .from("channel_sessions")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null)
    .in("phone_number", grafias);
  if (error) throw new Error(`elegibilidade: leitura dos canais falhou: ${error.message}`);
  return (count ?? 0) > 0;
}

/**
 * Turnos de IA do contato na janela. Um turno é um `job_id` distinto do
 * propósito `agent_turn` (cada passo do loop de ferramentas é uma linha).
 * Reaproveita o índice `(organization_id, purpose, created_at)`.
 */
export async function contarTurnosDeIaDoContato(
  pool: Pick<pg.Pool, "query">,
  input: { organizationId: string; contactId: string; agora: Date; janelaMs?: number },
): Promise<number> {
  const desde = new Date(input.agora.getTime() - (input.janelaMs ?? JANELA_DO_DISJUNTOR_MS));
  const { rows } = await pool.query<{ n: number }>(
    `select count(distinct job_id)::int as n
       from llm_calls
      where organization_id = $1
        and purpose = 'agent_turn'
        and contact_id = $2
        and job_id is not null
        and created_at > $3`,
    [input.organizationId, input.contactId, desde],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Abre o aviso de que a IA parou numa conversa. Um por conversa enquanto o
 * anterior estiver aberto (dedup por kind, ref e título). Nunca lança: o aviso
 * é informação, a trava já valeu.
 */
export async function avisarDisjuntorDeTurnosAberto(
  pool: Pick<pg.Pool, "query">,
  input: { organizationId: string; conversationId: string; turnos: number; teto: number },
): Promise<void> {
  try {
    await insertInboxItem(
      pool,
      input.organizationId,
      {
        kind: "other",
        severity: "warn",
        title: TITULO_DO_AVISO_DO_DISJUNTOR,
        body:
          `Esta conversa já teve ${input.turnos} respostas da IA na última hora (teto: ${input.teto}). ` +
          "Pode ser outro robô do outro lado, ou uma resposta automática em laço. " +
          "A IA fica calada nesta conversa até a contagem baixar; as mensagens continuam chegando. " +
          "Veja a conversa e assuma, se for uma pessoa.",
        refKind: "conversation",
        refId: input.conversationId,
      },
      "kind_ref_e_titulo",
    );
  } catch {
    // Sem aviso, a IA continua parada: o que importa já aconteceu.
  }
}
