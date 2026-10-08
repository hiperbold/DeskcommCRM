/**
 * A CIFRA DA CHAVE DE UM PROVEDOR DE IA, LIGADA À ORGANIZAÇÃO E À LINHA (D-168).
 *
 * `ai_provider_credentials` cifrava com AES-GCM sem dado adicional: uma cifra copiada para a linha de
 * outra organização decifrava normalmente. Aqui o dado adicional passa a ser
 * `ai_provider_credentials:<organization_id>:<id da linha>`, e o envelope ganha a versão da chave
 * (ver `lib/crypto/aes_gcm.ts`).
 *
 * Migração transparente: a LEITURA aceita as duas formas (a legada ignora o contexto), e a linha
 * legada é regravada na forma nova na próxima vez que a chave for salva (cadastro ou rotação), ou pelo
 * recifrador (`recifrar.ts`, rota de cron diária). Nenhuma credencial existente é tocada por migration. Zerado
 * o formato antigo, `AI_CRED_RECUSAR_LEGADO` passa a recusá-lo na leitura (ver `recusaCredencialLegada`).
 *
 * Quem lê precisa trazer `id` na seleção da linha e passar a organização que filtrou a consulta.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";

/** Tamanho do `iv` da forma ANTIGA (sem dado adicional): 12 bytes. A nova tem 13 (versão da chave + nonce). */
export const TAMANHO_DO_IV_LEGADO = 12;

export function aadDaCredencialDeIa(organizationId: string, credentialId: string): string {
  return `ai_provider_credentials:${organizationId}:${credentialId}`;
}

/**
 * INTERRUPTOR `AI_CRED_RECUSAR_LEGADO` (desligado por padrão): ligado, a leitura RECUSA a credencial no
 * formato antigo. A forma antiga não prende a cifra à organização nem à linha, então manter a aceitação
 * para sempre deixa a defesa do D-168 furada para quem tem acesso de escrita à tabela.
 *
 * Só se liga DEPOIS de o recifrador (`recifrar.ts`, rota `/api/v1/cron/recifrar-credenciais-de-ia`) responder
 * `restantes: 0` e `falhas: 0` em produção: ligado antes, a IA de toda organização com chave antiga para de
 * funcionar (a chave "não abre"). Valores que ligam: `1`, `true`, `sim`.
 */
export function recusaCredencialLegada(): boolean {
  return /^(1|true|sim)$/i.test(process.env.AI_CRED_RECUSAR_LEGADO ?? "");
}

export interface ColunasCifradasDaCredencial {
  id: string;
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
}

/** Decifra a chave de uma linha de `ai_provider_credentials`. Plaintext só existe no retorno. */
export function decifrarColunasDaCredencial(
  linha: ColunasCifradasDaCredencial,
  organizationId: string,
): string {
  const iv = byteaToBuffer(linha.api_key_iv);
  if (iv.length === TAMANHO_DO_IV_LEGADO && recusaCredencialLegada()) {
    // A mensagem não leva a chave nem a cifra: só diz o que fazer.
    throw new Error(
      "credencial de IA no formato antigo recusada (AI_CRED_RECUSAR_LEGADO): rode o recifrador antes de ligar o interruptor",
    );
  }
  return decryptKey(
    {
      ciphertext: byteaToBuffer(linha.api_key_encrypted),
      iv,
      tag: byteaToBuffer(linha.api_key_tag),
    },
    { aad: aadDaCredencialDeIa(organizationId, linha.id) },
  );
}
