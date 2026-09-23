/**
 * O extrato do ciclo atual da carteira de tokens de IA (fase F2-B, tarefa 5):
 * `billing_token_consumo_diario` agrupado por dia e por agente.
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
 * Cliente de SERVIÇO (`fn_billing_saldo_da_carteira`/agregado têm `execute`/
 * `select` fora do alcance de `authenticated` direto pela RLS da tela, mas a
 * leitura do servidor aqui usa o mesmo client admin das irmãs de
 * `lib/billing/planos/`), que ignora RLS: TODA consulta filtra
 * `organization_id` à mão, inclusive a segunda (nomes dos agentes): sem
 * isso um `agent_id` de outra organização vazaria o nome de um agente alheio.
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

const esquemaDaLinha = z
  .object({
    dia: z.string().min(1),
    agent_id: z.string().uuid().nullable(),
    tokens_ponderados: z.coerce.number().int(),
    chamadas: z.coerce.number().int(),
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
    const consumoRes = await admin
      .from("billing_token_consumo_diario")
      .select("dia, agent_id, tokens_ponderados, chamadas")
      .eq("organization_id", organizationId)
      .gte("dia", inicioDoCiclo)
      .order("dia", { ascending: true });

    if (consumoRes.error) {
      throw new Error(`ler extrato de tokens: ${consumoRes.error.message}`);
    }

    const linhasParseadas = z.array(esquemaDaLinha).safeParse(consumoRes.data);
    if (!linhasParseadas.success) {
      throw new Error(`extrato de tokens fora do esquema: ${linhasParseadas.error.message}`);
    }
    const linhas = linhasParseadas.data;

    // Nomes dos agentes: só os que aparecem no extrato, e só da MESMA
    // organização (decisão 19/isolamento): um agent_id de outra organização
    // (o que não deveria acontecer, mas o cliente de serviço não filtra
    // sozinho) não resolveria nome nenhum e cairia em "agente_removido".
    const idsDeAgente = [...new Set(linhas.map((l) => l.agent_id).filter((id): id is string => id !== null))];
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

    // Por dia: soma através de agente/contato/propósito (a chave única do
    // agregado, decisão 13), mantendo a ordem ascendente que a consulta já
    // devolveu (linhas do mesmo dia ficam contíguas).
    const porDiaMapa = new Map<string, { tokensPonderados: number; chamadas: number }>();
    for (const linha of linhas) {
      const atual = porDiaMapa.get(linha.dia) ?? { tokensPonderados: 0, chamadas: 0 };
      atual.tokensPonderados += linha.tokens_ponderados;
      atual.chamadas += linha.chamadas;
      porDiaMapa.set(linha.dia, atual);
    }
    const porDia: LinhaExtratoPorDia[] = [...porDiaMapa.entries()].map(([dia, v]) => ({ dia, ...v }));

    // Por agente: soma através de dia/contato/propósito. Chave "" agrupa as
    // linhas sem agent_id (conferências internas, embedding, visão).
    const SEM_AGENTE = "";
    const porAgenteMapa = new Map<string, { tokensPonderados: number; chamadas: number }>();
    for (const linha of linhas) {
      const chave = linha.agent_id ?? SEM_AGENTE;
      const atual = porAgenteMapa.get(chave) ?? { tokensPonderados: 0, chamadas: 0 };
      atual.tokensPonderados += linha.tokens_ponderados;
      atual.chamadas += linha.chamadas;
      porAgenteMapa.set(chave, atual);
    }
    const porAgente: LinhaExtratoPorAgente[] = [...porAgenteMapa.entries()]
      .map(([chave, v]): LinhaExtratoPorAgente => {
        if (chave === SEM_AGENTE) {
          return { agentId: null, tipo: "sem_agente", nome: null, ...v };
        }
        const nome = nomePorAgente.get(chave);
        return nome !== undefined
          ? { agentId: chave, tipo: "agente", nome, ...v }
          : { agentId: chave, tipo: "agente_removido", nome: null, ...v };
      })
      .sort((a, b) => b.tokensPonderados - a.tokensPonderados);

    return { status: "ok", extrato: { ciclo: inicioDoCiclo, porDia, porAgente } };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { status: "leitura_falhou" };
  }
}
