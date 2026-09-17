import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { fontesDoAppDaMeta } from "@/lib/channels/meta/app";
import { metaPodeReceber } from "@/lib/channels/meta/webhook";
import { nomeCurtoDaSessao } from "@/lib/channels/nome-da-sessao";
import { ConnectWhatsappClient } from "./_client";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function ConnectWhatsappPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");
  const idioma = user.idioma;

  // Receber pelo canal oficial exige DOIS segredos, não um — a regra e o porquê
  // moram em `lib/channels/meta/webhook.ts`, ao lado de quem os consome. Agora os
  // dois podem vir do BANCO (`platform_meta_app`, migration 0257) e não só do
  // `.env`: `fontesDoAppDaMeta()` devolve a fonte VENCEDORA, sem misturar as duas
  // — App Secret de um lado com verify token do outro é um app que não existe, e
  // esta tela diria que está tudo pronto.
  const oficialPodeReceber = metaPodeReceber(await fontesDoAppDaMeta());
  // Nada de canal nasce no SSR: quem grava a conexão é o formulário da forma
  // escolhida, e só depois de o outro lado responder. Ver `_client.tsx`.

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">{traduzir("Dê um telefone a ele", idioma)}</h2>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "É por este número que ele vai atender seus clientes. Tenha em mãos o endereço do seu servidor de WhatsApp e o token da instância.",
            idioma,
          )}
        </p>
      </header>
      <p className="text-sm text-muted-foreground">
        {traduzir("Novos canais começam em modo de teste. Após concluir a configuração, abra Conexões para autorizar seus números de teste ou liberar o público.", idioma)}
      </p>
      <ConnectWhatsappClient
        sessionName={nomeCurtoDaSessao(activeOrg.orgId)}
        oficialPodeReceber={oficialPodeReceber}
      />
    </div>
  );
}
