-- 0929, o vínculo com a organização só é gravado pelo servidor e a organização nunca fica sem admin (D-125, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito, em duas partes. user_organizations tem GRANT ALL a authenticated e as policies
-- de escrita só exigem admin da organização (user_orgs_insert aceita `user_id` qualquer e
-- `accepted_at` preenchido; user_orgs_update não tem with check).
--   1. Um admin gravava pelo PostgREST uma linha com o `user_id` de outra pessoa (o uuid
--      vaza por invited_by e por outras leituras): ao entrar sem o cookie da organização
--      ativa a vítima caía na organização do atacante. E trocava `user_id`, `role`,
--      `revoked_at` e `accepted_at` de linhas existentes sem passar pelas rotas.
--   2. A única guarda de "último admin" era uma contagem no código das rotas (rebaixar e
--      revogar), sem trava: dois admins se rebaixando ao mesmo tempo, ou qualquer escrita
--      direta, deixavam a organização sem admin.
--
-- A correção, no banco, em duas peças, no padrão da 0914 e da 0915:
--   * trg_user_orgs_so_servidor: quem não é o servidor (fn_billing_e_servidor: conexão direta
--     sem SET ROLE, ou service_role) só insere vínculo para si mesmo (user_id = auth.uid(),
--     o caso do admin da plataforma que entra numa empresa, que a 0918 já exige com MFA) e
--     não muda `user_id`, `role`, `revoked_at` nem `accepted_at` de linha existente. As rotas
--     de papel, revogação e reativação do time passam a gravar com o cliente de serviço,
--     depois de conferir o admin da organização, e o aceite de convite e a criação de
--     organização já gravam pelo servidor.
--   * trg_user_orgs_nunca_zero_admin: tirar o último admin ativo da organização (rebaixar,
--     revogar ou apagar a linha dele) é recusado com 23514 `organizacao_sem_admin`. Vale
--     para todo mundo que chega pelo PostgREST (service_role e authenticated; a conexão direta sem
--     SET ROLE, de migração e manutenção, fica fora), na troca de papel e na revogação, com uma trava
--     advisory por organização que serializa duas saídas de admin ao mesmo tempo (a segunda
--     enxerga a primeira já confirmada). O apagar a linha só é conferido para quem não é o
--     servidor, e nunca quando a organização ou o usuário estão sendo apagados (cascata), nem
--     no repasse do dono (fn_accept_team_invite apaga o vínculo provisório depois de criar o
--     do dono). Admin ativo é `role = 'admin'` com `revoked_at` nulo, a mesma noção de
--     fn_role_at_least.
--
-- Os nomes começam com `trg_user_orgs_` para disparar DEPOIS de trg_billing_trava_user_organizations
-- (ordem alfabética dos gatilhos BEFORE): o teto de membros do plano continua respondendo
-- primeiro, com a mesma mensagem.
--
-- Security definer pelo mesmo motivo de fn_channel_sessions_trava_uazapi_base_url (0914):
-- fn_billing_e_servidor só tem execute para service_role, e o gatilho roda com o papel de
-- quem grava. O papel da sessão (current_setting('role')) atravessa a troca de dono.
--
-- lock_timeout (D-084, B3): create trigger pega SHARE ROW EXCLUSIVE em user_organizations,
-- que espera escrita em andamento e enfileira as seguintes; com `set lock_timeout` a criação
-- desiste em 5s em vez de esperar sem limite, e o reaplicar tenta de novo. É `set` de sessão
-- (o baseline é aplicado instrução por instrução, sem transação) e o `reset` devolve a sessão.
--
-- Idempotente e seguro com o app no ar: create or replace da função e do gatilho, sem
-- reescrever linha nem constraint nova.
create or replace function public.fn_user_orgs_so_servidor_grava_vinculo()
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
    if new.user_id is distinct from auth.uid() then
      raise exception 'o vínculo com a organização só pode ser gravado pelo servidor' using errcode = '42501';
    end if;
  elsif new.user_id is distinct from old.user_id
     or new.role is distinct from old.role
     or new.revoked_at is distinct from old.revoked_at
     or new.accepted_at is distinct from old.accepted_at then
    raise exception 'o vínculo com a organização só pode ser gravado pelo servidor' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.fn_user_orgs_so_servidor_grava_vinculo() is
  '0929 (D-125): quem não é o servidor (fn_billing_e_servidor) só insere vínculo para si mesmo (user_id = auth.uid()) e não muda user_id, role, revoked_at nem accepted_at de linha existente. errcode 42501, mensagem fixa. As rotas do time gravam com o cliente de serviço depois de conferir o admin.';

revoke execute on function public.fn_user_orgs_so_servidor_grava_vinculo() from public, anon, authenticated;
grant execute on function public.fn_user_orgs_so_servidor_grava_vinculo() to service_role;

create or replace function public.fn_user_orgs_nunca_zero_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Conexão direta sem SET ROLE (migrações, manutenção, testes): o caminho do app nunca é esse, ele
  -- sempre chega como service_role ou authenticated pelo PostgREST. Fica fora da guarda.
  if coalesce(current_setting('role', true), 'none') = 'none'
     or old.role is distinct from 'admin' or old.revoked_at is not null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE' then
    if new.role = 'admin' and new.revoked_at is null then
      return new;
    end if;
  else
    -- Apagar a linha: o servidor (cascata, repasse do dono, scripts) não é conferido, e a
    -- cascata da organização ou do usuário nunca é barrada.
    if public.fn_billing_e_servidor()
       or not exists (select 1 from public.organizations where id = old.organization_id)
       or not exists (select 1 from auth.users where id = old.user_id) then
      return old;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('user_orgs_admins:' || old.organization_id::text, 0));

  if not exists (
    select 1 from public.user_organizations
    where organization_id = old.organization_id
      and role = 'admin'
      and revoked_at is null
      and id <> old.id
  ) then
    raise exception 'organizacao_sem_admin' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function public.fn_user_orgs_nunca_zero_admin() is
  '0929 (D-125): recusa (23514, organizacao_sem_admin) rebaixar, revogar ou apagar o último admin ativo da organização. Trava advisory por organização serializa duas saídas ao mesmo tempo. Apagar a linha só é conferido para quem não é o servidor, e nunca na cascata da organização ou do usuário.';

revoke execute on function public.fn_user_orgs_nunca_zero_admin() from public, anon, authenticated;
grant execute on function public.fn_user_orgs_nunca_zero_admin() to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_user_orgs_so_servidor_grava_vinculo(), public.fn_user_orgs_nunca_zero_admin() from agent_worker';
  end if;
end
$$;

set lock_timeout = '5s';

create or replace trigger trg_user_orgs_so_servidor
  before insert or update of user_id, role, revoked_at, accepted_at on public.user_organizations
  for each row
  execute function public.fn_user_orgs_so_servidor_grava_vinculo();

create or replace trigger trg_user_orgs_nunca_zero_admin
  before update of role, revoked_at or delete on public.user_organizations
  for each row
  execute function public.fn_user_orgs_nunca_zero_admin();

reset lock_timeout;
