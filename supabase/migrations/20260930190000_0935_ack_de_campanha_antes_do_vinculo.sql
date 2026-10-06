-- 0935, o ack de entregue/lido que chega antes do vínculo não se perde mais (D-131, resto) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- `fn_campanha_sincroniza_ack` (0375) achava o destinatário por `campaign_recipients.message_id`, e
-- esse vínculo só é gravado DEPOIS do envio (a coluna tem FK para `messages`, a linha da mensagem só
-- existe depois). Quando o canal devolvia o `delivered` ou o `read` antes de o vínculo ser gravado, o
-- UPDATE não achava ninguém: o destinatário ficava em `sent` para sempre se nenhum ack seguinte
-- chegasse, e as métricas de entrega e leitura da campanha saíam abaixo da realidade.
--
-- A mensagem de campanha já nasce com `metadata.campaign_recipient_id`; agora o ack também acha o
-- destinatário por ele quando o vínculo ainda não existe (`message_id is null`). O uuid do metadata
-- é validado por regex dentro de um CASE (o planner não garante a ordem de um AND) para que um
-- metadata torto nunca derrube o UPDATE de status da mensagem. A organização é conferida. O resto da
-- regra (status analítico nunca retrocede) fica exatamente como na 0375.
-- Reaplicável com o app no ar: `create or replace` e o grant idempotente. A função já tem o gatilho
-- da 0375 apontando para ela. Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_campanha_sincroniza_ack() returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  update public.campaign_recipients r
     set delivered_at = case
           when new.status in ('delivered', 'read')
             then coalesce(r.delivered_at, new.delivered_at, now())
           else r.delivered_at end,
         read_at = case
           when new.status = 'read' then coalesce(r.read_at, new.read_at, now())
           else r.read_at end,
         sent_at = case
           when new.status in ('sent', 'delivered', 'read')
             then coalesce(r.sent_at, new.sent_at, now())
           else r.sent_at end,
         status = case
           when r.status in ('replied', 'opted_out', 'cancelled') then r.status
           when new.status = 'read' then 'read'
           when new.status = 'delivered' and r.status in ('queued', 'sending', 'sent') then 'delivered'
           when new.status = 'sent' and r.status in ('queued', 'sending') then 'sent'
           when new.status = 'failed' and r.status in ('queued', 'sending', 'sent') then 'failed'
           else r.status end,
         last_error_code = case
           when new.status = 'failed' then coalesce(new.error_code, r.last_error_code)
           else r.last_error_code end,
         last_error_detail = case
           when new.status = 'failed' then coalesce(new.error_message, r.last_error_detail)
           else r.last_error_detail end,
         updated_at = now()
   where r.message_id = new.id
      or (r.message_id is null
          and r.organization_id = new.organization_id
          and r.id = case
                when new.metadata ->> 'campaign_recipient_id'
                     ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (new.metadata ->> 'campaign_recipient_id')::uuid
              end);

  return new;
end
$$;

comment on function public.fn_campanha_sincroniza_ack() is
  'Trigger de messages: leva o ack do canal (sent/delivered/read/failed) ao campaign_recipients daquela mensagem, pelo message_id ou, enquanto o vínculo não existe, pelo metadata.campaign_recipient_id. Status analítico nunca retrocede.';

revoke execute on function public.fn_campanha_sincroniza_ack() from public, anon, authenticated;
grant execute on function public.fn_campanha_sincroniza_ack() to service_role;
