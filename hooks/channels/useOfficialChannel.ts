"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface OfficialChannelState {
  channel_session_id?: string | null;
  connected: boolean;
  /** Existe token gravado? O token em si NUNCA volta — ver a rota. */
  hasToken: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  /** Base pública da API — usada no painel "Para integrar". */
  endpoint: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhook: {
    callbackUrl: string;
    verifyToken: string | null;
    /**
     * De onde vem o token que vale. `instalacao` = cadastrado na tela de
     * administração: existe, mas não volta num GET (foi mostrado uma vez, lá).
     * Opcional: ausente é lido como desconhecido, e a tela cai no aviso genérico.
     */
    verifyTokenOrigem?: "ambiente" | "instalacao" | null;
    /** Onde se cadastra o App da Meta — só para quem pode abrir a tela da instalação. */
    configurarEm?: string | null;
    fields: string[];
  } | null;
  /**
   * O que a instalação já fez SOZINHA com o webhook deste número (fatia F1 da #850):
   * a Meta foi apontada para o endereço desta sessão, ou ainda não.
   *
   * `registrado: false` NÃO é canal quebrado: ele envia normalmente; o que depende
   * disto é a ENTREGA. Nulo = banco sem a migration 0311 (a tela volta ao passo
   * manual, que é o estado anterior — e continua verdadeiro).
   */
  webhookRegistro: {
    registrado: boolean;
    url: string | null;
    erro: string | null;
    em: string | null;
  } | null;
}

export interface ConnectInput {
  phone_number_id: string;
  waba_id: string;
  token: string;
}

export interface RegistroDoWebhook {
  registrado: boolean;
  url: string | null;
  erro: string | null;
  em: string;
  callbackUrl: string;
}

export function useOfficialChannel() {
  return useQuery({
    queryKey: ["official-channel"],
    queryFn: async () => apiClient.get<{ data: OfficialChannelState }>("/api/v1/channels/official"),
    staleTime: 15_000,
  });
}

export function useConnectOfficialChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null } }>(
        "/api/v1/channels/official",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

/**
 * "Tentar de novo" o registro do webhook — sem pedir a credencial outra vez.
 *
 * A rota responde 200 mesmo quando a Meta recusa (o motivo vem em `erro`), e é de
 * propósito: aqui o que interessa é o MOTIVO na tela. Por isso não há toast de erro
 * genérico no sucesso — a invalidação recarrega o estado e o aviso âmbar com o motivo
 * fica onde o operador pode lê-lo, em vez de desaparecer em três segundos.
 */
export function useRegistrarWebhookOficial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: RegistroDoWebhook }>("/api/v1/channels/official/webhook", {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

export type EstadoDoNumeroNaMeta =
  | { disponivel: false; motivo: string }
  | {
      disponivel: true;
      /** `CONNECTED`, `PENDING`... como a Meta devolve. */
      status: string | null;
      codeVerificationStatus: string | null;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
      qualityRating: string | null;
      /** Verdadeiro no `PENDING`: verificado, mas nunca registrado. */
      precisaRegistrar: boolean;
    };

/** O estado do número lido AO VIVO na Meta (D-174). Só admin; a rota recusa os outros. */
export function useEstadoDoNumeroOficial(habilitado: boolean) {
  return useQuery({
    queryKey: ["official-channel", "numero"],
    queryFn: async () =>
      apiClient.get<{ data: EstadoDoNumeroNaMeta }>("/api/v1/channels/official/numero"),
    enabled: habilitado,
    staleTime: 15_000,
    retry: false,
  });
}

export interface ResultadoDoRegistroDoNumero {
  registrado: boolean;
  /** O PIN que o CRM gerou. Vem UMA vez, só neste retorno; `null` se o admin informou o dele. */
  pin: string | null;
  pinGerado: boolean;
  codigo: string | null;
  erro: string | null;
}

/**
 * Registra o número `PENDING` na Meta (D-174). Como o webhook, a recusa da Meta volta como 200 com o
 * motivo em `erro`, e a tela o mostra; por isso não há toast de erro genérico no sucesso.
 */
export function useRegistrarNumeroOficial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { pin?: string }) =>
      apiClient.post<{ data: ResultadoDoRegistroDoNumero }>("/api/v1/channels/official/registrar", input),
    // A resposta carrega o PIN gerado: a mutação não pode ficar retida no cache (padrão: 5 minutos).
    gcTime: 0,
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}
