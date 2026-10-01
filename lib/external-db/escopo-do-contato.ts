/**
 * ESCOPO DO CONTATO na leitura do banco externo pela IA (D-146).
 *
 * ═══ O PROBLEMA ═══
 *
 * `crm_query_external_data` recebe tabela, filtros e colunas do MODELO. Numa
 * conversa de WhatsApp, quem decide o que o modelo pede é o cliente: "consulte o
 * pedido do CPF 123" ou "liste os últimos pedidos" devolvia nome, endereço e
 * pedidos de OUTROS clientes da loja, e dali à resposta. O aviso "trate como
 * dado" protege contra instrução escondida, não contra o próprio cliente
 * pedindo dado de outra pessoa.
 *
 * ═══ A REGRA ═══
 *
 * Tabela que guarda dado de PESSOA (pelo nome da tabela ou das colunas) só é lida
 * ancorada no cliente da conversa, e com colunas explícitas:
 *
 *  1. a consulta tem de trazer um filtro de identidade cujo valor é do CONTATO
 *     do turno: telefone ou e-mail dele (coluna de telefone/e-mail, valor
 *     igual ao cadastro), ou, para uma segunda tabela, um identificador que uma
 *     consulta JÁ ancorada devolveu neste turno ("prova encadeada": o cliente
 *     achado pelo telefone tem `id` 55, e só então `pedidos.cliente_id = 55`);
 *  2. `colunas` não pode faltar (sem isto a consulta devolvia a linha inteira).
 *
 * Tabela sem dado de pessoa (catálogo de produtos) segue como sempre.
 *
 * ⚠️ O que isto NÃO é: lista de tabelas liberadas por conexão, escolhida pelo
 * administrador. A classificação é por NOME, e tabela de pessoa com nome e
 * colunas neutros escapa. Configuração por conexão é o passo seguinte (decisão
 * de produto + tela), registrado no D-146.
 */

/** Quem é o cliente do turno, como o banco externo poderia chamá-lo. */
export interface IdentidadeDoContato {
  telefones: readonly string[];
  emails: readonly string[];
}

/** Estado do turno: o que as consultas ancoradas já provaram ser do contato. */
export interface MemoriaDoEscopoExterno {
  /** Valores de colunas-identificador de linhas que vieram de consulta ancorada. */
  conhecidos: Set<string>;
}

const normalizar = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");

const SO_DIGITOS = (v: string): string => v.replace(/\D+/g, "");

/** Telefone sem o 55 de país e sem zero de tronco: DDD + número. */
function nacional(digitos: string): string {
  let d = digitos.replace(/^0+/, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  return d;
}

/** DDD + os 8 últimos dígitos: absorve o nono dígito presente num lado e ausente no outro. */
function chaveDeTelefone(valor: string): string | null {
  const d = nacional(SO_DIGITOS(valor));
  if (d.length < 10) return null;
  return d.slice(0, 2) + d.slice(-8);
}

export function mesmoTelefone(valor: unknown, telefoneDoContato: string): boolean {
  if (typeof valor !== "string" && typeof valor !== "number") return false;
  const a = chaveDeTelefone(String(valor));
  const b = chaveDeTelefone(telefoneDoContato);
  return a !== null && a === b;
}

const COLUNA_DE_TELEFONE = /(telefone|fone|celular|phone|mobile|whatsapp|wpp)|(^|_)(tel|cel|zap)(\d|_|$)/;
const COLUNA_DE_EMAIL = /e_?mail/;
const COLUNA_DE_DADO_PESSOAL =
  /(cpf|cnpj|documento|document|endereco|address|logradouro|nascimento|birth)|(^|_)(rg|cep|zip)(_|$)/;
const COLUNA_DE_REFERENCIA_A_PESSOA = /(^|_)(cliente|customer|paciente|comprador|buyer|contato|contact)(s)?(_|$)/;
const TABELA_DE_PESSOA =
  /(client|customer|contat|pessoa|paciente|usuari|pedido|order|venda|sale|assinatura|subscri|fatura|invoice|cobranca|pagamento|payment|ticket|chamado|lead|agendamento|appointment)/;
/** Chave PRÓPRIA da linha: é o que, numa tabela de cliente, identifica o cliente. */
const COLUNA_DE_CHAVE_PROPRIA = /^(id|uuid|codigo|cod)$/;
/** Coluna que aponta para o cliente em OUTRA tabela (`pedidos.cliente_id`). */
const COLUNA_QUE_APONTA_PARA_PESSOA = /(^|_)(cliente|customer|paciente|comprador|buyer|contato|contact)(s)?_(id|uuid|codigo|cod)$|^(id|cod|codigo)_(cliente|customer|paciente|comprador|buyer|contato|contact)$/;

export const ehColunaDeTelefone = (c: string): boolean => COLUNA_DE_TELEFONE.test(normalizar(c));
export const ehColunaDeEmail = (c: string): boolean => COLUNA_DE_EMAIL.test(normalizar(c));
const ehChavePropria = (c: string): boolean => COLUNA_DE_CHAVE_PROPRIA.test(normalizar(c));
const apontaParaPessoa = (c: string): boolean => COLUNA_QUE_APONTA_PARA_PESSOA.test(normalizar(c));

/** A tabela guarda dado de pessoa? Pelo nome dela e pelo das colunas. */
export function tabelaTemDadoDePessoa(tabela: string, colunas: readonly string[]): boolean {
  if (TABELA_DE_PESSOA.test(normalizar(tabela))) return true;
  return colunas.some((c) => {
    const n = normalizar(c);
    return (
      COLUNA_DE_TELEFONE.test(n) ||
      COLUNA_DE_EMAIL.test(n) ||
      COLUNA_DE_DADO_PESSOAL.test(n) ||
      COLUNA_DE_REFERENCIA_A_PESSOA.test(n)
    );
  });
}

type FiltroDaConsulta = { coluna: string; operador: string; valor?: unknown };

function valorEscalar(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}

/** Este filtro prova, pelo telefone ou e-mail do contato, que a consulta é sobre ele? */
function filtroAncoraPelaIdentidade(f: FiltroDaConsulta, identidade: IdentidadeDoContato): boolean {
  const valor = valorEscalar(f.valor);
  if (valor === null) return false;

  if (ehColunaDeTelefone(f.coluna)) {
    if (f.operador === "eq") return identidade.telefones.some((t) => mesmoTelefone(valor, t));
    // `contem` é o jeito de achar "(35) 99148-5627" sabendo só os dígitos. Só
    // vale com número de verdade (8+ dígitos) que esteja DENTRO do telefone do
    // contato, nunca um pedaço curto que casaria com meia loja.
    if (f.operador === "contem") {
      const d = nacional(SO_DIGITOS(valor));
      return d.length >= 8 && identidade.telefones.some((t) => nacional(SO_DIGITOS(t)).includes(d));
    }
    return false;
  }

  if (ehColunaDeEmail(f.coluna)) {
    return f.operador === "eq" && identidade.emails.some((e) => e.trim().toLowerCase() === valor.trim().toLowerCase());
  }
  return false;
}

/**
 * Prova encadeada: o identificador do cliente que uma consulta ancorada pelo
 * telefone/e-mail já devolveu, usado na coluna que aponta para o cliente
 * (`pedidos.cliente_id = 55`). Só essa coluna: um `id` solto de outra tabela
 * poderia coincidir com o do cliente e abrir o pedido de um desconhecido.
 */
function filtroAncoraPorProvaEncadeada(f: FiltroDaConsulta, conhecidos: ReadonlySet<string>): boolean {
  const valor = valorEscalar(f.valor);
  return valor !== null && f.operador === "eq" && apontaParaPessoa(f.coluna) && conhecidos.has(valor);
}

export type VereditoDaConsultaExterna =
  | { ok: true; ancorada: "identidade" | "encadeada" | false }
  | { ok: false; erro: "colunas_obrigatorias" | "consulta_sem_identidade"; mensagem: string };

/**
 * Decide se a consulta pode seguir no turno de um cliente. `ancorada` diz COMO
 * ela foi provada como do contato: só a que usou o telefone/e-mail dele
 * (`identidade`) alimenta a memória do turno; a encadeada nunca, senão um
 * identificador de pedido viraria "identificador de cliente".
 */
export function avaliarConsultaDoTurno(entrada: {
  tabela: string;
  colunasDaTabela: readonly string[];
  colunasPedidas: readonly string[];
  filtros: readonly FiltroDaConsulta[];
  identidade: IdentidadeDoContato;
  memoria: MemoriaDoEscopoExterno;
}): VereditoDaConsultaExterna {
  if (!tabelaTemDadoDePessoa(entrada.tabela, entrada.colunasDaTabela)) {
    return { ok: true, ancorada: false };
  }
  const { identidade, memoria } = entrada;

  if (entrada.colunasPedidas.length === 0) {
    return {
      ok: false,
      erro: "colunas_obrigatorias",
      mensagem:
        "esta tabela tem dados de clientes. Informe em `colunas` só os campos de que precisa para " +
        "responder (sem isso a consulta devolveria a linha inteira) e repita a chamada.",
    };
  }

  const porIdentidade = entrada.filtros.some((f) => filtroAncoraPelaIdentidade(f, identidade));
  const encadeada =
    !porIdentidade && entrada.filtros.some((f) => filtroAncoraPorProvaEncadeada(f, memoria.conhecidos));
  if (!porIdentidade && !encadeada) {
    const temComo = entrada.identidade.telefones.length > 0 || entrada.identidade.emails.length > 0;
    return {
      ok: false,
      erro: "consulta_sem_identidade",
      mensagem: temComo
        ? "esta tabela tem dados de clientes e só pode ser consultada para o cliente desta conversa. " +
          "Filtre pelo telefone ou e-mail DELE (coluna de telefone/e-mail igual ao cadastro desta conversa), " +
          "ou por um identificador devolvido numa consulta anterior que já usou o telefone ou e-mail dele. " +
          "Não consulte dados de outras pessoas, nem liste registros sem esse filtro."
        : "esta tabela tem dados de clientes, e este cliente não tem telefone nem e-mail cadastrado para " +
          "ligar a consulta a ele. Não consulte por dados que o cliente digitou: peça a uma pessoa da equipe.",
    };
  }
  return { ok: true, ancorada: porIdentidade ? "identidade" : "encadeada" };
}

/** Depois de uma consulta ancorada: guarda os identificadores que ela devolveu. */
export function lembrarIdentificadoresDaConsulta(
  memoria: MemoriaDoEscopoExterno,
  linhas: ReadonlyArray<Record<string, unknown>>,
): void {
  for (const linha of linhas.slice(0, 50)) {
    for (const [coluna, valor] of Object.entries(linha)) {
      if (!ehChavePropria(coluna)) continue;
      const v = valorEscalar(valor);
      if (v !== null) memoria.conhecidos.add(v);
    }
  }
}
