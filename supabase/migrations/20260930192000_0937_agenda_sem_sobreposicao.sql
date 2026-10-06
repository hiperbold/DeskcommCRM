-- 0937, dois compromissos ativos do mesmo dono não se sobrepõem, nem numa corrida (D-160) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A conferência de ocupação mora na rota (`exigeHorarioLivre` e `exigeSemSobreposicao`): ela lê a
-- grade, decide e só depois grava. Entre a leitura e o INSERT há uma janela: dois turnos de IA, ou a
-- IA e um atendente, leem a mesma grade livre e os dois gravam. A idempotência só protege a mesma
-- chave e o índice único `calendar_appointments_sem_duplicata_idx` (0182) só cobre o MESMO início
-- exato do mesmo dono; um compromisso das 14h30 em cima do das 14h entrava.
--
-- A 0182 deixou a sobreposição de propósito (o encaixe de 14h-15h contra 14h30-15h30) e recusou
-- `exclude using gist`, que pediria `btree_gist`, ausente deste baseline. Desde então a rota passou
-- a recusar a sobreposição para TODOS, inclusive o encaixe de quem atende (a ocupação real não é
-- dispensada: 422 `agenda_horario_indisponivel`). O banco ainda não dizia o mesmo, e é isso que
-- esta migration alinha, sem extensão nova e sem tocar na tabela.
--
-- Gatilho BEFORE INSERT OR UPDATE OF starts_at, ends_at, owner_user_id, organization_id em
-- `calendar_appointments`:
--   1. só confere compromisso que OCUPA (pending ou confirmed) e tem dono. Os mesmos dois estados do
--      índice da 0182 e da conferência de sobreposição do espelho do Google (`fn_google_appointment`):
--      cancelado e falta liberam o horário, e realizado já aconteceu (a rota ainda o conta, mas ele
--      só colide com marcação retroativa, e esta rede existe para a corrida de quem marca à frente);
--   2. só confere a linha NOVA ou ALTERADA (horário ou dono). Dado antigo já sobreposto em produção
--      não é varrido e continua editável nas outras colunas e no desfecho;
--   3. pega `pg_advisory_xact_lock` por (organização, dono) ANTES de olhar: duas transações que
--      chegam juntas se enfileiram, a segunda enxerga o commit da primeira (cada comando do corpo
--      toma um snapshot novo em READ COMMITTED) e é recusada. A trava solta no fim da transação;
--      donos diferentes não esperam um pelo outro;
--   4. recusa com SQLSTATE `23P01` (exclusion_violation) e mensagem fixa, sem dizer de quem é o
--      compromisso que atrapalha. A rota traduz para 422 `agenda_horario_indisponivel`.
-- O gatilho se chama `trg_zzz_...` de propósito: os BEFORE rodam em ordem alfabética e este tem de ser
-- o último, depois da autoria, do carimbo do Google e da entrega do Meet, que recusam o que é deles com
-- mensagem própria; a sobreposição é a última pergunta antes de gravar.
-- Sobreposição estrita: 14h-15h e 15h-16h convivem. O compromisso não se vê como conflito de si
-- mesmo (`id <> new.id`) e remarcar para o mesmo horário é no-op.
--
-- O que NÃO entra aqui: o Google Agenda (`calendar_external_events`). O evento do Google é de
-- outra pessoa e de outro sistema, entra e sai por sincronização, e recusar a ESCRITA do CRM por
-- causa dele faria o sync do próprio espelho falhar em loop. A rota segue conferindo o Google na
-- hora de marcar (`coletaOQueOcupa`), que é onde a recusa é útil. Também não entra a regra de
-- "atendentes podem mexer na agenda dos colegas" (`fn_colegas_podem_mexer_na_agenda`): ela é de
-- PERMISSÃO e já é cobrada antes, na rota (criação) e em `fn_appointment_change_core` (alteração e
-- cancelamento); este gatilho só pergunta se o horário está livre, igual para todo escritor.
--
-- Security definer com search_path fixo: precisa ver os compromissos de todos os donos por cima da
-- RLS (o atendente só mexe na própria agenda quando a opção está desligada, mas a ocupação do
-- colega é fato do banco). Não é RPC: revoga EXECUTE de todos. Custo: uma leitura por
-- `calendar_appointments_org_dono_idx` (organização, dono, início) só quando o horário ou o dono mudam.
-- Reaplicável com o app no ar: `create or replace` e um DO com lock_timeout curto.
-- Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_agenda_sem_sobreposicao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.owner_user_id is null or new.status not in ('pending', 'confirmed') then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.starts_at is not distinct from old.starts_at
     and new.ends_at is not distinct from old.ends_at
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.organization_id is not distinct from old.organization_id
  then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agenda_dono:' || new.organization_id::text || ':' || new.owner_user_id::text, 0));

  if exists (
    select 1 from public.calendar_appointments o
     where o.organization_id = new.organization_id
       and o.owner_user_id = new.owner_user_id
       and o.id <> new.id
       and o.status in ('pending', 'confirmed')
       and o.starts_at < new.ends_at
       and o.ends_at > new.starts_at
  )
  then
    raise exception 'Horário indisponível: o responsável já tem um compromisso nesse período.' using errcode = '23P01';
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_agenda_sem_sobreposicao() from public, anon, authenticated;

do $g_agenda_sem_sobreposicao$
begin
 perform set_config('lock_timeout','3s',true);
 drop trigger if exists trg_zzz_agenda_sem_sobreposicao on public.calendar_appointments;
 create trigger trg_zzz_agenda_sem_sobreposicao
   before insert or update of starts_at, ends_at, owner_user_id, organization_id on public.calendar_appointments
   for each row execute function public.fn_agenda_sem_sobreposicao();
end
$g_agenda_sem_sobreposicao$;
