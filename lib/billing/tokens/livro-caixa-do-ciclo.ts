/**
 * O livro-caixa do ciclo atual da carteira de tokens de IA, PARA A ABA DO
 * ADMIN DA PLATAFORMA (fase F2-B, tarefa 7): `billing_token_ledger` com nota
 * e autor, algo que `extrato-do-ciclo.ts` (tarefa 6, tela do CLIENTE) nunca
 * lê, porque a organização não pode ver a nota e o autor de um crédito ou
 * ajuste lançado pela Hiperbold (decisão 19: livro-caixa é "privilégio
 * nenhum para authenticated", só a plataforma pelo servidor).
 *
 * ─── Os quatro tipos, pela CHAVE (decisão 6/7 da fase) ──────────────────────
 *
 * A chave de cada linha já entrega o tipo, sem precisar de coluna nova:
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
 * isso, e só ele, é somado por dia e fonte.
 *
 * ─── Por que a comparação de `created_at` NÃO usa a data crua do ciclo ──────
 *
 * `billing_token_ledger.created_at` é `timestamptz`; `primeiroDiaDoCicloAtual`
 * devolve `"YYYY-MM-01"`. Filtrar `created_at >= "2026-09-01"` faria o
 * Postgres tratar a meia-noite como UTC — três horas ANTES da virada real do
 * ciclo em `America/Sao_Paulo` (UTC-3, fixo desde o fim do horário de verão
 * no Brasil em 2019) — e incluiria as últimas horas da noite de 31/08 em São
 * Paulo como se já fossem de setembro. `inicioDoCicloEmUtc` corrige isso.
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
}

export type ResultadoLivroCaixaDoCiclo =
  | { status: "ok"; livroCaixa: LivroCaixaDoCiclo }
  | { status: "leitura_falhou" };

const esquemaDaLinhaDoLedger = z
  .object({
    fonte: z.enum(FONTES_DA_CARTEIRA),
    tokens: z.coerce.number().int(),
    chave: z.string().min(1),
    nota: z.string().nullable(),
    valor_cents: z.coerce.number().int().nullable(),
    criado_por: z.string().uuid().nullable(),
    created_at: z.string().min(1),
  })
  .strict();

/**
 * O instante UTC real da meia-noite de `America/Sao_Paulo` do primeiro dia do
 * ciclo — ver o comentário do arquivo. Exportada porque `margem.ts` filtra o
 * MESMO livro-caixa pelo mesmo corte (créditos avulsos do ciclo, decisão 17).
 */
export function inicioDoCicloEmUtc(diaCiclo: string): string {
  return `${diaCiclo}T00:00:00-03:00`;
}

function tipoDaChave(chave: string): TipoLinhaLivroCaixa {
  if (chave.startsWith("consumo:")) return "consumo";
  if (chave.startsWith("credito:")) return "credito";
  if (chave.startsWith("ajuste:")) return "ajuste";
  // 'plano:<ciclo>' ou 'adicional:<id>:<ciclo>' (decisão 6/7): a ÚNICA
  // convenção de chave que sobra depois das três acima.
  return "concessao";
}

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
    const ledgerRes = await admin
      .from("billing_token_ledger")
      .select("fonte, tokens, chave, nota, valor_cents, criado_por, created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", inicioDoCicloEmUtc(inicioDoCiclo))
      .order("created_at", { ascending: false });

    if (ledgerRes.error) {
      throw new Error(`ler livro-caixa de tokens: ${ledgerRes.error.message}`);
    }

    const linhasParseadas = z.array(esquemaDaLinhaDoLedger).safeParse(ledgerRes.data);
    if (!linhasParseadas.success) {
      throw new Error(`livro-caixa de tokens fora do esquema: ${linhasParseadas.error.message}`);
    }
    const linhasCruas = linhasParseadas.data;

    // Autores: só os ids que aparecem, resolvidos uma vez cada (não por
    // linha). Falha em resolver UM autor não derruba a leitura (ver
    // comentário do arquivo).
    const idsDeAutor = [...new Set(linhasCruas.map((l) => l.criado_por).filter((id): id is string => id !== null))];
    const autorPorId = new Map<string, { nome: string | null; email: string | null }>();
    await Promise.all(
      idsDeAutor.map(async (id) => {
        try {
          const { data, error } = await admin.auth.admin.getUserById(id);
          if (error || !data?.user) return;
          const meta = (data.user.user_metadata as Record<string, unknown> | null) ?? null;
          const nome = typeof meta?.full_name === "string" ? meta.full_name : null;
          autorPorId.set(id, { nome, email: data.user.email ?? null });
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

    // Consumo agrupado por dia + fonte (ver comentário do arquivo);
    // concessão, crédito e ajuste passam individuais, com a nota e o autor
    // PRÓPRIOS de cada linha.
    const consumoAgrupado = new Map<string, LinhaLivroCaixa>();
    const outrasLinhas: LinhaLivroCaixa[] = [];

    for (const linha of linhasCruas) {
      const tipo = tipoDaChave(linha.chave);
      const dia = diaEmSaoPaulo(linha.created_at);

      if (tipo === "consumo") {
        const chaveDoGrupo = `${dia}:${linha.fonte}`;
        const atual = consumoAgrupado.get(chaveDoGrupo);
        if (atual) {
          atual.tokens += linha.tokens;
          atual.linhas += 1;
        } else {
          consumoAgrupado.set(chaveDoGrupo, {
            dia,
            fonte: linha.fonte,
            tipo,
            tokens: linha.tokens,
            linhas: 1,
            nota: null,
            valorCents: null,
            autorId: null,
            autorNome: null,
            autorEmail: null,
          });
        }
        continue;
      }

      outrasLinhas.push({
        dia,
        fonte: linha.fonte,
        tipo,
        tokens: linha.tokens,
        linhas: 1,
        nota: linha.nota,
        valorCents: linha.valor_cents,
        ...autorDe(linha.criado_por),
      });
    }

    const todasAsLinhas = [...outrasLinhas, ...consumoAgrupado.values()].sort((a, b) =>
      b.dia.localeCompare(a.dia),
    );

    return { status: "ok", livroCaixa: { ciclo: inicioDoCiclo, linhas: todasAsLinhas } };
  } catch (err) {
    log?.error("alarme_planos_leitura", {
      organization_id: organizationId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { status: "leitura_falhou" };
  }
}
