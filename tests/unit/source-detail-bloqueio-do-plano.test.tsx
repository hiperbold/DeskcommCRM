/**
 * Fase F3, tarefa 9 (segunda parte) — em `SourceDetail`, o bloqueio só trava
 * LIGAR uma fonte pausada (pausar não conta contra o teto — ver o comentário
 * da prop no próprio componente).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

const update = vi.fn();
const del = vi.fn();
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useUpdateWebhookSource: () => ({ mutate: update, isPending: false }),
  useDeleteWebhookSource: () => ({ mutateAsync: del }),
  useWebhookSourceEvents: () => ({ data: { data: [] }, refetch: vi.fn() }),
}));

import { SourceDetail } from "@/app/app/webhooks/_components/SourceDetail";

const FONTE_PAUSADA = {
  id: "src-1",
  organization_id: "org-1",
  name: "Landing page",
  path_token: "tok123",
  is_active: false,
  kind: "form",
  last_received_at: null,
  default_pipeline_id: "p1",
  default_stage_id: "s1",
  redirect_to: null,
  field_map: {},
  has_secret: false,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

afterEach(() => {
  cleanup();
  update.mockReset();
  del.mockReset();
});

describe("bloqueio do plano ao ligar uma fonte pausada", () => {
  it("com o bloqueio valendo, o interruptor fica desabilitado e mostra o motivo", () => {
    render(
      <SourceDetail
        source={FONTE_PAUSADA}
        open
        onOpenChange={() => {}}
        bloqueio={{ desabilitado: true, motivo: "2 de 2 integrações de webhook do plano Starter" }}
      />,
    );

    const interruptor = screen.getByRole("switch");
    expect(interruptor).toBeDisabled();
    expect(interruptor).toHaveAttribute("title", "2 de 2 integrações de webhook do plano Starter");
    expect(
      screen.getByText("2 de 2 integrações de webhook do plano Starter"),
    ).toBeInTheDocument();
  });

  it("sem a prop `bloqueio`, o interruptor continua habilitado como hoje", () => {
    render(<SourceDetail source={FONTE_PAUSADA} open onOpenChange={() => {}} />);

    const interruptor = screen.getByRole("switch");
    expect(interruptor).toBeEnabled();
    expect(interruptor).not.toHaveAttribute("title");
    expect(screen.getByText("Pausada, ela para de aceitar novos envios.")).toBeInTheDocument();
  });
});
