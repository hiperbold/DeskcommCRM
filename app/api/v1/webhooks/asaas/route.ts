/**
 * POST /api/v1/webhooks/asaas - recepção do webhook do Asaas.
 *
 * Fase F5 (`hiperbold/planos/fase-F5-tarefas.md`), Tarefa 12, decisão 19,
 * correção M6 do histórico da revisão, riscos de segurança 2, 3, 10 e 17.
 * Contrato comum: `manual-api-asaas-saas.md`, seção do webhook.
 *
 * ═══ O que esta rota FAZ e o que ela NÃO faz ═══
 *
 * Autentica, guarda o evento (com o dinheiro sanitizado) e responde. NADA
 * mais: quem aplica pagamento, estorno ou fim de assinatura é o processador
 * assíncrono (Tarefa 13, `lib/billing/asaas/processar-eventos.ts`), que
 * consulta o Asaas por GET antes de mexer em qualquer coisa (decisão 3, risco
 * 1). Um evento forjado aqui - token vazado à parte - nunca libera acesso
 * sozinho: o pior que ele faz é entrar na fila.
 *
 * ═══ Ordem das checagens (a ordem importa) ═══
 *
 * 1. Token do webhook (`asaas-access-token`), tempo constante, falha fechada
 *    com o ambiente vazio (risco 2). Só este cabeçalho é aceito - nenhum
 *    `Authorization: Bearer` nem fallback.
 * 2. Teto de 64 KB pelo `Content-Length` declarado (413 sem ler nada).
 * 3. Teto de 64 KB pelo FLUXO real (o cabeçalho pode mentir), em
 *    `lib/http/corpo-com-limite.ts`.
 * 4. JSON e o envelope mínimo (`id`/`event`, mesmo schema de
 *    `lib/billing/asaas/contratos.ts`). Corpo autenticado que falha aqui NÃO
 *    vira 4xx: vira quarentena dentro do banco, e a rota ainda responde 200
 *    (correção M6 - travar a fila `SEQUENTIALLY` do Asaas é pior que guardar
 *    um evento manco).
 *
 * O ambiente do evento é sempre o da base configurada (`configDoAsaas()`),
 * nunca um campo do corpo. A rota funciona com `ASAAS_ENABLED` desligado - o
 * evento entra `aguardando` e o processador da Tarefa 13 é quem vê a chave
 * desligada; só o token nunca pode faltar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { configDoAsaas } from "@/lib/billing/asaas/config";
import { envelopeWebhookAsaasSchema } from "@/lib/billing/asaas/contratos";
import { sanitizarPayloadAsaas } from "@/lib/billing/asaas/sanitizar";
import { timingSafeStringEqual } from "@/lib/auth/cron-auth";
import { env } from "@/lib/env";
import { lerCorpoComLimite } from "@/lib/http/corpo-com-limite";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 64 KB (decisão 19). O mesmo teto existe de novo dentro de
 * `fn_billing_asaas_registrar_evento`, medido no payload já sanitizado - os
 * dois são independentes porque a conciliação (Tarefa 16) monta eventos
 * sintéticos que nunca passam por esta rota. */
const TETO_CORPO_BYTES = 64 * 1024;

const CORPO_RECEBIDO = { recebido: true } as const;

function respostaGenerica(status: number): NextResponse {
  // Nenhuma resposta desta rota ecoa nada do corpo recebido nem detalha o
  // motivo da recusa (risco 2 e 3): 401/413/500 devolvem só o status.
  return new NextResponse(null, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  // ─── 1. Token do webhook ────────────────────────────────────────────────
  //
  // Lido direto de `lib/env.ts`, não de `configDoAsaas()`: a rota precisa
  // continuar autenticando mesmo com `ASAAS_ENABLED=false` (o estado de toda
  // instalação desta fase) ou com a base/chave incoerentes - casos em que
  // `configDoAsaas()` devolve `habilitado:false` sem lançar (o primeiro) ou
  // LANÇA (o segundo, decisão 14). Nenhum dos dois pode derrubar a
  // autenticação do webhook com um 500.
  const tokenConfigurado = env.ASAAS_WEBHOOK_TOKEN.trim();
  const tokenRecebido = req.headers.get("asaas-access-token") ?? "";
  // `timingSafeStringEqual` já falha fechado quando qualquer lado é vazio
  // (ambiente sem token, cabeçalho ausente) e já compara em tempo constante
  // mesmo com tamanhos diferentes (hash de 32 bytes fixos antes de comparar).
  if (!timingSafeStringEqual(tokenRecebido, tokenConfigurado)) {
    return respostaGenerica(401);
  }

  // ─── 2. Teto de 64 KB pelo Content-Length declarado ────────────────────
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > TETO_CORPO_BYTES) {
    return respostaGenerica(413);
  }

  // ─── 3. Teto de 64 KB pelo fluxo real ───────────────────────────────────
  const corpo = await lerCorpoComLimite(req.body, TETO_CORPO_BYTES);
  if (!corpo.ok) {
    return respostaGenerica(413);
  }

  // ─── Ambiente do evento: sempre o da base configurada ──────────────────
  let ambiente: "sandbox" | "producao" = "sandbox";
  try {
    ambiente = configDoAsaas().ambiente;
  } catch {
    // `ASAAS_ENABLED=true` com base/chave incoerentes (decisão 14): erro de
    // CONFIGURAÇÃO, não do chamador. O evento ainda é guardado (o token já
    // provou que quem chamou é o Asaas de verdade); "sandbox" é o valor
    // neutro que `configDoAsaas()` também usa quando `habilitado` é falso.
    ambiente = "sandbox";
  }

  // ─── 4. JSON e envelope mínimo (id/event) ──────────────────────────────
  //
  // Corpo autenticado fora do formato NUNCA vira 4xx: entra em quarentena
  // dentro de `fn_billing_asaas_registrar_evento` (que corrige o que precisa
  // para caber no CHECK da tabela, grava resultado = 'erro' com o payload
  // cortado, e devolve sucesso mesmo assim) e a rota responde 200 do mesmo
  // jeito - é a correção M6: travar a fila SEQUENTIALLY do Asaas é pior que
  // guardar um evento manco.
  let json: unknown = null;
  try {
    json = JSON.parse(corpo.texto);
  } catch {
    json = null;
  }

  let eventId: string | null = null;
  let eventType: string | null = null;
  let resourceId: string | null = null;
  if (json !== null) {
    const envelope = envelopeWebhookAsaasSchema.safeParse(json);
    if (envelope.success) {
      eventId = envelope.data.id;
      eventType = envelope.data.event;
      resourceId = envelope.data.payment?.id ?? envelope.data.subscription?.id ?? null;
    }
  }

  const payloadSanitizado = sanitizarPayloadAsaas(json ?? {});

  const admin = createAdminClient();
  let registrado: { novo: boolean; event_id: string; resultado: string } | null = null;
  try {
    const { data, error } = await admin.rpc("fn_billing_asaas_registrar_evento", {
      p_event_id: eventId,
      p_event_type: eventType,
      p_resource_id: resourceId,
      p_ambiente: ambiente,
      p_origem: "webhook",
      p_payload: payloadSanitizado,
    });
    if (error) {
      throw new Error(error.message);
    }
    registrado = data as { novo: boolean; event_id: string; resultado: string };
  } catch (err) {
    // 500 GENÉRICO só aqui: não conseguimos guardar o evento, e o Asaas
    // reentrega (decisão 19). Nunca o corpo, nunca o erro cru no log.
    logger.error("asaas_webhook_falha_ao_registrar", {
      requestId,
      erro: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return respostaGenerica(500);
  }

  // Log só com o que a decisão 19 permite: requestId, tipo, event_id e se
  // era novo. Nunca token, corpo, CPF ou payload.
  logger.info("asaas_webhook_recebido", {
    requestId,
    event_type: eventType ?? "desconhecido",
    event_id: registrado.event_id,
    novo: registrado.novo,
  });

  // Responde EXATAMENTE 200 com o mesmo corpo, evento novo ou repetido.
  // Nunca o wrapper `ok()` de `lib/api/wrappers.ts` (que embrulharia em
  // `{ data: ... }`): o Asaas espera este corpo exato.
  return NextResponse.json(CORPO_RECEBIDO, { status: 200 });
}
