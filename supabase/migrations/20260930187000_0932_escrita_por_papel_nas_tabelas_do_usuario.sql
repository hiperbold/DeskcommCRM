-- 0932, tabelas que a sessão do usuário grava passam a exigir papel (D-113, segunda metade) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A 0926 revogou a escrita do `authenticated` nas tabelas que só o servidor grava. Sobravam as
-- que a sessão de usuário grava de fato, ainda com policy `for all` só por tenant: um viewer
-- apagava mensagens, editava contatos, inseria `cron_jobs` (a IA mandava mensagem ao contato a
-- cada minuto e gastava a carteira) e forjava itens da Central, atividades e vínculos de negócio.
-- Aqui a escrita passa a pedir papel no `using` e no `with check`, e o papel é o da menor rota
-- que grava a tabela com a sessão do usuário (medido lendo as rotas; todas pedem agent ou mais,
-- então o viewer deixa de escrever em qualquer uma). Onde a escrita legítima é de agent, a
-- policy exige agent e não revoga; onde nenhuma rota grava com a sessão (só serviço, pool ou
-- função definer) a operação sobe para manager em vez de ficar aberta ao membro qualquer.
--
--   tabela                    insert    update    delete
--   contacts                  agent     agent     agent      (POST, PATCH e DELETE de contato pedem agent)
--   messages                  agent     agent     agent      (editar/revogar é agent; ocultar é manager; apagar contato e o eco do próprio envio apagam com a sessão)
--   idempotency_keys          agent     agent     agent      (as quatro rotas que usam o recibo pedem agent; o teste organizacoes-recibo-confiavel fixa que o membro apaga o próprio recibo)
--   cron_jobs                 agent*    manager   manager    (*só `kind = 'at'` e `job_kind = 'followup_turn'`: é o que a rota de reativação grava; recorrente e outros motores só pelo serviço)
--   lead_state                manager   agent     manager    (o aviso de próxima ação limpa `next_action`; o resto é do motor)
--   lead_checkpoints          agent     manager   manager    (a devolução ao agente grava um checkpoint; o resto é do motor)
--   contact_field_proposals   manager   agent     manager    (decidir a proposta é agent; criar e vencer é do motor)
--   lead_notes                manager   manager   manager    (nenhuma rota grava; é a memória do agente, escrita pelo motor)
--   crm_lead_reactivations    manager   agent     manager    (decidir é agent; propor e vencer é do motor)
--   crm_lead_activities       agent     (sem policy de update e delete)
--   crm_lead_links            agent     manager   manager    (marcar compromisso vincula; a limpeza é função definer)
--
-- FORA daqui, de propósito: `agent_inbox_items`. Os testes dos planos (planos-assinatura-estados,
-- planos-trava-avisa) fixam que o viewer encerra o aviso real da Central e que itens de outro tipo
-- seguem graváveis pelo membro; subir o papel é decisão de produto e fica ADIADO.
--
-- Cada `for all` vira quatro policies (select por organização, como era, e as três de escrita).
-- O ramo de admin de plataforma fica onde existia (contacts, messages, crm_lead_*). O select de
-- `messages`, `crm_lead_activities` e `crm_lead_links` não muda aqui (já olha a visibilidade).
-- Os gatilhos definer e o serviço seguem gravando: RLS não os alcança.
-- Reaplicável com o app no ar: um DO por tabela, `drop policy if exists`, lock_timeout curto.
-- Não cria função.

do $t_contacts$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_contacts_all on public.contacts;
 drop policy if exists tenant_isolation_contacts_select on public.contacts;
 create policy tenant_isolation_contacts_select on public.contacts for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_contacts_insert on public.contacts;
 create policy tenant_isolation_contacts_insert on public.contacts for insert with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_contacts_update on public.contacts;
 create policy tenant_isolation_contacts_update on public.contacts for update using (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin())) with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_contacts_delete on public.contacts;
 create policy tenant_isolation_contacts_delete on public.contacts for delete using (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
end
$t_contacts$;
do $t_cron_jobs$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_cron_jobs_all on public.cron_jobs;
 drop policy if exists tenant_isolation_cron_jobs_select on public.cron_jobs;
 create policy tenant_isolation_cron_jobs_select on public.cron_jobs for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_cron_jobs_insert on public.cron_jobs;
 create policy tenant_isolation_cron_jobs_insert on public.cron_jobs for insert with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and kind = 'at' and job_kind = 'followup_turn'));
 drop policy if exists tenant_isolation_cron_jobs_update on public.cron_jobs;
 create policy tenant_isolation_cron_jobs_update on public.cron_jobs for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_cron_jobs_delete on public.cron_jobs;
 create policy tenant_isolation_cron_jobs_delete on public.cron_jobs for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_cron_jobs$;
do $t_idempotency_keys$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists idempotency_tenant on public.idempotency_keys;
 drop policy if exists idempotency_tenant_select on public.idempotency_keys;
 create policy idempotency_tenant_select on public.idempotency_keys for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists idempotency_tenant_insert on public.idempotency_keys;
 create policy idempotency_tenant_insert on public.idempotency_keys for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')));
 drop policy if exists idempotency_tenant_update on public.idempotency_keys;
 create policy idempotency_tenant_update on public.idempotency_keys for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')));
 drop policy if exists idempotency_tenant_delete on public.idempotency_keys;
 create policy idempotency_tenant_delete on public.idempotency_keys for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')));
end
$t_idempotency_keys$;
do $t_lead_state$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_lead_state_all on public.lead_state;
 drop policy if exists tenant_isolation_lead_state_select on public.lead_state;
 create policy tenant_isolation_lead_state_select on public.lead_state for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_lead_state_insert on public.lead_state;
 create policy tenant_isolation_lead_state_insert on public.lead_state for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_lead_state_update on public.lead_state;
 create policy tenant_isolation_lead_state_update on public.lead_state for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')));
 drop policy if exists tenant_isolation_lead_state_delete on public.lead_state;
 create policy tenant_isolation_lead_state_delete on public.lead_state for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_lead_state$;
do $t_lead_checkpoints$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_lead_checkpoints_all on public.lead_checkpoints;
 drop policy if exists tenant_isolation_lead_checkpoints_select on public.lead_checkpoints;
 create policy tenant_isolation_lead_checkpoints_select on public.lead_checkpoints for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_lead_checkpoints_insert on public.lead_checkpoints;
 create policy tenant_isolation_lead_checkpoints_insert on public.lead_checkpoints for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')));
 drop policy if exists tenant_isolation_lead_checkpoints_update on public.lead_checkpoints;
 create policy tenant_isolation_lead_checkpoints_update on public.lead_checkpoints for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_lead_checkpoints_delete on public.lead_checkpoints;
 create policy tenant_isolation_lead_checkpoints_delete on public.lead_checkpoints for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_lead_checkpoints$;
do $t_contact_field_proposals$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_contact_field_proposals_all on public.contact_field_proposals;
 drop policy if exists tenant_isolation_contact_field_proposals_select on public.contact_field_proposals;
 create policy tenant_isolation_contact_field_proposals_select on public.contact_field_proposals for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_contact_field_proposals_insert on public.contact_field_proposals;
 create policy tenant_isolation_contact_field_proposals_insert on public.contact_field_proposals for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_contact_field_proposals_update on public.contact_field_proposals;
 create policy tenant_isolation_contact_field_proposals_update on public.contact_field_proposals for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')));
 drop policy if exists tenant_isolation_contact_field_proposals_delete on public.contact_field_proposals;
 create policy tenant_isolation_contact_field_proposals_delete on public.contact_field_proposals for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_contact_field_proposals$;
do $t_lead_notes$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_lead_notes_all on public.lead_notes;
 drop policy if exists tenant_isolation_lead_notes_select on public.lead_notes;
 create policy tenant_isolation_lead_notes_select on public.lead_notes for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_lead_notes_insert on public.lead_notes;
 create policy tenant_isolation_lead_notes_insert on public.lead_notes for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_lead_notes_update on public.lead_notes;
 create policy tenant_isolation_lead_notes_update on public.lead_notes for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_lead_notes_delete on public.lead_notes;
 create policy tenant_isolation_lead_notes_delete on public.lead_notes for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_lead_notes$;
do $t_crm_lead_reactivations$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_crm_lead_reactivations_all on public.crm_lead_reactivations;
 drop policy if exists tenant_isolation_crm_lead_reactivations_select on public.crm_lead_reactivations;
 create policy tenant_isolation_crm_lead_reactivations_select on public.crm_lead_reactivations for select using (organization_id in (select public.fn_user_org_ids()));
 drop policy if exists tenant_isolation_crm_lead_reactivations_insert on public.crm_lead_reactivations;
 create policy tenant_isolation_crm_lead_reactivations_insert on public.crm_lead_reactivations for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
 drop policy if exists tenant_isolation_crm_lead_reactivations_update on public.crm_lead_reactivations;
 create policy tenant_isolation_crm_lead_reactivations_update on public.crm_lead_reactivations for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')));
 drop policy if exists tenant_isolation_crm_lead_reactivations_delete on public.crm_lead_reactivations;
 create policy tenant_isolation_crm_lead_reactivations_delete on public.crm_lead_reactivations for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
end
$t_crm_lead_reactivations$;
do $t_messages$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists messages_insert on public.messages;
 create policy messages_insert on public.messages for insert with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
 drop policy if exists messages_update on public.messages;
 create policy messages_update on public.messages for update using (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin())) with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
 drop policy if exists messages_delete on public.messages;
 create policy messages_delete on public.messages for delete using (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
end
$t_messages$;
do $t_crm_lead_activities$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists crm_lead_activities_insert on public.crm_lead_activities;
 create policy crm_lead_activities_insert on public.crm_lead_activities for insert with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
end
$t_crm_lead_activities$;
do $t_crm_lead_links$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists crm_lead_links_insert on public.crm_lead_links;
 create policy crm_lead_links_insert on public.crm_lead_links for insert with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin()));
 drop policy if exists crm_lead_links_update on public.crm_lead_links;
 create policy crm_lead_links_update on public.crm_lead_links for update using (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')) or public.fn_is_platform_admin())) with check (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')) or public.fn_is_platform_admin()));
 drop policy if exists crm_lead_links_delete on public.crm_lead_links;
 create policy crm_lead_links_delete on public.crm_lead_links for delete using (((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')) or public.fn_is_platform_admin()));
end
$t_crm_lead_links$;
