/**
 * A SENHA DO TRONCO SIP, CIFRADA LIGADA À ORGANIZAÇÃO (D-168, parte 2).
 *
 * `voip_trunk_settings` cifrava a senha com a mesma `AI_CRED_AES_KEY` das credenciais de IA e SEM dado
 * adicional: uma cifra copiada para o tronco de outra organização abria normalmente. Agora o dado adicional
 * é `voip_trunk_settings:<organization_id>` (a chave primária da tabela É a organização, então não há um
 * segundo id) e o envelope leva a versão da chave (ver `lib/crypto/aes_gcm.ts`).
 *
 * LEITOR: hoje NÃO existe leitor da senha no repositório. A senha é aplicada à mão no `pjsip.conf` do
 * Asterisk (migration 0349: sem reload automático) e as telas leem só `voip_trunk_settings_safe`, que expõe
 * `password_last4`. Quando o dia de decifrar chegar (aplicar sozinho no Asterisk), é por esta função: ela lê
 * as duas formas, a antiga (iv de 12 bytes, que ignora o contexto) e a nova. Linha antiga vira nova na
 * próxima vez que a senha for salva pela tela do tronco.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";

export function aadDoTrunk(organizationId: string): string {
  return `voip_trunk_settings:${organizationId}`;
}

export interface ColunasCifradasDoTrunk {
  password_encrypted: unknown;
  password_iv: unknown;
  password_tag: unknown;
}

/** Decifra a senha do tronco de uma organização. Plaintext só existe no retorno. */
export function decifrarSenhaDoTrunk(linha: ColunasCifradasDoTrunk, organizationId: string): string {
  return decryptKey(
    {
      ciphertext: byteaToBuffer(linha.password_encrypted),
      iv: byteaToBuffer(linha.password_iv),
      tag: byteaToBuffer(linha.password_tag),
    },
    { aad: aadDoTrunk(organizationId) },
  );
}
