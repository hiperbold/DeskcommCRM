/**
 * O QUE NÃO SAI DO CRM NOS ARGUMENTOS DE UMA FERRAMENTA MCP EXTERNA (D-037).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Um agente que tem, no mesmo turno, ferramentas do CRM e de um servidor de
 * terceiro enxerga a conversa inteira: telefone do contato, e-mail, id do
 * lead, o texto das mensagens. Nada impedia o modelo de copiar isso para
 * dentro do argumento da ferramenta externa, e o argumento vai inteiro para o
 * servidor do outro lado. A tela de cadastro avisa, mas aviso não é trava.
 *
 * Decisão do Filipe (22/09/2026): o uso das conexões MCP é consulta de
 * catálogo, estoque, imóveis, veículos. Para isso nenhum dado de cliente
 * precisa sair. Então a trava é fechada por padrão e sem opção de tela: o que
 * tem forma de dado pessoal vira `[removido]` antes da chamada.
 *
 * ─── O que é recusado ───────────────────────────────────────────────────────
 *
 * Por FORMA do valor, em qualquer ponto do texto e não só no valor inteiro:
 * endereço de WhatsApp (`...@s.whatsapp.net`), e-mail, CPF e CNPJ com
 * pontuação, telefone brasileiro, e qualquer sequência de 10 a 14 dígitos
 * seguidos. Por VALOR: os ids desta instalação que o turno conhece
 * (organização, agente, job). Por NOME do campo: `telefone`, `email`, `cpf`,
 * `lead_id` e afins, mesmo que o valor não tenha forma reconhecível.
 *
 * ─── O que passa de propósito ───────────────────────────────────────────────
 *
 * - Sequência de até 9 dígitos: código de produto, CEP, número de imóvel, ano,
 *   preço. O corte em 10 é o menor telefone brasileiro com DDD.
 * - Campo de CÓDIGO (`sku`, `ean`, `gtin`, `codigo`, `placa`, `chassi`…):
 *   código de barras tem 12, 13 ou 14 dígitos e é exatamente o que a consulta
 *   de catálogo precisa mandar. Nesses campos a regra de dígitos e a de
 *   telefone não valem; e-mail, CPF e WhatsApp continuam valendo.
 * - `uuid` solto: o próprio servidor externo devolve uuid nos resultados dele,
 *   e o modelo devolve esse uuid na chamada seguinte para pedir o detalhe.
 *   Recusar todo uuid quebraria esse ida e volta. Id interno só é recusado
 *   quando o turno sabe o valor, ou quando o NOME do campo o denuncia. Fica
 *   de fora o id interno escrito no meio de um texto livre: não há como
 *   separá-lo de um id do outro sistema.
 * - Nome de pessoa: não há forma que o separe de um bairro ou de um modelo de
 *   carro, e lista de nomes erraria nos dois sentidos.
 */

/** O que fica no lugar do dado recusado. Vai para o servidor de terceiro. */
export const MARCA_DE_REMOCAO = "[removido]";

/** Profundidade máxima percorrida num argumento aninhado. */
const PROFUNDIDADE_MAXIMA = 6;

type Padrao = { tipo: string; re: RegExp; valeEmCampoDeCodigo: boolean };

/**
 * Ordem importa: o endereço de WhatsApp casa também com o padrão de e-mail, e
 * quem recusa primeiro é quem nomeia o achado no log.
 */
const PADROES: Padrao[] = [
  { tipo: "whatsapp", re: /[\w.-]+@(?:s\.whatsapp\.net|c\.us|lid|g\.us)\b/gi, valeEmCampoDeCodigo: true },
  { tipo: "email", re: /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, valeEmCampoDeCodigo: true },
  { tipo: "cpf", re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, valeEmCampoDeCodigo: true },
  { tipo: "cnpj", re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, valeEmCampoDeCodigo: true },
  // Sequência crua de 10 a 14 dígitos: telefone sem pontuação, CPF, CNPJ.
  // ANTES do telefone de propósito: em `5535991485627` o padrão de telefone
  // casaria só os 11 dígitos finais e deixaria o `55` do país para trás.
  { tipo: "sequencia_longa", re: /\b\d{10,14}\b/g, valeEmCampoDeCodigo: false },
  // Telefone escrito como gente escreve: +55 35 99148-5627, (35) 9914-8562.
  { tipo: "telefone", re: /(?:\+\s?\d{1,3}[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g, valeEmCampoDeCodigo: false },
];

/**
 * Nome de campo que denuncia o conteúdo mesmo quando o valor não tem forma
 * reconhecível. Casa por pedaço, em caixa baixa e sem separador, então
 * `phoneNumber`, `phone_number` e `TELEFONE` caem todos no mesmo item.
 */
const NOMES_RECUSADOS = [
  "telefone",
  "celular",
  "whatsapp",
  "phone",
  "email",
  "mail",
  "cpf",
  "cnpj",
  "leadid",
  "idlead",
  "contactid",
  "contatoid",
  "idcontato",
  "conversationid",
  "conversaid",
  "customerid",
  "clienteid",
  "idcliente",
];

/** Campo de código: a regra de dígitos atrapalharia a consulta de catálogo. */
const NOMES_DE_CODIGO = [
  "sku",
  "ean",
  "gtin",
  "upc",
  "isbn",
  "barcode",
  "codigodebarras",
  "codigo",
  "code",
  "referencia",
  "reference",
  "placa",
  "chassi",
  "renavam",
  "matricula",
];

function normalizarChave(chave: string): string {
  return chave.toLowerCase().replace(/[^a-z]/g, "");
}

function nomeDenuncia(chave: string): boolean {
  const limpo = normalizarChave(chave);
  return NOMES_RECUSADOS.some((n) => limpo.includes(n));
}

function nomeDeCodigo(chave: string): boolean {
  const limpo = normalizarChave(chave);
  return NOMES_DE_CODIGO.some((n) => limpo.includes(n));
}

function limparTexto(valor: string, campoDeCodigo: boolean): { texto: string; tipos: string[] } {
  let texto = valor;
  const tipos: string[] = [];
  for (const { tipo, re, valeEmCampoDeCodigo } of PADROES) {
    if (campoDeCodigo && !valeEmCampoDeCodigo) continue;
    // `re` é global e guarda `lastIndex` entre usos: zerar antes de cada valor.
    re.lastIndex = 0;
    if (!re.test(texto)) continue;
    re.lastIndex = 0;
    texto = texto.replace(re, MARCA_DE_REMOCAO);
    tipos.push(tipo);
  }
  return { texto, tipos };
}

export interface ArgumentosLimpos {
  /** O argumento pronto para sair, com o que era dado pessoal substituído. */
  limpos: Record<string, unknown>;
  /**
   * Um item por campo recusado, no formato `caminho:tipo`. Vai para o log;
   * NUNCA carrega o valor recusado.
   */
  recusados: string[];
}

/**
 * Limpa o argumento que o modelo montou para uma ferramenta externa.
 *
 * `idsConhecidos` são os ids desta instalação que o turno tem em mãos
 * (organização, agente, job): recusados por valor exato, em qualquer campo.
 *
 * Nunca lança: argumento estranho (função, símbolo, ciclo) vira `null` em vez
 * de derrubar o turno. Um turno que morre por causa da trava seria pior que o
 * vazamento que ela evita, porque o atendimento para.
 */
export function limparArgumentosExternos(
  args: unknown,
  idsConhecidos: readonly (string | null | undefined)[] = [],
): ArgumentosLimpos {
  const recusados: string[] = [];
  const vistos = new WeakSet<object>();
  const ids = idsConhecidos.filter((v): v is string => typeof v === "string" && v.length >= 8);

  const trocarIds = (texto: string): { texto: string; achou: boolean } => {
    let saida = texto;
    let achou = false;
    for (const id of ids) {
      if (!saida.toLowerCase().includes(id.toLowerCase())) continue;
      achou = true;
      saida = saida.replace(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), MARCA_DE_REMOCAO);
    }
    return { texto: saida, achou };
  };

  const andar = (valor: unknown, caminho: string, nivel: number, campoDeCodigo: boolean): unknown => {
    if (nivel > PROFUNDIDADE_MAXIMA) return null;
    if (typeof valor === "string") {
      const porId = trocarIds(valor);
      if (porId.achou) recusados.push(`${caminho}:id_da_instalacao`);
      const { texto, tipos } = limparTexto(porId.texto, campoDeCodigo);
      for (const tipo of tipos) recusados.push(`${caminho}:${tipo}`);
      return texto;
    }
    if (typeof valor === "number" || typeof valor === "boolean" || valor === null) {
      // Número não se limpa: trocar por texto quebraria o esquema da
      // ferramenta. Telefone que chega como número é pego pelo nome do campo.
      return valor;
    }
    if (Array.isArray(valor)) {
      if (vistos.has(valor)) return null;
      vistos.add(valor);
      return valor.map((item, i) => andar(item, `${caminho}[${i}]`, nivel + 1, campoDeCodigo));
    }
    if (typeof valor === "object") {
      if (vistos.has(valor as object)) return null;
      vistos.add(valor as object);
      const saida: Record<string, unknown> = {};
      for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
        const abaixo = caminho ? `${caminho}.${chave}` : chave;
        if (nomeDenuncia(chave)) {
          if (v !== null && v !== undefined) recusados.push(`${abaixo}:nome_do_campo`);
          saida[chave] = MARCA_DE_REMOCAO;
          continue;
        }
        saida[chave] = andar(v, abaixo, nivel + 1, campoDeCodigo || nomeDeCodigo(chave));
      }
      return saida;
    }
    // Função, símbolo, `undefined`: não sairiam num JSON de qualquer jeito.
    return null;
  };

  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    // O protocolo MCP exige objeto na raiz; qualquer outra coisa vira vazio,
    // como `buildExternalMcpTools` já fazia com `args ?? {}`.
    return { limpos: {}, recusados };
  }
  const limpos = andar(args, "", 0, false) as Record<string, unknown>;
  return { limpos, recusados };
}
