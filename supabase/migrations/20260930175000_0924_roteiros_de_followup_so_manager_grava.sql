-- 0924, roteiros de follow-up: só manager grava (D-139, parte de D-113 e D-127) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- As tabelas dos roteiros de follow-up tinham policy `for all` só por pertencer à
-- organização: o viewer reescrevia o `graph` da versão ativa (o worker mandava o
-- texto dele a todos os inscritos) ou ativava um roteiro com `trigger_config` próprio.
-- Todas as rotas que gravam exigem manager e o motor grava por serviço (admin, pool),
-- então: SELECT para membro; escrita só de manager em pointers, enrollments e events;
-- versions só ganha delete de manager (a publicação e o rollback usam serviço).
-- `active_version_id` passa a conferir no gatilho que a versão é da mesma organização
-- (só quando a coluna é gravada ou muda; ponteiro antigo não é varrido).
-- Reaplicável com o app no ar: um DO por tabela, create or replace, lock_timeout curto.
-- Cria função: entra ANTES da VARREDURA anon.

do $t_followup_flow_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_followup_flow_pointers_all on public.followup_flow_pointers;
 drop policy if exists tenant_isolation_followup_flow_pointers_select on public.followup_flow_pointers;
 create policy tenant_isolation_followup_flow_pointers_select on public.followup_flow_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_followup_flow_pointers_insert on public.followup_flow_pointers;
 create policy tenant_isolation_followup_flow_pointers_insert on public.followup_flow_pointers for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_followup_flow_pointers_update on public.followup_flow_pointers;
 create policy tenant_isolation_followup_flow_pointers_update on public.followup_flow_pointers for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_followup_flow_pointers_delete on public.followup_flow_pointers;
 create policy tenant_isolation_followup_flow_pointers_delete on public.followup_flow_pointers for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_followup_flow_pointers$;
do $t_followup_flow_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_followup_flow_versions_all on public.followup_flow_versions;
 drop policy if exists tenant_isolation_followup_flow_versions_select on public.followup_flow_versions;
 create policy tenant_isolation_followup_flow_versions_select on public.followup_flow_versions for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_followup_flow_versions_delete on public.followup_flow_versions;
 create policy tenant_isolation_followup_flow_versions_delete on public.followup_flow_versions for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_followup_flow_versions$;
do $t_followup_enrollments$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_followup_enrollments_all on public.followup_enrollments;
 drop policy if exists tenant_isolation_followup_enrollments_select on public.followup_enrollments;
 create policy tenant_isolation_followup_enrollments_select on public.followup_enrollments for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_followup_enrollments_insert on public.followup_enrollments;
 create policy tenant_isolation_followup_enrollments_insert on public.followup_enrollments for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_followup_enrollments_update on public.followup_enrollments;
 create policy tenant_isolation_followup_enrollments_update on public.followup_enrollments for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_followup_enrollments_delete on public.followup_enrollments;
 create policy tenant_isolation_followup_enrollments_delete on public.followup_enrollments for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_followup_enrollments$;
do $t_followup_enrollment_events$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_followup_enrollment_events_all on public.followup_enrollment_events;
 drop policy if exists tenant_isolation_followup_enrollment_events_select on public.followup_enrollment_events;
 create policy tenant_isolation_followup_enrollment_events_select on public.followup_enrollment_events for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_followup_enrollment_events_insert on public.followup_enrollment_events;
 create policy tenant_isolation_followup_enrollment_events_insert on public.followup_enrollment_events for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 revoke update, delete, truncate on public.followup_enrollment_events from authenticated, anon;
end
$t_followup_enrollment_events$;

create or replace function public.fn_followup_pointer_versao_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
 if new.active_version_id is not null
    and (tg_op = 'INSERT'
         or new.active_version_id is distinct from old.active_version_id
         or new.organization_id is distinct from old.organization_id)
    and not exists (
      select 1 from public.followup_flow_versions v
       where v.id = new.active_version_id
         and v.organization_id = new.organization_id)
 then
  raise exception 'Versão não encontrada.' using errcode = 'PT422';
 end if;
 return new;
end
$$;
revoke execute on function public.fn_followup_pointer_versao_da_organizacao() from public, anon, authenticated;

do $followup_ponteiro$
begin
 perform set_config('lock_timeout','3s',true);
 create or replace trigger trg_followup_pointer_versao_da_organizacao
  before insert or update of active_version_id, organization_id on public.followup_flow_pointers
  for each row
  execute function public.fn_followup_pointer_versao_da_organizacao();
end
$followup_ponteiro$;
