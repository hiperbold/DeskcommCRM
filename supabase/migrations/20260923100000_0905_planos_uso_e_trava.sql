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
-- Esta migration (0905) tem três partes. Parte 1 (Tarefa 2): configuração
-- (billing_settings), contador materializado de leads
-- (billing_usage_counters) e as duas funções de leitura (fn_billing_uso,
-- fn_billing_pode_criar). Parte 2 (Tarefa 3): os gatilhos que chamam a
-- conferência do teto e criam o aviso na Central. Parte 3 (Tarefa 4): o teto
-- técnico de 10 conexões MCP por organização (D-034), que não é item de plano.
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
--
-- D-053 (2), revisitado na revisão pós-auditoria da F3 (achado baixo 5): a
-- correção 1 daquela revisão (fn_billing_bloqueio_ativo, ver 0907 e o
-- comentário editado NO LUGAR em fn_billing_trava_crm_leads, logo abaixo) só
-- muda QUAL gatilho soma um lead durante a operação normal do banco; não
-- toca em NADA deste `insert ... select ... on conflict` de preenchimento
-- inicial, que roda toda vez que esta migration (ou o baseline.sql inteiro)
-- é reaplicada em produção. A janela continua existindo tal como o D-053
-- descreveu: sem `select ... for update` nem trava nenhuma entre a FOTO
-- (`count(*)` desta consulta) e a ESCRITA (o upsert), um lead confirmado
-- exatamente nesse intervalo pode ficar de fora da contagem recalculada até
-- fn_billing_conferir_contador (o conferidor diário) corrigir. Registrado
-- como D-063 em hiperbold/DEBITO.md (a correção 1 não fecha esta janela,
-- fecha uma OUTRA, de deadlock em operação normal, ver D-062).
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
    -- Achado B5 (revisão fase F2): antes bastava ser membro (fn_user_org_ids)
    -- para ler o contador; um agente com visibilidade "só os meus leads"
    -- descobria o total aberto da empresa. fn_role_at_least já confere
    -- pertencimento à organização (fn_user_role_in_org devolve null para
    -- quem não é membro, e a comparação de nível cai no coalesce false).
    public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin()
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
      -- Fase F3 (migration 0907, decisão 4, último parágrafo): sem o filtro
      -- de fn_billing_convite_ja_tem_vinculo_ativo, o instante do aceite (o
      -- convite ainda pendente, aplicar-convite.ts só marca accepted_at
      -- DEPOIS do RPC, mais o vínculo já ativo) contaria o MESMO ocupante
      -- duas vezes.
      select count(*) from public.team_invites ti
      where ti.organization_id = p_org
        and ti.accepted_at is null
        and ti.revoked_at is null
        and ti.expires_at > now()
        and not public.fn_billing_convite_ja_tem_vinculo_ativo(ti.id)
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
-- sem gravar nada (quem grava e cria o aviso é fn_billing_conferir_teto, da
-- parte 2). pode é falso só quando atual >= teto.
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
        -- Fase F3 (migration 0907, decisão 4, último parágrafo): mesmo filtro
        -- de fn_billing_uso, acima, para o instante do aceite não contar o
        -- mesmo ocupante duas vezes (convite ainda pendente + vínculo já
        -- ativo).
        select count(*) from public.team_invites ti
        where ti.organization_id = p_org
          and ti.accepted_at is null
          and ti.revoked_at is null
          and ti.expires_at > now()
          and not public.fn_billing_convite_ja_tem_vinculo_ativo(ti.id)
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
-- por OUTRO gatilho) e fn_billing_conferir_contador (o conferidor diário,
-- uma organização por chamada, que a Tarefa 5 agenda).
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
      -- Fase F3 (migration 0907, editado NO LUGAR aqui, decisão 3): o
      -- bloqueio roda ANTES do aviso, na MESMA transição. fn_billing_bloqueia
      -- só nasce na 0907, depois desta 0905 tanto no baseline quanto na
      -- ordem real de aplicação: a chamada só é resolvida em tempo de
      -- EXECUÇÃO (plpgsql não confere a existência de função chamada na hora
      -- de CRIAR esta função, só na hora de CHAMAR), e nenhum insert/update
      -- de crm_pipelines acontece durante a aplicação das migrations. No
      -- modo avisar/desligado, fn_billing_bloqueia sai sem travar (lê o modo
      -- antes do lock): zero custo a mais enquanto a F3 não for ligada.
      --
      -- Fase F4 (migration 0908, decisão 7, editado NO LUGAR aqui): recusa
      -- por modo leitura, ANTES do bloqueio de teto, na MESMA transição.
      -- fn_billing_modo_leitura só nasce na 0908, depois desta 0905 (mesma
      -- resolução em tempo de EXECUÇÃO de fn_billing_bloqueia, acima). PT402
      -- com detail='assinatura_suspensa', FORA de qualquer bloco exception.
      if public.fn_billing_modo_leitura(new.organization_id) then
        raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
      end if;
      if public.fn_billing_bloqueia(new.organization_id, 'funis', null) then
        raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'funis';
      end if;
      perform public.fn_billing_conferir_teto(new.organization_id, 'funis', null);
    end if;
  elsif old.is_archived = true and new.is_archived = false then
    -- Achado B4.1 (revisão fase F2): desarquivar reativa TAMBÉM as etapas
    -- ativas deste funil, que não passaram por nenhum insert agora (elas já
    -- existiam, arquivadas junto do funil), sem esta linha etapas_por_funil
    -- nunca era conferido nesta transição.
    --
    -- Fase F4 (migration 0908, decisão 7): mesmo padrão acima.
    if public.fn_billing_modo_leitura(new.organization_id) then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'funis', null) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'funis';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'funis', null);

    if public.fn_billing_modo_leitura(new.organization_id) then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'etapas_por_funil', new.id) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'etapas_por_funil';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'etapas_por_funil', new.id);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_crm_pipelines() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(funis) só na transição de is_archived para false, em insert ou update. Achado B4.1 (revisão fase F2): a transição de desarquivar TAMBÉM confere etapas_por_funil do próprio funil, porque as etapas ativas dele reaparecem sem passar por nenhum insert em crm_stages. Fase F3 (migration 0907): antes de cada conferência de aviso, fn_billing_bloqueia decide o bloqueio de verdade; PT402 fora de qualquer bloco exception. Fase F4 (migration 0908, decisão 7): antes do bloqueio de teto, fn_billing_modo_leitura recusa com PT402/assinatura_suspensa quando a conta está no modo leitura.';

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
      -- Fase F3 (migration 0907): mesmo padrão de fn_billing_trava_crm_pipelines.
      -- Fase F4 (migration 0908, decisão 7): recusa por modo leitura ANTES do
      -- bloqueio de teto, mesmo padrão de fn_billing_trava_crm_pipelines.
      if public.fn_billing_modo_leitura(new.organization_id) then
        raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
      end if;
      if public.fn_billing_bloqueia(new.organization_id, 'etapas_por_funil', new.pipeline_id) then
        raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'etapas_por_funil';
      end if;
      perform public.fn_billing_conferir_teto(new.organization_id, 'etapas_por_funil', new.pipeline_id);
    end if;
  elsif old.is_archived = true and new.is_archived = false then
    if public.fn_billing_modo_leitura(new.organization_id) then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'etapas_por_funil', new.pipeline_id) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'etapas_por_funil';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'etapas_por_funil', new.pipeline_id);
  elsif new.is_archived = false and new.pipeline_id is distinct from old.pipeline_id then
    -- Achado B4.2 (revisão fase F2): mover uma etapa ATIVA para outro funil
    -- muda a contagem de etapas_por_funil do funil de DESTINO sem passar por
    -- insert nem por is_archived, sem este ramo a transição não disparava
    -- conferência nenhuma. Etapa arquivada mudando de funil não conta (não
    -- está ativa em nenhum dos dois).
    if public.fn_billing_modo_leitura(new.organization_id) then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'etapas_por_funil', new.pipeline_id) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'etapas_por_funil';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'etapas_por_funil', new.pipeline_id);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_crm_stages() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(etapas_por_funil, pipeline_id) na transição de is_archived para false (insert ou update) e, achado B4.2 (revisão fase F2), quando uma etapa ATIVA muda de pipeline_id (confere o funil de DESTINO). Um INSERT com várias etapas dispara este gatilho uma vez por linha, e cada chamada conta as etapas já commitadas antes dela no mesmo comando (prova do VOLATILE, decisão 9). Fase F3 (migration 0907): fn_billing_bloqueia antes de cada conferência de aviso, PT402 fora de bloco exception. Fase F4 (migration 0908, decisão 7): antes do bloqueio de teto, fn_billing_modo_leitura recusa com PT402/assinatura_suspensa quando a conta está no modo leitura.';

revoke execute on function public.fn_billing_trava_crm_stages() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_crm_stages() to service_role;

drop trigger if exists trg_billing_trava_crm_stages on public.crm_stages;
create trigger trg_billing_trava_crm_stages
  before insert or update of is_archived, pipeline_id on public.crm_stages
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
      -- Fase F3 (migration 0907): mesmo padrão de fn_billing_trava_crm_pipelines.
      if public.fn_billing_bloqueia(new.organization_id, 'conexoes', null) then
        raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'conexoes';
      end if;
      perform public.fn_billing_conferir_teto(new.organization_id, 'conexoes', null);
    end if;
  elsif old.archived_at is not null and new.archived_at is null then
    if public.fn_billing_bloqueia(new.organization_id, 'conexoes', null) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'conexoes';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'conexoes', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_channel_sessions() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(conexoes) só na transição de archived_at para null, em insert ou update. Fase F3 (migration 0907): fn_billing_bloqueia antes de cada conferência de aviso, PT402 fora de bloco exception.';

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
      -- Fase F3 (migration 0907): mesmo padrão de fn_billing_trava_crm_pipelines.
      -- Fase F4 (migration 0908, decisão 7): recusa por modo leitura ANTES do
      -- bloqueio de teto, mesmo padrão de fn_billing_trava_crm_pipelines.
      if public.fn_billing_modo_leitura(new.organization_id) then
        raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
      end if;
      if public.fn_billing_bloqueia(new.organization_id, 'integracoes_webhook', null) then
        raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'integracoes_webhook';
      end if;
      perform public.fn_billing_conferir_teto(new.organization_id, 'integracoes_webhook', null);
    end if;
  elsif old.is_active = false and new.is_active = true then
    if public.fn_billing_modo_leitura(new.organization_id) then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'integracoes_webhook', null) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'integracoes_webhook';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'integracoes_webhook', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_webhook_sources() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(integracoes_webhook) só na transição de is_active para true, em insert ou update. Fase F3 (migration 0907): fn_billing_bloqueia antes de cada conferência de aviso, PT402 fora de bloco exception. Fase F4 (migration 0908, decisão 7): antes do bloqueio de teto, fn_billing_modo_leitura recusa com PT402/assinatura_suspensa quando a conta está no modo leitura.';

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
declare
  v_novo_pendente boolean;
  v_antigo_pendente boolean;
begin
  v_novo_pendente := new.accepted_at is null and new.revoked_at is null and new.expires_at > now();

  if tg_op = 'INSERT' then
    v_antigo_pendente := false;
  else
    v_antigo_pendente := old.accepted_at is null and old.revoked_at is null and old.expires_at > now();
  end if;

  -- Fase F3 (migration 0907, correção A3 pós-auditoria, achado alto): trocar
  -- o e-mail OU a organização de um convite JÁ pendente reciclava a vaga sem
  -- passar por conferência nenhuma, porque só expires_at/revoked_at/
  -- accepted_at eram vigiados (e nenhum dos três muda numa simples troca de
  -- e-mail). Pendente ANTES e DEPOIS, mas e-mail ou organização mudou: trata
  -- como convite NOVO, forçando v_antigo_pendente a false para cair no MESMO
  -- ramo de bloqueio e aviso do "if" abaixo (a organização de destino é
  -- sempre new.organization_id, então uma troca de organização também
  -- confere o teto da organização certa).
  if tg_op = 'UPDATE' and v_novo_pendente and v_antigo_pendente
    and (new.email is distinct from old.email or new.organization_id is distinct from old.organization_id)
  then
    v_antigo_pendente := false;
  end if;

  if v_novo_pendente and not v_antigo_pendente then
    -- Fase F3 (migration 0907, editado NO LUGAR aqui, decisão 4, item 1):
    -- mesmo padrão dos quatro gatilhos da decisão 3 (funis, etapas, conexões,
    -- webhooks). Convite novo pendente, ou renovado que volta a pendente, ou
    -- que teve e-mail/organização trocados enquanto pendente (correção A3,
    -- acima), ocupa uma vaga de membro: bloqueia igual, SEM isenção nenhuma
    -- (as isenções da decisão 4 são só para o ACEITE, em user_organizations,
    -- abaixo). "Aceite de convite nunca bloqueia" não é "emitir convite nunca
    -- bloqueia": o convite em si é quem cria a vaga a ocupar.
    --
    -- Fase F4 (migration 0908, decisão 7, editado NO LUGAR aqui): recusa por
    -- modo leitura ANTES do bloqueio de teto, mesmo padrão dos outros três
    -- gatilhos (funis, etapas, integrações webhook). Convite novo é criação,
    -- não aceite: a isenção de aceite (decisão 4, em user_organizations) não
    -- vale aqui.
    if public.fn_billing_modo_leitura(new.organization_id) then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'membros', null) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'membros';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'membros', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_team_invites() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(membros) na transição para pendente e não vencido. Achado B1 (revisão fase F2): reenviar um convite (emitirConvite/reenviarConvite, lib/team/convites.ts) faz UPDATE de expires_at/revoked_at/accepted_at na MESMA linha, inclusive vencida, o comentário antigo ("nunca volta a ficar pendente depois") estava errado, e por isso o gatilho passou a ser before insert or update dessas três colunas, conferindo só na transição de NÃO pendente para pendente (nunca ao só renovar um convite que já estava pendente). Fase F3 (migration 0907, decisão 4, item 1): fn_billing_bloqueia antes da conferência de aviso, sem isenção nenhuma (as isenções são só no ACEITE); PT402 fora de qualquer bloco exception. Correção A3 pós-auditoria (achado alto): a lista de colunas do GATILHO ganhou email e organization_id, e o corpo trata a troca de qualquer um dos dois num convite que continua pendente como convite NOVO (força v_antigo_pendente a false), senão trocar o e-mail de um convite pendente reciclava a vaga sem bloqueio nem aviso. Fase F4 (migration 0908, decisão 7): antes do bloqueio de teto, fn_billing_modo_leitura recusa com PT402/assinatura_suspensa quando a conta está no modo leitura (o convite em si, não o aceite).';

revoke execute on function public.fn_billing_trava_team_invites() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_team_invites() to service_role;

drop trigger if exists trg_billing_trava_team_invites on public.team_invites;
create trigger trg_billing_trava_team_invites
  -- Correção A3 pós-auditoria: email e organization_id entraram na lista (o
  -- corpo da função, acima, é quem decide se a troca de qualquer um dos dois
  -- conta como convite novo; um "of" mais curto deixava a troca passar sem
  -- disparar o gatilho nenhuma vez).
  before insert or update of expires_at, revoked_at, accepted_at, email, organization_id on public.team_invites
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
  v_invited_by_antigo uuid;
  v_invited_at_antigo timestamptz;
begin
  v_novo_ativo := new.accepted_at is not null and new.revoked_at is null and not new.provisional_until_handover;

  if tg_op = 'INSERT' then
    v_antigo_ativo := false;
    v_invited_by_antigo := null;
    v_invited_at_antigo := null;
  else
    v_antigo_ativo := old.accepted_at is not null and old.revoked_at is null and not old.provisional_until_handover;
    v_invited_by_antigo := old.invited_by;
    v_invited_at_antigo := old.invited_at;
  end if;

  if v_novo_ativo and not v_antigo_ativo then
    -- Fase F3 (migration 0907, editado NO LUGAR aqui, decisão 4, item 2):
    -- "aceite de convite nunca bloqueia". Três isenções, cada uma numa função
    -- pequena e testável (racional completo no cabeçalho da migration 0907,
    -- parte 2): (1) fn_billing_convite_pendente_do_membro, existe convite
    -- pendente e válido para o e-mail deste usuário nesta organização (cobre
    -- o aceite comum e a readmissão de revogado com convite pendente); (2)
    -- fn_billing_veio_de_aceite_de_convite, o vínculo nasceu dentro de
    -- fn_accept_team_invite mesmo sem linha de convite (token antigo),
    -- comparando invited_by/invited_at novo x antigo sem editar aquela
    -- função; (3) fn_billing_dono_do_provisionamento, o dono do signup
    -- self-service (lib/auth/provision.ts) que criou a própria organização.
    -- O provisório nem chega aqui: v_novo_ativo já é falso para ele (decisão
    -- 4, "nunca conta e nunca bloqueia", sem mudança nesta fase).
    if not (
      public.fn_billing_convite_pendente_do_membro(new.organization_id, new.user_id)
      or public.fn_billing_veio_de_aceite_de_convite(
        new.invited_by, new.invited_at, v_invited_by_antigo, v_invited_at_antigo, tg_op = 'INSERT'
      )
      or public.fn_billing_dono_do_provisionamento(new.organization_id, new.user_id, new.role)
    ) then
      if public.fn_billing_bloqueia(new.organization_id, 'membros', null) then
        raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'membros';
      end if;
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'membros', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_user_organizations() is
  'Gatilho de plano (Tarefa 3, decisão 5): chama fn_billing_conferir_teto(membros) na transição para ativo (accepted_at preenchido, revoked_at nulo, provisional_until_handover falso), cobrindo aceite direto, readmissão de revogado e insert já ativo. O admin provisório nunca conta. Fase F3 (migration 0907, decisão 4, item 2): antes do bloqueio de verdade, três isenções (convite pendente do e-mail, aceite sem linha de convite, dono do provisionamento) liberam o aceite mesmo no teto; a conferência de aviso continua rodando incondicionalmente, sem mudança.';

revoke execute on function public.fn_billing_trava_user_organizations() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_user_organizations() to service_role;

drop trigger if exists trg_billing_trava_user_organizations on public.user_organizations;
create trigger trg_billing_trava_user_organizations
  -- Achado M1 (revisão fase F2): a lista "of accepted_at, revoked_at" foi
  -- REMOVIDA, não ampliada com provisional_until_handover. Essa coluna só
  -- nasce bem depois deste ponto do baseline.sql (migration 0237, faixa
  -- 09xx é numeração RESERVADA ao fork, não ordem real de aplicação, e
  -- 0237 aplica DEPOIS do bloco 0905): um "of <coluna que ainda não
  -- existe>" falha na hora de CRIAR o gatilho num install do zero,
  -- diferente de uma referência dentro do CORPO da função (só resolvida em
  -- tempo de EXECUÇÃO, quando a coluna já existe de sobra). Sem "of", o
  -- gatilho passa a rodar em qualquer update da linha; o corpo da função
  -- (v_novo_ativo/v_antigo_ativo) é barato e não faz nada a mais quando a
  -- transição não muda (um update de interface_settings, por exemplo, não
  -- move accepted_at/revoked_at/provisional_until_handover).
  before insert or update on public.user_organizations
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

  -- Revisão pós-auditoria da F3 (achado médio 1, corrigida junto com a 0907):
  -- a correção A1 tinha tirado a soma da transição PARA aberto DAQUI de
  -- vez, incondicional de modo, e movido tudo para o BEFORE
  -- (fn_billing_bloqueia_crm_leads, 0907). Isso fechou o furo do A1 (lote
  -- passando do teto no modo bloquear), mas abriu um deadlock novo: num
  -- comando de várias linhas em QUALQUER modo, a trava do contador (dentro de
  -- fn_billing_conferir_teto, que o BEFORE chama) passava a ser disputada no
  -- MEIO do comando, uma vez por linha, e um arrasto simultâneo de OUTRO lead
  -- do mesmo lote podia entrar em deadlock com ela (D-062, hiperbold/
  -- DEBITO.md). fn_billing_bloqueio_ativo(v_org) (0907, definida perto de
  -- fn_billing_bloqueia) devolve as MESMAS quatro condições de
  -- fn_billing_bloqueia, sem contar nem travar: só quando ela diz TRUE (modo
  -- bloquear, carência vencida, teto de leads não nulo) é que a soma linha a
  -- linha do BEFORE é realmente necessária (só ali existe o defeito do A1).
  -- Nos outros três casos (avisar, desligado, dentro da carência) NINGUÉM
  -- pega a trava do contador no meio do comando: o BEFORE fica calado (ver o
  -- `if` dele, 0907) e quem soma volta a ser ESTE AFTER, exatamente como era
  -- ANTES da correção A1 e antes da fase F3 inteira, o comportamento que o
  -- modo avisar tem que preservar sem mudar nada (hiperbold/planos/fase-F3-
  -- tarefas.md, linha 5).
  --
  -- Janela rara, documentada e não corrigida (custo/benefício da revisão): se
  -- o modo mudar de bloquear para avisar (ou o inverso) NO MEIO de um comando
  -- de várias linhas, linhas diferentes do MESMO comando podem ler valores
  -- diferentes de fn_billing_bloqueio_ativo, e uma soma pode ficar por conta
  -- de nenhum dos dois gatilhos (ou dos dois). fn_billing_conferir_contador
  -- (o conferidor diário) corrige o contador dessa organização no dia
  -- seguinte; trocar o modo pela tela do admin não é operação de todo
  -- instante, e a janela exige coincidir exatamente com um comando de várias
  -- linhas.
  if v_status_novo = 'open' and v_status_antigo is distinct from 'open' then
    if not public.fn_billing_bloqueio_ativo(v_org) then
      -- Confere o aviso e soma, na mesma ordem "conta antes de somar" de
      -- sempre (achado 2 da revisão fase F2): comportamento IDÊNTICO ao de
      -- antes da correção A1, palavra por palavra.
      perform public.fn_billing_conferir_teto(v_org, 'leads', null);

      insert into public.billing_usage_counters (organization_id, item, valor)
      values (v_org, 'leads', 1)
      on conflict (organization_id, item) do update
        set valor = public.billing_usage_counters.valor + 1,
            updated_at = now();
    end if;
    -- Com o bloqueio ATIVO (fn_billing_bloqueio_ativo = true), esta soma fica
    -- por conta do BEFORE (fn_billing_bloqueia_crm_leads, 0907): é a correção
    -- A1 de verdade, e só é necessária ali (ordem estrita por linha).
  elsif v_status_antigo = 'open' and v_status_novo is distinct from 'open' then
    -- Fechamento (aberto -> ganho/perdido) e exclusão: sempre SUBTRAI aqui,
    -- nos dois modos, sem condição nenhuma. Fechar sempre LIBERA vaga, nunca
    -- ocupa, então não há teto a burlar fechando várias linhas juntas, e por
    -- isso o AFTER (que só dispara no FIM do comando) sempre basta.
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
  'Gatilho de plano (Tarefa 3, decisão 6): after insert/update/delete SEM lista de colunas em crm_leads, porque trg_crm_lead_close_on_stage (before, do autor) muda o status na troca de etapa e um gatilho com lista de colunas não veria essa mudança; só o valor final da linha resolve. Revisão pós-auditoria da F3 (achado médio 1): a soma da transição PARA aberto só acontece AQUI quando fn_billing_bloqueio_ativo(organizacao) é falso (avisar, desligado, ou dentro da carência), exatamente o comportamento de ANTES da correção A1. Com o bloqueio ativo, quem soma é o BEFORE (fn_billing_bloqueia_crm_leads, 0907), linha a linha, porque só ali existe o defeito do A1 (lote passando do teto). Fechamento (aberto -> ganho/perdido) e exclusão sempre subtraem AQUI (greatest(valor - 1, 0)), nos dois casos, nunca recriando a linha (decisão 11, exclusão em cascata de organização). Captura qualquer erro (decisão 11). Fecha o deadlock D-062 (hiperbold/DEBITO.md) para todo modo que não seja bloquear de verdade.';

revoke execute on function public.fn_billing_trava_crm_leads() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_crm_leads() to service_role;

drop trigger if exists trg_billing_trava_crm_leads on public.crm_leads;
create trigger trg_billing_trava_crm_leads
  after insert or update or delete on public.crm_leads
  for each row
  execute function public.fn_billing_trava_crm_leads();

-- 10. fn_billing_conferir_contador: o conferidor diário (chamado pela Tarefa
-- 5), UMA ORGANIZAÇÃO por chamada.
--
-- Achado 3 (revisão fase F2): a versão antiga (fn_billing_conferir_contadores,
-- sem argumento) rodava TODAS as organizações numa transação/RPC só, com
-- select ... for update em cada linha e soltura de TODAS só no commit final.
-- Durante a rodada, todo lead criado ou fechado numa organização já conferida
-- esperava a trava; a sessão authenticated tem lock_timeout curto, o erro é
-- engolido pelo exception block de fn_billing_trava_crm_leads, e a contagem se
-- perde: a própria divergência que o conferidor existe para corrigir. Por
-- isso a chamada agora é uma função por organização: quem chama (Tarefa 5)
-- itera as organizações por fora e faz uma RPC por organização, cada uma sua
-- própria transação.
--
-- Mesmo desenho de trava e contagem em comandos SEPARADOS da versão antiga:
-- TRAVA a linha (select ... for update) e só DEPOIS, num comando SEGUINTE,
-- conta os leads abertos de verdade e corrige: nunca no mesmo comando que
-- travou, senão o count enxergaria a mesma foto de dados de quando a trava foi
-- pega, e uma escrita concorrente que esperou a trava passaria batida.
--
-- Também CRIA a linha do contador quando ela não existe (a versão antiga só
-- percorria organização que já tinha linha em billing_usage_counters, e uma
-- organização sem linha nunca era conferida). Sem linha, o valor efetivo é
-- zero, mesma doutrina do coalesce(valor, 0) de fn_billing_uso e
-- fn_billing_pode_criar: então divergia = a contagem real não é zero.
--
-- Devolve true se o contador divergia (ou não existia e a contagem real não
-- era zero), false quando já estava certo.
create or replace function public.fn_billing_conferir_contador(p_org uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_real bigint;
  v_existia boolean;
  v_divergia boolean;
begin
  perform 1
    from public.billing_usage_counters
    where organization_id = p_org and item = 'leads'
    for update;
  v_existia := found;

  select count(*) into v_real
    from public.crm_leads
    where organization_id = p_org and status = 'open';

  if v_existia then
    update public.billing_usage_counters
      set valor = v_real, updated_at = now()
      where organization_id = p_org
        and item = 'leads'
        and valor <> v_real;
    v_divergia := found;
  else
    insert into public.billing_usage_counters (organization_id, item, valor)
    values (p_org, 'leads', v_real)
    on conflict (organization_id, item) do update
      set valor = excluded.valor,
          updated_at = now();
    v_divergia := v_real <> 0;
  end if;

  return v_divergia;
end;
$$;

comment on function public.fn_billing_conferir_contador(uuid) is
  'Conferidor diário (Tarefa 5) de UMA organização em billing_usage_counters (item leads), achado 3 da revisão fase F2: a versão antiga (fn_billing_conferir_contadores, sem argumento) segurava a trava de todas as organizações até o commit final de uma transação só, fazendo lead novo de organização já conferida esperar (lock_timeout curto da sessão authenticated engolia o erro e perdia a contagem, a divergência que este conferidor existe para corrigir). Por organização: trava a linha (for update) e só num comando SEGUINTE conta os leads abertos e corrige, para não enxergar a mesma foto do momento da trava. CRIA a linha do contador quando ela não existe (upsert com a contagem real), em vez de pular. Devolve true se divergia (ou não existia e a contagem real não era zero).';

-- Baseline idempotente: a 0905 ainda não foi para produção, então o drop da
-- função antiga (achado 3) não perde histórico nenhum.
drop function if exists public.fn_billing_conferir_contadores();

revoke execute on function public.fn_billing_conferir_contador(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_conferir_contador(uuid) to service_role;

-- 11. agent_worker não confere nem trava plano pelos gatilhos e funções
-- novos desta parte 2 (mesmo racional do bloco 6 da parte 1, acima): por
-- alter default privileges ela ganharia execute em toda função nova do
-- schema public, e tem bypassrls.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_conferir_teto(uuid, text, uuid), public.fn_billing_trava_crm_pipelines(), public.fn_billing_trava_crm_stages(), public.fn_billing_trava_channel_sessions(), public.fn_billing_trava_webhook_sources(), public.fn_billing_trava_team_invites(), public.fn_billing_trava_user_organizations(), public.fn_billing_trava_crm_leads(), public.fn_billing_conferir_contador(uuid) from agent_worker';
  end if;
end
$$;

-- ── Parte 3 (Tarefa 4): teto técnico de conexões MCP, D-034 ──
--
-- D-034 é achado da fase F2, mas o defeito é anterior aos planos (migration
-- 0901, fork Hiperbold): lib/ai/mcp-externo/conexoes.ts conta as conexões da
-- organização ANTES de inserir, com um teste de conexão de alguns segundos no
-- meio (abre sessão MCP, lista ferramentas). Dois cadastros simultâneos da
-- MESMA organização passam pela contagem antes de qualquer um dos dois
-- gravar, e os dois podem passar de 10. A checagem em código FICA (evita o
-- teste de conexão à toa quando já dá para saber que vai recusar), mas quem
-- trava de verdade é o banco.
--
-- É teto TÉCNICO, não de plano: vale para toda organização, inclusive no
-- plano Ilimitado, e por isso NÃO chama fn_billing_conferir_teto nem lê
-- billing_settings ou fn_billing_limites_efetivos. Mora nesta migration (faixa
-- 09xx) só porque a Tarefa 4 da fase F2 pediu que a correção entrasse junto,
-- não porque é assunto de billing.
--
-- pg_advisory_xact_lock por organização, com uma chave de NAMESPACE PRÓPRIA
-- ('ai_mcp_connections:...'), distinta da família 'billing:...' que
-- fn_billing_ajustar_limites (migration 0904) e fn_billing_conferir_teto
-- (acima, parte 2) usam: mesma organização, dois assuntos diferentes, dois
-- locks que não podem se confundir nem colidir.
--
-- Mensagem de erro FIXA, sem nenhum dado do banco (nem contagem, nem
-- organização, nem slug). errcode 'PT422': convenção já em uso neste
-- repositório (migration 0363) em que o PostgREST lê os TRÊS ÚLTIMOS DÍGITOS
-- do errcode como o status HTTP da resposta: chega em conexoes.ts como
-- error.code = 'PT422' na resposta do insert, mapeado para o MESMO 422 com o
-- MESMO texto (MOTIVO_LIMITE) que a checagem prévia em código já devolve,
-- nunca um 500 com o texto cru do Postgres.
--
-- before insert (sem "or update"): ao contrário dos itens de plano, uma
-- conexão MCP não tem estado "inativo que volta a ativo" que mude a
-- CONTAGEM DE LINHAS. editarConexao só troca is_active, a linha continua
-- existindo; o que soma ou tira uma linha é sempre insert ou delete, e
-- delete nunca precisa de trava.
--
-- Idempotente: create or replace, drop trigger if exists antes de recriar.

-- 12. fn_billing_trava_ai_mcp_connections: teto técnico de 10 conexões MCP.
create or replace function public.fn_billing_trava_ai_mcp_connections()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_atual bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_mcp_connections:' || new.organization_id::text, 0));

  select count(*) into v_atual
  from public.ai_mcp_connections
  where organization_id = new.organization_id;

  if v_atual >= 10 then
    raise exception 'Limite de 10 conexões por organização' using errcode = 'PT422';
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_ai_mcp_connections() is
  'Teto TÉCNICO de 10 conexões MCP por organização (D-034, Tarefa 4 da fase F2), não é item de plano: vale inclusive no Ilimitado, não lê billing_settings nem fn_billing_limites_efetivos. before insert, security definer, pg_advisory_xact_lock por organização ANTES de contar (chave própria, fora da família billing:..., para não colidir com o lock de plano da mesma organização). Mensagem de erro fixa, sem dado do banco; errcode PT422 (convenção da migration 0363: os três últimos dígitos viram o status HTTP no PostgREST), tratado em lib/ai/mcp-externo/conexoes.ts como o mesmo 422 de MOTIVO_LIMITE que a checagem prévia em código já devolve.';

revoke execute on function public.fn_billing_trava_ai_mcp_connections() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_ai_mcp_connections() to service_role;

drop trigger if exists trg_billing_trava_ai_mcp_connections on public.ai_mcp_connections;
create trigger trg_billing_trava_ai_mcp_connections
  before insert on public.ai_mcp_connections
  for each row
  execute function public.fn_billing_trava_ai_mcp_connections();

-- 13. agent_worker não trava conexões MCP pela função nova desta parte 3
-- (mesmo racional dos blocos 6 e 11, acima): por alter default privileges ela
-- ganharia execute em toda função nova do schema public, e tem bypassrls.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_trava_ai_mcp_connections() from agent_worker';
  end if;
end
$$;

-- Parte 4 (revisão fase F2, achados M1 e M2 da auditoria de segurança).
--
-- As partes 1 a 3 (Tarefas 2 a 4) já estavam escritas quando a auditoria de
-- segurança achou dois furos que só um gatilho no banco fecha (RLS sozinha
-- não alcança): M1 (provisional_until_handover gravável por qualquer admin
-- comum) e M2 (agent_inbox_items.ref_kind = 'billing_limite' forjável,
-- apagável e reescrevível por qualquer membro). B1, B4 e a lista de colunas
-- do M1 entraram NO LUGAR das peças da Tarefa 3, acima (achados sobre
-- gatilho já existente); esta parte 4 só tem as peças NOVAS (M1 e M2).
--
-- Idempotente: create or replace, drop trigger/policy if exists antes de
-- recriar.

-- 14. M1: só o servidor grava user_organizations.provisional_until_handover.
--
-- A coluna (comentário dela, migration 0237/baseline) diz que é gravada
-- "APENAS por fn_create_tenant_with_owner", mas a policy user_orgs_update (do
-- autor, fn_role_at_least(organization_id, 'admin')) deixa qualquer admin da
-- organização gravar QUALQUER coluna, inclusive esta. Um admin comum marcando
-- o vínculo de um colega como provisório (1) tira esse colega da contagem de
-- membros sem aviso e (2) faz fn_accept_team_invite apagar esse vínculo no
-- próximo aceite de admin: um jeito de expulsar alguém da própria empresa.
--
-- security invoker DE PROPÓSITO (diferente de todo o resto deste arquivo):
-- este gatilho precisa enxergar a ROLE REAL de quem está gravando.
-- security definer sempre veria o dono da função (postgres) e nunca
-- recusaria ninguém. Dentro de uma função security definer do dono postgres
-- (fn_create_tenant_with_owner, fn_accept_team_invite), current_user já É
-- postgres durante a execução dela, então o fluxo do autor continua
-- passando sem precisar de nenhuma exceção explícita para essas duas funções.
create or replace function public.fn_billing_trava_user_organizations_provisorio()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    if tg_op = 'INSERT' then
      if new.provisional_until_handover then
        raise exception 'provisional_until_handover só pode ser gravado pelo servidor' using errcode = '42501';
      end if;
    elsif new.provisional_until_handover is distinct from old.provisional_until_handover then
      raise exception 'provisional_until_handover só pode ser gravado pelo servidor' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_user_organizations_provisorio() is
  'M1 (revisão fase F2): recusa gravar user_organizations.provisional_until_handover fora do servidor (postgres, service_role, supabase_admin), em insert já true, ou em update quando o valor mudou. security invoker de propósito: precisa ver a role REAL de quem grava (dentro de uma função security definer do dono postgres, current_user já é postgres, o fluxo de fn_create_tenant_with_owner e fn_accept_team_invite continua passando sem exceção nenhuma). errcode 42501 (mesma família de permission denied das policies).';

revoke execute on function public.fn_billing_trava_user_organizations_provisorio() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_user_organizations_provisorio() to service_role;

-- Sem "of provisional_until_handover" DE PROPÓSITO (mesmo achado do gatilho
-- acima, item 8f da parte 2): a coluna só nasce depois deste ponto do
-- baseline.sql (migration 0237), e um "of <coluna inexistente>" falha na
-- hora de CRIAR o gatilho. O corpo da função já só recusa quando a coluna
-- realmente está envolvida (insert com ela true, ou update em que mudou).
drop trigger if exists trg_billing_trava_user_organizations_provisorio on public.user_organizations;
create trigger trg_billing_trava_user_organizations_provisorio
  before insert or update on public.user_organizations
  for each row
  execute function public.fn_billing_trava_user_organizations_provisorio();

-- 15. M2: agent_inbox_items, ninguém além do servidor forja, apaga ou
-- reescreve um aviso de plano (ref_kind = 'billing_limite').
--
-- tenant_isolation_agent_inbox_items_all (do autor, FOR ALL por organização)
-- deixa qualquer membro inserir, atualizar e apagar QUALQUER linha da própria
-- organização, inclusive um aviso de plano forjado: um viewer insere
-- kind='other', ref_kind='billing_limite' e o TÍTULO do aviso real, e a
-- deduplicação de fn_billing_conferir_teto (que olha organização + ref_kind +
-- título ENQUANTO status='open') acha essa linha falsa e o aviso verdadeiro
-- nunca nasce. O mesmo membro também apaga o aviso real, ou reescreve o
-- título/corpo de um aviso já aberto.
--
-- Duas policies RESTRICTIVE (acrescentam-se à FOR ALL do autor, não a
-- substituem: RESTRICTIVE é E lógico com toda PERMISSIVE que já vale) mais
-- um gatilho de UPDATE. Nomes com prefixo billing_ para não colidir com o
-- padrão support_write_* (mesma tabela, mesmo formato, propósito diferente:
-- aquele é o modo readonly do suporte, este é o dono do dado de plano).
--
-- Revisão pós-auditoria da F3 (achado baixo 9): a MESMA proteção passa a
-- cobrir também ref_kind = 'billing_carteira' (o aviso crítico de saldo
-- zerado da carteira de tokens, `run-model-call.ts`, decisão 7 da fase). Sem
-- isto, um membro forjava/apagava/reescrevia o aviso de carteira do jeito
-- exato que o M2 original fechou para o de limite de plano, mesma tabela,
-- mesmo vetor, dono diferente do dado. `not in (...)`/`in (...)` no lugar do
-- antigo `is distinct from`/`=` de um valor só; idempotente (create or
-- replace / drop policy if exists, como o resto do bloco).
drop policy if exists billing_agent_inbox_items_insert on public.agent_inbox_items;
create policy billing_agent_inbox_items_insert on public.agent_inbox_items
  as restrictive for insert
  to authenticated
  -- Fase F4 (migration 0908, decisão 9, editado NO LUGAR aqui): billing_assinatura
  -- (o aviso de estado da assinatura) entra na MESMA proteção de billing_limite/
  -- billing_carteira, mesmo vetor do M2 original (membro forjando/apagando/
  -- reescrevendo um aviso que não é dele para dar).
  with check (ref_kind is null or ref_kind not in ('billing_limite', 'billing_carteira', 'billing_assinatura'));

drop policy if exists billing_agent_inbox_items_delete on public.agent_inbox_items;
create policy billing_agent_inbox_items_delete on public.agent_inbox_items
  as restrictive for delete
  to authenticated
  using (ref_kind is null or ref_kind not in ('billing_limite', 'billing_carteira', 'billing_assinatura'));

-- O UPDATE não dá para travar só com RESTRICTIVE (não há coluna para
-- comparar old x new numa USING/WITH CHECK), por isso é gatilho: recusa
-- reescrever qualquer coluna de um aviso de plano (old ou new com ref_kind em
-- billing_limite/billing_carteira) que não seja status ou resolved_at: as
-- DUAS colunas de estado/resolução que app/api/v1/ai/inbox/[id]/route.ts
-- (PATCH, um membro marcando ack/resolved/open) e
-- app/api/v1/ai/inbox/resolve-all/route.ts (resolver todos de uma vez)
-- gravam ao encerrar um item; nenhuma das duas rotas toca título, corpo,
-- kind, severity, ref_kind nem ref_id. O membro pode marcar como resolvido
-- (ou reabrir), não pode transformar outro item num aviso de plano/carteira
-- nem reescrever o texto de um aviso real.
create or replace function public.fn_billing_trava_agent_inbox_items_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Fase F4 (migration 0908, decisão 9, editado NO LUGAR aqui): billing_assinatura
  -- entra na MESMA proteção de billing_limite/billing_carteira, mesmo vetor
  -- do M2 original.
  if current_user not in ('postgres', 'service_role', 'supabase_admin')
     and (old.ref_kind in ('billing_limite', 'billing_carteira', 'billing_assinatura') or new.ref_kind in ('billing_limite', 'billing_carteira', 'billing_assinatura'))
     and (to_jsonb(old) - array['status', 'resolved_at']) is distinct from (to_jsonb(new) - array['status', 'resolved_at'])
  then
    raise exception 'aviso de plano: só status e resolved_at podem mudar fora do servidor' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_agent_inbox_items_update() is
  'M2 (revisão fase F2), estendida na revisão da F3 (achado baixo 9) e na F4 (migration 0908, decisão 9): quando old.ref_kind ou new.ref_kind é billing_limite, billing_carteira OU billing_assinatura, recusa update de QUALQUER coluna fora de status e resolved_at (as duas que o app grava ao encerrar um item, app/api/v1/ai/inbox/[id]/route.ts e .../resolve-all/route.ts), fora do servidor. security invoker de propósito (mesmo racional do M1): precisa ver a role real de quem grava. Compara to_jsonb(old)/to_jsonb(new) menos as duas colunas permitidas, para nenhuma coluna nova do futuro escapar despercebida desta trava.';

revoke execute on function public.fn_billing_trava_agent_inbox_items_update() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_agent_inbox_items_update() to service_role;

drop trigger if exists trg_billing_trava_agent_inbox_items_update on public.agent_inbox_items;
create trigger trg_billing_trava_agent_inbox_items_update
  before update on public.agent_inbox_items
  for each row
  execute function public.fn_billing_trava_agent_inbox_items_update();

-- 16. agent_worker não trava provisório nem aviso de plano pelas peças novas
-- desta parte 4 (mesmo racional dos blocos 6, 11 e 13, acima): por alter
-- default privileges ela ganharia execute em toda função nova do schema
-- public, e tem bypassrls.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_trava_user_organizations_provisorio(), public.fn_billing_trava_agent_inbox_items_update() from agent_worker';
  end if;
end
$$;
