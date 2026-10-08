"use client";

/**
 * Peças que o passo a passo do plano (`_passo-a-passo.tsx`) e a compra de pacote (`_client.tsx`) dividem:
 * o valor em reais, o aceite dos Termos de Uso (D-133) e o formulário de quem paga (decisão 16, nunca
 * guardado no navegador). Saíram de `_client.tsx` sem mudar uma linha de comportamento (D-180).
 */
import Link from "next/link";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

import type { CamposDoFormularioDoPagador } from "../_logica-compra";

export const CAMPOS_VAZIOS: CamposDoFormularioDoPagador = { nome: "", documento: "", email: "", celular: "" };

export function formatarReais(centavos: number, tagDoIdioma: string): string {
  return (centavos / 100).toLocaleString(tagDoIdioma, { style: "currency", currency: "BRL" });
}

/** D-133: o aceite obrigatório dos Termos de Uso, em cada fluxo de compra. */
export function AceiteDosTermos({ id, aceito, onChange }: { id: string; aceito: boolean; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={aceito}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
        required
      />
      <span>
        {t("Li e aceito os")}{" "}
        <Link className="underline" href="/legal/terms" target="_blank" rel="noreferrer">
          {t("Termos de Uso")}
        </Link>
        .
      </span>
    </label>
  );
}

// ─── Formulário do pagador (decisão 16): nunca guardado no navegador ───────

export function FormularioDoPagador({
  pagador,
  onChange,
  idPrefixo,
}: {
  pagador: CamposDoFormularioDoPagador;
  onChange: (pagador: CamposDoFormularioDoPagador) => void;
  idPrefixo: string;
}) {
  const t = useT();
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm font-medium">{t("Dados de quem paga")}</p>
      <p className="text-xs text-muted-foreground">
        {t("Só usados para emitir a cobrança no Asaas. Não ficam guardados neste sistema.")}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-nome`}>{t("Nome completo")}</Label>
        <Input
          id={`${idPrefixo}-nome`}
          value={pagador.nome}
          onChange={(e) => onChange({ ...pagador, nome: e.target.value })}
          maxLength={200}
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-documento`}>{t("CPF ou CNPJ")}</Label>
        <Input
          id={`${idPrefixo}-documento`}
          value={pagador.documento}
          onChange={(e) => onChange({ ...pagador, documento: e.target.value })}
          maxLength={20}
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-email`}>{t("E-mail (opcional)")}</Label>
        <Input
          id={`${idPrefixo}-email`}
          type="email"
          value={pagador.email}
          onChange={(e) => onChange({ ...pagador, email: e.target.value })}
          maxLength={200}
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefixo}-celular`}>{t("Celular (opcional)")}</Label>
        <Input
          id={`${idPrefixo}-celular`}
          value={pagador.celular}
          onChange={(e) => onChange({ ...pagador, celular: e.target.value })}
          maxLength={20}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
