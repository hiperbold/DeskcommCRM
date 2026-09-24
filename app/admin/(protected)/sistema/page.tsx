import Link from "next/link";
import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import {
  organizacoesAtrasadasESuspensas,
  ultimoDiaDoPeriodo,
} from "@/lib/billing/assinatura/estado-da-assinatura";
import { carregarBloqueioDosPlanos } from "@/lib/billing/planos/bloqueio-da-instalacao";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
  FormularioDeBloqueioDosPlanos,
  FormularioDeCadastroDePacotes,
  FormularioDeComportamento,
  FormularioDeModulos,
} from "./_form";

export const metadata = { title: "Comportamento da instalação" };
export const dynamic = "force-dynamic";

/**
 * `current_period_end`/`dataPrevistaDaSuspensao` são sempre 00:00 em
 * America/Sao_Paulo (migração 0908, decisão 2; comentário de
 * `ultimoDiaDoPeriodo` em `lib/billing/assinatura/estado-da-assinatura.ts`).
 * Fixar o fuso aqui evita que a data mostrada dependa do fuso do SERVIDOR.
 */
const FUSO_SP = "America/Sao_Paulo";

/**
 * A tela onde o dono da instalação decide COMO ela se comporta, sem SSH.
 *
 * ── O defeito que ela fecha (issue #1034) ───────────────────────────────────
 *
 * As chaves que decidem o comportamento de uma instalação JÁ EM OPERAÇÃO — o
 * kill switch do orçamento de IA, a exigência de assinatura no webhook do
 * canal, o modo do portão de divulgação e a camada semântica de promessa — só
 * existiam no `.env`: quem instalou a VPS era o único que conseguia mudá-las,
 * por SSH. É a decisão de produto escondida atrás de infraestrutura.
 *
 * ── Por que `/admin`, e não `/app/settings` ─────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO inteira, não uma empresa. Num revendedor que hospeda
 * várias organizações, deixar o admin de um tenant desligar o bloqueio de gasto
 * mudaria o comportamento de TODOS os clientes daquele servidor. Mesmo
 * argumento de `/admin/cadastro`, `/admin/marca` e `/admin/google` — esta tela
 * é irmã das três, e usa o mesmo `traduzir`/`_form` das irmãs.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ──────────────────────────
 *
 * Para quem não administra a instalação, esta tela não faz parte do produto. O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo
 * é redundante HOJE; ele fica porque a garantia precisa ser local, e um layout
 * pode ser movido. Mesma decisão, mesma frase, de `/admin/cadastro`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const admin = createAdminClient();
  const t = (texto: string) => traduzir(texto, usuario.idioma);
  const tagDoIdioma = tagDeIdioma(usuario.idioma);

  // O valor EFETIVO (linha acima, `.env` como piso): a tela mostra o que está
  // valendo de verdade, e não o que a linha diria se ela existisse.
  const [comportamento, ligados, bloqueio, atrasadasESuspensas, pacotesRes] = await Promise.all([
    carregarComportamentoDaInstalacao(),
    modulosLigados(admin),
    carregarBloqueioDosPlanos(admin),
    // Fase F4, tarefa 8, decisão 9: a lista de atrasadas e suspensas na tela
    // da instalação.
    organizacoesAtrasadasESuspensas(admin),
    // Fase F4, tarefa 8, decisão 10: o catálogo INTEIRO (ativo e inativo) para
    // o cadastro simples de pacotes desta tela poder desativar.
    admin
      .from("billing_token_pacotes")
      .select("id, codigo, nome, tokens, preco_cents, ativo")
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Comportamento desta instalação", usuario.idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Como esta instalação se comporta em operação. Vale para todas as empresas hospedadas aqui.",
            usuario.idioma,
          )}
        </p>
        <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin/sistema/cobranca">{t("Cobrança (Asaas)")}</Link>
      </div>
      <FormularioDeComportamento inicial={comportamento} />
      <FormularioDeBloqueioDosPlanos inicial={bloqueio} />

      {/* Fase F4, tarefa 8, decisão 9: organizações atrasadas e suspensas. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Organizações atrasadas e suspensas")}</CardTitle>
        </CardHeader>
        <CardContent>
          {atrasadasESuspensas.leituraFalhou ? (
            <p className="text-sm text-destructive">
              {t("Não foi possível ler as organizações atrasadas e suspensas agora.")}
            </p>
          ) : atrasadasESuspensas.organizacoes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Nenhuma organização atrasada ou suspensa no momento.")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Organização")}</TableHead>
                  <TableHead>{t("Estado")}</TableHead>
                  <TableHead>{t("Fim do período")}</TableHead>
                  <TableHead>{t("Data prevista do modo leitura")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {atrasadasESuspensas.organizacoes.map((org) => (
                  <TableRow key={org.organizationId}>
                    <TableCell className="font-medium">{org.nome}</TableCell>
                    <TableCell>
                      <Badge variant={org.status === "suspensa" ? "error" : "warning"}>
                        {org.status === "suspensa" ? t("Suspensa") : t("Atrasada")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {org.currentPeriodEnd
                        ? ultimoDiaDoPeriodo(org.currentPeriodEnd).toLocaleDateString(tagDoIdioma, {
                            timeZone: FUSO_SP,
                          })
                        : "-"}
                    </TableCell>
                    <TableCell>
                      {org.dataPrevistaDaSuspensao
                        ? new Date(org.dataPrevistaDaSuspensao).toLocaleDateString(tagDoIdioma, {
                            timeZone: FUSO_SP,
                          })
                        : "-"}
                    </TableCell>
                    <TableCell>
                      <Link
                        className="text-sm text-primary underline-offset-4 hover:underline"
                        href={`/admin/tenants/${org.organizationId}/plano`}
                      >
                        {t("Ver plano")}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <FormularioDeCadastroDePacotes
        pacotes={(pacotesRes.data ?? []) as {
          id: string;
          codigo: string;
          nome: string;
          tokens: number;
          preco_cents: number | null;
          ativo: boolean;
        }[]}
        leituraFalhou={Boolean(pacotesRes.error)}
      />

      <FormularioDeModulos ligados={ligados} />
    </div>
  );
}
