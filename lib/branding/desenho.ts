/**
 * O DESENHO da marca do produto (HiperCRM) — símbolo e logotipo.
 *
 * Quando aparece: só onde um componente decide que a marca em vigor é a padrão
 * (`marcaEhADoProduto`, em `lib/branding.ts`). Quem configurou nome ou logo
 * próprio nunca vê estes desenhos.
 *
 * Duas peças, de naturezas diferentes:
 *
 *  1. O SÍMBOLO é geometria pura (seis paralelogramos sobre um ladrilho azul),
 *     derivada de `public/site/_hipercrm/hiperbold-icon-strokes-white.svg`.
 *     Fica aqui e não num arquivo porque o favicon (`app/icon.tsx`) é gerado em
 *     runtime pelo `ImageResponse`, que aceita SVG inline mas não lê arquivo do
 *     disco. Um único desenho alimenta a tela e o ícone.
 *  2. O LOGOTIPO são os arquivos `logo-hipercrm.svg` (claro) e
 *     `logo-hipercrm-escuro.svg` (escuro) do site de vendas, em
 *     `public/site/_hipercrm/`. Eles carregam a palavra em imagem embutida, não
 *     em caminhos, então não dá para reaproveitá-los como geometria: a tela os
 *     referencia por URL. O componente que os usa (`MarcaDoProduto.tsx`) escolhe
 *     o arquivo pelo tema e só os usa quando a marca é a do produto.
 */

/** O símbolo: ladrilho azul com a marca em seis paralelogramos brancos. Quadrado de 64. */
export const SIMBOLO = {
  viewBox: "0 0 64 64",
  /** O ladrilho. O mesmo azul e o mesmo raio do `public/site/favicon.svg`. */
  ladrilho: { x: 0, y: 0, width: 64, height: 64, rx: 16 },
  /** Seis paralelogramos inclinados, em duas fileiras de três. */
  d: "M32.01 45.52L25.33 45.52L31.99 32L38.67 32ZM32.01 32L25.33 32L31.99 18.48L38.67 18.48ZM18.68 45.52L12 45.52L18.66 32L25.33 32ZM18.68 32L12 32L18.66 18.48L25.33 18.48ZM45.34 45.52L38.67 45.52L45.32 32L52 32ZM45.34 32L38.67 32L45.32 18.48L52 18.48Z",
} as const;

/**
 * O logotipo: arquivos em `public/site/_hipercrm/`, um por tema. A proporção
 * (largura/altura) é a do `viewBox` dos dois SVGs, para dimensionar por altura.
 */
export const LOGOTIPO = {
  claro: "/site/_hipercrm/logo-hipercrm.svg",
  escuro: "/site/_hipercrm/logo-hipercrm-escuro.svg",
  proporcao: 684 / 84.5,
} as const;

/** As cores do símbolo, iguais nos dois temas (o ladrilho azul é o próprio fundo). */
export const CORES_DA_MARCA = {
  ladrilho: "#0139B0",
  marca: "#ffffff",
} as const;
