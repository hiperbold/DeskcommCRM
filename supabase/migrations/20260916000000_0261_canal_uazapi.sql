-- 0261 — quinto transporte de mensagem: instância de WhatsApp num servidor UAZAPI.
--
-- O VOCABULÁRIO antes do transporte, como a 0131 fez com o canal intermediado:
-- tipo TypeScript, matriz de capabilities e colunas de referência nascem juntos,
-- e o adapter chega encontrando o schema pronto.
--
-- ─── Por que TRÊS colunas, e não reusar as do canal por QR ──────────────────
--
-- `uazapi_instance_id`: o `instance.id` que o servidor devolve. É o sessionRef
-- (espelhado em lib/channels/session-ref.ts). Não é o telefone nem o nome da
-- instância, que muda pela tela do servidor.
--
-- `uazapi_base_url`: o servidor é POR CONEXÃO, não da instalação. Uma agência
-- tem o próprio servidor e cada cliente pode ter outro; um env global limitaria
-- a instalação a um servidor só (a mesma lição da 0087 com a WABA). E o id da
-- instância só é único dentro do servidor que o emitiu, por isso a trava de
-- unicidade abaixo é o PAR.
--
-- `uazapi_token_encrypted`: o token da instância, cifrado por fn_encrypt_oauth.
-- Quem o tem envia mensagem pelo número; nunca em claro.
--
-- Idempotente e auto-curativa (doutrina de migrations): as colunas nascem
-- nullable, então nenhuma linha existente as viola; os CHECKs são RECRIADOS
-- (drop + add) porque precisam MUDAR. Nada a deduplicar antes do índice: as
-- colunas acabam de nascer vazias, e o índice nasce junto delas.

alter table public.channel_sessions
  add column if not exists uazapi_instance_id text,
  add column if not exists uazapi_base_url text,
  add column if not exists uazapi_token_encrypted bytea;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'uazapi'::text, 'wacalls'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider = 'zernio'     and zernio_account_id    is not null) or
    (provider = 'uazapi'     and uazapi_instance_id   is not null and uazapi_base_url is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null)
  );

comment on column public.channel_sessions.uazapi_instance_id is
  'Id da instância no servidor UAZAPI (instance.id de /instance/status). É o sessionRef deste canal; espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.uazapi_base_url is
  'Servidor UAZAPI desta conexão (ex.: https://empresa.uazapi.com). Por sessão, não da instalação: cada organização pode usar outro servidor.';
comment on column public.channel_sessions.uazapi_token_encrypted is
  'Token da instância UAZAPI, cifrado por fn_encrypt_oauth. Quem tem este valor envia mensagem pelo número.';

-- Dois canais ATIVOS com a mesma instância no mesmo servidor são recusados pelo
-- Postgres, pelo mesmo motivo da 0165: sem a trava, a busca de credencial por
-- instância pode casar duas linhas, e o envio sai pela organização errada.
create unique index if not exists channel_sessions_uazapi_instancia_ativa_unique
  on public.channel_sessions (uazapi_base_url, uazapi_instance_id)
  where archived_at is null and uazapi_instance_id is not null;

-- O arquivo de webhooks recebidos grava o provider da sessão: sem 'uazapi' aqui,
-- a entrada pela rota neutra falharia ao abrir o arquivo do payload.
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'uazapi'
  ));
