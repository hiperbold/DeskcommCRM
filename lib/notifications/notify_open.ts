"use client";

import { useEffect } from "react";

/** Clique na bandeja: o SW manda `notify-open` se `WindowClient.navigate` não existir. */
export function useNotifyOpenFromServiceWorker(): void {
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMsg = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type !== "notify-open" || typeof data.href !== "string") return;
      // Compara a ORIGEM de verdade: `startsWith(origin)` aceitava
      // `https://crm.exemplo.com.br.evil.com` (D-135).
      let destino: URL;
      try {
        destino = new URL(data.href, window.location.origin);
      } catch {
        return;
      }
      if (destino.origin !== window.location.origin) return;
      window.location.assign(destino.href);
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);
}
