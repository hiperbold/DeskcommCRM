"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirDiasDeCarencia, definirModoDeBloqueio } from "@/app/actions/admin/bloqueioDosPlanos";
import { criarPacote, desativarPacote } from "@/app/actions/admin/pacotesDeTokens";
import { updateComportamento } from "@/app/actions/settings/updateComportamento";
import { updateModuloDaInstalacao } from "@/app/actions/settings/updateModuloDaInstalacao";
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
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { BloqueioDosPlanos, ModoDeBloqueio } from "@/lib/billing/planos/bloqueio-da-instalacao";
import type {
  ChaveDeOrcamentoDaInstalacao,
  ComportamentoDaInstalacao,
} from "@/lib/instalacao/comportamento";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import { formatCentsBRL, parseReaisToCents } from "@/lib/money";

/**
 * Cada interruptor salva na hora, sem botão de confirmar — mesmo desenho do
 * formulário da política de cadastro, e pelo mesmo motivo: é reversível com um
 * clique e o registro de quem trocou (e de qual valor para qual) fica na trilha
 * de auditoria, que é onde a pergunta "por que a IA não parou?" é respondida.
 *
 * A gravação manda o estado INTEIRO das quatro chaves, e não só a que mudou: é
 * um `upsert` de uma linha só, e mandar o estado todo evita que duas telas
 * abertas se sobrescrevam em campos que ninguém tocou.
 */
export function FormularioDeComportamento({ inicial }: { inicial: ComportamentoDaInstalacao }) {
  const t = useT();
  const [valores, setValores] = useState<ComportamentoDaInstalacao>(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function trocar<K extends keyof ComportamentoDaInstalacao>(
    campo: K,
    valor: ComportamentoDaInstalacao[K],
  ) {
    const anterior = valores;
    setErro(null);
    // Otimista, e com volta explícita no erro: sem a volta, uma falha de
    // gravação deixaria a tela dizendo "desligado" com a proteção ligada — o
    // pior estado possível para uma configuração de comportamento.
    setValores({ ...valores, [campo]: valor });
    startTransition(async () => {
      const r = await updateComportamento({ ...valores, [campo]: valor });
      if (!r.ok) {
        setValores(anterior);
        setErro(t("Não deu para salvar. Tente de novo em instantes."));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("O que esta instalação faz")}</CardTitle>
        <CardDescription>
          {t(
            "Cada escolha vale para todas as empresas daqui. Quem cuida do servidor pode declarar um valor no arquivo de ambiente, mas ele só responde até a primeira leitura do banco: a partir daí, manda o que estiver aqui.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="orcamento-de-ia" className="text-base">
              {t("Proteção de gasto de IA")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Decide o que acontece quando o gasto passa do teto que a empresa escolheu. Não liga a proteção de ninguém: só pode afrouxá-la.",
              )}
            </p>
          </div>
          <Select
            value={valores.orcamento_de_ia}
            onValueChange={(v) => trocar("orcamento_de_ia", v as ChaveDeOrcamentoDaInstalacao)}
            disabled={pendente}
          >
            <SelectTrigger id="orcamento-de-ia" className="w-[200px]" aria-label={t("Proteção de gasto de IA")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on">{t("Respeita o teto de cada empresa")}</SelectItem>
              <SelectItem value="avisar">{t("Só avisa, nunca para a IA")}</SelectItem>
              <SelectItem value="off">{t("Desligada")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="assinatura-do-webhook" className="text-base">
              {t("Exigir assinatura nas entregas do canal")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Vale para os servidores de canal que assinam o corpo do webhook: ligado, a entrega precisa vir assinada com o segredo da sessão. Um servidor que não assina o corpo não é afetado por esta opção: a proteção dele vem de outro mecanismo (token da conexão mais a conferência de dono), que já roda sempre.",
              )}
            </p>
          </div>
          <Switch
            id="assinatura-do-webhook"
            checked={valores.exigir_assinatura_no_webhook}
            onCheckedChange={(v) => trocar("exigir_assinatura_no_webhook", v)}
            disabled={pendente}
            aria-label={t("Exigir assinatura nas entregas do canal")}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="divulgacao-de-pagamento" className="text-base">
              {t("Divulgação de pagamento no atendimento")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Injetar acrescenta o texto de divulgação à primeira mensagem. Vetar bloqueia o envio sem ele e devolve ao modelo a razão, para ele reescrever.",
              )}
            </p>
          </div>
          <Select
            value={valores.divulgacao_de_pagamento}
            onValueChange={(v) =>
              trocar("divulgacao_de_pagamento", v as ComportamentoDaInstalacao["divulgacao_de_pagamento"])
            }
            disabled={pendente}
          >
            <SelectTrigger
              id="divulgacao-de-pagamento"
              className="w-[200px]"
              aria-label={t("Divulgação de pagamento no atendimento")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inject">{t("Injetar")}</SelectItem>
              <SelectItem value="veto">{t("Vetar")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="promessa-semantica" className="text-base">
              {t("Conferência de promessa antes de enviar")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Ligado, cada envio passa por uma conferência de modelo para não prometer o que a empresa não cumpre. Custa uma chamada de modelo por envio.",
              )}
            </p>
          </div>
          <Switch
            id="promessa-semantica"
            checked={valores.promessa_semantica}
            onCheckedChange={(v) => trocar("promessa_semantica", v)}
            disabled={pendente}
            aria-label={t("Conferência de promessa antes de enviar")}
          />
        </div>

        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Um pacote do catálogo, ativo ou não (fase F4, tarefa 8, decisão 10). */
interface PacoteDoCadastro {
  id: string;
  codigo: string;
  nome: string;
  tokens: number;
  preco_cents: number | null;
  ativo: boolean;
}

/**
 * O cadastro simples do catálogo de pacotes de tokens vendidos na mão (fase
 * F4, tarefa 8, decisão 10): criar um pacote novo e desativar um existente.
 * Sem `delete` concedido em `billing_token_pacotes` (migração 0908, parte 3):
 * um pacote já vendido fica no histórico, só desativa.
 *
 * ── Por que o preço fica de fora do formulário quando ninguém digita nada ──
 *
 * N9: nenhum preço é inventado. O campo é opcional; deixado em branco, o
 * pacote nasce com `preco_cents` nulo, e `fn_billing_creditar_pacote`
 * (migração 0908, parte 3) já sabe pedir o valor na hora de creditar.
 */
export function FormularioDeCadastroDePacotes({
  pacotes,
  leituraFalhou,
}: {
  pacotes: PacoteDoCadastro[];
  leituraFalhou: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const tagDoIdioma = useTagDeIdioma();

  const [codigo, setCodigo] = useState("");
  const [nome, setNome] = useState("");
  const [tokens, setTokens] = useState("");
  const [precoCents, setPrecoCents] = useState("");
  const [criando, iniciarCriacao] = useTransition();

  function criar() {
    const codigoLimpo = codigo.trim();
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(codigoLimpo)) {
      toast.error(t("Código inválido: letras minúsculas, dígitos e _, começando por letra."));
      return;
    }
    if (nome.trim().length === 0) {
      toast.error(t("O nome é obrigatório."));
      return;
    }
    const tokensNumero = Number(tokens);
    if (!Number.isInteger(tokensNumero) || tokensNumero <= 0) {
      toast.error(t("Informe uma quantidade de tokens válida."));
      return;
    }
    // N9: nenhum preço é inventado. Vazio vira nulo no banco.
    const precoLimpo = precoCents.trim();
    const precoCentsNumero = precoLimpo.length > 0 ? parseReaisToCents(precoLimpo) : undefined;
    if (precoLimpo.length > 0 && precoCentsNumero === null) {
      toast.error(t("Preço inválido."));
      return;
    }
    iniciarCriacao(async () => {
      const r = await criarPacote({
        codigo: codigoLimpo,
        nome: nome.trim(),
        tokens: tokensNumero,
        precoCents: precoCentsNumero ?? undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Pacote cadastrado."));
      setCodigo("");
      setNome("");
      setTokens("");
      setPrecoCents("");
      router.refresh();
    });
  }

  const [desativandoId, setDesativandoId] = useState<string | null>(null);
  const [desativando, iniciarDesativacao] = useTransition();

  function desativar(pacoteId: string) {
    setDesativandoId(pacoteId);
    iniciarDesativacao(async () => {
      const r = await desativarPacote({ pacoteId });
      if (!r.ok) {
        toast.error(r.error);
        setDesativandoId(null);
        return;
      }
      toast.success(t("Pacote desativado."));
      setDesativandoId(null);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Catálogo de pacotes de tokens")}</CardTitle>
        <CardDescription>
          {t(
            "Os pacotes que o admin de cada organização pode creditar na aba Plano. Sem preço, quem credita informa o valor na hora.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pacote-codigo">{t("Código")}</Label>
            <Input
              id="pacote-codigo"
              className="w-40"
              placeholder={t("pacote_100k")}
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              disabled={criando}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pacote-nome">{t("Nome")}</Label>
            <Input
              id="pacote-nome"
              className="w-48"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              disabled={criando}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pacote-tokens">{t("Tokens")}</Label>
            <Input
              id="pacote-tokens"
              className="w-32"
              inputMode="numeric"
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              disabled={criando}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pacote-preco">{t("Preço (opcional)")}</Label>
            <Input
              id="pacote-preco"
              className="w-32"
              placeholder="R$"
              value={precoCents}
              onChange={(e) => setPrecoCents(e.target.value)}
              disabled={criando}
            />
          </div>
          <Button data-testid="criar-pacote" onClick={criar} disabled={criando}>
            {t("Cadastrar")}
          </Button>
        </div>

        {leituraFalhou ? (
          <p className="text-sm text-destructive" role="alert">
            {t("Não foi possível ler o catálogo de pacotes agora.")}
          </p>
        ) : pacotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum pacote cadastrado ainda.")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Código")}</TableHead>
                <TableHead>{t("Nome")}</TableHead>
                <TableHead>{t("Tokens")}</TableHead>
                <TableHead>{t("Preço")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pacotes.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">{p.codigo}</TableCell>
                  <TableCell>{p.nome}</TableCell>
                  <TableCell className="tabular-nums">{p.tokens.toLocaleString(tagDoIdioma)}</TableCell>
                  <TableCell>{p.preco_cents !== null ? formatCentsBRL(p.preco_cents) : t("a combinar")}</TableCell>
                  <TableCell>
                    <Badge variant={p.ativo ? "success" : "neutral"}>{p.ativo ? t("Ativo") : t("Inativo")}</Badge>
                  </TableCell>
                  <TableCell>
                    {p.ativo && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={desativando && desativandoId === p.id}
                        onClick={() => desativar(p.id)}
                      >
                        {t("Desativar")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * O controle do bloqueio de verdade dos planos (fase F3, tarefa 10, decisão
 * 11 de `hiperbold/planos/fase-F3-tarefas.md`).
 *
 * ─── Por que a troca para "bloquear" pede confirmação, e as outras não ──────
 *
 * As outras trocas desta tela (comportamento, módulos) são reversíveis com um
 * clique e nunca travam a criação de nada para ninguém. Ligar o bloqueio de
 * verdade recusa criar funil, etapa, conexão, webhook, membro e lead de toda
 * organização que já passou do teto E da carência, em TODA organização desta
 * instalação de uma vez. A confirmação mostra o número exato (organizações
 * sem carência hoje, que ganham uma nesta troca) e a data em que a carência
 * delas vence, para o admin decidir vendo o tamanho do efeito.
 *
 * ─── Erro do servidor aparece cru, de propósito ─────────────────────────────
 *
 * Ao contrário do cartão de comportamento (que sempre mostra a mesma frase
 * genérica), as ações desta seção devolvem a frase exata que o servidor
 * escolheu (`Seu acesso de suporte não permite...`, `Confirme a verificação em
 * duas etapas.`), o mesmo padrão de `planoDaOrganizacao.ts`/`_client.tsx` da
 * aba Plano: são frases fixas e já pensadas para quem administra ler, nunca o
 * texto cru do Postgres.
 */
export function FormularioDeBloqueioDosPlanos({ inicial }: { inicial: BloqueioDosPlanos }) {
  const t = useT();
  const router = useRouter();
  const tagDoIdioma = useTagDeIdioma();

  const [modo, setModo] = useState<ModoDeBloqueio>(inicial.modo);
  const [modoParaConfirmar, setModoParaConfirmar] = useState<ModoDeBloqueio | null>(null);
  const [erroModo, setErroModo] = useState<string | null>(null);
  const [trocandoModo, iniciarTrocaDeModo] = useTransition();

  const [dias, setDias] = useState(String(inicial.carenciaDias));
  const [erroDias, setErroDias] = useState<string | null>(null);
  const [salvandoDias, iniciarSalvarDias] = useTransition();

  // `Date.now()` lido uma vez (lazy initializer, molde de `UpdatePanel.tsx`):
  // chamar `Date.now()` direto no corpo do componente é impuro para o React
  // Compiler. Prévia da data de carência, calculada no relógio de quem
  // administra, aproximada de propósito (o `now()` de verdade é o da
  // transação no banco, no momento em que `fn_billing_definir_modo` roda): é
  // só para o admin ver a ORDEM DE GRANDEZA antes de confirmar, não uma
  // promessa de segundo exato.
  const [agora] = useState(() => Date.now());
  const dataDeCarenciaPrevista = new Date(agora + inicial.carenciaDias * MS_POR_DIA);

  function salvarModo(novoModo: ModoDeBloqueio) {
    const anterior = modo;
    setErroModo(null);
    setModo(novoModo);
    iniciarTrocaDeModo(async () => {
      const r = await definirModoDeBloqueio({ modo: novoModo });
      if (!r.ok) {
        setModo(anterior);
        setErroModo(r.error);
        return;
      }
      toast.success(t("Modo do bloqueio atualizado."));
      router.refresh();
    });
  }

  function pedirTrocaDeModo(novoModo: ModoDeBloqueio) {
    if (novoModo === modo) return;
    if (novoModo === "bloquear") {
      setModoParaConfirmar(novoModo);
      return;
    }
    salvarModo(novoModo);
  }

  function confirmarLigarBloqueio() {
    const alvo = modoParaConfirmar;
    setModoParaConfirmar(null);
    if (alvo) salvarModo(alvo);
  }

  function salvarDiasDeCarencia() {
    const valor = Number(dias);
    if (!Number.isInteger(valor) || valor < 0 || valor > 90) {
      setErroDias(t("Informe um número inteiro de 0 a 90."));
      return;
    }
    setErroDias(null);
    iniciarSalvarDias(async () => {
      const r = await definirDiasDeCarencia({ dias: valor });
      if (!r.ok) {
        setErroDias(r.error);
        return;
      }
      toast.success(t("Dias de carência atualizados."));
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Bloqueio dos planos")}</CardTitle>
        <CardDescription>
          {t(
            "O bloqueio de verdade dos limites de plano: funis, etapas, conexões, integrações webhook, membros e leads param de ser criados quando a organização passa do teto contratado, depois da carência dela.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <p>
            {t(
              "A variável PLANOS_BLOQUEIO do servidor só alcança a IA (o teto de tokens). Ela não trava funil, etapa, conexão, webhook, membro nem lead: quem decide isso é o modo abaixo.",
            )}
          </p>
          <p>
            {t(
              "Chave de emergência para as travas do banco: se algo bloquear errado, mude o modo para Só avisa aqui. As travas do banco não leem variável de ambiente nenhuma.",
            )}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="modo-de-bloqueio" className="text-base">
              {t("Modo do bloqueio")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("Bloquear recusa criar acima do teto, depois da carência de cada organização.")}
            </p>
          </div>
          <Select
            value={modo}
            onValueChange={(v) => pedirTrocaDeModo(v as ModoDeBloqueio)}
            disabled={trocandoModo}
          >
            <SelectTrigger id="modo-de-bloqueio" className="w-[220px]" aria-label={t("Modo do bloqueio")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bloquear">{t("Bloquear de verdade")}</SelectItem>
              <SelectItem value="avisar">{t("Só avisa, nunca bloqueia")}</SelectItem>
              <SelectItem value="desligado">{t("Desligado")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {erroModo && (
          <p className="text-sm text-destructive" role="alert">
            {erroModo}
          </p>
        )}

        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="dias-de-carencia" className="text-base">
              {t("Dias de carência")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Quanto tempo uma organização tem, a partir de agora, antes do bloqueio valer para ela. De 0 a 90 dias.",
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="dias-de-carencia"
              className="w-24"
              inputMode="numeric"
              autoComplete="off"
              value={dias}
              onChange={(e) => setDias(e.target.value)}
              disabled={salvandoDias}
              aria-label={t("Dias de carência")}
            />
            <Button
              data-testid="salvar-dias-de-carencia"
              onClick={salvarDiasDeCarencia}
              disabled={salvandoDias}
            >
              {t("Salvar")}
            </Button>
          </div>
        </div>

        {erroDias && (
          <p className="text-sm text-destructive" role="alert">
            {erroDias}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Badge variant={inicial.organizacoesEmCarencia > 0 ? "warning" : "neutral"}>
            {t("Organizações em carência")}: {inicial.organizacoesEmCarencia}
          </Badge>
          <Badge variant={inicial.organizacoesComCarenciaVencida > 0 ? "error" : "neutral"}>
            {t("Com carência vencida")}: {inicial.organizacoesComCarenciaVencida}
          </Badge>
        </div>

        {inicial.leituraFalhou && (
          <p className="text-sm text-destructive" role="alert">
            {t(
              "Não foi possível ler o estado do bloqueio agora. Os números acima podem não refletir a realidade: recarregue a página antes de decidir qualquer coisa com base neles.",
            )}
          </p>
        )}
      </CardContent>

      <AlertDialog
        open={modoParaConfirmar !== null}
        onOpenChange={(v) => {
          if (!v) setModoParaConfirmar(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Ligar o bloqueio de verdade dos planos?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "A partir de agora, toda organização sem carência ganha uma: ela poderá continuar criando normalmente até a data abaixo, e só depois dela o teto do plano passa a valer de verdade.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-1 py-2 text-sm">
            <p>
              <span className="font-medium">{t("Organizações que ganham carência agora")}:</span>{" "}
              {inicial.organizacoesSemCarencia}
            </p>
            <p>
              <span className="font-medium">{t("Carência até")}:</span>{" "}
              {dataDeCarenciaPrevista.toLocaleDateString(tagDoIdioma)}
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction data-testid="confirmar-ligar-bloqueio" onClick={confirmarLigarBloqueio}>
              {t("Ligar o bloqueio")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * Os MÓDULOS OPCIONAIS da instalação — desligados por padrão, e é aqui, e só
 * aqui, que se ligam (doc 24: liga/desliga de configuração geral tem tela, sem
 * `.env`). Mesmo desenho do cartão de cima: salva no clique, volta no erro.
 */
/** Cada módulo, como ele aparece aqui. O texto diz o que ligar ABRE, não só o nome. */
const MODULOS_NA_TELA: ReadonlyArray<{ modulo: ModuloOpcional; id: string; rotulo: string; descricao: string }> = [
  {
    modulo: "banco_externo",
    id: "modulo-banco-externo",
    rotulo: "Banco de dados externo",
    descricao:
      "Ligado, cada empresa pode conectar o banco de outro sistema (um ERP, outro CRM) para o agente consultar. Isso guarda a senha daquele banco neste servidor e abre conexão com ele. Desligado, a tela, o menu e as ferramentas do agente somem.",
  },
  {
    modulo: "fluxos_atendimento",
    id: "modulo-fluxos-atendimento",
    rotulo: "Fluxos de atendimento",
    descricao:
      "Ligado, cada empresa pode montar roteiros de perguntas que a IA conduz durante a conversa (nome, CPF, interesse…), e as respostas aparecem na ficha do cliente. Desligado, a tela, o menu e o roteiro no atendimento da IA somem.",
  },
];

export function FormularioDeModulos({ ligados }: { ligados: readonly ModuloOpcional[] }) {
  const t = useT();
  const [estado, setEstado] = useState<ReadonlySet<ModuloOpcional>>(new Set(ligados));
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function trocar(modulo: ModuloOpcional, valor: boolean) {
    setErro(null);
    const alternar = (ligar: boolean) =>
      setEstado((atual) => {
        const proximo = new Set(atual);
        if (ligar) proximo.add(modulo);
        else proximo.delete(modulo);
        return proximo;
      });
    alternar(valor);
    startTransition(async () => {
      const r = await updateModuloDaInstalacao({ modulo, ligado: valor });
      if (!r.ok) {
        alternar(!valor);
        setErro(t("Não deu para salvar. Tente de novo em instantes."));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Módulos opcionais")}</CardTitle>
        <CardDescription>
          {t(
            "Recursos que a maioria das instalações não usa. Desligados, eles não aparecem para nenhuma empresa daqui.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {MODULOS_NA_TELA.map((m) => (
          <div key={m.modulo} className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor={m.id} className="text-base">
                {t(m.rotulo)}
              </Label>
              <p className="text-sm text-muted-foreground">{t(m.descricao)}</p>
            </div>
            <Switch
              id={m.id}
              checked={estado.has(m.modulo)}
              onCheckedChange={(valor) => trocar(m.modulo, valor)}
              disabled={pendente}
              aria-label={t(m.rotulo)}
            />
          </div>
        ))}

        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
