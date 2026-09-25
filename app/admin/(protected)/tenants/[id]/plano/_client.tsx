"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  ajustarLimitesDaOrganizacao,
  darCarenciaExtra,
  trocarPlanoDaOrganizacao,
} from "@/app/actions/admin/planoDaOrganizacao";
import {
  ajustarTokens,
  cancelarAdicional,
  contratarAdicional,
  creditarPacote,
  creditarTokens,
} from "@/app/actions/admin/carteiraDeTokens";
import {
  cancelarNoFimDoPeriodo,
  corrigirPeriodo,
  estornarPagamento,
  mudarEstadoDaAssinatura,
  porEmAvaliacao,
  registrarPagamento,
} from "@/app/actions/admin/assinaturaDaOrganizacao";
import {
  cancelarAssinaturaNoAsaas,
  cancelarPedidoAberto,
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
  ultimoDiaDoPeriodo,
  type PagamentoDaAssinatura,
  type ResultadoEstadoDaAssinatura,
} from "@/lib/billing/assinatura/estado-da-assinatura";
import type { ResultadoAsaasDaOrganizacao } from "@/lib/billing/asaas/leitura";
import type { EstadoDoBloqueio } from "@/lib/billing/planos/estado-do-bloqueio";
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
import { copyToClipboard } from "@/lib/clipboard";
import { formatCentsBRL, formatCentsUSD, parseReaisToCents } from "@/lib/money";
import { randomId } from "@/lib/random-id";

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

/** Uma linha de `billing_token_pacotes` com `ativo = true` (fase F4, tarefa 8, decisão 10). */
export interface PacoteAtivo {
  id: string;
  codigo: string;
  nome: string;
  tokens: number;
  preco_cents: number | null;
}

interface TenantPlanoClientProps {
  organizationId: string;
  podeEscrever: boolean;
  plano: { code: string; name: string; version: number };
  contrato: { status: string; cycle: string | null } | null;
  leituraFalhou: boolean;
  limitesEmVigor: Limites;
  limitesDoPlano: Limites;
  /** `billing_contracts.bloqueio_a_partir_de` (fase F3, tarefa 10). `null` = organização não bloqueia. */
  carenciaAtual: string | null;
  /** O estado real do bloqueio desta organização (fase F3, tarefa 9): desligado, em carência, ou valendo. */
  bloqueio: EstadoDoBloqueio;
  ajusteAtual: AjusteDeLimites;
  notaAtual: string | null;
  planosAtivos: PlanoAtivo[];
  saldo: ResultadoSaldoDaCarteira;
  livroCaixa: ResultadoLivroCaixaDoCiclo;
  margem: ResultadoPainelDeMargem;
  adicionaisAtivos: AdicionalAtivo[];
  leituraDosAdicionaisFalhou: boolean;
  /** Fase F4, tarefa 8: estado, período, cancel_at_period_end e modo leitura da assinatura. */
  assinatura: ResultadoEstadoDaAssinatura;
  pagamentos: PagamentoDaAssinatura[];
  leituraDosPagamentosFalhou: boolean;
  pacotesAtivos: PacoteAtivo[];
  leituraDosPacotesFalhou: boolean;
  /** Fase F5, Tarefa 18, decisão 22: `organizations.status`. `null` quando a leitura falhou. */
  organizacaoStatus: string | null;
  /** Fase F5, Tarefa 18: cliente, assinatura, pedidos e pagamentos com origem do Asaas. */
  asaas: ResultadoAsaasDaOrganizacao;
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

/**
 * `current_period_end`/`billing_period_end`/`dataPrevistaDaSuspensao` são
 * sempre 00:00 em America/Sao_Paulo (migração 0908, decisão 2; comentário de
 * `ultimoDiaDoPeriodo` em `lib/billing/assinatura/estado-da-assinatura.ts`).
 * Fixar o fuso aqui evita que a data mostrada dependa do fuso do SERVIDOR.
 */
const FUSO_SP = "America/Sao_Paulo";

/**
 * Pedido ainda não concluído (fase F5, decisões 11 e 25 do plano mestre): o
 * único conjunto que "Cancelar pedido" mostra, aqui e na tela de cobrança da
 * instalação (`app/admin/(protected)/sistema/cobranca/_client.tsx`).
 */
const STATUS_DE_PEDIDO_ABERTO = new Set(["criado", "processando", "aguardando_pagamento", "inconclusivo"]);

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

/**
 * O id curto (8 primeiros caracteres) de uma linha do livro-caixa, com botão
 * de copiar o id INTEIRO (item 9 da revisão, 23/09/2026): é o que preenche o
 * campo "Linha que compensa" do formulário de ajuste, e um uuid inteiro não
 * cabe legível numa coluna de tabela.
 */
function IdCurtoCopiavel({ id, t }: { id: string; t: (texto: string) => string }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <button
      type="button"
      title={id}
      className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-text-muted hover:bg-surface-elevated"
      onClick={async () => {
        const ok = await copyToClipboard(id);
        setCopiado(ok);
        if (ok) setTimeout(() => setCopiado(false), 1500);
      }}
    >
      {copiado ? t("Copiado") : id.slice(0, 8)}
    </button>
  );
}

/**
 * "Cancelar assinatura no Asaas" (fase F5, Tarefa 19): reusa
 * `cancelarAssinaturaNoAsaas` (`app/actions/admin/cobrancaAsaas.ts`, Tarefa
 * 17), que já faz `DELETE /subscriptions/{id}` no Asaas e só depois grava o
 * cancelamento no fim do período. A confirmação explica as duas coisas que
 * quem clica precisa saber ANTES de clicar: a assinatura continua valendo até
 * o fim do período já pago, e o Asaas para de cobrar depois disso.
 */
function BotaoCancelarAssinaturaNoAsaas({ organizationId }: { organizationId: string }) {
  const t = useT();
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [pendente, iniciar] = useTransition();

  function confirmar() {
    iniciar(async () => {
      const r = await cancelarAssinaturaNoAsaas({ organizationId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Assinatura cancelada no Asaas."));
      setAberto(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        data-testid="cancelar-assinatura-no-asaas"
        size="sm"
        variant="outline"
        disabled={pendente}
        onClick={() => setAberto(true)}
      >
        {t("Cancelar assinatura no Asaas")}
      </Button>

      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Cancelar a assinatura no Asaas?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "A assinatura continua valendo até o fim do período já pago; depois disso o Asaas para de cobrar. Esta ação não pode ser desfeita.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-cancelar-assinatura-no-asaas"
              disabled={pendente}
              onClick={(e) => {
                e.preventDefault();
                confirmar();
              }}
            >
              {t("Cancelar assinatura no Asaas")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * "Cancelar pedido aberto" (fase F5, Tarefa 19): mesmo desenho do que a tela
 * de cobrança da instalação usa (`FormularioDeCancelarPedido`), reusando
 * `cancelarPedidoAberto` (Tarefa 17), que busca a cobrança/assinatura no
 * Asaas por `externalReference` e remove antes de marcar cancelado.
 */
function BotaoCancelarPedidoAsaas({
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
        data-testid="cancelar-pedido-asaas"
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
            <Label htmlFor={`motivo-cancelamento-pedido-${pedidoId}`}>{t("Motivo (obrigatório)")}</Label>
            <Input
              id={`motivo-cancelamento-pedido-${pedidoId}`}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              maxLength={500}
              disabled={pendente}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-cancelar-pedido-asaas"
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
  carenciaAtual,
  bloqueio,
  ajusteAtual,
  notaAtual,
  planosAtivos,
  saldo,
  livroCaixa,
  margem,
  adicionaisAtivos,
  leituraDosAdicionaisFalhou,
  assinatura,
  pagamentos,
  leituraDosPagamentosFalhou,
  pacotesAtivos,
  leituraDosPacotesFalhou,
  organizacaoStatus,
  asaas,
}: TenantPlanoClientProps) {
  const t = useT();
  const router = useRouter();
  const tagDoIdioma = useTagDeIdioma();
  // `Date.now()` lido uma vez (lazy initializer): chamar `Date.now()` direto
  // no corpo do componente é impuro para o React Compiler. Usado só para
  // comparar a carência do plano (fase F3, tarefa 10) contra "agora".
  const [agora] = useState(() => Date.now());

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

  // ── Carência extra (fase F3, tarefa 10) ─────────────────────────────────
  const [novaDataDeCarencia, setNovaDataDeCarencia] = useState("");
  const [estendendoCarencia, iniciarExtensaoDeCarencia] = useTransition();

  function estenderCarencia() {
    if (!novaDataDeCarencia) {
      toast.error(t("Escolha uma data."));
      return;
    }
    iniciarExtensaoDeCarencia(async () => {
      const r = await darCarenciaExtra({ organizationId, novaData: novaDataDeCarencia });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Carência estendida."));
      setNovaDataDeCarencia("");
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
  // monta (`useState(() => randomId())`, calculado uma vez só) e
  // são trocadas por uma nova depois de CADA envio bem-sucedido: reenviar o
  // MESMO formulário sem recarregar a página (duplo clique, erro de rede que
  // o admin tenta de novo) usa a MESMA chave e não credita/contrata/ajusta
  // duas vezes; um envio novo, de propósito, usa uma chave nova.
  const [chaveCredito, setChaveCredito] = useState(() => randomId());
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
      setChaveCredito(randomId());
      router.refresh();
    });
  }

  const [chaveAdicional, setChaveAdicional] = useState(() => randomId());
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
      setChaveAdicional(randomId());
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

  const [chaveAjuste, setChaveAjuste] = useState(() => randomId());
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
      setChaveAjuste(randomId());
      router.refresh();
    });
  }

  // ── Assinatura (fase F4, tarefa 8) ──────────────────────────────────────
  //
  // Cada formulário segue o mesmo molde da carteira de tokens acima: chave
  // idempotente nascida na montagem (`useState(() => randomId())`), trocada
  // por uma nova depois de CADA envio bem-sucedido.
  const [chavePagamento, setChavePagamento] = useState(() => randomId());
  const [fimPagamento, setFimPagamento] = useState("");
  const [valorPagamento, setValorPagamento] = useState("");
  const [notaPagamento, setNotaPagamento] = useState("");
  const [registrando, iniciarRegistro] = useTransition();

  function registrar() {
    if (!fimPagamento) {
      toast.error(t("Escolha a data de fim do período."));
      return;
    }
    const valorCents = parseReaisToCents(valorPagamento);
    if (valorCents === null || valorCents <= 0) {
      toast.error(t("Informe um valor válido."));
      return;
    }
    iniciarRegistro(async () => {
      const r = await registrarPagamento({
        organizationId,
        fim: fimPagamento,
        valorCents,
        chave: chavePagamento,
        nota: notaPagamento.trim().length > 0 ? notaPagamento.trim() : undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.jaRegistrado ? t("Já registrado antes: nada foi lançado de novo.") : t("Pagamento registrado."));
      setFimPagamento("");
      setValorPagamento("");
      setNotaPagamento("");
      setChavePagamento(randomId());
      router.refresh();
    });
  }

  const [estornandoId, setEstornandoId] = useState<string | null>(null);
  const [estornando, iniciarEstorno] = useTransition();

  function estornar(pagamentoId: string) {
    setEstornandoId(pagamentoId);
    iniciarEstorno(async () => {
      const r = await estornarPagamento({ organizationId, pagamentoId, chave: randomId() });
      if (!r.ok) {
        toast.error(r.error);
        setEstornandoId(null);
        return;
      }
      toast.success(r.jaRegistrado ? t("Já estava estornado.") : t("Pagamento estornado."));
      setEstornandoId(null);
      router.refresh();
    });
  }

  const [fimCorrecao, setFimCorrecao] = useState("");
  const [motivoCorrecao, setMotivoCorrecao] = useState("");
  const [corrigindo, iniciarCorrecao] = useTransition();

  function corrigir() {
    if (!fimCorrecao) {
      toast.error(t("Escolha a data de fim do período."));
      return;
    }
    if (motivoCorrecao.trim().length === 0) {
      toast.error(t("O motivo é obrigatório."));
      return;
    }
    iniciarCorrecao(async () => {
      const r = await corrigirPeriodo({ organizationId, fim: fimCorrecao, motivo: motivoCorrecao.trim() });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Período corrigido."));
      setFimCorrecao("");
      setMotivoCorrecao("");
      router.refresh();
    });
  }

  const ESTADOS_DO_CONTRATO = ["avaliacao", "ativa", "atrasada", "suspensa", "cancelada"] as const;
  const [estadoParaMudar, setEstadoParaMudar] = useState<(typeof ESTADOS_DO_CONTRATO)[number]>("ativa");
  const [motivoDoEstado, setMotivoDoEstado] = useState("");
  const [mudandoEstado, iniciarMudancaDeEstado] = useTransition();

  function mudarEstado() {
    iniciarMudancaDeEstado(async () => {
      const r = await mudarEstadoDaAssinatura({
        organizationId,
        estado: estadoParaMudar,
        motivo: motivoDoEstado.trim().length > 0 ? motivoDoEstado.trim() : undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Estado da assinatura alterado."));
      setMotivoDoEstado("");
      router.refresh();
    });
  }

  const [fimAvaliacao, setFimAvaliacao] = useState("");
  const [motivoAvaliacao, setMotivoAvaliacao] = useState("");
  const [pondoEmAvaliacao, iniciarAvaliacao] = useTransition();

  function porEmAvaliacaoClick() {
    if (!fimAvaliacao) {
      toast.error(t("Escolha a data de fim da avaliação."));
      return;
    }
    if (motivoAvaliacao.trim().length === 0) {
      toast.error(t("O motivo é obrigatório."));
      return;
    }
    iniciarAvaliacao(async () => {
      const r = await porEmAvaliacao({
        organizationId,
        fim: fimAvaliacao,
        motivo: motivoAvaliacao.trim(),
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Organização em avaliação."));
      setFimAvaliacao("");
      setMotivoAvaliacao("");
      router.refresh();
    });
  }

  const [mudandoCancelamento, iniciarMudancaDeCancelamento] = useTransition();

  function alternarCancelamento(sim: boolean) {
    iniciarMudancaDeCancelamento(async () => {
      const r = await cancelarNoFimDoPeriodo({ organizationId, sim });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(sim ? t("A assinatura cancela no fim do período.") : t("O cancelamento no fim do período foi desligado."));
      router.refresh();
    });
  }

  // ── Creditar pacote do catálogo (fase F4, tarefa 8, decisão 10) ─────────
  const [chavePacote, setChavePacote] = useState(() => randomId());
  const [pacoteEscolhido, setPacoteEscolhido] = useState<string>(pacotesAtivos[0]?.id ?? "");
  const [valorPacote, setValorPacote] = useState("");
  const [notaPacote, setNotaPacote] = useState("");
  const [creditandoPacote, iniciarCreditoDePacote] = useTransition();

  const pacoteSelecionadoObjeto = pacotesAtivos.find((p) => p.id === pacoteEscolhido) ?? null;
  const pacotePrecisaDeValor = pacoteSelecionadoObjeto !== null && pacoteSelecionadoObjeto.preco_cents === null;

  function creditarPacoteDoCatalogo() {
    if (!pacoteEscolhido) {
      toast.error(t("Escolha um pacote."));
      return;
    }
    let valorCents: number | undefined;
    if (pacotePrecisaDeValor) {
      const parsed = parseReaisToCents(valorPacote);
      if (parsed === null || parsed <= 0) {
        toast.error(t("Este pacote não tem preço no catálogo: informe o valor recebido."));
        return;
      }
      valorCents = parsed;
    }
    iniciarCreditoDePacote(async () => {
      const r = await creditarPacote({
        organizationId,
        pacoteId: pacoteEscolhido,
        chave: chavePacote,
        valorCents,
        nota: notaPacote.trim().length > 0 ? notaPacote.trim() : undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.jaRegistrado ? t("Já registrado antes: nada foi creditado de novo.") : t("Pacote creditado."));
      setValorPacote("");
      setNotaPacote("");
      setChavePacote(randomId());
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

          {/* Fase F3, tarefa 9: o texto reflete o estado REAL do bloqueio para
              esta organização (desligado, em carência, ou valendo) em vez
              de afirmar "nenhum limite bloqueia" mesmo depois de o admin ter
              ligado o bloqueio pela tela de sistema. */}
          <p className="text-sm text-text-muted">
            {bloqueio.vale
              ? t(
                  "O bloqueio do plano está VALENDO para esta organização: os itens no teto abaixo não deixam criar nem reativar mais.",
                )
              : bloqueio.emCarencia
                ? t(
                    "O bloqueio do plano ainda está em carência para esta organização: os limites abaixo ainda não impedem nada.",
                  )
                : t(
                    "O bloqueio do plano está desligado para esta instalação: os limites abaixo ainda não impedem nada.",
                  )}
          </p>
          {bloqueio.vale && bloqueio.itensNoTeto.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
              {bloqueio.itensNoTeto.map((item, i) => (
                <li key={`${item.chave}-${item.pipelineId ?? i}`}>{item.motivo}</li>
              ))}
            </ul>
          )}

          {/* Carência do bloqueio de verdade (fase F3, tarefa 10). */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t("Bloqueio do plano")}:</span>
            {carenciaAtual === null ? (
              <Badge variant="neutral">{t("Sem bloqueio programado")}</Badge>
            ) : (
              <Badge variant={new Date(carenciaAtual).getTime() <= agora ? "error" : "warning"}>
                {new Date(carenciaAtual).getTime() <= agora
                  ? t("Carência vencida em")
                  : t("Em carência até")}{" "}
                {new Date(carenciaAtual).toLocaleDateString(tagDoIdioma)}
              </Badge>
            )}
          </div>

          {podeEscrever && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="nova-data-de-carencia">{t("Dar carência extra até")}</Label>
                <Input
                  id="nova-data-de-carencia"
                  type="date"
                  className="w-44"
                  value={novaDataDeCarencia}
                  onChange={(e) => setNovaDataDeCarencia(e.target.value)}
                  disabled={estendendoCarencia || carenciaAtual === null}
                />
              </div>
              <Button
                data-testid="dar-carencia-extra"
                variant="outline"
                onClick={estenderCarencia}
                disabled={estendendoCarencia || carenciaAtual === null}
              >
                {t("Estender carência")}
              </Button>
              {carenciaAtual === null && (
                <p className="text-xs text-text-muted">
                  {t("Esta organização não tem bloqueio programado: nada para estender.")}
                </p>
              )}
            </div>
          )}

          {!podeEscrever && (
            <p className="text-sm text-text-muted">
              {t(
                "Seu acesso de suporte só permite leitura. Para trocar o plano ou ajustar limites, peça a um admin com acesso completo.",
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Assinatura (fase F4, tarefa 8) ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Assinatura")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {assinatura.leituraFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler a assinatura agora.")}</p>
          ) : !assinatura.contrato ? (
            <p className="text-sm text-text-muted">{t("Sem contrato gravado.")}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={CONTRATO_STATUS_VARIANT[assinatura.contrato.status] ?? "neutral"}>
                  {rotuloDoStatusDoContrato(assinatura.contrato.status, t)}
                </Badge>
                {assinatura.contrato.cancelAtPeriodEnd && (
                  <Badge variant="warning">{t("Cancela no fim do período")}</Badge>
                )}
                {assinatura.modoLeituraValendo && (
                  <Badge variant="error">{t("Modo leitura valendo")}</Badge>
                )}
              </div>
              <p className="text-sm text-text-muted">
                {t("Período")}:{" "}
                {assinatura.contrato.currentPeriodStart
                  ? new Date(assinatura.contrato.currentPeriodStart).toLocaleDateString(tagDoIdioma, {
                      timeZone: FUSO_SP,
                    })
                  : "-"}{" "}
                {t("até")}{" "}
                {assinatura.contrato.currentPeriodEnd
                  ? ultimoDiaDoPeriodo(assinatura.contrato.currentPeriodEnd).toLocaleDateString(tagDoIdioma, {
                      timeZone: FUSO_SP,
                    })
                  : "-"}
              </p>
              {assinatura.contrato.dataPrevistaDaSuspensao && (
                <p className="text-sm text-text-muted">
                  {t("Data prevista do modo leitura")}:{" "}
                  {new Date(assinatura.contrato.dataPrevistaDaSuspensao).toLocaleDateString(tagDoIdioma, {
                    timeZone: FUSO_SP,
                  })}
                </p>
              )}
            </div>
          )}

          {podeEscrever && (
            <div className="grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
              <div className="flex flex-wrap items-end gap-2">
                <Select
                  value={estadoParaMudar}
                  onValueChange={(v) => setEstadoParaMudar(v as (typeof ESTADOS_DO_CONTRATO)[number])}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ESTADOS_DO_CONTRATO.map((estado) => (
                      <SelectItem key={estado} value={estado}>
                        {rotuloDoStatusDoContrato(estado, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="w-52"
                  placeholder={t("Motivo (opcional)")}
                  value={motivoDoEstado}
                  onChange={(e) => setMotivoDoEstado(e.target.value)}
                />
                <Button data-testid="mudar-estado" onClick={mudarEstado} disabled={mudandoEstado}>
                  {t("Mudar estado")}
                </Button>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <Button
                  data-testid="ligar-cancelamento"
                  variant="outline"
                  disabled={mudandoCancelamento || assinatura.contrato?.cancelAtPeriodEnd === true}
                  onClick={() => alternarCancelamento(true)}
                >
                  {t("Cancelar no fim do período")}
                </Button>
                <Button
                  data-testid="desligar-cancelamento"
                  variant="outline"
                  disabled={mudandoCancelamento || assinatura.contrato?.cancelAtPeriodEnd === false}
                  onClick={() => alternarCancelamento(false)}
                >
                  {t("Não cancelar")}
                </Button>
              </div>

              <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
                <Input type="date" className="w-40" value={fimAvaliacao} onChange={(e) => setFimAvaliacao(e.target.value)} />
                <Input
                  className="w-64"
                  placeholder={t("Motivo (obrigatório)")}
                  value={motivoAvaliacao}
                  onChange={(e) => setMotivoAvaliacao(e.target.value)}
                />
                <Button data-testid="por-em-avaliacao" variant="outline" onClick={porEmAvaliacaoClick} disabled={pondoEmAvaliacao}>
                  {t("Pôr em avaliação até")}
                </Button>
              </div>

              <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
                <Input type="date" className="w-40" value={fimCorrecao} onChange={(e) => setFimCorrecao(e.target.value)} />
                <Input
                  className="w-64"
                  placeholder={t("Motivo (obrigatório)")}
                  value={motivoCorrecao}
                  onChange={(e) => setMotivoCorrecao(e.target.value)}
                />
                <Button data-testid="corrigir-periodo" variant="outline" onClick={corrigir} disabled={corrigindo}>
                  {t("Corrigir período")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Asaas (fase F5, Tarefa 18) ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Asaas")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {asaas.leituraFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler os dados do Asaas agora.")}</p>
          ) : (
            <>
              {organizacaoStatus === "suspended" && asaas.assinatura && !asaas.assinatura.encerradaEm && (
                <p className="text-sm text-warning-fg">
                  {t(
                    "Esta organização está suspensa pelo admin, mas ainda tem uma assinatura Asaas ativa. Suspender aqui não cancela a cobrança no Asaas.",
                  )}
                </p>
              )}
              {asaas.assinatura && !asaas.assinatura.encerradaEm && (
                <p className="text-sm text-warning-fg">
                  {t(
                    "Esta organização tem assinatura Asaas ativa: registrar pagamento na mão duplica o período.",
                  )}
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-text-muted">{t("Cliente")}</p>
                  {asaas.cliente ? (
                    <p className="flex items-center gap-2 font-mono text-sm">
                      {asaas.cliente.asaasCustomerId}
                      <Badge variant="neutral">
                        {asaas.cliente.ambiente === "producao" ? t("Produção") : t("Sandbox")}
                      </Badge>
                    </p>
                  ) : (
                    <p className="text-sm text-text-muted">{t("Nenhum cliente vinculado.")}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-text-muted">{t("Assinatura")}</p>
                  {asaas.assinatura ? (
                    <>
                      <p className="flex items-center gap-2 font-mono text-sm">
                        {asaas.assinatura.asaasSubscriptionId}
                        <Badge variant={asaas.assinatura.encerradaEm ? "neutral" : "success"}>
                          {asaas.assinatura.encerradaEm ? t("Encerrada") : t("Ativa")}
                        </Badge>
                      </p>
                      {podeEscrever && !asaas.assinatura.encerradaEm && (
                        <BotaoCancelarAssinaturaNoAsaas organizationId={organizationId} />
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-text-muted">{t("Nenhuma assinatura Asaas.")}</p>
                  )}
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium text-text-muted">{t("Pedidos")}</p>
                {asaas.pedidos.length === 0 ? (
                  <p className="text-sm text-text-muted">{t("Nenhum pedido registrado.")}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Tipo")}</TableHead>
                        <TableHead>{t("Método")}</TableHead>
                        <TableHead>{t("Valor")}</TableHead>
                        <TableHead>{t("Status")}</TableHead>
                        <TableHead>{t("Criado em")}</TableHead>
                        {podeEscrever && <TableHead />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {asaas.pedidos.map((pedido) => (
                        <TableRow key={pedido.id}>
                          <TableCell>
                            {pedido.tipo === "assinatura" ? t("Assinatura") : t("Pacote de tokens")}
                          </TableCell>
                          <TableCell>{pedido.metodo}</TableCell>
                          <TableCell>{formatCentsBRL(pedido.amountCents)}</TableCell>
                          <TableCell>
                            <Badge variant="neutral">{pedido.status}</Badge>
                          </TableCell>
                          <TableCell>
                            {new Date(pedido.criadoEm).toLocaleDateString(tagDoIdioma, { timeZone: FUSO_SP })}
                          </TableCell>
                          {podeEscrever && (
                            <TableCell>
                              {STATUS_DE_PEDIDO_ABERTO.has(pedido.status) && (
                                <BotaoCancelarPedidoAsaas organizationId={organizationId} pedidoId={pedido.id} />
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium text-text-muted">{t("Pagamentos (com origem)")}</p>
                {asaas.pagamentos.length === 0 ? (
                  <p className="text-sm text-text-muted">{t("Nenhum pagamento registrado.")}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Status")}</TableHead>
                        <TableHead>{t("Valor")}</TableHead>
                        <TableHead>{t("Origem")}</TableHead>
                        <TableHead>{t("Data")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {asaas.pagamentos.map((pagamento) => (
                        <TableRow key={pagamento.id}>
                          <TableCell>
                            <Badge variant="neutral">{pagamento.status}</Badge>
                          </TableCell>
                          <TableCell>{formatCentsBRL(pagamento.grossCents)}</TableCell>
                          <TableCell>
                            <Badge variant={pagamento.origem === "asaas" ? "info" : "neutral"}>
                              {pagamento.origem === "asaas" ? t("Asaas") : t("Manual")}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {new Date(pagamento.createdAt).toLocaleDateString(tagDoIdioma, { timeZone: FUSO_SP })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Registrar pagamento */}
      {podeEscrever && (
        <Card>
          <CardHeader>
            <CardTitle>{t("Registrar pagamento")}</CardTitle>
            <CardDescription>{t("Pagamento recebido na mão (fora do Asaas). Renova o período e volta o estado para ativa.")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pagamento-fim">{t("Fim do novo período")}</Label>
                <Input
                  id="pagamento-fim"
                  type="date"
                  className="w-40"
                  value={fimPagamento}
                  onChange={(e) => setFimPagamento(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pagamento-valor">{t("Valor recebido")}</Label>
                <Input
                  id="pagamento-valor"
                  className="w-40"
                  placeholder="R$"
                  value={valorPagamento}
                  onChange={(e) => setValorPagamento(e.target.value)}
                />
              </div>
              <Button data-testid="registrar-pagamento" onClick={registrar} disabled={registrando}>
                {t("Registrar")}
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pagamento-nota">{t("Nota (opcional)")}</Label>
              <Textarea
                id="pagamento-nota"
                value={notaPagamento}
                onChange={(e) => setNotaPagamento(e.target.value)}
                maxLength={500}
                placeholder={t("Não coloque dado pessoal aqui: a nota fica registrada e nunca é apagada.")}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pagamentos e estornos */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Pagamentos e estornos")}</CardTitle>
        </CardHeader>
        <CardContent>
          {leituraDosPagamentosFalhou ? (
            <p className="text-sm text-destructive">{t("Não foi possível ler os pagamentos agora.")}</p>
          ) : pagamentos.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nenhum pagamento registrado.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead>{t("Valor")}</TableHead>
                  <TableHead>{t("Período")}</TableHead>
                  <TableHead>{t("Data")}</TableHead>
                  <TableHead>{t("Nota")}</TableHead>
                  <TableHead>{t("Autor")}</TableHead>
                  {podeEscrever && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagamentos.map((p: PagamentoDaAssinatura) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Badge variant={p.status === "REFUNDED" ? "error" : "success"}>
                        {p.status === "REFUNDED" ? t("Estornado") : t("Recebido")}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatCentsBRL(p.grossCents)}</TableCell>
                    <TableCell>
                      {new Date(p.billingPeriodStart).toLocaleDateString(tagDoIdioma, { timeZone: FUSO_SP })} -{" "}
                      {ultimoDiaDoPeriodo(p.billingPeriodEnd).toLocaleDateString(tagDoIdioma, { timeZone: FUSO_SP })}
                    </TableCell>
                    <TableCell>{new Date(p.createdAt).toLocaleDateString(tagDoIdioma)}</TableCell>
                    <TableCell className="max-w-xs truncate">{p.nota ?? "-"}</TableCell>
                    <TableCell>{p.autorNome ?? p.autorEmail ?? "-"}</TableCell>
                    {podeEscrever && (
                      <TableCell>
                        {p.status === "RECEIVED_IN_CASH" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={estornando && estornandoId === p.id}
                            onClick={() => estornar(p.id)}
                          >
                            {t("Estornar")}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Creditar pacote do catálogo (decisão 10) */}
      {podeEscrever && (
        <Card>
          <CardHeader>
            <CardTitle>{t("Creditar pacote do catálogo")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {leituraDosPacotesFalhou ? (
              <p className="text-sm text-destructive">{t("Não foi possível ler o catálogo de pacotes agora.")}</p>
            ) : pacotesAtivos.length === 0 ? (
              <p className="text-sm text-text-muted">{t("Nenhum pacote ativo no catálogo.")}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="pacote-escolhido">{t("Pacote")}</Label>
                    <Select value={pacoteEscolhido} onValueChange={setPacoteEscolhido}>
                      <SelectTrigger id="pacote-escolhido" className="w-72">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {pacotesAtivos.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {`${p.nome} · ${p.tokens.toLocaleString(tagDoIdioma)} tokens`}
                            {p.preco_cents !== null && ` · ${formatCentsBRL(p.preco_cents)}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {pacotePrecisaDeValor && (
                    <div className="space-y-1.5">
                      <Label htmlFor="pacote-valor">{t("Valor recebido")}</Label>
                      <Input
                        id="pacote-valor"
                        className="w-40"
                        placeholder="R$"
                        value={valorPacote}
                        onChange={(e) => setValorPacote(e.target.value)}
                      />
                    </div>
                  )}
                  <Button data-testid="creditar-pacote" onClick={creditarPacoteDoCatalogo} disabled={creditandoPacote}>
                    {t("Creditar")}
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pacote-nota">{t("Nota (opcional)")}</Label>
                  <Textarea
                    id="pacote-nota"
                    value={notaPacote}
                    onChange={(e) => setNotaPacote(e.target.value)}
                    maxLength={500}
                    placeholder={t("Não coloque dado pessoal aqui: a nota fica registrada e nunca é apagada.")}
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

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
              <p>
                {t("Custo estimado do ciclo (dólar, pelo catálogo)")}:{" "}
                <span className="font-medium">{formatCentsUSD(margem.margem.custoEstimadoCentsUsd)}</span>{" "}
                <span className="text-text-muted">
                  ({margem.margem.chamadasEstimadas} {t("chamada(s) sem custo real, precificadas pelo catálogo")})
                </span>
              </p>
              {margem.margem.custoIncompleto && (
                <Badge variant="warning">
                  {t("Custo incompleto")}: {margem.margem.chamadasSemPreco}{" "}
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
          ) : (
            <div className="space-y-3">
              {livroCaixa.livroCaixa.truncado && (
                <Badge variant="warning">{t("Mostrando as 500 linhas mais recentes.")}</Badge>
              )}
              {livroCaixa.livroCaixa.linhas.length === 0 ? (
                <p className="text-sm text-text-muted">{t("Nenhum lançamento neste ciclo ainda.")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Id")}</TableHead>
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
                      <TableRow key={linha.id ?? `${linha.dia}-${linha.fonte}-${linha.tipo}-${i}`}>
                        <TableCell>{linha.id !== null ? <IdCurtoCopiavel id={linha.id} t={t} /> : "-"}</TableCell>
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
            </div>
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
