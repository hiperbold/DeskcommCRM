-- 0927, emit_event pede agent e organização explícita (D-129) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O viewer emitia `lead.stage_changed` ou `lead.created` e disparava automações e
-- follow-ups, e com `p_organization_id` nulo a função escolhia uma organização do usuário
-- com `limit 1` sem ordem. Para chamador autenticado agora: papel agent ou acima e
-- organização obrigatória (a do suporte em sessão continua valendo). Única exceção: o
-- evento `user.profile_updated` do próprio usuário (a tela de perfil o emite com qualquer
-- papel). Corpo igual ao anterior fora isso; o caminho de serviço (sem JWT) não muda.
-- Cria função: entra ANTES da VARREDURA anon.


create or replace function public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb default '{}'::jsonb, p_metadata jsonb default '{}'::jsonb, p_organization_id uuid default null::uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_contact uuid;
  v_origin jsonb;
begin
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed'
  ) then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  if auth.uid() is not null
     and not (
       public.fn_role_at_least(v_org_id, 'agent')
       or (p_event_type = 'user.profile_updated' and p_entity_id = auth.uid())
     ) then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active agent or above in the organization';
  end if;

  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
      select contact_id into v_contact from public.crm_leads where organization_id=v_org_id and id=p_entity_id;
    elsif p_event_type='contact.tag_added' and p_entity_kind='contact' then
      select id into v_contact from public.contacts where organization_id=v_org_id and id=p_entity_id;
    end if;
    if v_contact is not null
       and exists(select 1 from public.contacts
                   where organization_id=v_org_id and id=v_contact
                     and not is_anonymized and is_merged_into is null) then
      v_origin := jsonb_build_object('kind','command',
        'observed', public.fn_service_observe_command(v_org_id, v_contact));
    end if;
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb)
       || case when v_origin is null then '{}'::jsonb else jsonb_build_object('service_origin', v_origin) end,
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;
revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
