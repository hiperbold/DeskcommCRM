/**
 * Lógica pura das telas do cliente (fase F5, Tarefas 20 e 21,
 * `hiperbold/planos/fase-F5-tarefas.md`): validação da URL de
 * redirecionamento, a régua de quando o polling do pedido para, e a
 * montagem do formulário do pagador.
 *
 * Fica FORA de `lib/billing/asaas/*` de propósito: o briefing desta tarefa
 * não autoriza tocar naquela pasta. A validação de URL abaixo é uma SEGUNDA
 * conferência, no NAVEGADOR (risco 8 do plano da fase); a fonte de verdade
 * continua sendo `urlDeFaturaValida` em `lib/billing/asaas/compra.ts`, que já
 * roda no servidor antes de gravar `invoice_url`.
 *
 * Sem JSX e sem hook: importável tanto pelos componentes client quanto pelo
 * teste de unidade (`tests/unit/asaas-telas-cliente.test.ts`) sem montar
 * árvore nenhuma.
 */

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
