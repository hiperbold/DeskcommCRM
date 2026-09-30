-- 0915, o endereço próprio e a chave de um ponto de IA só são gravados pelo servidor da aplicação (D-084, B1, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. ai_purpose_bindings.base_url é o endereço para onde o servidor manda
-- a chave da empresa e a conversa do cliente; credential_id é qual chave sai. As
-- travas ficam no PUT /api/v1/ai/providers: régua de destino de organização
-- (recusa rede interna, exige https) e "endereço próprio exige a chave da
-- própria empresa", com a credencial conferida contra a organização e o
-- provedor. Mas a tabela tem GRANT de escrita a authenticated e a policy
-- tenant_isolation_ai_purpose_bindings_write só exige admin da organização: um
-- admin gravava as duas colunas direto pelo PostgREST, pulava toda a validação
-- do PUT, apontava o ponto para a rede interna do servidor e, gravando um
-- credential_id que não era dele (a FK só olha o id, não a organização), usava a
-- chave de outra empresa.
--
-- A correção, em duas camadas. Esta é a do banco: um gatilho BEFORE INSERT OR
-- UPDATE OF base_url, credential_id recusa (42501, mensagem fixa sem dado do
-- banco) o que não é o SERVIDOR gravando, pelo mesmo critério das outras travas
-- do fork (fn_billing_e_servidor, 0907: conexão direta sem SET ROLE, ou
-- service_role). A outra camada mora no código: o PUT passou a gravar pelo
-- cliente de serviço, depois das checagens de papel e de destino que já faz e
-- com a organização vinda da sessão, nunca do corpo.
--
-- O que passa para quem não é o servidor, de propósito:
--   * INSERT com as duas colunas nulas (o ponto nasce "usa o padrão");
--   * UPDATE que não muda base_url nem credential_id (trocar modelo, ligar e
--     desligar o ponto);
--   * UPDATE que limpa credential_id para nulo, exceto quando o ponto tem
--     base_url (limpar a chave de um endereço próprio deixaria o ponto sem a
--     chave da empresa, que é o que o "exige credencial" do PUT impede). A
--     limpeza sem base_url só reduz o que o ponto alcança, e é o que a FK
--     `on delete set null` da 0141 faz quando uma chave é apagada.
--
-- Por gatilho e não por REVOKE de coluna, pelo mesmo motivo da 0914: o GRANT de
-- tabela inteira dá o que o REVOKE de coluna não tira, e revogar a tabela
-- quebraria as colunas que o admin edita.
--
-- Quem grava a tabela hoje: só o PUT de app/api/v1/ai/providers/route.ts (as
-- demais leituras são de SELECT). Depois desta migração ele grava com o cliente
-- de serviço; nenhuma tela grava pela sessão do usuário.
--
-- Security definer pelo mesmo motivo da 0914 (fn_billing_e_servidor só tem
-- execute para service_role e o gatilho roda com o papel de quem grava).
--
-- lock_timeout: create trigger pega SHARE ROW EXCLUSIVE na tabela, que espera
-- qualquer escrita em andamento e, enquanto espera, enfileira todas as escritas
-- seguintes. Com o app no ar isso é a tabela parada. Com `set lock_timeout` a
-- criação falha em 5s em vez de esperar sem limite, e o reaplicar tenta de novo.
-- É `set` de sessão, e não `set local`, porque o baseline é aplicado instrução
-- por instrução, sem transação, onde `set local` não vale; o `reset` logo depois
-- devolve a sessão ao que ela tinha.
--
-- Idempotente e seguro com o app no ar, instrução por instrução: create or
-- replace da função e do gatilho, sem reescrever linha nenhuma, sem constraint
-- nova (nenhuma linha existente é revalidada).
create or replace function public.fn_ai_purpose_bindings_trava_endereco_e_chave()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.fn_billing_e_servidor() then
    if tg_op = 'INSERT' then
      if new.base_url is not null or new.credential_id is not null then
        raise exception 'base_url e credential_id do ponto de IA só podem ser alterados pelo servidor' using errcode = '42501';
      end if;
    elsif tg_op = 'UPDATE' then
      if new.base_url is distinct from old.base_url
        or (new.credential_id is distinct from old.credential_id and new.credential_id is not null)
        or (new.credential_id is null and old.credential_id is not null and new.base_url is not null)
      then
        raise exception 'base_url e credential_id do ponto de IA só podem ser alterados pelo servidor' using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.fn_ai_purpose_bindings_trava_endereco_e_chave() is
  '0915 (D-084, B1): recusa gravar ou mudar ai_purpose_bindings.base_url e credential_id quando quem grava não é o servidor (fn_billing_e_servidor: conexão direta sem SET ROLE ou service_role). Sem isto o admin da organização pulava as travas do PUT (régua de destino, exige credencial da empresa, credencial da própria organização) gravando pelo PostgREST (GRANT de escrita a authenticated, policy só exige admin). errcode 42501, mensagem fixa. Passam: INSERT com as duas colunas nulas, UPDATE que não muda as duas colunas e UPDATE que limpa credential_id em ponto sem base_url (a FK on delete set null da 0141 faz isso). O PUT grava pelo cliente de serviço.';

revoke execute on function public.fn_ai_purpose_bindings_trava_endereco_e_chave() from public, anon, authenticated;
grant execute on function public.fn_ai_purpose_bindings_trava_endereco_e_chave() to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_ai_purpose_bindings_trava_endereco_e_chave() from agent_worker';
  end if;
end
$$;

set lock_timeout = '5s';

create or replace trigger trg_ai_purpose_bindings_trava_endereco_e_chave
  before insert or update of base_url, credential_id on public.ai_purpose_bindings
  for each row
  execute function public.fn_ai_purpose_bindings_trava_endereco_e_chave();

reset lock_timeout;
