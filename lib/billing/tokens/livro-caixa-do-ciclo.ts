/**
 * O livro-caixa do ciclo atual da carteira de tokens de IA, PARA A ABA DO
 * ADMIN DA PLATAFORMA (fase F2-B, tarefa 7): `billing_token_ledger` com nota
 * e autor, algo que `extrato-do-ciclo.ts` (tarefa 6, tela do CLIENTE) nunca
 * lê, porque a organização não pode ver a nota e o autor de um crédito ou
 * ajuste lançado pela Hiperbold (decisão 19: livro-caixa é "privilégio
 * nenhum para authenticated", só a plataforma pelo servidor).
 *
 * A leitura, o filtro do ciclo, o limite de 500 linhas não-consumo e o
 * agrupamento do consumo por dia/fonte são feitos NO BANCO por
 * `fn_billing_livro_caixa_do_ciclo` (Parte 6, item 1b da revisão de
 * 23/09/2026): a versão anterior deste módulo trazia linha crua e cortava em
 * `max_rows = 1000` do PostgREST antes de somar (mesmo defeito do extrato,
 * `extrato-do-ciclo.ts`), e filtrava `created_at` com um offset `-03:00`
 * FIXO calculado aqui (`inicioDoCicloEmUtc`), que quebraria em qualquer fuso
 * que não seja `America/Sao_Paulo` sem horário de verão. A RPC filtra pelo
 * `ciclo` gravado na linha e, para o que nunca tem `ciclo` (concessão e
 * crédito/ajuste avulso), converte `created_at` com `fn_billing_ciclo_de` NO
 * PRÓPRIO POSTGRES.
 *
 * ─── Os quatro tipos, pela CHAVE (decisão 6/7 da fase) ──────────────────────
 *
 * A RPC já resolve o tipo pela chave, sem precisar de coluna nova:
 * `plano:<ciclo>` e `adicional:<id>:<ciclo>` são CONCESSÃO (a fonte "plano" e
 * "adicional" já aparecem na chave, mas como PREFIXO fixo da convenção, nunca
 * confundido com a coluna `fonte`); `consumo:<llm_call_id>:<fonte>` é
 * CONSUMO; `credito:<uuid>` é CRÉDITO; `ajuste:<uuid>` é AJUSTE.
 *
 * ─── Por que só o CONSUMO é agrupado por dia ─────────────────────────────────
 *
 * Concessão, crédito e ajuste são eventos raros (um por ciclo, um por
 * contratação, um por decisão do admin) e cada um carrega nota e autor
 * PRÓPRIOS: agrupar destruiria exatamente a informação que esta leitura
 * existe para mostrar. Consumo é uma linha por chamada de IA por fonte (não
 * tem nota nem autor, decisão 7) e pode chegar a milhares por ciclo — por
 * isso, e só ele, a RPC devolve já somado por dia e fonte
 * (`consumo_por_dia_fonte`).
 *
 * ─── `id` de cada linha (item 9 da revisão, para o campo "compensa" do ajuste) ──
 *
 * As linhas NÃO-consumo (concessão, crédito, ajuste) trazem o `id` da própria
 * linha do livro-caixa: é o que a aba do admin mostra (curto, copiável) para
 * preencher `compensaId` de `fn_billing_ajustar_tokens`. Consumo continua sem
 * `id` (`null`): não é uma linha, é um RESUMO de várias, e não faz sentido
 * como alvo de compensação de um ajuste único.
 *
 * ─── Autor: enriquecimento, não dado essencial ───────────────────────────────
 *
 * `criado_por` (sem FK, decisão 7) é resolvido pela Auth Admin API
 * (`admin.auth.admin.getUserById`, mesmo caminho de
 * `app/api/v1/admin/platform-admins/route.ts`, que não fala com `auth` via
 * PostgREST porque o schema não é exposto). Uma falha em resolver UM autor
 * não derruba a leitura inteira (o livro-caixa continua correto, só o nome
 * daquela linha fica em branco); só falha de leitura do PRÓPRIO livro-caixa
 * vira `leitura_falhou`.
 *
 * Nunca lança, mesma regra das irmãs desta pasta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { primeiroDiaDoCicloAtual } from "./extrato-do-ciclo";
import { FONTES_DA_CARTEIRA, type FonteCarteira } from "./saldo-da-organizacao";

export type TipoLinhaLivroCaixa = "concessao" | "credito" | "consumo" | "ajuste";

export interface LinhaLivroCaixa {
  /**
   * `id` da linha do livro-caixa (item 9 da revisão): `null` só em CONSUMO,
   * que aqui é um RESUMO agrupado por dia/fonte (ver comentário do arquivo),
   * não uma linha só. É o que a aba do admin mostra para preencher o
   * "compensa" de um ajuste.
   */
  id: string | null;
  /** `YYYY-MM-DD`, fuso `America/Sao_Paulo`. */
  dia: string;
  fonte: FonteCarteira;
  tipo: TipoLinhaLivroCaixa;
  /** Soma dos tokens ponderados das linhas resumidas aqui (negativo em consumo). */
  tokens: number;
  /** Quantas linhas do livro-caixa este item resume: sempre 1, exceto consumo (por dia + fonte). */
  linhas: number;
  /** `null` em concessão e consumo (nunca têm nota, decisão 6/7). */
  nota: string | null;
  /** `valor_cents` da linha, quando houver (crédito). `null` em concessão, consumo e ajuste. */
  valorCents: number | null;
  autorId: string | null;
  /** `raw_user_meta_data.full_name`, quando o Auth tiver. */
  autorNome: string | null;
  autorEmail: string | null;
}

export interface LivroCaixaDoCiclo {
  ciclo: string;
  /** Mais recente primeiro. */
  linhas: LinhaLivroCaixa[];
  /** Item 1b da revisão: true quando havia mais de 500 linhas não-consumo no ciclo (o corte da RPC). */
  truncado: boolean;
}

export type ResultadoLivroCaixaDoCiclo =
  | { status: "ok"; livroCaixa: LivroCaixaDoCiclo }
  | { status: "leitura_falhou" };

/** Uma linha NÃO-consumo (concessão, crédito, ajuste), já com `tipo` resolvido pela RPC. */
const esquemaDaLinhaNaoConsumo = z
  .object({
    id: z.string().uuid(),
    created_at: z.string().min(1),
    fonte: z.enum(FONTES_DA_CARTEIRA),
    tipo: z.enum(["concessao", "credito", "ajuste"]),
    tokens: z.coerce.number().int(),
    valor_cents: z.coerce.number().int().nullable(),
    nota: z.string().nullable(),
    criado_por: z.string().uuid().nullable(),
    compensa_id: z.string().uuid().nullable(),
  })
  .strict();

const esquemaDoConsumoPorDiaFonte = z
  .object({
    dia: z.string().min(1),
    fonte: z.enum(FONTES_DA_CARTEIRA),
    tokens: z.coerce.number().int(),
    chamadas: z.coerce.number().int(),
  })
  .strict();

/** O formato exato de `fn_billing_livro_caixa_do_ciclo` (Parte 6, item 1b da revisão). */
const esquemaDoLivroCaixaRpc = z
  .object({
    linhas: z.array(esquemaDaLinhaNaoConsumo),
    consumo_por_dia_fonte: z.array(esquemaDoConsumoPorDiaFonte),
    truncado: z.boolean(),
  })
  .strict();

function diaEmSaoPaulo(createdAt: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(createdAt));
}

/** O livro-caixa do ciclo (por padrão, o atual) da organização. Nunca lança. */
export async function livroCaixaDoCiclo(
  admin: SupabaseClient,
  organizationId: string,
  ciclo?: string,
  log?: Logger,
): Promise<ResultadoLivroCaixaDoCiclo> {
  const inicioDoCiclo = ciclo ?? primeiroDiaDoCicloAtual();

  try {
    const { data, error } = await admin.rpc("fn_billing_livro_caixa_do_ciclo", {
      p_org: organizationId,
      p_ciclo: inicioDoCiclo,
    });

    if (error) {
      throw new Error(`ler livro-caixa de tokens: ${error.message}`);
    }

    const parsed = esquemaDoLivroCaixaRpc.safeParse(data);
    if (!parsed.success) {
      throw new Error(`livro-caixa de tokens fora do esquema: ${parsed.error.message}`);
    }
    const { linhas: linhasCruas, consumo_por_dia_fonte: consumoCru, truncado } = parsed.data;

    // Autores: só os ids que aparecem, resolvidos uma vez cada (não por
    // linha). Falha em resolver UM autor não derruba a leitura (ver
    // comentário do arquivo).
    const idsDeAutor = [...new Set(linhasCruas.map((l) => l.criado_por).filter((id): id is string => id !== null))];
    const autorPorId = new Map<string, { nome: string | null; email: string | null }>();
    await Promise.all(
      idsDeAutor.map(async (id) => {
        try {
          const { data: dadoDoAutor, error: erroDoAutor } = await admin.auth.admin.getUserById(id);
          if (erroDoAutor || !dadoDoAutor?.user) return;
          const meta = (dadoDoAutor.user.user_metadata as Record<string, unknown> | null) ?? null;
          const nome = typeof meta?.full_name === "string" ? meta.full_name : null;
          autorPorId.set(id, { nome, email: dadoDoAutor.user.email ?? null });
        } catch (err) {
          log?.warn("alarme_planos_leitura", {
            organization_id: organizationId,
            etapa: "resolver_autor_do_livro_caixa",
            error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          });
        }
      }),
    );

    function autorDe(criadoPor: string | null) {
      if (criadoPor === null) return { autorId: null, autorNome: null, autorEmail: null };
      const autor = autorPorId.get(criadoPor);
      return { autorId: criadoPor, autorNome: autor?.nome ?? null, autorEmail: autor?.email ?? null };
    }

    // Concessão, crédito e ajuste: individuais, com `id`, nota e autor
    // PRÓPRIOS de cada linha (a RPC já resolveu o `tipo` pela chave).
    const outrasLinhas: LinhaLivroCaixa[] = linhasCruas.map((linha) => ({
      id: linha.id,
      dia: diaEmSaoPaulo(linha.created_at),
      fonte: linha.fonte,
      tipo: linha.tipo,
      tokens: linha.tokens,
      linhas: 1,
      nota: linha.nota,
      valorCents: linha.valor_cents,
      ...autorDe(linha.criado_por),
    }));

    // Consumo: a RPC já devolve agrupado por dia e fonte (ver comentário do
    // arquivo); `id` fica `null` porque cada item aqui resume várias linhas.
    const linhasDeConsumo: LinhaLivroCaixa[] = consumoCru.map((c) => ({
      id: null,
      dia: c.dia,
      fonte: c.fonte,
      tipo: "consumo",
      tokens: c.tokens,
      linhas: c.chamadas,
      nota: null,
      valorCents: null,
      autorId: null,
      autorNome: null,
      autorEmail: null,
    }));

    const todasAsLinhas = [...outrasLinhas, ...linhasDeConsumo].sort((a, b) => b.dia.localeCompare(a.dia));

    return { status: "ok", livroCaixa: { ciclo: inicioDoCiclo, linhas: todasAsLinhas, truncado } };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { status: "leitura_falhou" };
  }
}
