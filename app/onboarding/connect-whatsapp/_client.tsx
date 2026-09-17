"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { skipWhatsapp, markWhatsappConfigured } from "@/app/actions/onboarding/skipWhatsapp";
import { CanalInstanciaClient } from "@/components/connections/CanalInstanciaClient";
import { CanalOficialClient } from "@/components/connections/CanalOficialClient";
import { CanalParceiroClient } from "@/components/connections/CanalParceiroClient";

interface Props {
  /** Só rotula o passo no estado do wizard; nenhum transporte depende dele. */
  sessionName: string;
  /**
   * A volta do canal oficial depende de um valor que mora no `.env` do
   * servidor, e o instalador NÃO o escreve — então numa instalação recém-feita
   * ele está ausente. Sem ele o número envia e nunca recebe, e o lugar de dizer
   * isso é ANTES de a pessoa buscar três credenciais no painel, não depois.
   */
  oficialPodeReceber: boolean;
}

/**
 * COMO a pessoa já usa o número. Vive em `useState` e NUNCA é gravada.
 *
 * Gravar aqui seria o defeito: `cumprido` do passo é `Boolean(state.whatsapp)`
 * (`lib/onboarding/passos.ts`), então persistir a escolha no clique marcaria o
 * passo como resolvido — e quem fechasse o navegador no meio cairia direto no
 * passo seguinte, sem telefone e sem caminho de volta, porque o roteador só
 * devolve o primeiro passo NÃO cumprido. O banco só é tocado quando o passo
 * termina de verdade: conectou, pulou, ou disse que já tinha conectado.
 *
 * ─── Por que não existe mais a forma "leio um código com o celular" ─────────
 *
 * Porque esta instalação não tem o serviço que a atendia. O canal por QR foi
 * retirado (serviço apagado do servidor, aba removida de Conexões), e esta tela
 * continuou oferecendo-o: escolher a opção chamava
 * `POST /api/v1/onboarding/whatsapp/session`, que CRIA a linha de
 * `channel_sessions` antes de falar com o transporte. Sem transporte, a criação
 * ia até o fim e a linha ficava `FAILED` para sempre — e `listarConexoesCaidas`
 * (`lib/channels/health.ts`) passava a anunciar na faixa vermelha do topo, em
 * toda tela de /app, um "WhatsApp sem nome está desconectado" que nenhum
 * operador conseguia resolver: o número dele estava conectado, e a conexão
 * caída era um fantasma que a própria tela tinha acabado de criar.
 *
 * A forma que entrou no lugar é a mesma da tela de Conexões — instância própria
 * —, e ela não grava linha nenhuma antes de o servidor e o token responderem.
 */
type Forma = "instancia" | "oficial" | "parceiro";

/**
 * Um cartão de escolha — a MESMA forma que o resto do produto já usa
 * (`app/app/settings/atendimento/_form.tsx`): `<label>` embrulhando um radio
 * nativo. Não é `RadioGroup` porque esse componente não existe neste repo, e
 * trazê-lo criaria um quarto dialeto de escolha ao lado de três iguais.
 */
function Escolha({
  valor,
  atual,
  titulo,
  corpo,
  onEscolher,
}: {
  valor: Forma;
  atual: Forma | null;
  titulo: string;
  corpo: string;
  onEscolher: (v: Forma) => void;
}) {
  const marcada = atual === valor;
  return (
    <label
      data-testid={`forma-${valor}`}
      data-marcada={marcada ? "sim" : "nao"}
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        marcada ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
      }`}
    >
      <input
        type="radio"
        name="forma-de-conectar"
        value={valor}
        checked={marcada}
        onChange={() => onEscolher(valor)}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
        aria-label={titulo}
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium">{titulo}</span>
        <span className="block text-xs text-muted-foreground">{corpo}</span>
      </span>
    </label>
  );
}

/** Voltar à pergunta. Escolher errado não pode ser uma porta que tranca. */
function VoltarParaEscolha({ onVoltar }: { onVoltar: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="voltar-para-escolha"
      onClick={onVoltar}
      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      ← {t("Escolher outra forma")}
    </button>
  );
}

/**
 * As duas saídas do passo, iguais nos três ramos.
 *
 * Ficam FORA do ramo de propósito: o defeito que este projeto já pagou caro
 * (commit c2f88e83) foi um aviso correto que nasceu sem botão — quem instalava
 * sem chave ficava preso numa tela com o diagnóstico certo e nenhum caminho.
 * Aqui, nenhuma escolha — nem a pergunta em si — deixa a pessoa sem saída.
 */
function Saidas({ sessionName }: { sessionName: string }) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              await skipWhatsapp();
            } catch (err) {
              if (isRedirectError(err)) throw err;
              toast.error(`${t("Falha ao pular:")} ${String(err)}`);
            }
          })
        }
      >
        {t("Pular por enquanto")}
      </Button>
      <Button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              await markWhatsappConfigured(sessionName, "configured");
            } catch (err) {
              if (isRedirectError(err)) throw err;
              toast.error(`${t("Falha ao marcar passo:")} ${String(err)}`);
            }
          })
        }
      >
        {t("Conectei em outro lugar")}
      </Button>
    </div>
  );
}

/**
 * Server actions throw a sentinel `NEXT_REDIRECT` when calling `redirect()`.
 * The Next runtime catches it at the boundary, but inside a try/catch we
 * must re-throw so navigation actually happens.
 */
function isRedirectError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: unknown }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
  );
}

export function ConnectWhatsappClient({ sessionName, oficialPodeReceber }: Props) {
  const t = useT();
  const [forma, setForma] = useState<Forma | null>(null);

  if (forma === null) {
    return (
      <div className="space-y-4 rounded-lg border bg-background p-6">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("Como você já usa esse número?")}</legend>
          <p className="text-xs text-muted-foreground">
            {t(
              "Existe mais de um jeito de ter WhatsApp para empresa, e cada um conecta de um jeito. Se você nunca ouviu falar dos outros dois, é o primeiro.",
            )}
          </p>
          <div className="grid gap-2">
            <Escolha
              valor="instancia"
              atual={forma}
              titulo={t("Tenho o número numa instância minha")}
              corpo={t(
                "O número já está pareado num servidor de WhatsApp seu, e você tem o endereço dele e o token da instância em mãos.",
              )}
              onEscolher={setForma}
            />
            <Escolha
              valor="oficial"
              atual={forma}
              titulo={t("Tenho conta oficial na Meta")}
              corpo={t("Você cadastrou o número na Meta e tem as credenciais em mãos. Não usa o celular para conectar.")}
              onEscolher={setForma}
            />
            <Escolha
              valor="parceiro"
              atual={forma}
              titulo={t("Contrato de um provedor parceiro")}
              corpo={t("Uma empresa parceira cuida do seu WhatsApp e te deu uma chave de acesso.")}
              onEscolher={setForma}
            />
          </div>
        </fieldset>
        <Saidas sessionName={sessionName} />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border bg-background p-6">
      <VoltarParaEscolha onVoltar={() => setForma(null)} />

      {forma === "oficial" && !oficialPodeReceber && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">
            {t("Este servidor ainda não está pronto para RECEBER por este caminho.")}
          </p>
          <p className="mt-1">
            {t(
              "Dá para conectar e já enviar, mas as respostas do cliente não vão chegar até quem administra a instalação cadastrar o App da Meta, em Admin › API Oficial (Meta). Se você quer atender hoje, conectar pela sua própria instância funciona agora — e dá para trocar depois, sem perder nada.",
            )}
          </p>
        </div>
      )}

      {/* Os mesmos componentes da tela de Conexões, inteiros. Reescrevê-los
          aqui criaria uma segunda cópia de um formulário que valida credencial
          contra o outro lado ANTES de gravar — e duas cópias divergem. */}
      {forma === "instancia" ? (
        <CanalInstanciaClient />
      ) : forma === "oficial" ? (
        <CanalOficialClient />
      ) : (
        <CanalParceiroClient />
      )}

      <Saidas sessionName={sessionName} />
    </div>
  );
}
