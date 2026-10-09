-- 0953, o estado do pareamento por QR Code mora no banco, fora do alcance do usuário (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito (auditoria do pareamento por QR Code, achados C1 e A1). O pareamento por QR guardava "esta linha
-- é um pareamento pendente", "a instância foi criada pelo CRM" e "iniciado em" no `metadata` de
-- `channel_sessions`. Só que a policy `channel_sessions_tenant_write` (0150) deixa o ADMIN DA ORGANIZAÇÃO
-- gravar qualquer coluna da própria linha pelo PostgREST, `metadata` inclusive. Um admin conectava uma linha
-- por servidor e token apontando para um servidor dele, marcava pelo PATCH "pendente, iniciado há 31 minutos",
-- e a limpeza do CRM chamava esse servidor com o token de ADMINISTRADOR da instalação no cabeçalho.
-- Também não havia teto real de instâncias por organização: o limite de 2 pendentes era uma contagem de
-- `metadata` (editável) feita antes do insert (sem trava), e criar e cancelar em laço não tinha freio.
--
-- A correção, em duas partes, as duas aqui no banco:
--
--   1. COLUNAS PRÓPRIAS, travadas. `pareamento_qr_estado` (pendente ou concluido), `pareamento_qr_iniciado_em`,
--      `criada_pelo_crm`, e os contadores `pareamento_qr_falhas` (tentativas de limpeza que falharam, para a
--      linha que não sai nunca travar o lote), `pareamento_qr_codigos` e `pareamento_qr_codigo_em` (pedidos de
--      código de pareamento por telefone). Um gatilho BEFORE INSERT OR UPDATE OF recusa (42501, mensagem fixa)
--      gravar ou mudar qualquer uma quando quem grava não é o SERVIDOR, pelo mesmo critério da 0914
--      (fn_billing_e_servidor: conexão direta sem SET ROLE, ou service_role). Por gatilho e não por REVOKE de
--      coluna, pelo motivo escrito na 0914: o grant de tabela já deu o UPDATE, e revogar uma coluna sozinha
--      não tira o que o grant de tabela deu. O código passa a decidir pendente, criada pelo CRM e vencido
--      SÓ por estas colunas, nunca pelo `metadata`.
--   2. RESERVA ATÔMICA. `fn_channel_pareamento_qr_reservar` serializa por organização
--      (pg_advisory_xact_lock), confere no máximo 2 pareamentos pendentes e o teto de conexões da organização
--      e, passando, INSERE a linha pendente na mesma transação. O teto é o limite `conexoes` do plano vigente
--      (fn_billing_limites_efetivos), contado sobre TODAS as conexões não arquivadas da organização, de
--      qualquer canal (os pendentes já são linhas não arquivadas, então já estão na conta); sem limite no
--      plano, o teto de segurança é 50. Vale qualquer que seja billing_settings.modo (decisão do dono,
--      D-188, migration 0954: Conexões bloqueia sempre). Devolve {ok: true, id} ou
--      {ok: false, codigo: pendentes_demais | teto_de_instancias, teto, do_plano}, com do_plano true quando
--      o teto é o do plano (a tela fala de plano) e false quando é o de segurança. O gatilho do plano (PT402)
--      continua valendo dentro do insert e sobe como erro.
--
-- A linha pendente nasce com `webhook_secret_encrypted` provisório (um byte): a coluna é NOT NULL e o token
-- real só existe depois de a instância ser criada no servidor; o código o troca logo em seguida.
--
-- Não há preenchimento de linhas antigas: o recurso ainda não tinha sido publicado, então nenhuma linha
-- existente guarda o estado no `metadata`.
--
-- Re-auditoria do mesmo recurso, mesmos defeitos de raiz (a policy deixa o admin gravar a linha inteira):
--
--   3. A INSTÂNCIA DO CRM NÃO SAI POR FORA DO FLUXO. O teto de instâncias se furava apagando ou arquivando a
--      linha por fora do fluxo do QR: o DELETE genérico de canal, ou o PostgREST (policy for all), arquivava ou
--      apagava a linha sem apagar a instância no servidor (ela seguia viva e paga, sem linha que a contasse), e
--      trocar `uazapi_instance_id`, `uazapi_token_encrypted` ou `uazapi_base_url` desligava a linha da
--      instância real. O gatilho `trg_channel_sessions_trava_instancia_do_crm` recusa (42501), a quem não é o
--      servidor, o UPDATE de `archived_at`, `uazapi_instance_id`, `uazapi_token_encrypted`, `uazapi_base_url`,
--      `provider` e `webhook_secret_encrypted` (trocar o provider ou o segredo do webhook desligava a linha
--      do fluxo do QR) e o DELETE de uma linha com `criada_pelo_crm = true`. Linha comum (conectada pelo cliente com o servidor
--      e o token dele) segue como antes. Quem remove a conexão do CRM é o código, no servidor, depois de apagar
--      a instância (removerConexaoPorInstancia).
--   4. FREIO DE TAXA QUE NÃO SE MULTIPLICA. O limite de 10 pedidos por hora vivia só no contador da borda
--      (Redis, com queda para a memória de cada processo, que se multiplica por instância do app). A reserva
--      agora também conta no banco as criações da organização na última hora (`pareamento_qr_iniciado_em`,
--      que sobrevive ao arquivamento) e recusa a partir de 10 com o código `taxa_de_criacao`.
--
-- Reaplicável com o app no ar: add column if not exists (padrão constante, sem reescrever a tabela), a
-- constraint de tabela guardada por pg_constraint, create or replace na função e no gatilho, lock_timeout
-- curto, e a transação única fecha a janela em que a função nova teria o EXECUTE padrão do Supabase.
begin;

set lock_timeout = '3s';

alter table public.channel_sessions
  add column if not exists pareamento_qr_estado text
    constraint channel_sessions_pareamento_qr_estado_valido
    check (pareamento_qr_estado in ('pendente', 'concluido')),
  add column if not exists pareamento_qr_iniciado_em timestamptz,
  add column if not exists criada_pelo_crm boolean not null default false,
  add column if not exists pareamento_qr_falhas integer not null default 0
    constraint channel_sessions_pareamento_qr_falhas_nao_negativa check (pareamento_qr_falhas >= 0),
  add column if not exists pareamento_qr_codigos integer not null default 0
    constraint channel_sessions_pareamento_qr_codigos_nao_negativo check (pareamento_qr_codigos >= 0),
  add column if not exists pareamento_qr_codigo_em timestamptz;

comment on column public.channel_sessions.pareamento_qr_estado is
  '0953: estado do pareamento por QR Code: pendente (o cliente ainda não leu), concluido (o número conectou) ou nulo (a linha não nasceu de um pareamento, ou ele foi desfeito). Só o servidor grava (gatilho trg_channel_sessions_trava_pareamento_qr).';
comment on column public.channel_sessions.pareamento_qr_iniciado_em is
  '0953: quando o pareamento por QR Code começou. A limpeza vence o pendente por esta coluna (30 minutos), nunca por data do metadata. Só o servidor grava.';
comment on column public.channel_sessions.criada_pelo_crm is
  '0953: a instância foi CRIADA pelo CRM (pareamento por QR Code), e por isso é dele apagá-la no servidor ao remover a conexão e contá-la no teto de instâncias. Só o servidor grava.';
comment on column public.channel_sessions.pareamento_qr_falhas is
  '0953: quantas rodadas de limpeza falharam para este pendente (instância não apagada, servidor fora). Passando do limite a linha sai do lote da limpeza. Só o servidor grava.';
comment on column public.channel_sessions.pareamento_qr_codigos is
  '0953: quantos códigos de pareamento por telefone já foram pedidos neste pareamento (máximo 5). Só o servidor grava.';
comment on column public.channel_sessions.pareamento_qr_codigo_em is
  '0953: quando o último código de pareamento por telefone foi pedido (um a cada 30 segundos). Só o servidor grava.';

do $d0953$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'channel_sessions_pareamento_qr_pendente_tem_inicio'
       and conrelid = 'public.channel_sessions'::regclass
  ) then
    alter table public.channel_sessions
      add constraint channel_sessions_pareamento_qr_pendente_tem_inicio
      check (pareamento_qr_estado is distinct from 'pendente' or pareamento_qr_iniciado_em is not null);
  end if;
end
$d0953$;

create or replace function public.fn_channel_sessions_trava_pareamento_qr()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.fn_billing_e_servidor() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.pareamento_qr_estado is not null
       or new.pareamento_qr_iniciado_em is not null
       or coalesce(new.criada_pelo_crm, false)
       or coalesce(new.pareamento_qr_falhas, 0) <> 0
       or coalesce(new.pareamento_qr_codigos, 0) <> 0
       or new.pareamento_qr_codigo_em is not null then
      raise exception 'estado do pareamento por QR só pode ser alterado pelo servidor' using errcode = '42501';
    end if;
  elsif new.pareamento_qr_estado is distinct from old.pareamento_qr_estado
     or new.pareamento_qr_iniciado_em is distinct from old.pareamento_qr_iniciado_em
     or new.criada_pelo_crm is distinct from old.criada_pelo_crm
     or new.pareamento_qr_falhas is distinct from old.pareamento_qr_falhas
     or new.pareamento_qr_codigos is distinct from old.pareamento_qr_codigos
     or new.pareamento_qr_codigo_em is distinct from old.pareamento_qr_codigo_em then
    raise exception 'estado do pareamento por QR só pode ser alterado pelo servidor' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.fn_channel_sessions_trava_pareamento_qr() is
  '0953: recusa gravar ou mudar as colunas do pareamento por QR Code (pareamento_qr_estado, pareamento_qr_iniciado_em, criada_pelo_crm, pareamento_qr_falhas, pareamento_qr_codigos, pareamento_qr_codigo_em) quando quem grava não é o servidor (fn_billing_e_servidor: conexão direta sem SET ROLE ou service_role). O admin da organização grava a linha pelo PostgREST (policy channel_sessions_tenant_write); sem isto ele marcaria uma linha dele como pendente vencida ou criada pelo CRM e poria o código da limpeza a falar com um servidor escolhido por ele. errcode 42501, mensagem fixa. INSERT com os valores padrão (todo canal comum) e UPDATE que não muda o valor passam.';

revoke execute on function public.fn_channel_sessions_trava_pareamento_qr() from public, anon, authenticated;
grant execute on function public.fn_channel_sessions_trava_pareamento_qr() to service_role;

create or replace trigger trg_channel_sessions_trava_pareamento_qr
  before insert or update of
    pareamento_qr_estado, pareamento_qr_iniciado_em, criada_pelo_crm,
    pareamento_qr_falhas, pareamento_qr_codigos, pareamento_qr_codigo_em
  on public.channel_sessions
  for each row
  execute function public.fn_channel_sessions_trava_pareamento_qr();

create or replace function public.fn_channel_sessions_trava_instancia_do_crm()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.fn_billing_e_servidor() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Linha comum (conectada pelo cliente com o servidor e o token dele): como sempre foi.
  if old.criada_pelo_crm is not true then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE'
     or new.archived_at is distinct from old.archived_at
     or new.uazapi_instance_id is distinct from old.uazapi_instance_id
     or new.uazapi_token_encrypted is distinct from old.uazapi_token_encrypted
     or new.uazapi_base_url is distinct from old.uazapi_base_url
     or new.provider is distinct from old.provider
     or new.webhook_secret_encrypted is distinct from old.webhook_secret_encrypted then
    raise exception 'a instância criada pelo CRM só pode ser removida ou trocada pelo servidor' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.fn_channel_sessions_trava_instancia_do_crm() is
  '0953: numa linha com criada_pelo_crm = true, recusa a quem não é o servidor (fn_billing_e_servidor) o DELETE e o UPDATE de archived_at, uazapi_instance_id, uazapi_token_encrypted, uazapi_base_url, provider e webhook_secret_encrypted. Sem isto o admin da organização (policy channel_sessions_tenant_write, for all) arquivava ou apagava a linha pelo PostgREST e a instância seguia viva e paga no servidor sem linha que a contasse no teto, ou religava a linha a outra instância. Linha comum não é afetada. errcode 42501, mensagem fixa.';

revoke execute on function public.fn_channel_sessions_trava_instancia_do_crm() from public, anon, authenticated;
grant execute on function public.fn_channel_sessions_trava_instancia_do_crm() to service_role;

create or replace trigger trg_channel_sessions_trava_instancia_do_crm
  before delete or update of archived_at, uazapi_instance_id, uazapi_token_encrypted, uazapi_base_url, provider, webhook_secret_encrypted
  on public.channel_sessions
  for each row
  execute function public.fn_channel_sessions_trava_instancia_do_crm();

create or replace function public.fn_channel_pareamento_qr_reservar(
  p_organization_id uuid,
  p_session_id uuid,
  p_base_url text,
  p_webhook_path_token text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_pendentes integer;
  v_limite integer;
  v_teto integer;
  v_ativas integer;
  v_criadas integer;
begin
  if p_organization_id is null or p_session_id is null or p_base_url is null or p_webhook_path_token is null then
    raise exception 'pareamento_qr_entrada_invalida' using errcode = '22023';
  end if;

  -- Não espera mais que isso pela trava: quem não a consegue recebe erro e a aplicação recusa o pedido.
  perform set_config('lock_timeout', '3s', true);

  if not exists (select 1 from public.organizations where id = p_organization_id) then
    raise exception 'pareamento_qr_organizacao_inexistente' using errcode = 'P0002';
  end if;

  -- Uma trava por organização: duas reservas simultâneas não leem a mesma contagem.
  perform pg_advisory_xact_lock(hashtextextended('pareamento_qr:' || p_organization_id::text, 0));

  select count(*) into v_pendentes
    from public.channel_sessions
   where organization_id = p_organization_id
     and archived_at is null
     and pareamento_qr_estado = 'pendente';
  if v_pendentes >= 2 then
    return jsonb_build_object('ok', false, 'codigo', 'pendentes_demais');
  end if;

  -- Freio de taxa que não se multiplica: as instâncias que o CRM criou nesta organização na última hora,
  -- arquivadas inclusive (criar e cancelar em laço), contadas aqui e não só no contador da borda.
  select count(*) into v_criadas
    from public.channel_sessions
   where organization_id = p_organization_id
     and criada_pelo_crm
     and pareamento_qr_iniciado_em > now() - interval '1 hour';
  if v_criadas >= 10 then
    return jsonb_build_object('ok', false, 'codigo', 'taxa_de_criacao');
  end if;

  -- O teto: o limite de conexões do plano vigente (todos os canais somados) quando houver, senão o teto de
  -- segurança de 50. Não olha billing_settings.modo: Conexões bloqueia sempre (D-188, migration 0954).
  begin
    v_limite := (public.fn_billing_limites_efetivos(p_organization_id) ->> 'conexoes')::integer;
  exception when others then
    v_limite := null;
  end;
  v_teto := greatest(coalesce(v_limite, 50), 0);

  -- TODAS as conexões não arquivadas da organização, de qualquer canal. O pendente de QR é uma linha não
  -- arquivada, então já está nesta conta (não se soma de novo).
  select count(*) into v_ativas
    from public.channel_sessions
   where organization_id = p_organization_id
     and archived_at is null;
  if v_ativas >= v_teto then
    return jsonb_build_object(
      'ok', false, 'codigo', 'teto_de_instancias', 'teto', v_teto, 'do_plano', v_limite is not null
    );
  end if;

  insert into public.channel_sessions (
    id, organization_id, provider, uazapi_instance_id, uazapi_base_url, webhook_path_token,
    webhook_secret_encrypted, display_name, status, archived_at, metadata,
    pareamento_qr_estado, pareamento_qr_iniciado_em, criada_pelo_crm
  ) values (
    p_session_id, p_organization_id, 'uazapi', 'pendente-' || p_session_id::text, p_base_url, p_webhook_path_token,
    '\x00'::bytea, 'WhatsApp', 'STARTING', null, coalesce(p_metadata, '{}'::jsonb),
    'pendente', now(), true
  );

  return jsonb_build_object('ok', true, 'id', p_session_id);
end;
$$;

comment on function public.fn_channel_pareamento_qr_reservar(uuid, uuid, text, text, jsonb) is
  '0953: reserva atômica de um pareamento por QR Code. Sob pg_advisory_xact_lock por organização, confere no máximo 2 pendentes (pendentes_demais) e o teto de conexões (teto_de_instancias): o limite conexoes do plano vigente contado sobre TODAS as conexões não arquivadas da organização, de qualquer canal (os pendentes já são linhas não arquivadas), ou 50 quando o plano não tem limite, qualquer que seja billing_settings.modo. Passando, insere a linha pendente (STARTING, criada_pelo_crm, iniciada agora, webhook_secret_encrypted provisório) e devolve {ok: true, id}; senão {ok: false, codigo, teto, do_plano}. O gatilho do plano (PT402) continua valendo e sobe como erro. Antes do teto, recusa com taxa_de_criacao quando a organização já criou 10 instâncias pelo CRM na última hora (pareamento_qr_iniciado_em, arquivadas inclusive). Só service_role.';

revoke execute on function public.fn_channel_pareamento_qr_reservar(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_channel_pareamento_qr_reservar(uuid, uuid, text, text, jsonb) to service_role;

do $agent_worker_pareamento_qr$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_channel_sessions_trava_pareamento_qr() from agent_worker';
    execute 'revoke execute on function public.fn_channel_sessions_trava_instancia_do_crm() from agent_worker';
    execute 'revoke execute on function public.fn_channel_pareamento_qr_reservar(uuid, uuid, text, text, jsonb) from agent_worker';
  end if;
end
$agent_worker_pareamento_qr$;

commit;

reset lock_timeout;
