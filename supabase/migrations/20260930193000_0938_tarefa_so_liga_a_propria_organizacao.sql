-- 0938, a tarefa só se liga a negócio, contato e responsável da própria organização (D-165, FK de crm_tasks) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- As FKs de `crm_tasks` (0210) só garantem que o pai existe, não de QUAL organização ele é, e a de
-- `assigned_to` aponta para `auth.users`, sem pergunta nenhuma de pertencimento. O comentário da rota
-- diz que o 23503 cobre o negócio e o contato de outra organização, e não cobre: o id existe, a FK
-- passa. Membro de A criava tarefa de A presa ao negócio, ao contato ou ao responsável de B, que
-- aparecia no quadro de B (e na timeline do negócio de B). Mesma classe da 0403 (negócio) e da 0933
-- (conversa e mensagem): gatilho na tabela, onde todo escritor passa (sessão, serviço, função).
--
-- Só confere o campo que MUDOU (ou tudo, no insert): tarefa antiga não é varrida e reenviar o que a
-- linha já tem não é ligar de novo. O responsável tem de ser membro ativo da organização da tarefa
-- (vínculo não revogado, qualquer papel: quem escreve tarefa é `agent`, mas a tarefa pode ser dada a
-- quem só acompanha). Negócio ou contato inexistente fica para a FK (23503 do mesmo jeito).
-- O erro é o 23503 genérico, sem dizer se o id existe noutra organização; a rota o traduz para 422.
-- Security definer com search_path fixo: precisa ver o pai e o vínculo por cima da RLS (o pai de
-- outra organização é invisível para quem escreve). Não é RPC: revoga EXECUTE de todos.
-- Reaplicável com o app no ar: `create or replace` e um DO com lock_timeout curto.
-- Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_crm_tasks_vinculos_da_organizacao()
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

  if new.assigned_to is not null
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to or new.organization_id is distinct from old.organization_id)
     and not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = new.assigned_to
          and uo.organization_id = new.organization_id
          and uo.revoked_at is null
     )
  then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_tasks_vinculos_da_organizacao() from public, anon, authenticated;

do $g_crm_tasks$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_crm_tasks_vinculos_da_organizacao on public.crm_tasks;
 create trigger trg_crm_tasks_vinculos_da_organizacao
   before insert or update of lead_id, contact_id, assigned_to, organization_id on public.crm_tasks
   for each row execute function public.fn_crm_tasks_vinculos_da_organizacao();
end
$g_crm_tasks$;
