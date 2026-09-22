"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { ConexaoPublica } from "@/lib/ai/mcp-externo/tipos";

const KEY = ["mcp-conexoes"];

export function useMcpConexoes(initial?: ConexaoPublica[]) {
  return useQuery({
    queryKey: KEY,
    ...(initial !== undefined ? { initialData: initial } : {}),
    queryFn: () =>
      apiClient
        .get<{ data: { conexoes: ConexaoPublica[] } }>("/api/v1/ai/mcp/conexoes")
        .then((r) => r.data.conexoes),
  });
}

export interface CriarConexaoInput {
  apelido: string;
  nome: string;
  url: string;
  cabecalho_nome?: string;
  cabecalho_valor?: string;
}

export function useCriarConexaoMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CriarConexaoInput) =>
      apiClient.post<{ data: { conexao: ConexaoPublica } }>("/api/v1/ai/mcp/conexoes", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export interface EditarConexaoInput {
  nome?: string;
  ativa?: boolean;
  cabecalho_nome?: string | null;
  cabecalho_valor?: string | null;
}

export function useEditarConexaoMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EditarConexaoInput }) =>
      apiClient.patch<{ data: { conexao: ConexaoPublica } }>(`/api/v1/ai/mcp/conexoes/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useAtualizarFerramentasMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ data: { conexao: ConexaoPublica } }>(`/api/v1/ai/mcp/conexoes/${id}/atualizar`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoverConexaoMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<{ data: { removida: boolean } }>(`/api/v1/ai/mcp/conexoes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export interface AprovarFerramentaInput {
  id: string;
  nome: string;
  aprovacao: boolean | null;
  /**
   * O `atualizada_em` que a TELA tinha na hora do clique (M1, auditoria da
   * Tarefa 11): sem ele a API não tem como saber se o admin está decidindo
   * em cima do cache que ele de fato viu. Ver `lib/ai/mcp-externo/conexoes.ts`.
   */
  versao: string;
}

export function useAprovarFerramentaMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, nome, aprovacao, versao }: AprovarFerramentaInput) =>
      apiClient.patch<{ data: { conexao: ConexaoPublica } }>(`/api/v1/ai/mcp/conexoes/${id}/ferramentas`, {
        nome,
        aprovacao,
        versao,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    // 409 (versão desatualizada ou corrida perdida): a mutação que falhou não
    // some do cache sozinha, e o admin ficaria aprovando de novo em cima do
    // MESMO cache velho que já causou o 409. Invalidar aqui força a tela a
    // buscar a linha atual antes da próxima tentativa.
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
