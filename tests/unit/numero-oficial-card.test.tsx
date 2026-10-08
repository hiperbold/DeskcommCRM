/**
 * D-174: o cartão do número na tela do canal oficial. O que se prova na tela: o botão de registrar só
 * existe no PENDING; o PIN gerado aparece UMA vez e some ao fechar (não volta a menos que se registre de
 * novo); a recusa da Meta aparece como texto, não como falha muda.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => getMock(...a), post: (...a: unknown[]) => postMock(...a) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: async () => undefined }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { NumeroOficialCard } from "@/components/connections/NumeroOficialCard";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NumeroOficialCard />
    </QueryClientProvider>,
  );
}

const pendente = {
  data: { disponivel: true, status: "PENDING", codeVerificationStatus: "VERIFIED", precisaRegistrar: true },
};

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});
afterEach(cleanup);

describe("NumeroOficialCard", () => {
  it("CONNECTED: mostra o estado e NÃO oferece registrar", async () => {
    getMock.mockResolvedValue({
      data: { disponivel: true, status: "CONNECTED", codeVerificationStatus: "VERIFIED", precisaRegistrar: false },
    });
    montar();
    await screen.findByText("CONNECTED");
    expect(screen.queryByText("Registrar número")).toBeNull();
  });

  it("⭐ PENDING sem PIN informado: registra, mostra o PIN gerado uma vez e some ao fechar", async () => {
    getMock.mockResolvedValue(pendente);
    postMock.mockResolvedValue({ data: { registrado: true, pin: "482913", pinGerado: true, codigo: null, erro: null } });
    montar();

    fireEvent.click(await screen.findByText("Registrar número"));
    await screen.findByText("482913");
    expect(postMock).toHaveBeenCalledWith("/api/v1/channels/official/registrar", {});

    fireEvent.click(screen.getByText("Já guardei"));
    await waitFor(() => expect(screen.queryByText("482913")).toBeNull());
  });

  it("PIN informado é enviado e NÃO reaparece na tela", async () => {
    getMock.mockResolvedValue(pendente);
    postMock.mockResolvedValue({ data: { registrado: true, pin: null, pinGerado: false, codigo: null, erro: null } });
    montar();

    fireEvent.change(await screen.findByLabelText("PIN de seis dígitos (opcional)"), { target: { value: "246810" } });
    fireEvent.click(screen.getByText("Registrar número"));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/channels/official/registrar", { pin: "246810" }),
    );
    await waitFor(() => expect(screen.queryByTestId("pin-gerado")).toBeNull());
    expect(screen.queryByText("246810")).toBeNull();
  });

  it("PIN informado incompleto trava o botão", async () => {
    getMock.mockResolvedValue(pendente);
    montar();
    fireEvent.change(await screen.findByLabelText("PIN de seis dígitos (opcional)"), { target: { value: "123" } });
    expect((screen.getByText("Registrar número") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a Meta recusa: o motivo aparece na tela", async () => {
    getMock.mockResolvedValue(pendente);
    postMock.mockResolvedValue({
      data: { registrado: false, pin: null, pinGerado: false, codigo: "pin_incorreto", erro: "O PIN não confere com o cadastrado." },
    });
    montar();
    fireEvent.click(await screen.findByText("Registrar número"));
    await screen.findByText("O PIN não confere com o cadastrado.");
    expect(screen.queryByTestId("pin-gerado")).toBeNull();
  });

  it("quem não é admin (403 da rota) não vê o cartão", async () => {
    getMock.mockRejectedValue(new Error("403"));
    const { container } = montar();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='numero-oficial']")).toBeNull();
  });
});
