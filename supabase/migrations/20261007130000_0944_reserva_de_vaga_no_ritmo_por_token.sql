-- 0944, reserva atômica de vaga no ritmo de envio por token (D-167, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O freio de envio por token (lib/messaging/ritmo-do-envio-por-token.ts) lia o pacing_ledger,
-- decidia e só DEPOIS do envio gravava a linha: duas chamadas concorrentes no mesmo número liam o
-- mesmo estado e passavam juntas (estourando o espaçamento e o teto diário do warm-up), e o PostgREST
-- não tem advisory lock. Estas duas funções fecham a corrida no banco:
--
--   1. fn_pacing_reservar_vaga confere, sob pg_advisory_xact_lock(hashtext(canal)) (a MESMA chave que
--      o agente usa em lib/agent-engine/guardrails/before-send.ts, então agente e token se
--      serializam entre si), a contagem do dia contra o teto e o último sent_at contra o
--      espaçamento, e RESERVA a vaga inserindo a linha no ledger na mesma transação. Espaçamento
--      curto (até p_espera_maxima_ms) reserva a vaga para o instante em que o número libera
--      (sent_at no futuro): chamadas em rajada formam fila, cada uma na sua vez, em vez de
--      passarem juntas. Acima disso, ou no teto diário, devolve liberado = false sem gravar nada.
--   2. fn_pacing_liberar_vaga apaga a linha reservada quando o envio falha, para a vaga não
--      queimar o teto à toa.
--
-- A REGRA (teto do warm-up e do daily_message_limit, espaçamento com jitter) continua em
-- lib/agent-engine/pacing/ledger-supabase.ts: a aplicação calcula p_teto, p_espera_ms e
-- p_inicio_do_dia e o banco só compara e grava, atomicamente. Só service_role executa. Funções novas
-- por create or replace, sem DDL de tabela: reaplicável com o app no ar.

create or replace function public.fn_pacing_reservar_vaga(
  p_org uuid,
  p_canal uuid,
  p_agora timestamptz,
  p_inicio_do_dia timestamptz,
  p_teto integer,
  p_espera_ms integer,
  p_espera_maxima_ms integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_enviados_hoje integer;
  v_ultimo timestamptz;
  v_libera_em timestamptz;
  v_vaga_em timestamptz;
  v_id uuid;
begin
  if p_org is null or p_canal is null or p_agora is null or p_inicio_do_dia is null then
    raise exception 'pacing_entrada_invalida' using errcode = '22023';
  end if;

  -- Não espera mais que isso pelo número: quem não consegue a trava recebe erro (a aplicação
  -- recusa o envio) em vez de segurar a conexão.
  perform set_config('lock_timeout', '3s', true);

  if not exists (
    select 1 from public.channel_sessions where id = p_canal and organization_id = p_org
  ) then
    raise exception 'pacing_canal_inexistente' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_canal::text));

  -- Teto diário antes do espaçamento: adia por horas, o outro por segundos.
  if p_teto is not null then
    select count(*) into v_enviados_hoje
      from public.pacing_ledger
     where organization_id = p_org
       and channel_session_id = p_canal
       and sent_at >= p_inicio_do_dia;
    if v_enviados_hoje >= p_teto then
      return jsonb_build_object('liberado', false, 'motivo', 'teto_diario');
    end if;
  end if;

  select max(sent_at) into v_ultimo
    from public.pacing_ledger
   where organization_id = p_org and channel_session_id = p_canal;

  v_vaga_em := p_agora;
  if v_ultimo is not null and coalesce(p_espera_ms, 0) > 0 then
    v_libera_em := v_ultimo + (p_espera_ms * interval '1 millisecond');
    if v_libera_em > p_agora then
      if (extract(epoch from (v_libera_em - p_agora)) * 1000) > coalesce(p_espera_maxima_ms, 0) then
        return jsonb_build_object('liberado', false, 'motivo', 'espacamento', 'libera_em', v_libera_em);
      end if;
      v_vaga_em := v_libera_em;
    end if;
  end if;

  insert into public.pacing_ledger (organization_id, channel_session_id, sent_at)
  values (p_org, p_canal, v_vaga_em)
  returning id into v_id;

  return jsonb_build_object('liberado', true, 'vaga_id', v_id, 'libera_em', v_vaga_em);
end;
$$;

comment on function public.fn_pacing_reservar_vaga(uuid, uuid, timestamptz, timestamptz, integer, integer, integer) is
  '0944 (D-167): reserva atômica de vaga no ritmo de envio por token. Sob pg_advisory_xact_lock(hashtext(canal)), a mesma chave do agente, confere a contagem do dia (desde p_inicio_do_dia) contra p_teto e o último sent_at contra p_espera_ms; liberado: grava a linha no pacing_ledger e devolve vaga_id e libera_em (espaçamento até p_espera_maxima_ms reserva a vaga para o instante em que o número libera); não liberado: motivo teto_diario ou espacamento (com libera_em), sem gravar nada. Só service_role. Canal que não é da organização: P0002.';

revoke execute on function public.fn_pacing_reservar_vaga(uuid, uuid, timestamptz, timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_pacing_reservar_vaga(uuid, uuid, timestamptz, timestamptz, integer, integer, integer) to service_role;

create or replace function public.fn_pacing_liberar_vaga(
  p_org uuid,
  p_canal uuid,
  p_vaga uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_apagadas integer;
begin
  -- Só a linha da própria organização e do próprio canal: o id sozinho não apaga o ledger de outro.
  delete from public.pacing_ledger
   where id = p_vaga and organization_id = p_org and channel_session_id = p_canal;
  get diagnostics v_apagadas = row_count;
  return v_apagadas > 0;
end;
$$;

comment on function public.fn_pacing_liberar_vaga(uuid, uuid, uuid) is
  '0944 (D-167): devolve a vaga reservada por fn_pacing_reservar_vaga quando o envio falhou (apaga a linha do pacing_ledger, só se for da organização e do canal informados). true quando apagou. Só service_role.';

revoke execute on function public.fn_pacing_liberar_vaga(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_pacing_liberar_vaga(uuid, uuid, uuid) to service_role;

do $agent_worker_pacing$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_pacing_reservar_vaga(uuid, uuid, timestamptz, timestamptz, integer, integer, integer), public.fn_pacing_liberar_vaga(uuid, uuid, uuid) from agent_worker';
  end if;
end
$agent_worker_pacing$;
