-- 0950, a sessão sem o segundo fator não troca o que a IA e o robô mandam ao cliente final (D-092, 2a parte) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. A 0949 fechou a escrita de credenciais, convites, LGPD e da empresa para a sessão aal1 de
-- quem TEM fator verificado, mas as actions de agente (app/app/ai/agents) exigem o segundo fator só no
-- servidor. Quem tem a senha de um admin com TOTP (sessão aal1) e usa a chave pública do projeto direto no
-- PostgREST ainda reescreve o prompt do agente, os guardrails, o roteador, a base de conhecimento e as
-- automações: ou seja, troca o que a IA e o robô dizem ao cliente final, sem passar pela action.
--
-- A correção. A mesma da 0949: uma política RESTRICTIVE por comando de escrita (insert, update, delete) só
-- para `authenticated`, pela ponte `fn_session_mfa_proven_rls()` da 0918 (aal2, OU o usuário não tem fator
-- TOTP verificado). Service_role e função security definer, que é por onde o app e os workers gravam, não
-- mudam. LEITURA não muda.
--
-- Escopo. Tudo o que define o conteúdo que a IA ou o robô manda: agente e versões (ai_agents,
-- ai_agent_versions), roteador (ai_routers, ai_router_members), orçamento de IA (ai_budgets), conhecimento
-- (ai_knowledge_sources, ai_faq_items, ai_chunks, ai_knowledge_versions), camadas de guardrail
-- (org_guardrail_layers), automações (automation_rules), modelos de mensagem (message_templates, que o
-- follow-up e o agente enviam) e os fluxos de follow-up (followup_flow_pointers, followup_flow_versions).
-- FICAM DE FORA, de propósito: followup_enrollments e followup_enrollment_events (execução de um fluxo já
-- publicado, não o conteúdo dele) e as tabelas de telemetria e de fila (ai_router_decisions,
-- automation_rule_runs, agent_cases, knowledge_searches), que o servidor escreve.
--
-- Reaplicável com o app no ar: um DO por tabela, cada um uma transação curta (uma tabela movimentada que
-- não solta a trava a tempo faz desistir só aquela, sem segurar várias juntas). Cada política só é criada se
-- não existir (sem drop policy, que deixaria a tabela sem a trava no meio), lock_timeout curto para desistir
-- em vez de ficar na fila. Sem função nova (a ponte é da 0918): nada a ver com a VARREDURA anon.

do $mfa_ai_agents$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_agents_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_agents'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_agents as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_agents$;

do $mfa_ai_agent_versions$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_agent_versions_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_agent_versions'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_agent_versions as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_agent_versions$;

do $mfa_ai_routers$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_routers_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_routers'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_routers as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_routers$;

do $mfa_ai_router_members$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_router_members_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_router_members'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_router_members as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_router_members$;

do $mfa_ai_budgets$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_budgets_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_budgets'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_budgets as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_budgets$;

do $mfa_ai_knowledge_sources$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_knowledge_sources_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_knowledge_sources'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_knowledge_sources as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_knowledge_sources$;

do $mfa_ai_faq_items$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_faq_items_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_faq_items'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_faq_items as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_faq_items$;

do $mfa_ai_chunks$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_chunks_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_chunks'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_chunks as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_chunks$;

do $mfa_ai_knowledge_versions$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'ai_knowledge_versions_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.ai_knowledge_versions'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.ai_knowledge_versions as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_ai_knowledge_versions$;

do $mfa_org_guardrail_layers$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'org_guardrail_layers_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.org_guardrail_layers'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.org_guardrail_layers as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_org_guardrail_layers$;

do $mfa_automation_rules$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'automation_rules_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.automation_rules'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.automation_rules as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_automation_rules$;

do $mfa_message_templates$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'message_templates_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.message_templates'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.message_templates as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_message_templates$;

do $mfa_followup_flow_pointers$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'followup_flow_pointers_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.followup_flow_pointers'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.followup_flow_pointers as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_followup_flow_pointers$;

do $mfa_followup_flow_versions$
declare
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach cmd in array array['insert','update','delete'] loop
  nome := 'followup_flow_versions_mfa_' || cmd;
  if not exists (select 1 from pg_policy where polname = nome and polrelid = 'public.followup_flow_versions'::regclass) then
   definicao := case cmd
    when 'insert' then 'with check ((select public.fn_session_mfa_proven_rls()))'
    when 'update' then 'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))'
    else 'using ((select public.fn_session_mfa_proven_rls()))'
   end;
   execute format('create policy %I on public.followup_flow_versions as restrictive for %s to authenticated %s', nome, cmd, definicao);
  end if;
 end loop;
end
$mfa_followup_flow_versions$;
