/**
 * Os códigos de `lib/ai/provider-validators.ts` são bons para o banco e para o
 * audit; para quem colou a chave e viu "auth_failed_401", não dizem nada.
 * Esta é a única tradução de código para frase — o card não conhece os códigos.
 *
 * As frases são chaves de `t()`: pt-BR aqui, espanhol em `lib/i18n/dicionario.ts`.
 */
import { PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import { codigoParaOrganizacao, DESTINO_RECUSADO } from "@/lib/automation/destino-recusado";

export interface ErroDescrito {
  frase: string;
  /** Vale oferecer o link "pegar chave em…"? Só quando a chave em si é o problema. */
  chaveErrada: boolean;
  /**
   * Caso genérico (código sem tradução conhecida): a `frase` já embute o
   * código cru e por isso NÃO pode passar inteira por `t()` — só a parte fixa
   * "Falha na validação" é chave de tradução. O card usa esta flag para saber
   * qual dos dois caminhos tomar, em vez de inspecionar `frase` por prefixo
   * (um `.startsWith(...)` na JSX do card conta, para o guarda de i18n, como
   * literal renderizado fora de `t()`).
   */
  generico: boolean;
}

const REDE = "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.";

/**
 * A recusa com o NOME de quem recusou, para a chave do Jev: "o provedor" não diz
 * nada a quem nunca ouviu falar da TypeSafe. Frases inteiras, e não o nome
 * encaixado numa frase comum, para cada idioma poder construí-las do seu jeito.
 */
const RECUSA_DA_TYPESAFE = {
  chave: "A TypeSafe recusou a chave. Confira se copiou inteira ou gere uma nova.",
  chaveOuCredito: "A TypeSafe recusou a chave. Confira se ela está inteira e se a conta na TypeSafe tem crédito.",
} as const;

/**
 * Quem escolheu o endereço que gerou o erro. Espelha `OrigemDoDestino` de
 * `lib/automation/destinos-internos-autorizados.ts`, declarado aqui de propósito:
 * este módulo é importado por componentes de cliente, e aquele arrasta DNS e
 * banco para o bundle.
 */
export type OrigemDoEnderecoDoErro = "instalacao" | "organizacao";

/**
 * A frase única para "o nome não resolve" e "o nome resolve para IP interno" de
 * um endereço escolhido por uma ORGANIZAÇÃO. Frases diferentes viravam oráculo:
 * quem administra uma empresa sondava, por tentativa, quais nomes existem na
 * rede interna do compose (nome que não existe = "não resolve"; nome que existe
 * = "rede interna"). A frase diz as duas hipóteses, sem escolher.
 */
const ENDERECO_NAO_ACEITO_DA_ORGANIZACAO =
  "Este endereço não é aceito: o nome não resolve para um servidor público, ou aponta para a rede interna do servidor (localhost, IP privado ou serviço interno). Confira a base URL.";

/**
 * `origem` vale só para o endereço: o padrão é `organizacao` (o lado que
 * fecha, para quem chamar sem pensar). Quem mostra erro de endereço da
 * INSTALAÇÃO passa `instalacao` e segue com a frase que separa os casos, porque
 * quem lê é o dono da máquina e a distinção o ajuda a corrigir.
 */
export function descreverErroDeValidacao(
  codigo: string | null,
  provedor?: string,
  origem: OrigemDoEnderecoDoErro = "organizacao",
): ErroDescrito {
  if (!codigo) return { frase: "", chaveErrada: false, generico: false };
  // `DESTINO_RECUSADO` é o código único que o servidor já grava e devolve no
  // lugar dos três da régua quando a origem é organização (`codigoParaOrganizacao`);
  // linhas antigas ainda podem trazer os três crus, e a organização vê a mesma frase.
  if (
    codigo === DESTINO_RECUSADO ||
    (origem === "organizacao" && codigoParaOrganizacao(codigo) === DESTINO_RECUSADO)
  ) {
    return { frase: ENDERECO_NAO_ACEITO_DA_ORGANIZACAO, chaveErrada: false, generico: false };
  }
  const ehTypeSafe = provedor === PROVEDOR_DO_JEV;

  if (codigo === "auth_failed_401") {
    return {
      frase: ehTypeSafe
        ? RECUSA_DA_TYPESAFE.chave
        : "O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.",
      chaveErrada: true,
      generico: false,
    };
  }

  // Provedor personalizado (#1642): o problema é o ENDEREÇO, não a chave —
  // dizer "confira a chave" mandaria quem opera procurar no lugar errado.
  if (codigo === "base_url_ausente" || codigo === "base_url_invalida") {
    return {
      frase:
        "Falta o endereço (base URL) do provedor personalizado, ou ele não começa com http:// ou https://. Edite a credencial e informe o endereço da API.",
      chaveErrada: false,
      generico: false,
    };
  }

  // A régua de destino (`motivoDaRecusaDeDestino`, decisão 22-d) recusou o
  // endereço antes de a chave sair. O problema é o ENDEREÇO, e cada código diz
  // o que fazer de um jeito diferente.
  if (codigo === "unsafe_url:dns_failed" || codigo === "unsafe_url:dns_empty") {
    return {
      frase: "Este servidor não encontrou o endereço: o nome não resolve. Confira a base URL.",
      chaveErrada: false,
      generico: false,
    };
  }
  if (codigo === "unsafe_url:https_required") {
    // Endereço de organização exige https sempre (`motivoDaRecusaDeDestino`);
    // só o da instalação segue com https apenas em produção.
    return {
      frase:
        origem === "organizacao"
          ? "O endereço (base URL) precisa começar com https://."
          : "Em produção, o endereço (base URL) precisa começar com https://.",
      chaveErrada: false,
      generico: false,
    };
  }
  if (codigo === "unsafe_url:redirect_not_followed") {
    return {
      frase:
        "Este endereço respondeu com um redirecionamento, e o CRM não segue redirecionamento em endereço cadastrado pela empresa. Informe o endereço final da API.",
      chaveErrada: false,
      generico: false,
    };
  }
  if (codigo.startsWith("unsafe_url:")) {
    return {
      frase:
        "Este endereço não é aceito: um endereço cadastrado pela empresa não pode apontar para a rede interna do servidor (localhost, IP privado ou serviço interno).",
      chaveErrada: false,
      generico: false,
    };
  }

  if (codigo === "provider_status_404") {
    return {
      frase:
        "Este endereço não respondeu em /models. Confira a base URL: ela deve apontar para a raiz de uma API compatível com a OpenAI.",
      chaveErrada: false,
      generico: false,
    };
  }

  if (codigo === "provider_status_429") {
    return {
      frase: "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.",
      chaveErrada: false,
      generico: false,
    };
  }

  // Outro 4xx (402 e afins): o provedor recusou, e o motivo mais comum fora a
  // chave errada é a conta sem crédito. Afirmar só um dos dois seria chute; o
  // código cru na tela ("provider_status_402") não diz nada a ninguém.
  if (/^provider_status_4\d\d$/.test(codigo)) {
    return {
      frase: ehTypeSafe
        ? RECUSA_DA_TYPESAFE.chaveOuCredito
        : "O provedor recusou a chave. Confira se ela está inteira e se a conta no provedor tem crédito.",
      chaveErrada: true,
      generico: false,
    };
  }

  if (/^provider_status_5\d\d$/.test(codigo)) {
    return {
      frase: "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.",
      chaveErrada: false,
      generico: false,
    };
  }

  if (
    codigo === "AbortError" ||
    codigo === "TimeoutError" ||
    codigo === "network_error" ||
    // `fetch` do Node lança `TypeError` para falha de rede/DNS (undici não usa
    // um nome próprio aqui) — sem isto, um self-host com firewall de saída
    // restrito via um "Falha na validação (TypeError)." cru, achado rodando a
    // spec de verdade contra o provedor real (não reproduz com mock).
    codigo === "TypeError"
  ) {
    return { frase: REDE, chaveErrada: false, generico: false };
  }

  return { frase: `Falha na validação (${codigo}).`, chaveErrada: false, generico: true };
}
