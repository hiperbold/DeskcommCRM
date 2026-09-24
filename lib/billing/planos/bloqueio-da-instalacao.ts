/**
 * O painel de bloqueio dos planos na tela da instalação (fase F3, tarefa 10,
 * decisão 11 do plano `hiperbold/planos/fase-F3-tarefas.md`).
 *
 * ─── O que esta leitura mostra, e por quê ───────────────────────────────────
 *
 * `billing_settings.modo` e `carencia_dias` são a fonte de verdade que
 * `fn_billing_bloqueia` (migration 0907) lê antes de qualquer trava no banco.
 * `organizacoesSemCarencia` é o número que a tela usa na CONFIRMAÇÃO de ligar
 * o bloqueio (decisão 11: "dizendo quantas organizações vão receber carência
 * e a data"): é exatamente o conjunto que `fn_billing_definir_modo` percorre
 * ao entrar em `bloquear` (toda organização com `bloqueio_a_partir_de` nulo).
 * `organizacoesEmCarencia`/`organizacoesComCarenciaVencida` são o estado
 * ATUAL, para o admin ver o tamanho do problema antes de mexer em qualquer
 * coisa.
 *
 * ─── Nunca lança ────────────────────────────────────────────────────────────
 *
 * Mesma doutrina de `carregarComportamentoDaInstalacao`/`modulosLigados`:
 * quem chama está no caminho de renderizar a tela. Falha de leitura degrada
 * para o padrão mais conservador (modo `avisar`, sem contagem) e carimba
 * `leituraFalhou: true`: a tela avisa que os números podem não bater, mas
 * nunca finge saber um valor que não leu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export const MODOS_DE_BLOQUEIO = ["desligado", "avisar", "bloquear"] as const;
export type ModoDeBloqueio = (typeof MODOS_DE_BLOQUEIO)[number];

export interface BloqueioDosPlanos {
  modo: ModoDeBloqueio;
  carenciaDias: number;
  /** `bloqueio_a_partir_de` preenchido, vencido ou não. */
  organizacoesEmCarencia: number;
  /** `bloqueio_a_partir_de` preenchido e já no passado. */
  organizacoesComCarenciaVencida: number;
  /** `bloqueio_a_partir_de` nulo hoje: quem ganharia carência agora se o modo virasse `bloquear`. */
  organizacoesSemCarencia: number;
  leituraFalhou: boolean;
}

function ehModoValido(valor: string | null | undefined): valor is ModoDeBloqueio {
  return valor === "desligado" || valor === "avisar" || valor === "bloquear";
}

const PADRAO_EM_FALHA: Omit<BloqueioDosPlanos, "leituraFalhou"> = {
  modo: "avisar",
  carenciaDias: 7,
  organizacoesEmCarencia: 0,
  organizacoesComCarenciaVencida: 0,
  organizacoesSemCarencia: 0,
};

export async function carregarBloqueioDosPlanos(admin: SupabaseClient): Promise<BloqueioDosPlanos> {
  try {
    const agoraIso = new Date().toISOString();

    const [settingsRes, emCarenciaRes, vencidaRes, semCarenciaRes] = await Promise.all([
      admin.from("billing_settings").select("modo, carencia_dias").eq("id", 1).maybeSingle(),
      admin
        .from("billing_contracts")
        .select("id", { count: "exact", head: true })
        .not("bloqueio_a_partir_de", "is", null),
      admin
        .from("billing_contracts")
        .select("id", { count: "exact", head: true })
        .not("bloqueio_a_partir_de", "is", null)
        .lte("bloqueio_a_partir_de", agoraIso),
      admin.from("billing_contracts").select("id", { count: "exact", head: true }).is("bloqueio_a_partir_de", null),
    ]);

    if (settingsRes.error) throw new Error(`ler billing_settings: ${settingsRes.error.message}`);
    if (emCarenciaRes.error) throw new Error(`contar em carência: ${emCarenciaRes.error.message}`);
    if (vencidaRes.error) throw new Error(`contar carência vencida: ${vencidaRes.error.message}`);
    if (semCarenciaRes.error) throw new Error(`contar sem carência: ${semCarenciaRes.error.message}`);

    const linha = settingsRes.data as { modo: string; carencia_dias: number } | null;

    return {
      modo: ehModoValido(linha?.modo) ? linha.modo : PADRAO_EM_FALHA.modo,
      carenciaDias: linha?.carencia_dias ?? PADRAO_EM_FALHA.carenciaDias,
      organizacoesEmCarencia: emCarenciaRes.count ?? 0,
      organizacoesComCarenciaVencida: vencidaRes.count ?? 0,
      organizacoesSemCarencia: semCarenciaRes.count ?? 0,
      leituraFalhou: false,
    };
  } catch (erro) {
    logger.error("alarme_planos_leitura", {
      etapa: "bloqueio_dos_planos_da_instalacao",
      error: (erro instanceof Error ? erro.message : String(erro)).slice(0, 300),
    });
    return { ...PADRAO_EM_FALHA, leituraFalhou: true };
  }
}
