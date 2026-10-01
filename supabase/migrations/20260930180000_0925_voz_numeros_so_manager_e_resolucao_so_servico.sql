-- 0925, voz: números só de manager e resolução só do serviço (D-111, D-112, parte de D-127) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- D-111. `fn_resolve_inbound_number` (security definer, sem search_path) era executável
-- por qualquer conta logada, inclusive sem organização, e devolvia organização, modo de
-- roteamento, agente e atendente do dono de um número. Só o worker de voz a usa, com
-- service_role: passa a ter search_path fixo e EXECUTE só do serviço.
-- Vizinho: `fn_colegas_podem_mexer_na_agenda` devolve false para quem não é da organização
-- perguntada (sem JWT, caminho de serviço, o comportamento é o de antes).
-- D-112. `phone_numbers` tinha policy `for all` só por tenant: o viewer cadastrava o DID
-- de outra empresa, mudava `trunk_endpoint`, `routing_mode` ou o agente. SELECT para
-- membro e escrita de manager (a API já exige manager). O agente padrão e o atendente
-- reserva passam a ser conferidos como da mesma organização por gatilho (D-127).
-- Fica de fora, por ser decisão de produto: o `number` segue único na instalação inteira e
-- um manager ainda pode ocupar um número de outra empresa (falta prova de posse do DID).
-- Reaplicável com o app no ar. Cria função: entra ANTES da VARREDURA anon.

do $t_phone_numbers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists phone_numbers_isolation on public.phone_numbers;
 drop policy if exists tenant_isolation_phone_numbers_select on public.phone_numbers;
 create policy tenant_isolation_phone_numbers_select on public.phone_numbers for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_phone_numbers_insert on public.phone_numbers;
 create policy tenant_isolation_phone_numbers_insert on public.phone_numbers for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_phone_numbers_update on public.phone_numbers;
 create policy tenant_isolation_phone_numbers_update on public.phone_numbers for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_phone_numbers_delete on public.phone_numbers;
 create policy tenant_isolation_phone_numbers_delete on public.phone_numbers for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_phone_numbers$;

create or replace function public.fn_resolve_inbound_number(p_number text)
returns table (
 organization_id uuid,
 routing_mode text,
 default_ai_agent_id uuid,
 fallback_user_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
 select organization_id, routing_mode, default_ai_agent_id, fallback_user_id
 from public.phone_numbers
 where number = p_number and is_active
 limit 1;
$$;
revoke execute on function public.fn_resolve_inbound_number(text) from public, anon, authenticated;
grant execute on function public.fn_resolve_inbound_number(text) to service_role;

create or replace function public.fn_colegas_podem_mexer_na_agenda(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
 select case
  when auth.uid() is not null and p_org not in (select public.fn_user_org_ids()) then false
  else coalesce(
   (select (o.settings->'colegas_podem_mexer_na_agenda') is distinct from 'false'::jsonb
      from public.organizations o where o.id = p_org),
   true)
 end;
$$;
revoke execute on function public.fn_colegas_podem_mexer_na_agenda(uuid) from public, anon;
grant execute on function public.fn_colegas_podem_mexer_na_agenda(uuid) to authenticated, service_role;

create or replace function public.fn_phone_numbers_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
 if new.default_ai_agent_id is not null
    and (tg_op = 'INSERT'
         or new.default_ai_agent_id is distinct from old.default_ai_agent_id
         or new.organization_id is distinct from old.organization_id)
    and not exists (
      select 1 from public.ai_agents a
       where a.id = new.default_ai_agent_id and a.organization_id = new.organization_id)
 then
  raise exception 'Agente não encontrado.' using errcode = 'PT422';
 end if;
 if new.fallback_user_id is not null
    and (tg_op = 'INSERT'
         or new.fallback_user_id is distinct from old.fallback_user_id
         or new.organization_id is distinct from old.organization_id)
    and not exists (
      select 1 from public.user_organizations uo
       where uo.user_id = new.fallback_user_id
         and uo.organization_id = new.organization_id
         and uo.revoked_at is null)
 then
  raise exception 'Responsável não é membro ativo desta organização.' using errcode = 'PT422';
 end if;
 return new;
end
$$;
revoke execute on function public.fn_phone_numbers_vinculos_da_organizacao() from public, anon, authenticated;

do $phone_gatilho$
begin
 perform set_config('lock_timeout','3s',true);
 create or replace trigger trg_phone_numbers_vinculos_da_organizacao
  before insert or update of default_ai_agent_id, fallback_user_id, organization_id on public.phone_numbers
  for each row
  execute function public.fn_phone_numbers_vinculos_da_organizacao();
end
$phone_gatilho$;
