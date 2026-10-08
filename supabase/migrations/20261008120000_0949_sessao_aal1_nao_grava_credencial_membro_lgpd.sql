-- 0949, a sessão sem o segundo fator não grava em credencial, convite, recuperação de acesso e LGPD (D-092) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. A 0918 fechou `api_tokens` e `user_organizations`, mas a RLS segue sem olhar o nível
-- da sessão nas demais tabelas. Quem tem a senha de um admin com TOTP cadastrado (sessão aal1) e
-- usa a chave pública do projeto direto no PostgREST ainda escreve nelas: troca a chave de IA ou o
-- token de uma conexão, cria convite de admin (team_invites), grava códigos de recuperação
-- que ele conhece (user_recovery_codes, que contornam o segundo fator no login), mexe em pedido de
-- LGPD e nos dados da empresa (organizations, só o admin de plataforma full escreve).
--
-- A correção. A mesma da 0918: uma política RESTRICTIVE por comando de escrita (insert, update,
-- delete) só para `authenticated`, pela ponte `fn_session_mfa_proven_rls()`. A regra é a de
-- `fn_session_mfa_proven()`: sessão aal2, OU o usuário não tem fator TOTP verificado (quem nunca
-- cadastrou não é trancado fora; o gate de cadastro é do app). Não muda nada para service_role nem
-- para função security definer, que é por onde o app grava. LEITURA não muda.
--
-- Escopo. As tabelas de maior risco, que o app já escreve só depois de `requireRole` (aal2 para quem
-- tem fator) ou pelo cliente de servidor: credenciais e conexões (ai_provider_credentials,
-- ai_purpose_bindings, channel_sessions, tenant_integrations, webhook_sources, voip_trunk_settings,
-- external_db_connections, calendar_connections), acesso e membros (team_invites,
-- user_recovery_codes), LGPD (lgpd_requests) e a empresa (organizations). Cobrança não entra: as
-- tabelas billing_* não têm escrita para `authenticated` e as funções billing_* só executam pelo
-- servidor. As demais tabelas de dado de cliente seguem adiadas (decisão do D-092 no DEBITO).
--
-- Reaplicável com o app no ar: um DO por tabela (a 0950 troca o DO único daqui pelo mesmo desenho: cada
-- tabela é uma transação curta, e uma tabela movimentada que não solta a trava a tempo faz desistir só aquela,
-- sem segurar as outras junto). Cada política só é criada se não existir (sem drop policy, que deixaria a
-- tabela sem a trava no meio), lock_timeout curto para desistir em vez de ficar na fila. Sem função nova (a
-- ponte é da 0918): nada a ver com a VARREDURA anon.

do $mfa_ai_provider_credentials$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_provider_credentials_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_provider_credentials'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_provider_credentials as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_provider_credentials$;

do $mfa_ai_purpose_bindings$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_purpose_bindings_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_purpose_bindings'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_purpose_bindings as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_purpose_bindings$;

do $mfa_calendar_connections$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'calendar_connections_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.calendar_connections'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.calendar_connections as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_calendar_connections$;

do $mfa_channel_sessions$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'channel_sessions_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.channel_sessions'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.channel_sessions as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_channel_sessions$;

do $mfa_external_db_connections$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'external_db_connections_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.external_db_connections'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.external_db_connections as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_external_db_connections$;

do $mfa_lgpd_requests$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'lgpd_requests_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.lgpd_requests'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.lgpd_requests as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_lgpd_requests$;

do $mfa_organizations$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'organizations_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.organizations'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.organizations as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_organizations$;

do $mfa_team_invites$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'team_invites_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.team_invites'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.team_invites as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_team_invites$;

do $mfa_tenant_integrations$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'tenant_integrations_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.tenant_integrations'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.tenant_integrations as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_tenant_integrations$;

do $mfa_user_recovery_codes$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'user_recovery_codes_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.user_recovery_codes'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.user_recovery_codes as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_user_recovery_codes$;

do $mfa_voip_trunk_settings$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'voip_trunk_settings_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.voip_trunk_settings'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.voip_trunk_settings as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_voip_trunk_settings$;

do $mfa_webhook_sources$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'webhook_sources_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.webhook_sources'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.webhook_sources as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_webhook_sources$;
