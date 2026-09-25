"use client";

/**
 * Cancelar a assinatura Asaas ATIVA da organização, pelo próprio cliente
 * (fase F5, Tarefa 21). Chama `cancelarAssinatura()`
 * (`app/actions/settings/compraDoPlano.ts`, Tarefa 15), que já faz todo o
 * gate (papel admin, `ASAAS_ENABLED`) e a auditoria; este componente só
 * cuida da confirmação e do feedback, mesmo padrão de
 * `app/admin/(protected)/sistema/cobranca/_client.tsx`.
 *
 * Vale a partir do fim do período já pago (decisão 18/N34 do plano da
 * fase: cancelar não depende de `compra_pelo_cliente`, só de
 * `ASAAS_ENABLED`, para desligar a venda nunca prender ninguém numa
 * assinatura já contratada); o diálogo diz isso antes de confirmar.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { cancelarAssinatura } from "@/app/actions/settings/compraDoPlano";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

export function BotaoCancelarAssinatura() {
  const t = useT();
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [pendente, iniciar] = useTransition();

  function confirmar() {
    iniciar(async () => {
      const r = await cancelarAssinatura();
      if (r.tipo === "erro") {
        toast.error(r.mensagem);
        return;
      }
      toast.success(t("Cancelamento registrado."));
      setAberto(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        data-testid="cancelar-assinatura-cliente"
        variant="outline"
        size="sm"
        disabled={pendente}
        onClick={() => setAberto(true)}
      >
        {t("Cancelar assinatura")}
      </Button>

      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Cancelar a assinatura?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Vale a partir do fim do período já pago: o acesso continua até lá, sem reembolso do que já foi pago.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-cancelar-assinatura-cliente"
              disabled={pendente}
              onClick={(e) => {
                e.preventDefault();
                confirmar();
              }}
            >
              {t("Cancelar assinatura")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
