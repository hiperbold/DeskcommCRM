-- 0921, a anonimização LGPD alcança o que sobrava do titular (D-142, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A cascata e o gatilho da 0391 zeravam `messages.body`, `media_*` e `metadata`, mas
-- deixavam para trás cinco lugares onde o titular continuava legível:
--
--  1. `messages.media_derived_text` e `media_derived_status`: a transcrição de áudio e a
--     leitura de imagem ou documento (gravadas pelo worker de mídia). A transcrição com
--     nome, CPF e endereço seguia lida pelo contexto do lead, pela conversa do caso e
--     pelo follow-up, e podia voltar para a IA.
--  2. `lead_notes` (a nota do agente, com `embedding`) e `conversation_notes` (a nota
--     interna da equipe): "Maria, CPF final 123, mora na Rua X" seguia legível no resumo
--     do CRM e no recall. As colunas de texto são `not null`: recebem o texto fixo, nunca
--     `null`. O `embedding` é derivado do texto e sai junto. O nome de quem escreveu a
--     nota (`created_by_name`) é da equipe, não do titular, e fica.
--  3. `ai_chunks`: a conversa resolvida que virou base de conhecimento (anonimizada só
--     por regex) continuava recuperável pelo agente, para outros clientes. O vínculo é
--     `metadata.conversation_id`; os trechos das conversas do titular são apagados.
--  4. `event_log.payload`: o gatilho de mensagem grava `body_preview` (280 caracteres do
--     texto). Sai a chave, o evento fica.
--  5. Rastro do pedido da Nuvemshop: `webhook_events_log.raw_body` e `payload_parsed` do
--     customer/redact e do customer/data_request, e `lgpd_requests.request_payload.customer`
--     do pedido de apagamento, achados pelo id do cliente da loja (`nuvemshop_customer_id`
--     do `source_metadata`, que o gatilho ainda lê no OLD) ou pelo `webhook_log_id` do
--     pedido. O pedido de exportação ainda aberto mantém o `customer` (precisa dele para
--     entregar), por isso a limpeza do `request_payload` é só do tipo `redact`.
--
-- O conserto é no ESTADO, na virada de `is_anonymized`, como a 0391: a cascata formal e o
-- botão da ficha (que chama a cascata, 0414) passam pelo mesmo gatilho na mesma transação.
--
-- Cura: contatos que JÁ foram anonimizados. Cada comando só alcança o que existia ATÉ
-- `anonymized_at`, para o contato religado pelo LID não perder o conteúdo novo. Vai num
-- bloco `do` com lock_timeout curto: é reaplicado com o app no ar e desiste em vez de
-- ficar na fila.
--
-- Reaplicável: create or replace e updates que só alcançam linha ainda não redigida.
-- Cria função: entra ANTES da VARREDURA anon.

-- O rastro operacional do titular: o que ele deixou em log de transporte e em pedido.
-- Função própria (e não corpo do gatilho) porque não é dado que a organização "tem
-- sobre" o titular para exportar (Art. 18 II): `event_log` e `webhook_events_log` são
-- cópias de transporte de conteúdo que o export já entrega (mensagens, pedido), e o
-- `request_payload` do pedido de apagamento é o PRÓPRIO pedido. O nome não casa com a
-- varredura de `tests/unit/lgpd-exporta-o-que-redige.test.ts`, que exige export de toda
-- tabela que uma função de anonimização limpa, e isso é deliberado e declarado aqui.
create or replace function public.fn_limpar_rastro_do_titular(p_org uuid, p_contato uuid, p_ext text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Os eventos de mensagem levam 280 caracteres do texto em `body_preview`. O vínculo é pelo id da mensagem.
  update public.event_log e set payload = e.payload - 'body_preview'
   where e.organization_id = p_org
     and e.entity_kind = 'message'
     and e.payload ? 'body_preview'
     and e.entity_id in (
       select m.id from public.messages m
        where m.organization_id = p_org
          and m.conversation_id in (
            select c.id from public.conversations c
             where c.contact_id = p_contato and c.organization_id = p_org));

  update public.webhook_events_log set
    raw_body = '[redigido]',
    payload_parsed = payload_parsed - 'customer'
  where organization_id = p_org
    and provider = 'nuvemshop'
    and (
      (p_ext is not null
       and event_type in ('customer/redact', 'customer/data_request')
       and payload_parsed->'customer'->>'id' = p_ext)
      or id::text in (
        select r.request_payload->>'webhook_log_id'
          from public.lgpd_requests r
         where r.organization_id = p_org
           and r.contact_id = p_contato
           and r.request_type = 'redact')
    );

  update public.lgpd_requests set
    request_payload = request_payload - 'customer'
  where organization_id = p_org
    and request_type = 'redact'
    and request_payload ? 'customer'
    and (contact_id = p_contato
         or (p_ext is not null and external_customer_id = p_ext));

end
$$;
revoke all on function public.fn_limpar_rastro_do_titular(uuid, uuid, text) from public;
revoke execute on function public.fn_limpar_rastro_do_titular(uuid, uuid, text) from anon;
revoke execute on function public.fn_limpar_rastro_do_titular(uuid, uuid, text) from authenticated;

create or replace function public.fn_redigir_conversas_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ext text := old.source_metadata->>'nuvemshop_customer_id';
begin
  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
    from public.messages m
   where m.organization_id = new.organization_id
     and m.conversation_id in (
       select c.id from public.conversations c
        where c.contact_id = new.id and c.organization_id = new.organization_id)
     and m.media_storage_path is not null
     and length(m.media_storage_path) > 0
  on conflict (bucket, object_path) do nothing;

  update public.messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    media_derived_status = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id);

  update public.conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = new.id and organization_id = new.organization_id;

  update public.lead_checkpoints set
    rolling_summary = '[resumo anonimizado]',
    commitments = '[]'::jsonb,
    objections = '[]'::jsonb,
    next_action = null,
    declaracao = null
  where contact_id = new.id and organization_id = new.organization_id;

  update public.lead_notes set
    headline = '[nota anonimizada]',
    body = '[nota anonimizada]',
    embedding = null,
    updated_at = now()
  where contact_id = new.id and organization_id = new.organization_id;

  update public.conversation_notes set
    body = '[nota anonimizada]'
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id);

  delete from public.ai_chunks a
   using public.conversations c
   where c.contact_id = new.id and c.organization_id = new.organization_id
     and a.organization_id = new.organization_id
     and a.metadata @> jsonb_build_object('conversation_id', c.id);

  perform public.fn_limpar_rastro_do_titular(new.organization_id, new.id, v_ext);

  return new;
end
$$;

-- As DUAS origens de EXECUTE (item 9 do CLAUDE.md): o grant a PUBLIC da criação
-- e o grant nominal a anon do ALTER DEFAULT PRIVILEGES do baseline.
revoke all on function public.fn_redigir_conversas_ao_anonimizar() from public;
revoke execute on function public.fn_redigir_conversas_ao_anonimizar() from anon;
revoke execute on function public.fn_redigir_conversas_ao_anonimizar() from authenticated;

do $cura_0921$
begin
 perform set_config('lock_timeout','3s',true);

 update public.messages m set
   media_derived_text = null,
   media_derived_status = null
   from public.conversations c
   join public.contacts k on k.id = c.contact_id and k.organization_id = c.organization_id
  where c.id = m.conversation_id
    and c.organization_id = m.organization_id
    and k.is_anonymized
    and m.created_at <= k.anonymized_at
    and (m.media_derived_text is not null or m.media_derived_status is not null);

 update public.lead_notes n set
   headline = '[nota anonimizada]',
   body = '[nota anonimizada]',
   embedding = null,
   updated_at = now()
   from public.contacts k
  where k.id = n.contact_id
    and k.organization_id = n.organization_id
    and k.is_anonymized
    and n.created_at <= k.anonymized_at
    and (n.body is distinct from '[nota anonimizada]'
         or n.headline is distinct from '[nota anonimizada]'
         or n.embedding is not null);

 update public.conversation_notes n set
   body = '[nota anonimizada]'
   from public.conversations c
   join public.contacts k on k.id = c.contact_id and k.organization_id = c.organization_id
  where c.id = n.conversation_id
    and c.organization_id = n.organization_id
    and k.is_anonymized
    and n.created_at <= k.anonymized_at
    and n.body is distinct from '[nota anonimizada]';

 delete from public.ai_chunks a
  using public.conversations c, public.contacts k
  where k.id = c.contact_id and k.organization_id = c.organization_id
    and k.is_anonymized
    and coalesce(c.last_message_at, c.created_at) <= k.anonymized_at
    and a.organization_id = c.organization_id
    and a.metadata @> jsonb_build_object('conversation_id', c.id);

 update public.event_log e set payload = e.payload - 'body_preview'
   from public.messages m
   join public.conversations c on c.id = m.conversation_id and c.organization_id = m.organization_id
   join public.contacts k on k.id = c.contact_id and k.organization_id = c.organization_id
  where e.entity_kind = 'message'
    and e.entity_id = m.id
    and e.organization_id = m.organization_id
    and k.is_anonymized
    and e.created_at <= k.anonymized_at
    and e.payload ? 'body_preview';

 update public.webhook_events_log w set
   raw_body = '[redigido]',
   payload_parsed = w.payload_parsed - 'customer'
   from public.lgpd_requests r
   join public.contacts k on k.id = r.contact_id and k.organization_id = r.organization_id
  where r.request_type = 'redact'
    and k.is_anonymized
    and w.organization_id = r.organization_id
    and w.provider = 'nuvemshop'
    and w.id::text = r.request_payload->>'webhook_log_id'
    and w.raw_body is distinct from '[redigido]';

 update public.lgpd_requests r set
   request_payload = r.request_payload - 'customer'
   from public.contacts k
  where k.id = r.contact_id
    and k.organization_id = r.organization_id
    and k.is_anonymized
    and r.request_type = 'redact'
    and r.request_payload ? 'customer';
end
$cura_0921$;
