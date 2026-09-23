-- 0903 — channel_sessions_provider_check/_ref_check recuperam 'uazapi' (fork Hiperbold).
--
-- A 0261/0385 (16/09) criou os dois CHECKs já com o ramo 'uazapi'. A 0368
-- (21/09, redes_sociais_nativas, do autor) fez `drop constraint` + `add
-- constraint` para somar 'zernio_social' sem saber da 0261/0385 (mundos
-- separados até o merge de hoje) e reescreveu a lista do zero, sem 'uazapi'.
-- É o mesmo defeito do PR #963 que `check-do-baseline-nao-diverge-da-cadeia.test.ts`
-- vigia: a ÚLTIMA definição da cadeia manda, e ela tinha encolhido o
-- vocabulário. `install.sh`/`update.sh` aplicam só o `baseline.sql`, então lá
-- o valor nunca sumiu; quem aplicasse a CADEIA de migrations (`supabase db
-- push` num clone) passava a recusar 'uazapi' com 23514 em silêncio.
--
-- Forward-fix, não edição da 0368: migration aplicada não se edita. Lista
-- igual à do bloco canônico do apêndice em baseline.sql (uma constraint, um
-- bloco), então os dois caminhos de instalação voltam a concordar.
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'uazapi', 'wacalls'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'uazapi' and uazapi_instance_id is not null and uazapi_base_url is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null)
  );
