-- 0933, vínculos das tabelas que a sessão grava só apontam para a própria organização (D-127, resto) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- As FKs simples (`messages.conversation_id` e as demais) só garantem que o pai existe, não de
-- QUAL organização ele é: membro de A inseria mensagem com `organization_id = A` e a conversa de
-- B, que aparecia para a equipe de B e entrava no histórico que a IA de B lê. Mesma classe da
-- 0403 (lead, contato e responsável). FK composta pediria índice único (organization_id, id) nos
-- pais e reconstruir FK em tabela quente com o app no ar; o gatilho cobre todo escritor (sessão,
-- serviço, função) sem esse custo. Um gatilho por tabela, com as colunas que apontam para
-- conversa, negócio ou contato: messages, conversation_notes, crm_lead_activities,
-- crm_lead_links, crm_lead_reactivations, contact_field_proposals, lead_notes, lead_checkpoints,
-- cron_jobs e lead_state.
-- Só confere o campo que MUDOU (ou tudo, no insert): linha antiga não é varrida e reenviar o que
-- a linha já tem não é ligar de novo. Pai inexistente fica para a FK (23503 do mesmo jeito).
-- O erro é o 23503 genérico, sem dizer se o id existe noutra organização.
-- Security definer com search_path fixo: precisa ver o pai por cima da RLS (o pai de outra
-- organização é invisível para quem escreve). Não é RPC: revoga EXECUTE de todos.
-- Reaplicável com o app no ar: `create or replace` e um DO por tabela com lock_timeout curto.
-- Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_messages_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.conversation_id is not null
     and (tg_op = 'INSERT' or new.conversation_id is distinct from old.conversation_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.conversations p
        where p.id = new.conversation_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;

  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.contacts p
        where p.id = new.contact_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_messages_vinculos_da_organizacao() from public, anon, authenticated;

do $g_messages$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_messages_vinculos_da_organizacao on public.messages;
 create trigger trg_messages_vinculos_da_organizacao
   before insert or update of conversation_id, contact_id, organization_id on public.messages
   for each row execute function public.fn_messages_vinculos_da_organizacao();
end
$g_messages$;

create or replace function public.fn_conversation_notes_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.conversation_id is not null
     and (tg_op = 'INSERT' or new.conversation_id is distinct from old.conversation_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.conversations p
        where p.id = new.conversation_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_conversation_notes_vinculos_da_organizacao() from public, anon, authenticated;

do $g_conversation_notes$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_conversation_notes_vinculos_da_organizacao on public.conversation_notes;
 create trigger trg_conversation_notes_vinculos_da_organizacao
   before insert or update of conversation_id, organization_id on public.conversation_notes
   for each row execute function public.fn_conversation_notes_vinculos_da_organizacao();
end
$g_conversation_notes$;

create or replace function public.fn_crm_lead_activities_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.lead_id is not null
     and (tg_op = 'INSERT' or new.lead_id is distinct from old.lead_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.crm_leads p
        where p.id = new.lead_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;

  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.contacts p
        where p.id = new.contact_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_activities_vinculos_da_organizacao() from public, anon, authenticated;

do $g_crm_lead_activities$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_crm_lead_activities_vinculos_da_organizacao on public.crm_lead_activities;
 create trigger trg_crm_lead_activities_vinculos_da_organizacao
   before insert or update of lead_id, contact_id, organization_id on public.crm_lead_activities
   for each row execute function public.fn_crm_lead_activities_vinculos_da_organizacao();
end
$g_crm_lead_activities$;

create or replace function public.fn_crm_lead_links_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.lead_id is not null
     and (tg_op = 'INSERT' or new.lead_id is distinct from old.lead_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.crm_leads p
        where p.id = new.lead_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_links_vinculos_da_organizacao() from public, anon, authenticated;

do $g_crm_lead_links$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_crm_lead_links_vinculos_da_organizacao on public.crm_lead_links;
 create trigger trg_crm_lead_links_vinculos_da_organizacao
   before insert or update of lead_id, organization_id on public.crm_lead_links
   for each row execute function public.fn_crm_lead_links_vinculos_da_organizacao();
end
$g_crm_lead_links$;

create or replace function public.fn_crm_lead_reactivations_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.lead_id is not null
     and (tg_op = 'INSERT' or new.lead_id is distinct from old.lead_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.crm_leads p
        where p.id = new.lead_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_reactivations_vinculos_da_organizacao() from public, anon, authenticated;

do $g_crm_lead_reactivations$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_crm_lead_reactivations_vinculos_da_organizacao on public.crm_lead_reactivations;
 create trigger trg_crm_lead_reactivations_vinculos_da_organizacao
   before insert or update of lead_id, organization_id on public.crm_lead_reactivations
   for each row execute function public.fn_crm_lead_reactivations_vinculos_da_organizacao();
end
$g_crm_lead_reactivations$;

create or replace function public.fn_contact_field_proposals_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.contacts p
        where p.id = new.contact_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;

  if new.conversation_id is not null
     and (tg_op = 'INSERT' or new.conversation_id is distinct from old.conversation_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.conversations p
        where p.id = new.conversation_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_contact_field_proposals_vinculos_da_organizacao() from public, anon, authenticated;

do $g_contact_field_proposals$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_contact_field_proposals_vinculos_da_organizacao on public.contact_field_proposals;
 create trigger trg_contact_field_proposals_vinculos_da_organizacao
   before insert or update of contact_id, conversation_id, organization_id on public.contact_field_proposals
   for each row execute function public.fn_contact_field_proposals_vinculos_da_organizacao();
end
$g_contact_field_proposals$;

create or replace function public.fn_lead_notes_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.contacts p
        where p.id = new.contact_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_lead_notes_vinculos_da_organizacao() from public, anon, authenticated;

do $g_lead_notes$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_lead_notes_vinculos_da_organizacao on public.lead_notes;
 create trigger trg_lead_notes_vinculos_da_organizacao
   before insert or update of contact_id, organization_id on public.lead_notes
   for each row execute function public.fn_lead_notes_vinculos_da_organizacao();
end
$g_lead_notes$;

create or replace function public.fn_lead_checkpoints_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.contacts p
        where p.id = new.contact_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;

  if new.conversation_id is not null
     and (tg_op = 'INSERT' or new.conversation_id is distinct from old.conversation_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.conversations p
        where p.id = new.conversation_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_lead_checkpoints_vinculos_da_organizacao() from public, anon, authenticated;

do $g_lead_checkpoints$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_lead_checkpoints_vinculos_da_organizacao on public.lead_checkpoints;
 create trigger trg_lead_checkpoints_vinculos_da_organizacao
   before insert or update of contact_id, conversation_id, organization_id on public.lead_checkpoints
   for each row execute function public.fn_lead_checkpoints_vinculos_da_organizacao();
end
$g_lead_checkpoints$;

create or replace function public.fn_cron_jobs_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.contacts p
        where p.id = new.contact_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_cron_jobs_vinculos_da_organizacao() from public, anon, authenticated;

do $g_cron_jobs$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_cron_jobs_vinculos_da_organizacao on public.cron_jobs;
 create trigger trg_cron_jobs_vinculos_da_organizacao
   before insert or update of contact_id, organization_id on public.cron_jobs
   for each row execute function public.fn_cron_jobs_vinculos_da_organizacao();
end
$g_cron_jobs$;

create or replace function public.fn_lead_state_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.contacts p
        where p.id = new.contact_id
          and p.organization_id is distinct from new.organization_id
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_lead_state_vinculos_da_organizacao() from public, anon, authenticated;

do $g_lead_state$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_lead_state_vinculos_da_organizacao on public.lead_state;
 create trigger trg_lead_state_vinculos_da_organizacao
   before insert or update of contact_id, organization_id on public.lead_state
   for each row execute function public.fn_lead_state_vinculos_da_organizacao();
end
$g_lead_state$;

