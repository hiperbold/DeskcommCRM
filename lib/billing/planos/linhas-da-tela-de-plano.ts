/**
 * As linhas da tela "Plano e uso" (fase F2, tarefa 7).
 *
 * Função pura: recebe o que `usoDaOrganizacao` e `planoDaOrganizacao` já
 * leram e devolve só o que a tela desenha, uma linha por item. Fica fora do
 * Server Component pelo mesmo motivo de `pode-escrever-na-aba.ts`, testar a
 * regra sem montar árvore nem tocar em rede.
 *
 * ═══ Por que `leituraFalhou` é UM booleano só, e não dois ═══
 *
 * A tela chama `usoDaOrganizacao` e `planoDaOrganizacao` em paralelo, e cada
 * uma tem o seu próprio `leituraFalhou`. Quem monta a tela já uniu os dois
 * (`||`) antes de chegar aqui, de propósito: se só o uso falhou, o teto que
 * `planoDaOrganizacao` leu está correto, mas juntar um "atual" que não veio do
 * banco com um "teto" que veio criaria um "3 de 5" em que só a metade é real
 *, pior que não mostrar nada, porque parece inteiro. Por isso, com
 * `leituraFalhou = true`, NENHUMA chave desta função olha para `uso` ou
 * `limites`: os dois argumentos são ignorados de propósito, não só não
 * usados.
 */
import type { ChaveDeLimite, Limites } from "./limites";
import type { Uso } from "./uso-da-organizacao";

/**
 * As seis chaves que a tela mostra como item com teto. `tokens_ia_mes` fica
 * de fora: nesta fase ele não é medido, e a tela mostra uma linha fixa
 * dizendo isso, não um "0 de X" que mentiria sobre uma coisa que ninguém
 * contou ainda.
 */
export const CHAVES_DA_TELA_DE_PLANO = [
  "funis",
  "etapas_por_funil",
  "membros",
  "conexoes",
  "integracoes_webhook",
  "leads",
] as const satisfies readonly Exclude<ChaveDeLimite, "tokens_ia_mes">[];

export type ChaveDaTelaDePlano = (typeof CHAVES_DA_TELA_DE_PLANO)[number];

export interface LinhaDaTelaDePlano {
  chave: ChaveDaTelaDePlano;
  /** `null` quando a leitura falhou, nunca "0", que pareceria uso real medido. */
  atual: number | null;
  /** `null` quando sem teto OU quando a leitura falhou. */
  teto: number | null;
  /** Só verdadeiro com leitura OK e teto nulo, é o único caso que diz "sem limite". */
  semLimite: boolean;
  /** 0 a 100, arredondado e limitado a 100 mesmo passando do teto. `null` sem teto ou com leitura falhada. */
  percentual: number | null;
  /** Uso no teto ou acima dele. Nunca `true` com leitura falhada. */
  estourou: boolean;
}

/** A linha "não sei", repetida para as seis chaves quando a leitura falhou. */
function linhaSemDado(chave: ChaveDaTelaDePlano): LinhaDaTelaDePlano {
  return { chave, atual: null, teto: null, semLimite: false, percentual: null, estourou: false };
}

export function linhasDaTelaDePlano(
  uso: Uso,
  limites: Limites,
  leituraFalhou: boolean,
): LinhaDaTelaDePlano[] {
  return CHAVES_DA_TELA_DE_PLANO.map((chave) => {
    if (leituraFalhou) return linhaSemDado(chave);

    const atual = uso[chave];
    const teto = limites[chave];

    if (teto === null) {
      return { chave, atual, teto: null, semLimite: true, percentual: null, estourou: false };
    }

    // `teto <= 0` é defensivo (a migração não semeia teto zero hoje): a barra
    // aparece cheia em vez de dividir por zero.
    const percentual = teto <= 0 ? 100 : Math.min(100, Math.round((atual / teto) * 100));
    return { chave, atual, teto, semLimite: false, percentual, estourou: atual >= teto };
  });
}
