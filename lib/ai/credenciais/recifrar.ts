/**
 * O RECIFRADOR DAS CREDENCIAIS DE IA DO FORMATO ANTIGO PARA O NOVO (D-168, parte 2).
 *
 * `ai_provider_credentials` guardava a chave de cada provedor com AES-GCM sem dado adicional (`iv` de 12
 * bytes). O D-168 passou a cifrar ligado à organização e à linha (`iv` de 13 bytes), mas a linha antiga só
 * migrava quando alguém salvava a chave de novo. Este módulo faz essa migração sozinho, em lotes pequenos:
 * decifra a linha antiga, cifra de novo com o `aad` dela e grava as três colunas.
 *
 * ─── Garantias ───────────────────────────────────────────────────────────────
 * - IDEMPOTENTE: só toca em linha com `iv` de 12 bytes; a linha nova é contada e deixada como está.
 * - NÃO ATROPELA ROTAÇÃO: a gravação só vale se o `iv` no banco ainda for o que foi lido. Quem rotacionou a
 *   chave no meio da rodada (outro `iv`) mantém a chave dele; a linha vira `mudaramNoMeio` e a próxima
 *   rodada olha de novo.
 * - CONFERE ANTES DE GRAVAR: o envelope novo é decifrado de volta e tem de dar o mesmo segredo. Chave de
 *   versão ausente ou fora do ar vira `falhas`, nunca uma linha gravada que não abre.
 * - NUNCA LANÇA POR UMA LINHA: a que não abre (cifrada com outra chave) conta em `falhas` e fica como está.
 * - O RESUMO NÃO LEVA SEGREDO, cifra, id nem texto de erro do banco: só contagens.
 *
 * O interruptor que recusa o formato antigo (`AI_CRED_RECUSAR_LEGADO`, ver `cifra.ts`) só deve ser ligado
 * depois de `restantes: 0` e `falhas: 0`. O recifrador lê o formato antigo de propósito, com o interruptor
 * ligado ou não.
 */
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import type { createAdminClient } from "@/lib/supabase/admin";

import { aadDaCredencialDeIa, TAMANHO_DO_IV_LEGADO } from "./cifra";

export const LOTE_PADRAO_DO_RECIFRADOR = 25;
export const PAGINA_DO_RECIFRADOR = 200;

export interface LinhaParaRecifrar {
  id: string;
  organization_id: string;
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
}

export interface ColunasRecifradas {
  api_key_encrypted: string;
  api_key_iv: string;
  api_key_tag: string;
}

export interface RepositorioDeRecifra {
  /** As linhas com `id` maior que `depoisDe` (ou desde o começo), em ordem de `id`. Lança se o banco falhar. */
  listar(depoisDe: string | null, tamanho: number): Promise<LinhaParaRecifrar[]>;
  /**
   * Grava as colunas novas SÓ se o `iv` gravado ainda for `ivAntigo`. `true` = gravou; `false` = a linha
   * mudou no meio (ou sumiu). Lança se o banco falhar.
   */
  trocar(id: string, organizationId: string, ivAntigo: unknown, novas: ColunasRecifradas): Promise<boolean>;
}

export interface ResumoDoRecifrador {
  varridas: number;
  jaNoFormatoNovo: number;
  recifradas: number;
  mudaramNoMeio: number;
  falhas: number;
  /** Linhas no formato antigo que esta rodada NÃO tratou (acabou o lote). Zero = pode ligar o interruptor. */
  restantes: number;
}

export async function recifrarCredenciaisLegadas(p: {
  repo: RepositorioDeRecifra;
  lote?: number;
  pagina?: number;
}): Promise<ResumoDoRecifrador> {
  const lote = p.lote ?? LOTE_PADRAO_DO_RECIFRADOR;
  const pagina = p.pagina ?? PAGINA_DO_RECIFRADOR;
  const resumo: ResumoDoRecifrador = {
    varridas: 0,
    jaNoFormatoNovo: 0,
    recifradas: 0,
    mudaramNoMeio: 0,
    falhas: 0,
    restantes: 0,
  };
  let tratadas = 0;
  let cursor: string | null = null;

  for (;;) {
    const linhas = await p.repo.listar(cursor, pagina);
    for (const linha of linhas) {
      resumo.varridas += 1;
      const iv = byteaToBuffer(linha.api_key_iv);
      if (iv.length !== TAMANHO_DO_IV_LEGADO) {
        resumo.jaNoFormatoNovo += 1;
        continue;
      }
      if (tratadas >= lote) {
        resumo.restantes += 1;
        continue;
      }
      tratadas += 1;
      try {
        const gravou = await recifrarUma(p.repo, linha, iv);
        if (gravou) resumo.recifradas += 1;
        else resumo.mudaramNoMeio += 1;
      } catch {
        // Sem o erro no resumo: o texto do banco ou da cifra não sai daqui.
        resumo.falhas += 1;
      }
    }
    if (linhas.length < pagina) break;
    cursor = linhas[linhas.length - 1]!.id;
  }
  return resumo;
}

async function recifrarUma(repo: RepositorioDeRecifra, linha: LinhaParaRecifrar, iv: Buffer): Promise<boolean> {
  const aad = aadDaCredencialDeIa(linha.organization_id, linha.id);
  const segredo = decryptKey({
    ciphertext: byteaToBuffer(linha.api_key_encrypted),
    iv,
    tag: byteaToBuffer(linha.api_key_tag),
  });
  const novo = encryptKey(segredo, { aad });
  // Prova de ida e volta antes de tocar no banco.
  const volta = decryptKey({ ciphertext: novo.ciphertext, iv: novo.iv, tag: novo.tag }, { aad });
  if (volta !== segredo) throw new Error("recifra não fecha");
  return repo.trocar(linha.id, linha.organization_id, bufToBytea(iv), {
    api_key_encrypted: bufToBytea(novo.ciphertext),
    api_key_iv: bufToBytea(novo.iv),
    api_key_tag: bufToBytea(novo.tag),
  });
}

/** O repositório de verdade: o cliente de servidor do Supabase (ignora a RLS, por isso filtra pela linha). */
export function repositorioDeRecifraSobre(admin: ReturnType<typeof createAdminClient>): RepositorioDeRecifra {
  return {
    async listar(depoisDe, tamanho) {
      let consulta = admin
        .from("ai_provider_credentials")
        .select("id, organization_id, api_key_encrypted, api_key_iv, api_key_tag")
        .order("id", { ascending: true })
        .limit(tamanho);
      if (depoisDe !== null) consulta = consulta.gt("id", depoisDe);
      const { data, error } = await consulta;
      if (error) throw new Error("falha ao listar as credenciais de IA");
      return (data ?? []) as LinhaParaRecifrar[];
    },
    async trocar(id, organizationId, ivAntigo, novas) {
      const { data, error } = await admin
        .from("ai_provider_credentials")
        .update(novas)
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("api_key_iv", bufToBytea(byteaToBuffer(ivAntigo)))
        .select("id");
      if (error) throw new Error("falha ao gravar a credencial recifrada");
      return (data ?? []).length > 0;
    },
  };
}
