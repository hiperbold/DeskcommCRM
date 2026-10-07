-- 0946, régua de aviso de renovação do plano que não renova sozinho (D-177, parte 2, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do Filipe em 06/10/2026: o contrato que NÃO renova sozinho (pago parcelado ou no Pix, sem
-- assinatura viva no Asaas) recebe um aviso 30, 15, 7 e 1 dia antes do último dia de acesso e no
-- próprio último dia. A régua para quando ele renova. Esta migration guarda as regras que precisam do
-- banco; o envio (e-mail ao admin da organização, aviso na Central e push) é do job diário
-- app/api/v1/cron/avisar-renovacao (lib/billing/assinatura/avisar-renovacao.ts).
--
-- O que ela faz:
--   1. billing_avisos_de_renovacao: um aviso por (organização, fim do período, marco), com o resultado
--      de CADA canal (e-mail e Central). É a idempotência da régua e o rastro de falha. RLS ligada sem
--      policy nenhuma: só o servidor (service_role) lê e grava, nem select o cliente tem.
--   2. fn_billing_assinatura_viva: a regra de "tem assinatura viva no Asaas" (id gravado e sem marcador
--      de encerramento) em um lugar só. É a mesma de parcelasDoPlanoSemRenovacao
--      (app/app/settings/plano/_logica-compra.ts), que decide o aviso da tela do plano.
--   3. fn_billing_renovacao_marco: o marco vigente de um fim de período, em datas de America/Sao_Paulo.
--      current_period_end é limite EXCLUSIVO (00h de São Paulo do dia seguinte ao último dia de acesso),
--      então o último dia de acesso é o dia de (current_period_end - 1 microssegundo) em São Paulo.
--      Marcos: 30, 15, 7, 1 e 0 dias (0 = o próprio último dia). Devolve o MENOR marco que já venceu
--      (dias restantes <= marco), ou nulo com mais de 30 dias: job atrasado manda só o mais recente,
--      nunca uma pilha de avisos antigos.
--   4. fn_billing_renovacao_pendentes: os contratos que pedem aviso agora. Contrato ativo, gateway
--      asaas, SEM assinatura viva, sem cancel_at_period_end, período no futuro, organização ativa, e
--      cujo marco vigente ainda não saiu (ou saiu com falha que vale repetir).
--   5. fn_billing_renovacao_reservar: sob trava do contrato, REVALIDA tudo (período que mudou, contrato
--      que passou a renovar sozinho ou foi cancelado, organização suspensa) e reserva o marco, dizendo a
--      quem chamou quais canais ele deve cumprir. Duas rodadas ao mesmo tempo não cumprem o mesmo canal.
--   6. fn_billing_renovacao_criar_aviso: cria o aviso na Central e marca o canal como cumprido na mesma
--      transação (ref_kind billing_assinatura, o ref_kind de plano que o membro não forja nem apaga).
--   7. fn_billing_renovacao_encerrar_avisos: resolve na Central o aviso de quem renovou, cancelou ou
--      passou a ter assinatura viva (a régua morre sozinha, e o aviso velho não fica mentindo).
--
-- cancel_at_period_end: nenhuma coluna diz QUEM o ligou (cliente, admin da plataforma, estorno ou
-- assinatura removida no Asaas). Em todos os casos o contrato será cancelado no fim do período, então
-- pedir renovação seria ruído: contrato com cancel_at_period_end ligado sai da régua.
--
-- Reaplicável com o app no ar: create table if not exists, create or replace, lock_timeout curto, e a
-- transação única fecha a janela em que a tabela nova teria o ACL padrão do Supabase.
begin;

set lock_timeout = '3s';

-- ── 1. A tabela ──
create table if not exists public.billing_avisos_de_renovacao (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.billing_contracts(id) on delete cascade,
  fim_do_periodo timestamptz not null,
  marco smallint not null,
  reservado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  email_resultado text not null default 'pendente',
  email_enviados integer not null default 0,
  email_falhas integer not null default 0,
  aviso_resultado text not null default 'pendente',
  inbox_item_id uuid references public.agent_inbox_items(id) on delete set null,
  constraint billing_avisos_de_renovacao_marco_check check (marco in (30, 15, 7, 1, 0)),
  constraint billing_avisos_de_renovacao_email_check
    check (email_resultado in ('pendente', 'enviado', 'parcial', 'sem_destinatario', 'nao_configurado', 'falhou')),
  constraint billing_avisos_de_renovacao_aviso_check check (aviso_resultado in ('pendente', 'criado', 'falhou')),
  constraint billing_avisos_de_renovacao_periodo_marco_unique unique (organization_id, fim_do_periodo, marco)
);

comment on table public.billing_avisos_de_renovacao is
  '0946 (D-177, parte 2): um aviso de renovação por (organização, fim do período, marco 30/15/7/1/0), com o resultado de cada canal. A unicidade é a idempotência da régua: o marco sai uma vez por período. email_resultado: pendente (reservado ou em voo, nunca reenviado), enviado, parcial (alguns destinatários falharam), sem_destinatario, nao_configurado, falhou (nada saiu; a rodada seguinte do mesmo marco repete). aviso_resultado: pendente, criado, falhou. Só service_role lê e grava; RLS ligada sem policy nenhuma.';

create index if not exists billing_avisos_de_renovacao_contract_idx
  on public.billing_avisos_de_renovacao (contract_id);

alter table public.billing_avisos_de_renovacao enable row level security;

revoke all on public.billing_avisos_de_renovacao from anon, authenticated;
grant select, insert, update on public.billing_avisos_de_renovacao to service_role;
revoke delete, truncate on public.billing_avisos_de_renovacao from service_role;

-- ── 2. Assinatura viva no Asaas ──
create or replace function public.fn_billing_assinatura_viva(
  p_asaas_subscription_id text,
  p_asaas_assinatura_encerrada_em timestamptz
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_asaas_subscription_id is not null and p_asaas_assinatura_encerrada_em is null;
$$;

comment on function public.fn_billing_assinatura_viva(text, timestamptz) is
  '0946 (D-177, parte 2): o contrato tem assinatura viva no Asaas quando asaas_subscription_id está gravado e asaas_assinatura_encerrada_em é nulo. Contrato SEM assinatura viva (e com período pago no futuro) não renova sozinho. É a mesma regra de parcelasDoPlanoSemRenovacao (app/app/settings/plano/_logica-compra.ts).';

revoke execute on function public.fn_billing_assinatura_viva(text, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_billing_assinatura_viva(text, timestamptz) to service_role;

-- ── 3. O marco vigente ──
create or replace function public.fn_billing_renovacao_marco(
  p_fim timestamptz,
  p_agora timestamptz default now()
)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select min(m)::integer
    from unnest(array[0, 1, 7, 15, 30]) as m
   where m >= (
     ((p_fim - interval '1 microsecond') at time zone 'America/Sao_Paulo')::date
     - (p_agora at time zone 'America/Sao_Paulo')::date
   );
$$;

comment on function public.fn_billing_renovacao_marco(timestamptz, timestamptz) is
  '0946 (D-177, parte 2): o marco vigente da régua de renovação. Último dia de acesso = dia, em America/Sao_Paulo, de (p_fim - 1 microssegundo), porque current_period_end é exclusivo. Devolve o MENOR marco de 0, 1, 7, 15, 30 que já venceu (dias até o último dia <= marco), ou nulo com mais de 30 dias.';

revoke execute on function public.fn_billing_renovacao_marco(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_billing_renovacao_marco(timestamptz, timestamptz) to service_role;

-- ── 4. Quem pede aviso agora ──
create or replace function public.fn_billing_renovacao_pendentes(
  p_agora timestamptz default now(),
  p_limite integer default 500
)
returns table (
  organization_id uuid,
  contract_id uuid,
  fim_do_periodo timestamptz,
  ultimo_dia date,
  dias_restantes integer,
  marco integer,
  precisa_email boolean,
  precisa_aviso boolean,
  plano_nome text,
  ciclo text,
  org_nome text,
  org_locale text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with base as (
    select bc.organization_id,
           bc.id as contract_id,
           bc.current_period_end as fim,
           ((bc.current_period_end - interval '1 microsecond') at time zone 'America/Sao_Paulo')::date as ultimo_dia,
           (p_agora at time zone 'America/Sao_Paulo')::date as hoje,
           public.fn_billing_renovacao_marco(bc.current_period_end, p_agora) as marco,
           bc.cycle as ciclo,
           bp.name as plano_nome,
           o.display_name as org_nome,
           o.locale as org_locale
      from public.billing_contracts bc
      join public.organizations o on o.id = bc.organization_id and o.status = 'active'
      join public.billing_plans bp on bp.id = bc.plan_id
     where bc.status = 'ativa'
       and bc.gateway = 'asaas'
       and not public.fn_billing_assinatura_viva(bc.asaas_subscription_id, bc.asaas_assinatura_encerrada_em)
       and not coalesce(bc.cancel_at_period_end, false)
       and bc.current_period_end is not null
       and bc.current_period_end > p_agora
  )
  select b.organization_id,
         b.contract_id,
         b.fim,
         b.ultimo_dia,
         (b.ultimo_dia - b.hoje)::integer,
         b.marco,
         (a.id is null or a.email_resultado = 'falhou'),
         (a.id is null
           or a.aviso_resultado = 'falhou'
           or (a.aviso_resultado = 'pendente' and a.atualizado_em < p_agora - interval '10 minutes')),
         b.plano_nome,
         b.ciclo,
         b.org_nome,
         b.org_locale
    from base b
    left join public.billing_avisos_de_renovacao a
           on a.organization_id = b.organization_id and a.fim_do_periodo = b.fim and a.marco = b.marco
   where b.marco is not null
     and (
       a.id is null
       or a.email_resultado = 'falhou'
       or a.aviso_resultado = 'falhou'
       or (a.aviso_resultado = 'pendente' and a.atualizado_em < p_agora - interval '10 minutes')
     )
   order by b.fim, b.organization_id
   limit greatest(coalesce(p_limite, 500), 1);
$$;

comment on function public.fn_billing_renovacao_pendentes(timestamptz, integer) is
  '0946 (D-177, parte 2): os contratos que pedem aviso de renovação agora, um marco por contrato (o vigente). Contrato ativo, gateway asaas, SEM assinatura viva (fn_billing_assinatura_viva), sem cancel_at_period_end, período no futuro, organização ativa. precisa_email: marco ainda não reservado ou e-mail que falhou sem entregar nada. precisa_aviso: marco ainda não reservado, aviso que falhou, ou reserva presa em pendente há mais de 10 minutos. Só service_role.';

revoke execute on function public.fn_billing_renovacao_pendentes(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_renovacao_pendentes(timestamptz, integer) to service_role;

-- ── 5. Reservar o marco ──
create or replace function public.fn_billing_renovacao_reservar(
  p_org uuid,
  p_contract uuid,
  p_fim timestamptz,
  p_marco integer,
  p_agora timestamptz default now()
)
returns table (reserva_id uuid, enviar_email boolean, criar_aviso boolean)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contrato public.billing_contracts%rowtype;
  v_linha public.billing_avisos_de_renovacao%rowtype;
  v_id uuid;
  v_email boolean := false;
  v_aviso boolean := false;
begin
  if p_org is null or p_contract is null or p_fim is null or p_marco is null or p_marco not in (30, 15, 7, 1, 0) then
    raise exception 'renovacao_entrada_invalida' using errcode = '22023';
  end if;

  perform set_config('lock_timeout', '3s', true);

  select * into v_contrato
    from public.billing_contracts
   where id = p_contract and organization_id = p_org
   for update;
  if not found then
    return;
  end if;

  -- Revalida sob a trava: o contrato pode ter renovado, cancelado ou ganhado assinatura viva, e a
  -- organização pode ter sido suspensa, entre a listagem e a reserva.
  if v_contrato.status <> 'ativa'
     or v_contrato.gateway is distinct from 'asaas'
     or public.fn_billing_assinatura_viva(v_contrato.asaas_subscription_id, v_contrato.asaas_assinatura_encerrada_em)
     or coalesce(v_contrato.cancel_at_period_end, false)
     or v_contrato.current_period_end is distinct from p_fim
     or p_fim <= p_agora
     or public.fn_billing_renovacao_marco(p_fim, p_agora) is distinct from p_marco
  then
    return;
  end if;

  if not exists (select 1 from public.organizations where id = p_org and status = 'active') then
    return;
  end if;

  insert into public.billing_avisos_de_renovacao (organization_id, contract_id, fim_do_periodo, marco, reservado_em, atualizado_em)
  values (p_org, p_contract, p_fim, p_marco, p_agora, p_agora)
  on conflict (organization_id, fim_do_periodo, marco) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true, true;
    return;
  end if;

  select * into v_linha
    from public.billing_avisos_de_renovacao
   where organization_id = p_org and fim_do_periodo = p_fim and marco = p_marco
   for update;

  -- E-mail: só repete quando nada saiu (falhou). Reserva presa em pendente pode ter saído antes do
  -- processo morrer, e reenviar e-mail em dobro é pior que não enviar.
  if v_linha.email_resultado = 'falhou' then
    v_email := true;
  end if;
  -- Aviso na Central: repete quando falhou ou ficou preso em pendente (criar o aviso é atômico, então
  -- pendente velho quer dizer que nada foi criado).
  if v_linha.aviso_resultado = 'falhou'
     or (v_linha.aviso_resultado = 'pendente' and v_linha.atualizado_em < p_agora - interval '10 minutes') then
    v_aviso := true;
  end if;

  if v_email or v_aviso then
    update public.billing_avisos_de_renovacao
       set email_resultado = case when v_email then 'pendente' else email_resultado end,
           aviso_resultado = case when v_aviso then 'pendente' else aviso_resultado end,
           atualizado_em = p_agora
     where id = v_linha.id;
  end if;

  return query select v_linha.id, v_email, v_aviso;
end;
$$;

comment on function public.fn_billing_renovacao_reservar(uuid, uuid, timestamptz, integer, timestamptz) is
  '0946 (D-177, parte 2): reserva o marco do aviso de renovação sob for update do contrato. Revalida (contrato ativo, asaas, sem assinatura viva, sem cancel_at_period_end, mesmo current_period_end, marco ainda vigente, organização ativa) e devolve nada quando algo mudou. Marco novo: grava a reserva e devolve enviar_email e criar_aviso verdadeiros. Marco já reservado: devolve verdadeiro só nos canais que ainda precisam (e-mail que falhou, aviso que falhou ou ficou preso), já marcados como pendente para esta chamada; duas rodadas ao mesmo tempo não cumprem o mesmo canal. Só service_role.';

revoke execute on function public.fn_billing_renovacao_reservar(uuid, uuid, timestamptz, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_billing_renovacao_reservar(uuid, uuid, timestamptz, integer, timestamptz) to service_role;

-- ── 6. O aviso na Central ──
create or replace function public.fn_billing_renovacao_criar_aviso(
  p_reserva uuid,
  p_titulo text,
  p_corpo text,
  p_severidade text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_linha public.billing_avisos_de_renovacao%rowtype;
  v_item uuid;
begin
  if p_reserva is null or p_titulo is null or char_length(btrim(p_titulo)) = 0
     or p_severidade is null or p_severidade not in ('info', 'warn') then
    raise exception 'renovacao_aviso_invalido' using errcode = '22023';
  end if;

  select * into v_linha
    from public.billing_avisos_de_renovacao
   where id = p_reserva
   for update;
  -- Reserva inexistente, ou aviso já criado: nada a fazer (idempotente).
  if not found or v_linha.aviso_resultado <> 'pendente' then
    return null;
  end if;

  -- ref_id é a própria organização, como os outros avisos de plano (billing_assinatura).
  insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
  values (v_linha.organization_id, 'other', p_severidade, p_titulo, p_corpo, 'billing_assinatura', v_linha.organization_id)
  returning id into v_item;

  update public.billing_avisos_de_renovacao
     set aviso_resultado = 'criado', inbox_item_id = v_item, atualizado_em = now()
   where id = p_reserva;

  return v_item;
end;
$$;

comment on function public.fn_billing_renovacao_criar_aviso(uuid, text, text, text) is
  '0946 (D-177, parte 2): cria o aviso de renovação na Central (kind other, ref_kind billing_assinatura, ref_id = a organização) e marca aviso_resultado = criado na MESMA transação, então um retry nunca duplica. Severidade info ou warn. Devolve o id do item, ou nulo quando a reserva não existe ou o aviso já foi criado. Só service_role.';

revoke execute on function public.fn_billing_renovacao_criar_aviso(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_billing_renovacao_criar_aviso(uuid, text, text, text) to service_role;

-- ── 7. A régua morre sozinha ──
create or replace function public.fn_billing_renovacao_encerrar_avisos(p_agora timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_resolvidos integer;
begin
  update public.agent_inbox_items i
     set status = 'resolved', resolved_at = p_agora
    from public.billing_avisos_de_renovacao a
    join public.billing_contracts bc on bc.id = a.contract_id
   where i.id = a.inbox_item_id
     and i.status in ('open', 'ack')
     and (
       a.fim_do_periodo is distinct from bc.current_period_end
       or bc.status <> 'ativa'
       or bc.gateway is distinct from 'asaas'
       or coalesce(bc.cancel_at_period_end, false)
       or public.fn_billing_assinatura_viva(bc.asaas_subscription_id, bc.asaas_assinatura_encerrada_em)
       or bc.current_period_end is null
       or bc.current_period_end <= p_agora
     );
  get diagnostics v_resolvidos = row_count;
  return v_resolvidos;
end;
$$;

comment on function public.fn_billing_renovacao_encerrar_avisos(timestamptz) is
  '0946 (D-177, parte 2): resolve na Central o aviso de renovação cujo contrato renovou (current_period_end mudou), foi cancelado, ganhou assinatura viva, deixou de estar ativo ou já passou do fim do período. Devolve quantos itens resolveu. Só service_role.';

revoke execute on function public.fn_billing_renovacao_encerrar_avisos(timestamptz) from public, anon, authenticated;
grant execute on function public.fn_billing_renovacao_encerrar_avisos(timestamptz) to service_role;

do $agent_worker_renovacao$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.billing_avisos_de_renovacao from agent_worker';
    execute 'revoke execute on function public.fn_billing_assinatura_viva(text, timestamptz), public.fn_billing_renovacao_marco(timestamptz, timestamptz), public.fn_billing_renovacao_pendentes(timestamptz, integer), public.fn_billing_renovacao_reservar(uuid, uuid, timestamptz, integer, timestamptz), public.fn_billing_renovacao_criar_aviso(uuid, text, text, text), public.fn_billing_renovacao_encerrar_avisos(timestamptz) from agent_worker';
  end if;
end
$agent_worker_renovacao$;

commit;

reset lock_timeout;
