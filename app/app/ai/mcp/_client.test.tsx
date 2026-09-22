/**
 * A tela "Conexões MCP" (Tarefa 11): lista com URL mascarada e contagem de
 * "aguardando aprovação", cadastro com aviso LGPD, aprovação de ferramenta
 * (três estados), ferramenta recusada desabilitada, "mudou desde a última
 * aprovação" e o botão de escrita escondido para quem não é admin.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/types";
import { McpClient } from "./_client";
import type { ConexaoPublica, FerramentaEmCache } from "@/lib/ai/mcp-externo/tipos";

function ferramenta(extra: Partial<FerramentaEmCache> = {}): FerramentaEmCache {
  return {
    nome: "listar_leads",
    descricao: "Lista os leads do funil",
    input_schema: {},
    somente_leitura: true,
    id: "mcp_n8n__listar_leads",
    recusada: null,
    somente_leitura_confirmado: null,
    ...extra,
  };
}

function conexao(extra: Partial<ConexaoPublica> = {}): ConexaoPublica {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    apelido: "n8n",
    nome: "n8n de produção",
    url: "https://n8n.hiperbold.com.br/…",
    tem_cabecalho: true,
    cabecalho_nome: "Authorization",
    ativa: true,
    ferramentas: [ferramenta()],
    ferramentas_atualizadas_em: "2026-09-20T10:00:00.000Z",
    ultimo_erro: null,
    atualizada_em: "2026-09-20T09:00:00.000Z",
    ...extra,
  };
}

function montar(conexoes: ConexaoPublica[], props: { canWrite?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  return render(
    <QueryClientProvider client={client}>
      <McpClient initialData={conexoes} canWrite={props.canWrite ?? true} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("McpClient — lista", () => {
  it("mostra a URL mascarada e a contagem de ferramentas aguardando aprovação", () => {
    montar([
      conexao({
        ferramentas: [
          ferramenta({ nome: "listar_leads", somente_leitura_confirmado: null }),
          ferramenta({ nome: "criar_lead", id: "mcp_n8n__criar_lead", somente_leitura_confirmado: null }),
          ferramenta({ nome: "apagar_lead", id: "mcp_n8n__apagar_lead", somente_leitura_confirmado: true }),
        ],
      }),
    ]);
    expect(screen.getByText(/https:\/\/n8n\.hiperbold\.com\.br\/…/)).toBeInTheDocument();
    // duas ferramentas com somente_leitura_confirmado null (a terceira já foi decidida).
    expect(screen.getByText(/2 aguardando aprovação/)).toBeInTheDocument();
  });

  it("nunca mostra o valor do cabeçalho — só 'com chave' / 'sem chave'", () => {
    montar([conexao({ tem_cabecalho: true })]);
    expect(screen.getByText(/com chave/)).toBeInTheDocument();
    expect(screen.queryByText(/Bearer/)).toBeNull();
  });
});

describe("McpClient — cadastro", () => {
  it("mostra o aviso de LGPD no formulário de cadastro", async () => {
    const user = userEvent.setup();
    montar([]);
    await user.click(screen.getByRole("button", { name: "Conectar servidor MCP" }));
    expect(screen.getByText(/LGPD/)).toBeInTheDocument();
    expect(screen.getByText(/servidor de terceiro configurado aqui/)).toBeInTheDocument();
  });

  it("erro do servidor ao conectar aparece de forma legível (toast com a mensagem da API)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockRejectedValue(
      new ApiError(422, "unprocessable_entity", undefined, "req-1", "Não foi possível conectar ao servidor."),
    );
    montar([]);
    await user.click(screen.getByRole("button", { name: "Conectar servidor MCP" }));
    await user.type(screen.getByLabelText("Nome"), "n8n de produção");
    await user.type(screen.getByLabelText("Apelido"), "n8n");
    await user.type(screen.getByLabelText("Endereço"), "https://n8n.exemplo.com");
    await user.click(screen.getByRole("button", { name: "Conectar e listar ferramentas" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Não foi possível conectar ao servidor.", expect.anything()),
    );
  });
});

describe("McpClient — aprovação de ferramenta", () => {
  it("clicar em 'Só consulta' aprova a ferramenta com true", async () => {
    const user = userEvent.setup();
    const c = conexao();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { conexao: c } });
    montar([c]);

    const linha = screen.getByText("listar_leads").closest("li")!;
    await user.click(within(linha).getByRole("button", { name: "Só consulta" }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        `/api/v1/ai/mcp/conexoes/${c.id}/ferramentas`,
        { nome: "listar_leads", aprovacao: true, versao: c.atualizada_em },
      ),
    );
  });

  it("clicar em 'Altera dados' aprova a ferramenta com false", async () => {
    const user = userEvent.setup();
    const c = conexao();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { conexao: c } });
    montar([c]);

    const linha = screen.getByText("listar_leads").closest("li")!;
    await user.click(within(linha).getByRole("button", { name: "Altera dados" }));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        `/api/v1/ai/mcp/conexoes/${c.id}/ferramentas`,
        { nome: "listar_leads", aprovacao: false, versao: c.atualizada_em },
      ),
    );
  });

  it("ferramenta 'Aguardando aprovação' mostra o rótulo e a sugestão do servidor", () => {
    montar([conexao({ ferramentas: [ferramenta({ somente_leitura: true, somente_leitura_confirmado: null })] })]);
    expect(screen.getByText("Aguardando aprovação")).toBeInTheDocument();
    expect(screen.getByText(/só consulta/)).toBeInTheDocument();
  });
});

describe("McpClient — ferramenta recusada", () => {
  it("aparece desabilitada, com o motivo, e sem botões de aprovação", () => {
    montar([
      conexao({
        ferramentas: [
          ferramenta({
            nome: "ferramenta_ruim",
            id: null,
            recusada: "O esquema desta ferramenta é grande demais.",
            somente_leitura_confirmado: null,
          }),
        ],
      }),
    ]);
    const linha = screen.getByText("ferramenta_ruim").closest("li")!;
    expect(within(linha).getByText("O esquema desta ferramenta é grande demais.")).toBeInTheDocument();
    expect(within(linha).queryByRole("button")).toBeNull();
  });
});

describe("McpClient — 'mudou desde a última aprovação'", () => {
  it("mostra a bandeira quando o repositório marca mudou_desde_aprovacao na ferramenta", () => {
    montar([
      conexao({
        ferramentas: [
          ferramenta({ somente_leitura_confirmado: null, mudou_desde_aprovacao: true }),
        ],
      }),
    ]);
    expect(screen.getByText(/mudou desde a última aprovação/)).toBeInTheDocument();
  });

  it("não mostra a bandeira quando mudou_desde_aprovacao é false ou ausente", () => {
    montar([conexao({ ferramentas: [ferramenta({ somente_leitura_confirmado: null })] })]);
    expect(screen.queryByText(/mudou desde a última aprovação/)).toBeNull();
  });

  it("409 (versão desatualizada) mostra o motivo do servidor e recarrega a lista", async () => {
    const user = userEvent.setup();
    const c = conexao();
    vi.mocked(apiClient.patch).mockRejectedValue(
      new ApiError(
        409,
        "state_conflict",
        undefined,
        "req-1",
        "A lista de ferramentas mudou desde que você abriu a tela. Recarregue e aprove de novo.",
      ),
    );
    vi.mocked(apiClient.get).mockResolvedValue({ data: { conexoes: [c] } });
    montar([c]);

    const linha = screen.getByText("listar_leads").closest("li")!;
    await user.click(within(linha).getByRole("button", { name: "Só consulta" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "A lista de ferramentas mudou desde que você abriu a tela. Recarregue e aprove de novo.",
        expect.anything(),
      ),
    );
    // a query de conexões foi invalidada e recarregada (novo GET).
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
  });
});

describe("McpClient — sem permissão de escrita", () => {
  it("usuário que não é admin não vê os botões de escrita", () => {
    montar(
      [
        conexao({
          ferramentas: [ferramenta({ somente_leitura_confirmado: null })],
        }),
      ],
      { canWrite: false },
    );
    expect(screen.queryByRole("button", { name: "Conectar servidor MCP" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Atualizar ferramentas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Trocar chave" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Só consulta" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Altera dados" })).toBeNull();
    // a lista continua visível — é só a ESCRITA que some.
    expect(screen.getByText("listar_leads")).toBeInTheDocument();
  });
});
