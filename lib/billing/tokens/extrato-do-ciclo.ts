/**
 * O extrato do ciclo atual da carteira de tokens de IA (fase F2-B, tarefa 5),
 * agregado NO BANCO por `fn_billing_extrato_do_ciclo` (Parte 6, item 1a da
 * revisão de 23/09/2026).
 *
 * ─── Por que a agregação foi para o banco (item 1 ALTO da revisão) ──────────
 *
 * Este módulo trazia linha CRUA de `billing_token_consumo_diario` e somava no
 * Node. O PostgREST corta em `max_rows = 1000` (`supabase/config.toml`, igual
 * ao Supabase Cloud): organização com mais de mil linhas de agregado diário
 * no ciclo tinha o total do extrato menor que o real, sem erro nenhum
 * avisando. `fn_billing_extrato_do_ciclo` faz `group by` e `sum` dentro do
 * Postgres e devolve só o jsonb já somado: nenhum corte de página entra na
 * conta.
 *
 * ─── Por que não bakear o texto do agrupamento aqui ──────────────────────────
 *
 * O agrupamento por agente tem três casos (decisão 13 da fase): linha com
 * `agent_id` que resolve num agente ATIVO da mesma organização, linha com
 * `agent_id` que não resolve mais (o agente foi apagado, e `ai_agents` não tem
 * FK em cascata de propósito) e linha SEM `agent_id` (conferência interna,
 * embedding, visão). Este módulo devolve os três como um discriminador
 * (`tipo`), não como a frase pronta "Agente removido" / "Conferências e
 * mídia": quem traduz é a tela (tarefa 6, `lib/billing/tokens/linhas-da-
 * tela.ts`), pelo dicionário: texto fixo aqui vazaria português para quem
 * escolheu espanhol sem passar pelo `t()`.
 *
 * ─── Isolamento ───────────────────────────────────────────────────────────
 *
 * A RPC é `security definer`, `execute` só de `service_role` (fora do alcance
 * de `authenticated` e de `agent_worker`) e recebe `p_org` explícito: mesmo
 * assim, a segunda consulta (nomes dos agentes) continua filtrando
 * `organization_id` à mão, porque o cliente de serviço usado aqui ignora RLS
 * por desenho. Sem o filtro, um `agent_id` de outra organização vazaria o
 * nome de um agente alheio.
 *
 * Nunca lança, mesma regra das irmãs desta pasta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

export type TipoDeAgrupamentoPorAgente = "agente" | "agente_removido" | "sem_agente";

export interface LinhaExtratoPorDia {
  dia: string;
  tokensPonderados: number;
  chamadas: number;
}

export interface LinhaExtratoPorAgente {
  /** `null` só quando `tipo === "sem_agente"`. */
  agentId: string | null;
  tipo: TipoDeAgrupamentoPorAgente;
  /** O nome de `ai_agents`, só quando `tipo === "agente"`. */
  nome: string | null;
  tokensPonderados: number;
  chamadas: number;
}

export interface ExtratoDoCiclo {
  ciclo: string;
  porDia: LinhaExtratoPorDia[];
  porAgente: LinhaExtratoPorAgente[];
}

export type ResultadoExtratoDoCiclo =
  | { status: "ok"; extrato: ExtratoDoCiclo }
  | { status: "leitura_falhou" };

const esquemaDaLinhaPorDia = z
  .object({
    dia: z.string().min(1),
    tokens_ponderados: z.coerce.number().int(),
    chamadas: z.coerce.number().int(),
  })
  .strict();

const esquemaDaLinhaPorAgente = z
  .object({
    agent_id: z.string().uuid().nullable(),
    tokens_ponderados: z.coerce.number().int(),
    chamadas: z.coerce.number().int(),
  })
  .strict();

/** O formato exato de `fn_billing_extrato_do_ciclo` (Parte 6, item 1a da revisão). */
const esquemaDoExtratoRpc = z
  .object({
    por_dia: z.array(esquemaDaLinhaPorDia),
    por_agente: z.array(esquemaDaLinhaPorAgente),
  })
  .strict();

const esquemaDoAgente = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .strict();

/**
 * Primeiro dia do mês civil no fuso `America/Sao_Paulo`, formato `YYYY-MM-DD`
 * (o mesmo cálculo de `fn_billing_ciclo_de`, migração 0906, decisão 4), do
 * lado do servidor Node, para quando quem chama não tem o ciclo já lido do
 * saldo (`fn_billing_saldo_da_carteira` também o devolve, e é a fonte
 * preferida: reaproveitá-la evita os dois lados divergirem por um segundo de
 * corrida na virada do mês).
 */
export function primeiroDiaDoCicloAtual(agora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(agora);
  const ano = partes.find((p) => p.type === "year")?.value;
  const mes = partes.find((p) => p.type === "month")?.value;
  if (!ano || !mes) {
    throw new Error("não foi possível calcular o primeiro dia do ciclo atual");
  }
  return `${ano}-${mes}-01`;
}

/**
 * O extrato do ciclo (por padrão, o atual) da organização. `ciclo`, quando
 * informado, é o `YYYY-MM-DD` já lido de `saldoDaOrganizacao`; sem ele, este
 * módulo calcula o primeiro dia do mês corrente no fuso `America/Sao_Paulo`.
 * Nunca lança.
 */
export async function extratoDoCiclo(
  admin: SupabaseClient,
  organizationId: string,
  ciclo?: string,
  log?: Logger,
): Promise<ResultadoExtratoDoCiclo> {
  const inicioDoCiclo = ciclo ?? primeiroDiaDoCicloAtual();

  try {
    const extratoRes = await admin.rpc("fn_billing_extrato_do_ciclo", {
      p_org: organizationId,
      p_ciclo: inicioDoCiclo,
    });

    if (extratoRes.error) {
      throw new Error(`ler extrato de tokens: ${extratoRes.error.message}`);
    }

    const extratoParseado = esquemaDoExtratoRpc.safeParse(extratoRes.data);
    if (!extratoParseado.success) {
      throw new Error(`extrato de tokens fora do esquema: ${extratoParseado.error.message}`);
    }
    const { por_dia: porDiaCru, por_agente: porAgenteCru } = extratoParseado.data;

    // Nomes dos agentes: só os que aparecem no extrato, e só da MESMA
    // organização (decisão 19/isolamento): um agent_id de outra organização
    // (o que não deveria acontecer, mas o cliente de serviço não filtra
    // sozinho) não resolveria nome nenhum e cairia em "agente_removido".
    const idsDeAgente = [
      ...new Set(porAgenteCru.map((l) => l.agent_id).filter((id): id is string => id !== null)),
    ];
    const nomePorAgente = new Map<string, string>();
    if (idsDeAgente.length > 0) {
      const agentesRes = await admin
        .from("ai_agents")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("id", idsDeAgente);

      if (agentesRes.error) {
        throw new Error(`ler agentes do extrato de tokens: ${agentesRes.error.message}`);
      }

      const agentesParseados = z.array(esquemaDoAgente).safeParse(agentesRes.data);
      if (!agentesParseados.success) {
        throw new Error(`agentes do extrato de tokens fora do esquema: ${agentesParseados.error.message}`);
      }
      for (const agente of agentesParseados.data) nomePorAgente.set(agente.id, agente.name);
    }

    // `por_dia` já vem somado e ordenado (ascendente) pela RPC: só remonta a
    // forma que a tela espera.
    const porDia: LinhaExtratoPorDia[] = porDiaCru.map((l) => ({
      dia: l.dia,
      tokensPonderados: l.tokens_ponderados,
      chamadas: l.chamadas,
    }));

    // `por_agente` já vem somado e ordenado (maior consumo primeiro) pela
    // RPC: só falta o discriminador de três casos (decisão 13) e o nome, que
    // são responsabilidade deste módulo, não do banco.
    const porAgente: LinhaExtratoPorAgente[] = porAgenteCru.map((l): LinhaExtratoPorAgente => {
      if (l.agent_id === null) {
        return { agentId: null, tipo: "sem_agente", nome: null, tokensPonderados: l.tokens_ponderados, chamadas: l.chamadas };
      }
      const nome = nomePorAgente.get(l.agent_id);
      return nome !== undefined
        ? { agentId: l.agent_id, tipo: "agente", nome, tokensPonderados: l.tokens_ponderados, chamadas: l.chamadas }
        : { agentId: l.agent_id, tipo: "agente_removido", nome: null, tokensPonderados: l.tokens_ponderados, chamadas: l.chamadas };
    });

    return { status: "ok", extrato: { ciclo: inicioDoCiclo, porDia, porAgente } };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { status: "leitura_falhou" };
  }
}
