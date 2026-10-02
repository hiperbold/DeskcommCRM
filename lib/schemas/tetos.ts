/**
 * Tetos de tamanho para o que um token de API ou um agente grava em lead e
 * contato (D-164).
 *
 * Sem teto, uma chamada gravava milhares de tags longas ou um jsonb de vários
 * MB em até 50 leads por vez. O custo aparece longe da causa: a linha incha, o
 * quadro do funil (que seleciona tudo) e a listagem de contatos ficam lentos, e
 * `emit_event` leva as tags inteiras para a timeline e para os webhooks.
 *
 * O teto de 32 KB é o mesmo dos campos personalizados de contato
 * (`lib/schemas/contacts.ts`): uma régua só para o jsonb de cliente.
 */
import { z } from "zod";

/** Bytes (em JSON) que um objeto livre pode ocupar. */
export const TETO_DE_BYTES_DO_OBJETO = 32_768;
/** Marcadores por lead ou contato numa escrita. */
export const TETO_DE_TAGS = 50;
/** Tamanho de cada marcador de lead (o de contato é cortado em 40 por `normalizarTag`). */
export const TETO_DO_TAMANHO_DA_TAG_DO_LEAD = 60;

/** Objeto livre (campos personalizados, metadados) com chave curta e 32 KB no total. */
export const objetoComTeto = z
  .record(z.string().min(1).max(80), z.unknown())
  .refine((valor) => JSON.stringify(valor).length <= TETO_DE_BYTES_DO_OBJETO, {
    message: "O objeto excede o limite de 32 KB",
  });

/** Lista de marcadores de lead: quantidade e tamanho de cada um limitados. */
export const tagsDeLeadComTeto = z
  .array(z.string().max(TETO_DO_TAMANHO_DA_TAG_DO_LEAD))
  .max(TETO_DE_TAGS);
