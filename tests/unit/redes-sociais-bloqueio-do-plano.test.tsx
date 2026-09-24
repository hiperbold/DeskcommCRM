/**
 * Fase F3, tarefa 9 (segunda parte) — em `RedesSociaisClient`, "Autorizar
 * conta" nunca cria `channel_sessions` (só devolve a URL de OAuth); quem cria é
 * "Receber no atendimento", e só quando a conta ainda não tem `account.channel`
 * — por isso só esse botão, por conta, recebe `bloqueio` (item "conexoes").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/connections/ChannelAiAccess", () => ({ ChannelAiAccess: () => null }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

import { RedesSociaisClient } from "@/components/connections/RedesSociaisClient";

const ESTADO = {
  data: {
    label: "conectado",
    configured: true,
    networks: [{ id: "instagram", label: "Instagram", inbox: true }],
    accounts: [
      {
        id: "acc-1",
        platform: "instagram",
        username: "@empresa",
        active: true,
        inbox_supported: true,
        channel: null,
      },
    ],
  },
};

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe("bloqueio do plano no botão «Receber no atendimento»", () => {
  it("com o bloqueio valendo, o botão fica desabilitado e mostra o motivo", async () => {
    getMock.mockResolvedValue(ESTADO);
    render(
      comQuery(
        <RedesSociaisClient bloqueio={{ desabilitado: true, motivo: "3 de 3 conexões do plano Starter" }} />,
      ),
    );

    const botao = await screen.findByRole("button", { name: "Receber no atendimento" });
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("title", "3 de 3 conexões do plano Starter");
    expect(screen.getByText("3 de 3 conexões do plano Starter")).toBeInTheDocument();
  });

  it("sem a prop `bloqueio`, o botão continua habilitado como hoje", async () => {
    getMock.mockResolvedValue(ESTADO);
    render(comQuery(<RedesSociaisClient />));

    const botao = await screen.findByRole("button", { name: "Receber no atendimento" });
    expect(botao).toBeEnabled();
    expect(botao).not.toHaveAttribute("title");
  });
});
