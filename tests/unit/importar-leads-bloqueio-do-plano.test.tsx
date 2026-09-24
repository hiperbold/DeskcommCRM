/**
 * Fase F3, tarefa 9 (segunda parte) — o botão "Escolher o arquivo CSV" de
 * `ImportarLeads` recebe `bloqueio` (item "leads" da matriz do plano) e precisa
 * desabilitar com o motivo quando o bloqueio vale, sem tocar no resto do fluxo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ImportarLeads } from "@/app/app/kanban/_components/ImportarLeads";
import type { FunilDaLista } from "@/app/app/kanban/_client";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// A tela não chama a rota nestes casos (o clique fica no botão desabilitado, ou
// abre só o seletor de arquivo), mas o `fetch` global segue definido para não
// quebrar caso algum teste futuro dispare o envio por engano.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const FUNIS: FunilDaLista[] = [
  { id: "f1", name: "Comercial", slug: "comercial", description: null, position: 1, is_default: true },
];

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe("bloqueio do plano no botão de importar", () => {
  it("com o bloqueio valendo, o botão fica desabilitado e mostra o motivo", async () => {
    const user = userEvent.setup();
    render(
      <ImportarLeads
        funis={FUNIS}
        bloqueio={{ desabilitado: true, motivo: "3 de 3 leads do plano Starter" }}
      />,
    );

    await user.click(screen.getByTestId("abrir-importar-leads"));

    const botao = screen.getByTestId("escolher-planilha");
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("title", "3 de 3 leads do plano Starter");
    expect(screen.getByTestId("importar-leads-bloqueio-motivo")).toHaveTextContent(
      "3 de 3 leads do plano Starter",
    );
  });

  it("sem a prop `bloqueio`, o botão continua habilitado como hoje", async () => {
    const user = userEvent.setup();
    render(<ImportarLeads funis={FUNIS} />);

    await user.click(screen.getByTestId("abrir-importar-leads"));

    const botao = screen.getByTestId("escolher-planilha");
    expect(botao).toBeEnabled();
    expect(botao).not.toHaveAttribute("title");
    expect(screen.queryByTestId("importar-leads-bloqueio-motivo")).toBeNull();
  });
});
