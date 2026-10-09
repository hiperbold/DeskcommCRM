import { CORES_DA_MARCA, LOGOTIPO, SIMBOLO } from "@/lib/branding/desenho";
import { cn } from "@/lib/utils";

/**
 * A marca do PRODUTO (HiperCRM) — o que a tela mostra quando ninguém configurou
 * marca própria (`marcaEhADoProduto`, em `lib/branding.ts`).
 *
 * O símbolo é SVG inline. O logotipo é um arquivo de `public/site/_hipercrm/`,
 * um por tema, aplicado como imagem de fundo de um `<span role="img">` e NÃO como
 * `<img>`, por dois motivos:
 *  - a barra lateral já usa `<img>` para o logo CONFIGURADO, e o e2e
 *    `marca-logo.spec.ts` mede "barra sem `<img>`" como "sem logo do
 *    revendedor". Um `<img>` do produto ali faria a spec medir a coisa errada;
 *  - a troca de tema é por CSS (`dark:`), sem JavaScript e sem piscar o logo
 *    claro antes de hidratar.
 *
 * O texto alternativo é o `nome` que a tela já resolveu — nunca uma string
 * fixa, para que a catraca de marca (`tests/unit/branding.test.ts`) continue
 * sem ocorrência fora de `lib/branding.ts`.
 */

type Props = {
  readonly nome: string;
  readonly className?: string;
  /** `true` quando o texto ao lado já nomeia a marca — evita ler duas vezes. */
  readonly decorativo?: boolean;
};

// O Tailwind só gera utilitário para valor LITERAL no fonte, então as URLs dos
// dois arquivos aparecem escritas abaixo. Quem impede as classes de divergirem
// de `LOGOTIPO` é `tests/unit/marca-do-produto.test.tsx`.
export const CLASSES_DO_LOGOTIPO =
  "bg-[url(/site/_hipercrm/logo-hipercrm.svg)] dark:bg-[url(/site/_hipercrm/logo-hipercrm-escuro.svg)]";

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

/** O símbolo sozinho — para a barra recolhida, avatar e cantos apertados. */
export function SimboloDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox={SIMBOLO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <rect {...SIMBOLO.ladrilho} fill={CORES_DA_MARCA.ladrilho} />
      <path d={SIMBOLO.d} fill={CORES_DA_MARCA.marca} />
    </svg>
  );
}

/** O logotipo completo — para a barra aberta e a fachada de entrada. */
export function LogotipoDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <span
      className={cn(
        "inline-block max-w-full shrink-0 bg-contain bg-left bg-no-repeat",
        CLASSES_DO_LOGOTIPO,
        className,
      )}
      style={{ aspectRatio: LOGOTIPO.proporcao }}
      {...acessibilidade(nome, decorativo)}
    />
  );
}
