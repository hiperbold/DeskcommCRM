/**
 * Fase F3, tarefa 9 (segunda parte) — o botão "Enviar convites" de `InviteForm`
 * recebe `bloqueio` (item "membros" da matriz do plano) e precisa desabilitar
 * com o motivo quando o bloqueio vale, sem tocar no resto do formulário.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const invite = vi.fn();
vi.mock("@/hooks/team/useInviteMembers", () => ({
  useInviteMembers: () => ({ mutateAsync: invite, isPending: false }),
}));

import { InviteForm } from "@/app/app/team/invite/_components/InviteForm";

afterEach(() => {
  cleanup();
  invite.mockReset();
});

describe("bloqueio do plano no botão «Enviar convites»", () => {
  it("com o bloqueio valendo, o botão fica desabilitado e mostra o motivo", () => {
    render(
      <InviteForm bloqueio={{ desabilitado: true, motivo: "5 de 5 membros do plano Starter" }} />,
    );

    const botao = screen.getByRole("button", { name: "Enviar convites" });
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("title", "5 de 5 membros do plano Starter");
    expect(screen.getByText("5 de 5 membros do plano Starter")).toBeInTheDocument();
  });

  it("sem a prop `bloqueio`, o botão continua habilitado como hoje", () => {
    render(<InviteForm />);

    const botao = screen.getByRole("button", { name: "Enviar convites" });
    expect(botao).toBeEnabled();
    expect(botao).not.toHaveAttribute("title");
  });
});
