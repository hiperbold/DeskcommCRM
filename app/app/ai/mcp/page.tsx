import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { listarConexoes } from "@/lib/ai/mcp-externo/conexoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { McpClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Guarda em `admin`, não `manager`: a rota que esta tela consulta
 * (`GET /api/v1/ai/mcp/conexoes`) já exige `admin` mesmo pra LISTAR — achado
 * da auditoria da Tarefa 6, porque a conexão expõe endereço, nome das
 * ferramentas do servidor de terceiro e se há credencial configurada. Deixar
 * a página em `manager` mandaria quem não é admin pra uma tela cuja primeira
 * leitura de dados já devolveria 403 (ver `lib/navigation/catalogo.ts`, item
 * "Conexões MCP", para o mesmo raciocínio do lado da navegação).
 */
export default async function McpPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) redirect("/403");

  const idioma = user.idioma;
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  const conexoes = await listarConexoes(createAdminClient(), activeOrg.orgId);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Conexões MCP", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Ferramentas de outros sistemas que o agente consulta ou aciona durante o atendimento.",
            idioma,
          )}
        </p>
      </header>
      <McpClient initialData={conexoes} canWrite={canWrite} />
    </div>
  );
}
