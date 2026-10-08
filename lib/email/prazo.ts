/**
 * Os prazos de qualquer envio de e-mail (SMTP e Resend). Um servidor de e-mail que não responde não pode prender
 * quem chamou para sempre; estourou o prazo, o envio vira `send_failed` como qualquer outra falha. Os e-mails de
 * conta e de cobrança saem do cron `enviar-emails-de-conta`, que tem nova tentativa, mas estes prazos valem para
 * TODO o sistema (convite, recuperação de acesso, relatórios), então cada um separa duas coisas:
 *
 *   - servidor que não ATENDE (não conecta, não cumprimenta): prazo curto, 10 s;
 *   - servidor que atendeu e está LENTO (aceitou a mensagem e demora a responder o fim): prazo longo, 60 s no
 *     silêncio do socket. Cortar cedo aqui transformaria "o servidor aceitou, só demorou" em falha, e a nova
 *     tentativa mandaria o mesmo e-mail em dobro.
 */

/** Conexão TCP e saudação do servidor SMTP (`connectionTimeout` e `greetingTimeout`). */
export const PRAZO_DE_CONEXAO_SMTP_MS = 10_000;

/** Silêncio do socket SMTP depois de conectado (`socketTimeout`): servidor lento que já aceitou não vira falha. */
export const PRAZO_DE_SILENCIO_SMTP_MS = 60_000;

/** A chamada inteira à API da Resend. */
export const PRAZO_DO_ENVIO_RESEND_MS = 30_000;
