"use client";

import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";

/** Para onde a recusa do limite de Conexões manda quem pode mudar de plano (a tela de assinar). */
const CAMINHO_PARA_ASSINAR = "/app/settings/plano/assinar";

/**
 * O motivo de um botão de nova conexão desabilitado pelo limite de Conexões do plano, com o caminho para mudar
 * de plano (D-188). O texto vem pronto do servidor (já com o limite, o plano e o idioma); aqui só se acrescenta
 * o link. Estas telas são de administrador, o mesmo papel que a tela de assinar exige.
 */
export function AvisoDeLimiteDeConexoes({
  motivo,
  className = "mt-1.5 text-xs text-destructive",
}: {
  motivo: string | null | undefined;
  className?: string;
}) {
  const t = useT();
  return (
    <p className={className} data-testid="aviso-limite-de-conexoes">
      {motivo}{" "}
      <Link href={CAMINHO_PARA_ASSINAR} className="font-medium underline underline-offset-2">
        {t("Ver planos")}
      </Link>
    </p>
  );
}
