"use client";
import * as React from "react";
import { toast } from "sonner";
import { z } from "zod";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plug, Plus, Trash, Warning } from "@/lib/ui/icons";
import type { ConexaoPublica, FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";
import {
  useAprovarFerramentaMcp,
  useAtualizarFerramentasMcp,
  useCriarConexaoMcp,
  useEditarConexaoMcp,
  useMcpConexoes,
  useRemoverConexaoMcp,
} from "@/hooks/ai/useMcpConexoes";

interface Props {
  initialData: ConexaoPublica[];
  canWrite: boolean;
}

const cadastroSchema = z.object({
  apelido: z
    .string()
    .trim()
    .min(2, "O apelido usa só letras minúsculas e números, de 2 a 12")
    .max(12, "O apelido usa só letras minúsculas e números, de 2 a 12")
    .regex(/^[a-z0-9]+$/, "O apelido usa só letras minúsculas e números, de 2 a 12"),
  nome: z.string().trim().min(2, "O nome precisa ter de 2 a 80 caracteres").max(80, "O nome precisa ter de 2 a 80 caracteres"),
  url: z
    .string()
    .trim()
    .min(1, "O endereço é obrigatório")
    .refine((v) => v.startsWith("https://"), "O endereço do servidor precisa começar com https://."),
  cabecalho_nome: z.string().trim().max(64).optional(),
  cabecalho_valor: z.string().max(2000).optional(),
});

function formatDate(iso: string | null, idioma: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(idioma, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `null` (sem decisão) vale como a SUGESTÃO do servidor até o admin confirmar. */
function contaComoRisco(f: FerramentaEmCache): "seguro" | "critico" {
  const confirmado = f.somente_leitura_confirmado ?? null;
  if (confirmado === true) return "seguro";
  return "critico";
}

export function McpClient({ initialData, canWrite }: Props) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { data } = useMcpConexoes(initialData);
  const conexoes = data ?? [];

  const criar = useCriarConexaoMcp();
  const editar = useEditarConexaoMcp();
  const atualizar = useAtualizarFerramentasMcp();
  const remover = useRemoverConexaoMcp();
  const aprovar = useAprovarFerramentaMcp();

  const [addOpen, setAddOpen] = React.useState(false);
  const [removerId, setRemoverId] = React.useState<string | null>(null);
  const [trocarChaveId, setTrocarChaveId] = React.useState<string | null>(null);

  function handleAtualizar(conexao: ConexaoPublica) {
    atualizar.mutate(conexao.id, {
      onSuccess: () => toast.success(t("Ferramentas atualizadas.")),
      onError: showApiError,
    });
  }

  /**
   * `versao` é o `atualizada_em` que ESTA linha da tela tem agora — o que o
   * admin viu antes de clicar. `aprovarFerramenta` recusa com 409 quando o
   * banco já tem outra coisa (auditoria M1); o hook invalida a lista nesse
   * caso, e a próxima tentativa já parte da versão nova.
   */
  function handleAprovar(conexao: ConexaoPublica, nome: string, aprovacao: boolean | null) {
    aprovar.mutate(
      { id: conexao.id, nome, aprovacao, versao: conexao.atualizada_em },
      { onError: showApiError },
    );
  }

  function handleLigarDesligar(conexao: ConexaoPublica) {
    editar.mutate(
      { id: conexao.id, patch: { ativa: !conexao.ativa } },
      {
        onSuccess: () =>
          toast.success(conexao.ativa ? t("Conexão desligada.") : t("Conexão ligada.")),
        onError: showApiError,
      },
    );
  }

  function handleRemover() {
    if (!removerId) return;
    remover.mutate(removerId, {
      onSuccess: () => {
        toast.success(t("Conexão removida."));
        setRemoverId(null);
      },
      onError: showApiError,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-accent-soft p-3 text-xs text-text-muted">
        <p>{t("Cada ferramenta marcada num agente ocupa uma das 25 vagas de capacidade dele.")}</p>
        {canWrite && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus size={14} aria-hidden className="mr-2" /> {t("Conectar servidor MCP")}
          </Button>
        )}
      </div>

      {conexoes.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Plug size={28} aria-hidden className="text-muted-foreground" />
          <h2 className="font-medium">{t("Nenhuma conexão MCP cadastrada ainda")}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t(
              "Cadastre um servidor MCP (n8n, DeepWiki, Context7, sistema de cliente) e as ferramentas dele viram capacidades que você libera agente a agente.",
            )}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {conexoes.map((conexao) => {
            const aguardando = conexao.ferramentas.filter(
              (f) => f.recusada === null && (f.somente_leitura_confirmado ?? null) === null,
            ).length;

            return (
              <li key={conexao.id}>
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          {conexao.nome}
                          <Badge variant={conexao.ativa ? "success" : "neutral"} className="text-[10px]">
                            {conexao.ativa ? t("Ativa") : t("Desligada")}
                          </Badge>
                          {aguardando > 0 && (
                            <Badge variant="warning" className="text-[10px]">
                              {aguardando} {t("aguardando aprovação")}
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription>
                          {conexao.apelido} · {conexao.url} ·{" "}
                          {conexao.tem_cabecalho ? t("com chave") : t("sem chave")} ·{" "}
                          {conexao.ferramentas.length} {t("ferramentas")}
                        </CardDescription>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("Ferramentas atualizadas em")} {formatDate(conexao.ferramentas_atualizadas_em, tagDoIdioma)}
                        </p>
                        {conexao.ultimo_erro && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                            <Warning size={12} aria-hidden /> {conexao.ultimo_erro}
                          </p>
                        )}
                      </div>
                      {canWrite && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={atualizar.isPending}
                            onClick={() => handleAtualizar(conexao)}
                          >
                            {t("Atualizar ferramentas")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => handleLigarDesligar(conexao)}>
                            {conexao.ativa ? t("Desligar") : t("Ligar")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setTrocarChaveId(conexao.id)}>
                            {t("Trocar chave")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => setRemoverId(conexao.id)}
                          >
                            <Trash size={14} aria-hidden />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {conexao.ferramentas.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("Nenhuma ferramenta neste servidor.")}</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {conexao.ferramentas.map((ferramenta) => {
                          if (ferramenta.recusada) {
                            return (
                              <li
                                key={ferramenta.nome}
                                className="flex flex-col gap-1 rounded-md border border-border/60 p-3 text-sm opacity-60"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{ferramenta.nome}</span>
                                  <Badge variant="error" className="text-[10px]">
                                    {t("recusada")}
                                  </Badge>
                                </div>
                                <p className="text-xs text-destructive">{ferramenta.recusada}</p>
                              </li>
                            );
                          }

                          const confirmado = ferramenta.somente_leitura_confirmado ?? null;
                          const risco = contaComoRisco(ferramenta);

                          return (
                            <li
                              key={ferramenta.nome}
                              className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3 text-sm"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{ferramenta.nome}</span>
                                {confirmado === true && (
                                  <Badge variant="success" className="text-[10px]">
                                    {t("Só consulta")}
                                  </Badge>
                                )}
                                {confirmado === false && (
                                  <Badge variant="warning" className="text-[10px]">
                                    {t("Altera dados")}
                                  </Badge>
                                )}
                                {confirmado === null && (
                                  <Badge variant="neutral" className="text-[10px]">
                                    {t("Aguardando aprovação")}
                                  </Badge>
                                )}
                                {ferramenta.mudou_desde_aprovacao && (
                                  <Badge variant="warning" className="text-[10px]">
                                    {t("mudou desde a última aprovação")}
                                  </Badge>
                                )}
                                <span className="text-xs text-muted-foreground">
                                  {t("Sugestão do servidor:")}{" "}
                                  {ferramenta.somente_leitura ? t("só consulta") : t("altera dados")}
                                </span>
                              </div>
                              {ferramenta.descricao && (
                                <p className="text-text-muted">{ferramenta.descricao}</p>
                              )}
                              {canWrite && (
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant={risco === "seguro" && confirmado === true ? "default" : "outline"}
                                    disabled={aprovar.isPending}
                                    onClick={() => handleAprovar(conexao, ferramenta.nome, true)}
                                  >
                                    {t("Só consulta")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant={confirmado === false ? "default" : "outline"}
                                    disabled={aprovar.isPending}
                                    onClick={() => handleAprovar(conexao, ferramenta.nome, false)}
                                  >
                                    {t("Altera dados")}
                                  </Button>
                                  {confirmado !== null && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={aprovar.isPending}
                                      onClick={() => handleAprovar(conexao, ferramenta.nome, null)}
                                    >
                                      {t("Desfazer aprovação")}
                                    </Button>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ConectarServidorDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        submitting={criar.isPending}
        onSubmit={(valores) =>
          criar.mutate(valores, {
            onSuccess: () => {
              toast.success(t("Servidor conectado. As ferramentas dele já entraram na lista, aguardando aprovação."));
              setAddOpen(false);
            },
            onError: showApiError,
          })
        }
      />

      <TrocarChaveDialog
        open={trocarChaveId !== null}
        onOpenChange={(open) => !open && setTrocarChaveId(null)}
        submitting={editar.isPending}
        onSubmit={(cabecalho) => {
          if (!trocarChaveId) return;
          editar.mutate(
            { id: trocarChaveId, patch: cabecalho },
            {
              onSuccess: () => {
                toast.success(t("Chave atualizada."));
                setTrocarChaveId(null);
              },
              onError: showApiError,
            },
          );
        }}
      />

      <AlertDialog open={removerId !== null} onOpenChange={(open) => !open && setRemoverId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remover esta conexão?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Os agentes que usam ferramentas dela vão mostrá-las como indisponíveis. Esta ação não pode ser desfeita.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction disabled={remover.isPending} onClick={(e) => { e.preventDefault(); handleRemover(); }}>
              {t("Remover")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Formulário "Conectar servidor MCP" ─────────────────────────────────────

interface ConectarValores {
  apelido: string;
  nome: string;
  url: string;
  cabecalho_nome?: string;
  cabecalho_valor?: string;
}

function ConectarServidorDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  onSubmit: (valores: ConectarValores) => void;
}) {
  const t = useT();
  const [apelido, setApelido] = React.useState("");
  const [nome, setNome] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [cabecalhoNome, setCabecalhoNome] = React.useState("Authorization");
  const [cabecalhoValor, setCabecalhoValor] = React.useState("");
  const [erros, setErros] = React.useState<Partial<Record<keyof ConectarValores, string>>>({});

  function reset() {
    setApelido("");
    setNome("");
    setUrl("");
    setCabecalhoNome("Authorization");
    setCabecalhoValor("");
    setErros({});
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErros({});
    const parsed = cadastroSchema.safeParse({
      apelido,
      nome,
      url,
      cabecalho_nome: cabecalhoValor ? cabecalhoNome : undefined,
      cabecalho_valor: cabecalhoValor || undefined,
    });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErros({
        apelido: flat.apelido?.[0] ? t(flat.apelido[0]) : undefined,
        nome: flat.nome?.[0] ? t(flat.nome[0]) : undefined,
        url: flat.url?.[0] ? t(flat.url[0]) : undefined,
      });
      return;
    }
    onSubmit(parsed.data);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Conectar servidor MCP")}</DialogTitle>
          <DialogDescription>
            {t(
              "LGPD: os dados que o agente enviar para esta ferramenta (mensagens e dados do cliente) saem para o servidor de terceiro configurado aqui.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mcp-nome">{t("Nome")}</Label>
            <Input id="mcp-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
            {erros.nome && <p className="text-xs text-destructive">{erros.nome}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-apelido">{t("Apelido")}</Label>
            <Input
              id="mcp-apelido"
              value={apelido}
              onChange={(e) => setApelido(e.target.value.toLowerCase())}
              placeholder="n8n"
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("Vira o começo do nome das ferramentas; não muda depois.")}
            </p>
            {erros.apelido && <p className="text-xs text-destructive">{erros.apelido}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-url">{t("Endereço")}</Label>
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              required
            />
            {erros.url && <p className="text-xs text-destructive">{erros.url}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-cabecalho-nome">{t("Nome do cabeçalho")}</Label>
            <Input
              id="mcp-cabecalho-nome"
              value={cabecalhoNome}
              onChange={(e) => setCabecalhoNome(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-cabecalho-valor">{t("Valor")}</Label>
            <Input
              id="mcp-cabecalho-valor"
              type="password"
              autoComplete="off"
              value={cabecalhoValor}
              onChange={(e) => setCabecalhoValor(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("Guardado cifrado. Depois de gravar ele não é mostrado de novo.")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("Conectando…") : t("Conectar e listar ferramentas")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── "Trocar chave" ──────────────────────────────────────────────────────────

function TrocarChaveDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  onSubmit: (cabecalho: { cabecalho_nome: string; cabecalho_valor: string }) => void;
}) {
  const t = useT();
  const [cabecalhoNome, setCabecalhoNome] = React.useState("Authorization");
  const [cabecalhoValor, setCabecalhoValor] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setCabecalhoNome("Authorization");
      setCabecalhoValor("");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Trocar chave")}</DialogTitle>
          <DialogDescription>
            {t("Guardado cifrado. Depois de gravar ele não é mostrado de novo.")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!cabecalhoValor) return;
            onSubmit({ cabecalho_nome: cabecalhoNome, cabecalho_valor: cabecalhoValor });
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="mcp-trocar-nome">{t("Nome do cabeçalho")}</Label>
            <Input
              id="mcp-trocar-nome"
              value={cabecalhoNome}
              onChange={(e) => setCabecalhoNome(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-trocar-valor">{t("Valor")}</Label>
            <Input
              id="mcp-trocar-valor"
              type="password"
              autoComplete="off"
              value={cabecalhoValor}
              onChange={(e) => setCabecalhoValor(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
