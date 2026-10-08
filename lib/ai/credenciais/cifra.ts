/**
 * A CIFRA DA CHAVE DE UM PROVEDOR DE IA, LIGADA À ORGANIZAÇÃO E À LINHA (D-168).
 *
 * `ai_provider_credentials` cifrava com AES-GCM sem dado adicional: uma cifra copiada para a linha de
 * outra organização decifrava normalmente. Aqui o dado adicional passa a ser
 * `ai_provider_credentials:<organization_id>:<id da linha>`, e o envelope ganha a versão da chave
 * (ver `lib/crypto/aes_gcm.ts`).
 *
 * Migração transparente: a LEITURA aceita as duas formas (a legada ignora o contexto), e a linha
 * legada é regravada na forma nova na próxima vez que a chave for salva (cadastro ou rotação). Nenhuma
 * credencial existente é tocada por migration.
 *
 * Quem lê precisa trazer `id` na seleção da linha e passar a organização que filtrou a consulta.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";

export function aadDaCredencialDeIa(organizationId: string, credentialId: string): string {
  return `ai_provider_credentials:${organizationId}:${credentialId}`;
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
  return decryptKey(
    {
      ciphertext: byteaToBuffer(linha.api_key_encrypted),
      iv: byteaToBuffer(linha.api_key_iv),
      tag: byteaToBuffer(linha.api_key_tag),
    },
    { aad: aadDaCredencialDeIa(organizationId, linha.id) },
  );
}
