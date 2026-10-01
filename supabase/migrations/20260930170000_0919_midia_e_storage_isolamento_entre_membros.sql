-- 0919, mídia e Storage: o que um membro grava não alcança o arquivo de outra empresa (D-099, D-110, D-149, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Três buracos do mesmo desenho: o código do app confere o dono do arquivo, mas a
-- porta do PostgREST e da Storage API deixa o membro escrever por fora dele.
--
-- D-099. `storage_redaction_queue` era gravável por qualquer membro da própria
-- organização (policy FOR ALL só conferindo o tenant, mais `GRANT ALL` para
-- authenticated). O cron de apagamento remove `bucket/object_path` com a chave de
-- serviço, sem conferir nada: um viewer enfileirava a logo da instalação
-- (`brand-logos/platform/...`) ou o arquivo de outra empresa e, em 5 minutos, o
-- arquivo sumia. Quem enfileira de verdade são funções security definer e o
-- service_role, então o authenticated perde insert, update, delete, truncate,
-- references e trigger; a leitura da fila da própria organização continua. O
-- drain também passou a conferir bucket e prefixo (lib/lgpd/storage-redaction-queue.ts).
--
-- D-110. Os buckets `ai-policy` e `lgpd-exports` deixavam qualquer membro agir
-- pelo próprio JWT: o viewer apagava e subia PDF na base de conhecimento do agente
-- (injeção de prompt na próxima indexação) e o agent ou viewer listava e baixava o
-- `data.json` e o `report.pdf` dos titulares, que a API só entrega ao admin. Todo
-- upload e todo download oficiais usam o cliente de serviço (rotas de
-- conhecimento, worker e rota de LGPD), então as policies de escrita de
-- `ai-policy` são removidas e a leitura de `lgpd-exports` passa a exigir admin.
--
-- D-149. `messages.media_storage_path` é lido pela rota de mídia, pelo worker de
-- derivação e pelo agente para assinar ou baixar o arquivo, e o membro grava a
-- coluna pelo PostgREST: apontava para `<outraOrg>/<conversa>/<msg>.jpg` e recebia
-- o arquivo de outra empresa. O gatilho exige o prefixo `{organization_id}/{conversation_id}/`
-- normalizado (sem `..`, `//`, `\`, `%` e caractere de controle) quando a coluna é
-- gravada. Só no insert e na troca do valor: a linha antiga que o merge de
-- conversas da 0027 deixou com o prefixo da conversa de origem continua atualizável
-- por outras colunas (ack, status). Linha antiga não é varrida.
--
-- Reaplicável com o app no ar: create or replace, drop policy if exists, revoke
-- (idempotente) e lock_timeout curto para desistir em vez de ficar na fila.
-- Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_messages_media_path_da_conversa()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
 v_prefixo text := new.organization_id::text || '/' || new.conversation_id::text || '/';
begin
 if left(new.media_storage_path, length(v_prefixo)) = v_prefixo
    and strpos(new.media_storage_path, chr(92)) = 0
    and strpos(new.media_storage_path, '%') = 0
    and new.media_storage_path !~ '[[:cntrl:]]'
    and new.media_storage_path !~ '//'
    and new.media_storage_path !~ '(^|/)\.\.?(/|$)'
 then
  return new;
 end if;
 raise exception 'media_storage_path fora do prefixo organization_id/conversation_id' using errcode = '23514';
end
$$;
revoke all on function public.fn_messages_media_path_da_conversa() from public, anon, authenticated;

do $midia_e_storage$
begin
 perform set_config('lock_timeout','3s',true);

 revoke insert, update, delete, truncate, references, trigger on public.storage_redaction_queue from authenticated, anon;

 drop policy if exists "tenant_write_ai_policy" on storage.objects;
 drop policy if exists "tenant_delete_ai_policy" on storage.objects;

 drop policy if exists "tenant_read_lgpd_exports" on storage.objects;
 create policy "tenant_read_lgpd_exports" on storage.objects for select
  using (
   bucket_id = 'lgpd-exports'
   and public.fn_role_at_least((split_part(name, '/', 1))::uuid, 'admin')
  );

 create or replace trigger trg_messages_media_path_insert
  before insert on public.messages
  for each row
  when (new.media_storage_path is not null)
  execute function public.fn_messages_media_path_da_conversa();

 create or replace trigger trg_messages_media_path_update
  before update of media_storage_path on public.messages
  for each row
  when (new.media_storage_path is not null and new.media_storage_path is distinct from old.media_storage_path)
  execute function public.fn_messages_media_path_da_conversa();
end
$midia_e_storage$;
