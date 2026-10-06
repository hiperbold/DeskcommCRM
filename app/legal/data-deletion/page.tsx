import type { Metadata } from "next";

import { nomeDoOperador, resolverOperador } from "@/lib/legal/operador";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Exclusão de dados" };

/**
 * "URL de instruções de exclusão de dados" que a Meta exige do app do WhatsApp
 * oficial. A Meta só aceita a URL se ela abrir sem login: por isso a rota está em
 * `PUBLIC_PATHS` (`lib/auth/public-paths.ts`) e, como as outras páginas legais,
 * resolve o operador com o client de sessão, caindo no texto padrão sem sessão.
 */
export default async function DataDeletionPage() {
  const op = await resolverOperador();
  const operador = nomeDoOperador(op);

  // Rota fora da árvore de `app/app/layout.tsx`: sem `IdiomaProvider`, então
  // resolve o idioma direto, como `legal/privacy/page.tsx`. Página pública:
  // pode ser lida sem sessão, por isso `user` é opcional.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Exclusão de dados")}</h1>
        <p className="text-muted-foreground">
          {t("Como pedir a exclusão dos dados tratados por esta instalação do")} {op.sistema}.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("1. O que esta página explica")}</h2>
        <p>
          {t(
            "Esta página explica como pedir a exclusão dos dados pessoais tratados por esta instalação, inclusive os que chegam pelo WhatsApp, pela API oficial da Meta. Quem responde por esses dados é",
          )}{" "}
          <strong>{operador}</strong>
          {op.cnpj ? ` (CNPJ ${op.cnpj})` : ""}.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("2. Como pedir")}</h2>
        <p>
          {op.dpoEmail ? (
            <>
              {t("Escreva para o encarregado de dados:")}{" "}
              <a className="underline underline-offset-2" href={`mailto:${op.dpoEmail}`}>
                {op.dpoEmail}
              </a>
              .
            </>
          ) : (
            <>
              {t(
                "O operador ainda não publicou um endereço de contato do encarregado de dados nesta instalação. Os pedidos devem ser feitos pelos canais de atendimento da própria organização.",
              )}
            </>
          )}
        </p>
        <p>
          {t(
            "Informe o telefone ou o e-mail usado na conversa, para confirmarmos que o pedido é do titular dos dados. A resposta vem em até 15 dias, como determina a LGPD.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("3. O que acontece com os seus dados")}</h2>
        <p>
          {t(
            "O pedido é atendido por anonimização: ela remove a identificação (nome, telefone, e-mail, conteúdo das conversas e arquivos) e preserva apenas o registro sem identificação. A anonimização",
          )}{" "}
          <strong>{t("não pode ser desfeita")}</strong>.
        </p>
        <p>
          {t(
            "Se quiser guardar uma cópia antes, peça também a exportação dos seus dados: ela reúne o que existe sobre você.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("4. O que pode ficar")}</h2>
        <p>
          {t(
            "Podem permanecer os registros que a lei obriga a guardar, como os de natureza fiscal e a prova de auditoria, pelo prazo legal.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("5. Empresas que conectaram um número")}</h2>
        <p>
          {t(
            "A empresa que conectou um número do WhatsApp pode desconectá-lo em Conexões, excluindo o canal. Isso apaga do sistema o token de acesso da Meta daquele número.",
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("6. Saiba mais")}</h2>
        <p>
          {t("O tratamento dos dados é descrito na")}{" "}
          <a className="underline underline-offset-2" href="/legal/privacy">
            {t("Política de Privacidade")}
          </a>
          .
        </p>
      </section>
    </>
  );
}
