-- 0905, uso dos planos e trava (fase F2, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F2-tarefas.md.
--
-- Objetivo da fase: o CRM passa a saber quanto cada organização usa de cada
-- item da matriz de planos, e cada item limitado ganha uma trava no banco.
-- Nesta fase a trava só avisa: quando a organização passa do teto, nasce um
-- aviso na Central e a operação segue. O bloqueio de verdade é da F3.
--
-- Esta migration (0905) tem duas partes. ESTA aplicação (Tarefa 2) traz só a
-- parte 1: configuração (billing_settings), contador materializado de leads
-- (billing_usage_counters) e as duas funções de leitura (fn_billing_uso,
-- fn_billing_pode_criar). Os gatilhos que de fato chamam a conferência do
-- teto e criam o aviso na Central são a Tarefa 3, ainda não escrita, e
-- entram depois neste mesmo arquivo.
--
-- billing_settings é linha única (id = 1, com check), modo de operação da
-- trava: desligado, avisar (default desta fase) ou bloquear (só funciona na
-- F3). Fica em tabela própria do fork, não em platform_settings do autor.
--
-- billing_usage_counters guarda, por organização e por item, um contador
-- materializado. Nesta fase só o item leads usa contador: os demais (funis,
-- etapas_por_funil, membros, conexoes, integracoes_webhook) são baratos de
-- contar com count(*) na hora, e leads muda com frequência alta demais (toda
-- troca de etapa) para valer a pena um count(*) a cada checagem.
--
-- fn_billing_uso e fn_billing_pode_criar são VOLATILE, não STABLE (decisão 9
-- da fase): uma função STABLE enxerga a foto de dados do início do comando
-- SQL que a chamou, e um funil criado com 20 etapas num INSERT só faria
-- fn_billing_pode_criar('etapas_por_funil') contar zero para todas.
--
-- Contagem de membros (decisão 3): membro ativo em user_organizations
-- (accepted_at preenchido, revoked_at nulo) que NÃO seja o admin provisório
-- (user_organizations.provisional_until_handover), mais convite pendente e
-- não vencido em team_invites (accepted_at nulo, revoked_at nulo, expires_at
-- no futuro). O admin provisório é quem segura a conta até o dono assumir, e
-- não ocupa vaga.
--
-- Permissões no mesmo molde da 0904: revoke all das duas origens públicas,
-- grant select em billing_usage_counters para authenticated (billing_settings
-- não tem grant nenhum, é assunto só do admin da plataforma e do worker de
-- cron), e as duas funções com execute só para service_role. Bloco final
-- revoga de agent_worker (se a role existir) a escrita nas tabelas novas e o
-- execute das funções novas: essa role tem bypassrls e ganharia os dois por
-- alter default privileges se este bloco não existisse.
--
-- Idempotente: create if not exists, create or replace, drop trigger if
-- exists antes de recriar, semeadura e preenchimento inicial com on conflict.

-- 1. billing_settings: configuração de operação da trava, linha única.
create table if not exists public.billing_settings (
  id integer primary key default 1,
  modo text not null default 'avisar',
  updated_at timestamptz not null default now(),
  constraint billing_settings_id_singleton check (id = 1),
  constraint billing_settings_modo_check check (modo in ('desligado', 'avisar', 'bloquear'))
);

comment on table public.billing_settings is
  'Configuração de operação da trava de planos (fase F2), linha única (id = 1). modo: desligado (nada roda), avisar (default desta fase, só cria aviso na Central) ou bloquear (só passa a bloquear de verdade na F3; nesta fase se comporta como avisar).';

drop trigger if exists trg_billing_settings_updated_at on public.billing_settings;
create trigger trg_billing_settings_updated_at
  before update on public.billing_settings
  for each row execute function public.fn_set_updated_at();

insert into public.billing_settings (id, modo)
values (1, 'avisar')
on conflict (id) do nothing;

-- 2. billing_usage_counters: contador materializado, só o item leads nesta fase.
create table if not exists public.billing_usage_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  item text not null,
  valor bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (organization_id, item),
  constraint billing_usage_counters_item_check check (item in ('leads')),
  constraint billing_usage_counters_valor_nao_negativo check (valor >= 0)
);

comment on table public.billing_usage_counters is
  'Contador materializado de uso por organização e item, só leads nesta fase (decisão 7 da fase F2: os demais itens são baratos de contar com count(*) na hora). Nunca fica negativo (constraint e, no gatilho da Tarefa 3, greatest(valor - 1, 0)); ao somar é upsert, ao subtrair é update simples, para exclusão em cascata da organização não recriar a linha no meio do delete.';

drop trigger if exists trg_billing_usage_counters_updated_at on public.billing_usage_counters;
create trigger trg_billing_usage_counters_updated_at
  before update on public.billing_usage_counters
  for each row execute function public.fn_set_updated_at();

-- Preenchimento inicial com a contagem REAL dos leads abertos de cada
-- organização. on conflict do update (não do nothing) para a migration ficar
-- idempotente por resultado: rodar de novo recalcula o valor real, não soma
-- nem duplica.
insert into public.billing_usage_counters (organization_id, item, valor)
select cl.organization_id, 'leads', count(*)
from public.crm_leads cl
where cl.status = 'open'
group by cl.organization_id
on conflict (organization_id, item) do update
  set valor = excluded.valor,
      updated_at = now();

-- 3. Permissões das duas tabelas novas, no molde da 0904: authenticated
-- perde tudo e recebe de volta só o select de billing_usage_counters
-- (política abaixo, leitura por organização ou admin da plataforma).
-- billing_settings não tem grant nenhum para authenticated: é assunto só do
-- admin da plataforma (via service_role) e do conferidor de cron (Tarefa 5).
alter table public.billing_settings enable row level security;
alter table public.billing_usage_counters enable row level security;

drop policy if exists billing_usage_counters_select on public.billing_usage_counters;
create policy billing_usage_counters_select on public.billing_usage_counters
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

revoke all on public.billing_settings, public.billing_usage_counters from anon, authenticated;
grant select on public.billing_usage_counters to authenticated;
grant all on public.billing_settings, public.billing_usage_counters to service_role;

-- 4. fn_billing_uso: o uso atual da organização, item a item.
--
-- etapas_por_funil aqui é o MAIOR número de etapas ativas entre os funis
-- ativos (decisão da Tarefa 2, item 4): um funil ativo sem nenhuma etapa
-- ativa entra na conta com zero, por isso o left join em vez de contar só
-- quem tem etapa.
create or replace function public.fn_billing_uso(p_org uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_funis bigint;
  v_etapas_por_funil bigint;
  v_leads bigint;
  v_membros bigint;
  v_conexoes bigint;
  v_integracoes_webhook bigint;
begin
  select count(*) into v_funis
  from public.crm_pipelines
  where organization_id = p_org and is_archived = false;

  select coalesce(max(t.qtd), 0) into v_etapas_por_funil
  from (
    select p.id, count(s.id) filter (where s.is_archived = false) as qtd
    from public.crm_pipelines p
    left join public.crm_stages s on s.pipeline_id = p.id
    where p.organization_id = p_org and p.is_archived = false
    group by p.id
  ) t;

  select coalesce(buc.valor, 0) into v_leads
  from public.billing_usage_counters buc
  where buc.organization_id = p_org and buc.item = 'leads';
  v_leads := coalesce(v_leads, 0);

  select
    (
      select count(*) from public.user_organizations uo
      where uo.organization_id = p_org
        and uo.accepted_at is not null
        and uo.revoked_at is null
        and not uo.provisional_until_handover
    )
    +
    (
      select count(*) from public.team_invites ti
      where ti.organization_id = p_org
        and ti.accepted_at is null
        and ti.revoked_at is null
        and ti.expires_at > now()
    )
  into v_membros;

  select count(*) into v_conexoes
  from public.channel_sessions
  where organization_id = p_org and archived_at is null;

  select count(*) into v_integracoes_webhook
  from public.webhook_sources
  where organization_id = p_org and is_active = true;

  return jsonb_build_object(
    'funis', v_funis,
    'etapas_por_funil', v_etapas_por_funil,
    'leads', v_leads,
    'membros', v_membros,
    'conexoes', v_conexoes,
    'integracoes_webhook', v_integracoes_webhook
  );
end;
$$;

comment on function public.fn_billing_uso(uuid) is
  'Uso atual da organização por item (funis, etapas_por_funil, leads, membros, conexoes, integracoes_webhook). VOLATILE de propósito (decisão 9 da fase F2): STABLE enxergaria a foto do início do comando e contaria errado dentro do mesmo INSERT que criou várias linhas.';

revoke execute on function public.fn_billing_uso(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_uso(uuid) to service_role;

-- 5. fn_billing_pode_criar: confere se a organização pode criar mais um item,
-- sem gravar nada (quem grava e cria o aviso é a função de conferência da
-- Tarefa 3, ainda não escrita). pode é falso só quando atual >= teto.
create or replace function public.fn_billing_pode_criar(p_org uuid, p_item text, p_pipeline uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tetos jsonb;
  v_teto integer;
  v_atual bigint;
  v_pode boolean;
  v_motivo text;
begin
  if p_item not in ('funis', 'etapas_por_funil', 'leads', 'membros', 'conexoes', 'integracoes_webhook') then
    raise exception 'billing_item_desconhecido' using errcode = '22023';
  end if;

  v_tetos := public.fn_billing_limites_efetivos(p_org);
  v_teto := (v_tetos ->> p_item)::integer;

  if v_teto is null then
    return jsonb_build_object('pode', true, 'motivo', 'sem_limite', 'atual', null, 'teto', null);
  end if;

  if p_item = 'funis' then
    select count(*) into v_atual
    from public.crm_pipelines
    where organization_id = p_org and is_archived = false;
  elsif p_item = 'etapas_por_funil' then
    if p_pipeline is null then
      raise exception 'billing_pipeline_obrigatorio_para_etapas_por_funil' using errcode = '22023';
    end if;

    select count(*) into v_atual
    from public.crm_stages
    where pipeline_id = p_pipeline and organization_id = p_org and is_archived = false;
  elsif p_item = 'leads' then
    select coalesce(valor, 0) into v_atual
    from public.billing_usage_counters
    where organization_id = p_org and item = 'leads';
    v_atual := coalesce(v_atual, 0);
  elsif p_item = 'membros' then
    select
      (
        select count(*) from public.user_organizations uo
        where uo.organization_id = p_org
          and uo.accepted_at is not null
          and uo.revoked_at is null
          and not uo.provisional_until_handover
      )
      +
      (
        select count(*) from public.team_invites ti
        where ti.organization_id = p_org
          and ti.accepted_at is null
          and ti.revoked_at is null
          and ti.expires_at > now()
      )
    into v_atual;
  elsif p_item = 'conexoes' then
    select count(*) into v_atual
    from public.channel_sessions
    where organization_id = p_org and archived_at is null;
  elsif p_item = 'integracoes_webhook' then
    select count(*) into v_atual
    from public.webhook_sources
    where organization_id = p_org and is_active = true;
  end if;

  v_pode := v_atual < v_teto;
  v_motivo := case when v_pode then 'ok' else 'teto_atingido' end;

  return jsonb_build_object('pode', v_pode, 'motivo', v_motivo, 'atual', v_atual, 'teto', v_teto);
end;
$$;

comment on function public.fn_billing_pode_criar(uuid, text, uuid) is
  'Confere se a organização pode criar mais um item do plano, sem gravar nada. pode=false só quando atual >= teto. motivo em ok, teto_atingido ou sem_limite. p_pipeline é obrigatório só para etapas_por_funil (conta as etapas ativas DESSE funil, diferente de fn_billing_uso, que devolve o maior entre todos os funis ativos). VOLATILE pela mesma razão de fn_billing_uso.';

revoke execute on function public.fn_billing_pode_criar(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_pode_criar(uuid, text, uuid) to service_role;

-- 6. agent_worker não escreve nem conta plano por fora das funções.
--
-- hiperbold/scripts/role-agent-worker.sql dá a esta role, por alter default
-- privileges, escrita em toda tabela nova e execute em toda função nova do
-- schema public, e ela tem bypassrls. Sem este bloco, a role burlaria a RLS
-- de billing_usage_counters e chamaria as funções de leitura direto. A role
-- pode não existir (o banco de teste do test:db não a cria).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke insert, update, delete, truncate on public.billing_settings, public.billing_usage_counters from agent_worker';
    execute 'revoke execute on function public.fn_billing_uso(uuid), public.fn_billing_pode_criar(uuid, text, uuid) from agent_worker';
  end if;
end
$$;
