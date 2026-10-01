-- 0922, mesclar contatos não apaga o opt-out nem a trava `force_human` (D-143, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. `fn_mesclar_contatos` (0407) combinava nome, e-mail, telefone, tags, LID e
-- identidade social, mas não `is_blocked`, `force_human`, `blocked_at`, `blocked_reason`
-- nem `consent`. O contato B pede para sair; um gerente mescla B em A; A herda o telefone
-- de B e fica `is_blocked = false`: IA, campanha e prospecção voltam a escrever para quem
-- pediu opt-out (o opt-out do titular vive só em `contacts.is_blocked`, 0376).
--
-- A correção. Para restrição vale a mais restritiva dos dois lados: `is_blocked` e
-- `force_human` do principal viram OU com os dos secundários; o bloqueio herdado leva o
-- `blocked_at` e o `blocked_reason` do secundário mais antigo bloqueado (o principal que já
-- estava bloqueado mantém os seus); no `consent`, toda chave recusada num secundário
-- (valor `false` ou objeto com `revoked_at`) passa ao principal. Concessão continua NÃO herdada (seria fabricar
-- consentimento). O resto do corpo é o da 0407, sem mudança.
--
-- Reaplicável com o app no ar: `create or replace` e o mesmo grant.
-- Cria função: entra ANTES da VARREDURA anon.

CREATE OR REPLACE FUNCTION public.fn_mesclar_contatos(p_organization_id uuid, p_contato_principal uuid, p_contatos_secundarios uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal public.contacts%rowtype;
  v_esperado integer;
  v_achado integer;
  v_alvo record;
  v_linha record;
  v_movidas integer;
  v_pulados integer;
  v_repontado jsonb := '{}'::jsonb;
  v_nao_repontado jsonb := '{}'::jsonb;
  v_nome text;
  v_apelido text;
  v_nascimento date;
  v_email text;
  v_telefone text;
  v_lid text;
  v_social text;
  v_tags text[];
  v_leads integer := 0;
  v_service_contact uuid;
  v_bloqueado boolean;
  v_bloqueado_em timestamptz;
  v_bloqueado_motivo text;
  v_force_human boolean;
  v_consent_restrito jsonb;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- 1 · Autorização. Fundir é destrutivo na prática: `manager`, o mesmo piso das
  --     policies de `merge_queue`. Sessão de service role (auth.uid() nulo) não
  --     passa por aqui, quem resolve a org nesse caminho é a rota, de fonte
  --     confiável, nunca do body.
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_contato_principal is null
     or p_contatos_secundarios is null
     or cardinality(p_contatos_secundarios) = 0
     or p_contato_principal = any(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'selecao_de_mesclagem_invalida';
  end if;

  select count(distinct id)::integer into v_esperado
    from unnest(p_contatos_secundarios) as ids(id);
  if v_esperado <> cardinality(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'secundario_repetido';
  end if;

  -- A TRAVA DA REGRA "CLIENTES PELA AGENDA" (migration 0262), ANTES DE TODA
  -- OUTRA. O passo 5 reponta `calendar_appointments.contact_id`, e o trigger
  -- desse repontamento pede `pg_advisory_xact_lock_shared(org, 262)`, só que
  -- a esta altura a fusão já segura os contatos (passos 2 e 3).
  -- `fn_definir_cliente_pela_agenda` pega a mesma trava EXCLUSIVA e depois
  -- trava contato por contato. Medido com duas sessões, sem esta linha: a fusão
  -- morria em `deadlock detected` e a rota devolvia 500. Aqui a ordem fica a
  -- mesma das duas funções, a organização primeiro, os contatos depois. Duas
  -- fusões, ou uma fusão e uma marcação, pegam a versão compartilhada e não se
  -- esperam.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(p_organization_id::text, 262));

  -- Mesmo mutex dos atendimentos, ANTES de qualquer row lock.
  for v_service_contact in select distinct id from unnest(array[p_contato_principal]||p_contatos_secundarios) ids(id) order by id loop
    perform public.fn_service_lock(p_organization_id,v_service_contact);
  end loop;
  perform 1 from public.conversations where organization_id=p_organization_id
    and contact_id=any(array[p_contato_principal]||p_contatos_secundarios) order by id for no key update;

  -- Conversa colidente NÃO aborta a fusão. Duas conversas no mesmo
  -- `channel_session_id` é exatamente COMO a duplicata de WhatsApp nasce (dois
  -- cadastros, dois números, o mesmo número de atendimento), então recusar aqui
  -- fecharia o caminho dominante do recurso, medido: o caso ordinário do
  -- `tests/e2e/juntar-contatos-duplicados.spec.ts` virava 409.
  -- Quem trata a colisão é o passo 5: `uniq_conversations_1to1_per_contact_session`
  -- levanta unique_violation, o repontamento cai para linha a linha, a conversa
  -- que não coube FICA na lápide e sai contada em `nao_repontado`, que a rota
  -- devolve e a tela anuncia ("N registro(s) continuaram no cadastro antigo").
  -- Mensagem não se perde: `messages.contact_id` não tem índice único por
  -- contato e passa inteira para o vencedor.

  -- 2 · O principal existe, é desta org, está vivo, e trava até o fim.
  select * into v_principal from public.contacts
   where id = p_contato_principal
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_principal_indisponivel';
  end if;

  -- 3 · Os secundários também. `is_anonymized = false` não é zelo: L-04 é
  --     irreversível, e reencaixar a linha anonimizada num contato ativo a
  --     traria de volta ao atendimento pela porta dos fundos.
  perform 1 from public.contacts
   where id = any(p_contatos_secundarios)
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  get diagnostics v_achado = row_count;
  if v_achado <> v_esperado then
    raise exception using errcode = 'P0002', message = 'contato_secundario_indisponivel';
  end if;

  -- 4 · A LÁPIDE VEM ANTES de tudo. É ela que solta telefone/e-mail/CPF dos
  --     índices únicos parciais para o vencedor poder herdá-los no passo 6.
  update public.contacts
     set is_merged_into = p_contato_principal,
         merged_at = now(),
         updated_at = now()
   where organization_id = p_organization_id
     and id = any(p_contatos_secundarios);

  -- Cadeia: quem já tinha sido mesclado NUM dos secundários passa a apontar para
  -- o vencedor. Sem isto, `is_merged_into` vira uma corrente que a leitura teria
  -- de percorrer, e ninguém percorre.
  update public.contacts
     set is_merged_into = p_contato_principal
   where organization_id = p_organization_id
     and is_merged_into = any(p_contatos_secundarios);

  -- 5 · Reponta TODO ponteiro para os perdedores. A lista sai do catálogo; o
  --     polimórfico entra à mão porque catálogo nenhum o conhece.
  for v_alvo in
    select n.nspname as esquema, c.relname as tabela, a.attname as coluna, ''::text as filtro
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_class c on c.oid = co.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
     where co.contype = 'f'
       and co.confrelid = 'public.contacts'::regclass
       and co.conrelid <> 'public.contacts'::regclass
       and array_length(co.conkey, 1) = 1
       and c.relkind = 'r'
       and n.nspname = 'public'
    union all
    select 'public', 'crm_lead_links', 'target_id', ' and target_kind = ''contact'''
     where to_regclass('public.crm_lead_links') is not null
    order by 2, 3
  loop
    v_pulados := 0;
    begin
      execute format(
        'update %I.%I set %I = $1 where %I = any($2)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.coluna, v_alvo.filtro
      ) using p_contato_principal, p_contatos_secundarios;
      get diagnostics v_movidas = row_count;
    exception when unique_violation or exclusion_violation then
      -- Colisão REAL e esperada: `uniq_job_queue_one_running_per_contact` deixa
      -- um job 'running' por contato, e os dois lados podem ter um. Em vez de
      -- abortar a fusão inteira por causa de estado efêmero de runtime, reponta
      -- linha a linha e conta quem ficou. Quem fica NÃO vira FK órfã, continua
      -- apontando para a lápide, que existe.
      v_movidas := 0;
      for v_linha in execute format(
        'select ctid as tid from %I.%I where %I = any($1)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.filtro
      ) using p_contatos_secundarios
      loop
        begin
          execute format(
            'update %I.%I set %I = $1 where ctid = $2',
            v_alvo.esquema, v_alvo.tabela, v_alvo.coluna
          ) using p_contato_principal, v_linha.tid;
          v_movidas := v_movidas + 1;
        exception when unique_violation or exclusion_violation then
          v_pulados := v_pulados + 1;
        end;
      end loop;
    end;

    if v_movidas > 0 then
      v_repontado := v_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_movidas);
    end if;
    if v_pulados > 0 then
      v_nao_repontado := v_nao_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_pulados);
    end if;
  end loop;

  -- 6 · O principal MANDA; o que ele não tem, vem dos perdedores. Nunca o
  --     contrário: sobrescrever o que o atendente digitou seria fusão com
  --     surpresa, e fusão não tem desfazer.
  select c.name into v_nome from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.name is not null
   order by c.created_at, c.id limit 1;
  select c.display_name into v_apelido from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.display_name is not null
   order by c.created_at, c.id limit 1;
  select c.birthdate into v_nascimento from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.birthdate is not null
   order by c.created_at, c.id limit 1;
  select c.email into v_email from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.email is not null
   order by c.created_at, c.id limit 1;
  select c.phone_number into v_telefone from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.phone_number is not null
   order by c.created_at, c.id limit 1;
  -- `wa_identity`/`wa_lid` são GERADAS: o que se herda é a origem delas. Sem
  -- isto o WhatsApp do perdedor fica órfão, `fn_upsert_wa_contact` filtra
  -- `is_merged_into is null`, não acharia mais ninguém e criaria um contato
  -- novo na mensagem seguinte, refazendo a duplicata que acabou de ser desfeita.
  select c.source_metadata->>'waha_lid' into v_lid from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.source_metadata->>'waha_lid' is not null
   order by c.created_at, c.id limit 1;
  -- A identidade social é a MESMA razão do `waha_lid`, pelo lado de quem fala
  -- por rede social: com o #1444 `upsertSocialContact` filtra
  -- `is_merged_into is null`, então sem herdar a identidade a próxima DM daquela
  -- pessoa não acha ficha viva com esta identidade e abre uma nova, refazendo a
  -- duplicata que a fusão acabou de desfazer (issue #1455). O índice
  -- `contacts_org_social_identity_unique` é parcial em `is_merged_into is null`,
  -- então o único conflito possível é com um TERCEIRO contato vivo.
  select c.social_identity into v_social from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.social_identity is not null
   order by c.created_at, c.id limit 1;

  -- Guardas de unicidade. A lápide já tirou os perdedores dos índices parciais,
  -- então o que sobrar aqui é conflito com um TERCEIRO contato vivo, e nesse
  -- caso o vencedor simplesmente não herda o campo. Falhar a fusão inteira por
  -- causa de um e-mail seria perder o repontamento que já valeu a pena.
  if v_email is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.email_normalized = lower(btrim(v_email))
  ) then v_email := null; end if;
  if v_telefone is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.phone_number = v_telefone
  ) then v_telefone := null; end if;
  if v_lid is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.wa_lid = v_lid
  ) then v_lid := null; end if;
  if v_social is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.social_identity = v_social
  ) then v_social := null; end if;

  -- O QUE RESTRINGE VAI COM A FICHA (D-143). O opt-out do titular vive só em
  -- `contacts.is_blocked` e a trava de IA em `force_human`: o principal herda o
  -- telefone do secundário, então se a ficha que pediu para sair some na lápide
  -- e o vencedor volta `is_blocked = false`, IA, campanha e prospecção voltam a
  -- escrever para quem pediu opt-out. Aqui é o contrário do resto da fusão (o
  -- principal manda): para restrição, vale a mais restritiva dos dois lados.
  select coalesce(v_principal.is_blocked, false) or coalesce(bool_or(c.is_blocked), false),
         coalesce(v_principal.force_human, false) or coalesce(bool_or(c.force_human), false)
    into v_bloqueado, v_force_human
    from public.contacts c
   where c.id = any(p_contatos_secundarios);
  -- Quando quem herda o bloqueio é o secundário, leva o carimbo e o motivo dele
  -- (o bloqueio mais antigo), para o registro de quando e por quê continuar verdadeiro.
  select c.blocked_at, c.blocked_reason into v_bloqueado_em, v_bloqueado_motivo
    from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.is_blocked
   order by c.blocked_at nulls last, c.created_at, c.id limit 1;
  -- `consent`: continua sem herdar concessão (seria fabricar consentimento), mas a
  -- RECUSA registrada no cadastro que sai vale: toda chave recusada num secundário
  -- (valor `false`, ou objeto com `revoked_at` preenchido) passa ao principal com o
  -- mesmo valor.
  select jsonb_object_agg(e.key, e.value) into v_consent_restrito
    from public.contacts c, lateral jsonb_each(coalesce(c.consent, '{}'::jsonb)) e
   where c.id = any(p_contatos_secundarios)
     and jsonb_typeof(c.consent) = 'object'
     and (e.value = 'false'::jsonb
          or (jsonb_typeof(e.value) = 'object' and e.value->>'revoked_at' is not null));

  select coalesce(array_agg(distinct t), '{}'::text[]) into v_tags
    from (
      select unnest(c.tags) as t from public.contacts c
       where c.organization_id = p_organization_id
         and (c.id = p_contato_principal or c.id = any(p_contatos_secundarios))
    ) as todas;

  -- CPF e `consent` NÃO são herdados, de propósito. CPF é um PAR
  -- (`cpf_encrypted` + `cpf_hash`) preso por check constraint e criptografado
  -- com a chave da instalação, mover metade quebra a linha. `consent` é
  -- registro legal do que AQUELA pessoa autorizou; herdar um "granted_at" de
  -- outro cadastro fabricaria consentimento. Falha fechada nos dois.
  update public.contacts set
    name = coalesce(name, v_nome),
    display_name = coalesce(display_name, v_apelido),
    birthdate = coalesce(birthdate, v_nascimento),
    email = coalesce(email, v_email),
    phone_number = coalesce(phone_number, v_telefone),
    social_identity = coalesce(social_identity, v_social),
    is_blocked = v_bloqueado,
    blocked_at = case
      when v_bloqueado then coalesce(blocked_at, v_bloqueado_em, now())
      else blocked_at end,
    blocked_reason = case
      when v_bloqueado then coalesce(blocked_reason, v_bloqueado_motivo)
      else blocked_reason end,
    force_human = v_force_human,
    consent = case
      when v_consent_restrito is not null
        then coalesce(consent, '{}'::jsonb) || v_consent_restrito
      else consent end,
    tags = v_tags,
    last_activity_at = greatest(
      last_activity_at,
      (select max(c.last_activity_at) from public.contacts c
        where c.id = any(p_contatos_secundarios))
    ),
    source_metadata = (
      case when source_metadata->>'waha_lid' is null and v_lid is not null
        then source_metadata || jsonb_build_object('waha_lid', v_lid)
        else source_metadata end
    )
      - case when coalesce(phone_number, v_telefone) is not null
             then 'telefone_em_conflito' else '' end
      || jsonb_build_object(
           'mesclado_de',
           coalesce(source_metadata->'mesclado_de', '[]'::jsonb)
             || to_jsonb(p_contatos_secundarios),
           'mesclado_em', to_jsonb(now())
         ),
    updated_at = now()
  where id = p_contato_principal and organization_id = p_organization_id;

  -- 7 · A fusão aparece na timeline de cada negócio que o vencedor passou a ter.
  --     `crm_lead_activities.lead_id` é NOT NULL, contato sem negócio nenhum
  --     não tem onde escrever, e para esse caso quem guarda o rastro é o
  --     `api_audit_log` que a rota emite, sempre.
  insert into public.crm_lead_activities
    (organization_id, lead_id, contact_id, source_module, source_id, type,
     payload, metadata, performed_at, performed_by_user_id)
  select p_organization_id, l.id, p_contato_principal, 'crm', p_contato_principal,
         'contacts_merged',
         jsonb_build_object(
           'contatos_mesclados', to_jsonb(p_contatos_secundarios),
           'repontado', v_repontado,
           'nao_repontado', v_nao_repontado
         ),
         '{}'::jsonb, now(), auth.uid()
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contato_principal;
  get diagnostics v_leads = row_count;

  return jsonb_build_object(
    'contato_id', p_contato_principal,
    'contatos_mesclados', to_jsonb(p_contatos_secundarios),
    'repontado', v_repontado,
    'nao_repontado', v_nao_repontado,
    'atividades_emitidas', v_leads
  );
end;
$function$;

revoke execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.fn_mesclar_contatos(uuid, uuid, uuid[]) to authenticated, service_role;
notify pgrst, 'reload schema';
