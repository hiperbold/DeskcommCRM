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

-- ── Parte 2 (Tarefa 3): os gatilhos que avisam ──
--
-- A parte 1 (acima) trouxe a configuração, o contador materializado e as
-- duas funções de LEITURA (fn_billing_uso, fn_billing_pode_criar). Esta
-- parte 2 traz quem de fato CHAMA a conferência do teto na hora certa e cria
-- o aviso na Central: fn_billing_conferir_teto (a conferência central),
-- seis gatilhos de transição (crm_pipelines, crm_stages, channel_sessions,
-- webhook_sources, team_invites, user_organizations), o gatilho de leads
-- (decisão 6, o mais delicado: precisa enxergar a mudança de status feita
-- por OUTRO gatilho) e fn_billing_conferir_contadores (o conferidor diário
-- que a Tarefa 5 agenda).
--
-- Nesta fase a trava só AVISA (ver cabeçalho do arquivo): quando a
-- organização passa do teto, nasce um item na Central
-- (agent_inbox_items, kind='other', ref_kind='billing_limite') e a operação
-- do usuário segue normalmente. modo 'bloquear' se comporta como 'avisar'
-- nesta fase (decisão 4), com um raise warning a mais no log, para o dia em
-- que a F3 ligar o bloqueio de verdade ter como comparar.
--
-- Decisão 5: os seis gatilhos de transição são "before insert or update of
-- <coluna de estado>" e só chamam a conferência quando o item passa de
-- INATIVO para ATIVO: em insert, quando já nasce ativo; em update, quando o
-- valor antigo era inativo e o novo é ativo. Desarquivar, religar ou
-- readmitir passa pela MESMA checagem que criar; mudar qualquer outra coisa
-- (nome, posição, etc.) não dispara nada, porque o gatilho só existe na
-- coluna de estado.
--
-- Decisão 6: o gatilho de crm_leads é o único AFTER INSERT OR UPDATE OR
-- DELETE sem lista de colunas. Quem muda new.status na troca de etapa é
-- trg_crm_lead_close_on_stage (BEFORE, do autor, before insert or update of
-- stage_id): um gatilho AFTER com lista de colunas não vê uma mudança feita
-- por OUTRO gatilho, só o valor final da linha sem filtro de coluna resolve
-- isso. AFTER também resolve a ordem: o lead já está com o status FINAL
-- quando este gatilho roda.
--
-- Decisão 8: fn_billing_conferir_teto lê o modo e o teto efetivo (0904)
-- ANTES de pegar o pg_advisory_xact_lock pela chave (organização, item):
-- modo desligado ou sem teto sai sem travar e sem contar (hoje toda
-- organização está no Ilimitado, e travar sem teto serializaria à toa toda
-- criação da organização).
--
-- Decisão 9: a checagem sob a trava reaproveita fn_billing_pode_criar (já
-- VOLATILE, Tarefa 2), então um funil criado com 20 etapas num INSERT só
-- conta certo etapa a etapa, não a foto do início do comando.
--
-- Decisão 11: nada aqui derruba a operação do usuário.
-- fn_billing_conferir_teto e o gatilho de leads capturam qualquer erro e
-- seguem com raise warning. O contador nunca fica negativo
-- (greatest(valor - 1, 0)) e só nasce por upsert ao SOMAR; ao subtrair é só
-- update, para a exclusão em cascata de uma organização não recriar a linha
-- do contador no meio do delete. Os seis gatilhos de transição não têm
-- exception block próprio: eles só leem campos booleanos/timestamp da
-- própria linha (nunca falha) e delegam tudo que pode falhar para
-- fn_billing_conferir_teto, que já captura.
--
-- Decisão 12: o aviso é deduplicado por organização + ref_kind
-- ('billing_limite') + título (fixo por item) ENQUANTO status = 'open': um
-- aviso já resolvido não impede um aviso NOVO nascer depois.
--
-- Nomes de gatilho conferidos contra o catálogo antes de escrever (nenhum
-- colide): crm_pipelines tinha só trg_crm_pipelines_updated_at; crm_stages
-- só trg_crm_stages_updated_at; crm_leads tinha
-- trg_crm_lead_close_on_stage, trg_crm_leads_updated_at,
-- trg_emit_event_on_lead_change, trg_stamp_stage_changed_at e
-- trg_validate_lost_reason_required; team_invites só
-- trg_team_invites_updated_at; user_organizations tinha
-- trg_adotar_tipos_de_agendamento_sem_dono, trg_routing_member_revoked e
-- trg_user_orgs_touch; channel_sessions tinha
-- trg_channel_sessions_status_audit, trg_channel_sessions_updated_at e
-- trg_reply_channel_revision; webhook_sources não tinha nenhum. Os nomes
-- novos, todos com o prefixo trg_billing_trava_<tabela> (ou
-- trg_billing_trava_crm_leads), não aparecem em nenhuma das listas acima.
--
-- Idempotente: create or replace, drop trigger if exists antes de recriar.

-- 7. fn_billing_conferir_teto: a conferência central de todo gatilho de plano.
create or replace function public.fn_billing_conferir_teto(p_org uuid, p_item text, p_pipeline uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_teto integer;
  v_resultado jsonb;
  v_titulo text;
begin
  select modo into v_modo from public.billing_settings where id = 1;

  if v_modo is null or v_modo = 'desligado' then
    return;
  end if;

  v_teto := (public.fn_billing_limites_efetivos(p_org) ->> p_item)::integer;

  if v_teto is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text || ':' || p_item, 0));

  v_resultado := public.fn_billing_pode_criar(p_org, p_item, p_pipeline);

  if (v_resultado ->> 'pode')::boolean then
    return;
  end if;

  if v_modo = 'bloquear' then
    raise warning 'billing_teto_ultrapassado_bloquearia_na_f3: organizacao=%, item=%, atual=%, teto=%',
      p_org, p_item, v_resultado ->> 'atual', v_resultado ->> 'teto';
  end if;

  v_titulo := case p_item
    when 'funis' then 'Limite de funis do plano atingido'
    when 'etapas_por_funil' then 'Limite de etapas por funil do plano atingido'
    when 'leads' then 'Limite de leads abertos do plano atingido'
    when 'membros' then 'Limite de membros do plano atingido'
    when 'conexoes' then 'Limite de conexões do plano atingido'
    when 'integracoes_webhook' then 'Limite de integrações de webhook do plano atingido'
    else 'Limite do plano atingido'
  end;

  if not exists (
    select 1 from public.agent_inbox_items
    where organization_id = p_org
      and kind = 'other'
      and ref_kind = 'billing_limite'
      and title = v_titulo
      and status = 'open'
  ) then
    insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
    values (
      p_org,
      'other',
      'warn',
      v_titulo,
      'Esta organização passou do limite contratado para este item do plano. Nesta fase nada é bloqueado; veja Configurações › Plano e uso.',
      'billing_limite',
      p_org
    );
  end if;
exception
  when others then
    raise warning 'billing_conferir_teto_falhou: organizacao=%, item=%, sqlerrm=%', p_org, p_item, sqlerrm;
end;
$$;

comment on function public.fn_billing_conferir_teto(uuid, text, uuid) is
  'Conferência central chamada por todo gatilho de plano (Tarefa 3, decisão 8): lê o modo e o teto efetivo ANTES de travar, desligado ou sem teto sai sem lock nem contagem. Com teto, pg_advisory_xact_lock por (organização, item), confere via fn_billing_pode_criar já sob a trava, e cria o aviso da Central (decisão 12) quando passou. modo bloquear se comporta como avisar nesta fase (a F3 bloqueia de verdade), com um raise warning a mais. Nunca lança: qualquer erro vira raise warning (decisão 11).';

revoke execute on function public.fn_billing_conferir_teto(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_conferir_teto(uuid, text, uuid) to service_role;

-- 8. Os seis gatilhos de transição (decisão 5).

-- 8a. crm_pipelines (is_archived) → item funis.
create or replace function public.fn_billing_trava_crm_pipelines()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_archived = false then
      perform public.fn_billing_conferir_teto(new.organization_id, 'funis', null);
    end if;
  elsif old.is_archived = true and new.is_archived = false then
    perform public.fn_billing_conferir_teto(new.organization_id, 'funis', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_crm_pipelines() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(funis) só na transição de is_archived para false, em insert ou update.';

revoke execute on function public.fn_billing_trava_crm_pipelines() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_crm_pipelines() to service_role;

drop trigger if exists trg_billing_trava_crm_pipelines on public.crm_pipelines;
create trigger trg_billing_trava_crm_pipelines
  before insert or update of is_archived on public.crm_pipelines
  for each row
  execute function public.fn_billing_trava_crm_pipelines();

-- 8b. crm_stages (is_archived, com pipeline_id) → item etapas_por_funil.
create or replace function public.fn_billing_trava_crm_stages()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_archived = false then
      perform public.fn_billing_conferir_teto(new.organization_id, 'etapas_por_funil', new.pipeline_id);
    end if;
  elsif old.is_archived = true and new.is_archived = false then
    perform public.fn_billing_conferir_teto(new.organization_id, 'etapas_por_funil', new.pipeline_id);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_crm_stages() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(etapas_por_funil, pipeline_id) só na transição de is_archived para false, em insert ou update. Um INSERT com várias etapas dispara este gatilho uma vez por linha, e cada chamada conta as etapas já commitadas antes dela no mesmo comando (prova do VOLATILE, decisão 9).';

revoke execute on function public.fn_billing_trava_crm_stages() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_crm_stages() to service_role;

drop trigger if exists trg_billing_trava_crm_stages on public.crm_stages;
create trigger trg_billing_trava_crm_stages
  before insert or update of is_archived on public.crm_stages
  for each row
  execute function public.fn_billing_trava_crm_stages();

-- 8c. channel_sessions (archived_at) → item conexoes.
create or replace function public.fn_billing_trava_channel_sessions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.archived_at is null then
      perform public.fn_billing_conferir_teto(new.organization_id, 'conexoes', null);
    end if;
  elsif old.archived_at is not null and new.archived_at is null then
    perform public.fn_billing_conferir_teto(new.organization_id, 'conexoes', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_channel_sessions() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(conexoes) só na transição de archived_at para null, em insert ou update.';

revoke execute on function public.fn_billing_trava_channel_sessions() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_channel_sessions() to service_role;

drop trigger if exists trg_billing_trava_channel_sessions on public.channel_sessions;
create trigger trg_billing_trava_channel_sessions
  before insert or update of archived_at on public.channel_sessions
  for each row
  execute function public.fn_billing_trava_channel_sessions();

-- 8d. webhook_sources (is_active) → item integracoes_webhook.
create or replace function public.fn_billing_trava_webhook_sources()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_active = true then
      perform public.fn_billing_conferir_teto(new.organization_id, 'integracoes_webhook', null);
    end if;
  elsif old.is_active = false and new.is_active = true then
    perform public.fn_billing_conferir_teto(new.organization_id, 'integracoes_webhook', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_webhook_sources() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(integracoes_webhook) só na transição de is_active para true, em insert ou update.';

revoke execute on function public.fn_billing_trava_webhook_sources() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_webhook_sources() to service_role;

drop trigger if exists trg_billing_trava_webhook_sources on public.webhook_sources;
create trigger trg_billing_trava_webhook_sources
  before insert or update of is_active on public.webhook_sources
  for each row
  execute function public.fn_billing_trava_webhook_sources();

-- 8e. team_invites (nasce pendente) → item membros.
create or replace function public.fn_billing_trava_team_invites()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.accepted_at is null and new.revoked_at is null and new.expires_at > now() then
    perform public.fn_billing_conferir_teto(new.organization_id, 'membros', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_team_invites() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(membros) quando o convite nasce pendente e não vencido. team_invites não tem gatilho de UPDATE: um convite pendente só deixa de contar por aceite (vira user_organizations, contado por outro gatilho) ou revogação, nunca volta a ficar pendente depois.';

revoke execute on function public.fn_billing_trava_team_invites() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_team_invites() to service_role;

drop trigger if exists trg_billing_trava_team_invites on public.team_invites;
create trigger trg_billing_trava_team_invites
  before insert on public.team_invites
  for each row
  execute function public.fn_billing_trava_team_invites();

-- 8f. user_organizations (accepted_at, revoked_at) → item membros. O admin
-- provisório (provisional_until_handover) nunca conta como ativo, mesmo com
-- accepted_at preenchido e revoked_at nulo (decisão 3, 0904/0905 parte 1).
create or replace function public.fn_billing_trava_user_organizations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_novo_ativo boolean;
  v_antigo_ativo boolean;
begin
  v_novo_ativo := new.accepted_at is not null and new.revoked_at is null and not new.provisional_until_handover;

  if tg_op = 'INSERT' then
    v_antigo_ativo := false;
  else
    v_antigo_ativo := old.accepted_at is not null and old.revoked_at is null and not old.provisional_until_handover;
  end if;

  if v_novo_ativo and not v_antigo_ativo then
    perform public.fn_billing_conferir_teto(new.organization_id, 'membros', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_user_organizations() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(membros) na transição para ativo (accepted_at preenchido, revoked_at nulo, provisional_until_handover falso), cobrindo aceite direto, readmissão de revogado e insert já ativo. O admin provisório nunca conta.';

revoke execute on function public.fn_billing_trava_user_organizations() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_user_organizations() to service_role;

drop trigger if exists trg_billing_trava_user_organizations on public.user_organizations;
create trigger trg_billing_trava_user_organizations
  before insert or update of accepted_at, revoked_at on public.user_organizations
  for each row
  execute function public.fn_billing_trava_user_organizations();

-- 9. crm_leads (decisão 6): after insert or update or delete, SEM lista de
-- colunas. Mantém billing_usage_counters (item leads) e confere o teto só
-- quando SOMOU.
create or replace function public.fn_billing_trava_crm_leads()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_status_antigo text;
  v_status_novo text;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_status_antigo := old.status;
    v_status_novo := null;
  else
    v_org := new.organization_id;
    v_status_novo := new.status;
    v_status_antigo := case when tg_op = 'UPDATE' then old.status else null end;
  end if;

  if v_status_antigo is not distinct from v_status_novo then
    return null;
  end if;

  if v_status_novo = 'open' then
    insert into public.billing_usage_counters (organization_id, item, valor)
    values (v_org, 'leads', 1)
    on conflict (organization_id, item) do update
      set valor = public.billing_usage_counters.valor + 1,
          updated_at = now();

    perform public.fn_billing_conferir_teto(v_org, 'leads', null);
  elsif v_status_antigo = 'open' then
    update public.billing_usage_counters
      set valor = greatest(valor - 1, 0),
          updated_at = now()
      where organization_id = v_org and item = 'leads';
  end if;

  return null;
exception
  when others then
    raise warning 'billing_trava_crm_leads_falhou: organizacao=%, sqlerrm=%', v_org, sqlerrm;
    return null;
end;
$$;

comment on function public.fn_billing_trava_crm_leads() is
  'Gatilho de plano (Tarefa 3, decisão 6): after insert/update/delete SEM lista de colunas em crm_leads, porque trg_crm_lead_close_on_stage (before, do autor) muda o status na troca de etapa e um gatilho com lista de colunas não veria essa mudança; só o valor final da linha resolve. Mantém billing_usage_counters (item leads) por upsert ao somar e update simples (greatest(valor - 1, 0)) ao subtrair, nunca recriando a linha na subtração (decisão 11, exclusão em cascata de organização). Confere o teto só quando somou. Captura qualquer erro (decisão 11).';

revoke execute on function public.fn_billing_trava_crm_leads() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_crm_leads() to service_role;

drop trigger if exists trg_billing_trava_crm_leads on public.crm_leads;
create trigger trg_billing_trava_crm_leads
  after insert or update or delete on public.crm_leads
  for each row
  execute function public.fn_billing_trava_crm_leads();

-- 10. fn_billing_conferir_contadores: o conferidor diário (chamado pela
-- Tarefa 5, ainda não escrita). Por organização com contador de leads, TRAVA
-- a linha (select ... for update) e só DEPOIS, num comando SEGUINTE, conta os
-- leads abertos de verdade e corrige, nunca no mesmo comando que travou,
-- senão o count enxergaria a mesma foto de dados de quando a trava foi
-- pega, e uma escrita concorrente que esperou a trava passaria batida.
-- Devolve quantos contadores divergiam.
create or replace function public.fn_billing_conferir_contadores()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_org record;
  v_real bigint;
  v_divergiam integer := 0;
begin
  for v_org in
    select organization_id
    from public.billing_usage_counters
    where item = 'leads'
    order by organization_id
  loop
    perform 1
      from public.billing_usage_counters
      where organization_id = v_org.organization_id and item = 'leads'
      for update;

    select count(*) into v_real
      from public.crm_leads
      where organization_id = v_org.organization_id and status = 'open';

    update public.billing_usage_counters
      set valor = v_real, updated_at = now()
      where organization_id = v_org.organization_id
        and item = 'leads'
        and valor <> v_real;

    if found then
      v_divergiam := v_divergiam + 1;
    end if;
  end loop;

  return v_divergiam;
end;
$$;

comment on function public.fn_billing_conferir_contadores() is
  'Conferidor diário (Tarefa 5) de billing_usage_counters (item leads): por organização, trava a linha (for update) e só num comando SEGUINTE conta os leads abertos e corrige, para não enxergar a mesma foto do momento da trava. Devolve quantos contadores estavam divergentes.';

revoke execute on function public.fn_billing_conferir_contadores() from public, anon, authenticated;
grant execute on function public.fn_billing_conferir_contadores() to service_role;

-- 11. agent_worker não confere nem trava plano pelos gatilhos e funções
-- novos desta parte 2 (mesmo racional do bloco 6 da parte 1, acima): por
-- alter default privileges ela ganharia execute em toda função nova do
-- schema public, e tem bypassrls.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_conferir_teto(uuid, text, uuid), public.fn_billing_trava_crm_pipelines(), public.fn_billing_trava_crm_stages(), public.fn_billing_trava_channel_sessions(), public.fn_billing_trava_webhook_sources(), public.fn_billing_trava_team_invites(), public.fn_billing_trava_user_organizations(), public.fn_billing_trava_crm_leads(), public.fn_billing_conferir_contadores() from agent_worker';
  end if;
end
$$;
