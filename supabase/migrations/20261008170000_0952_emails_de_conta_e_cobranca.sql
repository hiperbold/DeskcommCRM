-- 0952, e-mails de conta e de cobrança: a fila de envio (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do Filipe em 08/10/2026: o CRM passa a mandar e-mail de conta e de cobrança (boas-vindas, plano
-- confirmado, recibo, pagamento não aprovado, estorno e os que vierem). Cada e-mail sai uma vez só para o
-- mesmo fato, mesmo que o evento do Asaas chegue repetido ou o processador rode duas vezes.
--
-- billing_emails_enviados é a FILA (outbox) e o registro: uma linha por (organização, e-mail, chave). `email_id`
-- é o código do e-mail (CONTA-06, COB-02, COB-03, COB-05, COB-08...) e `chave` é o fato que o dispara (a
-- organização, o pedido, o pagamento do Asaas). Quem dispara o fato só ENFILEIRA (insert on conflict do
-- nothing, com os dados do momento do evento em `dados`, sem endereço de e-mail de ninguém): a unicidade é a
-- idempotência e o gatilho nunca fala com servidor de e-mail. Quem envia é o cron
-- `enviar-emails-de-conta`, que pega um lote pela fn_billing_emails_reservar_lote (claim atômico, for update
-- skip locked) e grava o desfecho:
--
--   pendente          esperando a vez (proxima_tentativa_em); também o estado de quem falhou e vai tentar de novo
--   enviando          reservado por um cron até proxima_tentativa_em (5 min); se o processo morrer, a reserva
--                     vence e o lote seguinte pega a linha de novo
--   enviado           saiu para pelo menos um destinatário
--   falhou            esgotou as tentativas (6) sem sair para ninguém, ou o e-mail não pôde ser montado
--   sem_destinatario  a organização não tem quem receba (admin ativo com endereço, ou o criador)
--
-- `destino` diz quem recebe (os admins da organização ou o criador, com criador_user_id); o endereço é
-- resolvido NA HORA do envio. `ultimo_erro` é um código classificado (sem texto cru do servidor, que costuma
-- citar o destinatário). `resultado` guarda o desfecho por destinatário e canal, com o endereço mascarado.
--
-- RLS ligada sem policy nenhuma: só o servidor (service_role) lê e grava, nem select o cliente tem.
-- Sem delete nem truncate, nem para o service_role: o registro é só de acréscimo e de atualização.
--
-- Reaplicável com o app no ar e sobre a versão anterior desta migration (que criou só a tabela de registro):
-- create table if not exists, add column if not exists (a constraint de coluna só nasce junto da coluna),
-- constraints de tabela guardadas por pg_constraint, create or replace na função, lock_timeout curto, e a
-- transação única fecha a janela em que a tabela nova teria o ACL padrão do Supabase.
begin;

set lock_timeout = '3s';

create table if not exists public.billing_emails_enviados (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email_id text not null,
  chave text not null,
  criado_em timestamptz not null default now(),
  resultado jsonb not null default '{}'::jsonb,
  constraint billing_emails_enviados_email_id_formato check (email_id ~ '^[A-Z]{2,8}-[0-9]{2}$'),
  constraint billing_emails_enviados_chave_tamanho check (length(chave) between 1 and 200),
  constraint billing_emails_enviados_resultado_objeto check (jsonb_typeof(resultado) = 'object'),
  constraint billing_emails_enviados_org_email_chave_unique unique (organization_id, email_id, chave)
);

alter table public.billing_emails_enviados
  add column if not exists status text not null default 'pendente'
    constraint billing_emails_enviados_status_valido
    check (status in ('pendente', 'enviando', 'enviado', 'falhou', 'sem_destinatario')),
  add column if not exists dados jsonb not null default '{}'::jsonb
    constraint billing_emails_enviados_dados_objeto check (jsonb_typeof(dados) = 'object'),
  add column if not exists copia_para_operador boolean not null default false,
  add column if not exists destino text not null default 'admins'
    constraint billing_emails_enviados_destino_valido check (destino in ('admins', 'criador')),
  add column if not exists criador_user_id uuid,
  add column if not exists tentativas integer not null default 0
    constraint billing_emails_enviados_tentativas_faixa check (tentativas between 0 and 100),
  add column if not exists proxima_tentativa_em timestamptz not null default now(),
  add column if not exists enviado_em timestamptz,
  add column if not exists ultimo_erro text
    constraint billing_emails_enviados_ultimo_erro_codigo check (ultimo_erro is null or ultimo_erro ~ '^[a-z0-9_]{1,60}$');

do $emails_constraints$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_emails_enviados_criador_exigido') then
    alter table public.billing_emails_enviados
      add constraint billing_emails_enviados_criador_exigido
      check (destino <> 'criador' or criador_user_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'billing_emails_enviados_enviado_com_data') then
    alter table public.billing_emails_enviados
      add constraint billing_emails_enviados_enviado_com_data
      check (status <> 'enviado' or enviado_em is not null);
  end if;
end
$emails_constraints$;

create index if not exists billing_emails_enviados_fila_idx
  on public.billing_emails_enviados (proxima_tentativa_em)
  where status in ('pendente', 'enviando');

comment on table public.billing_emails_enviados is
  '0952: fila de envio e registro dos e-mails de conta e de cobrança, um por (organização, email_id, chave). email_id é o código do e-mail (CONTA-06, COB-02, COB-03, COB-05, COB-08, ...) e chave é o fato que o dispara (organização, pedido, pagamento do Asaas). O gatilho só enfileira (insert on conflict do nothing, com os dados do momento do evento em dados, sem e-mail de ninguém); o cron enviar-emails-de-conta reserva um lote (fn_billing_emails_reservar_lote), envia e grava status, tentativas, proxima_tentativa_em, enviado_em, ultimo_erro (código classificado) e resultado (por destinatário e canal, endereço mascarado). Só service_role lê e grava; RLS ligada sem policy nenhuma.';
comment on column public.billing_emails_enviados.status is
  '0952: pendente (espera a vez ou tenta de novo), enviando (reservado por um cron até proxima_tentativa_em), enviado, falhou (esgotou as tentativas ou não montou) ou sem_destinatario.';
comment on column public.billing_emails_enviados.dados is
  '0952: tudo que o template precisa, capturado NA HORA do evento (valores, plano, ciclo, datas, link da fatura, modo). Nunca guarda e-mail de destinatário: o endereço é resolvido no envio.';
comment on column public.billing_emails_enviados.ultimo_erro is
  '0952: código classificado da última falha (sem_resposta, recusado, limite, excecao, montagem, banco...), nunca o texto cru do servidor de e-mail.';

alter table public.billing_emails_enviados enable row level security;

revoke all on public.billing_emails_enviados from anon, authenticated;
grant select, insert, update on public.billing_emails_enviados to service_role;
revoke delete, truncate on public.billing_emails_enviados from service_role;

-- O claim do lote: pega até p_limite linhas pendentes (ou com a reserva vencida) cuja hora chegou, marca
-- como enviando, conta a tentativa e empurra proxima_tentativa_em para daqui a p_reserva_segundos. for update
-- skip locked: dois crons ao mesmo tempo nunca pegam a mesma linha. A linha de uma reserva vencida que já
-- gastou todas as tentativas (o processo morreu no meio, de novo) vira falhou em vez de voltar à fila.
create or replace function public.fn_billing_emails_reservar_lote(
  p_limite integer default 20,
  p_reserva_segundos integer default 300,
  p_max_tentativas integer default 6
)
returns setof public.billing_emails_enviados
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_limite is null or p_limite < 1 or p_limite > 100
     or p_reserva_segundos is null or p_reserva_segundos < 30 or p_reserva_segundos > 3600
     or p_max_tentativas is null or p_max_tentativas < 1 or p_max_tentativas > 20
  then
    raise exception 'emails_lote_invalido' using errcode = '22023';
  end if;

  update public.billing_emails_enviados
     set status = 'falhou',
         ultimo_erro = 'esgotado',
         proxima_tentativa_em = now()
   where status = 'enviando'
     and proxima_tentativa_em <= now()
     and tentativas >= p_max_tentativas;

  return query
  update public.billing_emails_enviados e
     set status = 'enviando',
         tentativas = e.tentativas + 1,
         proxima_tentativa_em = now() + make_interval(secs => p_reserva_segundos)
   where e.id in (
     select f.id
       from public.billing_emails_enviados f
      where f.status in ('pendente', 'enviando')
        and f.proxima_tentativa_em <= now()
      order by f.proxima_tentativa_em, f.criado_em
      limit p_limite
        for update skip locked
   )
  returning e.*;
end;
$$;

comment on function public.fn_billing_emails_reservar_lote(integer, integer, integer) is
  '0952: claim atômico do lote de e-mails de conta. Marca como enviando (e conta a tentativa) até p_limite linhas pendentes ou com a reserva vencida, com for update skip locked, e devolve as linhas reservadas. Reserva vencida que já gastou p_max_tentativas vira falhou. Só service_role.';

revoke execute on function public.fn_billing_emails_reservar_lote(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_emails_reservar_lote(integer, integer, integer) to service_role;

do $agent_worker_emails$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.billing_emails_enviados from agent_worker';
    execute 'revoke execute on function public.fn_billing_emails_reservar_lote(integer, integer, integer) from agent_worker';
  end if;
end
$agent_worker_emails$;

commit;

reset lock_timeout;
