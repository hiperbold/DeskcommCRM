-- 0939, a visibilidade por atendente vale nas tabelas filhas (D-147) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- `visibility_mode` (0035 e 0036) restringe conversas, mensagens e negócios só para o papel `agent`:
-- no modo `own` ele lê o que é dele, em `own_and_unassigned` (o padrão) o que é dele e a fila, em
-- `all` tudo. As tabelas que apontam para uma conversa ou para um negócio seguiram lendo a
-- organização inteira: com o próprio JWT no PostgREST, um agent lia a transcrição e o `peer_phone`
-- das ligações, a nota interna, o resumo (`rolling_summary`, compromissos e objeções) e as execuções
-- da IA das conversas dos colegas, e pelo Realtime recebia `voice_calls` e `ai_agent_runs` da
-- organização toda. `conversation_drafts` e `ai_reply_drafts` já herdam a visibilidade da conversa
-- (join em `conversations` com `fn_can_view_conversation`); esta migration leva a mesma regra ao
-- SELECT de mais 16 tabelas.
--
-- `fn_registro_filho_visivel(p_org, p_conversation_id, p_lead_id)` é a regra em um lugar só:
--   - viewer, manager e admin leem a organização toda, como nas duas funções que a 0035 e a 0036
--     criaram; a conta do suporte da plataforma entra por elas também;
--   - para o `agent`, com conversa na linha vale `fn_can_view_conversation` sobre a conversa; sem
--     conversa e com negócio vale `fn_can_view_lead` sobre o negócio; quando a linha tem os dois,
--     vale a conversa (é o que a mensagem e a nota dizem, e o negócio sozinho abriria o resumo da
--     conversa de outro atendente);
--   - linha sem conversa nem negócio (checkpoint antigo só com contato, execução de IA sem conversa,
--     ligação só com contato) segue legível pela organização: não existe visibilidade por contato
--     (`contacts_select` é da organização toda), então o comportamento antigo se mantém. Quem preencher
--     `conversation_id` ou `lead_id` na gravação passa a ser coberto;
--   - pai que não existe mais (as colunas de `golden_candidates` e `jev_observacoes` não têm FK)
--     some para o agent: na dúvida, esconde.
-- O pai é lido pela chave primária (`conversations_pkey`, `crm_leads_pkey`) por dentro da função, que
-- é `security definer`: o agent não precisa enxergar o pai para a pergunta ter resposta, e a decisão
-- é a das duas funções existentes. Ela confere pertencimento por `fn_user_role_in_org` e devolve
-- falso para quem não é da organização.
--
-- A regra entra como policy RESTRITIVA de SELECT, uma por tabela (`visibilidade_por_atendente`), e não
-- trocando as policies permissivas que cada tabela já tem. Restritiva soma por AND com todas as
-- permissivas (é o desenho das `support_write_*`), então vale também sobre as policies `for all`
-- (`conversation_notes_write` e `voice_calls_write` dão SELECT ao agent pelo USING, e continuam
-- existindo: a escrita não muda) e sobre qualquer permissiva que alguém acrescente depois. Também
-- evita a janela que trocar as permissivas abriria: o baseline recria em cada passada as policies
-- antigas das migrations anteriores, e entre a recriação delas e a troca a regra larga voltaria a
-- valer; a restritiva já está de pé e não é derrubada (tests/unit/baseline-nao-constroi-o-que-derruba).
-- Como UPDATE e DELETE leem a linha antes, o agent deixa de editar e apagar nota e ligação de conversa
-- que não enxerga; o INSERT não muda. Em `voice_calls` quem fez ou atendeu a chamada
-- (`owner_user_id`, `created_by`) continua vendo a própria ligação mesmo quando o negócio é de outro.
--
-- Não entram: `crm_tasks` e `calendar_appointments` (decisão de produto: tarefa e compromisso são
-- da equipe, e a regra de agenda de colegas já tem opção própria) e `lead_notes` (só tem contato).
-- Reaplicável com o app no ar: `create or replace` e `drop policy if exists`, um DO por tabela com
-- lock_timeout curto, nada que reescreva linha. Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_registro_filho_visivel(p_org uuid, p_conversation_id uuid, p_lead_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_papel text := public.fn_user_role_in_org(p_org);
begin
  if v_papel in ('viewer', 'manager', 'admin') then
    return true;
  end if;
  if v_papel is null then
    return public.fn_is_platform_admin();
  end if;

  if p_conversation_id is not null then
    return exists (
      select 1 from public.conversations c
       where c.id = p_conversation_id
         and c.organization_id = p_org
         and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    );
  end if;
  if p_lead_id is not null then
    return exists (
      select 1 from public.crm_leads l
       where l.id = p_lead_id
         and l.organization_id = p_org
         and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    );
  end if;
  return true;
end;
$$;

revoke execute on function public.fn_registro_filho_visivel(uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_registro_filho_visivel(uuid, uuid, uuid) to authenticated, service_role;

comment on function public.fn_registro_filho_visivel(uuid, uuid, uuid) is
  'Migration 0939 (D-147): a linha de uma tabela filha de conversa ou de negócio é visível para o chamador? viewer, manager e admin sim; agent pela fn_can_view_conversation (conversa primeiro) ou fn_can_view_lead; sem vínculo, vale a organização.';

do $t_agent_cases$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.agent_cases;
 create policy visibilidade_por_atendente on public.agent_cases as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, lead_id));
end
$t_agent_cases$;

do $t_ai_agent_runs$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.ai_agent_runs;
 create policy visibilidade_por_atendente on public.ai_agent_runs as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_ai_agent_runs$;

do $t_ai_invocations$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.ai_invocations;
 create policy visibilidade_por_atendente on public.ai_invocations as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_ai_invocations$;

do $t_ai_router_decisions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.ai_router_decisions;
 create policy visibilidade_por_atendente on public.ai_router_decisions as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_ai_router_decisions$;

do $t_contact_field_proposals$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.contact_field_proposals;
 create policy visibilidade_por_atendente on public.contact_field_proposals as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_contact_field_proposals$;

do $t_conversation_notes$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.conversation_notes;
 create policy visibilidade_por_atendente on public.conversation_notes as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_conversation_notes$;

do $t_crm_lead_reactivations$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.crm_lead_reactivations;
 create policy visibilidade_por_atendente on public.crm_lead_reactivations as restrictive for select using (public.fn_registro_filho_visivel(organization_id, null, lead_id));
end
$t_crm_lead_reactivations$;

do $t_crm_lead_risk_states$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.crm_lead_risk_states;
 create policy visibilidade_por_atendente on public.crm_lead_risk_states as restrictive for select using (public.fn_registro_filho_visivel(organization_id, null, lead_id));
end
$t_crm_lead_risk_states$;

do $t_crm_lead_scores$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.crm_lead_scores;
 create policy visibilidade_por_atendente on public.crm_lead_scores as restrictive for select using (public.fn_registro_filho_visivel(organization_id, null, lead_id));
end
$t_crm_lead_scores$;

do $t_demanda_conversas$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.demanda_conversas;
 create policy visibilidade_por_atendente on public.demanda_conversas as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_demanda_conversas$;

do $t_demandas$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.demandas;
 create policy visibilidade_por_atendente on public.demandas as restrictive for select using (public.fn_registro_filho_visivel(organization_id, null, lead_id));
end
$t_demandas$;

do $t_followup_enrollments$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.followup_enrollments;
 create policy visibilidade_por_atendente on public.followup_enrollments as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_followup_enrollments$;

do $t_golden_candidates$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.golden_candidates;
 create policy visibilidade_por_atendente on public.golden_candidates as restrictive for select using (public.fn_registro_filho_visivel(organization_id, null, lead_id));
end
$t_golden_candidates$;

do $t_jev_observacoes$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.jev_observacoes;
 create policy visibilidade_por_atendente on public.jev_observacoes as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_jev_observacoes$;

do $t_lead_checkpoints$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.lead_checkpoints;
 create policy visibilidade_por_atendente on public.lead_checkpoints as restrictive for select using (public.fn_registro_filho_visivel(organization_id, conversation_id, null));
end
$t_lead_checkpoints$;

do $t_voice_calls$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.voice_calls;
 create policy visibilidade_por_atendente on public.voice_calls as restrictive for select using ((public.fn_registro_filho_visivel(organization_id, null, lead_id) or owner_user_id = (select auth.uid()) or created_by = (select auth.uid())));
end
$t_voice_calls$;
