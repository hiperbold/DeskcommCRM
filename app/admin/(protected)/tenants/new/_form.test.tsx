import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { NewTenantForm } from "./_form";

/**
 * Tarefa 6, fase F1 dos planos de assinatura: o seletor de "Plano" saiu da
 * criação de organização (hiperbold/planos/fase-F1-tarefas.md, decisão de
 * desenho 12). Toda organização nova nasce no plano Ilimitado pelo gatilho do
 * banco, nada aqui escolhe plano nenhum.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

function renderForm() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NewTenantForm />
    </QueryClientProvider>,
  );
}

describe("NewTenantForm não oferece mais o seletor de Plano", () => {
  it("não renderiza rótulo nem combobox de Plano", () => {
    renderForm();
    expect(screen.queryByText("Plano")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Plano" })).toBeNull();
  });

  it("segue oferecendo os demais campos da organização", () => {
    renderForm();
    expect(screen.getByLabelText(/Nome de exibição/)).toBeTruthy();
    expect(screen.getByText("Slug")).toBeTruthy();
    expect(screen.getByLabelText(/E-mail do responsável/)).toBeTruthy();
  });
});
