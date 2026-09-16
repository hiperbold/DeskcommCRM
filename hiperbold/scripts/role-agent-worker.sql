-- Role dedicada do worker e do app para a conexão direta ao Postgres
-- (SUPABASE_DB_URL), no lugar do dono do banco. Receita de
-- docs/deploy-selfhost/README.md, com duas diferenças medidas:
--
-- 1. `alter default privileges`: sem isto, toda tabela criada DEPOIS (a próxima
--    migration re-aplicada pelo baseline) nasce sem grant para esta role, e o
--    worker passa a falhar com "permission denied" só naquela tabela.
-- 2. Idempotente: pode rodar de novo a cada re-aplicação do baseline.
--
-- O que muda na prática: a role lê e escreve os DADOS de `public` (bypassrls,
-- porque o worker atende todas as organizações), mas não altera schema, não
-- lê `auth` nem `private` diretamente. As funções `security definer` (como a
-- cifra) continuam funcionando porque rodam com o dono.
--
-- A senha NÃO está aqui: vem por variável do psql.
--   psql "$DONO" -v senha="$SENHA" -f hiperbold/scripts/role-agent-worker.sql

\o /dev/null
select set_config('app.senha_agent_worker', :'senha', false);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute format('create role agent_worker login bypassrls password %L', current_setting('app.senha_agent_worker'));
  else
    execute format('alter role agent_worker login bypassrls password %L', current_setting('app.senha_agent_worker'));
  end if;
end $$;

select set_config('app.senha_agent_worker', '', false);
\o

grant usage on schema public to agent_worker;
grant select, insert, update, delete on all tables in schema public to agent_worker;
grant usage, select on all sequences in schema public to agent_worker;
grant execute on all functions in schema public to agent_worker;

alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to agent_worker;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to agent_worker;
alter default privileges for role postgres in schema public
  grant execute on functions to agent_worker;
