/**
 * GET /api/v1/billing/pedidos/[id]: fase F5, Tarefa 15.
 *
 * Estado do pedido para a tela consultar a cada 5s (Tarefa 21, fora desta
 * tarefa: `app/app/settings/plano/pedido/[id]/page.tsx`). Leitura PURA do
 * banco: nenhuma chamada ao Asaas sai daqui (restrição fixa 1 da fase);
 * quem busca o QR do Pix é a própria ação de compra
 * (`app/actions/settings/compraDoPlano.ts`), na hora em que cria a cobrança.
 *
 * ─── "Não existe" e "é de outra organização" no MESMO 404 (decisão 17) ────
 *
 * `dbCompraSupabase(admin).lerPedido(org.orgId, id)` sempre filtra pelo
 * `organization_id` da SESSÃO (nunca do path); um `id` de outra organização
 * simplesmente não bate nenhuma linha, o mesmo resultado de um `id`
 * inexistente. Não há dois caminhos de código para "sem permissão" e "não
 * existe": só existe UM: `data === null` vira 404, sempre com a mesma
 * mensagem.
 *
 * ─── Resposta sem dado do pagador ──────────────────────────────────────────
 *
 * Só `status`, `tipo` e `url` (a `invoice_url` já gravada, quando houver,
 * fluxo de cartão). `PedidoLinha` tem mais campos (nomes do plano/pacote,
 * ids do Asaas): nenhum dos dois é dado do pagador, mas mesmo assim só o
 * necessário para a tela decidir "ainda esperando" ou "pago" atravessa esta
 * rota.
 */
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { dbCompraSupabase } from "@/lib/billing/asaas/db-compra-supabase";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MENSAGEM_NAO_ENCONTRADO = "Pedido não encontrado.";
const MENSAGEM_ERRO_GENERICO = "Não foi possível consultar o pedido agora.";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? undefined;

  // N41/correção 6: só admin compra e cancela; esta leitura do estado do
  // pedido exige o mesmo papel das ações de compra (`compraDoPlano.ts`).
  const authz = await requireRole("admin", { requestId, resource: "billing_orders" });
  if (!authz.ok) return authz.response;

  const { id } = await context.params;
  // Formato inválido cai no MESMO 404 (nunca 400): não existe consulta cujo
  // "id malformado" precise ser diferenciável de "id que não bate com nada".
  if (!UUID_REGEX.test(id)) {
    return fail("not_found", MENSAGEM_NAO_ENCONTRADO, 404, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await dbCompraSupabase(admin).lerPedido(authz.org.orgId, id);

  if (error) {
    logger.error("[billing/pedidos] ler pedido falhou", {
      code: error.code ?? null,
      message: error.message ?? null,
    });
    return fail("internal_error", MENSAGEM_ERRO_GENERICO, 500, { requestId });
  }

  if (!data) {
    return fail("not_found", MENSAGEM_NAO_ENCONTRADO, 404, { requestId });
  }

  return ok(
    { status: data.status, tipo: data.tipo, url: data.invoiceUrl },
    { requestId, headers: { "Cache-Control": "no-store" } },
  );
}
