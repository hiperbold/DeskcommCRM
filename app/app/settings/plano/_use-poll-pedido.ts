"use client";

/**
 * Consulta `GET /api/v1/billing/pedidos/[id]` a cada 5 segundos, por até 10
 * minutos, ou até um estado final (fase F5, Tarefas 20 e 21). A decisão de
 * QUANDO parar é pura e testada à parte (`devePararDePollarPedido`, em
 * `_logica-compra.ts`); este hook só é o cano que chama a rota e reagenda.
 *
 * A rota já filtra pela organização da sessão (Tarefa 15): um `id` de outro
 * pedido, ou de outra organização, cai no mesmo 404, e este hook trata isso
 * como falha de leitura, nunca como pedido pago ou cancelado.
 */
import { useEffect, useRef, useState } from "react";

import { devePararDePollarPedido, INTERVALO_DE_POLLING_MS } from "./_logica-compra";

export interface EstadoDoPollingDePedido {
  status: string | null;
  tipo: string | null;
  url: string | null;
  parou: boolean;
  erro: boolean;
}

interface RespostaDoPedido {
  data?: { status: string; tipo: string; url: string | null };
}

export function usePollDoPedido(pedidoId: string, statusInicial: string | null = null): EstadoDoPollingDePedido {
  const [estado, setEstado] = useState<EstadoDoPollingDePedido>(() => ({
    status: statusInicial,
    tipo: null,
    url: null,
    parou: statusInicial !== null && devePararDePollarPedido(statusInicial, 0),
    erro: false,
  }));
  // `Date.now()` é impuro: não pode ser chamado durante o render (regra
  // `react-hooks/purity`). O relógio começa a contar dentro do EFEITO
  // abaixo, que roda depois do commit, na mesma ordem em que os hooks foram
  // declarados, antes do efeito de polling, que é quem lê `inicioRef`.
  const inicioRef = useRef<number | null>(null);
  useEffect(() => {
    inicioRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (estado.parou) return;

    let cancelado = false;
    let id: ReturnType<typeof setInterval> | null = null;

    function decorridoDesdeInicio(): number {
      return inicioRef.current === null ? 0 : Date.now() - inicioRef.current;
    }

    async function consultar() {
      try {
        const resposta = await fetch(`/api/v1/billing/pedidos/${pedidoId}`, { cache: "no-store" });
        if (!resposta.ok) throw new Error(String(resposta.status));
        const corpo = (await resposta.json()) as RespostaDoPedido;
        if (cancelado || !corpo.data) return;
        const parar = devePararDePollarPedido(corpo.data.status, decorridoDesdeInicio());
        setEstado({ status: corpo.data.status, tipo: corpo.data.tipo, url: corpo.data.url, parou: parar, erro: false });
        if (parar && id !== null) clearInterval(id);
      } catch {
        if (!cancelado) setEstado((atual) => ({ ...atual, erro: true }));
      }
    }

    void consultar();
    id = setInterval(() => {
      if (devePararDePollarPedido(null, decorridoDesdeInicio())) {
        setEstado((atual) => ({ ...atual, parou: true }));
        if (id !== null) clearInterval(id);
        return;
      }
      void consultar();
    }, INTERVALO_DE_POLLING_MS);

    return () => {
      cancelado = true;
      if (id !== null) clearInterval(id);
    };
  }, [pedidoId, estado.parou]);

  return estado;
}
