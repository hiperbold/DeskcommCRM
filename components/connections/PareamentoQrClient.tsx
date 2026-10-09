"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { useT } from "@/hooks/i18n/useT";
import { AvisoDeLimiteDeConexoes } from "./AvisoDeLimiteDeConexoes";

/**
 * Conectar o WhatsApp lendo um QR Code DENTRO do CRM.
 *
 * O cliente não cola servidor nem token: o CRM cria a conexão sozinho e mostra o
 * QR. Só é montado quando a instalação tem o recurso configurado (a página decide
 * no servidor e passa `ativo`); sem ele, a tela segue como sempre.
 *
 * O QR vem como imagem pronta do servidor (`qr`, data URL) e é renovado por
 * polling de 3 s no estado (`POST .../verificar`, que conclui a conexão quando o número lê). Passados 5 minutos sem leitura a tela PARA de
 * perguntar e oferece "gerar outro": QR esquecido aberto não fica pesando no
 * servidor. Cancelar apaga a conexão que o CRM criou e libera a vaga do plano.
 * Recarregar a página não perde o pareamento: ele é retomado pelo servidor.
 */

const INTERVALO_MS = 3_000;
const LIMITE_SEM_LEITURA_MS = 5 * 60 * 1000;

interface Andamento {
  id: string;
  estado: "aguardando" | "expirado";
  qr: string | null;
  codigo: string | null;
  expira_em: string;
}

interface Conectou {
  id: string;
  estado: "conectado";
  conexao: { id: string; display_name: string; phone_number: string | null; status: string };
  webhook: { registrado: boolean; aviso: string | null };
}

type Fase = "inicio" | "qr";

export function PareamentoQrClient({
  bloqueio,
  aoConectar,
}: {
  /** O mesmo estado de "conexões" do plano que a página já calcula: nunca decidido aqui. */
  bloqueio?: BloqueioDoBotao;
  /** Avisa quem lista as conexões que há uma nova. */
  aoConectar?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [fase, setFase] = useState<Fase>("inicio");
  const [sessao, setSessao] = useState<Andamento | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [mostrarCodigo, setMostrarCodigo] = useState(false);
  const [telefone, setTelefone] = useState("");
  const [parouDeAtualizar, setParouDeAtualizar] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Início da espera atual (reinicia ao gerar outro QR). Em ref: o polling lê sem re-renderizar.
  const esperaDesde = useRef<number>(0);

  const concluir = useCallback(
    (r: Conectou) => {
      setFase("inicio");
      setSessao(null);
      setTelefone("");
      setMostrarCodigo(false);
      if (r.webhook.registrado) {
        toast.success(t("WhatsApp conectado. As mensagens já entram no CRM."));
      } else {
        setAviso(r.webhook.aviso ?? t("A volta das mensagens não foi ligada."));
        toast.warning(t("Conectado, mas as mensagens ainda não entram. Veja o aviso."));
      }
      void qc.invalidateQueries({ queryKey: ["pacing-knobs"] });
      aoConectar?.();
    },
    [aoConectar, qc, t],
  );

  // Retoma um pareamento em andamento (a aba foi recarregada ou fechada no meio).
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const r = await apiClient.get<{
          data: { disponivel: boolean; pendente: { id: string; expira_em: string } | null };
        }>("/api/v1/channels/pareamento-qr");
        if (!vivo || !r.data.pendente) return;
        esperaDesde.current = Date.now();
        setSessao({
          id: r.data.pendente.id,
          estado: "aguardando",
          qr: null,
          codigo: null,
          expira_em: r.data.pendente.expira_em,
        });
        setFase("qr");
      } catch {
        // Sem retomada: o botão de começar continua servindo.
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // Pergunta o estado de 3 em 3 segundos, até conectar, expirar ou passar 5 minutos.
  const sessaoId = sessao?.id ?? null;
  useEffect(() => {
    if (fase !== "qr" || !sessaoId || parouDeAtualizar) return;
    let vivo = true;
    const tick = async () => {
      if (Date.now() - esperaDesde.current > LIMITE_SEM_LEITURA_MS) {
        if (vivo) setParouDeAtualizar(true);
        return;
      }
      try {
        // POST, e não GET: perguntar o estado conclui a conexão quando o número leu o QR
        // e desfaz o pareamento vencido, então tem efeito.
        const r = await apiClient.post<{ data: Andamento | Conectou }>(
          `/api/v1/channels/pareamento-qr/${encodeURIComponent(sessaoId)}/verificar`,
          {},
        );
        if (!vivo) return;
        if (r.data.estado === "conectado") {
          concluir(r.data);
          return;
        }
        const novo = r.data;
        if (novo.estado === "expirado") {
          setParouDeAtualizar(true);
        }
        setSessao((atual) => (atual && atual.id === novo.id ? { ...atual, ...novo } : atual));
      } catch (e) {
        // Pareamento que sumiu (expirou ou foi cancelado em outra aba): volta ao começo.
        if (vivo && e instanceof ApiError && e.status === 404) {
          setFase("inicio");
          setSessao(null);
          toast.error(t("Este pareamento expirou. Comece de novo."));
        }
        // Falha de rede passageira: a próxima rodada tenta de novo.
      }
    };
    const timer = setInterval(() => void tick(), INTERVALO_MS);
    void tick();
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [fase, sessaoId, parouDeAtualizar, concluir, t]);

  const comecar = async (comTelefone: boolean) => {
    setOcupado(true);
    setAviso(null);
    try {
      const r = await apiClient.post<{ data: Andamento }>("/api/v1/channels/pareamento-qr", {
        telefone: comTelefone ? telefone : null,
      });
      esperaDesde.current = Date.now();
      setParouDeAtualizar(false);
      setSessao(r.data);
      setFase("qr");
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível iniciar a conexão."));
    } finally {
      setOcupado(false);
    }
  };

  const gerarOutro = async (comTelefone: boolean) => {
    if (!sessao) return;
    setOcupado(true);
    try {
      const r = await apiClient.post<{ data: Andamento }>(
        `/api/v1/channels/pareamento-qr/${encodeURIComponent(sessao.id)}`,
        { telefone: comTelefone ? telefone : null },
      );
      esperaDesde.current = Date.now();
      setParouDeAtualizar(false);
      setSessao(r.data);
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível gerar outro QR Code."));
    } finally {
      setOcupado(false);
    }
  };

  const cancelar = async () => {
    if (!sessao) return;
    setOcupado(true);
    try {
      await apiClient.delete(`/api/v1/channels/pareamento-qr/${encodeURIComponent(sessao.id)}`);
      setFase("inicio");
      setSessao(null);
      setParouDeAtualizar(false);
      setMostrarCodigo(false);
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível cancelar."));
    } finally {
      setOcupado(false);
    }
  };

  const bloqueado = !!bloqueio?.desabilitado;
  const telefoneValido = /^\d{10,15}$/.test(telefone.replace(/\D/g, ""));

  return (
    <div className="flex flex-col gap-4" data-testid="pareamento-qr-root">
      <Card className="flex flex-col gap-4 p-4">
        <div>
          <h3 className="text-sm font-semibold">{t("Conectar WhatsApp (QR Code)")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "O CRM cria a conexão sozinho. Você só lê o QR Code com o celular do número que vai atender seus clientes.",
            )}
          </p>
        </div>

        {fase === "inicio" && (
          <div className="flex flex-col gap-3">
            <div>
              <Button
                onClick={() => void comecar(false)}
                disabled={ocupado || bloqueado}
                title={bloqueado ? (bloqueio?.motivo ?? undefined) : undefined}
              >
                {ocupado ? t("Conectando…") : t("Gerar QR Code")}
              </Button>
              {bloqueado && <AvisoDeLimiteDeConexoes motivo={bloqueio?.motivo} />}
            </div>
            <CodigoNoCelular
              aberto={mostrarCodigo}
              alternar={() => setMostrarCodigo((v) => !v)}
              telefone={telefone}
              setTelefone={setTelefone}
              valido={telefoneValido}
              ocupado={ocupado || bloqueado}
              acao={() => void comecar(true)}
            />
          </div>
        )}

        {fase === "qr" && sessao && (
          <div className="flex flex-col gap-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>{t("Abra o WhatsApp no celular.")}</li>
              <li>{t("Vá em Dispositivos conectados.")}</li>
              <li>{t("Toque em Conectar dispositivo e aponte a câmera para o QR Code.")}</li>
            </ol>

            <div className="flex flex-col items-center gap-3">
              {sessao.codigo ? (
                <div className="flex flex-col items-center gap-2" data-testid="pareamento-codigo">
                  <p className="text-center text-xs text-muted-foreground">
                    {t(
                      "No WhatsApp, em Dispositivos conectados, escolha conectar com número de telefone e digite este código:",
                    )}
                  </p>
                  <code className="rounded-md border bg-muted px-4 py-2 text-2xl font-semibold tracking-widest">
                    {sessao.codigo}
                  </code>
                </div>
              ) : sessao.qr && !parouDeAtualizar ? (
                // eslint-disable-next-line @next/next/no-img-element -- imagem base64 gerada na hora, não um asset otimizável pelo next/image
                <img
                  src={sessao.qr}
                  alt={t("QR Code para conectar o WhatsApp")}
                  className="h-64 w-64 rounded-md border bg-white p-2"
                  data-testid="pareamento-qr-imagem"
                />
              ) : parouDeAtualizar ? (
                <p className="text-sm text-muted-foreground" data-testid="pareamento-qr-expirado">
                  {t("O QR Code expirou.")}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="pareamento-qr-gerando">
                  {t("Gerando o QR Code…")}
                </p>
              )}
              {!parouDeAtualizar && (
                <p className="text-xs text-muted-foreground">{t("Aguardando a leitura…")}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {parouDeAtualizar && (
                <Button onClick={() => void gerarOutro(false)} disabled={ocupado}>
                  {t("Gerar outro")}
                </Button>
              )}
              <Button variant="outline" onClick={() => void cancelar()} disabled={ocupado}>
                {t("Cancelar")}
              </Button>
            </div>

            {!sessao.codigo && (
              <CodigoNoCelular
                aberto={mostrarCodigo}
                alternar={() => setMostrarCodigo((v) => !v)}
                telefone={telefone}
                setTelefone={setTelefone}
                valido={telefoneValido}
                ocupado={ocupado}
                acao={() => void gerarOutro(true)}
              />
            )}
          </div>
        )}
      </Card>

      {aviso && (
        <Card className="flex flex-col gap-2 border-warning/40 bg-warning-bg p-4">
          <h3 className="text-sm font-semibold">{t("Falta ligar a volta")}</h3>
          <p className="text-xs text-muted-foreground">{aviso}</p>
        </Card>
      )}
    </div>
  );
}

function CodigoNoCelular({
  aberto,
  alternar,
  telefone,
  setTelefone,
  valido,
  ocupado,
  acao,
}: {
  aberto: boolean;
  alternar: () => void;
  telefone: string;
  setTelefone: (v: string) => void;
  valido: boolean;
  ocupado: boolean;
  acao: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={alternar}
        className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        data-testid="pareamento-alternar-codigo"
      >
        {t("Conectar com código no celular")}
      </button>
      {aberto && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pareamento-telefone">{t("Número do WhatsApp (com DDI e DDD)")}</Label>
          <div className="flex gap-2">
            <Input
              id="pareamento-telefone"
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              placeholder="5511999999999"
              inputMode="numeric"
              autoComplete="off"
            />
            <Button variant="outline" onClick={acao} disabled={ocupado || !valido}>
              {t("Gerar código")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
