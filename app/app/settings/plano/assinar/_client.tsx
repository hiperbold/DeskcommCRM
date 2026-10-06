"use client";

/**
 * A tela de compra pelo cliente (fase F5, Tarefa 20): escolha de ciclo e
 * método por plano (decisão 2), pacotes de tokens, formulário do pagador na
 * primeira compra (decisão 16), e o desfecho de cada tentativa
 * (`redirecionar` ou `pix`).
 *
 * As três ações (`iniciarAssinatura`, `comprarPacote`, o gate de admin e as
 * duas chaves) já vivem em `app/actions/settings/compraDoPlano.ts`: este
 * arquivo só monta a entrada, confere a URL de novo (risco 8,
 * `urlDeRedirecionamentoEhSegura` em `../_logica-compra`) e mostra o
 * resultado. Nenhuma mensagem de erro é reescrita: o que a ação devolve
 * chega direto ao toast, mesmo padrão de `app/admin/(protected)/sistema/
 * cobranca/_client.tsx`.
 *
 * Correção 6 (revisão da fase): a chave de idempotência de cada tentativa
 * (decisão 13) vive em `chaveParaProximaTentativaDeCompra`/
 * `classificarDesfechoDaTentativa` (`../_logica-compra`, puras e testadas em
 * `tests/unit/asaas-telas-cliente.test.ts`): a MESMA chave só se repete para
 * a MESMA escolha (plano/ciclo/método, ou pacote/método) depois de um
 * desfecho "aguarde"; qualquer mudança de escolha, ou qualquer desfecho
 * terminal (erro de validação do formulário, pedido `falhou`/`cancelado`,
 * ou qualquer outra recusa), gera uma chave nova.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";

import { comprarPacote, iniciarAssinatura } from "@/app/actions/settings/compraDoPlano";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { randomId } from "@/lib/random-id";

import type { PlanoParaVenda } from "@/lib/billing/asaas/leitura";
import type { ResultadoIniciarCompra } from "@/lib/billing/asaas/compra";

import {
  chaveParaProximaTentativaDeCompra,
  ciclosDisponiveis,
  classificarDesfechoDaTentativa,
  montarPagadorDoFormulario,
  precoDoCiclo,
  resumoDoCiclo,
  urlDeRedirecionamentoEhSegura,
  type CamposDoFormularioDoPagador,
  type CicloDeCompra,
  type DadosDoPagador,
  type DesfechoDaTentativaDeCompra,
  type EscolhaDeCompra,
} from "../_logica-compra";
import { PixPendente } from "./_pix-pendente";
import type { PacoteParaVenda } from "./_dados";

const CAMPOS_VAZIOS: CamposDoFormularioDoPagador = { nome: "", documento: "", email: "", celular: "" };

function formatarReais(centavos: number, tagDoIdioma: string): string {
  return (centavos / 100).toLocaleString(tagDoIdioma, { style: "currency", currency: "BRL" });
}

function classeDoToggle(ativo: boolean): string {
  return cn(
    "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
    ativo ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
  );
}

export function AssinarOuComprarClient({
  planos,
  pacotes,
  precisaPagador,
  leituraFalhou,
}: {
  planos: PlanoParaVenda[];
  pacotes: PacoteParaVenda[];
  precisaPagador: boolean;
  leituraFalhou: boolean;
}) {
  const t = useT();
  const nadaAVenda = planos.length === 0 && pacotes.length === 0;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Assinar ou comprar")}</h1>
      </header>

      {leituraFalhou && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {t("Não foi possível carregar os planos à venda agora. Atualize a página.")}
        </div>
      )}

      {!leituraFalhou && nadaAVenda && (
        <div className="rounded-md border border-border p-6 text-sm text-muted-foreground">
          {t("Nenhum plano ou pacote está à venda no momento.")}
        </div>
      )}

      {planos.length > 0 && (
        <section id="planos" className="space-y-3">
          <h2 className="text-lg font-medium">{t("Planos disponíveis")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {planos.map((plano) => (
              <PlanoParaAssinar key={plano.code} plano={plano} precisaPagador={precisaPagador} />
            ))}
          </div>
        </section>
      )}

      {pacotes.length > 0 && (
        <section id="pacotes" className="space-y-3">
          <h2 className="text-lg font-medium">{t("Pacotes de tokens")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {pacotes.map((pacote) => (
              <PacoteParaComprar key={pacote.codigo} pacote={pacote} precisaPagador={precisaPagador} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Um plano, com ciclo, método e o desfecho da tentativa ─────────────────

function PlanoParaAssinar({ plano, precisaPagador }: { plano: PlanoParaVenda; precisaPagador: boolean }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const [ciclo, setCiclo] = useState<CicloDeCompra>("monthly");
  const [metodo, setMetodo] = useState<"CREDIT_CARD" | "PIX">("CREDIT_CARD");
  const [pagador, setPagador] = useState<CamposDoFormularioDoPagador>(CAMPOS_VAZIOS);
  const [pendente, setPendente] = useState(false);
  const [resultado, setResultado] = useState<ResultadoIniciarCompra | null>(null);
  // Chave de idempotência (decisão 13 do plano da fase): estável entre
  // repetições da MESMA escolha depois de "aguarde"; nova a cada mudança de
  // ciclo/método ou a cada desfecho terminal (correção 6 da revisão).
  const [chave, setChave] = useState<string>(() => randomId());
  const tentativaAnteriorRef = useRef<{ escolha: EscolhaDeCompra; desfecho: DesfechoDaTentativaDeCompra } | null>(null);

  // Só os ciclos com preço no catálogo aparecem (D-176): o plano sem preço
  // semestral ou anual simplesmente não oferece esse botão.
  const ciclos = ciclosDisponiveis(plano);
  const resumo = resumoDoCiclo(plano, ciclo);

  function escolherCiclo(novo: CicloDeCompra) {
    setCiclo(novo);
    if (novo === "monthly") setMetodo("CREDIT_CARD");
  }

  const rotuloDoCiclo: Record<CicloDeCompra, string> = {
    monthly: t("Mensal"),
    semiannual: t("Semestral"),
    yearly: t("Anual"),
  };

  async function assinar() {
    const escolhaAtual: EscolhaDeCompra = { tipo: "assinatura", planCode: plano.code, ciclo, metodo };
    const chaveDestaTentativa = chaveParaProximaTentativaDeCompra({
      chaveAtual: chave,
      escolhaAtual,
      tentativaAnterior: tentativaAnteriorRef.current,
    });
    if (chaveDestaTentativa !== chave) setChave(chaveDestaTentativa);

    let entradaDoPagador: DadosDoPagador | undefined;

    if (precisaPagador) {
      const montado = montarPagadorDoFormulario(pagador);
      if (!montado.ok) {
        toast.error(t(montado.erro));
        tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: "terminal" };
        return;
      }
      entradaDoPagador = montado.pagador;
    }

    setPendente(true);
    try {
      const r = await iniciarAssinatura({
        planCode: plano.code,
        ciclo,
        metodo,
        chave: chaveDestaTentativa,
        pagador: entradaDoPagador,
      });
      tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: classificarDesfechoDaTentativa(r) };

      if (r.tipo === "erro") {
        // A frase de recusa da troca de plano (0942) tem es e zh-CN no dicionário; as demais
        // mensagens da ação seguem em português, como antes (t() devolve a própria frase quando
        // não há tradução).
        toast.error(t(r.mensagem));
        setPendente(false);
        return;
      }

      if (r.tipo === "redirecionar") {
        if (!urlDeRedirecionamentoEhSegura(r.url)) {
          toast.error(t("Não foi possível continuar: o endereço de pagamento não é reconhecido."));
          setPendente(false);
          return;
        }
        window.location.href = r.url;
        return;
      }

      setResultado(r);
      setPendente(false);
    } catch {
      tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: "terminal" };
      toast.error(t("Não foi possível concluir a compra agora. Tente novamente em instantes."));
      setPendente(false);
    }
  }

  if (resultado?.tipo === "pix") {
    return <PixPendente pedidoId={resultado.pedidoId} qr={resultado.qr} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>{plano.name}</span>
          <Badge variant="info">
            {formatarReais(plano.priceMonthlyCents, tagDoIdioma)} {t("por mês")}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t("Ciclo")}</span>
          <div className="flex w-fit flex-wrap items-center gap-0.5 rounded-md border bg-muted p-0.5">
            {ciclos.map((opcao) => (
              <button
                key={opcao}
                type="button"
                data-testid={`ciclo-${plano.code}-${opcao}`}
                aria-pressed={ciclo === opcao}
                className={classeDoToggle(ciclo === opcao)}
                onClick={() => escolherCiclo(opcao)}
              >
                {rotuloDoCiclo[opcao]}
                {opcao !== "monthly" && ` · ${formatarReais(precoDoCiclo(plano, opcao) as number, tagDoIdioma)}`}
              </button>
            ))}
          </div>
        </div>

        {ciclo !== "monthly" && resumo && (
          <div className="space-y-0.5 text-sm" data-testid={`resumo-${plano.code}`}>
            <p>
              {t("Total do período")}: <span className="font-medium">{formatarReais(resumo.totalCents, tagDoIdioma)}</span> (
              {resumo.meses} {t("meses")})
            </p>
            {resumo.economiaCents > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("Economia de")} {formatarReais(resumo.economiaCents, tagDoIdioma)} ({resumo.economiaPercentual}%){" "}
                {t("em relação ao mensal")}
              </p>
            )}
          </div>
        )}

        {ciclo !== "monthly" && (
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t("Forma de pagamento")}</span>
            <div className="flex w-fit items-center gap-0.5 rounded-md border bg-muted p-0.5">
              <button
                type="button"
                aria-pressed={metodo === "CREDIT_CARD"}
                className={classeDoToggle(metodo === "CREDIT_CARD")}
                onClick={() => setMetodo("CREDIT_CARD")}
              >
                {t("Cartão de crédito")}
              </button>
              <button
                type="button"
                aria-pressed={metodo === "PIX"}
                className={classeDoToggle(metodo === "PIX")}
                onClick={() => setMetodo("PIX")}
              >
                {t("Pix")}
              </button>
            </div>
          </div>
        )}

        {precisaPagador && (
          <FormularioDoPagador pagador={pagador} onChange={setPagador} idPrefixo={`pagador-plano-${plano.code}`} />
        )}

        <Button data-testid={`assinar-${plano.code}`} disabled={pendente} onClick={() => void assinar()}>
          {pendente ? t("Enviando...") : t("Assinar")}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Um pacote de tokens ────────────────────────────────────────────────────

function PacoteParaComprar({ pacote, precisaPagador }: { pacote: PacoteParaVenda; precisaPagador: boolean }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const [metodo, setMetodo] = useState<"CREDIT_CARD" | "PIX">("PIX");
  const [pagador, setPagador] = useState<CamposDoFormularioDoPagador>(CAMPOS_VAZIOS);
  const [pendente, setPendente] = useState(false);
  const [resultado, setResultado] = useState<ResultadoIniciarCompra | null>(null);
  const [chave, setChave] = useState<string>(() => randomId());
  const tentativaAnteriorRef = useRef<{ escolha: EscolhaDeCompra; desfecho: DesfechoDaTentativaDeCompra } | null>(null);

  async function comprar() {
    const escolhaAtual: EscolhaDeCompra = { tipo: "pacote_tokens", pacote: pacote.codigo, metodo };
    const chaveDestaTentativa = chaveParaProximaTentativaDeCompra({
      chaveAtual: chave,
      escolhaAtual,
      tentativaAnterior: tentativaAnteriorRef.current,
    });
    if (chaveDestaTentativa !== chave) setChave(chaveDestaTentativa);

    let entradaDoPagador: DadosDoPagador | undefined;

    if (precisaPagador) {
      const montado = montarPagadorDoFormulario(pagador);
      if (!montado.ok) {
        toast.error(t(montado.erro));
        tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: "terminal" };
        return;
      }
      entradaDoPagador = montado.pagador;
    }

    setPendente(true);
    try {
      const r = await comprarPacote({ pacote: pacote.codigo, metodo, chave: chaveDestaTentativa, pagador: entradaDoPagador });
      tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: classificarDesfechoDaTentativa(r) };

      if (r.tipo === "erro") {
        toast.error(r.mensagem);
        setPendente(false);
        return;
      }

      if (r.tipo === "redirecionar") {
        if (!urlDeRedirecionamentoEhSegura(r.url)) {
          toast.error(t("Não foi possível continuar: o endereço de pagamento não é reconhecido."));
          setPendente(false);
          return;
        }
        window.location.href = r.url;
        return;
      }

      setResultado(r);
      setPendente(false);
    } catch {
      tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: "terminal" };
      toast.error(t("Não foi possível concluir a compra agora. Tente novamente em instantes."));
      setPendente(false);
    }
  }

  if (resultado?.tipo === "pix") {
    return <PixPendente pedidoId={resultado.pedidoId} qr={resultado.qr} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>{pacote.nome}</span>
          <Badge variant="info">{formatarReais(pacote.precoCents, tagDoIdioma)}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {pacote.tokens.toLocaleString(tagDoIdioma)} {t("Tokens")}
        </p>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t("Forma de pagamento")}</span>
          <div className="flex w-fit items-center gap-0.5 rounded-md border bg-muted p-0.5">
            <button
              type="button"
              aria-pressed={metodo === "PIX"}
              className={classeDoToggle(metodo === "PIX")}
              onClick={() => setMetodo("PIX")}
            >
              {t("Pix")}
            </button>
            <button
              type="button"
              aria-pressed={metodo === "CREDIT_CARD"}
              className={classeDoToggle(metodo === "CREDIT_CARD")}
              onClick={() => setMetodo("CREDIT_CARD")}
            >
              {t("Cartão de crédito")}
            </button>
          </div>
        </div>

        {precisaPagador && (
          <FormularioDoPagador pagador={pagador} onChange={setPagador} idPrefixo={`pagador-pacote-${pacote.codigo}`} />
        )}

        <Button data-testid={`comprar-${pacote.codigo}`} disabled={pendente} onClick={() => void comprar()}>
          {pendente ? t("Enviando...") : t("Comprar")}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Formulário do pagador (decisão 16): nunca guardado no navegador ───────

function FormularioDoPagador({
  pagador,
  onChange,
  idPrefixo,
}: {
  pagador: CamposDoFormularioDoPagador;
  onChange: (pagador: CamposDoFormularioDoPagador) => void;
  idPrefixo: string;
}) {
  const t = useT();
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm font-medium">{t("Dados de quem paga")}</p>
      <p className="text-xs text-muted-foreground">
        {t("Só usados para emitir a cobrança no Asaas. Não ficam guardados neste sistema.")}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-nome`}>{t("Nome completo")}</Label>
        <Input
          id={`${idPrefixo}-nome`}
          value={pagador.nome}
          onChange={(e) => onChange({ ...pagador, nome: e.target.value })}
          maxLength={200}
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-documento`}>{t("CPF ou CNPJ")}</Label>
        <Input
          id={`${idPrefixo}-documento`}
          value={pagador.documento}
          onChange={(e) => onChange({ ...pagador, documento: e.target.value })}
          maxLength={20}
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-email`}>{t("E-mail (opcional)")}</Label>
        <Input
          id={`${idPrefixo}-email`}
          type="email"
          value={pagador.email}
          onChange={(e) => onChange({ ...pagador, email: e.target.value })}
          maxLength={200}
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-celular`}>{t("Celular (opcional)")}</Label>
        <Input
          id={`${idPrefixo}-celular`}
          value={pagador.celular}
          onChange={(e) => onChange({ ...pagador, celular: e.target.value })}
          maxLength={20}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
