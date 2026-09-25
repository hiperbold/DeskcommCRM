"use client";

/**
 * O estado do pedido (fase F5, Tarefa 21), com o MESMO polling da tela de
 * compra (`usePollDoPedido`, `../../_use-poll-pedido.ts`) enquanto ainda
 * aguarda: a cada 5s por até 10 min, texto "aguardando a confirmação do
 * pagamento", sem prometer ativação.
 */
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";

import { urlDeRedirecionamentoEhSegura } from "../../_logica-compra";
import { usePollDoPedido } from "../../_use-poll-pedido";

type Variante = "success" | "info" | "warning" | "error" | "neutral";

const RUBRICA_DO_STATUS: Record<string, { texto: string; variante: Variante }> = {
  criado: { texto: "Aguardando pagamento", variante: "info" },
  processando: { texto: "Aguardando pagamento", variante: "info" },
  aguardando_pagamento: { texto: "Aguardando pagamento", variante: "info" },
  inconclusivo: { texto: "Aguardando pagamento", variante: "warning" },
  pago: { texto: "Pagamento confirmado", variante: "success" },
  vencido: { texto: "Vencido", variante: "error" },
  cancelado: { texto: "Cancelado", variante: "neutral" },
  falhou: { texto: "Falhou", variante: "error" },
  estornado: { texto: "Estornado", variante: "neutral" },
};

const ESTADOS_AGUARDANDO = new Set(["criado", "processando", "aguardando_pagamento", "inconclusivo"]);

export function PedidoClient({
  pedidoId,
  statusInicial,
  urlInicial,
}: {
  pedidoId: string;
  statusInicial: string;
  urlInicial: string | null;
}) {
  const t = useT();
  const estado = usePollDoPedido(pedidoId, statusInicial);
  const status = estado.status ?? statusInicial;
  const url = estado.url ?? urlInicial;
  const urlSegura = url && urlDeRedirecionamentoEhSegura(url) ? url : null;
  const rubrica = RUBRICA_DO_STATUS[status] ?? { texto: status, variante: "neutral" as const };
  const aguardando = ESTADOS_AGUARDANDO.has(status);

  return (
    <div className="space-y-4 rounded-md border p-4">
      <Badge variant={rubrica.variante}>{t(rubrica.texto)}</Badge>

      {aguardando && <p className="text-sm text-muted-foreground">{t("aguardando a confirmação do pagamento")}</p>}

      {status === "pago" && (
        <div className="space-y-2">
          <Link href="/app/settings/plano" className="text-sm underline">
            {t("Ver plano")}
          </Link>
        </div>
      )}

      {urlSegura && status !== "pago" && (
        <a href={urlSegura} target="_blank" rel="noopener noreferrer" className="text-sm underline">
          {t("Abrir a fatura no Asaas")}
        </a>
      )}

      {estado.parou && aguardando && (
        <p className="text-xs text-muted-foreground">
          {t("Ainda não recebemos a confirmação. Atualize a página mais tarde.")}
        </p>
      )}
    </div>
  );
}
