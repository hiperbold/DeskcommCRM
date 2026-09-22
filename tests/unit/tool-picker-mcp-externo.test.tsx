/**
 * As ferramentas de conexões MCP entram na MESMA tela de capacidades do
 * agente, contam no MESMO teto de 25 e usam a MESMA ficha — mas vêm de uma
 * consulta separada (`/api/v1/ai/mcp/ferramentas`), então precisam se
 * comportar bem quando essa segunda consulta falha ou ainda não terminou.
 *
 * `ToolPicker` é controlado: quem muda `value` de verdade é o teste, imitando
 * o pai (`AgentForm`) — por isso todo cenário de "marcar" passa `value` de
 * novo depois do `onChange`.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => getMock(...a) },
}));

import { ToolPicker } from "@/app/app/ai/agents/[id]/_components/ToolPicker";

const FERRAMENTA_CATALOGO = {
  id: "crm_move_lead_stage",
  description: "Move o lead de etapa",
  category: "write",
  requires_role: "ai_operator",
  requires_scope: "crm:write",
  rotulo: "Mover etapa do funil",
  explicacao: "O agente move o lead para outra etapa.",
  o_que_toca: "Funil",
  risco: "atencao",
  pacotes: ["vender"],
};

function ferramentaExterna(over: Record<string, unknown> = {}) {
  return {
    id: "mcp_n8n__listar_leads",
    description: "Lista os leads do CRM externo",
    category: "read",
    requires_role: "ai_operator",
    requires_scope: "mcp:read",
    rotulo: "listar_leads",
    explicacao: "Lista os leads do CRM externo",
    o_que_toca: "n8n de produção",
    risco: "seguro",
    pacotes: [],
    conexao: { apelido: "n8n", nome: "n8n de produção" },
    somente_leitura_confirmado: true,
    ...over,
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/** `/api/v1/mcp/tools` (catálogo) sempre primeiro; `/ferramentas` (externas) sempre segundo — é a ordem em que o componente chama as duas queries. */
function mockarRotas(opts: {
  catalogo?: unknown[];
  externas?: unknown[] | Error;
  externasPendente?: boolean;
}) {
  const { catalogo = [FERRAMENTA_CATALOGO], externas = [], externasPendente = false } = opts;
  getMock.mockImplementation(async (url: string) => {
    if (url === "/api/v1/mcp/tools") {
      return { data: { tools: catalogo } };
    }
    if (url === "/api/v1/ai/mcp/ferramentas") {
      if (externasPendente) return new Promise(() => {});
      if (externas instanceof Error) throw externas;
      return { data: { tools: externas } };
    }
    throw new Error(`rota inesperada no teste: ${url}`);
  });
}

function Controlado({ inicial }: { inicial: string[] }) {
  const [value, setValue] = React.useState<string[]>(inicial);
  return <ToolPicker value={value} onChange={setValue} />;
}

beforeEach(() => {
  getMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Seção Conexões MCP", () => {
  it("2 ferramentas externas aparecem na seção, com o nome da conexão", async () => {
    mockarRotas({
      externas: [
        ferramentaExterna({ id: "mcp_n8n__listar_leads", rotulo: "listar_leads" }),
        ferramentaExterna({ id: "mcp_n8n__criar_lead", rotulo: "criar_lead" }),
      ],
    });
    render(wrap(<Controlado inicial={[]} />));

    expect(await screen.findByText("Conexões MCP")).toBeInTheDocument();
    expect(screen.getByText("n8n de produção")).toBeInTheDocument();
    expect(screen.getByTestId("capacidade-mcp_n8n__listar_leads")).toBeInTheDocument();
    expect(screen.getByTestId("capacidade-mcp_n8n__criar_lead")).toBeInTheDocument();
  });

  it("marcar uma ferramenta externa sobe o contador de N de 25 para N+1 de 25", async () => {
    mockarRotas({ externas: [ferramentaExterna()] });
    render(wrap(<Controlado inicial={[]} />));

    await screen.findByTestId("capacidade-mcp_n8n__listar_leads");
    expect(screen.getByTestId("consumo-teto")).toHaveTextContent("0 de 25");

    fireEvent.click(screen.getByTestId("capacidade-mcp_n8n__listar_leads"));

    expect(await screen.findByTestId("consumo-teto")).toHaveTextContent("1 de 25");
  });

  it("com 25 ligadas, a ficha externa desmarcada fica bloqueada", async () => {
    const cheias = Array.from({ length: 25 }, (_, i) => `crm_tool_${i}`);
    mockarRotas({ externas: [ferramentaExterna()] });
    render(wrap(<Controlado inicial={cheias} />));

    const ficha = await screen.findByTestId("capacidade-mcp_n8n__listar_leads");
    expect(ficha.querySelector("input")).toBeDisabled();
  });

  it("id mcp_* salvo fora da lista vira órfão; um que está na lista não", async () => {
    mockarRotas({ externas: [ferramentaExterna({ id: "mcp_n8n__listar_leads" })] });
    render(
      wrap(<Controlado inicial={["mcp_n8n__listar_leads", "mcp_n8n__fantasma"]} />),
    );

    await screen.findByTestId("capacidade-mcp_n8n__listar_leads");
    const orfas = await screen.findByTestId("capacidades-orfas");
    expect(orfas).toHaveTextContent("mcp_n8n__fantasma");
    expect(orfas).not.toHaveTextContent("mcp_n8n__listar_leads,");
    expect(screen.queryByText(/mcp_n8n__listar_leads\)/)).not.toBeInTheDocument();
  });

  it("ferramenta externa crítica mostra o selo de risco 'crítico'", async () => {
    mockarRotas({
      externas: [ferramentaExterna({ risco: "critico", somente_leitura_confirmado: false })],
    });
    render(wrap(<Controlado inicial={[]} />));

    const ficha = await screen.findByTestId("capacidade-mcp_n8n__listar_leads");
    expect(ficha).toHaveAttribute("data-risco", "critico");
  });
});

describe("Estado de aprovação da ferramenta externa", () => {
  it("mostra os três estados: Só consulta, Altera dados e Aguardando aprovação", async () => {
    mockarRotas({
      externas: [
        ferramentaExterna({ id: "mcp_n8n__a", rotulo: "a", somente_leitura_confirmado: true }),
        ferramentaExterna({
          id: "mcp_n8n__b",
          rotulo: "b",
          risco: "critico",
          somente_leitura_confirmado: false,
        }),
        ferramentaExterna({
          id: "mcp_n8n__c",
          rotulo: "c",
          risco: "critico",
          somente_leitura_confirmado: null,
        }),
      ],
    });
    render(wrap(<Controlado inicial={[]} />));

    await screen.findByTestId("capacidade-mcp_n8n__a");
    expect(screen.getByText("Só consulta")).toBeInTheDocument();
    expect(screen.getByText("Altera dados")).toBeInTheDocument();
    expect(screen.getByText("Aguardando aprovação")).toBeInTheDocument();
  });

  it("ferramenta aguardando aprovação mostra o aviso de que não roda ainda, e pode ser marcada", async () => {
    mockarRotas({
      externas: [
        ferramentaExterna({
          id: "mcp_n8n__pendente",
          rotulo: "pendente",
          risco: "critico",
          somente_leitura_confirmado: null,
        }),
      ],
    });
    render(wrap(<Controlado inicial={[]} />));

    const ficha = await screen.findByTestId("capacidade-mcp_n8n__pendente");
    expect(ficha).toHaveTextContent(/aprovar/);
    const checkbox = ficha.querySelector("input") as HTMLInputElement;
    expect(checkbox).not.toBeDisabled();

    fireEvent.click(checkbox);
    expect(await screen.findByTestId("consumo-teto")).toHaveTextContent("1 de 25");
  });
});

describe("Falha da consulta de externas não derruba a tela", () => {
  it("catálogo continua funcionando e a seção mostra o aviso de erro", async () => {
    mockarRotas({
      catalogo: [FERRAMENTA_CATALOGO],
      externas: new Error("500"),
    });
    render(wrap(<Controlado inicial={[]} />));

    // O resto da tela (catálogo) segue de pé.
    expect(await screen.findByTestId("tool-picker")).toBeInTheDocument();
    expect(
      await screen.findByText("Não foi possível carregar as ferramentas das conexões MCP."),
    ).toBeInTheDocument();
  });
});

describe("Contador soma catálogo e externas", () => {
  it("uma capacidade do catálogo e uma externa marcadas contam as duas", async () => {
    mockarRotas({
      catalogo: [FERRAMENTA_CATALOGO],
      externas: [ferramentaExterna()],
    });
    render(
      wrap(
        <Controlado
          inicial={["crm_move_lead_stage", "mcp_n8n__listar_leads"]}
        />,
      ),
    );

    expect(await screen.findByTestId("consumo-teto")).toHaveTextContent("2 de 25");
  });
});

describe("Sem conexões", () => {
  it("mostra o convite para conectar um servidor", async () => {
    mockarRotas({ externas: [] });
    render(wrap(<Controlado inicial={[]} />));

    expect(
      await screen.findByText(/Nenhuma conexão MCP\. Conecte um servidor/),
    ).toBeInTheDocument();
  });
});
