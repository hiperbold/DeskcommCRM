"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  ajustarLimitesDaOrganizacao,
  trocarPlanoDaOrganizacao,
} from "@/app/actions/admin/planoDaOrganizacao";
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
import { formatCentsBRL } from "@/lib/money";

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
}

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
    </div>
  );
}
