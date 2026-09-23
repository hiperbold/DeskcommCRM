-- 0904, catálogo de planos e contrato da organização (fase F1, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901): o autor upstream numera em
-- sequência própria, e um número perto do dele colide no próximo merge.
--
-- Objetivo da fase (hiperbold/planos/fase-F1-tarefas.md): o banco passa a
-- saber em que plano cada organização está, e o admin da plataforma consegue
-- ver e trocar isso na mão. NADA bloqueia nesta fase: toda organização,
-- existente ou nova, fica no plano Ilimitado, e nenhum limite é imposto por
-- código de contagem ainda (isso é da F2).
--
-- Três tabelas. `billing_plans` é o catálogo: uma linha por VERSÃO de plano
-- (coluna `active`, só uma versão ativa por `code`, índice único parcial).
-- `billing_contracts` é a assinatura da organização, uma linha por
-- organização, apontando para a VERSÃO contratada (`plan_id`): quem já
-- assinou mantém o preço e os tetos que contratou, mesmo que uma versão nova
-- do mesmo `code` nasça depois. `billing_plan_adjustments` é o ajuste manual
-- do CRM por cima do plano (parcial: só as chaves que o admin decidiu
-- sobrescrever). `asaas_customer_id` NÃO mora aqui: pelo manual comum Asaas
-- ele fica em `billing_customers`, que nasce só na F5.
--
-- Tetos em jsonb com conjunto FECHADO de sete chaves, todas presentes no
-- plano (parcial só no ajuste). Valor inteiro entre 0 e 2147483647, ou null
-- significando sem limite. A validação mora em UMA função,
-- `fn_billing_limites_validos`, chamada pelo CHECK das duas tabelas: por
-- isso ela precisa existir ANTES de `billing_plans`.
--
-- Escrita só por função SQL `security definer`, executável apenas pelo
-- `service_role`, chamada depois da checagem de admin no servidor (escopo
-- `full`; `support_readonly` só lê). Nenhuma política de RLS de escrita para
-- `authenticated`: por isso a única forma de mudar plano ou ajuste é pelas
-- funções, que travam a linha (`for update`), gravam e devolvem o antes e o
-- depois, para a auditoria da Tarefa 4 não mentir numa troca concorrente.
--
-- A precedência dos limites mora em UMA função SQL,
-- `fn_billing_limites_efetivos`, estável, uma consulta só: o servidor chama
-- por RPC, e os gatilhos de contagem da F2 vão reaproveitar a mesma função.
-- Não há segunda implementação em TypeScript.
--
-- Organização nova ganha contrato por gatilho `after insert on
-- organizations` (nome escolhido para não colidir com
-- `trg_seed_org_llm_defaults` e `trg_semear_tipos_de_agendamento`, que já
-- existem na mesma tabela). Organização existente ganha contrato Ilimitado
-- pelo backfill do item 7 desta migration.
--
-- O campo antigo `organizations.settings.plan` (valores standard | pro |
-- enterprise) fica aposentado como fonte de plano a partir desta fase (a
-- tela para de mostrá-lo, a F2 nunca o lê); a função SQL do autor que o
-- grava não é tocada aqui, e o registro fica no débito da fase, não nesta
-- migration.
--
-- Idempotente: create if not exists, create or replace, drop policy/trigger
-- if exists antes de recriar, semeadura com on conflict do nothing,
-- preenchimento com where not exists.

-- ── 1. fn_billing_limites_validos: valida o objeto de tetos ──
--
-- Precisa existir ANTES de `billing_plans`, porque o CHECK da coluna
-- `limits` chama esta função. Em plpgsql (não em SQL puro) de propósito: dá
-- para checar o tipo do jsonb ANTES de iterar as chaves, e assim nunca
-- chamamos jsonb_each/jsonb_object_keys num valor que não é objeto.
create or replace function public.fn_billing_limites_validos(l jsonb, parcial boolean)
returns boolean
language plpgsql
immutable
as $$
declare
  v_chave text;
  v_valor jsonb;
  v_contagem integer := 0;
begin
  if l is null or jsonb_typeof(l) <> 'object' then
    return false;
  end if;

  for v_chave, v_valor in select * from jsonb_each(l)
  loop
    if v_chave not in (
      'funis', 'etapas_por_funil', 'leads', 'membros',
      'conexoes', 'integracoes_webhook', 'tokens_ia_mes'
    ) then
      return false;
    end if;

    if jsonb_typeof(v_valor) = 'null' then
      -- null é o valor documentado de "sem limite": aceito.
      null;
    elsif jsonb_typeof(v_valor) = 'number' then
      if (v_valor::text)::numeric <> trunc((v_valor::text)::numeric)
        or (v_valor::text)::numeric < 0
        or (v_valor::text)::numeric > 2147483647
      then
        return false;
      end if;
    else
      -- texto, booleano, array ou objeto aninhado: nenhum é teto válido.
      return false;
    end if;

    v_contagem := v_contagem + 1;
  end loop;

  -- No modo completo (parcial = false), o conjunto fechado inteiro precisa
  -- estar presente; no modo parcial (ajuste), qualquer subconjunto vale,
  -- inclusive vazio.
  if not parcial and v_contagem <> 7 then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.fn_billing_limites_validos(jsonb, boolean) is
  'Valida o objeto de tetos do plano (conjunto fechado de 7 chaves, valor null ou inteiro 0..2147483647). parcial=false exige as 7 chaves (plano); parcial=true aceita subconjunto, inclusive vazio (ajuste). EXCEÇÃO deliberada ao item 12: pura, não lê tabela nenhuma, e o CHECK que a chama roda no contexto de quem escreve (service_role), e por isso fica com o grant padrão de EXECUTE, sem revoke/grant explícito.';

-- ── 2. billing_plans: o catálogo, uma linha por VERSÃO ──
create table if not exists public.billing_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version integer not null default 1,
  active boolean not null default true,
  name text not null,
  for_sale boolean not null default false,
  price_monthly_cents integer not null,
  price_yearly_cents integer,
  grace_days integer not null default 7,
  limits jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_plans_code_formato check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint billing_plans_version_positiva check (version >= 1),
  constraint billing_plans_preco_mensal_nao_negativo check (price_monthly_cents >= 0),
  constraint billing_plans_preco_anual_nao_negativo check (price_yearly_cents is null or price_yearly_cents >= 0),
  constraint billing_plans_carencia_faixa check (grace_days between 0 and 90),
  constraint billing_plans_limites_completos check (public.fn_billing_limites_validos(limits, false)),
  constraint billing_plans_code_version_key unique (code, version)
);

-- Uma única versão ativa por code: mudar preço ou teto de um plano é criar
-- versão nova ativa e desativar a antiga, nunca editar a linha contratada.
create unique index if not exists billing_plans_code_ativo_unique
  on public.billing_plans (code)
  where active;

comment on table public.billing_plans is
  'Catálogo de planos (fase F1, nenhum limite bloqueia ainda). Uma linha por VERSÃO: mudar preço ou teto é nova versão ativa, a antiga fica active=false e continua servindo quem já contratou (billing_contracts.plan_id aponta para a versão, não para o code).';
comment on column public.billing_plans.limits is
  'Conjunto fechado de 7 chaves (funis, etapas_por_funil, leads, membros, conexoes, integracoes_webhook, tokens_ia_mes), todas presentes. Valor inteiro ou null (null = sem limite). Validado por fn_billing_limites_validos(limits, false).';

drop trigger if exists trg_billing_plans_updated_at on public.billing_plans;
create trigger trg_billing_plans_updated_at
  before update on public.billing_plans
  for each row execute function public.fn_set_updated_at();

-- ── 3. billing_contracts: a assinatura, uma linha por organização ──
create table if not exists public.billing_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null references public.billing_plans(id),
  status text not null default 'ativa',
  cycle text,
  gateway text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  asaas_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_contracts_status_check check (status in ('avaliacao', 'ativa', 'atrasada', 'suspensa', 'cancelada')),
  constraint billing_contracts_cycle_check check (cycle is null or cycle in ('monthly', 'yearly')),
  constraint billing_contracts_gateway_check check (gateway is null or gateway in ('asaas')),
  constraint billing_contracts_organization_id_key unique (organization_id)
);

comment on table public.billing_contracts is
  'A assinatura da organização: uma linha só, unique(organization_id). Aponta para a VERSÃO do plano (plan_id), não para o code: preço e tetos contratados ficam congelados mesmo se o plano ganhar versão nova. Histórico de troca fica na auditoria (app/actions/admin), não nesta tabela.';

drop trigger if exists trg_billing_contracts_updated_at on public.billing_contracts;
create trigger trg_billing_contracts_updated_at
  before update on public.billing_contracts
  for each row execute function public.fn_set_updated_at();

-- ── 4. billing_plan_adjustments: o ajuste manual por organização ──
create table if not exists public.billing_plan_adjustments (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  limits jsonb not null,
  note text,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_plan_adjustments_nota_tamanho check (note is null or char_length(note) <= 500),
  constraint billing_plan_adjustments_limites_parciais check (public.fn_billing_limites_validos(limits, true))
);

comment on table public.billing_plan_adjustments is
  'Ajuste manual do admin da plataforma por cima do plano contratado, uma linha por organização. Objeto PARCIAL: só as chaves sobrescritas (inclusive com valor null, que libera o limite). Chave ausente aqui herda o valor do plano. Apagar o ajuste inteiro é responsabilidade de fn_billing_ajustar_limites (delete da linha), não um limits={}: a linha só existe quando há algo a sobrepor.';

drop trigger if exists trg_billing_plan_adjustments_updated_at on public.billing_plan_adjustments;
create trigger trg_billing_plan_adjustments_updated_at
  before update on public.billing_plan_adjustments
  for each row execute function public.fn_set_updated_at();

-- ── 6. semeadura dos quatro planos ──
--
-- on conflict (code, version) do nothing: roda de novo a cada atualização de
-- produção (update.sh reaplica o baseline) e não pode sobrescrever um preço
-- que o admin já mudou depois de semear.
insert into public.billing_plans
  (code, version, active, name, for_sale, price_monthly_cents, price_yearly_cents, grace_days, limits)
values
  ('ilimitado', 1, true, 'Ilimitado', false, 0, null, 7, jsonb_build_object(
    'funis', null, 'etapas_por_funil', null, 'leads', null, 'membros', null,
    'conexoes', null, 'integracoes_webhook', null, 'tokens_ia_mes', null
  )),
  ('pro', 1, true, 'Pro', false, 19900, null, 7, jsonb_build_object(
    'funis', 5, 'etapas_por_funil', 10, 'leads', 5000, 'membros', 3,
    'conexoes', 3, 'integracoes_webhook', 3, 'tokens_ia_mes', 1000000
  )),
  ('max', 1, true, 'Max', false, 39900, null, 7, jsonb_build_object(
    'funis', 10, 'etapas_por_funil', 15, 'leads', 50000, 'membros', 15,
    'conexoes', 10, 'integracoes_webhook', 10, 'tokens_ia_mes', 1000000
  )),
  ('escale', 1, true, 'Escale', false, 59900, null, 7, jsonb_build_object(
    'funis', 25, 'etapas_por_funil', 20, 'leads', 100000, 'membros', 30,
    'conexoes', 20, 'integracoes_webhook', 20, 'tokens_ia_mes', 1000000
  ))
on conflict (code, version) do nothing;

-- ── 7. backfill: toda organização existente sem contrato ganha o Ilimitado ──
insert into public.billing_contracts (organization_id, plan_id, status)
select o.id, bp.id, 'ativa'
from public.organizations o
join public.billing_plans bp on bp.code = 'ilimitado' and bp.active
where not exists (
  select 1 from public.billing_contracts bc where bc.organization_id = o.id
)
on conflict (organization_id) do nothing;

-- ── 8. fn_billing_contrato_da_organizacao_nova + gatilho ──
--
-- Nome escolhido para não colidir com trg_seed_org_llm_defaults nem
-- trg_semear_tipos_de_agendamento, que já existem em organizations.
create or replace function public.fn_billing_contrato_da_organizacao_nova()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
begin
  select id into v_plan_id
  from public.billing_plans
  where code = 'ilimitado' and active
  limit 1;

  if v_plan_id is null then
    -- Sem Ilimitado ativo: não insere, avisa, e a criação da organização
    -- segue (nada nesta fase pode bloquear a criação de organização).
    raise warning 'billing_plano_ilimitado_ausente_na_criacao_da_organizacao';
    return new;
  end if;

  insert into public.billing_contracts (organization_id, plan_id, status)
  values (new.id, v_plan_id, 'ativa')
  on conflict (organization_id) do nothing;

  return new;
end;
$$;

revoke execute on function public.fn_billing_contrato_da_organizacao_nova() from public, anon, authenticated;
grant execute on function public.fn_billing_contrato_da_organizacao_nova() to service_role;

drop trigger if exists trg_billing_contrato_da_organizacao_nova on public.organizations;
create trigger trg_billing_contrato_da_organizacao_nova
  after insert on public.organizations
  for each row
  execute function public.fn_billing_contrato_da_organizacao_nova();

-- ── 9. fn_billing_limites_efetivos: a ÚNICA função de precedência ──
--
-- UMA consulta: o plano efetivo é o do contrato (se existir) ou, na
-- ausência de contrato, o Ilimitado ativo. Para cada uma das 7 chaves, o
-- ajuste vence quando a chave está PRESENTE no ajuste (mesmo com valor
-- null); senão vale o valor do plano.
create or replace function public.fn_billing_limites_efetivos(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'funis', case when aj.limits ? 'funis' then aj.limits -> 'funis' else pe.limits -> 'funis' end,
    'etapas_por_funil', case when aj.limits ? 'etapas_por_funil' then aj.limits -> 'etapas_por_funil' else pe.limits -> 'etapas_por_funil' end,
    'leads', case when aj.limits ? 'leads' then aj.limits -> 'leads' else pe.limits -> 'leads' end,
    'membros', case when aj.limits ? 'membros' then aj.limits -> 'membros' else pe.limits -> 'membros' end,
    'conexoes', case when aj.limits ? 'conexoes' then aj.limits -> 'conexoes' else pe.limits -> 'conexoes' end,
    'integracoes_webhook', case when aj.limits ? 'integracoes_webhook' then aj.limits -> 'integracoes_webhook' else pe.limits -> 'integracoes_webhook' end,
    'tokens_ia_mes', case when aj.limits ? 'tokens_ia_mes' then aj.limits -> 'tokens_ia_mes' else pe.limits -> 'tokens_ia_mes' end
  )
  from (
    select coalesce(
      (
        select bp.limits
        from public.billing_contracts bc
        join public.billing_plans bp on bp.id = bc.plan_id
        where bc.organization_id = p_org
      ),
      (
        select bp2.limits
        from public.billing_plans bp2
        where bp2.code = 'ilimitado' and bp2.active
      )
    ) as limits
  ) pe
  left join public.billing_plan_adjustments aj on aj.organization_id = p_org;
$$;

revoke execute on function public.fn_billing_limites_efetivos(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_limites_efetivos(uuid) to service_role;

-- ── 10. fn_billing_trocar_plano e fn_billing_ajustar_limites ──
--
-- Ambas: travam a linha existente (for update) ANTES de ler o "antes",
-- gravam, e leem o "depois" já persistido: o retorno reflete exatamente o
-- que ficou no banco, mesmo sob troca concorrente.
create or replace function public.fn_billing_trocar_plano(p_org uuid, p_plan_code text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
  v_antes_plan_code text;
  v_antes_plan_version integer;
  v_depois_plan_code text;
  v_depois_plan_version integer;
begin
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'organizacao_nao_encontrada' using errcode = 'P0002';
  end if;

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

  select bp.code, bp.version
    into v_antes_plan_code, v_antes_plan_version
  from public.billing_contracts bc
  join public.billing_plans bp on bp.id = bc.plan_id
  where bc.organization_id = p_org;

  insert into public.billing_contracts (organization_id, plan_id)
  values (p_org, v_plan_id)
  on conflict (organization_id) do update set plan_id = excluded.plan_id;

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
begin
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'organizacao_nao_encontrada' using errcode = 'P0002';
  end if;

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

  return jsonb_build_object('antes', v_antes, 'depois', v_depois);
end;
$$;

revoke execute on function public.fn_billing_ajustar_limites(uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_ajustar_limites(uuid, jsonb, text, uuid) to service_role;

-- ── 11. RLS: leitura por organização, nenhuma política de escrita ──
alter table public.billing_plans enable row level security;
alter table public.billing_contracts enable row level security;
alter table public.billing_plan_adjustments enable row level security;

drop policy if exists billing_plans_select on public.billing_plans;
create policy billing_plans_select on public.billing_plans
  for select using (true);

drop policy if exists billing_contracts_select on public.billing_contracts;
create policy billing_contracts_select on public.billing_contracts
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists billing_plan_adjustments_select on public.billing_plan_adjustments;
create policy billing_plan_adjustments_select on public.billing_plan_adjustments
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

-- ── 12. grants das três tabelas ──
--
-- anon perde tudo. authenticated perde TUDO e recebe de volta só o select,
-- filtrado pelas policies acima. Revogar só insert, update e delete deixava
-- truncate, references e trigger, que vêm no grant padrão do Supabase; e
-- truncate passa por cima da RLS. Só as funções desta migration, com
-- service_role, escrevem; service_role mantém acesso total.
revoke all on public.billing_plans, public.billing_contracts, public.billing_plan_adjustments from anon, authenticated;
grant select on public.billing_plans, public.billing_contracts, public.billing_plan_adjustments to authenticated;
grant all on public.billing_plans, public.billing_contracts, public.billing_plan_adjustments to service_role;
