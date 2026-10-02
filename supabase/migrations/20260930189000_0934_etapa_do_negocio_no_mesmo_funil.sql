-- 0934, a etapa do negócio é do mesmo funil e da mesma organização dele (D-150, parte do banco) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- `fn_mover_leads_em_lote` (0263) só trocava `stage_id` e o gatilho 0403 só conferia contato e
-- dono. Quem chamava a RPC (ou escrevia `crm_leads` pela REST) com uma etapa de outro funil
-- deixava o negócio com `pipeline_id` de um funil e etapa de outro: some dos dois quadros, as
-- regras de reabertura rodam no funil errado e a transferência entre funis (0266) é contornada;
-- membro de duas empresas ainda podia apontar o negócio para a etapa da outra. A rota já recusa
-- (lote 8); agora o banco também:
--   1. a RPC confere, antes de escrever, que a etapa existe na organização do lote (PT404) e que
--      todo negócio do lote é do funil dela (PT422), na mesma transação;
--   2. gatilho em `crm_leads` (before insert ou update de stage_id, pipeline_id):
--      a etapa tem de ser da organização e do funil do próprio negócio (PT422). Só confere quando
--      a etapa ou o funil mudam (a troca de organização é da trava do plano, 0905); negócio antigo não é varrido. Etapa inexistente fica para a FK.
--      Security definer porque a etapa de outra organização é invisível sob RLS.
-- A transferência entre funis cria um negócio novo no funil de destino (clone), então não é
-- afetada. Reaplicável com o app no ar: `create or replace` e um DO com lock_timeout curto.
-- Cria função: entra ANTES da VARREDURA anon.

CREATE OR REPLACE FUNCTION public.fn_mover_leads_em_lote(p_organization_id uuid, p_lead_ids uuid[], p_stage_id uuid, p_lost_reason text DEFAULT NULL::text)
 RETURNS TABLE(lead_id uuid, from_stage_id uuid, pipeline_id uuid)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_piso numeric;
  -- Motivo em branco é ausência de motivo, nunca um motivo de uma letra.
  v_motivo text := nullif(btrim(coalesce(p_lost_reason, '')), '');
  v_coluna_motivo text := '';
  v_etapa_org uuid;
  v_etapa_funil uuid;
begin
  -- D-150: a etapa de destino é da MESMA organização e do MESMO funil de todo lead do lote.
  -- A rota já confere; aqui a regra mora no banco, onde todo chamador passa. Erro genérico
  -- (PT404/PT422), sem dizer se o id existe noutra organização.
  select s.organization_id, s.pipeline_id into v_etapa_org, v_etapa_funil
    from public.crm_stages s where s.id = p_stage_id;
  if not found or v_etapa_org is distinct from p_organization_id then
    raise exception 'Etapa não encontrada.' using errcode = 'PT404';
  end if;
  if exists (
    select 1 from public.crm_leads l
     where l.organization_id = p_organization_id
       and l.id = any(p_lead_ids)
       and l.pipeline_id is distinct from v_etapa_funil
  ) then
    raise exception 'Etapa de outro funil: use a transferência entre funis.' using errcode = 'PT422';
  end if;

  -- `coalesce(..., 0)` cobre a etapa vazia; o DEFAULT da coluna é 1000, então
  -- o primeiro card de um lote para uma etapa vazia cai em 1000, como um card
  -- criado à mão.
  select coalesce(max(l.position_in_stage), 0)
    into v_piso
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.stage_id = p_stage_id
     and not (l.id = any(p_lead_ids));

  -- Só com motivo a gravar a coluna entra na escrita (ver o cabeçalho).
  if v_motivo is not null then
    v_coluna_motivo := ', lost_reason = $4';
  end if;

  return query execute format($f$
  with alvo as (
    select l.id,
           l.stage_id    as from_stage_id,
           l.pipeline_id as pipeline_id,
           -- A ordem do lote no destino é a ordem em que ele estava no quadro:
           -- etapa, depois posição. `id` só desempata para o resultado ser
           -- determinístico (dois cards podem legitimamente empatar hoje :
           -- é justamente o estado que a migration 0209 deixa de produzir).
           row_number() over (order by l.stage_id, l.position_in_stage, l.id) as ordem
      from public.crm_leads l
     where l.organization_id = $1
       and l.id = any($2)
  ),
  movidos as (
    update public.crm_leads l
       set stage_id          = $3,
           position_in_stage = $5 + (a.ordem * 1000),
           updated_at        = now()%s
      from alvo a
     where l.id = a.id
       and l.organization_id = $1
    returning l.id, a.from_stage_id, a.pipeline_id
  )
  select m.id, m.from_stage_id, m.pipeline_id from movidos m
  $f$, v_coluna_motivo)
  using p_organization_id, p_lead_ids, p_stage_id, v_motivo, v_piso;
end;
$function$;

create or replace function public.fn_lead_etapa_do_mesmo_funil()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.stage_id is not distinct from old.stage_id
     and new.pipeline_id is not distinct from old.pipeline_id
  then
    return new;
  end if;

  if exists (
    select 1 from public.crm_stages s
     where s.id = new.stage_id
       and (s.organization_id is distinct from new.organization_id
            or s.pipeline_id is distinct from new.pipeline_id)
  )
  then
    raise exception 'Etapa não pertence ao funil deste negócio.' using errcode = 'PT422';
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_lead_etapa_do_mesmo_funil() from public, anon, authenticated;

do $g_crm_leads_etapa$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_lead_etapa_do_mesmo_funil on public.crm_leads;
 create trigger trg_lead_etapa_do_mesmo_funil
   before insert or update of stage_id, pipeline_id on public.crm_leads
   for each row execute function public.fn_lead_etapa_do_mesmo_funil();
end
$g_crm_leads_etapa$;
