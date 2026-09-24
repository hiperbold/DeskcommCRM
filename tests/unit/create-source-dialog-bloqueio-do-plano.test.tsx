/**
 * Fase F3, tarefa 9 (segunda parte) — o botão "Criar fonte" de
 * `CreateSourceDialog` recebe `bloqueio` (item "integracoes_webhook" da matriz
 * do plano) e precisa desabilitar com o motivo quando o bloqueio vale.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const create = vi.fn();
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useCreateWebhookSource: () => ({ mutateAsync: create, isPending: false }),
  usePipelines: () => ({ data: { data: [{ id: "p1", name: "Comercial" }] }, isLoading: false }),
  usePipelineStages: () => ({
    data: { data: { stages: [{ id: "s1", name: "Novo" }] } },
    isLoading: false,
  }),
}));

import { CreateSourceDialog } from "@/app/app/webhooks/_components/CreateSourceDialog";

afterEach(() => {
  cleanup();
  create.mockReset();
});

describe("bloqueio do plano no botão «Criar fonte»", () => {
  it("com o bloqueio valendo, o botão fica desabilitado e mostra o motivo", () => {
    render(
      <CreateSourceDialog
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
        bloqueio={{ desabilitado: true, motivo: "2 de 2 integrações de webhook do plano Starter" }}
      />,
    );

    const botao = screen.getByRole("button", { name: "Criar fonte" });
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("title", "2 de 2 integrações de webhook do plano Starter");
    expect(
      screen.getByText("2 de 2 integrações de webhook do plano Starter"),
    ).toBeInTheDocument();
  });

  it("sem a prop `bloqueio`, o botão continua habilitado como hoje", () => {
    render(<CreateSourceDialog open onOpenChange={() => {}} onCreated={() => {}} />);

    const botao = screen.getByRole("button", { name: "Criar fonte" });
    expect(botao).toBeEnabled();
    expect(botao).not.toHaveAttribute("title");
  });
});
