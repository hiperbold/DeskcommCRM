import "server-only";

/**
 * O serviço de compra do Asaas: fase F5, Tarefa 14 (`hiperbold/planos/fase-F5-tarefas.md`).
 * Decisões 1, 2, 4, 8, 13, 16, 17, 18, 25, 26; correções A2, A3, M9; riscos de
 * segurança 5, 6, 8, 11, 14.
 *
 * RESTRIÇÃO ABSOLUTA DESTA FASE: nenhuma chamada real ao Asaas sai daqui em
 * teste. `iniciarCompra`/`cancelarAssinaturaDoCliente` recebem tudo por
 * injeção (`DepsCompra`): o cliente Asaas (`lib/billing/asaas/cliente.ts`,
 * já testado com `fetch` falso) e o banco, por uma interface ESTREITA
 * (`DbCompra`), um método por RPC/leitura, no mesmo molde de
 * `ConferidorDeCarteiraDb` (`lib/billing/tokens/conferir-carteira.ts`), não
 * um `SupabaseClient` genérico. Isso deixa o dublê de teste trivial (um
 * objeto com as funções certas) e não amarra este arquivo a nenhum detalhe
 * de tabela ou de `rpc(...)`: a implementação real de `DbCompra`, contra o
 * Supabase de verdade, é trabalho da Tarefa 15 (fora desta tarefa; não
 * tocado aqui). Este arquivo só sabe orquestrar a SEQUÊNCIA de passos.
 *
 * ─── Organização, preço, plano e tokens sempre do banco (decisão 17) ──────
 *
 * `EntradaIniciarCompra` não tem nenhum campo de preço, plano resolvido ou
 * quantidade de tokens: só o CÓDIGO do plano/pacote que o cliente pediu.
 * `fn_billing_criar_pedido` (chamada por `DbCompra.criarPedido`) é quem
 * resolve preço e tokens no banco; toda leitura posterior (`DbCompra.
 * lerPedido`) também vem do banco. Não existe um caminho aqui que aceite um
 * valor em centavos vindo da entrada: mesmo que a AÇÃO do cliente (Tarefa
 * 15) fosse adulterada, este serviço não tem onde colocar esse valor.
 *
 * ─── Posse atômica antes de qualquer POST (decisão 25/A2/risco 14) ────────
 *
 * `DbCompra.tomarPedido` é o `fn_billing_pedido_tomar` da migração: só quem
 * ganha o `update` (`tomado: true`) segue para o cliente Asaas e para o
 * POST. Quem não ganha só LÊ o estado atual (`resolverRespostaPeloEstado`) e
 * NUNCA chama `deps.asaas`. Isso é testado direto: duas chamadas simultâneas
 * de `iniciarCompra` para o MESMO pedido, com um dublê de `tomarPedido` que
 * só deixa a primeira ganhar, provam que `deps.asaas.criarCobranca`/
 * `criarAssinatura` roda no máximo uma vez.
 *
 * ─── Pedido aberto retomado, qualquer que seja a chave (M9) ────────────────
 *
 * `resolverPedido` tenta `fn_billing_criar_pedido` primeiro; só quando o
 * banco recusa com `billing_pedido_aberto_existe` (a chave usada é
 * DIFERENTE da do pedido já aberto) é que busca o pedido aberto existente
 * (`DbCompra.buscarPedidoAbertoPorTipo`) e segue com ELE, sem nunca criar um
 * segundo pedido do mesmo tipo. Se esse pedido já tem cobrança registrada
 * (`aguardando_pagamento`), `iniciarCompra` devolve a URL/QR que já existem
 * e NUNCA repete o POST (`resolverRespostaPeloEstado` →
 * `devolverCobrancaJaRegistrada`, antes mesmo de tentar tomar a posse).
 *
 * ─── Chamada financeira nunca se repete cegamente (decisão 13) ────────────
 *
 * Quando o pedido chega a esta função já `inconclusivo` (POST anterior deu
 * timeout ou 5xx), `criarCobrancaOuAssinatura` primeiro busca o recurso por
 * `externalReference` (`buscarAssinaturaPorReferencia`/
 * `buscarCobrancaPorReferencia`, um `GET`) ANTES de cogitar um novo `POST`.
 * Achou: registra o que já existe e devolve, sem `POST` nenhum. Não achou:
 * segue para o `POST`, uma única vez: este arquivo nunca repete um `POST`
 * sozinho; a retentativa só acontece numa PRÓXIMA chamada de
 * `iniciarCompra` (nova requisição do cliente).
 *
 * ─── Dados do pagador nunca em log nem no banco (decisão 16) ──────────────
 *
 * `DadosPagador` (nome, documento, e-mail, celular) só viaja até
 * `deps.asaas.criarCliente(...)`. Nenhuma linha deste arquivo passa
 * `pagador` para `deps.logger.*` nem para `deps.db.*` (que só recebe o
 * `asaasCustomerId` DEPOIS de criado). `documentoValido` recusa um CPF/CNPJ
 * malformado ANTES de qualquer chamada de rede (risco: gastar uma chamada
 * com um documento obviamente errado, ou pior, o documento errado aparecer
 * num log de erro de rede).
 *
 * ─── URL de redirecionamento sempre validada de novo (risco 8) ────────────
 *
 * `fn_billing_pedido_registrar_cobranca` já recusa gravar uma `invoice_url`
 * fora do ambiente do próprio pedido; este arquivo AINDA reconfere
 * (`urlDeFaturaValida`) antes de devolver `{ tipo: "redirecionar" }`, tanto
 * no caminho que acabou de gravar quanto no caminho que está RETOMANDO uma
 * URL já gravada antes (defesa em profundidade: nunca confia cegamente numa
 * coluna do banco só porque uma função supostamente já validou).
 *
 * ─── `cancelarAssinaturaDoCliente`: o marcador de encerramento ────────────
 *
 * Correção 5 (revisão/auditoria da fase): depois de um `DELETE
 * /subscriptions/{id}` bem sucedido feito pelo próprio CRM,
 * `cancelarAssinaturaDoCliente` chama só `fn_billing_asaas_marcar_
 * assinatura_encerrada` (0909, Tarefa 6, decisão 22), sem passar antes por
 * `fn_billing_cancelar_no_fim_do_periodo` (0908): a função nova já liga
 * `cancel_at_period_end` e grava o evento de auditoria
 * (`billing_contract_eventos`, tipo `cancelar_no_fim`) sozinha, então a
 * chamada antiga só duplicava trabalho. Uma falha em
 * `marcarAssinaturaEncerrada` agora DEVOLVE ERRO (nunca mais "ok"): sem o
 * marcador, o contrato não ficou com `cancel_at_period_end` nem com o
 * rastro de auditoria, e afirmar sucesso seria mentir. Pedir para tentar de
 * novo é seguro: o `DELETE` já feito é idempotente (`removerAssinatura`
 * trata 404 como sucesso) e `marcarAssinaturaEncerrada` também é idempotente
 * (marcador já preenchido devolve `ja_registrado` sem repetir nada).
 *
 * ─── Correção 1 (revisão da fase): recuperação do inconclusivo nunca prende
 * o pedido em `processando` ────────────────────────────────────────────────
 *
 * `tomarPedido` já moveu o pedido para `processando` (posse atômica, decisão
 * 25) antes de `criarCobrancaOuAssinatura` tentar recuperar a assinatura/
 * cobrança pela `externalReference` (decisão 13, pedido veio `inconclusivo`).
 * Se essa CONSULTA falhar (timeout/429/5xx), o código antigo só devolvia
 * "aguarde" e deixava o pedido preso em `processando`: como `fn_billing_
 * pedido_tomar` só toma de `criado`/`inconclusivo` (nunca de `processando`),
 * nenhuma chamada seguinte de `iniciarCompra` conseguiria tomar posse de
 * novo, e o pedido ficaria parado até a conciliação diária (Tarefa 16)
 * alcançar. Agora, antes de devolver "aguarde", volta o pedido para
 * `inconclusivo` (`fn_billing_pedido_marcar`, válido porque o pedido está em
 * `processando`, PARTE 7 da migração 0909): uma TERCEIRA chamada de
 * `iniciarCompra` toma posse de novo e tenta a recuperação outra vez.
 *
 * ─── Correção 8 (revisão da fase): `invoice_url` fora do ambiente nunca
 * deixa uma assinatura/cobrança viva no Asaas sem ninguém tentando apagar ──
 *
 * Quando `fn_billing_pedido_registrar_cobranca` recusa a `invoice_url` por
 * estar fora do ambiente do próprio pedido, a assinatura ou a cobrança JÁ
 * FOI criada no Asaas (o `POST` teve sucesso; só a URL veio errada). Marcar
 * `falhou` sem remover essa assinatura/cobrança deixaria uma cobrança
 * fantasma cobrando sozinha por lá, sem ninguém tentando removê-la de novo
 * (o pedido `falhou` é terminal e a conciliação não mexe em pedido
 * terminal). `removerRecemCriadoOuMarcarInconclusivo` remove primeiro
 * (`removerAssinatura`/`removerCobranca`, idempotentes em 404); só DEPOIS
 * disso funcionar é que marca `falhou`. Se a remoção em si falhar, marca
 * `inconclusivo` em vez de `falhou`: a conciliação diária (Tarefa 16) refaz
 * a remoção, e o pedido continua retomável.
 */
import type { ClienteAsaasHttp } from "./cliente";
import type { AmbienteAsaas, ConfigAsaas } from "./config";
import type { AssinaturaAsaas, CicloAsaas, CobrancaAsaas } from "./contratos";
import { centavosParaReais, dataSaoPaulo } from "./dinheiro";
import { documentoValido } from "./documento";
import { calcularParcelamento, parcelasValidas, type ParametrosDeParcelamento } from "./parcelamento";
import { ErroAsaasException } from "./erros";

// ─── Tipos de entrada/saída ─────────────────────────────────────────────

export type TipoPedido = "assinatura" | "pacote_tokens";
export type MetodoPedido = "CREDIT_CARD" | "PIX";
export type CicloPedido = "monthly" | "semiannual" | "yearly";

/**
 * O ciclo do pedido no vocabulário do Asaas (D-176). Mensal, semestral e
 * anual viram assinatura `MONTHLY`, `SEMIANNUALLY` e `YEARLY` quando o método
 * é o cartão; no Pix o ciclo só decide o valor e o período (cobrança avulsa).
 */
export const CICLO_ASAAS_DO_PEDIDO: Record<CicloPedido, CicloAsaas> = {
  monthly: "MONTHLY",
  semiannual: "SEMIANNUALLY",
  yearly: "YEARLY",
};

const ROTULO_DO_CICLO_NA_DESCRICAO: Record<CicloPedido, string> = {
  monthly: "mensal",
  semiannual: "semestral",
  yearly: "anual",
};
export type StatusPedido =
  | "criado"
  | "processando"
  | "aguardando_pagamento"
  | "inconclusivo"
  | "pago"
  | "vencido"
  | "cancelado"
  | "falhou"
  | "estornado";

/**
 * Nome, CPF/CNPJ, e-mail e celular do pagador. Só usado para
 * `POST /customers`; nunca gravado no CRM, nunca logado (decisão 16).
 * Opcional em `EntradaIniciarCompra`: só é exigido quando a organização
 * AINDA não tem cliente Asaas (nem vínculo local, nem cliente achado pela
 * referência), normalmente a primeira compra.
 */
export interface DadosPagador {
  nome: string;
  documento: string;
  email?: string;
  celular?: string;
}

export interface EntradaIniciarCompra {
  /** Sempre da sessão de quem chama (Tarefa 15); nunca aceito daqui. */
  organizationId: string;
  actorId: string;
  tipo: TipoPedido;
  /** Só para `tipo: "assinatura"`. */
  planCode?: string;
  ciclo?: CicloPedido;
  /** Só para `tipo: "pacote_tokens"`. */
  pacote?: string;
  metodo: MetodoPedido;
  /** uuid do formulário, a chave de idempotência (decisão 13). */
  chave: string;
  pagador?: DadosPagador;
  /**
   * D-177: em quantas parcelas pagar no cartão (só semestral e anual). Ausente ou 1 = à vista. O
   * número é a ÚNICA coisa que vem do navegador: o total (com juros de 4x em diante) é calculado aqui, no
   * servidor, e o banco confere de novo ao criar o pedido.
   */
  parcelas?: number;
  /** D-133: a versão dos Termos de Uso que o cliente aceitou (`lib/legal/versao-dos-termos.ts`). Sem ela a compra é recusada. */
  termosVersao: string;
}

export interface QrPixResposta {
  encodedImage: string;
  payload: string;
  expirationDate: string | null;
}

export type ResultadoIniciarCompra =
  | { tipo: "redirecionar"; url: string }
  | { tipo: "pix"; pedidoId: string; qr: QrPixResposta }
  | { tipo: "erro"; mensagem: string };

export type ResultadoCancelarAssinatura =
  | { tipo: "ok"; cancelAtPeriodEnd: boolean }
  | { tipo: "erro"; mensagem: string };

// ─── A interface estreita do banco (implementação real: Tarefa 15) ────────

export interface RpcErro {
  code?: string;
  message?: string;
}

export interface RpcResultado<T> {
  data: T | null;
  error: RpcErro | null;
}

/** O que `fn_billing_criar_pedido` devolve (campos usados por este serviço). */
export interface PedidoCriado {
  pedidoId: string;
  externalReference: string;
  amountCents: number;
  parcelas?: number;
  jaExistia: boolean;
  /** `AAAA-MM-DD`, só quando o período do contrato ainda está no futuro (decisão 26). */
  proximaCobrancaEm: string | null;
}

/** O que `fn_billing_pedido_tomar` devolve. */
export interface PedidoTomado {
  tomado: boolean;
  pedidoId: string;
  status: StatusPedido;
}

/**
 * A linha completa do pedido (leitura pura, sem `rpc`), com o nome do plano
 * ou do pacote já resolvido para montar a `description` sem dado pessoal
 * (decisão 4). A implementação real (Tarefa 15) faz o `join` com
 * `billing_plans`/`billing_token_pacotes`; este arquivo só consome o
 * resultado.
 */
export interface PedidoLinha {
  id: string;
  status: StatusPedido;
  tipo: TipoPedido;
  ambiente: AmbienteAsaas;
  metodo: MetodoPedido;
  amountCents: number;
  externalReference: string;
  asaasPaymentId: string | null;
  asaasSubscriptionId: string | null;
  invoiceUrl: string | null;
  /** D-177: 1 = à vista; de 2 em diante é cobrança parcelada avulsa (`amountCents` é o total com juros). */
  parcelas?: number;
  asaasInstallmentId?: string | null;
  ciclo: CicloPedido | null;
  planoNome: string | null;
  pacoteNome: string | null;
  /** `billing_plans.code` (correção 3/M9): compara a oferta do pedido aberto retomado com a que a entrada pediu agora. */
  planCode: string | null;
  /** `billing_token_pacotes.codigo` (correção 3/M9), mesmo racional de `planCode`. */
  pacoteCode: string | null;
  /**
   * `billing_orders.updated_at` (ISO 8601), correção 10 (revisão da fase,
   * tarefa 17): `cancelarPedidoAberto` (`app/actions/admin/cobrancaAsaas.ts`)
   * usa este campo para recusar cancelar um pedido `processando` há MENOS de
   * 15 minutos (o `POST` ao Asaas pode ainda estar em voo).
   */
  atualizadoEm: string;
}

export interface VinculoClienteAsaas {
  asaasCustomerId: string;
}

export interface ContratoAsaas {
  asaasSubscriptionId: string | null;
  asaasAssinaturaEncerradaEm: string | null;
  /**
   * `billing_contracts.current_period_end` (correção 3/M9): decisão 26 na
   * retomada de um pedido aberto (`fn_billing_criar_pedido` não roda nesse
   * caminho, então quem calcula a próxima cobrança é este arquivo).
   */
  currentPeriodEnd: string | null;
}

export interface DbCompra {
  /** `fn_billing_criar_pedido`. */
  criarPedido(args: {
    org: string;
    tipo: TipoPedido;
    planCode: string | null;
    ciclo: CicloPedido | null;
    pacote: string | null;
    metodo: MetodoPedido;
    ambiente: AmbienteAsaas;
    chave: string;
    actor: string;
    termosVersao: string | null;
    parcelas: number;
    /** D-177: o total que o servidor calculou, só para o banco conferir (nulo à vista). */
    totalCents: number | null;
  }): Promise<RpcResultado<PedidoCriado>>;

  /** D-177: o preço do ciclo do plano e os parâmetros de parcelamento de `billing_settings` (leitura pura). */
  lerParcelamentoDoPlano(
    planCode: string,
    ciclo: CicloPedido,
  ): Promise<RpcResultado<{ precoCents: number | null; parametros: ParametrosDeParcelamento }>>;

  /** D-177: `fn_billing_pedido_registrar_parcelamento`. */
  registrarParcelamento(
    org: string,
    pedidoId: string,
    asaasInstallmentId: string,
  ): Promise<RpcResultado<{ jaRegistrado: boolean }>>;

  /** Leitura pura: pedido aberto (`criado`/`aguardando_pagamento`/`inconclusivo`/`processando`) do mesmo tipo, se houver (M9). */
  buscarPedidoAbertoPorTipo(org: string, tipo: TipoPedido): Promise<RpcResultado<PedidoLinha | null>>;

  /** `fn_billing_pedido_tomar`. */
  tomarPedido(org: string, pedidoId: string): Promise<RpcResultado<PedidoTomado>>;

  /** Leitura pura, autoritativa, da linha do pedido. */
  lerPedido(org: string, pedidoId: string): Promise<RpcResultado<PedidoLinha | null>>;

  /** Leitura pura de `billing_customers`. */
  buscarVinculoClienteAsaas(org: string, ambiente: AmbienteAsaas): Promise<RpcResultado<VinculoClienteAsaas | null>>;

  /** `fn_billing_vincular_cliente_asaas`. */
  vincularClienteAsaas(
    org: string,
    ambiente: AmbienteAsaas,
    asaasCustomerId: string,
  ): Promise<RpcResultado<{ jaExistia: boolean; asaasCustomerId: string }>>;

  /** `fn_billing_pedido_registrar_cobranca`. */
  registrarCobranca(args: {
    org: string;
    pedidoId: string;
    asaasPaymentId: string | null;
    asaasSubscriptionId: string | null;
    invoiceUrl: string | null;
  }): Promise<RpcResultado<{ jaRegistrado: boolean; pedidoId: string; status: StatusPedido }>>;

  /** `fn_billing_pedido_marcar`. */
  marcarPedido(
    org: string,
    pedidoId: string,
    status: "inconclusivo" | "falhou" | "cancelado",
    motivo: string,
  ): Promise<RpcResultado<{ pedidoId: string; statusAnterior: StatusPedido; statusNovo: StatusPedido }>>;

  /** Leitura pura de `billing_contracts` (campos usados por `cancelarAssinaturaDoCliente` e pela retomada M9, correção 3). */
  lerContrato(org: string): Promise<RpcResultado<ContratoAsaas | null>>;

  /** `fn_billing_asaas_marcar_assinatura_encerrada` (migração 0909, Tarefa 6, decisão 22). */
  marcarAssinaturaEncerrada(
    org: string,
    asaasSubscriptionId: string,
    actor: string,
  ): Promise<RpcResultado<{ jaRegistrado: boolean; asaasAssinaturaEncerradaEm: string }>>;
}

export interface LoggerCompra {
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface DepsCompra {
  db: DbCompra;
  asaas: ClienteAsaasHttp;
  config: ConfigAsaas;
  logger: LoggerCompra;
  /** Injetável só para teste; padrão `() => new Date()`. */
  agora?: () => Date;
  /**
   * COB-07: chamado DEPOIS de o cancelamento estar gravado, com a assinatura cancelada (a chave de
   * idempotência do e-mail). Opcional; quem não passa não manda e-mail. Nunca desfaz nem muda o resultado do
   * cancelamento: o gatilho engole a própria falha, e `avisarCancelamento` engole a que escapar.
   */
  avisoDeCancelamento?: (cancelamento: { organizationId: string; asaasSubscriptionId: string }) => Promise<void>;
}

// ─── Mensagens fixas (risco 13: nunca a mensagem crua do Asaas na tela) ────

export const MENSAGEM_GENERICA =
  "Não foi possível concluir a compra agora. Tente novamente em instantes ou fale com o suporte.";
export const MENSAGEM_AGUARDE =
  "Não foi possível confirmar agora. Aguarde a confirmação do pagamento e tente novamente em instantes.";
export const MENSAGEM_VALIDACAO =
  "Não foi possível concluir a compra com os dados informados. Confira os dados e tente novamente.";
export const MENSAGEM_DOCUMENTO_INVALIDO = "O CPF ou CNPJ informado é inválido.";
export const MENSAGEM_PEDIDO_JA_PAGO = "Este pedido já foi pago.";
export const MENSAGEM_PAGADOR_OBRIGATORIO =
  "Informe seus dados de pagamento para concluir a primeira compra.";
export const MENSAGEM_SEM_ASSINATURA_ASAAS =
  "Esta organização não tem uma assinatura Asaas ativa para cancelar.";
export const MENSAGEM_TROCA_DE_CICLO =
  "Sua assinatura atual ainda está no período pago em outro ciclo. A troca de ciclo ainda não está disponível: fale com o suporte ou contrate de novo depois do fim do período.";
/** 0942: `billing_troca_de_plano_indisponivel`. A tela passa esta frase por `t()` (es e zh-CN em `lib/i18n`). */
export const MENSAGEM_TROCA_DE_PLANO =
  "Sua assinatura atual ainda está no período pago de outro plano. A troca de plano ainda não está disponível: fale com o suporte ou contrate de novo depois do fim do período.";
/** D-133: compra sem o aceite dos Termos de Uso. */
export const MENSAGEM_TERMOS_NAO_ACEITOS = "Aceite os Termos de Uso para continuar.";
/** D-177: parcelamento fora da regra (ciclo, método, teto). */
export const MENSAGEM_PARCELAMENTO_INDISPONIVEL =
  "O parcelamento só está disponível no cartão de crédito, no plano semestral (até 6x) e no anual (até 12x).";
export const MENSAGEM_OUTRA_OFERTA_ABERTA =
  "Há um pedido em aberto de outra opção. Conclua ou peça para cancelar antes de escolher outra.";

// ─── Ajudantes ──────────────────────────────────────────────────────────

/**
 * A mesma amarra de `fn_billing_pedido_registrar_cobranca` (decisão 5/B7),
 * reconferida em TypeScript antes de qualquer `{ tipo: "redirecionar" }`
 * (risco 8: redirecionamento aberto).
 */
function urlDeFaturaValida(ambiente: AmbienteAsaas, url: string): boolean {
  if (ambiente === "sandbox") return /^https:\/\/sandbox\.asaas\.com\//.test(url);
  return /^https:\/\/(www\.)?asaas\.com\//.test(url);
}

function contemCodigo(erro: RpcErro | null | undefined, codigo: string): boolean {
  return Boolean(erro?.message?.includes(codigo));
}

/**
 * Traduz os `22023`/`P0002` de `fn_billing_criar_pedido` (comentário da
 * própria função, migração 0909) para a frase que a tela mostra.
 * `billing_pedido_aberto_existe` NUNCA chega aqui: é tratado à parte, como
 * retomada (M9), antes desta função ser chamada.
 */
function mensagemDoErroDoPedido(erro: RpcErro): string {
  if (contemCodigo(erro, "billing_compra_desligada")) {
    return "A compra pela tela ainda não está disponível. Fale com o suporte.";
  }
  if (contemCodigo(erro, "billing_plano_fora_de_venda")) {
    return "Este plano não está disponível para compra no momento.";
  }
  if (contemCodigo(erro, "billing_preco_nao_definido")) {
    return "O preço desta oferta ainda não foi definido.";
  }
  if (contemCodigo(erro, "billing_metodo_invalido_para_oferta")) {
    return "Essa forma de pagamento não está disponível para esta oferta.";
  }
  if (contemCodigo(erro, "billing_troca_de_ciclo_indisponivel")) {
    return MENSAGEM_TROCA_DE_CICLO;
  }
  if (contemCodigo(erro, "billing_troca_de_plano_indisponivel")) {
    return MENSAGEM_TROCA_DE_PLANO;
  }
  if (contemCodigo(erro, "billing_termos_nao_aceitos") || contemCodigo(erro, "billing_termos_invalidos")) {
    return MENSAGEM_TERMOS_NAO_ACEITOS;
  }
  if (contemCodigo(erro, "billing_parcelamento_") || contemCodigo(erro, "billing_parcelas_")) {
    return MENSAGEM_PARCELAMENTO_INDISPONIVEL;
  }
  if (contemCodigo(erro, "billing_ja_tem_assinatura_asaas")) {
    return "Sua organização já tem uma assinatura ativa.";
  }
  if (contemCodigo(erro, "billing_chave_com_valores_diferentes")) {
    return "Esta solicitação já foi usada com dados diferentes. Recarregue a página e tente de novo.";
  }
  if (contemCodigo(erro, "plano_nao_encontrado_ou_inativo") || contemCodigo(erro, "pacote_nao_encontrado_ou_inativo")) {
    return "Oferta não encontrada.";
  }
  return MENSAGEM_GENERICA;
}

function montarDescricao(pedido: PedidoLinha): string {
  if (pedido.tipo === "assinatura") {
    const periodo = pedido.ciclo ? ROTULO_DO_CICLO_NA_DESCRICAO[pedido.ciclo] : "mensal";
    const plano = pedido.planoNome ?? "assinatura";
    const parcelas = (pedido.parcelas ?? 1) > 1 ? ` em ${pedido.parcelas}x` : "";
    return `HiperCRM, plano ${plano} ${periodo}${parcelas}`;
  }
  const pacote = pedido.pacoteNome ?? "pacote de tokens";
  return `HiperCRM, ${pacote}`;
}

function relogio(deps: DepsCompra): Date {
  return (deps.agora ?? (() => new Date()))();
}

/** Mesmo ajudante de `lib/billing/asaas/processar-eventos.ts`: só o `tipo` tipado do erro, nunca a mensagem crua do Asaas (risco 13). */
function tipoDoErro(err: unknown): string {
  return err instanceof ErroAsaasException ? err.erro.tipo : "desconhecido";
}

/** `AAAA-MM-DD` de amanhã em São Paulo (decisão 4: `dueDate` do Pix). */
function amanhaSaoPaulo(agora: Date): string {
  return dataSaoPaulo(new Date(agora.getTime() + 24 * 60 * 60 * 1000));
}

// ─── Passo 1: resolver o pedido (criar, reaproveitar pela chave, ou M9) ────

type ResolucaoPedido =
  | { tipo: "ok"; pedidoId: string; proximaCobrancaEm: string | null }
  | { tipo: "erro"; mensagem: string };

/**
 * M9/correção 3: só retoma um pedido aberto do mesmo tipo quando plano,
 * ciclo e método também batem com o que a entrada pediu AGORA. Comparar só
 * o tipo (M9 original) deixava alguém que pediu Pro mensal cartão ser
 * silenciosamente jogado para dentro de um pedido aberto de outra oferta
 * (ex.: Ilimitado anual Pix) criado minutos antes.
 */
function mesmaOfertaDoPedidoAberto(pedido: PedidoLinha, entrada: EntradaIniciarCompra): boolean {
  if (pedido.metodo !== entrada.metodo) return false;
  if (pedido.tipo === "assinatura") {
    if ((pedido.parcelas ?? 1) !== (entrada.parcelas ?? 1)) return false;
    return pedido.planCode === (entrada.planCode ?? null) && pedido.ciclo === (entrada.ciclo ?? null);
  }
  return pedido.pacoteCode === (entrada.pacote ?? null);
}

async function resolverPedido(
  deps: DepsCompra,
  entrada: EntradaIniciarCompra,
  ambiente: AmbienteAsaas,
): Promise<ResolucaoPedido> {
  // D-177: o total do parcelamento é calculado AQUI, no servidor, com o preço e os parâmetros do banco; o
  // navegador só escolheu o número de parcelas. O banco confere o total de novo ao criar o pedido.
  const parcelas = entrada.parcelas ?? 1;
  let totalCents: number | null = null;
  if (parcelas !== 1) {
    if (
      entrada.tipo !== "assinatura" ||
      entrada.metodo !== "CREDIT_CARD" ||
      !entrada.planCode ||
      (entrada.ciclo !== "semiannual" && entrada.ciclo !== "yearly")
    ) {
      return { tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO_INDISPONIVEL };
    }
    const oferta = await deps.db.lerParcelamentoDoPlano(entrada.planCode, entrada.ciclo);
    if (oferta.error || !oferta.data || oferta.data.precoCents === null) {
      deps.logger.error("asaas_compra_ler_parcelamento_falhou", { org: entrada.organizationId, codigo: oferta.error?.code });
      return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
    }
    if (!parcelasValidas(entrada.ciclo, parcelas, oferta.data.parametros)) {
      return { tipo: "erro", mensagem: MENSAGEM_PARCELAMENTO_INDISPONIVEL };
    }
    totalCents = calcularParcelamento(oferta.data.precoCents, parcelas, oferta.data.parametros).totalCents;
  }

  const criado = await deps.db.criarPedido({
    org: entrada.organizationId,
    tipo: entrada.tipo,
    planCode: entrada.planCode ?? null,
    ciclo: entrada.ciclo ?? null,
    pacote: entrada.pacote ?? null,
    metodo: entrada.metodo,
    ambiente,
    chave: entrada.chave,
    actor: entrada.actorId,
    termosVersao: entrada.termosVersao,
    parcelas,
    totalCents,
  });

  if (!criado.error) {
    if (!criado.data) {
      deps.logger.error("asaas_compra_criar_pedido_sem_dados", { org: entrada.organizationId });
      return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
    }
    return { tipo: "ok", pedidoId: criado.data.pedidoId, proximaCobrancaEm: criado.data.proximaCobrancaEm };
  }

  // M9: pedido aberto do MESMO TIPO já existe, qualquer que seja a chave
  // desta chamada. Retoma esse pedido; nunca cria um segundo.
  if (contemCodigo(criado.error, "billing_pedido_aberto_existe")) {
    const aberto = await deps.db.buscarPedidoAbertoPorTipo(entrada.organizationId, entrada.tipo);
    if (aberto.error || !aberto.data) {
      deps.logger.error("asaas_compra_pedido_aberto_nao_encontrado", {
        org: entrada.organizationId,
        tipo: entrada.tipo,
        codigo: aberto.error?.code,
      });
      return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
    }
    if (!mesmaOfertaDoPedidoAberto(aberto.data, entrada)) {
      // Correção 3: nunca retoma silenciosamente um pedido de outra oferta;
      // nunca chega a fazer POST nenhum neste caminho.
      return { tipo: "erro", mensagem: MENSAGEM_OUTRA_OFERTA_ABERTA };
    }

    let proximaCobrancaEm: string | null = null;
    if (aberto.data.tipo === "assinatura") {
      // Decisão 26 continua valendo na retomada (correção 3):
      // fn_billing_criar_pedido não rodou desta vez (a exceção que gerou
      // billing_pedido_aberto_existe não devolve dados), então este serviço
      // calcula a próxima cobrança a partir do CONTRATO, em vez de deixar
      // cair em "hoje" por omissão.
      const contrato = await deps.db.lerContrato(entrada.organizationId);
      if (contrato.error) {
        deps.logger.error("asaas_compra_ler_contrato_para_retomada_falhou", {
          org: entrada.organizationId,
          codigo: contrato.error.code,
        });
        return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
      }
      const fimPeriodo = contrato.data?.currentPeriodEnd;
      if (fimPeriodo && new Date(fimPeriodo).getTime() > relogio(deps).getTime()) {
        proximaCobrancaEm = dataSaoPaulo(new Date(fimPeriodo));
      }
    }

    return { tipo: "ok", pedidoId: aberto.data.id, proximaCobrancaEm };
  }

  deps.logger.warn("asaas_compra_pedido_recusado", {
    org: entrada.organizationId,
    tipo: entrada.tipo,
    codigo: criado.error.code,
  });
  return { tipo: "erro", mensagem: mensagemDoErroDoPedido(criado.error) };
}

// ─── Devolver o que um pedido em `aguardando_pagamento` já tem ─────────────

async function devolverCobrancaJaRegistrada(deps: DepsCompra, org: string, pedido: PedidoLinha): Promise<ResultadoIniciarCompra> {
  if (pedido.metodo === "CREDIT_CARD") {
    if (pedido.invoiceUrl) {
      if (!urlDeFaturaValida(pedido.ambiente, pedido.invoiceUrl)) {
        deps.logger.error("asaas_compra_invoice_url_invalida_na_retomada", { pedidoId: pedido.id });
        return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
      }
      return { tipo: "redirecionar", url: pedido.invoiceUrl };
    }
    // Correção 4: invoice_url ainda nula (a leitura da fatura, logo depois
    // do POST, falhou). Nunca um erro genérico permanente por isso:
    // reconsulta agora e registra; se falhar de novo, pede para aguardar.
    return reconsultarFaturaEDevolver(deps, org, pedido);
  }
  if (!pedido.asaasPaymentId) {
    deps.logger.error("asaas_compra_pix_sem_cobranca_na_retomada", { pedidoId: pedido.id });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  try {
    const qr = await deps.asaas.qrPix(pedido.asaasPaymentId);
    return {
      tipo: "pix",
      pedidoId: pedido.id,
      qr: { encodedImage: qr.encodedImage, payload: qr.payload, expirationDate: qr.expirationDate ?? null },
    };
  } catch {
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
}

/**
 * Correção 4: quando `aguardando_pagamento` chega com `invoice_url` nula no
 * fluxo de cartão (a leitura da fatura falhou bem depois de um POST que já
 * tinha sucesso), reconsulta agora, pela assinatura quando o pedido tem
 * `asaasSubscriptionId`, pela cobrança avulsa quando tem `asaasPaymentId`, e
 * REGISTRA o que achar (para a próxima chamada não precisar reconsultar de
 * novo). Uma consulta que falha de novo, ou que ainda não tem a fatura,
 * NUNCA vira erro permanente: sempre `MENSAGEM_AGUARDE`, para uma PRÓXIMA
 * chamada de `iniciarCompra` tentar de novo.
 */
async function reconsultarFaturaEDevolver(deps: DepsCompra, org: string, pedido: PedidoLinha): Promise<ResultadoIniciarCompra> {
  let cobranca: CobrancaAsaas | null = null;
  try {
    if (pedido.asaasSubscriptionId) {
      const cobrancas = await deps.asaas.listarCobrancasDaAssinatura(pedido.asaasSubscriptionId);
      cobranca = cobrancas[0] ?? null;
    } else if (pedido.asaasPaymentId) {
      const resultado = await deps.asaas.buscarCobranca(pedido.asaasPaymentId);
      cobranca = "removido" in resultado ? null : resultado;
    }
  } catch {
    deps.logger.warn("asaas_compra_reconsultar_fatura_falhou", { pedidoId: pedido.id });
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }

  if (!cobranca?.invoiceUrl) {
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }
  if (!urlDeFaturaValida(pedido.ambiente, cobranca.invoiceUrl)) {
    deps.logger.error("asaas_compra_invoice_url_fora_da_lista_na_retomada", { pedidoId: pedido.id });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }

  const registrado = await deps.db.registrarCobranca({
    org,
    pedidoId: pedido.id,
    asaasPaymentId: cobranca.id,
    asaasSubscriptionId: pedido.asaasSubscriptionId,
    invoiceUrl: cobranca.invoiceUrl,
  });
  if (registrado.error || !registrado.data) {
    deps.logger.error("asaas_compra_registrar_cobranca_na_retomada_falhou", {
      pedidoId: pedido.id,
      codigo: registrado.error?.code,
    });
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }

  return { tipo: "redirecionar", url: cobranca.invoiceUrl };
}

async function resolverRespostaPeloEstado(deps: DepsCompra, org: string, pedido: PedidoLinha): Promise<ResultadoIniciarCompra> {
  if (pedido.status === "aguardando_pagamento") return devolverCobrancaJaRegistrada(deps, org, pedido);
  if (pedido.status === "pago") return { tipo: "erro", mensagem: MENSAGEM_PEDIDO_JA_PAGO };
  if (pedido.status === "processando") return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  // "criado"/"inconclusivo" não deveriam chegar aqui vindos deste caminho
  // (são estados TOMÁVEIS); "vencido"/"cancelado"/"falhou"/"estornado" são
  // estados terminais: nenhum dos dois merece uma mensagem própria na tela.
  return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
}

// ─── Passo 3: cliente Asaas (vínculo local, depois referência, depois criar) ─

type ResultadoCliente =
  | { ok: true; asaasCustomerId: string }
  | { ok: false; mensagem: string; motivoInterno: string };

function tratarErroAsaasComoFalhaDeCliente(deps: DepsCompra, err: unknown): ResultadoCliente {
  const tipoErro = err instanceof ErroAsaasException ? err.erro.tipo : "desconhecido";
  deps.logger.error("asaas_compra_cliente_falhou", { tipoErro });
  return { ok: false, mensagem: MENSAGEM_GENERICA, motivoInterno: `cliente_asaas_${tipoErro}` };
}

async function resolverAsaasCustomerId(
  deps: DepsCompra,
  org: string,
  ambiente: AmbienteAsaas,
  pagador: DadosPagador | undefined,
): Promise<ResultadoCliente> {
  const vinculo = await deps.db.buscarVinculoClienteAsaas(org, ambiente);
  if (vinculo.error) {
    deps.logger.error("asaas_compra_ler_vinculo_falhou", { org, codigo: vinculo.error.code });
    return { ok: false, mensagem: MENSAGEM_GENERICA, motivoInterno: "ler_vinculo_cliente_falhou" };
  }
  if (vinculo.data) return { ok: true, asaasCustomerId: vinculo.data.asaasCustomerId };

  const referencia = `HC:org:${org}`;
  let asaasCustomerId: string;
  try {
    const existente = await deps.asaas.buscarClientePorReferencia(referencia);
    if (existente) {
      asaasCustomerId = existente.id;
    } else {
      if (!pagador) {
        return { ok: false, mensagem: MENSAGEM_PAGADOR_OBRIGATORIO, motivoInterno: "pagador_ausente" };
      }
      if (!documentoValido(pagador.documento)) {
        return { ok: false, mensagem: MENSAGEM_DOCUMENTO_INVALIDO, motivoInterno: "documento_invalido" };
      }
      const criado = await deps.asaas.criarCliente({
        name: pagador.nome,
        cpfCnpj: pagador.documento,
        email: pagador.email,
        mobilePhone: pagador.celular,
        externalReference: referencia,
      });
      asaasCustomerId = criado.id;
    }
  } catch (err) {
    return tratarErroAsaasComoFalhaDeCliente(deps, err);
  }

  const vinculado = await deps.db.vincularClienteAsaas(org, ambiente, asaasCustomerId);
  if (vinculado.error || !vinculado.data) {
    deps.logger.error("asaas_compra_vincular_cliente_falhou", { org, codigo: vinculado.error?.code });
    return { ok: false, mensagem: MENSAGEM_GENERICA, motivoInterno: "vincular_cliente_falhou" };
  }
  return { ok: true, asaasCustomerId };
}

// ─── Passos 4 e 5: cobrança/assinatura no Asaas + registrar no banco ───────

async function tratarErroDoPost(
  deps: DepsCompra,
  org: string,
  pedidoId: string,
  err: unknown,
): Promise<ResultadoIniciarCompra> {
  if (err instanceof ErroAsaasException) {
    const erro = err.erro;
    if (erro.inconclusivo) {
      // Timeout ou 5xx num POST: o pedido fica `inconclusivo` (decisão 13).
      // A retentativa (uma PRÓXIMA chamada) consulta por externalReference
      // antes de tentar de novo: nunca um segundo POST cego.
      deps.logger.warn("asaas_compra_post_inconclusivo", { pedidoId, tipoErro: erro.tipo });
      await deps.db.marcarPedido(org, pedidoId, "inconclusivo", `asaas_${erro.tipo}`);
      return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
    }
    if (erro.tipo === "validacao") {
      // 4xx de validação: falha definitiva. Nunca a mensagem crua do Asaas
      // (risco 13); só os `codes`, já extraídos pelo cliente HTTP, vão para
      // o log.
      deps.logger.error("asaas_compra_post_validacao_recusada", { pedidoId, codigos: erro.codigos });
      await deps.db.marcarPedido(org, pedidoId, "falhou", "asaas_validacao");
      return { tipo: "erro", mensagem: MENSAGEM_VALIDACAO };
    }
    deps.logger.error("asaas_compra_post_falhou", { pedidoId, tipoErro: erro.tipo });
    await deps.db.marcarPedido(org, pedidoId, "falhou", `asaas_${erro.tipo}`);
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  deps.logger.error("asaas_compra_post_erro_desconhecido", { pedidoId });
  await deps.db.marcarPedido(org, pedidoId, "falhou", "erro_desconhecido");
  return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
}

/**
 * Correção 8 (revisão da fase): antes de marcar o pedido `falhou` por
 * `invoice_url` fora do ambiente, a assinatura ou a cobrança JÁ FOI criada
 * no Asaas (o `POST` teve sucesso; só a URL veio errada) - remove essa
 * assinatura/cobrança recém-criada (`removerAssinatura`/`removerCobranca`,
 * idempotentes em 404) antes de marcar `falhou`, para não deixar uma
 * cobrança fantasma cobrando sozinha por lá (um pedido `falhou` é terminal;
 * nada mais tentaria removê-la depois). Se a REMOÇÃO em si falhar, marca
 * `inconclusivo` em vez de `falhou`: a conciliação diária (Tarefa 16) refaz
 * a remoção, e o pedido continua retomável (nunca morre com uma assinatura
 * viva no Asaas que ninguém mais tenta apagar).
 */
async function removerRecemCriadoOuMarcarInconclusivo(
  deps: DepsCompra,
  org: string,
  pedidoId: string,
  asaasSubscriptionId: string | null,
  asaasPaymentId: string | null,
  motivo: string,
  asaasInstallmentId: string | null = null,
): Promise<void> {
  try {
    if (asaasSubscriptionId) {
      await deps.asaas.removerAssinatura(asaasSubscriptionId);
    } else if (asaasInstallmentId) {
      // D-177: remove o parcelamento INTEIRO, nunca só a primeira parcela (as outras seguiriam pendentes).
      await deps.asaas.removerParcelamento(asaasInstallmentId);
    } else if (asaasPaymentId) {
      await deps.asaas.removerCobranca(asaasPaymentId);
    }
  } catch (err) {
    deps.logger.warn("asaas_compra_remover_apos_invoice_url_invalida_falhou", {
      pedidoId,
      tipoErro: tipoDoErro(err),
    });
    await deps.db.marcarPedido(org, pedidoId, "inconclusivo", `${motivo}_remocao_falhou`);
    return;
  }
  await deps.db.marcarPedido(org, pedidoId, "falhou", motivo);
}

/**
 * Grava a cobrança/assinatura (fn_billing_pedido_registrar_cobranca) e
 * devolve `{ tipo: "redirecionar" }` só quando a `invoiceUrl` bate com a
 * lista do ambiente do pedido (decisão 5/B7, risco 8). Usada tanto para uma
 * assinatura/cobrança recém-criada quanto para uma recuperada por
 * `externalReference` (decisão 13).
 */
async function registrarEDevolverCartao(
  deps: DepsCompra,
  org: string,
  pedido: PedidoLinha,
  asaasSubscriptionId: string | null,
  cobranca: CobrancaAsaas | null,
): Promise<ResultadoIniciarCompra> {
  const asaasPaymentId = cobranca?.id ?? null;
  const invoiceUrl = cobranca?.invoiceUrl ?? null;
  const asaasInstallmentId = (pedido.parcelas ?? 1) > 1 ? (cobranca?.installment ?? null) : null;

  // D-177: o id do parcelamento vai para o pedido ANTES da cobrança ser registrada. Sem ele não dá para
  // remover o parcelamento inteiro se o pedido vencer; falhar aqui deixa o pedido em `processando` e a
  // retomada acha o parcelamento pela referência.
  if ((pedido.parcelas ?? 1) > 1) {
    if (!asaasInstallmentId) {
      deps.logger.error("asaas_compra_parcelamento_sem_id", { pedidoId: pedido.id });
      return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
    }
    const reg = await deps.db.registrarParcelamento(org, pedido.id, asaasInstallmentId);
    if (reg.error) {
      deps.logger.error("asaas_compra_registrar_parcelamento_falhou", { pedidoId: pedido.id, codigo: reg.error.code });
      return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
    }
  }

  const registrado = await deps.db.registrarCobranca({ org, pedidoId: pedido.id, asaasPaymentId, asaasSubscriptionId, invoiceUrl });
  if (registrado.error) {
    if (contemCodigo(registrado.error, "billing_invoice_url_fora_do_ambiente")) {
      deps.logger.error("asaas_compra_invoice_url_fora_do_ambiente", { pedidoId: pedido.id });
      await removerRecemCriadoOuMarcarInconclusivo(
        deps,
        org,
        pedido.id,
        asaasSubscriptionId,
        asaasPaymentId,
        "invoice_url_fora_do_ambiente",
        asaasInstallmentId,
      );
      return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
    }
    deps.logger.error("asaas_compra_registrar_cobranca_falhou", { pedidoId: pedido.id, codigo: registrado.error.code });
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }
  if (!registrado.data) {
    deps.logger.error("asaas_compra_registrar_cobranca_sem_dados", { pedidoId: pedido.id });
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }

  if (!invoiceUrl) {
    // A assinatura/cobrança já existe no Asaas, mas ainda não temos a
    // fatura (ex.: o Asaas ainda não gerou o primeiro pagamento). Nunca
    // inventa uma URL: uma nova chamada de iniciarCompra (M9) retoma este
    // mesmo pedido, agora `aguardando_pagamento`, e tenta ler de novo.
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }
  if (!urlDeFaturaValida(pedido.ambiente, invoiceUrl)) {
    // D-072: esta segunda validação (TS) roda DEPOIS de `registrarCobranca`
    // já ter tido sucesso: o banco (`fn_billing_pedido_registrar_cobranca`)
    // aceitou a mesma `invoiceUrl`, então hoje este ramo é inalcançável (o
    // banco valida a mesma lista de endereços antes). Mesmo assim, se um dia
    // divergir, trata a recusa como o outro caminho (`billing_invoice_url_
    // fora_do_ambiente`, registrado acima): remove no Asaas o recurso que
    // acabou de ser criado, para não deixar uma cobrança fantasma cobrando
    // sozinha por lá.
    deps.logger.error("asaas_compra_invoice_url_fora_da_lista", { pedidoId: pedido.id });
    await removerRecemCriadoOuMarcarInconclusivo(
      deps,
      org,
      pedido.id,
      asaasSubscriptionId,
      asaasPaymentId,
      "invoice_url_fora_da_lista_ts",
      asaasInstallmentId,
    );
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  return { tipo: "redirecionar", url: invoiceUrl };
}

async function registrarEDevolverPix(deps: DepsCompra, org: string, pedido: PedidoLinha, cobranca: CobrancaAsaas): Promise<ResultadoIniciarCompra> {
  const registrado = await deps.db.registrarCobranca({
    org,
    pedidoId: pedido.id,
    asaasPaymentId: cobranca.id,
    asaasSubscriptionId: null,
    invoiceUrl: null,
  });
  if (registrado.error || !registrado.data) {
    deps.logger.error("asaas_compra_registrar_cobranca_falhou", { pedidoId: pedido.id, codigo: registrado.error?.code });
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }
  try {
    const qr = await deps.asaas.qrPix(cobranca.id);
    return {
      tipo: "pix",
      pedidoId: pedido.id,
      qr: { encodedImage: qr.encodedImage, payload: qr.payload, expirationDate: qr.expirationDate ?? null },
    };
  } catch {
    // A cobrança já está registrada; o QR não veio agora, mas uma nova
    // chamada de iniciarCompra (M9, aguardando_pagamento) busca de novo.
    return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
  }
}

async function criarAssinaturaEDevolver(
  deps: DepsCompra,
  org: string,
  pedido: PedidoLinha,
  asaasCustomerId: string,
  descricao: string,
  proximaCobrancaEm: string | null,
  agora: Date,
): Promise<ResultadoIniciarCompra> {
  const nextDueDate = proximaCobrancaEm ?? dataSaoPaulo(agora);
  let assinatura: AssinaturaAsaas;
  try {
    assinatura = await deps.asaas.criarAssinatura({
      customer: asaasCustomerId,
      billingType: "CREDIT_CARD",
      value: centavosParaReais(pedido.amountCents),
      nextDueDate,
      cycle: CICLO_ASAAS_DO_PEDIDO[pedido.ciclo ?? "monthly"],
      description: descricao,
      externalReference: pedido.externalReference,
    });
  } catch (err) {
    return tratarErroDoPost(deps, org, pedido.id, err);
  }

  let primeiraCobranca: CobrancaAsaas | null = null;
  try {
    const cobrancas = await deps.asaas.listarCobrancasDaAssinatura(assinatura.id);
    primeiraCobranca = cobrancas[0] ?? null;
  } catch {
    // Sem a fatura por agora; registrarEDevolverCartao lida com
    // `invoiceUrl: null` sem inventar nada.
  }
  return registrarEDevolverCartao(deps, org, pedido, assinatura.id, primeiraCobranca);
}

/**
 * D-177: cobrança PARCELADA no cartão (2x a 12x), sem assinatura: `installmentCount` + `totalValue` (o total
 * do pedido, com juros de 4x em diante), vencimento hoje. O Asaas devolve a primeira parcela, com o id do
 * parcelamento. Não renova sozinha.
 */
async function criarCobrancaParceladaEDevolver(
  deps: DepsCompra,
  org: string,
  pedido: PedidoLinha,
  asaasCustomerId: string,
  descricao: string,
  agora: Date,
): Promise<ResultadoIniciarCompra> {
  let cobranca: CobrancaAsaas;
  try {
    cobranca = await deps.asaas.criarCobrancaParcelada({
      customer: asaasCustomerId,
      billingType: "CREDIT_CARD",
      installmentCount: pedido.parcelas ?? 1,
      totalValue: centavosParaReais(pedido.amountCents),
      dueDate: dataSaoPaulo(agora),
      description: descricao,
      externalReference: pedido.externalReference,
    });
  } catch (err) {
    return tratarErroDoPost(deps, org, pedido.id, err);
  }
  return registrarEDevolverCartao(deps, org, pedido, null, cobranca);
}

async function criarCobrancaAvulsaEDevolver(
  deps: DepsCompra,
  org: string,
  pedido: PedidoLinha,
  asaasCustomerId: string,
  descricao: string,
  agora: Date,
): Promise<ResultadoIniciarCompra> {
  let cobranca: CobrancaAsaas;
  try {
    cobranca = await deps.asaas.criarCobranca({
      customer: asaasCustomerId,
      billingType: pedido.metodo,
      value: centavosParaReais(pedido.amountCents),
      dueDate: amanhaSaoPaulo(agora),
      description: descricao,
      externalReference: pedido.externalReference,
    });
  } catch (err) {
    return tratarErroDoPost(deps, org, pedido.id, err);
  }
  if (pedido.metodo === "CREDIT_CARD") return registrarEDevolverCartao(deps, org, pedido, null, cobranca);
  return registrarEDevolverPix(deps, org, pedido, cobranca);
}

async function criarCobrancaOuAssinatura(
  deps: DepsCompra,
  org: string,
  pedido: PedidoLinha,
  tentarRecuperarPorReferencia: boolean,
  proximaCobrancaEm: string | null,
  asaasCustomerId: string,
): Promise<ResultadoIniciarCompra> {
  const agora = relogio(deps);
  const descricao = montarDescricao(pedido);
  // D-177: de 2x em diante o cartão é cobrança parcelada avulsa, nunca assinatura (não renova sozinha).
  const ehAssinaturaCartao = pedido.tipo === "assinatura" && pedido.metodo === "CREDIT_CARD" && (pedido.parcelas ?? 1) <= 1;

  if (tentarRecuperarPorReferencia) {
    try {
      if (ehAssinaturaCartao) {
        const existente = await deps.asaas.buscarAssinaturaPorReferencia(pedido.externalReference);
        if (existente) {
          let primeiraCobranca: CobrancaAsaas | null = null;
          try {
            const cobrancas = await deps.asaas.listarCobrancasDaAssinatura(existente.id);
            primeiraCobranca = cobrancas[0] ?? null;
          } catch {
            // segue sem a fatura por agora
          }
          return registrarEDevolverCartao(deps, org, pedido, existente.id, primeiraCobranca);
        }
      } else {
        const existente = await deps.asaas.buscarCobrancaPorReferencia(pedido.externalReference);
        if (existente) {
          if (pedido.metodo === "CREDIT_CARD") return registrarEDevolverCartao(deps, org, pedido, null, existente);
          return registrarEDevolverPix(deps, org, pedido, existente);
        }
      }
    } catch {
      deps.logger.warn("asaas_compra_recuperar_inconclusivo_falhou", { pedidoId: pedido.id });
      // Decisão 13: a CONSULTA falhou (timeout/429/5xx). Nunca faz um POST
      // cego depois de uma consulta que não respondeu; devolve "aguarde".
      //
      // Correção 1: sem o passo abaixo, o pedido ficaria preso em
      // `processando` (`tomarPedido` já tomou a posse antes de chegar aqui):
      // `fn_billing_pedido_tomar` só toma de `criado`/`inconclusivo`, nunca
      // de `processando`, então nenhuma chamada seguinte de `iniciarCompra`
      // conseguiria tentar de novo. Volta para `inconclusivo` (válido porque
      // o pedido está em `processando`) para uma TERCEIRA chamada retomar.
      const marcado = await deps.db.marcarPedido(org, pedido.id, "inconclusivo", "asaas_recuperar_referencia_falhou");
      if (marcado.error) {
        deps.logger.error("asaas_compra_marcar_inconclusivo_apos_falha_de_recuperacao_falhou", {
          pedidoId: pedido.id,
          codigo: marcado.error.code,
        });
      }
      return { tipo: "erro", mensagem: MENSAGEM_AGUARDE };
    }
  }

  if (ehAssinaturaCartao) {
    return criarAssinaturaEDevolver(deps, org, pedido, asaasCustomerId, descricao, proximaCobrancaEm, agora);
  }
  if ((pedido.parcelas ?? 1) > 1) {
    return criarCobrancaParceladaEDevolver(deps, org, pedido, asaasCustomerId, descricao, agora);
  }
  return criarCobrancaAvulsaEDevolver(deps, org, pedido, asaasCustomerId, descricao, agora);
}

// ─── A função pública ───────────────────────────────────────────────────

export async function iniciarCompra(deps: DepsCompra, entrada: EntradaIniciarCompra): Promise<ResultadoIniciarCompra> {
  const ambiente = deps.config.ambiente;

  // D-133: sem o aceite dos Termos nada é criado, nem pedido nem chamada ao Asaas. O banco recusa de
  // novo (billing_termos_nao_aceitos) quando a compra tem ator.
  if (typeof entrada.termosVersao !== "string" || entrada.termosVersao.trim() === "") {
    return { tipo: "erro", mensagem: MENSAGEM_TERMOS_NAO_ACEITOS };
  }

  const resolucao = await resolverPedido(deps, entrada, ambiente);
  if (resolucao.tipo === "erro") return resolucao;

  const leitura1 = await deps.db.lerPedido(entrada.organizationId, resolucao.pedidoId);
  if (leitura1.error || !leitura1.data) {
    deps.logger.error("asaas_compra_ler_pedido_falhou", { pedidoId: resolucao.pedidoId, codigo: leitura1.error?.code });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }

  const tomavel = leitura1.data.status === "criado" || leitura1.data.status === "inconclusivo" || leitura1.data.status === "processando";
  if (!tomavel) {
    return resolverRespostaPeloEstado(deps, entrada.organizationId, leitura1.data);
  }
  const estadoAntesDeTomar = leitura1.data.status;

  const posse = await deps.db.tomarPedido(entrada.organizationId, resolucao.pedidoId);
  if (posse.error || !posse.data) {
    deps.logger.error("asaas_compra_tomar_pedido_falhou", { pedidoId: resolucao.pedidoId, codigo: posse.error?.code });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  if (!posse.data.tomado) {
    // Não ganhou a posse (decisão 25/A2): lê o estado atual e devolve o que
    // houver. NENHUMA chamada ao Asaas acontece neste ramo.
    const leitura2 = await deps.db.lerPedido(entrada.organizationId, resolucao.pedidoId);
    if (leitura2.error || !leitura2.data) {
      deps.logger.error("asaas_compra_ler_pedido_falhou", { pedidoId: resolucao.pedidoId, codigo: leitura2.error?.code });
      return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
    }
    return resolverRespostaPeloEstado(deps, entrada.organizationId, leitura2.data);
  }

  // Ganhou a posse: releitura autoritativa (decisão 12: releitura depois da
  // trava) para plano/pacote/ciclo, usados na `description`.
  const leitura3 = await deps.db.lerPedido(entrada.organizationId, resolucao.pedidoId);
  if (leitura3.error || !leitura3.data) {
    deps.logger.error("asaas_compra_ler_pedido_falhou", { pedidoId: resolucao.pedidoId, codigo: leitura3.error?.code });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  const pedido = leitura3.data;

  const cliente = await resolverAsaasCustomerId(deps, entrada.organizationId, ambiente, entrada.pagador);
  if (!cliente.ok) {
    await deps.db.marcarPedido(entrada.organizationId, pedido.id, "falhou", cliente.motivoInterno);
    return { tipo: "erro", mensagem: cliente.mensagem };
  }

  return criarCobrancaOuAssinatura(
    deps,
    entrada.organizationId,
    pedido,
    estadoAntesDeTomar === "inconclusivo",
    resolucao.proximaCobrancaEm,
    cliente.asaasCustomerId,
  );
}

/**
 * Quem tem período pago a frente (Pix) e assina no cartão tem a assinatura AGENDADA para o fim
 * desse período (`nextDueDate` no futuro, decisão 26): enquanto o primeiro pagamento não chega,
 * o contrato ainda não guarda o id dela (`aplicar_pagamento` grava no primeiro pagamento), e só
 * o pedido aberto (`aguardando_pagamento`) o carrega desde a criação
 * (`registrarEDevolverCartao`). Sem este caminho o cliente não conseguia cancelar: o contrato
 * dizia "sem assinatura" e o Asaas cobrava o cartão na data agendada. Remove a assinatura no
 * Asaas (idempotente em 404) e SÓ DEPOIS marca o pedido `cancelado`, a mesma ordem do
 * cancelamento da assinatura viva: um erro no meio nunca deixa o pedido cancelado com a
 * assinatura ainda cobrando, e repetir é seguro. O contrato não muda: o período pago a frente
 * continua valendo e não há renovação agendada.
 */
async function cancelarAssinaturaAgendadaDoPedido(
  deps: DepsCompra,
  organizationId: string,
): Promise<ResultadoCancelarAssinatura> {
  const aberto = await deps.db.buscarPedidoAbertoPorTipo(organizationId, "assinatura");
  if (aberto.error) {
    deps.logger.error("asaas_cancelar_ler_pedido_agendado_falhou", { org: organizationId, codigo: aberto.error.code });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  const pedido = aberto.data;
  if (
    !pedido ||
    pedido.metodo !== "CREDIT_CARD" ||
    pedido.status !== "aguardando_pagamento" ||
    !pedido.asaasSubscriptionId ||
    pedido.ambiente !== deps.config.ambiente
  ) {
    return { tipo: "erro", mensagem: MENSAGEM_SEM_ASSINATURA_ASAAS };
  }

  try {
    await deps.asaas.removerAssinatura(pedido.asaasSubscriptionId);
  } catch (err) {
    deps.logger.error("asaas_cancelar_remover_assinatura_agendada_falhou", { org: organizationId, tipoErro: tipoDoErro(err) });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }

  const marcado = await deps.db.marcarPedido(organizationId, pedido.id, "cancelado", "cancelado_pelo_cliente");
  if (marcado.error || !marcado.data) {
    deps.logger.error("asaas_cancelar_marcar_pedido_agendado_falhou", { org: organizationId, codigo: marcado.error?.code });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }

  await avisarCancelamento(deps, organizationId, pedido.asaasSubscriptionId);
  return { tipo: "ok", cancelAtPeriodEnd: false };
}

async function avisarCancelamento(
  deps: DepsCompra,
  organizationId: string,
  asaasSubscriptionId: string,
): Promise<void> {
  if (!deps.avisoDeCancelamento) return;
  try {
    await deps.avisoDeCancelamento({ organizationId, asaasSubscriptionId });
  } catch (err) {
    deps.logger.warn("asaas_cancelar_aviso_falhou", { org: organizationId, tipoErro: tipoDoErro(err) });
  }
}

/**
 * Cancela a assinatura Asaas da organização: primeiro `DELETE
 * /subscriptions/{id}` (idempotente: 404 já conta como sucesso, tratado
 * dentro de `deps.asaas.removerAssinatura`); só DEPOIS do sucesso chama
 * `fn_billing_asaas_marcar_assinatura_encerrada` (correção 5: ela já liga
 * `cancel_at_period_end` e grava o evento de auditoria sozinha, ver o corpo
 * dela na migração 0909). Nunca na ordem inversa: marcar `cancel_at_period_
 * end` antes do `DELETE` deixaria o contrato dizendo "cancela no fim do
 * período" enquanto a assinatura de verdade continua cobrando no Asaas.
 */
export async function cancelarAssinaturaDoCliente(
  deps: DepsCompra,
  organizationId: string,
  actorId: string,
): Promise<ResultadoCancelarAssinatura> {
  const contrato = await deps.db.lerContrato(organizationId);
  if (contrato.error || !contrato.data) {
    deps.logger.error("asaas_cancelar_ler_contrato_falhou", { org: organizationId, codigo: contrato.error?.code });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  const { asaasSubscriptionId, asaasAssinaturaEncerradaEm } = contrato.data;
  if (!asaasSubscriptionId || asaasAssinaturaEncerradaEm) {
    return cancelarAssinaturaAgendadaDoPedido(deps, organizationId);
  }

  try {
    await deps.asaas.removerAssinatura(asaasSubscriptionId);
  } catch (err) {
    const tipoErro = err instanceof ErroAsaasException ? err.erro.tipo : "desconhecido";
    deps.logger.error("asaas_cancelar_remover_assinatura_falhou", { org: organizationId, tipoErro });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }

  // Correção 5: fn_billing_asaas_marcar_assinatura_encerrada (0909) já liga
  // cancel_at_period_end = true e grava o evento de auditoria sozinha;
  // chamar fn_billing_cancelar_no_fim_do_periodo (0908) antes dela só
  // duplicava trabalho que a função nova já cobre, por isso essa chamada foi
  // removida. Uma falha AQUI agora devolve erro (nunca mais "ok"): sem o
  // marcador, o contrato não tem cancel_at_period_end nem o rastro de
  // auditoria, e afirmar sucesso seria mentir. É seguro pedir para tentar de
  // novo: o DELETE já feito é idempotente (removerAssinatura trata 404 como
  // sucesso) e marcarAssinaturaEncerrada também é idempotente (marcador já
  // preenchido devolve ja_registrado sem repetir nada).
  const marcado = await deps.db.marcarAssinaturaEncerrada(organizationId, asaasSubscriptionId, actorId);
  if (marcado.error || !marcado.data) {
    deps.logger.error("asaas_cancelar_marcar_encerrada_falhou", { org: organizationId, codigo: marcado.error?.code });
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }

  await avisarCancelamento(deps, organizationId, asaasSubscriptionId);
  return { tipo: "ok", cancelAtPeriodEnd: true };
}
