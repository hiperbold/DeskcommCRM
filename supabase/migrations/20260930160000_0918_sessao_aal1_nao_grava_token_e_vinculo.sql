-- 0918, sessão sem o segundo fator não grava em api_tokens nem em user_organizations (D-092, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. A exigência de MFA vivia só no código das rotas (`requireRole`); a RLS
-- não olha o nível da sessão. Quem tem a senha de um admin com TOTP cadastrado
-- (sessão aal1) e usa a chave pública do projeto direto no PostgREST escrevia nas
-- duas tabelas que dão acesso persistente: insere em api_tokens o hash de um segredo
-- que ele escolheu (a chave sobrevive à troca de senha) e, se for admin de
-- plataforma, insere a si mesmo em user_organizations como admin de qualquer
-- empresa (policy user_orgs_insert).
--
-- A correção. Uma política RESTRICTIVE por comando de escrita (insert, update,
-- delete) nas duas tabelas, só para o papel `authenticated`, exigindo a prova da
-- sessão. A regra é a de fn_session_mfa_proven(): sessão aal2, OU o usuário não tem
-- fator TOTP verificado (quem nunca cadastrou não é trancado fora, o gate de
-- cadastro é do app). Não muda nada para service_role, nem para função security
-- definer (o papel de execução não é authenticated), que é por onde o app grava.
-- Leitura não muda: as rotas de leitura já passam por requireRole, e a policy de
-- SELECT de user_organizations é usada pelo próprio login para montar a sessão.
--
-- Por que um wrapper. fn_session_mfa_proven() é revogada de authenticated de
-- propósito (0229), e uma policy executa a função com o papel de quem consulta:
-- chamá-la direto daria "permission denied". Em vez de abrir a função original, a
-- ponte fn_session_mfa_proven_rls() só repete a pergunta, security definer, com
-- search_path fixo, executável só por authenticated.
--
-- Escopo deliberadamente estreito: só as duas tabelas do cenário. Estender a
-- exigência a todas as tabelas de dado de cliente é decisão separada (custo por
-- linha, fluxos que gravam com sessão aal1 de quem tem fator).
--
-- Reaplicável com o app no ar: create or replace + guarda por pg_policy (cada
-- policy só é criada se não existir; sem drop policy, que travaria a tabela por
-- inteiro), e lock_timeout curto para a criação desistir em vez de ficar na fila.
-- Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_session_mfa_proven_rls()
returns boolean language sql stable security definer set search_path=public as $$
 select public.fn_session_mfa_proven();
$$;
revoke all on function public.fn_session_mfa_proven_rls() from public,anon,authenticated;
grant execute on function public.fn_session_mfa_proven_rls() to authenticated;

do $mfa_na_escrita$
declare
 t text;
 cmd text;
 nome text;
 definicao text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach t in array array['api_tokens','user_organizations'] loop
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
$mfa_na_escrita$;
