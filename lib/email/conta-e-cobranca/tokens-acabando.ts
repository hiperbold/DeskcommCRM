/**
 * IA-02, tokens de IA acabando: o e-mail aos admins quando a organização cruza 80% e quando chega a 100% dos
 * tokens do mês.
 *
 * ─── De onde vem o cruzamento (sem custo no caminho quente) ─────────────────
 *
 * Quem DETECTA o cruzamento já existe e já roda no débito de cada chamada: `fn_billing_avisar_carteira`
 * (migration 0906, parte 3). Ela compara o consumido do ciclo com o total disponível (plano + adicional +
 * avulso na proporção do mês), grava uma linha em `billing_token_avisos_emitidos` com a chave
 * `limiar:<ciclo>:<50|80|100>` (insert on conflict do nothing, uma por limiar por ciclo) e abre o aviso na
 * Central. Aqui não se compara nada de novo e o caminho de cada mensagem não ganha consulta nenhuma: um job
 * leve LÊ essas linhas (só as dos últimos 2 dias, no ciclo atual) e manda o e-mail. Trigger de banco nunca
 * faz HTTP (regra do repo), por isso o e-mail não sai de dentro dela.
 *
 * O ciclo é o mês civil de São Paulo (`fn_billing_ciclo_de`); a franquia volta a valer no dia 1 do mês seguinte,
 * que é a data de renovação do e-mail. Linha de ciclo anterior nunca avisa (um débito atrasado já não gera
 * linha de limiar, e o filtro cobre o resto).
 *
 * ─── Regras ─────────────────────────────────────────────────────────────────
 *
 * - Chave do e-mail: `tokens:<organização>:<ciclo>:<80|100>`, um por nível por ciclo (a unicidade de
 *   `billing_emails_enviados` segura repetição; a leitura de quem já recebeu vem ANTES de calcular o saldo, para
 *   o job de 15 em 15 minutos não refazer a conta de quem já foi avisado).
 * - Se as linhas de 80 e de 100 aparecem juntas (o salto passou dos dois limiares num débito só, ou o job ficou
 *   parado), só o 100 sai: dizer "está acabando" de quem já acabou seria ruído.
 * - Só ENFILEIRA (`fila.ts`): o cron `enviar-emails-de-conta` envia, com nova tentativa se o servidor falhar. O
 *   que o e-mail diz é capturado AQUI, no momento em que a rodada enfileira: o limiar que cruzou (80 ou 100, é
 *   ele que o texto e a barra mostram), `saldoDaOrganizacao` (usado e total do ciclo) e o modo do sistema.
 *   Organização sem limite ou com a leitura falhando não enfileira nada agora (a leitura falha vira log; a
 *   próxima rodada tenta de novo dentro da janela).
 * - Destinatários: admins da organização, resolvidos no envio. Sem cópia ao operador.
 * - O texto acompanha o MODO do sistema (`billing_settings.modo`, lido uma vez por rodada): só com `bloquear`
 *   (e a chave de emergência `PLANOS_BLOQUEIO`, de `lib/env`, fora de `off` e de `avisar`) o e-mail diz que a IA parou; com o
 *   sistema só avisando ele pede o pacote extra sem afirmar parada nenhuma. Leitura do modo falhando cai em
 *   `avisar` (nunca afirmar uma parada que pode não existir).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizarModoDeBilling } from "@/lib/agent-engine/edge/llm/carteira";
import { normalizarChaveDeOrcamento } from "@/lib/agent-engine/edge/llm/orcamento";
import { modoDeBillingCacheado } from "@/lib/billing/planos/modo-cacheado";
import { saldoDaOrganizacao } from "@/lib/billing/tokens/saldo-da-organizacao";
import type { ModoDaFranquiaDeTokens } from "@/lib/email/templates/tokens-de-ia-acabando";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { enfileirarEmailDeConta, type Enfileirador } from "./fila";

const MS_POR_DIA = 24 * 60 * 60 * 1000;
/** Quanto tempo uma linha de limiar continua pedindo e-mail. Depois disso o aviso perdeu o sentido. */
const JANELA_EM_DIAS = 2;
const TAMANHO_DO_LOTE = 500;
/** Páginas de leitura por rodada: linhas já avisadas não podem esconder as novas atrás de um lote cheio. */
const MAXIMO_DE_PAGINAS = 10;
const FUSO = "America/Sao_Paulo";
const CHAVE_DO_LIMIAR = /^limiar:(\d{4}-\d{2}-\d{2}):(80|100)$/;

export interface LimiarCruzado {
  organization_id: string;
  chave: string;
}

export interface DepsDosTokensAcabando {
  /** Injetável nos testes. O padrão é o enfileiramento real. */
  enfileirar?: Enfileirador;
  agora?: () => Date;
  /** Injetável nos testes. O padrão é a consulta real ao banco. `ciclo` é `AAAA-MM-01`. */
  listar?: (admin: SupabaseClient, desde: Date, ciclo: string) => Promise<LimiarCruzado[]>;
  /** Injetável nos testes. O padrão lê `billing_settings.modo` (e a chave `PLANOS_BLOQUEIO` do `lib/env`). */
  modo?: (admin: SupabaseClient) => Promise<ModoDaFranquiaDeTokens>;
}

export interface ResumoDosTokensAcabando {
  /** Limiares de 80/100 lidos na janela. */
  lidos: number;
  /** Fora do ciclo atual, ou substituídos por um 100 da mesma organização. */
  descartados: number;
  /** A chave já estava na fila (ou já saiu): nada novo. */
  jaAvisados: number;
  /** Avisos que entraram na fila agora. */
  enfileirados: number;
  /** Sem dado para o e-mail agora (sem limite, ou leitura do saldo falhou). Tenta de novo na próxima rodada. */
  semSaldo: number;
  falhas: number;
}

/**
 * Só os limiares de 80 e de 100 do ciclo atual (o 50 também é gravado pelo banco e não manda e-mail), das mais
 * novas para as mais antigas e em páginas: um lote cheio de linhas já avisadas não esconde as novas.
 */
async function listarLimiares(admin: SupabaseClient, desde: Date, ciclo: string): Promise<LimiarCruzado[]> {
  const todas: LimiarCruzado[] = [];
  for (let pagina = 0; pagina < MAXIMO_DE_PAGINAS; pagina++) {
    const de = pagina * TAMANHO_DO_LOTE;
    const { data, error } = await admin
      .from("billing_token_avisos_emitidos" as never)
      .select("organization_id, chave")
      .in("chave", [`limiar:${ciclo}:80`, `limiar:${ciclo}:100`])
      .gte("created_at", desde.toISOString())
      .order("created_at", { ascending: false })
      .range(de, de + TAMANHO_DO_LOTE - 1);
    if (error) throw new Error(`billing_token_avisos_emitidos: ${(error as { message: string }).message}`);
    const lote = (data as LimiarCruzado[] | null) ?? [];
    todas.push(...lote);
    if (lote.length < TAMANHO_DO_LOTE) break;
  }
  return todas;
}

/**
 * O modo do sistema para o texto do e-mail: `bloquear` só quando a IA realmente para ao esgotar a franquia
 * (`billing_settings.modo = 'bloquear'` e `PLANOS_BLOQUEIO` ligada; a chave em `avisar` ou `off` rebaixa). Qualquer
 * falha de leitura vira `avisar`: o e-mail não afirma uma parada que pode não existir.
 */
async function lerModoDaFranquia(admin: SupabaseClient): Promise<ModoDaFranquiaDeTokens> {
  try {
    const { modo, error } = await modoDeBillingCacheado(admin);
    if (error) return "avisar";
    const chave = normalizarChaveDeOrcamento(env.PLANOS_BLOQUEIO);
    return normalizarModoDeBilling(modo) === "bloquear" && chave === "on" ? "bloquear" : "avisar";
  } catch {
    return "avisar";
  }
}

/** O primeiro dia do mês civil de São Paulo, `AAAA-MM-01`: o ciclo (`fn_billing_ciclo_de`). */
export function cicloAtual(agora: Date): string {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit" }).formatToParts(
    agora,
  );
  const ano = partes.find((p) => p.type === "year")?.value;
  const mes = partes.find((p) => p.type === "month")?.value;
  if (!ano || !mes) throw new Error("não foi possível calcular o ciclo atual");
  return `${ano}-${mes}-01`;
}

/** O dia 1 do mês seguinte ao ciclo `AAAA-MM-01`: quando a franquia volta. */
export function proximoCiclo(ciclo: string): string {
  const [ano, mes] = ciclo.split("-").map(Number);
  const seguinte = new Date(Date.UTC(ano!, mes!, 1));
  const m = String(seguinte.getUTCMonth() + 1).padStart(2, "0");
  return `${seguinte.getUTCFullYear()}-${m}-01`;
}

export async function avisarTokensAcabando(
  admin: SupabaseClient,
  deps: DepsDosTokensAcabando = {},
): Promise<ResumoDosTokensAcabando> {
  const enfileirar = deps.enfileirar ?? ((entrada) => enfileirarEmailDeConta(entrada, admin));
  const agora = (deps.agora ?? (() => new Date()))();
  const listar = deps.listar ?? listarLimiares;
  const resumo: ResumoDosTokensAcabando = {
    lidos: 0,
    descartados: 0,
    jaAvisados: 0,
    enfileirados: 0,
    semSaldo: 0,
    falhas: 0,
  };

  const ciclo = cicloAtual(agora);
  const linhas = await listar(admin, new Date(agora.getTime() - JANELA_EM_DIAS * MS_POR_DIA), ciclo);
  resumo.lidos = linhas.length;
  if (linhas.length >= TAMANHO_DO_LOTE * MAXIMO_DE_PAGINAS) {
    logger.warn("[tokens-acabando] leitura no teto de páginas, o resto fica para a próxima rodada", {
      limite: TAMANHO_DO_LOTE * MAXIMO_DE_PAGINAS,
    });
  }

  // Por organização, o nível que vale: o 100 quando ele aparece (com ou sem o 80 junto), senão o 80.
  const nivelPorOrganizacao = new Map<string, 80 | 100>();
  for (const linha of linhas) {
    const achou = CHAVE_DO_LIMIAR.exec(linha.chave);
    if (!achou || achou[1] !== ciclo) continue;
    const nivel = Number(achou[2]) as 80 | 100;
    if (nivelPorOrganizacao.get(linha.organization_id) !== 100) nivelPorOrganizacao.set(linha.organization_id, nivel);
  }
  resumo.descartados = linhas.length - nivelPorOrganizacao.size;
  // O modo é lido uma vez por rodada, e só quando há alguém a avisar.
  const modoDaFranquia = nivelPorOrganizacao.size > 0 ? await (deps.modo ?? lerModoDaFranquia)(admin) : "avisar";

  for (const [organizationId, nivel] of nivelPorOrganizacao) {
    try {
      const chave = `tokens:${organizationId}:${ciclo}:${nivel}`;

      // Quem já recebeu não refaz a conta do saldo a cada rodada de 15 minutos.
      const { data: reservado, error: erroReserva } = await admin
        .from("billing_emails_enviados" as never)
        .select("id")
        .eq("organization_id", organizationId)
        .eq("email_id", "IA-02")
        .eq("chave", chave)
        .maybeSingle();
      if (erroReserva) throw new Error(`billing_emails_enviados: ${(erroReserva as { message: string }).message}`);
      if (reservado) {
        resumo.jaAvisados++;
        continue;
      }

      const saldo = await saldoDaOrganizacao(admin, organizationId, logger);
      if (saldo.status !== "ok") {
        resumo.semSaldo++;
        continue;
      }

      const r = await enfileirar({
        organizationId,
        emailId: "IA-02",
        chave,
        destino: "admins",
        copiaParaOperador: false,
        // O limiar vem da linha que o banco gravou ao cruzar; usados e total, de agora (a leitura do saldo).
        dados: {
          nivel,
          modo: modoDaFranquia,
          usados: saldo.totalConsumido,
          total: saldo.totalDisponivel,
          renovaEm: proximoCiclo(ciclo),
        },
      });

      if (r === "enfileirado") resumo.enfileirados++;
      else if (r === "ja_existia") resumo.jaAvisados++;
      else resumo.falhas++;
    } catch (erro) {
      resumo.falhas++;
      logger.warn("[tokens-acabando] organização falhou, rodada segue", {
        organization_id: organizationId,
        motivo: erro instanceof Error ? erro.message.slice(0, 120) : "erro",
      });
    }
  }

  return resumo;
}
