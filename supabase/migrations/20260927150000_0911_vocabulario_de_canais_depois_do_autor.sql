-- 0911, o vocabulário de canais fecha a cadeia depois do autor (fork Hiperbold).
--
-- A 0387 (22/09, canal_datafy, do autor) reconstruiu
-- channel_sessions_provider_check, channel_sessions_provider_ref_check e
-- webhook_events_log_provider_check para somar 'datafy', a partir do
-- vocabulário que ela conhecia (sem 'uazapi': a 0900, ex-0385, vivia só no
-- fork até este merge de 2026-09-27).
--
-- Na cadeia de migrations, a 0903 (fork Hiperbold, já aplicada antes deste
-- merge, timestamp 20260922200000, depois do timestamp da 0387,
-- 20260922164700) roda por cima e reconstrói de novo
-- channel_sessions_provider_check e channel_sessions_provider_ref_check,
-- agora a partir do vocabulário que O FORK conhecia antes do merge (com
-- 'uazapi', sem 'datafy'). Ela não toca webhook_events_log_provider_check.
-- Sem este forward-fix, quem aplica a cadeia (supabase db push num clone)
-- perde 'datafy' nos dois CHECKs de channel_sessions e nunca ganha 'uazapi'
-- no CHECK de webhook_events_log.
--
-- Migration aplicada não se edita (nem a 0387, nem a 0903): esta migration
-- roda por último, com timestamp depois de toda a cadeia do autor até aqui
-- (a mais recente é a 0442, 20260927140300), e reafirma a UNIÃO final dos
-- três CHECKs. Lista igual ao bloco canônico do apêndice em baseline.sql
-- (uma constraint, um bloco). Catraca: tests/unit/check-do-baseline-nao-
-- diverge-da-cadeia.test.ts e tests/unit/migrations-nao-encolhem-
-- vocabulario.test.ts.

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'uazapi', 'wacalls', 'datafy'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'uazapi' and uazapi_instance_id is not null and uazapi_base_url is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'uazapi', 'datafy'
  ));
