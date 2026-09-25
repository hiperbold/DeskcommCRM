"use client";

/**
 * O resultado `{ tipo: "pix" }` de `iniciarAssinatura`/`comprarPacote` (fase
 * F5, Tarefa 20): QR code, copia e cola com botão de copiar, expiração, e o
 * polling do pedido a cada 5s por até 10 min (`usePollDoPedido`,
 * `../_use-poll-pedido.ts`), com o texto "aguardando a confirmação do
 * pagamento" e, ao ver `pago`, "pagamento confirmado" com link para o plano.
 *
 * Nunca promete ativação: o polling só mostra o que o pedido diz agora
 * (mesma doutrina da decisão 3 do plano da fase, "quem confirma é a API").
 */
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { copyToClipboard } from "@/lib/clipboard";

import { usePollDoPedido } from "../_use-poll-pedido";

import type { QrPixResposta } from "@/lib/billing/asaas/compra";

const ESTADOS_AINDA_AGUARDANDO = new Set(["criado", "processando", "aguardando_pagamento", "inconclusivo"]);

export function PixPendente({ pedidoId, qr }: { pedidoId: string; qr: QrPixResposta }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const [copiado, setCopiado] = useState(false);
  const estado = usePollDoPedido(pedidoId, "aguardando_pagamento");

  async function copiar() {
    const ok = await copyToClipboard(qr.payload);
    if (ok) {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 3000);
    } else {
      toast.error(t("Não foi possível copiar. Selecione e copie manualmente."));
    }
  }

  if (estado.status === "pago") {
    return (
      <div className="space-y-3 rounded-md border p-4">
        <Badge variant="success">{t("Pagamento confirmado")}</Badge>
        <p className="text-sm text-muted-foreground">{t("O pagamento pelo Pix foi confirmado.")}</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/app/settings/plano">{t("Ver plano")}</Link>
        </Button>
      </div>
    );
  }

  if (estado.status !== null && !ESTADOS_AINDA_AGUARDANDO.has(estado.status)) {
    return (
      <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {t("Este pedido não está mais aguardando pagamento. Atualize a página ou fale com o suporte.")}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border p-4">
      <p className="text-sm font-medium">{t("Pague com Pix para confirmar")}</p>

      {/* eslint-disable-next-line @next/next/no-img-element -- imagem base64 gerada na hora, não um asset otimizável pelo next/image */}
      <img
        src={`data:image/png;base64,${qr.encodedImage}`}
        alt={t("QR code do Pix")}
        className="h-48 w-48 rounded-md border"
      />

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t("Pix copia e cola")}</span>
        <div className="flex gap-2">
          <code className="flex-1 overflow-x-auto rounded-md border bg-muted p-2 text-xs">{qr.payload}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => void copiar()}>
            {copiado ? t("Copiado") : t("Copiar")}
          </Button>
        </div>
      </div>

      {qr.expirationDate && (
        <p className="text-xs text-muted-foreground">
          {t("Expira em")} {new Date(qr.expirationDate).toLocaleString(tagDoIdioma)}
        </p>
      )}

      {estado.parou ? (
        <p className="text-sm text-muted-foreground">
          {t("Ainda não recebemos a confirmação. Você pode acompanhar este pedido depois.")}{" "}
          <Link href={`/app/settings/plano/pedido/${pedidoId}`} className="underline">
            {t("Ver pedido")}
          </Link>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("aguardando a confirmação do pagamento")}</p>
      )}
    </div>
  );
}
