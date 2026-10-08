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
-- Reaplicável com o app no ar: um DO só, cada política só é criada se não existir (sem drop policy,
-- que deixaria a tabela sem a trava no meio), lock_timeout curto para desistir em vez de ficar na
-- fila. Sem função nova (a ponte é da 0918): nada a ver com a VARREDURA anon.

do $mfa_na_escrita_ampliada$
declare
 t text;
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach t in array array['ai_provider_credentials','ai_purpose_bindings','calendar_connections','channel_sessions','external_db_connections','lgpd_requests','organizations','team_invites','tenant_integrations','user_recovery_codes','voip_trunk_settings','webhook_sources'] loop
  foreach cmd in array array['insert','update','delete'] loop
   nome := t || '_mfa_' || cmd;
   if not exists (select 1 from pg_policy where polname = nome and polrelid = ('public.' || t)::regclass) then
    definicao := case cmd
     when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
     when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
     else 'using ((select public.fn_session_mfa_proven_rls()))'
    end;
    execute format('create policy %I on public.%I as restrictive for %s to authenticated %s', nome, t, cmd, definicao);
   end if;
  end loop;
 end loop;
end
$mfa_na_escrita_ampliada$;
