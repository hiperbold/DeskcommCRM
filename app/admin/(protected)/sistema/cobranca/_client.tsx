"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  cancelarPedidoAberto,
  definirCompraPeloCliente,
  definirPlanoAVenda,
  reprocessarEventoAsaas,
} from "@/app/actions/admin/cobrancaAsaas";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

/**
 * As ações da tela de cobrança (Asaas), fase F5, Tarefa 19: ligam aos cinco
 * server actions de `app/actions/admin/cobrancaAsaas.ts` (Tarefa 17), que já
 * fazem o gate (`requirePlatformAdmin`, escopo `full`, MFA) e a auditoria.
 * Estes componentes só cuidam da CONFIRMAÇÃO e do feedback na tela: a barreira
 * de verdade mora no servidor, e um erro devolvido pela ação (frase fixa,
 * nunca o texto cru do Postgres) aparece direto no toast, sem passar por
 * `t()`, mesmo padrão de `_client.tsx` da aba de plano do tenant.
 *
 * `podeEscrever` (escopo `full`) já é conferido por quem RENDERIZA estes
 * componentes (`page.tsx` só os monta quando `podeEscrever` é verdadeiro):
 * eles não repetem a checagem, do mesmo jeito que os formulários de
 * `assinaturaDaOrganizacao.ts` na aba do tenant.
 */

// ─── Compra pelo cliente (decisão 18) ───────────────────────────────────────

export function AlternarCompraPeloCliente({ ligada }: { ligada: boolean }) {
  const t = useT();
  const router = useRouter();
  const [pedindoConfirmacao, setPedindoConfirmacao] = useState(false);
  const [pendente, iniciar] = useTransition();

  function confirmar() {
    iniciar(async () => {
      const r = await definirCompraPeloCliente({ sim: !ligada });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Compra pelo cliente atualizada."));
      setPedindoConfirmacao(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        data-testid="alternar-compra-pelo-cliente"
        variant="outline"
        size="sm"
        disabled={pendente}
        onClick={() => setPedindoConfirmacao(true)}
      >
        {ligada ? t("Desligar compra pelo cliente") : t("Ligar compra pelo cliente")}
      </Button>

      <AlertDialog open={pedindoConfirmacao} onOpenChange={setPedindoConfirmacao}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ligada ? t("Desligar a compra pelo cliente?") : t("Ligar a compra pelo cliente?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ligada
                ? t(
                    "O cliente deixa de conseguir comprar plano ou pacote pela própria tela. Nenhuma assinatura já ativa é cancelada.",
                  )
                : t(
                    "Isto só vale com ASAAS_ENABLED ligado no ambiente do servidor. Sem essa variável, o cliente continua sem poder comprar pela tela mesmo com esta chave ligada.",
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-compra-pelo-cliente"
              disabled={pendente}
              onClick={(e) => {
                e.preventDefault();
                confirmar();
              }}
            >
              {ligada ? t("Desligar") : t("Ligar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Plano à venda, por plano (decisão 18, `fn_billing_definir_a_venda`) ────

export function AlternarPlanoAVenda({
  planCode,
  forSale,
  podeVender,
}: {
  planCode: string;
  forSale: boolean;
  /** `price_monthly_cents > 0`: a própria função do banco exige isso para ligar. */
  podeVender: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [pendente, iniciar] = useTransition();

  function alternar() {
    iniciar(async () => {
      const r = await definirPlanoAVenda({ planCode, sim: !forSale });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Plano atualizado."));
      router.refresh();
    });
  }

  const desabilitadoPorPreco = !forSale && !podeVender;

  return (
    <Button
      data-testid={`alternar-a-venda-${planCode}`}
      size="sm"
      variant="outline"
      disabled={pendente || desabilitadoPorPreco}
      title={desabilitadoPorPreco ? t("Defina o preço mensal deste plano antes de pôr à venda.") : undefined}
      onClick={alternar}
    >
      {forSale ? t("Tirar de venda") : t("Pôr à venda")}
    </Button>
  );
}

// ─── Reprocessar evento (decisão 20, `fn_billing_asaas_reprocessar_evento`) ─

export function BotaoDeReprocessarEvento({ eventoId }: { eventoId: string }) {
  const t = useT();
  const router = useRouter();
  const [pendente, iniciar] = useTransition();

  function reprocessar() {
    iniciar(async () => {
      const r = await reprocessarEventoAsaas({ eventoId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Evento reprocessado."));
      router.refresh();
    });
  }

  return (
    <Button
      data-testid="reprocessar-evento"
      size="sm"
      variant="outline"
      disabled={pendente}
      onClick={reprocessar}
    >
      {t("Reprocessar")}
    </Button>
  );
}

// ─── Cancelar pedido aberto (decisão 10) ────────────────────────────────────
//
// Reusada aqui e na seção Asaas da aba `tenants/[id]/plano` (mesmo desenho:
// a ação SEMPRE busca no Asaas por `externalReference` antes de marcar
// cancelado, e recusa se a remoção falhar: nada disto é decidido no cliente).

export function FormularioDeCancelarPedido({
  organizationId,
  pedidoId,
}: {
  organizationId: string;
  pedidoId: string;
}) {
  const t = useT();
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [pendente, iniciar] = useTransition();

  function confirmar() {
    if (motivo.trim().length === 0) {
      toast.error(t("O motivo é obrigatório."));
      return;
    }
    iniciar(async () => {
      const r = await cancelarPedidoAberto({ organizationId, pedidoId, motivo: motivo.trim() });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Pedido cancelado."));
      setAberto(false);
      setMotivo("");
      router.refresh();
    });
  }

  return (
    <>
      <Button
        data-testid="cancelar-pedido"
        size="sm"
        variant="outline"
        disabled={pendente}
        onClick={() => setAberto(true)}
      >
        {t("Cancelar pedido")}
      </Button>

      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Cancelar este pedido?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Remove a cobrança ou a assinatura no Asaas antes de marcar o pedido como cancelado. Não é possível desfazer.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor={`motivo-cancelamento-${pedidoId}`}>{t("Motivo (obrigatório)")}</Label>
            <Input
              id={`motivo-cancelamento-${pedidoId}`}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              maxLength={500}
              disabled={pendente}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-cancelar-pedido"
              disabled={pendente}
              onClick={(e) => {
                e.preventDefault();
                confirmar();
              }}
            >
              {t("Cancelar pedido")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
