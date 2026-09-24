/**
 * O GATE DA CARTEIRA DE TOKENS: decisão, sem I/O. Irmão de `./orcamento.ts`
 * (decisões 6 e 7 da fase F3, `hiperbold/planos/fase-F3-tarefas.md`).
 *
 * ═══ POR QUE É UM GATE SEPARADO, E NÃO UM RAMO DENTRO DO ORÇAMENTO ═══
 *
 * O orçamento em dólar (`ai_budgets`) e a carteira de tokens (`billing_token_wallets`,
 * F2-B/0906) medem coisas diferentes, de donos diferentes: o orçamento é um teto que
 * CADA ORGANIZAÇÃO escolhe para si; a carteira é o que a INSTALAÇÃO vendeu a ela num
 * plano. Uma organização pode ter orçamento infinito e carteira zerada, ou o
 * contrário, os dois vetos são independentes e precisam poder ligar/desligar sem se
 * arrastarem.
 *
 * ═══ A DECISÃO EM SI JÁ MORA NO BANCO ═══
 *
 * Ao contrário de `decidirOrcamento`, aqui não há uma função pura que reimplementa o
 * veredito: `fn_billing_ia_pode_responder` (migration 0907, parte 3) já devolve
 * `{acao, motivo, saldo, ciclo}` pronto: reimplementar a conta em TypeScript seria a
 * SEGUNDA fonte de verdade que a fase inteira existe para evitar (a carteira já tem
 * ledger, ciclo e proporção do mês calculados no banco). O que mora aqui é:
 *
 *   1. o vocabulário do modo (`billing_settings.modo`) e da chave de emergência
 *      (`PLANOS_BLOQUEIO`), espelhando `orcamento.ts`;
 *   2. o portão que decide SE vale a pena consultar a função do banco, a parte cara
 *      de "zero consulta a mais" (decisão 6);
 *   3. a interpretação do jsonb que a função devolve, com o mesmo viés do resto da
 *      fase: resposta que não bate com o formato esperado nunca bloqueia;
 *   4. os textos do aviso crítico da Central, com identidade própria (decisão 7).
 */

import { z } from 'zod';

import { PURPOSES_ISENTOS, type ChaveDeOrcamento } from './orcamento';

// Reexporta o vocabulário e a normalização da chave de emergência: mesmo espaço de
// valores (`off`/`avisar`/`on`), mesma semântica ("só afrouxa"). `PLANOS_BLOQUEIO`
// não precisa de uma segunda função de normalização, duplicá-la seria duplicar
// justamente o texto que já explica por que é `z.string()` cru e nunca `z.enum`
// (ver `lib/env.ts`, ao lado de `AI_BUDGET_ENFORCEMENT`).
export { normalizarChaveDeOrcamento as normalizarChaveDePlanosBloqueio } from './orcamento';
export type { ChaveDeOrcamento as ChaveDePlanosBloqueio } from './orcamento';

/** `billing_settings.modo` (0905/0907). Nasce `'avisar'` por DEFAULT da coluna. */
export type ModoDeBilling = 'desligado' | 'avisar' | 'bloquear';

/**
 * `billing_settings.modo` cru → o tipo do domínio. QUALQUER outra coisa,
 * inclusive `null`, que não deveria acontecer (a linha é única e semeada, `id = 1`)
 * mas cobre o clone cujo `update.sh` engoliu um erro, vira `'desligado'`: a
 * leitura mais frouxa possível, mesma doutrina de `normalizarModoDeOrcamento`.
 */
export function normalizarModoDeBilling(v: string | null | undefined): ModoDeBilling {
  if (v === 'avisar' || v === 'bloquear') return v;
  return 'desligado';
}

/** A única coluna que o gate precisa ler antes de decidir se vale a pena continuar. */
export const SQL_MODO_DE_BILLING = `select modo from public.billing_settings where id = 1`;

export type AcaoDaCarteira = 'seguir' | 'avisar_e_seguir' | 'bloquear';

/** O jsonb que `fn_billing_ia_pode_responder` devolve, já tipado. */
export interface VeredictoDaCarteira {
  acao: AcaoDaCarteira;
  motivo: string;
  saldo: number | null;
  ciclo: string | null;
}

const vereditoSchema = z.object({
  acao: z.enum(['seguir', 'avisar_e_seguir', 'bloquear']),
  motivo: z.string(),
  saldo: z.number().nullable(),
  ciclo: z.string().nullable(),
});

/**
 * A resposta CRUA da RPC → o tipo do domínio. Igual à doutrina do arquivo
 * irmão: toda ambiguidade resolve para o lado que NÃO bloqueia. Uma resposta
 * fora do formato esperado (coluna renomeada num clone, função alterada à mão)
 * nunca deveria acontecer, e por isso, quando acontece, "seguir" é a única
 * saída que não troca um soluço de leitura por um agente mudo.
 */
export function interpretarVeredictoDaCarteira(bruto: unknown): VeredictoDaCarteira {
  const parsed = vereditoSchema.safeParse(bruto);
  if (!parsed.success) {
    return {
      acao: 'seguir',
      motivo: 'resposta da carteira fora do formato esperado',
      saldo: null,
      ciclo: null,
    };
  }
  return parsed.data;
}

/**
 * A chave de emergência só sabe AFROUXAR (mesma regra da chave do orçamento):
 * `'avisar'` rebaixa um `'bloquear'` vindo do banco para `'avisar_e_seguir'`: a IA
 * nunca é parada só porque o operador esqueceu de tirar o `PLANOS_BLOQUEIO=avisar`
 * de um teste. `'on'` não faz nada (obedece o banco); `'off'` nem chega aqui, porque
 * `deveConsultarCarteira` já recusou a consulta antes.
 */
export function aplicarChaveNoVeredicto(
  veredicto: VeredictoDaCarteira,
  chave: ChaveDeOrcamento,
): VeredictoDaCarteira {
  if (veredicto.acao !== 'bloquear' || chave !== 'avisar') return veredicto;
  return {
    ...veredicto,
    acao: 'avisar_e_seguir',
    motivo: `${veredicto.motivo} (rebaixado pela chave de emergência PLANOS_BLOQUEIO=avisar)`,
  };
}

/**
 * O PORTÃO DE CUSTO (decisão 6): "a chamada só acontece quando: a variável e o modo
 * permitem bloquear, `origemDaChave === 'chave_da_instalacao'`, e o propósito não
 * está em `PURPOSES_ISENTOS`. Senão, segue sem consulta nenhuma."
 *
 * As quatro condições, em ordem do mais barato para o mais caro de verificar:
 * quem chama (`aplicarCarteira`, em `run-model-call.ts`) já testou `chave`,
 * `origemDaChave` e `purpose` (todos em memória) ANTES de pagar a leitura cacheada
 * de `billing_settings.modo`; esta função só existe para a decisão em si ficar
 * testável sem banco nenhum, com o `modo` já resolvido entregue por parâmetro.
 */
export function deveConsultarCarteira(d: {
  chave: ChaveDeOrcamento;
  modoDoBanco: ModoDeBilling;
  origemDaChave: 'chave_da_instalacao' | 'credencial_da_organizacao';
  purpose: string;
}): boolean {
  if (d.chave === 'off') return false;
  if (d.origemDaChave !== 'chave_da_instalacao') return false;
  if ((PURPOSES_ISENTOS as readonly string[]).includes(d.purpose)) return false;
  return d.modoDoBanco === 'bloquear';
}

/**
 * O título do aviso crítico, próprio, e não `BLOQUEIO_TITULO` do orçamento em
 * dólar: são dois vetos diferentes, e um operador que lê "o limite de gasto foi
 * atingido" quando o que acabou foi a carteira de tokens do plano vai procurar o
 * conserto no lugar errado (Uso de IA › Orçamento em vez de Plano e uso).
 */
export const CARTEIRA_BLOQUEIO_TITULO = 'Os tokens de IA do mês acabaram';

/**
 * O corpo do aviso: diz o que aconteceu (a fila humana assumiu), não convida a
 * adivinhar. Ponteiro para o saldo, não um número congelado: por ora ele reflete o
 * instante da recusa, e é isso que interessa a quem vai decidir contratar mais.
 */
export function corpoDoBloqueioDaCarteira(saldoTokens: number | null): string {
  const saldoTexto = saldoTokens === null ? '' : ` (saldo no ciclo: ${saldoTokens} tokens)`;
  return (
    `A carteira de tokens de IA desta organização chegou a zero neste ciclo${saldoTexto}. ` +
    'As conversas que estavam sendo atendidas pela IA foram para a FILA DE ATENDIMENTO HUMANO, ' +
    'ninguém ficou sem próximo passo, mas alguém precisa responder. ' +
    'Para a IA voltar a responder ainda neste mês, contrate mais tokens em Configurações › Plano e uso.'
  );
}
