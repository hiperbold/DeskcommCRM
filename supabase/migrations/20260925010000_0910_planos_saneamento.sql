-- 0910, saneamento do módulo de planos (fase F7, lotes 1 e 4b, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F7-tarefas.md e nas entradas D-069, D-070, D-060,
-- D-047, D-055 e D-068 de hiperbold/DEBITO.md (PARTE 1, lote 1) e D-048,
-- D-061, D-062 e D-063 (PARTE 2, lote 4b, abaixo). D-070, D-060 (PARTE 4) e
-- D-062 (PARTE 2) NÃO mudam nada nesta migration (justificativa em cada
-- seção, sem instrução SQL). D-068 é só prova de banco (roteiro fora desta migration, em transação com
-- rollback no banco local de desenvolvimento); nenhuma linha de SQL aqui.
--
-- Mesmo padrão de segurança das migrations anteriores da faixa (0904 a 0909):
-- security definer, search_path fixo em public, pg_temp, revoke de
-- public/anon/authenticated, grant só para service_role, bloco final
-- revogando de agent_worker (se a role existir) o acesso às peças novas: essa
-- role tem bypassrls e ganharia tudo por privilégio padrão (alter default
-- privileges) se não fosse revogado explicitamente.
--
-- Idempotente: revoke/grant são repetíveis por natureza (revogar um
-- privilégio que já não existe não é erro), create table if not exists,
-- create or replace function, drop trigger if exists + create trigger.

-- ============================================================================
-- PARTE 1 (D-069, achado da auditoria da F5): billing_payments e
-- billing_contracts só escritos pelas funções, não mais pelo service_role
-- direto.
-- ============================================================================
--
-- Achado: `grant select, insert on billing_payments to service_role`
-- (decisão 1 da 0908, "SÓ DE ACRÉSCIMO, para QUALQUER escritor") e
-- `grant all on billing_contracts to service_role` (0904, "service_role
-- mantém acesso total") deixam o INSERT de billing_payments e o INSERT,
-- UPDATE e DELETE de billing_contracts abertos a QUALQUER código que use o
-- cliente de serviço, por fora de fn_billing_registrar_pagamento,
-- fn_billing_estornar_pagamento, fn_billing_mudar_estado etc., que são
-- security definer, dono postgres, e por isso nunca dependeram desse grant
-- para escrever (a ação roda com o privilégio do DONO da função, não do
-- papel que a chamou).
--
-- Levantamento (grep em lib/, app/, workers/, scripts/, supabase/: os cinco
-- diretórios existem neste repo, o grep em workers/ e scripts/ não achou
-- nenhuma escrita nas duas tabelas):
--
--   - Nenhum `.insert(`/`.update(`/`.delete(`/`.upsert(` em
--     `.from("billing_payments")` fora das migrações: todo uso em TS é
--     `.select(...)` (lib/billing/assinatura/estado-da-assinatura.ts,
--     lib/billing/asaas/leitura.ts, lib/billing/asaas/processar-eventos.ts).
--     INSERT revogado do service_role sem achado pendente.
--
--   - `billing_contracts`: o único caminho real que usava UPDATE direto com
--     o cliente de serviço era `app/actions/admin/planoDaOrganizacao.ts`
--     (`darCarenciaExtra`, então referida como `estenderCarenciaDaOrganizacao`
--     na 0910 original), gravando só a coluna `bloqueio_a_partir_de`
--     (concorrência antes resolvida por `.eq("bloqueio_a_partir_de", antes)`,
--     comentário "achado médio 3-a"). Correção (fase F7, lote 1b, PARTE 3
--     abaixo): a ação passou a chamar `fn_billing_estender_carencia`
--     (security definer, nova nesta migration), que faz a mesma leitura e
--     escrita dentro de UMA transação sob `select ... for update`: fecha de
--     vez a janela de concorrência do achado 3-a, que antes só era
--     detectada depois de ocorrer. UPDATE também revogado do service_role
--     abaixo, ao lado de INSERT/DELETE/TRUNCATE: nenhum caminho TypeScript
--     escreve mais direto nesta tabela. DELETE inclui a cascata de apagar
--     organização: a ação referencial (ON DELETE CASCADE) roda com o
--     privilégio do DONO da tabela, não do papel que disparou o DELETE em
--     organizations (mesmo racional do comentário de billing_payments:
--     "apagar o usuário não pode travar o registro"), então revogar DELETE
--     do service_role não quebra a exclusão de organização nem o gatilho
--     `trg_billing_protege_assinatura_asaas` (0909) que a protege; só fecha o
--     caminho de apagar o CONTRATO direto por fora da cascata.
--
-- Prova de banco (idempotência e recusa): tests/invariants/planos-saneamento.test.ts.
-- Prova de que a cascata de organização não depende do grant revogado:
-- tests/invariants/planos-asaas.test.ts, describe "trg_billing_protege_assinatura_asaas".

revoke insert on public.billing_payments from service_role;

comment on table public.billing_payments is
  '0908, decisão 1: pagamentos registrados NA MÃO (N24), no molde do manual comum (hiper-track/docs/manual-api-asaas-saas.md). SÓ DE ACRÉSCIMO: ninguém tem update, delete nem truncate, nem o service_role (ver grants). Estorno é uma linha NOVA (status=REFUNDED), nunca uma edição da linha original. Duplicidade de período é conferida DENTRO de fn_billing_registrar_pagamento, não por índice (a F5 precisa aceitar estorno seguido de novo pagamento do mesmo período). Correção (0910, fase F7, D-069): INSERT também revogado do service_role, nenhum caminho em TypeScript escreve direto nesta tabela; toda escrita passa por fn_billing_registrar_pagamento, fn_billing_estornar_pagamento e pelas funções do Asaas (todas security definer, dono postgres, que nunca dependeram deste grant).';

revoke insert, update, delete, truncate on public.billing_contracts from service_role;

comment on table public.billing_contracts is
  'A assinatura da organização: uma linha só, unique(organization_id). Aponta para a VERSÃO do plano (plan_id), não para o code: preço e tetos contratados ficam congelados mesmo se o plano ganhar versão nova. Histórico de troca fica na auditoria (app/actions/admin), não nesta tabela. Correção (0910, fase F7, D-069): INSERT, DELETE e TRUNCATE revogados do service_role: só as funções (security definer, dono postgres) criam e mudam de estado. Correção (fase F7, lote 1b): UPDATE também revogado. app/actions/admin/planoDaOrganizacao.ts (darCarenciaExtra) não escreve mais bloqueio_a_partir_de direto; passou a chamar fn_billing_estender_carencia (security definer, PARTE 3 desta migration), que lê e escreve na mesma transação sob select ... for update. D-069 fechado por completo (hiperbold/DEBITO.md).';

-- ============================================================================
-- PARTE 2 (D-047, achado da auditoria da F1): revoga TRUNCATE de anon e
-- authenticated em todo o schema public, inclusive tabela futura.
-- ============================================================================
--
-- TRUNCATE passa por cima da RLS (mesmo racional do comentário da 0904, item
-- 12: "revogar só insert, update e delete deixava truncate, references e
-- trigger, que vêm no grant padrão do Supabase; e truncate passa por cima da
-- RLS"). O PostgREST não emite TRUNCATE (D-047: "hoje não há caminho de
-- exploração"), e o grep em lib/, app/, workers/, scripts/ não achou nenhum
-- uso de TRUNCATE em código do produto: a palavra só aparece em CSS
-- (`truncate` do Tailwind), truncamento de string e comentário. O risco é
-- futuro: uma função `security invoker` que aceitasse nome de tabela abriria
-- a porta. `alter default privileges for role postgres` cobre toda tabela
-- CRIADA DEPOIS desta migration (mesmo padrão de
-- hiperbold/scripts/role-agent-worker.sql para agent_worker): sem isso, o
-- default ACL do Supabase (que concede `arwdDxt`, incluindo o `D` de
-- TRUNCATE, a anon/authenticated em toda tabela nova) reabriria o mesmo
-- buraco na primeira tabela criada por uma migração futura.
--
-- Prova de banco (idempotência e recusa, inclusive numa tabela criada DEPOIS
-- desta migration dentro do próprio teste): tests/invariants/planos-saneamento.test.ts.

revoke truncate on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- ============================================================================
-- PARTE 3 (D-055, achado da auditoria da F2): o gatilho de leads deixa
-- rastro consultável quando o upsert do contador falha.
-- ============================================================================
--
-- Hoje fn_billing_trava_crm_leads (0905) só faz `raise warning` quando o
-- upsert de billing_usage_counters falha (lock_timeout de 4s da sessão
-- authenticated numa disputa pela linha, por exemplo): o lead nasce (decisão
-- 6, "o chat nunca para" continua valendo, comportamento preservado), mas
-- ninguém fica sabendo que aconteceu fora do log do Postgres: o conferidor
-- diário (fn_billing_conferir_contador) corrige o contador no dia seguinte,
-- só isso não avisa ninguém.
--
-- billing_trigger_alarmes é o rastro CONSULTÁVEL (padrão que o módulo já usa
-- para alarme legível: asaas_webhook_events.alarme, 0909, filtrado pela tela
-- do admin com "where alarme is not null"). Tabela nova, escopo mínimo (só
-- esta falha por ora; generalizar para outros gatilhos "trava_*" que também
-- só fazem raise warning não é pedido por D-055 e fica fora desta migration).
-- SÓ DE ACRÉSCIMO, mesmo desenho de billing_contract_eventos: RLS ligada,
-- ZERO policy, service_role só select+insert, sem update/delete/truncate
-- nem para o service_role.

create table if not exists public.billing_trigger_alarmes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  gatilho text not null,
  falha text not null,
  criado_em timestamptz not null default now()
);

comment on table public.billing_trigger_alarmes is
  '0910, fase F7, D-055: rastro CONSULTÁVEL de falha engolida por um gatilho de plano que hoje só faz raise warning (fn_billing_trava_crm_leads, 0905, upsert de billing_usage_counters). Escopo mínimo: só este gatilho grava aqui por ora. SÓ DE ACRÉSCIMO: ninguém tem update, delete nem truncate, nem o service_role. A escrita nunca derruba a operação original (o insert é feito dentro de um bloco exception PRÓPRIO, que também vira raise warning se falhar).';
comment on column public.billing_trigger_alarmes.gatilho is
  '0910: nome da função de gatilho que engoliu o erro (ex.: fn_billing_trava_crm_leads), para o admin filtrar por origem.';
comment on column public.billing_trigger_alarmes.falha is
  '0910: sqlerrm capturado no bloco exception do gatilho, mesmo texto que hoje só ia para raise warning.';

create index if not exists billing_trigger_alarmes_org_idx
  on public.billing_trigger_alarmes (organization_id, criado_em desc);

alter table public.billing_trigger_alarmes enable row level security;

revoke all on public.billing_trigger_alarmes from anon, authenticated;
grant select, insert on public.billing_trigger_alarmes to service_role;
revoke update, delete, truncate on public.billing_trigger_alarmes from service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.billing_trigger_alarmes from agent_worker';
  end if;
end
$$;

-- Redefinição (última definição vale, CLAUDE.md item 10) de
-- fn_billing_trava_crm_leads (0905): corpo IDÊNTICO, só o bloco exception
-- ganha a gravação do alarme. v_org já está atribuído em toda entrada da
-- função (INSERT/UPDATE/DELETE, ver as duas primeiras linhas do corpo), por
-- isso está disponível aqui mesmo quando o erro acontece dentro do próprio
-- upsert. A gravação do alarme roda dentro do SEU PRÓPRIO bloco
-- exception: uma falha ao gravar o alarme (ex.: billing_trigger_alarmes
-- indisponível) vira só mais um raise warning, nunca propaga e nunca
-- impede o lead de nascer, o mesmo comportamento de hoje, decisão 6.
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

  if v_status_novo = 'open' and v_status_antigo is distinct from 'open' then
    if not public.fn_billing_bloqueio_ativo(v_org) then
      perform public.fn_billing_conferir_teto(v_org, 'leads', null);

      insert into public.billing_usage_counters (organization_id, item, valor)
      values (v_org, 'leads', 1)
      on conflict (organization_id, item) do update
        set valor = public.billing_usage_counters.valor + 1,
            updated_at = now();
    end if;
  elsif v_status_antigo = 'open' and v_status_novo is distinct from 'open' then
    update public.billing_usage_counters
      set valor = greatest(valor - 1, 0),
          updated_at = now()
      where organization_id = v_org and item = 'leads';
  end if;

  return null;
exception
  when others then
    raise warning 'billing_trava_crm_leads_falhou: organizacao=%, sqlerrm=%', v_org, sqlerrm;
    begin
      if v_org is not null then
        insert into public.billing_trigger_alarmes (organization_id, gatilho, falha)
        values (v_org, 'fn_billing_trava_crm_leads', sqlerrm);
      end if;
    exception
      when others then
        raise warning 'billing_trava_crm_leads_alarme_falhou: organizacao=%, sqlerrm=%', v_org, sqlerrm;
    end;
    return null;
end;
$$;

comment on function public.fn_billing_trava_crm_leads() is
  'Gatilho de plano (Tarefa 3, decisão 6): after insert/update/delete SEM lista de colunas em crm_leads, porque trg_crm_lead_close_on_stage (before, do autor) muda o status na troca de etapa e um gatilho com lista de colunas não veria essa mudança; só o valor final da linha resolve. Revisão pós-auditoria da F3 (achado médio 1): a soma da transição PARA aberto só acontece AQUI quando fn_billing_bloqueio_ativo(organizacao) é falso (avisar, desligado, ou dentro da carência), exatamente o comportamento de ANTES da correção A1. Com o bloqueio ativo, quem soma é o BEFORE (fn_billing_bloqueia_crm_leads, 0907), linha a linha, porque só ali existe o defeito do A1 (lote passando do teto). Fechamento (aberto -> ganho/perdido) e exclusão sempre subtraem AQUI (greatest(valor - 1, 0)), nos dois casos, nunca recriando a linha (decisão 11, exclusão em cascata de organização). Captura qualquer erro (decisão 11): o lead SEMPRE nasce/fecha, o chat nunca para. Correção (0910, fase F7, D-055): a falha engolida agora também grava um rastro consultável em billing_trigger_alarmes, dentro do seu próprio bloco exception (uma falha ao gravar o alarme não impede o lead de nascer, mesmo comportamento de hoje).';

revoke execute on function public.fn_billing_trava_crm_leads() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_crm_leads() to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_trava_crm_leads() from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- PARTE 4 (D-070 e D-060, achados da auditoria de segurança): SEM MUDANÇA DE
-- SQL. Justificativa para o Filipe fechar as duas entradas.
-- ============================================================================
--
-- D-070: fn_billing_modo_leitura, fn_billing_limites_efetivos e
-- fn_billing_ia_pode_responder aceitam qualquer p_org de quem pode
-- executá-las, sem conferir vínculo com a organização informada.
--
-- D-060: fn_billing_ia_pode_responder devolve o SALDO numérico (não só a
-- ação) de qualquer p_org.
--
-- Levantamento (catálogo do banco local, information_schema.role_routine_
-- grants): as ÚNICAS roles com EXECUTE nas três funções são postgres,
-- service_role e agent_worker, nenhuma outra (anon/authenticated já
-- revogadas nas migrations de origem). pg_roles.rolbypassrls das três:
--
--   postgres       | rolbypassrls = true
--   service_role   | rolbypassrls = true
--   agent_worker   | rolbypassrls = true
--
-- As três já leem qualquer organização por QUALQUER outro caminho (bypassrls
-- ignora toda policy de RLS em toda tabela do banco): restringir p_org nestas
-- três funções, ou esconder o saldo de fn_billing_ia_pode_responder, não
-- fecha nenhum vetor de leitura entre organizações: o mesmo chamador
-- consultaria a tabela direto. Não há decisão de produto pendente aqui: as
-- duas entradas descrevem alargamento de privilégio de um ator que já tem o
-- dado por construção, não vazamento para um ator sem acesso.
--
-- Prova de banco (rolbypassrls das três roles, para o gate travar se algum
-- dia uma role SEM bypassrls ganhar EXECUTE): tests/invariants/planos-saneamento.test.ts.

-- ============================================================================
-- PARTE 2 (fase F7, lote 4b): D-048, D-061 e D-062/D-063.
-- ============================================================================
--
-- Três achados da revisão e da auditoria de segurança da F3, fora do lote 1
-- desta mesma migration (PARTE 1, acima). Racional completo em
-- hiperbold/planos/fase-F7-tarefas.md e nas entradas D-048, D-061, D-062 e
-- D-063 de hiperbold/DEBITO.md. D-062 NÃO muda nada nesta migration
-- (justificativa na própria seção, abaixo, sem instrução SQL).

-- ----------------------------------------------------------------------------
-- D-048 (achado da auditoria da F1): orgs_write_platform_admin aceita
-- qualquer admin da plataforma, inclusive escopo support_readonly.
-- ----------------------------------------------------------------------------
--
-- A política orgs_write_platform_admin (baseline.sql, apêndice do dump) usa
-- fn_is_platform_admin(), que devolve true para qualquer linha não revogada
-- de platform_admins, sem olhar a coluna scope (full ou support_readonly).
-- Hoje o insert direto só falha por acaso, porque um gatilho de agendamento
-- nega EXECUTE antes; sem ele, o insert de um admin support_readonly passa.
--
-- O padrão do repositório para "só o admin de escopo full" já existe, mas
-- sempre dentro de uma função security definer chamada com o ator explícito
-- em parâmetro (fn_create_tenant_with_owner, migration 0231:
-- "exists (select 1 from public.platform_admins where user_id = p_actor and
-- revoked_at is null and scope = 'full')"). Uma política de RLS não recebe
-- ator por parâmetro, então ganha uma função irmã de fn_is_platform_admin(),
-- com o mesmo corpo (auth.uid(), stable, security definer, search_path
-- fixo), só acrescentando a condição de escopo.
create or replace function public.fn_is_platform_admin_full() returns boolean
    language sql stable security definer
    set search_path to 'public'
    as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and revoked_at is null and scope = 'full'
  );
$$;

revoke execute on function public.fn_is_platform_admin_full() from public, anon;
grant execute on function public.fn_is_platform_admin_full() to authenticated, service_role;

-- Achado da auditoria da F7 (lote 1b): função nova nasce com EXECUTE para
-- agent_worker por privilégio padrão (mesmo mecanismo que
-- role-agent-worker.sql concede, e que test-db.sh reproduz para o gate
-- local); essa role não é chamadora de fn_is_platform_admin_full (só
-- authenticated, pela política de RLS, e service_role).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_is_platform_admin_full() from agent_worker';
  end if;
end
$$;

comment on function public.fn_is_platform_admin_full() is
  '0910, fase F7, D-048: mesmo corpo de fn_is_platform_admin(), com a condição extra scope = full. Existe porque a política de RLS orgs_write_platform_admin não pode chamar a função com ator explícito (não tem parâmetro), e fn_is_platform_admin() não distingue full de support_readonly.';

-- Redefinição da política (drop + create: RLS não tem "create or replace
-- policy"), mesmo padrão já em uso no repositório para trocar a condição de
-- uma policy existente (billing_usage_counters_select, migration 0905).
-- Redução de escopo pura: quem passava por fn_is_platform_admin() com
-- scope = full continua passando; quem tinha só support_readonly deixa de
-- escrever em organizations por esta política. A policy de leitura
-- (orgs_select) continua aceitando qualquer admin da plataforma: leitura não
-- é o achado do D-048.
drop policy if exists orgs_write_platform_admin on public.organizations;
create policy orgs_write_platform_admin on public.organizations
  using (public.fn_is_platform_admin_full())
  with check (public.fn_is_platform_admin_full());

-- ----------------------------------------------------------------------------
-- D-061 (achado da auditoria de segurança da F3): fn_reserve_channel_connection
-- reaproveita sessão waha arquivada sem limpar archived_at e sem passar pelo
-- teto do plano.
-- ----------------------------------------------------------------------------
--
-- No ramo p_onboarding, a função (do autor, nascida na migration 0228,
-- forward-fix em 0230 e 0232) pode achar uma channel_sessions arquivada do
-- provider waha e reaproveitá-la sem zerar archived_at. Como a última
-- atualização do corpo original não toca essa coluna, o gatilho que confere
-- o teto de conexões do plano (trg_billing_trava_channel_sessions, before
-- insert or update OF archived_at, migration 0907) nunca dispara para essa
-- reativação: ele só é acionado quando a coluna archived_at está
-- literalmente na lista de colunas do comando. WAHA saiu da instalação
-- (D-029), então o caminho é improvável de ser exercitado hoje, mas a
-- correção é local e não muda mais nada do corpo.
--
-- Assim que o ramo de onboarding acha uma sessão arquivada, um update
-- próprio zera archived_at (com a coluna presente no set, mesmo que já fosse
-- nula) antes do resto do corpo. Isso dispara o mesmo gatilho que uma
-- conexão nova usa, então o reaproveitamento passa a contar no teto igual a
-- uma conexão criada do zero, exatamente o que D-061 pede. Corpo idêntico ao
-- da migration 0232 fora deste trecho novo (última definição vale, CLAUDE.md
-- item 10).
create or replace function public.fn_reserve_channel_connection(p_org uuid,p_key uuid,p_hash text,p_display_name text default null,p_onboarding boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt public.channel_connection_requests; channel public.channel_sessions; token uuid:=gen_random_uuid();
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org)
 then raise exception 'connection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'connection_mfa_required' using errcode='42501';end if;
 if p_key is null or p_hash is null or length(p_hash)<>64 or length(coalesce(p_display_name,''))>100 then
  raise exception 'connection_invalid_request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,2281));
 delete from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key
  and state='succeeded' and updated_at<now()-interval '24 hours';
 select * into receipt from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key for update;
 if found then
  if receipt.request_hash<>p_hash then raise exception 'idempotency_conflict' using errcode='22023';end if;
  if receipt.state='succeeded' then
   select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id;
   return jsonb_build_object('replay',true,'channel',to_jsonb(channel),'receipt_id',receipt.id);
  end if;
  if receipt.state='processing' and receipt.lease_until>now() then
   raise exception 'connection_in_progress' using errcode='55P03';end if;
  select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id for update;
  if not found then raise exception 'connection_reservation_missing' using errcode='P0002';end if;
 else
  if p_onboarding then
   select * into channel from public.channel_sessions where organization_id=p_org and provider='waha'
    and (metadata->>'onboarding'='true' or waha_session_name='org_'||left(p_org::text,8))
    order by created_at limit 1 for update;
   -- D-061: sessão arquivada reaproveitada pelo onboarding conta no teto como
   -- uma conexão nova, pelo MESMO gatilho que a criação usa.
   if channel.id is not null and channel.archived_at is not null then
    update public.channel_sessions set archived_at=null,updated_at=now()
     where organization_id=p_org and id=channel.id
     returning * into channel;
   end if;
  end if;
  if channel.id is null then
   insert into public.channel_sessions(organization_id,waha_session_name,display_name,engine,webhook_path_token,
     webhook_secret_encrypted,status,last_status_change_at,consecutive_health_fails,daily_message_limit,metadata)
   values(p_org,'org_'||left(replace(p_org::text,'-',''),8)||'_'||replace(gen_random_uuid()::text,'-',''),p_display_name,'NOWEB',
     replace(gen_random_uuid()::text,'-',''),'\x00'::bytea,'STARTING',now(),0,250,
     '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'::jsonb
     || case when p_onboarding then '{"onboarding":true}'::jsonb else '{}'::jsonb end) returning * into channel;
  end if;
  if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
    and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
  insert into public.channel_connection_requests(organization_id,idempotency_key,request_hash,channel_session_id)
   values(p_org,p_key,p_hash,channel.id) returning * into receipt;
 end if;
 if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
   and id<>receipt.id and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
 update public.channel_connection_requests set state='processing',lease_token=token,lease_until=now()+interval '5 minutes',
  remote_created=false,updated_at=now() where organization_id=p_org and id=receipt.id;
 update public.channel_sessions set status='STARTING',status_reason='connection_pending',last_status_change_at=now()
  where organization_id=p_org and id=channel.id returning * into channel;
 return jsonb_build_object('replay',false,'channel',to_jsonb(channel),'receipt_id',receipt.id,'lease_token',token);
end;
$$;
revoke all on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- D-062 (achado médio 1 da revisão da F3): SEM MUDANÇA DE SQL. Justificativa
-- para o Filipe fechar ou registrar a análise.
-- ----------------------------------------------------------------------------
--
-- Com o bloqueio de fato ativo (fn_billing_bloqueio_ativo = true: modo
-- bloquear, carência vencida, teto efetivo não nulo), fn_mover_leads_em_lote
-- (migration 0209, PATCH em massa) faz um único update de várias linhas,
-- comentado no próprio corpo como o que "torna o lote atômico: move todos ou
-- nenhum". Cada linha passa pelo gatilho before de bloqueio
-- (fn_billing_bloqueia_crm_leads, 0907), que com o bloqueio ativo soma o
-- contador linha a linha sob a trava do contador (pg_advisory_xact_lock
-- dentro de fn_billing_conferir_teto), disputada no meio desse comando de
-- várias linhas. Um arrasto simultâneo de outro lead da mesma organização,
-- que também precisa da mesma trava, pode formar um ciclo de espera com a
-- ordem de bloqueio de linha do lote e receber 40P01 (deadlock detected) do
-- Postgres.
--
-- A correção sugerida no D-062 (savepoint e nova tentativa automática no
-- caminho que receber 40P01) só é possível de verdade dentro de um bloco
-- plpgsql com exception (que abre um savepoint implícito e sobrevive ao erro
-- sem abortar a transação inteira). Para funcionar aqui,
-- fn_mover_leads_em_lote precisaria trocar o update único por um laço linha
-- a linha, cada iteração num bloco próprio de captura e nova tentativa,
-- porque o update de várias linhas de hoje não tem como capturar um erro no
-- meio do próprio comando e continuar dali. Essa troca muda a garantia
-- central da função, documentada no comentário dela e válida em qualquer
-- modo (avisar, desligado ou bloquear): hoje o lote move todos os leads ou
-- nenhum; um laço com nova tentativa por linha abriria espaço para um lote
-- terminar com algumas linhas movidas e outras não, se uma tentativa
-- esgotasse o limite ou achasse outro erro. Essa é uma mudança de
-- comportamento da função inteira, não uma mudança isolada ao caminho de
-- bloqueio ativo, e por isso fica fora do critério desta tarefa (correção
-- que não muda nada no modo avisar e não reabre o problema que a F3
-- fechou).
--
-- Sem essa troca não há como testar o D-062 de forma determinística: como o
-- próprio achado registra, o deadlock depende de timing fino entre duas
-- sessões, e não é reproduzido automaticamente hoje. Fica sem mudança de
-- código, documentado aqui e em D-062 (hiperbold/DEBITO.md) para o Filipe
-- decidir se vale reescrever fn_mover_leads_em_lote com outra garantia de
-- atomicidade antes de aplicar a nova tentativa.

-- ----------------------------------------------------------------------------
-- D-063 (achado baixo 5 da revisão da F3): janela de contagem na primeira
-- aplicação do baseline (D-053, item 2) continua existindo.
-- ----------------------------------------------------------------------------
--
-- O preenchimento inicial de billing_usage_counters (migration 0905, roda a
-- cada reaplicação inteira do baseline em produção) faz um
-- "insert ... select count(*) ... group by organization_id on conflict do
-- update set valor = excluded.valor": sem select for update nem trava
-- nenhuma entre a foto (o count) e a escrita (o upsert), um lead confirmado
-- exatamente nesse intervalo (via fn_billing_trava_crm_leads, after, soma +1
-- na mesma linha) pode ter o incremento apagado pela sobrescrita, se o
-- upsert desta migration terminar depois do incremento concorrente:
-- "set valor = excluded.valor" troca o valor pela foto desatualizada, mesmo
-- que a linha já tivesse sido incrementada por um lead legítimo nascido no
-- meio do caminho.
--
-- Travar a tabela inteira, ou repetir a mesma trava por organização que os
-- gatilhos usam (pg_advisory_xact_lock dentro de fn_billing_conferir_teto),
-- reabriria exatamente a disputa de lock que o D-062, acima, já descreve (e
-- que a F3 já fechou para a operação normal): fica fora do critério desta
-- tarefa.
--
-- Correção que cabe sem trava nova nenhuma: repetir o mesmo recálculo aqui,
-- depois do da 0905 (a mesma organização recebe as duas passadas a cada
-- reaplicação do arquivo inteiro), trocando a sobrescrita cega por
-- "greatest(valor atual, valor recalculado)". Sob read committed, o update
-- de um "on conflict do update" relê a linha atual (já com o incremento
-- concorrente, se ele já tiver sido commitado) para resolver o conflito:
-- pegar o maior entre o valor atual e a foto desta passada nunca decresce um
-- contador que um lead legítimo já elevou durante a janela, e continua
-- convergindo para o valor real quando a foto é maior que o valor atual
-- (organização sem incremento concorrente nenhum, o caso comum). Não fecha a
-- janela por completo (um lead que fecha exatamente na janela, com a foto
-- desta passada ainda o contando aberto, pode deixar o contador
-- temporariamente acima do real, na direção oposta à que D-063 descreve):
-- fn_billing_conferir_contador (o conferidor diário) já corrige as duas
-- direções todo dia, e essa correção não muda isso. Não toca em nenhum
-- gatilho, não acrescenta trava nenhuma, e não muda nada no que qualquer
-- modo (avisar, desligado ou bloquear) decide fazer com o valor do contador:
-- só muda quão fiel a foto de uma reaplicação de baseline fica de um
-- incremento concorrente específico.
--
-- Prova de banco (a fusão nunca decresce um valor já incrementado, e ainda
-- sobe até o valor real quando ele é maior): tests/invariants/saneamento-autor.test.ts.
insert into public.billing_usage_counters (organization_id, item, valor)
select cl.organization_id, 'leads', count(*)
from public.crm_leads cl
where cl.status = 'open'
group by cl.organization_id
on conflict (organization_id, item) do update
  set valor = greatest(public.billing_usage_counters.valor, excluded.valor),
      updated_at = now();

-- ============================================================================
-- PARTE 3 (fase F7, lote 1b): D-069 completo. fn_billing_estender_carencia
-- substitui a escrita direta de app/actions/admin/planoDaOrganizacao.ts, e o
-- UPDATE de billing_contracts é revogado do service_role (PARTE 1, acima).
-- ============================================================================
--
-- Levantamento (grep em app/, lib/, workers/, scripts/, os dois últimos
-- diretórios não existem neste repo hoje): darCarenciaExtra era o ÚNICO
-- caminho em TypeScript que escrevia em billing_contracts.bloqueio_a_partir_de
-- direto com o cliente de serviço. Nenhum outro trecho de app/lib faz
-- `.update(`/`.insert(`/`.delete(`/`.upsert(` em `.from("billing_contracts")`;
-- o resto do repositório só lê (`.select(...)`).
--
-- fn_billing_estender_carencia: lê e escreve dentro de UMA transação sob
-- `select ... for update` na linha do contrato, então duas chamadas
-- concorrentes para a MESMA organização serializam pela trava da própria
-- linha (a segunda espera a primeira terminar e enxerga o valor JÁ
-- atualizado, sem precisar de advisory lock à parte: diferente de
-- fn_billing_trocar_plano, aqui a linha sempre existe, porque a função exige
-- bloqueio_a_partir_de não nulo antes de aceitar a escrita). Mesmas
-- validações de negócio que a ação já fazia em TypeScript (achado médio 3 da
-- revisão da F3): organização sem contrato é recusada (P0002), organização
-- sem bloqueio_a_partir_de programado é recusada (P0002, "nada para
-- estender"), e a nova data só é aceita se for POSTERIOR à carência atual
-- (22023, só ADIA, nunca antecipa). Formato de data, calendário válido (sem
-- overflow de 31/02), fuso America/Sao_Paulo e o teto de 90 dias continuam
-- calculados em TypeScript ANTES de chamar a função (são validação de
-- entrada da tela, não regra do banco). Devolve o bloqueio_a_partir_de
-- ANTERIOR ao update (o "antes" que a ação audita); o "depois" a ação já
-- conhece, é o mesmo p_ate que enviou.
--
-- billing_contract_eventos (0908, mais o tipo 'plano' que a 0909 acrescentou)
-- ganha o tipo 'carencia' (redefinição do CHECK, drop + add, mesmo padrão de
-- troca de constraint já usado no repositório e na própria 0909, seção 25):
-- a extensão de carência passa a deixar rastro de autor e motivo, no mesmo
-- molde das outras transições do contrato (fn_billing_mudar_estado,
-- fn_billing_corrigir_periodo etc., 0908; fn_billing_asaas_aplicar_pagamento,
-- 0909). Os cinco valores anteriores (0908: estado, periodo, cancelar_no_fim,
-- conferidor; 0909: plano) continuam valendo tal qual.
--
-- Prova de banco (recusa de UPDATE direto, sucesso da função, as três
-- recusas de negócio, e que anon/authenticated/agent_worker não executam):
-- tests/invariants/planos-saneamento.test.ts.

alter table public.billing_contract_eventos drop constraint if exists billing_contract_eventos_tipo_check;
alter table public.billing_contract_eventos add constraint billing_contract_eventos_tipo_check
  check (tipo in ('estado', 'periodo', 'cancelar_no_fim', 'conferidor', 'plano', 'carencia'));

comment on column public.billing_contract_eventos.tipo is
  '0908 (estado, periodo, cancelar_no_fim, conferidor) + 0909 Tarefa 5/B6 (plano) + 0910 fase F7 lote 1b (carencia, gravado por fn_billing_estender_carencia, D-069). Os cinco valores anteriores continuam valendo tal qual.';

create or replace function public.fn_billing_estender_carencia(p_org uuid, p_ate timestamptz, p_actor uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
begin
  if p_ate is null then
    raise exception 'billing_carencia_data_obrigatoria' using errcode = '22023';
  end if;

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_carencia_organizacao_sem_contrato' using errcode = 'P0002';
  end if;

  if v_contract.bloqueio_a_partir_de is null then
    raise exception 'billing_carencia_sem_bloqueio_programado' using errcode = 'P0002';
  end if;

  if p_ate <= v_contract.bloqueio_a_partir_de then
    raise exception 'billing_carencia_data_nao_posterior' using errcode = '22023';
  end if;

  update public.billing_contracts
    set bloqueio_a_partir_de = p_ate
    where id = v_contract.id;

  insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
  values (
    p_org, v_contract.id, 'carencia',
    v_contract.bloqueio_a_partir_de::text, p_ate::text,
    'carencia_extra', p_actor
  );

  return v_contract.bloqueio_a_partir_de;
end;
$$;

comment on function public.fn_billing_estender_carencia(uuid, timestamptz, uuid) is
  '0910, fase F7, lote 1b, D-069: adia billing_contracts.bloqueio_a_partir_de de UMA organização para p_ate, trocando a escrita direta que app/actions/admin/planoDaOrganizacao.ts (darCarenciaExtra) fazia com o cliente de serviço. Lê e escreve na MESMA transação sob select ... for update: sem janela entre leitura e escrita. Recusa (P0002) organização sem contrato ou sem bloqueio_a_partir_de programado; recusa (22023) data que não é posterior à carência atual (só ADIA). Grava um evento em billing_contract_eventos (tipo=carencia, motivo=carencia_extra, actor=p_actor) na MESMA transação. Devolve o bloqueio_a_partir_de ANTERIOR ao update.';

revoke execute on function public.fn_billing_estender_carencia(uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_estender_carencia(uuid, timestamptz, uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_estender_carencia(uuid, timestamptz, uuid) from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- PARTE 4 (fase F7, lote 1b, auditoria): D-061 era falso positivo. Reverte
-- fn_reserve_channel_connection para o corpo da migration 0232.
-- ============================================================================
--
-- fn_finish_channel_connection (migration 0228) já zera archived_at no
-- próprio SET da atualização de channel_sessions
-- (`archived_at=case when p_status<>'FAILED' then null else archived_at
-- end`): a coluna está na lista do UPDATE mesmo quando o valor final é
-- igual ao anterior. trg_billing_trava_channel_sessions (before insert or
-- update OF archived_at, migration 0907) dispara por COLUNA NA LISTA do
-- comando, não por mudança de valor (mesmo mecanismo do gatilho `of
-- <coluna>` de qualquer trigger do Postgres): toda chamada de
-- fn_finish_channel_connection já passa pelo teto de conexões do plano,
-- inclusive quando ela conclui a reativação de uma sessão arquivada que o
-- onboarding tinha reservado antes. D-061 (lote 4b, PARTE 2 desta
-- migration, acima) fazia fn_reserve_channel_connection TAMBÉM zerar
-- archived_at, na reserva: a mesma reativação passaria a contar no teto
-- DUAS vezes (reserva + finish) no caminho normal, e uma vez sozinha (sem
-- passar por finish) numa reserva que falha ou nunca é concluída: um
-- alargamento do que o teto pune, não um fechamento de furo.
--
-- Reverte para o corpo original da migration 0232 (última definição vale,
-- CLAUDE.md item 10; corpo idêntico, char a char, ao de 0232): o ramo de
-- onboarding volta a achar a sessão arquivada sem zerar archived_at, que só
-- é limpo quando fn_finish_channel_connection conclui de verdade.
--
-- Prova de banco (a sessão arquivada continua arquivada depois da reserva):
-- tests/invariants/saneamento-autor.test.ts, describe "2. D-061".

create or replace function public.fn_reserve_channel_connection(p_org uuid,p_key uuid,p_hash text,p_display_name text default null,p_onboarding boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt public.channel_connection_requests; channel public.channel_sessions; token uuid:=gen_random_uuid();
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org)
 then raise exception 'connection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'connection_mfa_required' using errcode='42501';end if;
 if p_key is null or p_hash is null or length(p_hash)<>64 or length(coalesce(p_display_name,''))>100 then
  raise exception 'connection_invalid_request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,2281));
 delete from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key
  and state='succeeded' and updated_at<now()-interval '24 hours';
 select * into receipt from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key for update;
 if found then
  if receipt.request_hash<>p_hash then raise exception 'idempotency_conflict' using errcode='22023';end if;
  if receipt.state='succeeded' then
   select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id;
   return jsonb_build_object('replay',true,'channel',to_jsonb(channel),'receipt_id',receipt.id);
  end if;
  if receipt.state='processing' and receipt.lease_until>now() then
   raise exception 'connection_in_progress' using errcode='55P03';end if;
  select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id for update;
  if not found then raise exception 'connection_reservation_missing' using errcode='P0002';end if;
 else
  if p_onboarding then
   select * into channel from public.channel_sessions where organization_id=p_org and provider='waha'
    and (metadata->>'onboarding'='true' or waha_session_name='org_'||left(p_org::text,8))
    order by created_at limit 1 for update;
  end if;
  if channel.id is null then
   insert into public.channel_sessions(organization_id,waha_session_name,display_name,engine,webhook_path_token,
     webhook_secret_encrypted,status,last_status_change_at,consecutive_health_fails,daily_message_limit,metadata)
   values(p_org,'org_'||left(replace(p_org::text,'-',''),8)||'_'||replace(gen_random_uuid()::text,'-',''),p_display_name,'NOWEB',
     replace(gen_random_uuid()::text,'-',''),'\x00'::bytea,'STARTING',now(),0,250,
     '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'::jsonb
     || case when p_onboarding then '{"onboarding":true}'::jsonb else '{}'::jsonb end) returning * into channel;
  end if;
  if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
    and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
  insert into public.channel_connection_requests(organization_id,idempotency_key,request_hash,channel_session_id)
   values(p_org,p_key,p_hash,channel.id) returning * into receipt;
 end if;
 if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
   and id<>receipt.id and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
 update public.channel_connection_requests set state='processing',lease_token=token,lease_until=now()+interval '5 minutes',
  remote_created=false,updated_at=now() where organization_id=p_org and id=receipt.id;
 -- Não ressuscita antes da pós-condição remota. Arquivado permanece invisível
 -- até finish; falha conserva identidade e estado FAILED para reparo.
 update public.channel_sessions set status='STARTING',status_reason='connection_pending',last_status_change_at=now()
  where organization_id=p_org and id=channel.id returning * into channel;
 return jsonb_build_object('replay',false,'channel',to_jsonb(channel),'receipt_id',receipt.id,'lease_token',token);
end;
$$;

comment on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) is
  '0910, fase F7, lote 1b: reversão do D-061 (falso positivo, ver comentário da PARTE 4, acima). Corpo idêntico ao da migration 0232: no ramo de onboarding, acha a sessão waha arquivada sem zerar archived_at; a reativação de verdade (e a contagem no teto) acontece em fn_finish_channel_connection.';

revoke all on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) to authenticated;

-- ============================================================================
-- PARTE 5 (fase F7, lote 1b, auditoria): D-047, privilégio padrão de
-- supabase_admin em public também concedia TRUNCATE a anon/authenticated.
-- ============================================================================
--
-- A PARTE 2 desta migration (acima) só cobriu `alter default privileges FOR
-- ROLE POSTGRES`: em produção (Supabase gerenciado) o dono de schema/tabela é
-- `supabase_admin`, não `postgres`, e o `pg_default_acl` desse papel também
-- concede TRUNCATE a anon/authenticated em toda tabela futura, o mesmo
-- buraco do D-047, por um papel que a PARTE 2 não alcançava.
--
-- `postgres` pode não ter privilégio para alterar o padrão de OUTRO papel
-- (só o dono do papel, ou quem tem a role concedida, pode fazê-lo): o bloco
-- abaixo tenta e, se vier `insufficient_privilege` (42501), avisa e segue --
-- nunca derruba a migration por um papel que talvez nem exista nesta
-- instalação (banco local de desenvolvimento não tem supabase_admin).
--
-- Prova de banco (estado final no catálogo, pg_default_acl, para os dois
-- papéis que existirem): tests/invariants/planos-saneamento.test.ts.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute 'alter default privileges for role supabase_admin in schema public revoke truncate on tables from anon, authenticated';
    exception
      when insufficient_privilege then
        raise warning 'fase F7 lote 1b, D-047: sem privilégio para alterar o default de supabase_admin (42501); revogar TRUNCATE do default desse papel fica pendente de quem administra o projeto Supabase (fora do alcance de uma migration rodada como dono do schema).';
    end;
  end if;
end
$$;
