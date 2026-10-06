"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";

/** O script só é carregado por quem monta este componente: as telas de entrada. */
const SCRIPT_DO_TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/api.js";

interface OpcoesDoWidget {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
  "timeout-callback": () => void;
}

interface ApiDoTurnstile {
  render: (elemento: HTMLElement, opcoes: OpcoesDoWidget) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: ApiDoTurnstile;
  }
}

let carregamento: Promise<ApiDoTurnstile> | null = null;

function carregarTurnstile(): Promise<ApiDoTurnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!carregamento) {
    carregamento = new Promise<ApiDoTurnstile>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${SCRIPT_DO_TURNSTILE}?render=explicit`;
      script.async = true;
      script.defer = true;
      script.onload = () =>
        window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile ausente"));
      script.onerror = () => {
        // Bloqueio de rede ou de extensão: deixa a próxima montagem tentar de novo.
        carregamento = null;
        reject(new Error("falha ao carregar o turnstile"));
      };
      document.head.appendChild(script);
    });
  }
  return carregamento;
}

/**
 * Estado do captcha de um formulário.
 *
 * O token do Turnstile é de USO ÚNICO: depois de qualquer tentativa enviada ao
 * servidor, mesmo a que falhou, ele já foi gasto. `renovar()` descarta o token e
 * manda o widget gerar outro. `pronto` é o que libera o botão de enviar: sem chave
 * configurada o captcha nem existe e o formulário se comporta como sempre.
 */
export function useCaptcha(siteKey?: string | null) {
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const renovar = useCallback(() => {
    setToken(null);
    setResetKey((k) => k + 1);
  }, []);
  return {
    ativo: Boolean(siteKey),
    token,
    setToken,
    resetKey,
    renovar,
    pronto: !siteKey || token !== null,
  };
}

interface Props {
  siteKey: string;
  onToken: (token: string | null) => void;
  /** Cada mudança de valor manda o widget gerar um token novo. */
  resetKey: number;
}

export function TurnstileWidget({ siteKey, onToken, resetKey }: Props) {
  const t = useT();
  const ancora = useRef<HTMLDivElement>(null);
  const idDoWidget = useRef<string | null>(null);
  const aoReceberToken = useRef(onToken);
  const [falhouAoCarregar, setFalhouAoCarregar] = useState(false);

  useEffect(() => {
    aoReceberToken.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let cancelado = false;
    carregarTurnstile()
      .then((api) => {
        if (cancelado || !ancora.current) return;
        idDoWidget.current = api.render(ancora.current, {
          sitekey: siteKey,
          callback: (token) => aoReceberToken.current(token),
          "expired-callback": () => aoReceberToken.current(null),
          "error-callback": () => aoReceberToken.current(null),
          "timeout-callback": () => aoReceberToken.current(null),
        });
      })
      .catch(() => {
        if (!cancelado) setFalhouAoCarregar(true);
      });
    return () => {
      cancelado = true;
      if (idDoWidget.current && window.turnstile) window.turnstile.remove(idDoWidget.current);
      idDoWidget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || !idDoWidget.current || !window.turnstile) return;
    window.turnstile.reset(idDoWidget.current);
  }, [resetKey]);

  return (
    <div className="space-y-2">
      <div ref={ancora} data-testid="turnstile-widget" className="flex justify-center" />
      {falhouAoCarregar && (
        <p className="text-center text-xs text-destructive" role="alert">
          {t("Não foi possível carregar a verificação de segurança. Recarregue a página.")}
        </p>
      )}
    </div>
  );
}
