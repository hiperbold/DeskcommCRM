/**
 * As linhas da seção "Tokens de IA" da tela "Plano e uso" (fase F2-B,
 * tarefa 6).
 *
 * Função pura, no molde de `lib/billing/planos/linhas-da-tela-de-plano.ts`:
 * recebe o que `saldoDaOrganizacao`, `extratoDoCiclo` e `estimativaDeRespostas`
 * já leram e devolve só o que a tela desenha. Nenhum texto mora aqui: o
 * dicionário (`lib/i18n/dicionario.ts`) é responsabilidade da tela, que
 * traduz cada rótulo com `t()`; este módulo só decide NÚMEROS e
 * DISCRIMINADORES (que frase mostrar), o mesmo corte de responsabilidade do
 * módulo irmão.
 *
 * ═══ Por que `leituraFalhou` é UM booleano, unindo os TRÊS resultados ═══
 *
 * Saldo, extrato e estimativa são três leituras independentes. Misturar um
 * saldo que veio do banco com um extrato que não veio criaria uma tela que
 * parece inteira mas é meio inventada, o mesmo raciocínio do comentário de
 * `linhas-da-tela-de-plano.ts` para "uso" e "plano". Por isso, se qualquer
 * uma falhou, NENHUM número desta seção sai: `carteira`, `estimativa` e os
 * dois extratos vêm vazios/nulos, e a tela mostra só o aviso.
 */
import { FONTES_DA_CARTEIRA, type FonteCarteira, type ResultadoSaldoDaCarteira } from "./saldo-da-organizacao";
import type {
  LinhaExtratoPorAgente,
  LinhaExtratoPorDia,
  ResultadoExtratoDoCiclo,
} from "./extrato-do-ciclo";
import type { ResultadoEstimativaDeRespostas } from "./estimativa-de-respostas";

export interface LinhaFonteDaCarteira {
  fonte: FonteCarteira;
  creditado: number;
  consumido: number;
  saldo: number;
}

export interface LinhaCarteiraDeTokens {
  semLimite: boolean;
  /** `null` só quando `semLimite` (Ilimitado: não existe "disponível" a comparar). */
  totalDisponivel: number | null;
  totalConsumido: number;
  /** 0 a 100, arredondado e limitado a 100. `null` quando `semLimite`. */
  percentual: number | null;
  /** Consumido no total disponível ou acima dele. Nunca `true` com `semLimite`. */
  estourou: boolean;
  /** Consumido ACIMA do disponível (saldo negativo, decisão 15 da fase). Nunca `true` com `semLimite`. */
  saldoNegativo: boolean;
  /** Só as fontes com crédito (`creditado > 0`); `plano` sempre aparece, mesmo zerada. */
  fontes: LinhaFonteDaCarteira[];
}

export interface LinhaEstimativaDeTokens {
  tokensPorResposta: number;
  /** `null` quando não há saldo restante para medir contra (sem teto). */
  respostasQueCabem: number | null;
  baseadoEmAmostra: boolean;
}

export interface LinhasDeTokensDeIA {
  /** `true` quando saldo, extrato OU estimativa falharam: nenhum número abaixo é real. */
  leituraFalhou: boolean;
  carteira: LinhaCarteiraDeTokens | null;
  estimativa: LinhaEstimativaDeTokens | null;
  /** Mais recente primeiro. */
  extratoPorDia: LinhaExtratoPorDia[];
  /** Maior consumo primeiro. */
  extratoPorAgente: LinhaExtratoPorAgente[];
}

const SECAO_SEM_DADO: LinhasDeTokensDeIA = {
  leituraFalhou: true,
  carteira: null,
  estimativa: null,
  extratoPorDia: [],
  extratoPorAgente: [],
};

export function linhasDeTokensDeIA(
  saldo: ResultadoSaldoDaCarteira,
  extrato: ResultadoExtratoDoCiclo,
  estimativa: ResultadoEstimativaDeRespostas,
): LinhasDeTokensDeIA {
  if (saldo.status === "leitura_falhou" || extrato.status === "leitura_falhou" || estimativa.status === "leitura_falhou") {
    return SECAO_SEM_DADO;
  }

  const semLimite = saldo.status === "sem_limite";
  // `saldo.status === "ok"` (e não `!semLimite`) para o TypeScript estreitar
  // `saldo` de verdade: `totalDisponivel` só existe na variante "ok".
  const totalDisponivel = saldo.status === "ok" ? saldo.totalDisponivel : null;
  const totalConsumido = saldo.totalConsumido;

  // `totalDisponivel <= 0` é defensivo (mesma guarda de linhas-da-tela-de-plano.ts):
  // a barra aparece cheia em vez de dividir por zero.
  const percentual =
    totalDisponivel === null
      ? null
      : totalDisponivel <= 0
        ? 100
        : Math.min(100, Math.round((totalConsumido / totalDisponivel) * 100));
  const estourou = totalDisponivel !== null && totalConsumido >= totalDisponivel;
  const saldoNegativo = totalDisponivel !== null && totalConsumido > totalDisponivel;

  const fontes: LinhaFonteDaCarteira[] = FONTES_DA_CARTEIRA.filter(
    (fonte) => fonte === "plano" || saldo.porFonte[fonte].creditado > 0,
  ).map((fonte) => ({ fonte, ...saldo.porFonte[fonte] }));

  const carteira: LinhaCarteiraDeTokens = {
    semLimite,
    totalDisponivel,
    totalConsumido,
    percentual,
    estourou,
    saldoNegativo,
    fontes,
  };

  const linhaEstimativa: LinhaEstimativaDeTokens = { ...estimativa.estimativa };

  const extratoPorDia = [...extrato.extrato.porDia].sort((a, b) => b.dia.localeCompare(a.dia));
  const extratoPorAgente = [...extrato.extrato.porAgente].sort(
    (a, b) => b.tokensPonderados - a.tokensPonderados,
  );

  return {
    leituraFalhou: false,
    carteira,
    estimativa: linhaEstimativa,
    extratoPorDia,
    extratoPorAgente,
  };
}
