/**
 * D-174, achado 5: o PIN que o CRM gera no registro do número é mostrado UMA vez e não fica em cache. A
 * mutação do React Query guarda o `data` da resposta pelo `gcTime` (5 minutos por padrão), e o PIN viaja nessa
 * resposta. O comentário do cartão já prometia "nem cache de consulta"; aqui a promessa é medida no cache de
 * mutações do próprio React Query.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => getMock(...a), post: (...a: unknown[]) => postMock(...a) },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: async () => undefined }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { NumeroOficialCard } from "@/components/connections/NumeroOficialCard";
import { useRegistrarNumeroOficial } from "@/hooks/channels/useOfficialChannel";

const PIN = "482913";

function novoCliente() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Tudo o que o cache de mutações guarda, em texto: se o PIN estiver lá, aparece aqui. */
function oQueOCacheDeMutacoesGuarda(qc: QueryClient): string {
  return JSON.stringify(qc.getMutationCache().getAll().map((m) => ({ estado: m.state, opcoes: m.options.gcTime })));
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  postMock.mockResolvedValue({ data: { registrado: true, pin: PIN, pinGerado: true, codigo: null, erro: null } });
});
afterEach(cleanup);

describe("useRegistrarNumeroOficial", () => {
  it("⭐ a mutação não é retida: sem quem a observe, sai do cache na hora (gcTime 0)", async () => {
    const qc = novoCliente();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useRegistrarNumeroOficial(), { wrapper });

    let r: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      r = await result.current.mutateAsync({});
    });
    expect(r?.data.pin).toBe(PIN);

    unmount();
    // Com o gcTime padrão (5 min) a mutação, e o PIN dentro dela, ficaria no cache. Com 0 ela some.
    await waitFor(() => expect(qc.getMutationCache().getAll()).toHaveLength(0));
    expect(oQueOCacheDeMutacoesGuarda(qc)).not.toContain(PIN);
  });
});

describe("NumeroOficialCard: o PIN mostrado não sobra no cache de mutações", () => {
  it("⭐ depois de registrar, o PIN está na tela e NÃO está no cache do React Query", async () => {
    getMock.mockResolvedValue({
      data: { disponivel: true, status: "PENDING", codeVerificationStatus: "VERIFIED", precisaRegistrar: true },
    });
    const qc = novoCliente();
    render(
      <QueryClientProvider client={qc}>
        <NumeroOficialCard />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByText("Registrar número"));
    await screen.findByText(PIN);

    await waitFor(() => expect(oQueOCacheDeMutacoesGuarda(qc)).not.toContain(PIN));
    // E o PIN segue na tela (o cartão guarda no estado local, não depende do cache).
    expect(screen.getByText(PIN)).toBeTruthy();
  });
});
