"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  ajustarLimitesDaOrganizacao,
  trocarPlanoDaOrganizacao,
} from "@/app/actions/admin/planoDaOrganizacao";
import {
  ajustarTokens,
  cancelarAdicional,
  contratarAdicional,
  creditarTokens,
} from "@/app/actions/admin/carteiraDeTokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  ajusteDoFormulario,
  estadoInicialDoAjuste,
  type CampoDeAjuste,
  type EstadoDoFormularioDeAjuste,
} from "@/lib/billing/planos/formulario-de-ajuste";
import {
  CHAVES_DE_LIMITE,
  type AjusteDeLimites,
  type ChaveDeLimite,
  type Limites,
} from "@/lib/billing/planos/limites";
import type { LinhaLivroCaixa, ResultadoLivroCaixaDoCiclo, TipoLinhaLivroCaixa } from "@/lib/billing/tokens/livro-caixa-do-ciclo";
import type { ResultadoPainelDeMargem } from "@/lib/billing/tokens/margem";
import { FONTES_DA_CARTEIRA, type FonteCarteira, type ResultadoSaldoDaCarteira } from "@/lib/billing/tokens/saldo-da-organizacao";
import { formatCentsBRL, formatCentsUSD, parseReaisToCents } from "@/lib/money";

// ---------------------------------------------------------------------------
// Tipos e tabelas de rótulo
// ---------------------------------------------------------------------------

export interface PlanoAtivo {
  code: string;
  name: string;
  version: number;
  price_monthly_cents: number;
  for_sale: boolean;
}

/** Uma linha de `billing_token_adicionais` com `ativo = true` (fase F2-B, tarefa 7). */
export interface AdicionalAtivo {
  id: string;
  tokens_por_ciclo: number;
  valor_cents: number | null;
  nota: string | null;
  created_at: string;
}

interface TenantPlanoClientProps {
  organizationId: string;
  podeEscrever: boolean;
  plano: { code: string; name: string; version: number };
  contrato: { status: string; cycle: string | null } | null;
  leituraFalhou: boolean;
  limitesEmVigor: Limites;
  limitesDoPlano: Limites;
  ajusteAtual: AjusteDeLimites;
  notaAtual: string | null;
  planosAtivos: PlanoAtivo[];
  saldo: ResultadoSaldoDaCarteira;
  livroCaixa: ResultadoLivroCaixaDoCiclo;
  margem: ResultadoPainelDeMargem;
  adicionaisAtivos: AdicionalAtivo[];
  leituraDosAdicionaisFalhou: boolean;
}

/** Nome legível de cada fonte da carteira, na mesma ordem de `FONTES_DA_CARTEIRA`. */
const ROTULO_DA_FONTE: Record<FonteCarteira, string> = {
  plano: "Do plano contratado",
  adicional: "Assinatura adicional",
  avulso: "Pacote avulso",
};

/** Nome legível de cada tipo de linha do livro-caixa. */
const ROTULO_DO_TIPO: Record<TipoLinhaLivroCaixa, string> = {
  concessao: "Concessão",
  credito: "Crédito",
  consumo: "Consumo",
  ajuste: "Ajuste",
};

/** Nome legível de cada chave de limite, na mesma ordem de `CHAVES_DE_LIMITE`. */
const ROTULO_DA_CHAVE: Record<ChaveDeLimite, string> = {
  funis: "Funis",
  etapas_por_funil: "Etapas por funil",
  leads: "Leads",
  membros: "Membros",
  conexoes: "Conexões",
  integracoes_webhook: "Integrações webhook",
  tokens_ia_mes: "Tokens de IA por mês",
};

const CONTRATO_STATUS_VARIANT: Record<string, "success" | "info" | "warning" | "error" | "neutral"> = {
  avaliacao: "info",
  ativa: "success",
  atrasada: "warning",
  suspensa: "error",
  cancelada: "error",
};

function rotuloDoStatusDoContrato(status: string, t: (texto: string) => string): string {
  switch (status) {
    case "avaliacao":
      return t("Em avaliação");
    case "ativa":
      return t("Ativa");
    case "atrasada":
      return t("Atrasada");
    case "suspensa":
      return t("Suspensa");
    case "cancelada":
      return t("Cancelada");
    default:
      // Valor fora do vocabulário conhecido: aparece cru de propósito, como em
      // `TenantOverview.tsx`. Esconder um estado que a tela não sabe nomear é
      // pior que mostrá-lo.
      return status;
  }
}

function rotuloDoCiclo(cycle: string, t: (texto: string) => string): string {
  switch (cycle) {
    case "monthly":
      return t("Mensal");
    case "yearly":
      return t("Anual");
    default:
      return cycle;
  }
}

function formatarLimite(
  valor: number | null,
  tagDoIdioma: string,
  t: (texto: string) => string,
): string {
  return valor === null ? t("sem limite") : valor.toLocaleString(tagDoIdioma);
}

function formatarCelulaDoAjuste(
  chave: ChaveDeLimite,
  ajuste: AjusteDeLimites,
  tagDoIdioma: string,
  t: (texto: string) => string,
): string {
  if (!(chave in ajuste)) return t("herda do plano");
  const valor = ajuste[chave];
  return valor === null || valor === undefined ? t("sem limite") : valor.toLocaleString(tagDoIdioma);
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

export function TenantPlanoClient({
  organizationId,
  podeEscrever,
  plano,
  contrato,
  leituraFalhou,
  limitesEmVigor,
  limitesDoPlano,
  ajusteAtual,
  notaAtual,
  planosAtivos,
  saldo,
  livroCaixa,
  margem,
  adicionaisAtivos,
  leituraDosAdicionaisFalhou,
}: TenantPlanoClientProps) {
  const t = useT();
  const router = useRouter();
  const tagDoIdioma = useTagDeIdioma();

  // ── Trocar plano ──────────────────────────────────────────────────────
  // Sem contrato lido direito (leituraFalhou), `plano.code` é o fallback
  // Ilimitado: não pré-selecioná-lo evita que o admin confirme uma troca
  // pensando que estava confirmando o plano atual, quando na verdade não se
  // sabe qual é.
  const [planoSelecionado, setPlanoSelecionado] = useState(leituraFalhou ? "" : plano.code);
  const [trocandoPlano, iniciarTrocaDePlano] = useTransition();

  // Trocar de plano é permitido em três casos, não só "código diferente":
  //
  // 1. Sem contrato gravado: `plano.code` é o fallback Ilimitado que
  //    `planoDaOrganizacao` inventa quando não existe linha em
  //    `billing_contracts`, e selecionar esse mesmo código ainda GRAVA o
  //    primeiro contrato da organização, que não é um no-op.
  // 2. Código diferente do contratado: a troca óbvia.
  // 3. Mesmo código, mas a versão ATIVA dele (a que `planosAtivos` lista)
  //    difere da versão que o contrato tem hoje: a organização está numa
  //    versão INATIVA do plano, e mover para a versão ativa do mesmo código
  //    também é uma escrita real, mesmo sem trocar `plan_code`.
  const versaoAtivaDoPlanoSelecionado = planosAtivos.find(
    (p) => p.code === planoSelecionado,
  )?.version;
  const podeSalvarTrocaDePlano =
    Boolean(planoSelecionado) &&
    (contrato === null ||
      planoSelecionado !== plano.code ||
      versaoAtivaDoPlanoSelecionado !== plano.version);

  function salvarPlano() {
    if (!planoSelecionado) return;
    iniciarTrocaDePlano(async () => {
      const r = await trocarPlanoDaOrganizacao({ organizationId, planCode: planoSelecionado });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Plano trocado."));
      router.refresh();
    });
  }

  // ── Ajustar limites ───────────────────────────────────────────────────
  const [estado, setEstado] = useState<EstadoDoFormularioDeAjuste>(() =>
    estadoInicialDoAjuste(ajusteAtual),
  );
  const [nota, setNota] = useState(notaAtual ?? "");
  const [erro, setErro] = useState<{ chave: ChaveDeLimite; mensagem: string } | null>(null);
  const [ajustando, iniciarAjuste] = useTransition();

  function atualizarModo(chave: ChaveDeLimite, modo: CampoDeAjuste["modo"]) {
    setEstado((atual) => {
      const anterior = atual[chave];
      const novoCampo: CampoDeAjuste =
        modo === "valor"
          ? { modo: "valor", valor: anterior.modo === "valor" ? anterior.valor : "" }
          : { modo };
      return { ...atual, [chave]: novoCampo };
    });
  }

  function atualizarValor(chave: ChaveDeLimite, valor: string) {
    setEstado((atual) => ({ ...atual, [chave]: { modo: "valor", valor } }));
  }

  function salvarAjuste() {
    const resultado = ajusteDoFormulario(estado);
    if (!resultado.ok) {
      setErro({ chave: resultado.chave, mensagem: resultado.erro });
      toast.error(resultado.erro);
      return;
    }
    setErro(null);
    iniciarAjuste(async () => {
      const r = await ajustarLimitesDaOrganizacao({
        organizationId,
        limites: resultado.limites,
        nota: nota.trim().length > 0 ? nota.trim() : undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Ajuste salvo."));
      router.refresh();
    });
  }

  function removerAjuste() {
    setErro(null);
    iniciarAjuste(async () => {
      const r = await ajustarLimitesDaOrganizacao({ organizationId, limites: {} });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setEstado(estadoInicialDoAjuste(null));
      setNota("");
      toast.success(t("Ajuste removido."));
      router.refresh();
    });
  }

  // ── Carteira de tokens de IA (fase F2-B, tarefa 7) ──────────────────────
  //
  // As três chaves idempotentes (decisão 16) nascem quando o COMPONENTE
  // monta (`useState(() => crypto.randomUUID())`, calculado uma vez só) e
  // são trocadas por uma nova depois de CADA envio bem-sucedido: reenviar o
  // MESMO formulário sem recarregar a página (duplo clique, erro de rede que
  // o admin tenta de novo) usa a MESMA chave e não credita/contrata/ajusta
  // duas vezes; um envio novo, de propósito, usa uma chave nova.
  const [chaveCredito, setChaveCredito] = useState(() => crypto.randomUUID());
  const [tokensCredito, setTokensCredito] = useState("");
  const [valorCredito, setValorCredito] = useState("");
  const [notaCredito, setNotaCredito] = useState("");
  const [creditando, iniciarCredito] = useTransition();

  function creditar() {
    const tokens = Number(tokensCredito);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      toast.error(t("Informe uma quantidade de tokens válida."));
      return;
    }
    const valorCents = valorCredito.trim().length > 0 ? parseReaisToCents(valorCredito) : undefined;
    if (valorCredito.trim().length > 0 && valorCents === null) {
      toast.error(t("Valor recebido inválido."));
      return;
    }
    iniciarCredito(async () => {
      const r = await creditarTokens({
        organizationId,
        tokens,
        chave: chaveCredito,
        valorCents: valorCents ?? undefined,
        nota: notaCredito.trim().length > 0 ? notaCredito.trim() : undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.jaRegistrado ? t("Já registrado antes: nada foi creditado de novo.") : t("Tokens creditados."));
      setTokensCredito("");
      setValorCredito("");
      setNotaCredito("");
      setChaveCredito(crypto.randomUUID());
      router.refresh();
    });
  }

  const [chaveAdicional, setChaveAdicional] = useState(() => crypto.randomUUID());
  const [tokensAdicional, setTokensAdicional] = useState("");
  const [valorAdicional, setValorAdicional] = useState("");
  const [notaAdicional, setNotaAdicional] = useState("");
  const [contratando, iniciarContratacao] = useTransition();

  function contratar() {
    const tokensPorCiclo = Number(tokensAdicional);
    if (!Number.isInteger(tokensPorCiclo) || tokensPorCiclo <= 0) {
      toast.error(t("Informe uma quantidade de tokens por ciclo válida."));
      return;
    }
    const valorCents = valorAdicional.trim().length > 0 ? parseReaisToCents(valorAdicional) : undefined;
    if (valorAdicional.trim().length > 0 && valorCents === null) {
      toast.error(t("Valor recebido inválido."));
      return;
    }
    iniciarContratacao(async () => {
      const r = await contratarAdicional({
        organizationId,
        tokensPorCiclo,
        chave: chaveAdicional,
        valorCents: valorCents ?? undefined,
        nota: notaAdicional.trim().length > 0 ? notaAdicional.trim() : undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.jaRegistrado ? t("Já registrado antes: nada foi contratado de novo.") : t("Adicional contratado."));
      setTokensAdicional("");
      setValorAdicional("");
      setNotaAdicional("");
      setChaveAdicional(crypto.randomUUID());
      router.refresh();
    });
  }

  const [cancelandoId, setCancelandoId] = useState<string | null>(null);
  const [cancelando, iniciarCancelamento] = useTransition();

  function cancelar(adicionalId: string) {
    setCancelandoId(adicionalId);
    iniciarCancelamento(async () => {
      const r = await cancelarAdicional({ organizationId, adicionalId });
      if (!r.ok) {
        toast.error(r.error);
        setCancelandoId(null);
        return;
      }
      toast.success(r.jaRegistrado ? t("Já estava cancelado.") : t("Adicional cancelado."));
      setCancelandoId(null);
      router.refresh();
    });
  }

  const [chaveAjuste, setChaveAjuste] = useState(() => crypto.randomUUID());
  const [fonteAjuste, setFonteAjuste] = useState<FonteCarteira>("plano");
  const [sinalAjuste, setSinalAjuste] = useState<"creditar" | "debitar">("creditar");
  const [tokensAjuste, setTokensAjuste] = useState("");
  const [compensaAjuste, setCompensaAjuste] = useState("");
  const [notaAjuste, setNotaAjuste] = useState("");
  const [ajustandoTokens, iniciarAjusteDeTokens] = useTransition();

  function ajustar() {
    const magnitude = Number(tokensAjuste);
    if (!Number.isInteger(magnitude) || magnitude <= 0) {
      toast.error(t("Informe uma quantidade de tokens válida."));
      return;
    }
    if (notaAjuste.trim().length === 0) {
      toast.error(t("O ajuste precisa de uma nota."));
      return;
    }
    const tokensComSinal = sinalAjuste === "debitar" ? -magnitude : magnitude;
    iniciarAjusteDeTokens(async () => {
      const r = await ajustarTokens({
        organizationId,
        fonte: fonteAjuste,
        tokens: tokensComSinal,
        chave: chaveAjuste,
        compensaId: compensaAjuste.trim().length > 0 ? compensaAjuste.trim() : undefined,
        nota: notaAjuste.trim(),
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.jaRegistrado ? t("Já registrado antes: nada foi ajustado de novo.") : t("Ajuste lançado."));
      setTokensAjuste("");
      setCompensaAjuste("");
      setNotaAjuste("");
      setChaveAjuste(crypto.randomUUID());
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/* Cabeçalho: plano atual, versão e estado do contrato */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Plano contratado")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {leituraFalhou ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {t(
                "Não foi possível ler o plano desta organização agora. Os limites desta tela não refletem a realidade: recarregue a página antes de decidir qualquer coisa com base neles.",
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-semibold">{plano.name}</span>
              <Badge variant="neutral">{`v${plano.version}`}</Badge>
              {contrato ? (
                <>
                  <Badge variant={CONTRATO_STATUS_VARIANT[contrato.status] ?? "neutral"}>
                    {rotuloDoStatusDoContrato(contrato.status, t)}
                  </Badge>
                  {contrato.cycle && (
                    <Badge variant="neutral">{rotuloDoCiclo(contrato.cycle, t)}</Badge>
                  )}
                </>
              ) : (
                <Badge variant="warning">{t("Sem contrato gravado")}</Badge>
              )}
            </div>
          )}

          <p className="text-sm text-text-muted">
            {t(
              "Nesta fase nenhum limite bloqueia; eles só passam a valer quando o bloqueio for ligado.",
            )}
          </p>

          {!podeEscrever && (
            <p className="text-sm text-text-muted">
              {t(
                "Seu acesso de suporte só permite leitura. Para trocar o plano ou ajustar limites, peça a um admin com acesso completo.",
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Tabela de limites: do plano, do ajuste, em vigor */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Limites")}</CardTitle>
          <CardDescription>
            {t(
              "O que o plano contratado prevê, o que o ajuste desta organização define por cima, e o que vale hoje.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Limite")}</TableHead>
                <TableHead>{t("Do plano")}</TableHead>
                <TableHead>{t("Do ajuste")}</TableHead>
                <TableHead>{t("Em vigor")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CHAVES_DE_LIMITE.map((chave) => (
                <TableRow key={chave}>
                  <TableCell className="font-medium">{t(ROTULO_DA_CHAVE[chave])}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatarLimite(limitesDoPlano[chave], tagDoIdioma, t)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatarCelulaDoAjuste(chave, ajusteAtual, tagDoIdioma, t)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatarLimite(limitesEmVigor[chave], tagDoIdioma, t)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Trocar plano */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Trocar plano")}</CardTitle>
        </CardHeader>
        <CardContent>
          {podeEscrever ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="plano-selecionado">{t("Novo plano")}</Label>
                <Select value={planoSelecionado} onValueChange={setPlanoSelecionado}>
                  <SelectTrigger id="plano-selecionado" className="w-72">
                    <SelectValue placeholder={t("Escolha um plano")} />
                  </SelectTrigger>
                  <SelectContent>
                    {planosAtivos.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {`${p.name} · ${formatCentsBRL(p.price_monthly_cents)} ${t("por mês")}`}
                        {!p.for_sale && ` · ${t("não à venda")}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                data-testid="salvar-plano"
                onClick={salvarPlano}
                disabled={trocandoPlano || !podeSalvarTrocaDePlano}
              >
                {t("Salvar")}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t("Acesso de suporte: só leitura.")}</p>
          )}
        </CardContent>
      </Card>

      {/* Ajuste de limites por cima do plano */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Ajustar limites")}</CardTitle>
          <CardDescription>
            {t(
              "Um teto próprio desta organização, por cima do que o plano contratado prevê. Cada chave herda do plano até que você escolha outra coisa.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {podeEscrever ? (
            <div className="space-y-4">
              <div className="divide-y divide-border/60">
                {CHAVES_DE_LIMITE.map((chave) => {
                  const campo = estado[chave];
                  const idSelect = `ajuste-modo-${chave}`;
                  const idValor = `ajuste-valor-${chave}`;
                  const erroDaChave = erro?.chave === chave ? erro.mensagem : null;
                  return (
                    <div key={chave} className="flex flex-wrap items-start gap-3 py-3 first:pt-0">
                      <Label htmlFor={idSelect} className="w-44 shrink-0 self-center">
                        {t(ROTULO_DA_CHAVE[chave])}
                      </Label>
                      <Select
                        value={campo.modo}
                        onValueChange={(modo) =>
                          atualizarModo(chave, modo as CampoDeAjuste["modo"])
                        }
                      >
                        <SelectTrigger id={idSelect} className="w-52">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="herdar">{t("Herdar do plano")}</SelectItem>
                          <SelectItem value="sem_limite">{t("Sem limite")}</SelectItem>
                          <SelectItem value="valor">{t("Valor")}</SelectItem>
                        </SelectContent>
                      </Select>
                      {campo.modo === "valor" && (
                        <div className="flex flex-col gap-1">
                          <Input
                            id={idValor}
                            className="w-32"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            value={campo.valor}
                            onChange={(e) => atualizarValor(chave, e.target.value)}
                            aria-invalid={erroDaChave ? true : undefined}
                            aria-describedby={erroDaChave ? `${idValor}-erro` : undefined}
                          />
                          {erroDaChave && (
                            <p id={`${idValor}-erro`} className="text-xs text-destructive">
                              {erroDaChave}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="nota-do-ajuste">{t("Nota")}</Label>
                <Textarea
                  id="nota-do-ajuste"
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                  maxLength={500}
                  placeholder={t(
                    "Por que este ajuste existe, para quem olhar depois (visível só para admins da plataforma)",
                  )}
                />
                <p className="text-xs text-text-muted">{`${nota.length}/500`}</p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button data-testid="salvar-ajuste" onClick={salvarAjuste} disabled={ajustando}>
                  {t("Salvar ajuste")}
                </Button>
                <Button
                  data-testid="remover-ajuste"
                  variant="outline"
                  onClick={removerAjuste}
                  disabled={ajustando}
                >
                  {t("Remover ajuste")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t("Acesso de suporte: só leitura.")}</p>
          )}
        </CardContent>
      </Card>

      {/* ── Tokens de IA (fase F2-B, tarefa 7) ──────────────────────────── */}
      <h2 className="text-lg font-semibold tracking-tight">{t("Tokens de IA")}</h2>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        {t(
          "Nesta fase, embedding (base de conhecimento) e transcrição não debitam tokens da carteira: só chamadas de resposta do agente, pela credencial da instalação, consomem.",
        )}
      </div>

      {/* Saldo por fonte */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Saldo da carteira")}</CardTitle>
          <CardDescription>{t("Do ciclo atual, por fonte, na ordem em que o consumo desconta.")}</CardDescription>
        </CardHeader>
        <CardContent>
          {saldo.status === "leitura_falhou" ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler o saldo da carteira agora.")}</p>
          ) : (
            <div className="space-y-3">
              {saldo.status === "sem_limite" && <Badge variant="neutral">{t("Plano sem limite (Ilimitado)")}</Badge>}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Fonte")}</TableHead>
                    <TableHead>{t("Creditado")}</TableHead>
                    <TableHead>{t("Consumido")}</TableHead>
                    <TableHead>{t("Saldo")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {FONTES_DA_CARTEIRA.map((fonte) => {
                    const linha = saldo.porFonte[fonte];
                    return (
                      <TableRow key={fonte}>
                        <TableCell className="font-medium">{t(ROTULO_DA_FONTE[fonte])}</TableCell>
                        <TableCell className="tabular-nums">{linha.creditado.toLocaleString(tagDoIdioma)}</TableCell>
                        <TableCell className="tabular-nums">{linha.consumido.toLocaleString(tagDoIdioma)}</TableCell>
                        <TableCell className="tabular-nums">{linha.saldo.toLocaleString(tagDoIdioma)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Painel de margem (decisão 17): só a plataforma vê */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Painel de margem")}</CardTitle>
          <CardDescription>
            {t(
              "Receita em reais e custo em dólar, lado a lado, sem conversão de câmbio: câmbio não se inventa.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {margem.status === "leitura_falhou" ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler o painel de margem agora.")}</p>
          ) : (
            <div className="space-y-2 text-sm">
              <p>
                {t("Receita do ciclo")}: <span className="font-medium">{formatCentsBRL(margem.margem.receitaTotalCents)}</span>{" "}
                <span className="text-text-muted">
                  ({t("plano")} {formatCentsBRL(margem.margem.receitaPlanoCents)} · {t("adicionais")}{" "}
                  {formatCentsBRL(margem.margem.receitaAdicionaisCents)} · {t("créditos avulsos")}{" "}
                  {formatCentsBRL(margem.margem.receitaCreditosCents)})
                </span>
              </p>
              <p>
                {t("Custo conhecido do ciclo (dólar)")}:{" "}
                <span className="font-medium">{formatCentsUSD(margem.margem.custoConhecidoCentsUsd)}</span>
              </p>
              {margem.margem.custoIncompleto && (
                <Badge variant="warning">
                  {t("Custo incompleto")}: {margem.margem.chamadasCustoNulo}{" "}
                  {t("chamada(s) do ciclo sem preço conhecido")}
                </Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Adicionais ativos, com cancelar */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Adicionais ativos")}</CardTitle>
        </CardHeader>
        <CardContent>
          {leituraDosAdicionaisFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler os adicionais agora.")}</p>
          ) : adicionaisAtivos.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nenhum adicional ativo.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Tokens por ciclo")}</TableHead>
                  <TableHead>{t("Valor")}</TableHead>
                  <TableHead>{t("Nota")}</TableHead>
                  <TableHead>{t("Contratado em")}</TableHead>
                  {podeEscrever && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {adicionaisAtivos.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="tabular-nums">{a.tokens_por_ciclo.toLocaleString(tagDoIdioma)}</TableCell>
                    <TableCell>{a.valor_cents !== null ? formatCentsBRL(a.valor_cents) : "-"}</TableCell>
                    <TableCell className="max-w-xs truncate">{a.nota ?? "-"}</TableCell>
                    <TableCell>{new Date(a.created_at).toLocaleDateString(tagDoIdioma)}</TableCell>
                    {podeEscrever && (
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancelando && cancelandoId === a.id}
                          onClick={() => cancelar(a.id)}
                        >
                          {t("Cancelar")}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Livro-caixa do ciclo, com nota e autor */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Livro-caixa do ciclo")}</CardTitle>
          <CardDescription>{t("Consumo agrupado por dia; concessão, crédito e ajuste um a um.")}</CardDescription>
        </CardHeader>
        <CardContent>
          {livroCaixa.status === "leitura_falhou" ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler o livro-caixa agora.")}</p>
          ) : livroCaixa.livroCaixa.linhas.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nenhum lançamento neste ciclo ainda.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Dia")}</TableHead>
                  <TableHead>{t("Fonte")}</TableHead>
                  <TableHead>{t("Tipo")}</TableHead>
                  <TableHead>{t("Tokens")}</TableHead>
                  <TableHead>{t("Valor")}</TableHead>
                  <TableHead>{t("Nota")}</TableHead>
                  <TableHead>{t("Autor")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {livroCaixa.livroCaixa.linhas.map((linha: LinhaLivroCaixa, i: number) => (
                  <TableRow key={`${linha.dia}-${linha.fonte}-${linha.tipo}-${i}`}>
                    <TableCell>{linha.dia}</TableCell>
                    <TableCell>{t(ROTULO_DA_FONTE[linha.fonte])}</TableCell>
                    <TableCell>
                      {t(ROTULO_DO_TIPO[linha.tipo])}
                      {linha.linhas > 1 && <span className="text-text-muted"> ({linha.linhas})</span>}
                    </TableCell>
                    <TableCell className="tabular-nums">{linha.tokens.toLocaleString(tagDoIdioma)}</TableCell>
                    <TableCell>{linha.valorCents !== null ? formatCentsBRL(linha.valorCents) : "-"}</TableCell>
                    <TableCell className="max-w-xs truncate">{linha.nota ?? "-"}</TableCell>
                    <TableCell>{linha.autorNome ?? linha.autorEmail ?? "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {podeEscrever && (
        <>
          {/* Creditar pacote avulso */}
          <Card>
            <CardHeader>
              <CardTitle>{t("Creditar pacote avulso")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="credito-tokens">{t("Tokens")}</Label>
                  <Input
                    id="credito-tokens"
                    className="w-40"
                    inputMode="numeric"
                    value={tokensCredito}
                    onChange={(e) => setTokensCredito(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="credito-valor">{t("Valor recebido (opcional)")}</Label>
                  <Input
                    id="credito-valor"
                    className="w-40"
                    placeholder="R$"
                    value={valorCredito}
                    onChange={(e) => setValorCredito(e.target.value)}
                  />
                </div>
                <Button data-testid="creditar-tokens" onClick={creditar} disabled={creditando}>
                  {t("Creditar")}
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credito-nota">{t("Nota (opcional)")}</Label>
                <Textarea
                  id="credito-nota"
                  value={notaCredito}
                  onChange={(e) => setNotaCredito(e.target.value)}
                  maxLength={500}
                  placeholder={t("Não coloque dado pessoal aqui: a nota fica registrada e nunca é apagada.")}
                />
              </div>
            </CardContent>
          </Card>

          {/* Contratar adicional */}
          <Card>
            <CardHeader>
              <CardTitle>{t("Contratar adicional")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="adicional-tokens">{t("Tokens por ciclo")}</Label>
                  <Input
                    id="adicional-tokens"
                    className="w-40"
                    inputMode="numeric"
                    value={tokensAdicional}
                    onChange={(e) => setTokensAdicional(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adicional-valor">{t("Valor mensal (opcional)")}</Label>
                  <Input
                    id="adicional-valor"
                    className="w-40"
                    placeholder="R$"
                    value={valorAdicional}
                    onChange={(e) => setValorAdicional(e.target.value)}
                  />
                </div>
                <Button data-testid="contratar-adicional" onClick={contratar} disabled={contratando}>
                  {t("Contratar")}
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adicional-nota">{t("Nota (opcional)")}</Label>
                <Textarea
                  id="adicional-nota"
                  value={notaAdicional}
                  onChange={(e) => setNotaAdicional(e.target.value)}
                  maxLength={500}
                  placeholder={t("Não coloque dado pessoal aqui: a nota fica registrada e nunca é apagada.")}
                />
              </div>
            </CardContent>
          </Card>

          {/* Ajustar tokens (sinal livre) */}
          <Card>
            <CardHeader>
              <CardTitle>{t("Ajustar tokens")}</CardTitle>
              <CardDescription>{t("Para estornar um débito errado ou corrigir na mão. A nota é obrigatória.")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ajuste-fonte">{t("Fonte")}</Label>
                  <Select value={fonteAjuste} onValueChange={(v) => setFonteAjuste(v as FonteCarteira)}>
                    <SelectTrigger id="ajuste-fonte" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONTES_DA_CARTEIRA.map((fonte) => (
                        <SelectItem key={fonte} value={fonte}>
                          {t(ROTULO_DA_FONTE[fonte])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ajuste-sinal">{t("Sinal")}</Label>
                  <Select value={sinalAjuste} onValueChange={(v) => setSinalAjuste(v as "creditar" | "debitar")}>
                    <SelectTrigger id="ajuste-sinal" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="creditar">{t("Creditar (+)")}</SelectItem>
                      <SelectItem value="debitar">{t("Debitar (-)")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ajuste-tokens">{t("Tokens")}</Label>
                  <Input
                    id="ajuste-tokens"
                    className="w-40"
                    inputMode="numeric"
                    value={tokensAjuste}
                    onChange={(e) => setTokensAjuste(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ajuste-compensa">{t("Linha que compensa (opcional)")}</Label>
                  <Input
                    id="ajuste-compensa"
                    className="w-64"
                    placeholder={t("id da linha do livro-caixa")}
                    value={compensaAjuste}
                    onChange={(e) => setCompensaAjuste(e.target.value)}
                  />
                </div>
                <Button data-testid="ajustar-tokens" onClick={ajustar} disabled={ajustandoTokens}>
                  {t("Ajustar")}
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ajuste-nota">{t("Nota (obrigatória)")}</Label>
                <Textarea
                  id="ajuste-nota"
                  value={notaAjuste}
                  onChange={(e) => setNotaAjuste(e.target.value)}
                  maxLength={500}
                  placeholder={t("Por que este ajuste existe. Não coloque dado pessoal: fica registrado e nunca é apagado.")}
                />
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
