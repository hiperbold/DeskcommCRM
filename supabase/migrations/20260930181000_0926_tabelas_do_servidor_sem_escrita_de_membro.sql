-- 0926, tabelas do servidor sem escrita de membro (D-113, D-163) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A varredura genérica criou `for all` só por tenant em dezenas de tabelas que são do
-- motor: um viewer apagava `job_queue` (parava a IA), trocava `playbook_pointers` e
-- `skill_pointers`, reescrevia `lead_state_transitions` e, pelo INSERT em
-- `ai_invocations`, o gatilho definer somava em `ai_budgets` (D-163).
-- Medido no código: nenhuma dessas tabelas é gravada pelo navegador nem por rota com
-- sessão de usuário; quem grava é o servidor (service_role, pool direto, funções
-- definer). O authenticated perde insert, update, delete, truncate, references e
-- trigger, e a policy `for all` vira só SELECT para o membro da organização (o ramo de
-- admin de plataforma fica onde existia). Os gatilhos definer seguem gravando.
-- `fn_proteger_tabelas_de_organizacao` passa a criar só SELECT (a policy mantém o nome
-- `tenant_isolation_<tabela>_all` porque a provisionadora e seus gates procuram esse nome).
-- `meta_templates` não é revogada (o espelho dos modelos da Meta tem escrita de manager
-- em vez de membro qualquer; a rota grava por serviço).
-- Ficam de fora as tabelas que a sessão do usuário grava de fato (messages, contacts,
-- cron_jobs, idempotency_keys, lead_state, lead_checkpoints, agent_inbox_items e afins):
-- exigem papel e não revogação, e não entram neste lote.
-- Reaplicável com o app no ar: um DO por tabela, lock_timeout curto.
-- Cria função: entra ANTES da VARREDURA anon.

do $t_ai_agent_runs$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_ai_agent_runs_all on public.ai_agent_runs;
 drop policy if exists tenant_isolation_ai_agent_runs_select on public.ai_agent_runs;
 create policy tenant_isolation_ai_agent_runs_select on public.ai_agent_runs for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.ai_agent_runs from authenticated, anon;
end
$t_ai_agent_runs$;
do $t_ai_router_decisions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_ai_router_decisions_all on public.ai_router_decisions;
 drop policy if exists tenant_isolation_ai_router_decisions_select on public.ai_router_decisions;
 create policy tenant_isolation_ai_router_decisions_select on public.ai_router_decisions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.ai_router_decisions from authenticated, anon;
end
$t_ai_router_decisions$;
do $t_before_send_traces$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_before_send_traces_all on public.before_send_traces;
 drop policy if exists tenant_isolation_before_send_traces_select on public.before_send_traces;
 create policy tenant_isolation_before_send_traces_select on public.before_send_traces for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.before_send_traces from authenticated, anon;
end
$t_before_send_traces$;
do $t_judge_alignment_pool$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_judge_alignment_pool_all on public.judge_alignment_pool;
 drop policy if exists tenant_isolation_judge_alignment_pool_select on public.judge_alignment_pool;
 create policy tenant_isolation_judge_alignment_pool_select on public.judge_alignment_pool for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.judge_alignment_pool from authenticated, anon;
end
$t_judge_alignment_pool$;
do $t_flywheel_judge_verdicts$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_flywheel_judge_verdicts_all on public.flywheel_judge_verdicts;
 drop policy if exists tenant_isolation_flywheel_judge_verdicts_select on public.flywheel_judge_verdicts;
 create policy tenant_isolation_flywheel_judge_verdicts_select on public.flywheel_judge_verdicts for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.flywheel_judge_verdicts from authenticated, anon;
end
$t_flywheel_judge_verdicts$;
do $t_flywheel_distiller_proposals$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_flywheel_distiller_proposals_all on public.flywheel_distiller_proposals;
 drop policy if exists tenant_isolation_flywheel_distiller_proposals_select on public.flywheel_distiller_proposals;
 create policy tenant_isolation_flywheel_distiller_proposals_select on public.flywheel_distiller_proposals for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.flywheel_distiller_proposals from authenticated, anon;
end
$t_flywheel_distiller_proposals$;
do $t_knowledge_searches$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_knowledge_searches_all on public.knowledge_searches;
 drop policy if exists tenant_isolation_knowledge_searches_select on public.knowledge_searches;
 create policy tenant_isolation_knowledge_searches_select on public.knowledge_searches for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.knowledge_searches from authenticated, anon;
end
$t_knowledge_searches$;
do $t_outbound_copies$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_outbound_copies_all on public.outbound_copies;
 drop policy if exists tenant_isolation_outbound_copies_select on public.outbound_copies;
 create policy tenant_isolation_outbound_copies_select on public.outbound_copies for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.outbound_copies from authenticated, anon;
end
$t_outbound_copies$;
do $t_metrics$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_metrics_all on public.metrics;
 drop policy if exists tenant_isolation_metrics_select on public.metrics;
 create policy tenant_isolation_metrics_select on public.metrics for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.metrics from authenticated, anon;
end
$t_metrics$;
do $t_lead_state_transitions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_lead_state_transitions_all on public.lead_state_transitions;
 drop policy if exists tenant_isolation_lead_state_transitions_select on public.lead_state_transitions;
 create policy tenant_isolation_lead_state_transitions_select on public.lead_state_transitions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.lead_state_transitions from authenticated, anon;
end
$t_lead_state_transitions$;
do $t_send_ledger$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_send_ledger_all on public.send_ledger;
 drop policy if exists tenant_isolation_send_ledger_select on public.send_ledger;
 create policy tenant_isolation_send_ledger_select on public.send_ledger for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.send_ledger from authenticated, anon;
end
$t_send_ledger$;
do $t_pacing_ledger$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_pacing_ledger_all on public.pacing_ledger;
 drop policy if exists tenant_isolation_pacing_ledger_select on public.pacing_ledger;
 create policy tenant_isolation_pacing_ledger_select on public.pacing_ledger for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.pacing_ledger from authenticated, anon;
end
$t_pacing_ledger$;
do $t_job_queue$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_job_queue_all on public.job_queue;
 drop policy if exists tenant_isolation_job_queue_select on public.job_queue;
 create policy tenant_isolation_job_queue_select on public.job_queue for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.job_queue from authenticated, anon;
end
$t_job_queue$;
do $t_org_memory_entries$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_org_memory_entries_all on public.org_memory_entries;
 drop policy if exists tenant_isolation_org_memory_entries_select on public.org_memory_entries;
 create policy tenant_isolation_org_memory_entries_select on public.org_memory_entries for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.org_memory_entries from authenticated, anon;
end
$t_org_memory_entries$;
do $t_org_memory_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_org_memory_pointers_all on public.org_memory_pointers;
 drop policy if exists tenant_isolation_org_memory_pointers_select on public.org_memory_pointers;
 create policy tenant_isolation_org_memory_pointers_select on public.org_memory_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.org_memory_pointers from authenticated, anon;
end
$t_org_memory_pointers$;
do $t_org_memory_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_org_memory_versions_all on public.org_memory_versions;
 drop policy if exists tenant_isolation_org_memory_versions_select on public.org_memory_versions;
 create policy tenant_isolation_org_memory_versions_select on public.org_memory_versions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.org_memory_versions from authenticated, anon;
end
$t_org_memory_versions$;
do $t_playbook_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_playbook_pointers_all on public.playbook_pointers;
 drop policy if exists tenant_isolation_playbook_pointers_select on public.playbook_pointers;
 create policy tenant_isolation_playbook_pointers_select on public.playbook_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.playbook_pointers from authenticated, anon;
end
$t_playbook_pointers$;
do $t_playbook_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_playbook_versions_all on public.playbook_versions;
 drop policy if exists tenant_isolation_playbook_versions_select on public.playbook_versions;
 create policy tenant_isolation_playbook_versions_select on public.playbook_versions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.playbook_versions from authenticated, anon;
end
$t_playbook_versions$;
do $t_skill_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_skill_pointers_all on public.skill_pointers;
 drop policy if exists tenant_isolation_skill_pointers_select on public.skill_pointers;
 create policy tenant_isolation_skill_pointers_select on public.skill_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.skill_pointers from authenticated, anon;
end
$t_skill_pointers$;
do $t_skill_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_skill_versions_all on public.skill_versions;
 drop policy if exists tenant_isolation_skill_versions_select on public.skill_versions;
 create policy tenant_isolation_skill_versions_select on public.skill_versions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.skill_versions from authenticated, anon;
end
$t_skill_versions$;
do $t_skill_activations$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_skill_activations_all on public.skill_activations;
 drop policy if exists tenant_isolation_skill_activations_select on public.skill_activations;
 create policy tenant_isolation_skill_activations_select on public.skill_activations for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.skill_activations from authenticated, anon;
end
$t_skill_activations$;
do $t_disclosure_template_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_disclosure_template_pointers_all on public.disclosure_template_pointers;
 drop policy if exists tenant_isolation_disclosure_template_pointers_select on public.disclosure_template_pointers;
 create policy tenant_isolation_disclosure_template_pointers_select on public.disclosure_template_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.disclosure_template_pointers from authenticated, anon;
end
$t_disclosure_template_pointers$;
do $t_disclosure_template_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_disclosure_template_versions_all on public.disclosure_template_versions;
 drop policy if exists tenant_isolation_disclosure_template_versions_select on public.disclosure_template_versions;
 create policy tenant_isolation_disclosure_template_versions_select on public.disclosure_template_versions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.disclosure_template_versions from authenticated, anon;
end
$t_disclosure_template_versions$;
do $t_reentry_knob_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_reentry_knob_pointers_all on public.reentry_knob_pointers;
 drop policy if exists tenant_isolation_reentry_knob_pointers_select on public.reentry_knob_pointers;
 create policy tenant_isolation_reentry_knob_pointers_select on public.reentry_knob_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.reentry_knob_pointers from authenticated, anon;
end
$t_reentry_knob_pointers$;
do $t_reentry_knob_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_reentry_knob_versions_all on public.reentry_knob_versions;
 drop policy if exists tenant_isolation_reentry_knob_versions_select on public.reentry_knob_versions;
 create policy tenant_isolation_reentry_knob_versions_select on public.reentry_knob_versions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.reentry_knob_versions from authenticated, anon;
end
$t_reentry_knob_versions$;
do $t_reentry_template_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_reentry_template_pointers_all on public.reentry_template_pointers;
 drop policy if exists tenant_isolation_reentry_template_pointers_select on public.reentry_template_pointers;
 create policy tenant_isolation_reentry_template_pointers_select on public.reentry_template_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.reentry_template_pointers from authenticated, anon;
end
$t_reentry_template_pointers$;
do $t_reentry_template_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_reentry_template_versions_all on public.reentry_template_versions;
 drop policy if exists tenant_isolation_reentry_template_versions_select on public.reentry_template_versions;
 create policy tenant_isolation_reentry_template_versions_select on public.reentry_template_versions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.reentry_template_versions from authenticated, anon;
end
$t_reentry_template_versions$;
do $t_promise_table_pointers$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_promise_table_pointers_all on public.promise_table_pointers;
 drop policy if exists tenant_isolation_promise_table_pointers_select on public.promise_table_pointers;
 create policy tenant_isolation_promise_table_pointers_select on public.promise_table_pointers for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.promise_table_pointers from authenticated, anon;
end
$t_promise_table_pointers$;
do $t_promise_table_versions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_promise_table_versions_all on public.promise_table_versions;
 drop policy if exists tenant_isolation_promise_table_versions_select on public.promise_table_versions;
 create policy tenant_isolation_promise_table_versions_select on public.promise_table_versions for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.promise_table_versions from authenticated, anon;
end
$t_promise_table_versions$;
do $t_channel_knobs$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_channel_knobs_all on public.channel_knobs;
 drop policy if exists tenant_isolation_channel_knobs_select on public.channel_knobs;
 create policy tenant_isolation_channel_knobs_select on public.channel_knobs for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.channel_knobs from authenticated, anon;
end
$t_channel_knobs$;
do $t_channel_session_health$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_channel_session_health_all on public.channel_session_health;
 drop policy if exists tenant_isolation_channel_session_health_select on public.channel_session_health;
 create policy tenant_isolation_channel_session_health_select on public.channel_session_health for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.channel_session_health from authenticated, anon;
end
$t_channel_session_health$;
do $t_crm_lead_risk_states$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_crm_lead_risk_states_all on public.crm_lead_risk_states;
 drop policy if exists tenant_isolation_crm_lead_risk_states_select on public.crm_lead_risk_states;
 create policy tenant_isolation_crm_lead_risk_states_select on public.crm_lead_risk_states for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.crm_lead_risk_states from authenticated, anon;
end
$t_crm_lead_risk_states$;
do $t_crm_lead_scores$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_crm_lead_scores_all on public.crm_lead_scores;
 drop policy if exists tenant_isolation_crm_lead_scores_select on public.crm_lead_scores;
 create policy tenant_isolation_crm_lead_scores_select on public.crm_lead_scores for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.crm_lead_scores from authenticated, anon;
end
$t_crm_lead_scores$;
do $t_demanda_conversas$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_demanda_conversas_all on public.demanda_conversas;
 drop policy if exists tenant_isolation_demanda_conversas_select on public.demanda_conversas;
 create policy tenant_isolation_demanda_conversas_select on public.demanda_conversas for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.demanda_conversas from authenticated, anon;
end
$t_demanda_conversas$;
do $t_demandas$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_demandas_all on public.demandas;
 drop policy if exists tenant_isolation_demandas_select on public.demandas;
 create policy tenant_isolation_demandas_select on public.demandas for select using (organization_id in (select public.fn_user_org_ids()));
 revoke insert, update, delete, truncate, references, trigger on public.demandas from authenticated, anon;
end
$t_demandas$;
do $t_ai_invocations$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_ai_invocations_all on public.ai_invocations;
 drop policy if exists tenant_isolation_ai_invocations_select on public.ai_invocations;
 create policy tenant_isolation_ai_invocations_select on public.ai_invocations for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 revoke insert, update, delete, truncate, references, trigger on public.ai_invocations from authenticated, anon;
end
$t_ai_invocations$;
do $t_channel_session_warmup$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists warmup_tenant_isolation_all on public.channel_session_warmup;
 drop policy if exists tenant_isolation_channel_session_warmup_select on public.channel_session_warmup;
 create policy tenant_isolation_channel_session_warmup_select on public.channel_session_warmup for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 revoke insert, update, delete, truncate, references, trigger on public.channel_session_warmup from authenticated, anon;
end
$t_channel_session_warmup$;
do $t_nuvemshop_products$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists nuvemshop_products_tenant on public.nuvemshop_products;
 drop policy if exists tenant_isolation_nuvemshop_products_select on public.nuvemshop_products;
 create policy tenant_isolation_nuvemshop_products_select on public.nuvemshop_products for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 revoke insert, update, delete, truncate, references, trigger on public.nuvemshop_products from authenticated, anon;
end
$t_nuvemshop_products$;
do $t_orders$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists orders_tenant_write on public.orders;
 revoke insert, update, delete, truncate, references, trigger on public.orders from authenticated, anon;
end
$t_orders$;
do $t_meta_templates$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_meta_templates_all on public.meta_templates;
 drop policy if exists tenant_isolation_meta_templates_select on public.meta_templates;
 create policy tenant_isolation_meta_templates_select on public.meta_templates for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_meta_templates_insert on public.meta_templates;
 create policy tenant_isolation_meta_templates_insert on public.meta_templates for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_meta_templates_update on public.meta_templates;
 create policy tenant_isolation_meta_templates_update on public.meta_templates for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_meta_templates_delete on public.meta_templates;
 create policy tenant_isolation_meta_templates_delete on public.meta_templates for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_meta_templates$;

create or replace function public.fn_proteger_tabelas_de_organizacao()
returns void
language plpgsql
set search_path = public
as $f$
declare r record;
begin
 for r in
   select c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
      and exists (
        select 1 from pg_attribute a
         where a.attrelid = c.oid
           and a.attname = 'organization_id'
           and a.attnum > 0
           and not a.attisdropped)
    order by c.relname
 loop
   execute format('alter table public.%I enable row level security', r.relname);
   execute format('revoke all on public.%I from anon', r.relname);
   execute format('drop policy if exists tenant_isolation_%s_all on public.%I', r.relname, r.relname);
   execute format(
     'create policy tenant_isolation_%s_all on public.%I for select
        using (organization_id in (select * from public.fn_user_org_ids()))',
     r.relname, r.relname);
 end loop;
end $f$;
revoke execute on function public.fn_proteger_tabelas_de_organizacao() from public, anon, authenticated, service_role;
