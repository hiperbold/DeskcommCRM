"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantOrganization {
  id: string;
  slug: string;
  display_name: string;
  legal_name: string | null;
  cnpj: string | null;
  // 'onboarding' não existe na check constraint do banco — é estado derivado
  // (active + onboarded_at null), nunca vem numa linha real.
  status: "active" | "suspended" | "redacted";
  onboarded_at: string | null;
  suspended_at: string | null;
  created_at: string;
  settings: Record<string, unknown> | null;
}

export interface TenantCounts {
  user_count: number;
  conversations_count: number;
  messages_count: number;
  leads_count: number;
  orders_count: number;
  lgpd_requests_pending: number;
  ai_invocations_30d: number;
  waha_sessions_count: number;
}

export interface TenantIntegrations {
  nuvemshop_status: string | null;
  nuvemshop_connected_at: string | null;
}

/**
 * O plano do contrato (`billing_contracts`), lido por `planoDaOrganizacao`.
 * Substitui `organizations.settings.plan` como fonte de "Plano" na Visão
 * Geral desde a Tarefa 6 da fase F1 dos planos de assinatura.
 */
export interface TenantPlano {
  name: string;
  leituraFalhou: boolean;
}

export interface TenantDetailResponse {
  data: {
    organization: TenantOrganization;
    counts: TenantCounts;
    integrations: TenantIntegrations;
    plano: TenantPlano;
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTenantDetail(id: string) {
  return useQuery({
    queryKey: ["admin", "tenant", id] as const,
    queryFn: () =>
      apiClient.get<TenantDetailResponse>(`/api/v1/admin/tenants/${id}`),
    staleTime: 60_000,
    enabled: !!id,
  });
}
