"use client";

/**
 * A tela de compra pelo cliente (fase F5, Tarefa 20): o plano em passo a passo (D-180, em
 * `./_passo-a-passo`), os pacotes de tokens, o formulário do pagador na primeira compra (decisão 16)
 * e o desfecho de cada tentativa (`redirecionar` ou `pix`).
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

import { comprarPacote } from "@/app/actions/settings/compraDoPlano";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { randomId } from "@/lib/random-id";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";

import type { PlanoParaVenda } from "@/lib/billing/asaas/leitura";
import type { ResultadoIniciarCompra } from "@/lib/billing/asaas/compra";
import type { OpcaoDeParcelas } from "@/lib/billing/asaas/parcelamento";

import {
  chaveParaProximaTentativaDeCompra,
  classificarDesfechoDaTentativa,
  montarPagadorDoFormulario,
  urlDeRedirecionamentoEhSegura,
  type CamposDoFormularioDoPagador,
  type DadosDoPagador,
  type DesfechoDaTentativaDeCompra,
  type EscolhaDeCompra,
} from "../_logica-compra";
import { PixPendente } from "./_pix-pendente";
import { AceiteDosTermos, CAMPOS_VAZIOS, FormularioDoPagador, formatarReais } from "./_comuns";
import { AssinarPlanoPassoAPasso } from "./_passo-a-passo";
import type { PacoteParaVenda } from "./_dados";

function classeDoToggle(ativo: boolean): string {
  return cn(
    "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
    ativo ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
  );
}

export type OpcoesDeParcelasPorPlano = Record<string, { semiannual: OpcaoDeParcelas[]; yearly: OpcaoDeParcelas[] }>;

export function AssinarOuComprarClient({
  opcoesDeParcelas = {},
  taxaMensalPercentual = null,
  planos,
  pacotes,
  precisaPagador,
  leituraFalhou,
  planoAtualCode = null,
}: {
  /** D-177: calculadas no servidor (parâmetros de `billing_settings`); o cliente só escolhe o número de parcelas. */
  opcoesDeParcelas?: OpcoesDeParcelasPorPlano;
  taxaMensalPercentual?: number | null;
  planos: PlanoParaVenda[];
  pacotes: PacoteParaVenda[];
  precisaPagador: boolean;
  leituraFalhou: boolean;
  /** D-180: o plano que a organização tem hoje (contrato vivo), só para marcar o cartão; `null` quando não há. */
  planoAtualCode?: string | null;
}) {
  const t = useT();
  const nadaAVenda = planos.length === 0 && pacotes.length === 0;

  return (
    <div className="flex h-full flex-col gap-8 overflow-y-auto p-6">
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
        <section id="planos" className="space-y-4">
          <h2 className="text-lg font-medium">{t("Planos disponíveis")}</h2>
          <AssinarPlanoPassoAPasso
            planos={planos}
            opcoesDeParcelas={opcoesDeParcelas}
            taxaMensalPercentual={taxaMensalPercentual}
            precisaPagador={precisaPagador}
            planoAtualCode={planoAtualCode}
          />
        </section>
      )}

      {pacotes.length > 0 && (
        <section id="pacotes" className="space-y-3 border-t pt-8">
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

// ─── Um pacote de tokens ────────────────────────────────────────────────────

function PacoteParaComprar({ pacote, precisaPagador }: { pacote: PacoteParaVenda; precisaPagador: boolean }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const [metodo, setMetodo] = useState<"CREDIT_CARD" | "PIX">("PIX");
  const [pagador, setPagador] = useState<CamposDoFormularioDoPagador>(CAMPOS_VAZIOS);
  const [pendente, setPendente] = useState(false);
  const [aceitouTermos, setAceitouTermos] = useState(false);
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
      const r = await comprarPacote({
        pacote: pacote.codigo,
        metodo,
        chave: chaveDestaTentativa,
        pagador: entradaDoPagador,
        termosVersao: VERSAO_DOS_TERMOS,
      });
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

        <AceiteDosTermos id={`termos-pacote-${pacote.codigo}`} aceito={aceitouTermos} onChange={setAceitouTermos} />

        <Button data-testid={`comprar-${pacote.codigo}`} disabled={pendente || !aceitouTermos} onClick={() => void comprar()}>
          {pendente ? t("Enviando...") : t("Comprar")}
        </Button>
      </CardContent>
    </Card>
  );
}
