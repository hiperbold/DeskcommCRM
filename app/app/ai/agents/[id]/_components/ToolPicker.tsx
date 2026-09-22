"use client";
/**
 * O que o agente pode fazer — na língua de quem contrata um agente, não na de
 * quem escreve um.
 *
 * Antes desta tela o humano via `crm_move_lead_stage` em fonte monoespaçada,
 * agrupado por "Leitura / Escrita / Especiais". Isso descreve o código, não a
 * decisão: quem configura é dono de clínica, de loja, de imobiliária, e a
 * pergunta dele é "o que essa coisa vai fazer com meus clientes?".
 *
 * O caminho padrão é o PACOTE por jornada. O checkbox por capacidade continua
 * existindo em modo avançado — para quem quer, quando quer.
 *
 * A regra de quem entra por pacote NÃO mora aqui: vive em
 * `lib/mcp/tools/selecao-por-pacote.ts`, com teste. O componente chama e
 * renderiza. Regra dentro de `onChange` é regra que nunca é exercitada.
 */
import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import {
  PACOTES,
  riscoMeta,
  type ToolBundle,
  type ToolRisk,
} from "@/lib/mcp/tools/pacotes";
import {
  TETO_TOOLS_POR_AGENTE,
  capacidadesAutomaticasDoPacote,
  capacidadesCriticasDoPacote,
  desligarPacote,
  estadoDoPacote,
  ligarPacote,
  vagasExigidasPeloPacote,
  textoDaContagem,
  vagasRestantes,
  type CapacidadeSelecionavel,
} from "@/lib/mcp/tools/selecao-por-pacote";

/**
 * O que a rota `/api/v1/mcp/tools` serve (snake_case no wire).
 *
 * `conexao` e `somente_leitura_confirmado` só existem na ferramenta que vem de
 * `/api/v1/ai/mcp/ferramentas` (conexão MCP externa) — é a presença de
 * `conexao` que a ficha usa para saber que precisa mostrar o selo de
 * aprovação; uma capacidade do catálogo nunca tem esse campo.
 */
export interface McpToolMeta extends CapacidadeSelecionavel {
  id: string;
  description: string;
  category: string;
  requires_role: string;
  requires_scope: string;
  rotulo: string;
  explicacao: string;
  o_que_toca: string;
  risco: ToolRisk;
  pacotes: ReadonlyArray<ToolBundle>;
  conexao?: { apelido: string; nome: string };
  somente_leitura_confirmado?: boolean | null;
}

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

interface ApiResponse {
  data: { tools: Array<Omit<McpToolMeta, "name">> };
}

const TODOS_OS_PACOTES: ReadonlyArray<ToolBundle> = PACOTES.map((p) => p.id);

const CLASSE_RISCO: Record<ToolRisk, string> = {
  seguro: "border-border/60 text-muted-foreground",
  atencao: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  critico: "border-destructive/40 text-destructive",
};

function BadgeRisco({ risco }: { risco: ToolRisk }) {
  const t = useT();
  const meta = riscoMeta(risco);
  return (
    <Badge variant="outline" className={`text-[11px] ${CLASSE_RISCO[risco]}`} title={t(meta.explicacao)}>
      {t(meta.rotulo)}
    </Badge>
  );
}

/**
 * O estado de aprovação de uma ferramenta de conexão MCP — nada a ver com
 * `risco` (que é o que ela FAZ). `true`/`false` são a decisão do admin
 * (Tarefa 11); `null` é "o servidor sugeriu, ninguém confirmou ainda", e por
 * isso pode ser marcada no agente, mas não roda sem essa confirmação.
 */
function BadgeAprovacao({ aprovacao }: { aprovacao: boolean | null | undefined }) {
  const t = useT();
  if (aprovacao === true) {
    return (
      <Badge variant="outline" className="text-[11px] border-border/60 text-muted-foreground">
        {t("Só consulta")}
      </Badge>
    );
  }
  if (aprovacao === false) {
    return (
      <Badge variant="outline" className="text-[11px] border-amber-500/40 text-amber-700 dark:text-amber-400">
        {t("Altera dados")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[11px] border-amber-500/40 text-amber-700 dark:text-amber-400">
      {t("Aguardando aprovação")}
    </Badge>
  );
}

/** Ficha de uma capacidade — o que ela faz, o que toca, quanto pode doer. */
function FichaCapacidade({
  capacidade,
  marcada,
  bloqueada,
  onToggle,
  disabled,
  mostrarNomeTecnico,
}: {
  capacidade: McpToolMeta;
  marcada: boolean;
  bloqueada: boolean;
  onToggle: () => void;
  disabled?: boolean;
  mostrarNomeTecnico?: boolean;
}) {
  const t = useT();
  return (
    <label
      data-testid={`capacidade-${capacidade.name}`}
      data-marcada={marcada ? "sim" : "nao"}
      data-risco={capacidade.risco}
      className={`flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/40 ${
        bloqueada ? "opacity-60" : ""
      }`}
    >
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 rounded-md border-border accent-primary"
        checked={marcada}
        onChange={onToggle}
        disabled={disabled || bloqueada}
        aria-label={t(capacidade.rotulo)}
      />
      <span className="flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t(capacidade.rotulo)}</span>
          <BadgeRisco risco={capacidade.risco} />
          {/*
            `risco` de uma ferramenta externa É a confirmação: a rota
            calcula "seguro" só quando `somente_leitura_confirmado === true`
            (ver `app/api/v1/ai/mcp/ferramentas/route.ts`). Nesse caso o selo
            de risco já diz "Só consulta" — repetir aqui seria o MESMO texto
            duas vezes na mesma ficha. O selo de aprovação só soma
            informação quando distingue "Altera dados" (confirmado) de
            "Aguardando aprovação" (ninguém decidiu ainda), coisa que o selo
            de risco sozinho não separa.
          */}
          {capacidade.conexao && capacidade.somente_leitura_confirmado !== true ? (
            <BadgeAprovacao aprovacao={capacidade.somente_leitura_confirmado} />
          ) : null}
          <span className="text-xs text-muted-foreground">· {t(capacidade.o_que_toca)}</span>
        </span>
        <span className="block text-xs text-muted-foreground">{t(capacidade.explicacao)}</span>
        {capacidade.conexao && capacidade.somente_leitura_confirmado == null ? (
          <span
            data-testid={`aviso-aprovacao-${capacidade.name}`}
            className="block text-xs text-amber-700 dark:text-amber-400"
          >
            {t("Não roda até o admin aprovar em IA › Conexões MCP.")}
          </span>
        ) : null}
        {mostrarNomeTecnico ? (
          <code className="block font-mono text-[11px] text-muted-foreground">
            {capacidade.name}
          </code>
        ) : null}
      </span>
    </label>
  );
}

export function ToolPicker({ value, onChange, disabled }: Props) {
  const t = useT();
  const [avancado, setAvancado] = React.useState(false);
  const [recusa, setRecusa] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ["mcp", "tools"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>("/api/v1/mcp/tools");
      // `name` é o mesmo `id` — a regra de seleção fala em `name`, o wire em `id`.
      return res.data.tools.map((t) => ({ ...t, name: t.id })) as McpToolMeta[];
    },
    staleTime: 60_000,
  });

  /**
   * As ferramentas das conexões MCP da organização, numa consulta SEPARADA:
   * quem falha aqui não pode derrubar o catálogo interno, que é o essencial da
   * tela. `staleTime` igual ao do catálogo — as duas envelhecem juntas.
   */
  const queryExternas = useQuery({
    queryKey: ["mcp", "externas"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>("/api/v1/ai/mcp/ferramentas");
      return res.data.tools.map((t) => ({ ...t, name: t.id })) as McpToolMeta[];
    },
    staleTime: 60_000,
  });

  const doCatalogo = React.useMemo<McpToolMeta[]>(() => query.data ?? [], [query.data]);
  const externas = React.useMemo<McpToolMeta[]>(() => queryExternas.data ?? [], [queryExternas.data]);

  /**
   * Contagem, órfãs, `alternarCapacidade` e as funções de pacote precisam da
   * lista JUNTA: uma capacidade MCP marcada é uma capacidade que ocupa vaga do
   * mesmo teto, e um id `mcp_*` só deixa de ser órfão se aparecer aqui. O modo
   * avançado continua olhando só `doCatalogo` — a externa já tem casa própria,
   * a seção "Conexões MCP", e duplicá-la lá seria mostrar a mesma ficha duas
   * vezes.
   */
  const catalogo = React.useMemo<McpToolMeta[]>(
    () => [...doCatalogo, ...externas],
    [doCatalogo, externas],
  );
  const porNome = React.useMemo(
    () => new Map(catalogo.map((c) => [c.name, c])),
    [catalogo],
  );

  /**
   * Enquanto a primeira carga das externas não termina, `catalogo` ainda não
   * tem os ids `mcp_*` que já estavam marcados — ligar um pacote agora
   * apagaria essas marcas em silêncio (`ligarPacote` só preserva o que está na
   * lista que recebe). Trava o toggle até a lista estar completa.
   */
  const externasCarregando = queryExternas.isLoading;

  /** Ferramentas externas agrupadas por conexão, na ordem em que chegaram. */
  const porConexao = React.useMemo(() => {
    const grupos = new Map<string, { nome: string; ferramentas: McpToolMeta[] }>();
    for (const ferramenta of externas) {
      const chave = ferramenta.conexao?.apelido ?? ferramenta.o_que_toca;
      const nome = ferramenta.conexao?.nome ?? ferramenta.o_que_toca;
      const grupo = grupos.get(chave) ?? { nome, ferramentas: [] };
      grupo.ferramentas.push(ferramenta);
      grupos.set(chave, grupo);
    }
    return [...grupos.values()];
  }, [externas]);

  const vagas = vagasRestantes(value);
  const cheio = vagas <= 0;

  /** Ids salvos que o servidor não oferece mais — some da tela seria mentir. */
  const orfas = value.filter((id) => !porNome.has(id));

  /**
   * `vagasExigidas` é o que DECIDE, e por padrão é o tamanho do resultado.
   *
   * Ele existe separado porque ligar um pacote exige mais vagas do que o
   * resultado ocupa: as críticas do pacote não entram por ele, mas o humano
   * precisa poder marcá-las depois (issue #162). A primeira versão desta
   * correção contava as críticas só na MENSAGEM de recusa e deixava a decisão
   * em `proximo.length` — o número certo aparecia no texto e não mudava nada.
   * Medido na tela: com 3 ligadas, "Atender" (17 automáticas + 1 crítica)
   * chegava a 20, passava, e a crítica nascia desabilitada.
   */
  function aplicar(proximo: string[], motivoSeRecusar: string, vagasExigidas = proximo.length) {
    if (vagasExigidas > TETO_TOOLS_POR_AGENTE) {
      setRecusa(motivoSeRecusar);
      return;
    }
    setRecusa(null);
    onChange(proximo);
  }

  function alternarPacote(pacote: ToolBundle, ligar: boolean) {
    if (ligar) {
      const proximo = ligarPacote(value, catalogo, pacote);
      // O excedente conta as CRÍTICAS do pacote junto (issue #162): ligar o
      // pacote e deixar a crítica dele sem vaga é prometer uma escolha que o
      // produto não permite fazer — o checkbox nasce desabilitado, sem dizer
      // por quê. Ou cabe inteiro, com a vaga da crítica guardada, ou não liga
      // e a tela diz quantas faltam.
      const exigidas = vagasExigidasPeloPacote(value, catalogo, pacote);
      const excedente = exigidas - TETO_TOOLS_POR_AGENTE;
      aplicar(
        proximo,
        `${t("Ligar este pacote passaria de")} ${TETO_TOOLS_POR_AGENTE} ${t("capacidades (faltam")} ${excedente} ${
          excedente === 1 ? t("vaga") : t("vagas")
        }${t("). Desligue um pacote que você usa menos antes.")}`,
        exigidas,
      );
    } else {
      setRecusa(null);
      onChange(desligarPacote(value, catalogo, pacote, TODOS_OS_PACOTES));
    }
  }

  function alternarCapacidade(name: string) {
    if (value.includes(name)) {
      setRecusa(null);
      onChange(value.filter((x) => x !== name));
      return;
    }
    aplicar(
      [...catalogo.map((c) => c.name), ...orfas].filter(
        (n) => value.includes(n) || n === name,
      ),
      `${t("Você já ligou")} ${TETO_TOOLS_POR_AGENTE} ${t("capacidades. Desligue uma antes de ligar outra.")}`,
    );
  }

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Carregando as capacidades…")}</p>;
  }
  if (query.isError) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {t("Não foi possível carregar as capacidades. Recarregue a página.")}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="tool-picker">
      {/* Consumo do teto — o número que impede a surpresa no salvar. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
        <p className="text-sm">
          <strong data-testid="consumo-teto">
            {value.length} {t("de")} {TETO_TOOLS_POR_AGENTE}
          </strong>{" "}
          {t("capacidades ligadas")}
        </p>
        <p className="text-xs text-muted-foreground">
          {cheio
            ? t("Limite atingido. Desligue algo para ligar outra coisa.")
            : t("Acima disso o agente erra na hora de escolher o que usar.")}
        </p>
      </div>

      {recusa ? (
        <p
          data-testid="aviso-teto"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {recusa}
        </p>
      ) : null}

      {/* Caminho padrão: pacotes por jornada. */}
      <div className="grid gap-3">
        {PACOTES.map((pacote) => {
          const automaticas = capacidadesAutomaticasDoPacote(catalogo, pacote.id);
          const criticas = capacidadesCriticasDoPacote(catalogo, pacote.id);
          const estado = estadoDoPacote(value, catalogo, pacote.id);
          const total = automaticas.length + criticas.length;
          const ligadas = [...automaticas, ...criticas].filter((n) =>
            value.includes(n),
          ).length;
          const vazio = total === 0;

          return (
            <div
              key={pacote.id}
              data-testid={`pacote-${pacote.id}`}
              data-estado={estado}
              className="space-y-3 rounded-md border border-border/60 p-4"
            >
              <div className="flex items-start gap-3">
                <Switch
                  id={`pacote-${pacote.id}`}
                  data-testid={`switch-pacote-${pacote.id}`}
                  checked={estado === "ligado"}
                  onCheckedChange={(v) => alternarPacote(pacote.id, v)}
                  disabled={disabled || vazio || externasCarregando}
                  aria-label={pacote.rotulo}
                />
                <div className="flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      htmlFor={`pacote-${pacote.id}`}
                      className="cursor-pointer text-sm font-medium"
                    >
                      {pacote.rotulo}
                    </label>
                    {estado === "parcial" ? (
                      <Badge variant="outline" className="text-[11px]">
                        {t("parcial")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{pacote.explicacao}</p>
                  <p className="text-xs text-muted-foreground" data-testid={`contagem-${pacote.id}`}>
                    {textoDaContagem(total, ligadas, t)}
                  </p>
                </div>
              </div>

              {/* Crítico nunca entra por pacote: exige o dedo do humano. */}
              {criticas.length > 0 ? (
                <div
                  data-testid={`criticas-${pacote.id}`}
                  className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2"
                >
                  <p className="text-xs font-medium text-destructive">
                    {t("Só ligando uma a uma — o pacote não liga por você:")}
                  </p>
                  {criticas.map((name) => {
                    const capacidade = porNome.get(name);
                    if (!capacidade) return null;
                    const marcada = value.includes(name);
                    return (
                      <FichaCapacidade
                        key={name}
                        capacidade={capacidade}
                        marcada={marcada}
                        bloqueada={!marcada && cheio}
                        onToggle={() => alternarCapacidade(name)}
                        disabled={disabled}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/*
        Ferramentas de conexões MCP — cada uma é uma capacidade própria, uma a
        uma, nunca por pacote (elas nascem com `pacotes: []`). Falha na
        consulta não pode levar a tela de catálogo junto: mostra o aviso aqui
        dentro, sem barrar mais nada.
      */}
      <div className="space-y-3 rounded-md border border-border/60 p-4" data-testid="secao-mcp-externo">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t("Conexões MCP")}</h3>
          <Link
            href="/app/ai/mcp"
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("Gerenciar conexões MCP")}
          </Link>
        </div>

        {queryExternas.isError ? (
          <p className="text-xs text-muted-foreground" data-testid="mcp-externo-erro">
            {t("Não foi possível carregar as ferramentas das conexões MCP.")}
          </p>
        ) : porConexao.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "Nenhuma conexão MCP. Conecte um servidor em IA › Conexões MCP para dar ferramentas de outros sistemas ao agente.",
            )}
          </p>
        ) : (
          porConexao.map((grupo) => (
            <div key={grupo.nome} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{grupo.nome}</p>
              {grupo.ferramentas.map((ferramenta) => {
                const marcada = value.includes(ferramenta.name);
                return (
                  <FichaCapacidade
                    key={ferramenta.name}
                    capacidade={ferramenta}
                    marcada={marcada}
                    bloqueada={!marcada && cheio}
                    onToggle={() => alternarCapacidade(ferramenta.name)}
                    disabled={disabled}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Modo avançado: a lista inteira, capacidade por capacidade. */}
      <div className="space-y-2">
        <button
          type="button"
          data-testid="toggle-avancado"
          aria-expanded={avancado}
          onClick={() => setAvancado((v) => !v)}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {avancado ? t("Esconder a lista completa") : t("Escolher uma a uma (modo avançado)")}
        </button>

        {avancado ? (
          <div
            data-testid="lista-avancada"
            className="space-y-1 rounded-md border border-border/60 p-3"
          >
            <p className="pb-1 text-xs text-muted-foreground">
              {t(
                "Cada linha é uma capacidade. O nome em cinza é como ela aparece para quem integra o sistema por fora.",
              )}
            </p>
            {doCatalogo.map((capacidade) => {
              const marcada = value.includes(capacidade.name);
              return (
                <FichaCapacidade
                  key={capacidade.name}
                  capacidade={capacidade}
                  marcada={marcada}
                  bloqueada={!marcada && cheio}
                  onToggle={() => alternarCapacidade(capacidade.name)}
                  disabled={disabled}
                  mostrarNomeTecnico
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {orfas.length > 0 ? (
        <div
          data-testid="capacidades-orfas"
          className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
        >
          <p>
            {orfas.length === 1
              ? t("Uma capacidade ligada não existe mais")
              : `${orfas.length} ${t("capacidades ligadas não existem mais")}`}{" "}
            {t("nesta versão do sistema (")}
            {orfas.join(", ")}
            {t("). Elas continuam salvas, mas o agente não consegue usá-las.")}
          </p>
          <button
            type="button"
            data-testid="remover-orfas"
            disabled={disabled}
            onClick={() => {
              setRecusa(null);
              onChange(value.filter((id) => porNome.has(id)));
            }}
            className="font-medium underline underline-offset-4 disabled:opacity-50"
          >
            {t("Desligar")} {orfas.length === 1 ? t("essa capacidade") : t("essas capacidades")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
