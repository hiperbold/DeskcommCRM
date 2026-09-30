-- 0914, o servidor da conexão UAZAPI só é gravado pelo servidor da aplicação (D-083, achado 4, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. channel_sessions.uazapi_base_url é o endereço para onde o processo
-- manda o token da instância e busca o que o servidor responde. Ele só era
-- conferido no cadastro (validarInstanciaUazapi), mas a tabela tem GRANT ALL a
-- authenticated e a policy de escrita (channel_sessions_tenant_write) só exige
-- admin da organização. Um admin gravava a coluna direto pelo PostgREST, sem
-- passar pela validação, e apontava a conexão para a rede interna do servidor
-- (169.254.169.254, um serviço do compose): o processo então falava com esse
-- endereço levando o token e devolvia a resposta em mídia ou foto.
--
-- A correção, em duas camadas. Esta é a do banco: um gatilho BEFORE INSERT OR
-- UPDATE OF uazapi_base_url recusa (42501, mensagem fixa sem dado do banco)
-- gravar ou mudar a coluna quando quem grava não é o SERVIDOR, pelo mesmo
-- critério das outras travas do fork (fn_billing_e_servidor, 0907: conexão
-- direta sem SET ROLE, ou service_role). A outra camada mora no código: as duas
-- funções `chamar` da UAZAPI passam pela régua de destino de organização a cada
-- requisição, sem seguir redirect.
--
-- Por gatilho e não por REVOKE de coluna: a tabela tem GRANT ALL a authenticated
-- e anon no baseline, e revogar UPDATE de uma coluna sozinho não tira o que o
-- grant de tabela já deu (só REVOKE do grant de tabela inteiro, que quebraria as
-- outras colunas que o admin edita pela tela). O gatilho independe dos grants.
--
-- Quem grava a coluna hoje: salvarConexaoUazapi (lib/channels/uazapi/conexao.ts),
-- chamada por conectarPorInstancia (lib/channels/instancia.ts) com o cliente de
-- SERVIÇO da rota /api/v1/channels/instancia. Nenhuma tela grava pela sessão do
-- usuário, então o cadastro legítimo segue igual. O INSERT com a coluna nula
-- (todo canal que não é UAZAPI, criado por qualquer admin) também segue igual.
--
-- Security definer pelo mesmo motivo de fn_billing_trava_organization_id
-- (0907): fn_billing_e_servidor só tem execute para service_role, e o gatilho
-- roda com o papel de quem grava. O papel da sessão (current_setting('role'))
-- atravessa a troca de dono, como provado no comentário de fn_billing_e_servidor.
--
-- lock_timeout (D-084, B3): create trigger pega SHARE ROW EXCLUSIVE em
-- channel_sessions, que espera qualquer escrita em andamento e, enquanto espera,
-- enfileira todas as escritas seguintes: com o app no ar, a tabela parada. Com
-- `set lock_timeout` a criação falha em 5s em vez de esperar sem limite, e o
-- reaplicar tenta de novo. É `set` de sessão, e não `set local`, porque o
-- baseline é aplicado instrução por instrução, sem transação, onde `set local`
-- não vale; o `reset` logo depois devolve a sessão ao que ela tinha.
--
-- Idempotente e seguro com o app no ar, instrução por instrução: create or
-- replace da função e do gatilho, sem reescrever linha nenhuma, sem constraint
-- nova (nenhuma linha existente é revalidada).
create or replace function public.fn_channel_sessions_trava_uazapi_base_url()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.fn_billing_e_servidor() and (
    (tg_op = 'INSERT' and new.uazapi_base_url is not null)
    or (tg_op = 'UPDATE' and new.uazapi_base_url is distinct from old.uazapi_base_url)
  ) then
    raise exception 'uazapi_base_url só pode ser alterado pelo servidor' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.fn_channel_sessions_trava_uazapi_base_url() is
  '0914 (D-083, achado 4): recusa gravar ou mudar channel_sessions.uazapi_base_url quando quem grava não é o servidor (fn_billing_e_servidor: conexão direta sem SET ROLE ou service_role). Sem isto o admin da organização apontava o servidor da conexão para a rede interna pelo PostgREST (GRANT ALL a authenticated, policy de escrita só exige admin), pulando a validação do cadastro. errcode 42501, mensagem fixa. INSERT com a coluna nula (canal que não é UAZAPI) e UPDATE que não muda o valor passam. O cadastro legítimo grava pelo cliente de serviço (salvarConexaoUazapi).';

revoke execute on function public.fn_channel_sessions_trava_uazapi_base_url() from public, anon, authenticated;
grant execute on function public.fn_channel_sessions_trava_uazapi_base_url() to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_channel_sessions_trava_uazapi_base_url() from agent_worker';
  end if;
end
$$;

set lock_timeout = '5s';

create or replace trigger trg_channel_sessions_trava_uazapi_base_url
  before insert or update of uazapi_base_url on public.channel_sessions
  for each row
  execute function public.fn_channel_sessions_trava_uazapi_base_url();

reset lock_timeout;
