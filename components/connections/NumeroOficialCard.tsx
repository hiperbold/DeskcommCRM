"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useEstadoDoNumeroOficial,
  useRegistrarNumeroOficial,
} from "@/hooks/channels/useOfficialChannel";
import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * O estado do número na Meta e, no `PENDING`, o botão de registrá-lo (D-174).
 *
 * Número verificado mas nunca registrado fica `PENDING` e não envia. O admin pode informar o PIN de seis
 * dígitos que já usa (número que teve verificação em duas etapas) ou deixar em branco: o CRM gera um e o
 * mostra UMA vez aqui. O PIN vive só neste componente, em memória: não vai para URL, storage nem cache
 * de consulta (a mutação o devolve uma vez e a tela o descarta ao fechar).
 *
 * Quem não é admin leva 403 da rota e o cartão simplesmente não aparece.
 */
export function NumeroOficialCard() {
  const t = useT();
  const estado = useEstadoDoNumeroOficial(true);
  const registrar = useRegistrarNumeroOficial();
  const [pinInformado, setPinInformado] = useState("");
  const [pinGerado, setPinGerado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const dado = estado.data?.data;
  if (estado.isError || !dado) return null;

  async function enviar() {
    setErro(null);
    const r = await registrar.mutateAsync(pinInformado ? { pin: pinInformado } : {});
    // O PIN já está em `r`: solta a mutação (com gcTime 0 ela sai do cache), para a resposta não ficar retida.
    registrar.reset();
    if (r.data.registrado) {
      setPinInformado("");
      setPinGerado(r.data.pin);
      toast.success(t("Número registrado na Meta."));
    } else {
      setErro(r.data.erro);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="numero-oficial">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{t("Número na Meta")}</h2>
        {dado.disponivel ? (
          <>
            <Badge variant={dado.status === "CONNECTED" ? "default" : "outline"}>{dado.status ?? "?"}</Badge>
            {dado.codeVerificationStatus ? (
              <Badge variant="outline" className="font-mono text-xs">
                {t("verificação")}: {dado.codeVerificationStatus}
              </Badge>
            ) : null}
          </>
        ) : null}
      </div>

      {!dado.disponivel ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {t("Não consegui ler o estado do número agora.")} {dado.motivo}
        </p>
      ) : null}

      {dado.disponivel && dado.precisaRegistrar ? (
        <div className="flex flex-col gap-3" data-testid="numero-pendente">
          <p className="text-sm text-muted-foreground">
            {t(
              "Este número foi verificado, mas ainda não foi registrado na API oficial: enquanto estiver PENDING, a Meta não deixa enviar mensagens. O registro usa um PIN de seis dígitos (verificação em duas etapas do número).",
            )}
          </p>
          <div className="flex max-w-xs flex-col gap-1.5">
            <Label htmlFor="pin-do-numero">{t("PIN de seis dígitos (opcional)")}</Label>
            <Input
              id="pin-do-numero"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pinInformado}
              onChange={(e) => setPinInformado(e.target.value.replace(/\D/g, ""))}
              placeholder="••••••"
            />
            <span className="text-xs text-muted-foreground">
              {t("Se o número já teve verificação em duas etapas, informe o PIN que você definiu. Em branco, o CRM gera um e mostra uma única vez.")}
            </span>
          </div>
          {erro ? <p className="text-sm text-destructive">{erro}</p> : null}
          <div>
            <Button
              onClick={enviar}
              disabled={registrar.isPending || (pinInformado !== "" && pinInformado.length !== 6)}
            >
              {registrar.isPending ? t("Registrando…") : t("Registrar número")}
            </Button>
          </div>
        </div>
      ) : null}

      {pinGerado ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          data-testid="pin-gerado"
        >
          <p className="text-sm font-medium">{t("Guarde este PIN agora. Ele não será mostrado de novo.")}</p>
          <div className="flex items-center gap-2">
            <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm tracking-widest">{pinGerado}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await copyToClipboard(pinGerado);
                toast.success(t("Copiado."));
              }}
            >
              {t("Copiar")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPinGerado(null)}>
              {t("Já guardei")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("A Meta pede este PIN se o número for registrado de novo. Se perder, redefina-o no WhatsApp Manager.")}
          </p>
        </div>
      ) : null}
    </Card>
  );
}
