-- 0917, anonimizar contato: o admin de plataforma de fora da empresa precisa ter escopo full (D-103, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. O portão de fn_lgpd_anonymize_contact (0414, o botão "Anonimizar
-- contato" da ficha) aceita quem é admin da organização OU fn_is_platform_admin()
-- fora de sessão de suporte. fn_is_platform_admin() responde "existe linha não
-- revogada em platform_admins" e não olha o escopo: um operador support_readonly
-- que chamasse a função com o id de QUALQUER empresa, sem ser membro dela,
-- anonimizava o contato de forma irreversível. A rota
-- (requireRole com allowPlatformAdmin e organizationId) era a porta de fora; esta
-- migration fecha a de dentro, porque a função é chamável direto pelo PostgREST
-- por qualquer authenticated.
--
-- A correção. No portão, fn_is_platform_admin() passa a ser
-- fn_is_platform_admin_full() (escopo full, a mesma função que as policies de
-- escrita de platform_admins já usam). O resto do portão não muda: autoridade de
-- suporte, admin da organização, MFA comprovado, mutex e contrato de retorno.
-- Quem é admin da própria empresa continua anonimizando pelo ramo de papel.
--
-- Cria função: entra ANTES da VARREDURA anon. Só create or replace, revoke e
-- grant: reaplicável com o app no ar, sem tabela, coluna, gatilho nem linha
-- tocada.

create or replace function public.fn_lgpd_anonymize_contact(p_organization_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.contacts; support jsonb; v_quando timestamptz;
begin
 support:=public.fn_support_context();
 if auth.uid() is null or not public.fn_support_write_allowed(p_organization_id)
  or not (public.fn_role_at_least(p_organization_id,'admin') or (public.fn_is_platform_admin_full() and support is null)) then
  raise exception 'contact_anonymize_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'contact_anonymize_mfa_required' using errcode='42501';end if;
 perform public.fn_service_lock(p_organization_id,p_contact_id);
 select * into c from public.contacts where organization_id=p_organization_id and id=p_contact_id for update;
 if not found then raise exception 'contact_not_found' using errcode='P0002';end if;
 if c.is_anonymized then return jsonb_build_object('already_anonymized',true,'anonymized_at',c.anonymized_at);end if;
 -- issue #1504 - a redação em si é da função ÚNICA. Este caminho (o botão) e o
 -- pedido formal passam por aqui; o portão acima é quem decide QUEM pode
 -- anonimizar, e nada é escrito por conta própria neste corpo.
 perform public.fn_lgpd_cascade_redact_contact(p_organization_id,p_contact_id,null);
 select anonymized_at into v_quando
   from public.contacts where organization_id=p_organization_id and id=p_contact_id;
 return jsonb_build_object('already_anonymized',false,'anonymized_at',v_quando);
end;$$;
revoke all on function public.fn_lgpd_anonymize_contact(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.fn_lgpd_anonymize_contact(uuid,uuid) to authenticated;
