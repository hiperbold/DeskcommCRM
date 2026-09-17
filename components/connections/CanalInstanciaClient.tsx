"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Conectar números por INSTÂNCIA de uma API não oficial.
 *
 * ─── Por que a tela não escreve o nome do provedor ──────────────────────────
 *
 * O rótulo vem do servidor (`label`): o `lint:channels` proíbe nomear provider
 * fora de `lib/channels/`, e no dia em que houver outro provedor por instância
 * esta tela não muda. O que o usuário lê continua sendo a marca que contratou.
 *
 * ─── A volta é ligada sozinha, mas pode falhar ──────────────────────────────
 *
 * O CRM registra o webhook na instância, e o operador não cola nada do outro
 * lado. Quando o registro não acontece (endereço público não configurado,
 * servidor recusou), a tela diz isso em destaque: uma conexão que envia e não
 * recebe é o defeito que aparece horas depois como "o cliente respondeu e não
 * chegou".
 */

interface Conexao {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  status: string | null;
  servidor: string | null;
  webhook_registrado: boolean;
}

interface Estado {
  label: string;
  conexoes: Conexao[];
}

interface Conectou {
  conexao: { id: string; display_name: string; phone_number: string | null; status: string };
  webhook: { registrado: boolean; aviso: string | null };
}

function rotuloDoStatus(status: string | null, t: (s: string) => string): string {
  switch (status) {
    case "WORKING":
      return t("Conectado");
    case "SCAN_QR_CODE":
      return t("Precisa parear o aparelho");
    case "STOPPED":
      return t("Pausado");
    case "FAILED":
      return t("Falhou");
    default:
      return status ?? "—";
  }
}

export function CanalInstanciaClient() {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [servidor, setServidor] = useState("");
  const [token, setToken] = useState("");
  const [nome, setNome] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState<string | null>(null);

  const carregar = async () => {
    try {
      const r = await apiClient.get<{ data: Estado }>("/api/v1/channels/instancia");
      setEstado(r.data);
    } catch {
      // Falha de leitura não trava a tela: o formulário continua servindo.
      setEstado(null);
    }
  };

  useEffect(() => {
    void carregar();
  }, []);

  const conectar = async () => {
    setSalvando(true);
    setAviso(null);
    try {
      const r = await apiClient.post<{ data: Conectou }>("/api/v1/channels/instancia", {
        servidor,
        token,
        nome: nome || null,
      });
      // O token sai da memória da tela assim que é gravado: ele não volta num GET.
      setToken("");
      setNome("");
      if (r.data.webhook.registrado) {
        toast.success(t("Número conectado. As mensagens já entram no CRM."));
      } else {
        setAviso(r.data.webhook.aviso ?? t("A volta das mensagens não foi ligada."));
        toast.warning(t("Conectado, mas as mensagens ainda não entram. Veja o aviso."));
      }
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(false);
    }
  };

  const remover = async (id: string) => {
    // Dois cliques: remover desliga a entrada de mensagens deste número.
    if (confirmandoRemocao !== id) {
      setConfirmandoRemocao(id);
      return;
    }
    setConfirmandoRemocao(null);
    try {
      await apiClient.delete(`/api/v1/channels/instancia?id=${encodeURIComponent(id)}`);
      toast.success(t("Conexão removida."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível remover."));
    }
  };

  const rotulo = estado?.label ?? t("API não oficial");
  const conexoes = estado?.conexoes ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="canal-instancia-root">
      <Card className="flex flex-col gap-4 p-4">
        <div>
          <h3 className="text-sm font-semibold">
            {t("Conectar por")} {rotulo}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Um número de WhatsApp pareado numa instância do seu servidor. As mensagens entram e saem pelo CRM, e a entrega é ligada automaticamente.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="instancia-servidor">{t("Servidor")}</Label>
            <Input
              id="instancia-servidor"
              value={servidor}
              onChange={(e) => setServidor(e.target.value)}
              placeholder="https://seu-servidor.exemplo.com"
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="instancia-token">{t("Token da instância")}</Label>
            <Input
              id="instancia-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("cole o token")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("Guardado cifrado. Depois de gravar ele não é mostrado de novo.")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="instancia-nome">{t("Apelido (opcional)")}</Label>
            <Input
              id="instancia-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("ex.: Comercial")}
              autoComplete="off"
            />
          </div>

          <div>
            <Button onClick={conectar} disabled={salvando || !servidor || !token}>
              {salvando ? t("Verificando…") : t("Conectar")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("O servidor e o token são testados antes de gravar.")}
            </p>
          </div>
        </div>
      </Card>

      {aviso && (
        <Card className="flex flex-col gap-2 border-warning/40 bg-warning-bg p-4">
          <h3 className="text-sm font-semibold">{t("Falta ligar a volta")}</h3>
          <p className="text-xs text-muted-foreground">{aviso}</p>
        </Card>
      )}

      {conexoes.map((c) => (
        <Card key={c.id} className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{c.display_name ?? t("Número conectado")}</p>
              <p className="text-xs text-muted-foreground">
                {c.phone_number ?? t("sem número informado")} · {c.servidor ?? "—"}
              </p>
            </div>
            <Badge variant={c.status === "WORKING" ? "secondary" : "outline"}>{rotuloDoStatus(c.status, t)}</Badge>
          </div>

          {!c.webhook_registrado && (
            <p className="text-xs text-warning-fg">
              {t("A entrada de mensagens não está ligada. Reconecte com o mesmo token depois de configurar o endereço público do CRM.")}
            </p>
          )}

          <ChannelAiAccess channelId={c.id} />

          <div>
            <Button variant="outline" size="sm" onClick={() => void remover(c.id)}>
              {confirmandoRemocao === c.id ? t("Clique de novo para remover") : t("Remover conexão")}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
