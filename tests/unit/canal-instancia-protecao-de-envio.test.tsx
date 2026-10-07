/**
 * Proteção de envio (anti-ban) nos cartões da API não oficial.
 *
 * A ficha só era montada pela lista de números por QR; quando a aba saiu
 * (be97dd61f) os canais por instância ficaram sem onde editar os limites de
 * envio. Estes testes provam o comportamento pela tela: o botão aparece no
 * cartão de cada conexão, abre a ficha DAQUELA conexão, e o papel decide se a
 * ficha edita (`manager` para cima, o piso de `PUT /api/v1/ai/pacing`), só lê, ou
 * nem é oferecida (wizard de onboarding).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import type { PacingKnobsItem } from "@/hooks/channels/usePacingKnobs";

const getMock = vi.fn();
const putMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: vi.fn(),
    put: (...a: unknown[]) => putMock(...a),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { CanalInstanciaClient } from "@/components/connections/CanalInstanciaClient";

const KNOBS: PacingKnobs = {
  throttleMs: 1_200,
  jitterMaxMs: 800,
  windowStartHour: 7,
  windowEndHour: 22,
  allowSunday: true,
  timezone: "America/Sao_Paulo",
  warmupDailyCaps: [
    { minAgeDays: 0, cap: 20 },
    { minAgeDays: 7, cap: 60 },
    { minAgeDays: 30, cap: null },
  ],
};

function itemDePacing(id: string, nome: string): PacingKnobsItem {
  return {
    channel_session: {
      id,
      waha_session_name: null,
      display_name: nome,
      phone_number: null,
      status: "WORKING",
      daily_message_limit: null,
    },
    effective: KNOBS,
    warmup: { number_activated_at: null, age_days: 0, skipped: false, cap_today: 20 },
    overrides: null,
    defaults: KNOBS,
    bounds: {
      intervalMaxMs: 600_000,
      hourLastStart: 23,
      hourEnd: 24,
      daily_limit: { min: 1, max: 2_000 },
    },
  };
}

const CONEXOES = [
  {
    id: "canal-a",
    display_name: "Comercial",
    phone_number: "5511999990001",
    status: "WORKING",
    servidor: "https://uazapi.exemplo.test",
    webhook_registrado: true,
  },
  {
    id: "canal-b",
    display_name: "Suporte",
    phone_number: "5511999990002",
    status: "WORKING",
    servidor: "https://uazapi.exemplo.test",
    webhook_registrado: true,
  },
];

function cliente() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function tela(props: { podeEditarProtecao?: boolean }) {
  return (
    <QueryClientProvider client={cliente()}>
      <CanalInstanciaClient {...props} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset();
  getMock.mockImplementation((url: string) => {
    if (url === "/api/v1/channels/instancia") {
      return Promise.resolve({ data: { label: "API não oficial", conexoes: CONEXOES } });
    }
    if (url === "/api/v1/ai/pacing") {
      return Promise.resolve({
        data: {
          items: [itemDePacing("canal-a", "Comercial"), itemDePacing("canal-b", "Suporte")],
        },
      });
    }
    return Promise.reject(new Error(`rota não prevista no teste: ${url}`));
  });
  putMock.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe("CanalInstanciaClient: Proteção de envio", () => {
  it("cada cartão de conexão tem o botão, e ele abre a ficha DAQUELA conexão", async () => {
    render(tela({ podeEditarProtecao: true }));

    const botoes = await screen.findAllByRole("button", { name: /Proteção de envio/ });
    expect(botoes).toHaveLength(2);

    fireEvent.click(botoes[1]!);

    expect(await screen.findByTestId("anti-ban-form")).toBeInTheDocument();
    expect(screen.getByText(/Proteção de envio —/)).toHaveTextContent("Suporte");
  });

  it("quem pode editar (manager para cima) salva pela mesma rota da ficha antiga", async () => {
    render(tela({ podeEditarProtecao: true }));

    fireEvent.click((await screen.findAllByRole("button", { name: /Proteção de envio/ }))[0]!);
    fireEvent.click(await screen.findByTestId("anti-ban-save"));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [rota, corpo] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(rota).toBe("/api/v1/ai/pacing");
    expect(corpo.channel_session_id).toBe("canal-a");
  });

  it("papel abaixo do piso: a ficha abre só para ler, sem Salvar e com os campos travados", async () => {
    render(tela({ podeEditarProtecao: false }));

    fireEvent.click((await screen.findAllByRole("button", { name: /Proteção de envio/ }))[0]!);

    expect(await screen.findByTestId("anti-ban-form")).toBeInTheDocument();
    expect(screen.queryByTestId("anti-ban-save")).toBeNull();
    expect(screen.getByLabelText("Teto diário de mensagens")).toBeDisabled();
    expect(screen.getByLabelText("Hora de início da janela")).toBeDisabled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it("sem a prop (wizard de onboarding) a ficha não é oferecida nem consultada", async () => {
    render(tela({}));

    // Espera o cartão da conexão aparecer para o "não há botão" não ser pressa.
    await screen.findByText("Comercial");
    expect(screen.queryByRole("button", { name: /Proteção de envio/ })).toBeNull();
    expect(getMock).not.toHaveBeenCalledWith("/api/v1/ai/pacing");
  });

  it("sem conexões não há botão nem consulta de proteção", async () => {
    getMock.mockImplementation((url: string) =>
      url === "/api/v1/channels/instancia"
        ? Promise.resolve({ data: { label: "API não oficial", conexoes: [] } })
        : Promise.reject(new Error(`rota não prevista no teste: ${url}`)),
    );
    render(tela({ podeEditarProtecao: true }));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/channels/instancia"));
    expect(screen.queryByRole("button", { name: /Proteção de envio/ })).toBeNull();
    expect(getMock).not.toHaveBeenCalledWith("/api/v1/ai/pacing");
  });
});
