/**
 * Fase F3, tarefa 9 (segunda parte) — o botão "Acrescentar etapa ao fim" de
 * `StagesSection` recebe `bloqueio` (item "etapas_por_funil" da matriz do
 * plano, POR FUNIL) e precisa desabilitar com o motivo quando o bloqueio vale.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { LEAD_STAGES } from "@/lib/agent-engine/agent/lead-state";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const criar = vi.fn();
const editar = vi.fn();
const arquivar = vi.fn();
vi.mock("@/hooks/pipelines/useStages", () => ({
  useCriarEtapa: () => ({ isPending: false, mutate: criar }),
  useEditarEtapa: () => ({ isPending: false, mutate: editar }),
  useArquivarEtapa: () => ({ isPending: false, mutate: arquivar }),
}));

const MAPEAMENTO_VAZIO = Object.fromEntries(LEAD_STAGES.map((passo) => [passo, null]));

vi.mock("@/hooks/pipelines/useAgentMapping", () => ({
  useAgentMapping: () => ({
    isError: false,
    isFetching: false,
    data: {
      etapas: [{ id: "etapa-1", name: "Novo", is_won: false, is_lost: false }],
      mapeamento: MAPEAMENTO_VAZIO,
    },
  }),
}));

import { StagesSection } from "@/app/app/settings/tenant/pipelines/_stages";

afterEach(() => {
  cleanup();
  criar.mockReset();
  editar.mockReset();
  arquivar.mockReset();
});

describe("bloqueio do plano no botão «Acrescentar etapa ao fim»", () => {
  it("com o bloqueio valendo, o botão fica desabilitado e mostra o motivo", () => {
    render(
      <StagesSection
        pipelineId="pipeline-1"
        ancoraMapeamento="mapeamento-pipeline-1"
        bloqueio={{ desabilitado: true, motivo: "5 de 5 etapas neste funil do plano Starter", suspensa: false }}
      />,
    );

    const botao = screen.getByTestId("nova-etapa");
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("title", "5 de 5 etapas neste funil do plano Starter");
    expect(screen.getByTestId("nova-etapa-bloqueio-motivo")).toHaveTextContent(
      "5 de 5 etapas neste funil do plano Starter",
    );
  });

  it("sem a prop `bloqueio`, o botão continua habilitado como hoje", () => {
    render(<StagesSection pipelineId="pipeline-1" ancoraMapeamento="mapeamento-pipeline-1" />);

    const botao = screen.getByTestId("nova-etapa");
    expect(botao).toBeEnabled();
    expect(botao).not.toHaveAttribute("title");
    expect(screen.queryByTestId("nova-etapa-bloqueio-motivo")).toBeNull();
  });
});
