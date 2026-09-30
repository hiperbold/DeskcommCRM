/**
 * Abre o acesso ao banco externo para uma leitura: carrega a conexão (com a
 * organização no filtro), revalida o destino contra a guarda de rede e devolve o
 * pool da conexão.
 *
 * ─── Por que a guarda roda AQUI, e não só no cadastro ───────────────────────
 *
 * Um host pode ter sido cadastrado quando resolvia para um IP público e, depois,
 * passar a resolver para `127.0.0.1` (DNS rebinding) — ou o dono pode ter
 * apontado para um nome que só existe dentro da rede. Validar apenas no POST
 * deixaria a janela aberta entre o cadastro e o primeiro SELECT. Toda leitura
 * passa por aqui, então a guarda é sempre reavaliada no momento de abrir o pool.
 *
 * ─── E o pool conecta pelo IP que a guarda validou (D-084, M2) ──────────────
 *
 * Resolver na guarda e deixar o `pg` resolver de novo no connect deixava a mesma
 * janela aberta DENTRO da leitura (e a cada reconexão do pool). A guarda devolve
 * os endereços que validou; o pool é aberto com o primeiro deles como host, e o
 * nome original vai só no `ssl.servername` (ver `conexao.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";

import { carregarConexao, type MotivoSemConexao } from "./credenciais";
import { obterPool } from "./conexao";
import { validarHostDeBanco } from "./guardas";
import type { ConexaoExterna } from "./types";

export type MotivoAcesso = MotivoSemConexao | "host_bloqueado" | "modulo_desligado";

export type Acesso =
  | { ok: true; conexao: ConexaoExterna; pool: pg.Pool }
  | { ok: false; motivo: MotivoAcesso };

export async function abrirAcesso(
  admin: SupabaseClient,
  organizationId: string,
  connectionId: string,
): Promise<Acesso> {
  // A porta de saída que o doc 37 manda fechar é ESTA: abrir conexão com o
  // banco de outro sistema. Toda leitura passa por aqui — as rotas e as
  // ferramentas do agente —, então o módulo desligado recusa aqui também, e
  // nenhum caminho novo precisa lembrar de perguntar.
  if (!(await moduloLigado(admin, "banco_externo"))) return { ok: false, motivo: "modulo_desligado" };

  const leitura = await carregarConexao(admin, organizationId, connectionId);
  if (!leitura.ok) return { ok: false, motivo: leitura.motivo };

  const alvo = await validarHostDeBanco(leitura.conexao.host);
  // O motivo real fica para o log do servidor: para o CLIENTE, "não resolveu" e
  // "rede interna" viram a mesma recusa (`respostaDeAcesso`), senão a resposta
  // vira oráculo de nomes que existem dentro da rede do servidor (D-084, M3).
  if (!alvo.ok) {
    logger.warn("[external-db.acesso] destino recusado pela guarda de rede", {
      connectionId,
      motivo: alvo.motivo,
    });
    return { ok: false, motivo: "host_bloqueado" };
  }

  const [enderecoValidado] = alvo.enderecos;
  if (enderecoValidado === undefined) return { ok: false, motivo: "host_bloqueado" };

  return { ok: true, conexao: leitura.conexao, pool: obterPool(leitura.conexao, enderecoValidado) };
}
