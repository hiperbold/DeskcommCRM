/**
 * Lógica pura das telas do cliente (fase F5, Tarefas 20 e 21,
 * `hiperbold/planos/fase-F5-tarefas.md`): validação da URL de
 * redirecionamento, a régua de quando o polling do pedido para, a montagem
 * do formulário do pagador, e a chave de idempotência da tentativa de
 * compra (correção 6 da revisão).
 *
 * Fica FORA de `lib/billing/asaas/*` de propósito: o briefing desta tarefa
 * não autoriza tocar naquela pasta. A validação de URL abaixo é uma SEGUNDA
 * conferência, no NAVEGADOR (risco 8 do plano da fase); a fonte de verdade
 * continua sendo `urlDeFaturaValida` em `lib/billing/asaas/compra.ts`, que já
 * roda no servidor antes de gravar `invoice_url`. Pelo mesmo motivo,
 * `MENSAGEM_AGUARDE_ESPELHO` (abaixo) é uma CÓPIA do texto de
 * `MENSAGEM_AGUARDE` daquele arquivo `server-only`, nunca um import dele.
 *
 * Sem JSX e sem hook: importável tanto pelos componentes client quanto pelo
 * teste de unidade (`tests/unit/asaas-telas-cliente.test.ts`) sem montar
 * árvore nenhuma.
 */
import { randomId } from "@/lib/random-id";

// ─── URL de redirecionamento (risco 8) ─────────────────────────────────────

const PREFIXOS_DE_REDIRECIONAMENTO_PERMITIDOS = [
  "https://www.asaas.com/",
  "https://asaas.com/",
  "https://sandbox.asaas.com/",
] as const;

/**
 * Confere de novo no CLIENTE, antes de `window.location.href = url`
 * (risco 8: redirecionamento aberto). A URL precisa COMEÇAR exatamente com
 * um dos três prefixos oficiais: `startsWith`, nunca `includes`, para que um
 * endereço como `https://evil.com/?next=https://asaas.com/` continue
 * recusado.
 */
export function urlDeRedirecionamentoEhSegura(url: string): boolean {
  return PREFIXOS_DE_REDIRECIONAMENTO_PERMITIDOS.some((prefixo) => url.startsWith(prefixo));
}

// ─── Polling do pedido (tarefas 20 e 21) ───────────────────────────────────

/** A cada 5 segundos, como o briefing pede. */
export const INTERVALO_DE_POLLING_MS = 5_000;

/** Por até 10 minutos, como o briefing pede. */
export const TETO_DE_POLLING_MS = 10 * 60 * 1000;

const ESTADOS_FINAIS_DO_PEDIDO = new Set(["pago", "vencido", "cancelado", "falhou", "estornado"]);

/** `billing_orders.status` que não muda mais sozinho. */
export function pedidoEmEstadoFinal(status: string): boolean {
  return ESTADOS_FINAIS_DO_PEDIDO.has(status);
}

/**
 * Decide se o polling do pedido deve parar: ao ver um estado final (`pago` e
 * os outros da lista acima), ou ao estourar o teto de 10 minutos sem
 * resposta nova, o que vier primeiro. `status` é o último lido (`null` antes
 * da primeira resposta); `decorridoMs` é o tempo desde que o polling
 * começou.
 */
export function devePararDePollarPedido(status: string | null, decorridoMs: number): boolean {
  if (status !== null && pedidoEmEstadoFinal(status)) return true;
  return decorridoMs >= TETO_DE_POLLING_MS;
}

// ─── Formulário do pagador (decisão 16 da fase) ────────────────────────────

export interface CamposDoFormularioDoPagador {
  nome: string;
  documento: string;
  email: string;
  celular: string;
}

export interface DadosDoPagador {
  nome: string;
  documento: string;
  email?: string;
  celular?: string;
}

export type ResultadoDoFormularioDoPagador =
  | { ok: true; pagador: DadosDoPagador }
  | { ok: false; erro: string };

const EMAIL_RAZOAVEL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Monta `DadosDoPagador` a partir dos campos crus do formulário: `nome` e
 * `documento` obrigatórios, `email` e `celular` só entram quando
 * preenchidos (o mesmo `.optional()` do zod em
 * `app/actions/settings/compraDoPlano.ts`).
 *
 * A conferência do DÍGITO VERIFICADOR do CPF/CNPJ é só no servidor
 * (`documentoValido`, `lib/billing/asaas/documento.ts`, `server-only`, não
 * importável aqui): esta função só recusa o que nem chega a ter a
 * quantidade certa de dígitos (11 ou 14), para não gastar uma volta ao
 * servidor com um documento obviamente incompleto.
 */
// ─── Chave de idempotência da tentativa de compra (correção 6 da revisão) ──

export interface EscolhaDeAssinatura {
  tipo: "assinatura";
  planCode: string;
  ciclo: "monthly" | "yearly";
  metodo: "CREDIT_CARD" | "PIX";
}

export interface EscolhaDePacote {
  tipo: "pacote_tokens";
  pacote: string;
  metodo: "CREDIT_CARD" | "PIX";
}

/** O que o cliente escolheu nesta tentativa: plano+ciclo+método, ou pacote+método. */
export type EscolhaDeCompra = EscolhaDeAssinatura | EscolhaDePacote;

export type DesfechoDaTentativaDeCompra = "aguarde" | "terminal";

/**
 * Espelha `MENSAGEM_AGUARDE` de `lib/billing/asaas/compra.ts`: aquele
 * arquivo é `server-only` e não pode ser importado por código de cliente
 * (o pacote `server-only` lança exatamente quando `typeof window !==
 * "undefined"`, ou seja, quando o bundle chegasse ao navegador). O TEXTO
 * exato é conferido contra o original em `tests/unit/asaas-telas-cliente.
 * test.ts` (que roda em Node e pode importar os dois), para não deixar as
 * duas cópias divergirem em silêncio.
 */
export const MENSAGEM_AGUARDE_ESPELHO =
  "Não foi possível confirmar agora. Aguarde a confirmação do pagamento e tente novamente em instantes.";

/**
 * Classifica o desfecho de UMA tentativa de compra/assinatura, para decidir
 * a chave da PRÓXIMA (decisão 13 do plano da fase, correção 6 da revisão):
 * só o erro com a MESMA mensagem de `MENSAGEM_AGUARDE` é "aguarde" (o pedido
 * segue `aguardando_pagamento`/`processando`, vale repetir com a MESMA
 * chave); qualquer outro erro (validação do formulário, `falhou`,
 * `cancelado`, já pago, sem assinatura, outra oferta aberta, genérico) é
 * TERMINAL. Um sucesso (`redirecionar`/`pix`) também conta como terminal: a
 * tela sai do ar (navega para longe) ou troca de formulário (QR do Pix),
 * então não há uma "próxima tentativa" nesta MESMA instância do formulário.
 */
export function classificarDesfechoDaTentativa(resultado: {
  tipo: "erro" | "redirecionar" | "pix";
  mensagem?: string;
}): DesfechoDaTentativaDeCompra {
  if (resultado.tipo === "erro" && resultado.mensagem === MENSAGEM_AGUARDE_ESPELHO) return "aguarde";
  return "terminal";
}

function mesmaEscolhaDeCompra(a: EscolhaDeCompra, b: EscolhaDeCompra): boolean {
  if (a.tipo === "assinatura" && b.tipo === "assinatura") {
    return a.planCode === b.planCode && a.ciclo === b.ciclo && a.metodo === b.metodo;
  }
  if (a.tipo === "pacote_tokens" && b.tipo === "pacote_tokens") {
    return a.pacote === b.pacote && a.metodo === b.metodo;
  }
  return false;
}

/**
 * A chave de idempotência (decisão 13 do plano da fase) só se REPETE quando
 * a tentativa ANTERIOR ficou em "aguarde" E a escolha de agora (plano/ciclo/
 * método, ou pacote/método) é EXATAMENTE a mesma: aí sim vale repetir a
 * MESMA requisição. Qualquer mudança de escolha, qualquer desfecho TERMINAL
 * (erro de validação do formulário, pedido `falhou`/`cancelado`, ou
 * qualquer outra recusa), ou a ausência de uma tentativa anterior, gera uma
 * chave NOVA com `randomId()` (correção 6): nunca reaproveita a chave de uma
 * escolha diferente, nem a de um pedido que já chegou a um estado do qual
 * não volta.
 */
export function chaveParaProximaTentativaDeCompra(args: {
  chaveAtual: string;
  escolhaAtual: EscolhaDeCompra;
  tentativaAnterior: { escolha: EscolhaDeCompra; desfecho: DesfechoDaTentativaDeCompra } | null;
}): string {
  const { chaveAtual, escolhaAtual, tentativaAnterior } = args;
  if (
    tentativaAnterior !== null &&
    tentativaAnterior.desfecho === "aguarde" &&
    mesmaEscolhaDeCompra(escolhaAtual, tentativaAnterior.escolha)
  ) {
    return chaveAtual;
  }
  return randomId();
}

export function montarPagadorDoFormulario(
  campos: CamposDoFormularioDoPagador,
): ResultadoDoFormularioDoPagador {
  const nome = campos.nome.trim();
  const documento = campos.documento.trim();
  const email = campos.email.trim();
  const celular = campos.celular.trim();

  if (nome.length === 0) {
    return { ok: false, erro: "Informe o nome de quem paga." };
  }

  const digitosDoDocumento = documento.replace(/\D/g, "");
  if (digitosDoDocumento.length !== 11 && digitosDoDocumento.length !== 14) {
    return { ok: false, erro: "Informe um CPF ou CNPJ válido." };
  }

  if (email.length > 0 && !EMAIL_RAZOAVEL.test(email)) {
    return { ok: false, erro: "Informe um e-mail válido, ou deixe em branco." };
  }

  const pagador: DadosDoPagador = { nome, documento };
  if (email.length > 0) pagador.email = email;
  if (celular.length > 0) pagador.celular = celular;

  return { ok: true, pagador };
}
