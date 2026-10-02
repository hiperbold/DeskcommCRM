-- 0930, a troca de plano e o ajuste de limites deixam trilha dentro da transação (D-133, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. Trocar o plano (fn_billing_trocar_plano, 0904) e ajustar os limites
-- (fn_billing_ajustar_limites, 0904) não gravavam billing_contract_eventos. A única marca era o
-- api_audit_log, que é fire-and-forget: se o insert da auditoria falhasse, a troca ficava feita sem
-- registro. As funções de pagamento e de estado (0908, 0909) já gravam o evento na mesma transação.
-- A carência extra (fn_billing_estender_carencia) já gravava o evento desde a 0910 e não muda.
--
-- A correção. Os dois usam o tipo `plano` que a 0909 já criou em billing_contract_eventos (o CHECK
-- não muda). fn_billing_trocar_plano grava o evento quando o plano muda (de e para são os ids das
-- versões, como no primeiro pagamento, motivo `troca_manual`), e fn_billing_ajustar_limites grava o
-- evento quando o ajuste muda e a organização tem contrato (de e para são o ajuste antes e depois,
-- motivo `ajuste_de_limites: <nota>`). Ator e motivo na mesma transação da mudança. Corpo igual ao
-- anterior fora isso.
--
-- Fora desta migration (adiado): o aceite dos Termos na compra e a versão em billing_orders.
--
-- Só troca o CORPO das duas funções (create or replace, mesmo ACL): reaplicável com o app no ar, sem
-- DDL em tabela.
create or replace function public.fn_billing_trocar_plano(p_org uuid, p_plan_code text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
  v_plan_id_antes uuid;
  v_contract_id uuid;
  v_antes_plan_code text;
  v_antes_plan_version integer;
  v_depois_plan_code text;
  v_depois_plan_version integer;
begin
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'organizacao_nao_encontrada' using errcode = 'P0002';
  end if;

  -- Advisory lock por organização, não `for update` em `organizations`: essa
  -- trava bloquearia os inserts de qualquer tabela filha da organização
  -- durante a troca. `for update` na linha do contrato não serve sozinho
  -- porque não trava nada quando a linha ainda não existe (organização sem
  -- contrato), e duas trocas concorrentes registrariam o mesmo "antes".
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text, 0));

  select id into v_plan_id
  from public.billing_plans
  where code = p_plan_code and active
  limit 1;

  if v_plan_id is null then
    raise exception 'plano_nao_encontrado_ou_inativo' using errcode = 'P0002';
  end if;

  -- Trava o contrato existente, se houver, para não perder o "antes" numa
  -- troca concorrente. Organização sem contrato ainda: nada a travar, o
  -- insert abaixo cria a linha.
  perform 1 from public.billing_contracts where organization_id = p_org for update;

  select bp.code, bp.version, bc.plan_id
    into v_antes_plan_code, v_antes_plan_version, v_plan_id_antes
  from public.billing_contracts bc
  join public.billing_plans bp on bp.id = bc.plan_id
  where bc.organization_id = p_org;

  insert into public.billing_contracts (organization_id, plan_id)
  values (p_org, v_plan_id)
  on conflict (organization_id) do update set plan_id = excluded.plan_id
  returning id into v_contract_id;

  -- D-133 (0930): a troca fica registrada na MESMA transação (de e para são os ids das
  -- versões, como o evento de plano do primeiro pagamento, 0909). Trocar para o mesmo plano
  -- não muda nada e não grava evento.
  if v_plan_id_antes is distinct from v_plan_id then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (p_org, v_contract_id, 'plano', v_plan_id_antes::text, v_plan_id::text, 'troca_manual', p_actor);
  end if;

  select bp.code, bp.version
    into v_depois_plan_code, v_depois_plan_version
  from public.billing_contracts bc
  join public.billing_plans bp on bp.id = bc.plan_id
  where bc.organization_id = p_org;

  return jsonb_build_object(
    'antes', case when v_antes_plan_code is null then null
                  else jsonb_build_object('plan_code', v_antes_plan_code, 'version', v_antes_plan_version) end,
    'depois', jsonb_build_object('plan_code', v_depois_plan_code, 'version', v_depois_plan_version)
  );
end;
$$;

revoke execute on function public.fn_billing_trocar_plano(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_trocar_plano(uuid, text, uuid) to service_role;

create or replace function public.fn_billing_ajustar_limites(p_org uuid, p_limits jsonb, p_note text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes jsonb;
  v_depois jsonb;
  v_contract_id uuid;
begin
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'organizacao_nao_encontrada' using errcode = 'P0002';
  end if;

  -- Mesmo racional de fn_billing_trocar_plano: advisory lock por
  -- organização, não `for update` em `organizations`.
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text, 0));

  select limits into v_antes
  from public.billing_plan_adjustments
  where organization_id = p_org
  for update;

  if p_limits is null or p_limits = '{}'::jsonb then
    -- Objeto vazio apaga o ajuste: a linha só existe quando há algo a
    -- sobrepor ao plano.
    delete from public.billing_plan_adjustments where organization_id = p_org;
    v_depois := null;
  else
    insert into public.billing_plan_adjustments (organization_id, limits, note, granted_by)
    values (p_org, p_limits, p_note, p_actor)
    on conflict (organization_id) do update
      set limits = excluded.limits,
          note = excluded.note,
          granted_by = excluded.granted_by
    returning limits into v_depois;
  end if;

  -- D-133 (0930): o ajuste fica registrado na MESMA transação, com a nota como motivo. Sem
  -- contrato não há a quem pendurar o evento (billing_contract_eventos.contract_id é
  -- obrigatório): o ajuste vale, e a auditoria do chamador segue sendo o registro.
  if v_antes is distinct from v_depois then
    select id into v_contract_id from public.billing_contracts where organization_id = p_org;
    if v_contract_id is not null then
      insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
      values (p_org, v_contract_id, 'plano', v_antes::text, v_depois::text, left('ajuste_de_limites: ' || coalesce(p_note, ''), 500), p_actor);
    end if;
  end if;

  return jsonb_build_object('antes', v_antes, 'depois', v_depois);
end;
$$;

revoke execute on function public.fn_billing_ajustar_limites(uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_ajustar_limites(uuid, jsonb, text, uuid) to service_role;
