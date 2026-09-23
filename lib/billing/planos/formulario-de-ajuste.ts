/**
 * A conversão do formulário de ajuste de limites (fase F1, tarefa 5).
 *
 * ═══ Por que um seletor de TRÊS opções, e não um campo numérico vazio = herda ═══
 *
 * Um campo numérico vazio some sozinho quando alguém apaga o número para
 * digitar outro: aí "vazio" deixa de significar "não decidi" e passa a
 * significar "ainda estou digitando", e as duas coisas produzem o MESMO
 * estado. A especificação (hiperbold/planos/fase-F1-tarefas.md, tarefa 5) por
 * isso pede um seletor com três opções EXPLÍCITAS por chave: herdar do plano
 * (a chave não entra no ajuste), sem limite (entra como `null`, libera de
 * verdade) e valor (entra como o número digitado). O campo numérico só
 * aparece no terceiro caso, e mesmo ali um valor mal digitado nunca vira
 * "sem limite" nem "herdar" caladamente: os dois têm efeito real sobre a
 * organização, e um erro de digitação não pode produzir nenhum dos dois.
 *
 * Função pura, sem React: é o que o teste unitário cobre; a tela (`_client.tsx`)
 * só guarda este estado e chama estas duas funções.
 */
import {
  CHAVES_DE_LIMITE,
  esquemaDoAjusteDeLimites,
  TETO_DE_LIMITE,
  type AjusteDeLimites,
  type ChaveDeLimite,
} from "./limites";

/** O estado de UMA chave no formulário. O campo de número só existe em "valor". */
export type CampoDeAjuste =
  | { modo: "herdar" }
  | { modo: "sem_limite" }
  | { modo: "valor"; valor: string };

/** O estado do formulário inteiro: uma entrada por chave de limite. */
export type EstadoDoFormularioDeAjuste = Record<ChaveDeLimite, CampoDeAjuste>;

/**
 * O estado inicial, a partir do que está gravado em `billing_plan_adjustments`
 * (ou `null`, quando a organização não tem ajuste). Espelha a leitura que
 * `estadoInicialDoAjuste(ajusteDoFormulario(x))` desfaz: chave ausente vira
 * "herdar", chave presente com `null` vira "sem limite", chave presente com
 * número vira "valor" com o número já escrito como string.
 */
export function estadoInicialDoAjuste(
  ajuste: AjusteDeLimites | null | undefined,
): EstadoDoFormularioDeAjuste {
  const estado = {} as EstadoDoFormularioDeAjuste;
  for (const chave of CHAVES_DE_LIMITE) {
    if (!ajuste || !(chave in ajuste)) {
      estado[chave] = { modo: "herdar" };
      continue;
    }
    const valor = ajuste[chave];
    estado[chave] = valor === null ? { modo: "sem_limite" } : { modo: "valor", valor: String(valor) };
  }
  return estado;
}

export type ResultadoDoFormularioDeAjuste =
  | { ok: true; limites: AjusteDeLimites }
  | { ok: false; erro: string; chave: ChaveDeLimite };

/**
 * O objeto que a server action `ajustarLimitesDaOrganizacao` recebe.
 *
 * "herdar" NÃO entra no objeto (é a ausência da chave: herda do plano).
 * "sem_limite" entra como `null`. "valor" só vira número quando o texto
 * digitado é um inteiro entre 0 e `TETO_DE_LIMITE`, sem espaço solto, sem
 * sinal, sem casa decimal: qualquer outra coisa devolve o erro NAQUELA
 * chave, sem tocar nas demais e sem inventar "sem limite" nem "herdar" para
 * ela.
 */
export function ajusteDoFormulario(
  estado: EstadoDoFormularioDeAjuste,
): ResultadoDoFormularioDeAjuste {
  const rascunho: Partial<Record<ChaveDeLimite, number | null>> = {};

  for (const chave of CHAVES_DE_LIMITE) {
    const campo = estado[chave];

    if (campo.modo === "herdar") continue;

    if (campo.modo === "sem_limite") {
      rascunho[chave] = null;
      continue;
    }

    const bruto = campo.valor.trim();
    if (!/^\d+$/.test(bruto)) {
      return { ok: false, erro: "Digite um número inteiro maior ou igual a zero.", chave };
    }

    const numero = Number(bruto);
    if (numero > TETO_DE_LIMITE) {
      return {
        ok: false,
        erro: `O maior valor aceito é ${TETO_DE_LIMITE.toLocaleString("pt-BR")}.`,
        chave,
      };
    }

    rascunho[chave] = numero;
  }

  const validado = esquemaDoAjusteDeLimites.safeParse(rascunho);
  if (!validado.success) {
    // Defensivo: as checagens acima já garantem o mesmo esquema. Chegar aqui
    // seria bug nesta função, não entrada ruim do operador, e por isso aponta
    // sempre a primeira chave, só para o chamador ter algo a mostrar.
    return { ok: false, erro: "Ajuste inválido.", chave: CHAVES_DE_LIMITE[0] };
  }

  return { ok: true, limites: validado.data };
}
