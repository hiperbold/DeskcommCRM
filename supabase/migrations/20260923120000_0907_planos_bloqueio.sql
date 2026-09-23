-- 0907, bloqueio do plano (fase F3, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F3-tarefas.md, decisões 1 a 3 e Tarefa 1.
--
-- Objetivo da fase: construir o bloqueio de verdade, mas deixá-lo DESLIGADO.
-- billing_settings.modo continua 'avisar' em qualquer banco ao fim desta
-- migration (ela não muda a linha semeada pela 0905); ligar o bloqueio é um
-- ato do admin da plataforma, pela tela, chamando fn_billing_definir_modo.
-- Enquanto o modo for 'avisar' ou 'desligado', nada aqui muda comportamento
-- nenhum: fn_billing_bloqueia lê o modo e sai sem travar nem contar antes de
-- qualquer outro trabalho (decisão 3, "zero custo a mais").
--
-- Esta migration (0907) é só a Tarefa 1 da fase: modo, carência e bloqueio
-- de funis, etapas por funil, conexões e integrações webhook. Membros
-- (Tarefa 2), a IA (Tarefa 3) e leads (Tarefa 7) ficam para migrations
-- seguintes desta mesma faixa.
--
-- Decisão 2 (carência por organização):
-- billing_contracts.bloqueio_a_partir_de timestamptz, NULO = não bloqueia
-- (mesma regra de enforcement_effective_at do orçamento de IA do autor).
-- fn_billing_definir_modo preenche now() + billing_settings.carencia_dias em
-- TODO contrato sem data ao passar para 'bloquear', com aviso na Central de
-- cada organização afetada. Organização nova com o modo já em 'bloquear'
-- ganha a carência por um gatilho NOSSO em billing_contracts (after insert),
-- sem editar o gatilho de organização nova da 0904
-- (fn_billing_contrato_da_organizacao_nova). Troca para plano de teto menor
-- dá carência a partir da troca, por outro gatilho NOSSO (after update of
-- plan_id), sem editar fn_billing_trocar_plano (0904): ela grava plan_id por
-- um upsert que sempre lista a coluna no SET, então o gatilho confere
-- IS DISTINCT FROM para não disparar numa troca que manteve o mesmo plano.
-- Ao SAIR de 'bloquear', as datas de carência já dadas NÃO são apagadas
-- (fn_billing_definir_modo só grava carência ao ENTRAR em 'bloquear'):
-- voltar a bloquear depois respeita a carência já concedida antes.
--
-- As três peças que dão carência (a bulk de fn_billing_definir_modo e os
-- dois gatilhos) compartilham fn_billing_dar_carencia, que trava só quando
-- bloqueio_a_partir_de ainda está nulo (idempotente: um contrato que já tem
-- data não ganha uma data nova nem um aviso duplicado) e cria o aviso na
-- Central com texto fixo contendo a data, kind='other',
-- ref_kind='billing_limite' (mesma família de aviso da 0905), deduplicado
-- por organização + título ENQUANTO status='open' (o título inclui a data
-- exata da carência, que é a mesma para todo mundo processado na MESMA
-- chamada de fn_billing_definir_modo, porque now() é o tempo da transação).
--
-- Decisão 3 (bloqueio no banco):
-- fn_billing_bloqueia(p_org, p_item, p_pipeline) decide o veredito: modo
-- 'bloquear' E bloqueio_a_partir_de preenchido e VENCIDO E teto efetivo não
-- nulo E fn_billing_pode_criar diz que não pode. Lê modo, carência e teto
-- ANTES de travar (mesma ordem de fn_billing_conferir_teto, 0905): sai sem
-- pegar lock nenhum quando qualquer uma dessas condições já falha, e SÓ
-- ENTÃO pega a MESMA trava bloqueante de fn_billing_conferir_teto
-- (pg_advisory_xact_lock por 'billing:'||org||':'||item, NUNCA a variante
-- _try_: com _try_, duas criações simultâneas no teto menos um passariam as
-- duas). A contagem (fn_billing_pode_criar, já VOLATILE) roda DENTRO de um
-- bloco begin/exception que devolve false em qualquer falha interna (raise
-- warning primeiro): falha interna LIBERA, nunca bloqueia por acidente.
--
-- Os quatro gatilhos de funis, etapas por funil, conexões e integrações
-- webhook são NOSSOS (nasceram na 0905) e por isso são editados NO LUGAR lá
-- (migration 0905 e o bloco dela no baseline.sql), não aqui: antes de cada
-- chamada existente a fn_billing_conferir_teto (a conferência de aviso), um
-- "if fn_billing_bloqueia(...) then raise exception ... PT402" FORA de
-- qualquer bloco exception (nenhum desses quatro gatilhos envolve o corpo
-- inteiro em exception when others). fn_billing_bloqueia só existe a partir
-- desta migration (0907, aplicada DEPOIS da 0905): a chamada dentro do corpo
-- da função da 0905 só é resolvida em tempo de EXECUÇÃO (plpgsql não
-- confere a existência de função chamada na hora de CRIAR a função que
-- chama, só na hora de rodar), e nenhum insert/update das quatro tabelas
-- acontece durante a aplicação de migrations. Membros (team_invites,
-- user_organizations) e leads (crm_leads) ficam de fora desta migration
-- (decisões 4 e 5 da fase, Tarefas 2 e 7).
--
-- Mesmo padrão de segurança das fases anteriores (0904/0905/0906): security
-- definer, search_path fixo em public, pg_temp, revoke de public/anon/
-- authenticated e grant só para service_role, bloco final revogando de
-- agent_worker (se a role existir) o execute das funções novas: essa role
-- tem bypassrls e ganharia o execute por alter default privileges se este
-- bloco não existisse.
--
-- Idempotente: add column if not exists, constraint nomeada criada só se
-- ainda não existe, create or replace, drop trigger if exists antes de
-- recriar.

-- ============================================================================
-- 1. billing_settings.carencia_dias e billing_contracts.bloqueio_a_partir_de.
-- ============================================================================

-- billing_settings já existe desde a 0905; a linha única (id = 1) também.
alter table public.billing_settings add column if not exists carencia_dias integer not null default 7;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_settings_carencia_dias_check') then
    alter table public.billing_settings
      add constraint billing_settings_carencia_dias_check
      check (carencia_dias between 0 and 90);
  end if;
end
$$;

comment on column public.billing_settings.carencia_dias is
  '0907, decisão 2 (N19, padrão 7): quantos dias de carência uma organização ganha ao entrar no modo bloquear, contados a partir do momento em que fn_billing_definir_modo grava a data (ou do insert/troca de plano que dá carência a uma organização isolada). Não retroage: mudar este número não recalcula bloqueio_a_partir_de de quem já tem data.';

-- billing_contracts já existe desde a 0904 (uma linha por organização).
-- Nulo = não bloqueia (mesma regra de enforcement_effective_at do orçamento
-- de IA do autor, decisão 2 da fase): é o padrão de toda organização, até
-- ganhar uma data por fn_billing_definir_modo ou pelos dois gatilhos abaixo.
alter table public.billing_contracts add column if not exists bloqueio_a_partir_de timestamptz;

comment on column public.billing_contracts.bloqueio_a_partir_de is
  '0907, decisão 2: a partir de quando esta organização passa a bloquear de verdade (fn_billing_bloqueia), no modo bloquear. NULO = não bloqueia. Preenchida por fn_billing_dar_carencia, chamada por fn_billing_definir_modo (ao entrar em bloquear, para toda organização sem data), pelo gatilho de organização nova (trg_billing_trava_carencia_contrato_novo) e pelo gatilho de troca para plano de teto menor (trg_billing_trava_carencia_troca_de_plano). Sair do modo bloquear NÃO apaga a data: voltar a bloquear depois respeita a carência já dada.';

-- ============================================================================
-- 2. fn_billing_dar_carencia: dá a carência a UM contrato, se ainda não tem.
-- ============================================================================
--
-- Compartilhada pelas três peças que dão carência (item 3, abaixo, e a bulk
-- de fn_billing_definir_modo, item 4): trava por linha (update ... where
-- bloqueio_a_partir_de is null), então uma organização que já tem data não
-- ganha uma data nova nem um segundo aviso, mesmo chamada duas vezes.
-- Devolve true só quando de fato gravou (para fn_billing_definir_modo
-- contar quantas organizações receberam carência agora).
create or replace function public.fn_billing_dar_carencia(p_contract_id uuid, p_carencia_dias integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_data timestamptz;
  v_titulo text;
begin
  v_data := now() + (p_carencia_dias || ' days')::interval;

  update public.billing_contracts
    set bloqueio_a_partir_de = v_data
    where id = p_contract_id and bloqueio_a_partir_de is null
    returning organization_id into v_org;

  if v_org is null then
    -- Ou o contrato não existe, ou já tinha data (idempotente): nada a fazer.
    return false;
  end if;

  -- Texto fixo com a data (decisão 2): o título inclui a data exata, então o
  -- dedup por organização + título ENQUANTO status='open' não confunde uma
  -- carência antiga (já resolvida) com esta.
  v_titulo := 'Bloqueio do plano fica ativo em ' || to_char(v_data, 'DD/MM/YYYY');

  if not exists (
    select 1 from public.agent_inbox_items
    where organization_id = v_org
      and kind = 'other'
      and ref_kind = 'billing_limite'
      and title = v_titulo
      and status = 'open'
  ) then
    insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
    values (
      v_org,
      'other',
      'warn',
      v_titulo,
      'O bloqueio do plano foi ligado para esta instalação. A partir da data acima, criar acima do limite contratado passa a ser recusado; veja Configurações › Plano e uso.',
      'billing_limite',
      v_org
    );
  end if;

  return true;
end;
$$;

comment on function public.fn_billing_dar_carencia(uuid, integer) is
  '0907, decisão 2: dá bloqueio_a_partir_de = now() + p_carencia_dias a UM contrato, só quando a coluna ainda está nula (idempotente por update condicional, sem select prévio: a linha só muda uma vez). Cria o aviso na Central (kind=other, ref_kind=billing_limite, texto fixo com a data), deduplicado por organização + título enquanto status=open. Devolve true só quando gravou de fato, para fn_billing_definir_modo contar organizações afetadas.';

revoke execute on function public.fn_billing_dar_carencia(uuid, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_dar_carencia(uuid, integer) to service_role;

-- ============================================================================
-- 3. fn_billing_definir_modo: o admin liga/desliga o bloqueio pela tela.
-- ============================================================================
create or replace function public.fn_billing_definir_modo(p_modo text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo_anterior text;
  v_carencia_dias integer;
  v_qtd integer := 0;
  v_contract_id uuid;
begin
  if p_modo not in ('desligado', 'avisar', 'bloquear') then
    raise exception 'billing_modo_invalido' using errcode = '22023';
  end if;

  -- for update: duas chamadas concorrentes de fn_billing_definir_modo não
  -- podem ler o mesmo "modo_anterior" nem correr a bulk de carência duas vezes
  -- às cegas (billing_settings é linha única, o lock é barato).
  select modo, carencia_dias into v_modo_anterior, v_carencia_dias
  from public.billing_settings
  where id = 1
  for update;

  update public.billing_settings
    set modo = p_modo
    where id = 1;

  -- Decisão 2: só ao ENTRAR em bloquear é que toda organização SEM data
  -- ganha uma agora. Ao SAIR de bloquear, a linha acima já bastou (as datas
  -- já dadas ficam como estão, fn_billing_dar_carencia não é chamada).
  if p_modo = 'bloquear' then
    for v_contract_id in
      select id from public.billing_contracts where bloqueio_a_partir_de is null
    loop
      if public.fn_billing_dar_carencia(v_contract_id, v_carencia_dias) then
        v_qtd := v_qtd + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'modo_anterior', v_modo_anterior,
    'modo_novo', p_modo,
    'organizacoes_com_carencia', v_qtd
  );
end;
$$;

comment on function public.fn_billing_definir_modo(text, uuid) is
  '0907, decisão 2: grava billing_settings.modo (desligado|avisar|bloquear). Ao entrar em bloquear, dá carência (fn_billing_dar_carencia) a toda organização com bloqueio_a_partir_de nulo e devolve quantas foram afetadas agora. Ao sair de bloquear, não mexe nas datas já dadas. p_actor recebido para a auditoria do chamador (mesmo padrão de p_actor em fn_billing_trocar_plano/fn_billing_ajustar_limites, 0904: não é gravado por esta função). Devolve modo_anterior, modo_novo e organizacoes_com_carencia.';

revoke execute on function public.fn_billing_definir_modo(text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_definir_modo(text, uuid) to service_role;

-- ============================================================================
-- 4. Gatilho NOSSO: organização nova nascida já com o modo em bloquear.
-- ============================================================================
--
-- fn_billing_contrato_da_organizacao_nova (0904) NÃO é editada: este é um
-- gatilho À PARTE, after insert na MESMA tabela (billing_contracts), então
-- roda depois do insert que aquela função faz (e depois do backfill/insert
-- manual de qualquer outro caminho que crie contrato).
create or replace function public.fn_billing_trava_carencia_contrato_novo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_carencia_dias integer;
begin
  select modo, carencia_dias into v_modo, v_carencia_dias
  from public.billing_settings
  where id = 1;

  if v_modo is distinct from 'bloquear' then
    return null;
  end if;

  perform public.fn_billing_dar_carencia(new.id, v_carencia_dias);

  return null;
exception
  when others then
    raise warning 'billing_trava_carencia_contrato_novo_falhou: organizacao=%, sqlerrm=%', new.organization_id, sqlerrm;
    return null;
end;
$$;

comment on function public.fn_billing_trava_carencia_contrato_novo() is
  '0907, decisão 2: after insert em billing_contracts. Com o modo já em bloquear, dá carência ao contrato recém-criado (fn_billing_dar_carencia), sem editar fn_billing_contrato_da_organizacao_nova (0904). Nunca lança (captura qualquer erro): uma falha aqui não pode impedir a criação da organização nem do contrato.';

revoke execute on function public.fn_billing_trava_carencia_contrato_novo() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_carencia_contrato_novo() to service_role;

drop trigger if exists trg_billing_trava_carencia_contrato_novo on public.billing_contracts;
create trigger trg_billing_trava_carencia_contrato_novo
  after insert on public.billing_contracts
  for each row
  execute function public.fn_billing_trava_carencia_contrato_novo();

-- ============================================================================
-- 5. Gatilho NOSSO: troca para plano de teto menor dá carência a partir dela.
-- ============================================================================
--
-- fn_billing_trocar_plano (0904) NÃO é editada: ela grava plan_id por um
-- upsert que sempre lista a coluna no SET (insert ... on conflict do update
-- set plan_id = excluded.plan_id), então "after update of plan_id" dispara
-- mesmo quando o plano final é o MESMO; por isso o corpo confere
-- IS DISTINCT FROM antes de qualquer trabalho.
create or replace function public.fn_billing_trava_carencia_troca_de_plano()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_carencia_dias integer;
  v_limites_antigos jsonb;
  v_limites_novos jsonb;
  v_chave text;
  v_teve_reducao boolean := false;
begin
  select modo, carencia_dias into v_modo, v_carencia_dias
  from public.billing_settings
  where id = 1;

  if v_modo is distinct from 'bloquear' then
    return null;
  end if;

  if new.plan_id is not distinct from old.plan_id then
    return null;
  end if;

  select limits into v_limites_antigos from public.billing_plans where id = old.plan_id;
  select limits into v_limites_novos from public.billing_plans where id = new.plan_id;

  -- "Qualquer item com teto menor" (decisão 2): compara os TETOS DO PLANO
  -- (não os efetivos, que levariam em conta o ajuste manual do admin, fora
  -- do escopo desta comparação). Todo plano tem o conjunto fechado de 7
  -- chaves (billing_plans_limites_completos, 0904), então iterar as chaves
  -- do plano novo cobre as 7. Nulo no plano novo = sem limite, nunca é
  -- "menor" que nada. Nulo no plano ANTIGO (sem limite) virando um número no
  -- plano novo TAMBÉM conta como redução: de ilimitado para limitado é o
  -- caso mais óbvio de teto menor.
  for v_chave in select jsonb_object_keys(v_limites_novos)
  loop
    if (v_limites_novos ->> v_chave) is not null
      and (
        (v_limites_antigos ->> v_chave) is null
        or (v_limites_novos ->> v_chave)::bigint < (v_limites_antigos ->> v_chave)::bigint
      )
    then
      v_teve_reducao := true;
      exit;
    end if;
  end loop;

  if not v_teve_reducao then
    return null;
  end if;

  perform public.fn_billing_dar_carencia(new.id, v_carencia_dias);

  return null;
exception
  when others then
    raise warning 'billing_trava_carencia_troca_de_plano_falhou: organizacao=%, sqlerrm=%', new.organization_id, sqlerrm;
    return null;
end;
$$;

comment on function public.fn_billing_trava_carencia_troca_de_plano() is
  '0907, decisão 2: after update of plan_id em billing_contracts. Compara limits do plano antigo e do novo (qualquer chave com teto menor, inclusive ilimitado virando limitado); havendo redução e o modo em bloquear, dá carência (fn_billing_dar_carencia, idempotente: não atrasa nem antecipa uma carência já dada). fn_billing_trocar_plano (0904) NÃO é editada: o upsert dela sempre lista plan_id no SET, por isso o corpo confere IS DISTINCT FROM antes de qualquer trabalho. Nunca lança.';

revoke execute on function public.fn_billing_trava_carencia_troca_de_plano() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_carencia_troca_de_plano() to service_role;

drop trigger if exists trg_billing_trava_carencia_troca_de_plano on public.billing_contracts;
create trigger trg_billing_trava_carencia_troca_de_plano
  after update of plan_id on public.billing_contracts
  for each row
  execute function public.fn_billing_trava_carencia_troca_de_plano();

-- ============================================================================
-- 6. fn_billing_bloqueia: o veredito de bloqueio de verdade (decisão 3).
-- ============================================================================
--
-- VOLATILE pela mesma razão de fn_billing_pode_criar/fn_billing_conferir_teto
-- (0905): a contagem sob a trava precisa enxergar linhas já commitadas no
-- MESMO comando, não a foto do início dele.
create or replace function public.fn_billing_bloqueia(p_org uuid, p_item text, p_pipeline uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_bloqueio_a_partir_de timestamptz;
  v_teto integer;
  v_resultado jsonb;
begin
  -- Lê o modo ANTES de qualquer outra coisa (decisão 3, "zero custo a
  -- mais"): no modo avisar/desligado, sai sem tocar billing_contracts, sem
  -- ler o teto efetivo e sem pegar lock nenhum.
  select modo into v_modo from public.billing_settings where id = 1;

  if v_modo is distinct from 'bloquear' then
    return false;
  end if;

  select bc.bloqueio_a_partir_de into v_bloqueio_a_partir_de
  from public.billing_contracts bc
  where bc.organization_id = p_org;

  -- Nulo = não bloqueia (decisão 2); data no futuro = ainda em carência.
  if v_bloqueio_a_partir_de is null or v_bloqueio_a_partir_de > now() then
    return false;
  end if;

  v_teto := (public.fn_billing_limites_efetivos(p_org) ->> p_item)::integer;

  -- Organização Ilimitado (ou item sem teto efetivo) nunca bloqueia.
  if v_teto is null then
    return false;
  end if;

  -- MESMA trava bloqueante de fn_billing_conferir_teto (0905), NUNCA a
  -- variante _try_: com _try_, duas criações simultâneas no teto menos um
  -- passariam as duas (cada uma veria "pode" antes de a outra commitar).
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text || ':' || p_item, 0));

  begin
    v_resultado := public.fn_billing_pode_criar(p_org, p_item, p_pipeline);
    return not (v_resultado ->> 'pode')::boolean;
  exception
    when others then
      -- Falha interna LIBERA (nunca bloqueia por acidente): mesma doutrina
      -- de fn_billing_conferir_teto e fn_billing_trava_crm_leads (0905).
      raise warning 'billing_bloqueia_falhou: organizacao=%, item=%, sqlerrm=%', p_org, p_item, sqlerrm;
      return false;
  end;
end;
$$;

comment on function public.fn_billing_bloqueia(uuid, text, uuid) is
  '0907, decisão 3: o veredito de bloqueio de verdade. true só quando modo=bloquear E bloqueio_a_partir_de preenchido e VENCIDO E teto efetivo não nulo E fn_billing_pode_criar diz que não pode. Lê modo, carência e teto ANTES de travar (sai sem lock nenhum em avisar/desligado, sem carência, sem carência vencida ou sem teto). Só então pega pg_advisory_xact_lock BLOQUEANTE pela mesma chave de fn_billing_conferir_teto (billing:<org>:<item>), e a contagem roda dentro de begin/exception que devolve false (raise warning) em qualquer falha interna. Quem chama levanta o PT402 (este código nunca lança).';

revoke execute on function public.fn_billing_bloqueia(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_bloqueia(uuid, text, uuid) to service_role;

-- ============================================================================
-- 7. agent_worker não define modo, não dá carência nem decide bloqueio pelas
-- peças novas desta migration (mesmo racional de todo bloco análogo em
-- 0904/0905/0906): por alter default privileges ela ganharia execute em
-- toda função nova do schema public, e tem bypassrls.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_dar_carencia(uuid, integer), public.fn_billing_definir_modo(text, uuid), public.fn_billing_trava_carencia_contrato_novo(), public.fn_billing_trava_carencia_troca_de_plano(), public.fn_billing_bloqueia(uuid, text, uuid) from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- Parte 2 (Tarefa 2): bloqueio de membros, com as isenções da decisão 4.
-- ============================================================================
--
-- Os dois gatilhos de membros (team_invites, user_organizations) são NOSSOS
-- (nasceram na 0905) e por isso são editados NO LUGAR lá (migration 0905 e o
-- bloco dela no baseline.sql), no mesmo padrão da parte 1 acima: a chamada às
-- quatro funções novas abaixo só é resolvida em tempo de EXECUÇÃO (elas nascem
-- nesta 0907, aplicada depois da 0905), e nenhum insert/update de team_invites
-- ou user_organizations acontece durante a aplicação de migrations.
--
-- Convite (fn_billing_trava_team_invites, decisão 4, item 1): convite novo
-- pendente, ou renovado que volta a pendente, bloqueia igual aos quatro
-- gatilhos da parte 1, sem isenção nenhuma: as isenções abaixo são só para o
-- ACEITE (o momento em que o vínculo em user_organizations vira ativo).
--
-- Vínculo em user_organizations (decisão 4, item 2): a transição para ativo
-- (insert e update, porque a readmissão de revogado passa pelo ramo update de
-- fn_accept_team_invite) é isenta quando qualquer uma das três funções abaixo
-- devolve true. Cada isenção é uma função pequena, testável sozinha:
--
--  1. fn_billing_convite_pendente_do_membro(p_org, p_user): existe convite
--     pendente e válido (accepted_at e revoked_at nulos, expires_at no
--     futuro) para o e-mail deste usuário (auth.users.email x
--     team_invites.email, sem diferença de maiúsculas) nesta organização. O
--     convite já ocupava a vaga: aplicar-convite.ts (lib/auth/aplicar-convite.ts)
--     só marca accepted_at DEPOIS de chamar fn_accept_team_invite, então no
--     instante deste gatilho o convite ainda está pendente. Cobre o aceite
--     comum e a readmissão de um revogado que tinha convite pendente (a rota
--     app/api/v1/team/[user_id]/reactivate/route.ts só faz update de
--     revoked_at, sem tocar invited_by/invited_at: sem esta função, aquela
--     readmissão bloquearia mesmo com convite válido esperando).
--
--  2. fn_billing_veio_de_aceite_de_convite(...): o vínculo nasceu dentro de
--     fn_accept_team_invite mesmo sem linha de convite (token antigo, caso
--     declarado válido em aplicar-convite.ts), sem editar aquela função
--     (proibido). Critério escolhido e provado nesta tarefa: aplicarConvite
--     sempre passa p_invited_at não nulo nas duas chamadas a
--     fn_accept_team_invite (lib/auth/aplicar-convite.ts:
--     "new Date((payload.iat ?? payload.exp - 86400) * 1000)"), com ou sem
--     linha de convite, e é a única escrita de user_organizations.invited_by/
--     invited_at em todo o repositório (só
--     supabase/migrations/20260912010000_0237_criador_provisorio_sai_na_entrega.sql,
--     dentro de fn_accept_team_invite, grava essas duas colunas). Por isso:
--       - em INSERT, invited_by ou invited_at preenchido já é a marca (nem
--         lib/auth/provision.ts, nem fn_create_tenant_with_owner com o ator
--         sendo o próprio dono, gravam qualquer um dos dois: nenhum dos dois
--         passa por fn_accept_team_invite);
--       - em UPDATE (readmissão), compara NOVO x ANTIGO: fn_accept_team_invite
--         reescreve invited_at (e invited_by, por coalesce) a cada aceite, e
--         nenhum outro caminho toca essas colunas depois de gravadas uma vez
--         (a rota de reativação só grava revoked_at/updated_at). Por isso
--         invited_by/invited_at MUDAREM nesta transição é a prova de que ESTA
--         escrita veio do aceite, diferente de checar só "preenchido", que
--         ficaria true para sempre depois do primeiro aceite de alguém,
--         inclusive numa readmissão direta sem convite nenhum anos depois.
--     Na dúvida, esta isenção vale (decisão 4: bloquear o aceite de quem foi
--     convidado é o erro mais caro).
--
--  3. fn_billing_dono_do_provisionamento(p_org, p_user, p_role): o dono do
--     signup self-service (lib/auth/provision.ts, ensureTenantForUser) é quem
--     criou a própria organização (organizations.created_by = user_id) e vira
--     admin dela, sem invited_by/invited_at (não passa pelo aceite). Isento.
--
-- O provisório (provisional_until_handover) nem chega a este ponto do
-- gatilho: v_novo_ativo já é falso para ele (decisão 4, "nunca conta e nunca
-- bloqueia", herdado sem mudança da 0905).
--
-- Decisão 4, último parágrafo ("a mesma isenção vale na checagem de aviso"):
-- no instante do aceite, o convite ainda pendente (accepted_at só é marcado
-- DEPOIS, por aplicar-convite.ts) e o vínculo novo já ativo contam os dois na
-- MESMA chamada de fn_billing_uso/fn_billing_pode_criar, dobrando a conta de
-- um ocupante só. fn_billing_convite_ja_tem_vinculo_ativo(p_invite_id) fecha
-- isso: um convite pendente cujo e-mail já tem vínculo ativo na organização
-- não entra na soma. Usada dentro das duas funções de leitura (fn_billing_uso
-- e fn_billing_pode_criar, parte 1 da migration 0905, editadas NO LUGAR), que
-- continuam contando membro ativo + convite pendente, só que agora sem contar
-- duas vezes o mesmo ocupante no instante do aceite. Não muda o AVISO em si
-- (que continua rodando incondicionalmente a cada transição, herdado da
-- 0905): só a CONTAGEM de que ele depende.
--
-- Mesmo padrão de segurança da parte 1: security definer, search_path fixo,
-- revoke de public/anon/authenticated, grant só para service_role, bloco
-- próprio revogando de agent_worker.

create or replace function public.fn_billing_convite_pendente_do_membro(p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.team_invites ti
    join auth.users au on au.id = p_user
    where ti.organization_id = p_org
      and lower(ti.email) = lower(au.email)
      and ti.accepted_at is null
      and ti.revoked_at is null
      and ti.expires_at > now()
  );
$$;

comment on function public.fn_billing_convite_pendente_do_membro(uuid, uuid) is
  '0907, decisão 4, isenção 1: existe convite pendente e válido para o e-mail deste usuário nesta organização (auth.users.email x team_invites.email, sem diferença de maiúsculas; accepted_at e revoked_at nulos, expires_at no futuro). O convite já ocupava a vaga (aplicar-convite.ts só marca accepted_at DEPOIS do aceite). Cobre o aceite comum e a readmissão de um revogado com convite pendente (a rota de reativação não toca invited_by/invited_at).';

revoke execute on function public.fn_billing_convite_pendente_do_membro(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_convite_pendente_do_membro(uuid, uuid) to service_role;

create or replace function public.fn_billing_veio_de_aceite_de_convite(
  p_invited_by_novo uuid,
  p_invited_at_novo timestamptz,
  p_invited_by_antigo uuid,
  p_invited_at_antigo timestamptz,
  p_insercao boolean
)
returns boolean
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_insercao then p_invited_by_novo is not null or p_invited_at_novo is not null
    else p_invited_by_novo is distinct from p_invited_by_antigo
      or p_invited_at_novo is distinct from p_invited_at_antigo
  end;
$$;

comment on function public.fn_billing_veio_de_aceite_de_convite(uuid, timestamptz, uuid, timestamptz, boolean) is
  '0907, decisão 4, isenção 2: o vínculo nasceu dentro de fn_accept_team_invite mesmo sem linha de convite (token antigo). Critério sem editar fn_accept_team_invite (proibido): ela é a única escrita de user_organizations.invited_by/invited_at do repositório, e aplicarConvite (lib/auth/aplicar-convite.ts) sempre passa p_invited_at não nulo. Em INSERT, invited_by ou invited_at preenchido já é a marca. Em UPDATE (readmissão), compara NOVO x ANTIGO: fn_accept_team_invite reescreve as duas colunas a cada aceite, e nenhum outro caminho as toca depois de gravadas (a reativação por admin só grava revoked_at); checar só "preenchido" ficaria true para sempre depois do primeiro aceite de alguém, inclusive numa readmissão direta sem convite. Na dúvida, isenta (decisão 4).';

revoke execute on function public.fn_billing_veio_de_aceite_de_convite(uuid, timestamptz, uuid, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.fn_billing_veio_de_aceite_de_convite(uuid, timestamptz, uuid, timestamptz, boolean) to service_role;

create or replace function public.fn_billing_dono_do_provisionamento(p_org uuid, p_user uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_role = 'admin' and exists (
    select 1 from public.organizations o
    where o.id = p_org and o.created_by = p_user
  );
$$;

comment on function public.fn_billing_dono_do_provisionamento(uuid, uuid, text) is
  '0907, decisão 4, isenção 3: o dono do signup self-service (lib/auth/provision.ts, ensureTenantForUser) é quem criou a própria organização (organizations.created_by = user_id) e vira admin dela, sem passar por fn_accept_team_invite. Isento.';

revoke execute on function public.fn_billing_dono_do_provisionamento(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_billing_dono_do_provisionamento(uuid, uuid, text) to service_role;

create or replace function public.fn_billing_convite_ja_tem_vinculo_ativo(p_invite_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.team_invites ti
    join public.user_organizations uo on uo.organization_id = ti.organization_id
    join auth.users au on au.id = uo.user_id
    where ti.id = p_invite_id
      and uo.accepted_at is not null
      and uo.revoked_at is null
      and not uo.provisional_until_handover
      and lower(au.email) = lower(ti.email)
  );
$$;

comment on function public.fn_billing_convite_ja_tem_vinculo_ativo(uuid) is
  '0907, decisão 4, último parágrafo: fecha o dobro da contagem no instante do aceite (item 1 do D-053). Um convite pendente cujo e-mail já tem vínculo ativo (accepted_at preenchido, revoked_at nulo, não provisório) na mesma organização não é mais uma vaga em aberto, já virou o membro. Usada dentro de fn_billing_uso e fn_billing_pode_criar (0905, editadas NO LUGAR) para não somar os dois no mesmo instante.';

revoke execute on function public.fn_billing_convite_ja_tem_vinculo_ativo(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_convite_ja_tem_vinculo_ativo(uuid) to service_role;

-- Parte 2: agent_worker não decide isenção de membro nem fecha a contagem
-- dobrada pelas peças novas desta seção (mesmo racional do bloco 7 acima).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_convite_pendente_do_membro(uuid, uuid), public.fn_billing_veio_de_aceite_de_convite(uuid, timestamptz, uuid, timestamptz, boolean), public.fn_billing_dono_do_provisionamento(uuid, uuid, text), public.fn_billing_convite_ja_tem_vinculo_ativo(uuid) from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- Parte 3 (Tarefa 3): fn_billing_ia_pode_responder, o gate de tokens do
-- agente ANTES de responder (decisão 6 da fase).
-- ============================================================================
--
-- Diferença DELIBERADA do texto da decisão 6 do plano da fase
-- (hiperbold/planos/fase-F3-tarefas.md): aquele texto diz que esta função
-- "precisa chamar a concessão" (fn_billing_garantir_concessoes, 0906). O
-- briefing desta tarefa substitui isso: fn_billing_ia_pode_responder é
-- STABLE e NUNCA chama fn_billing_garantir_concessoes, porque aquela função
-- GRAVA (insere linha no livro-caixa e na carteira) e esta função roda a
-- CADA resposta de agente (decisão 6, "uma chamada por resposta"), sem
-- poder ter efeito colateral nenhum no banco. Sem linha de 'plano' no ciclo
-- atual (a concessão preguiçosa que ainda não rodou porque nenhum débito
-- nem leitura de saldo aconteceu neste mês), o teto efetivo de tokens
-- (fn_billing_limites_efetivos(p_org) ->> 'tokens_ia_mes') é contado como
-- se já estivesse creditado, sem gravar nada: nunca bloqueia por falta de
-- linha de concessão. Mesmo racional do "concessao_pendente" de
-- fn_billing_saldo_da_carteira (0906), só que incondicional aqui: esta
-- função nunca tenta pg_try_advisory_xact_lock nem depende de perder uma
-- trava para cair nesse ramo, porque ela nunca trava (é STABLE, não grava).
--
-- Ordem das checagens (decisão 3 da fase, "zero custo a mais"): modo,
-- depois carência, depois teto efetivo, SÓ ENTÃO lê a carteira
-- (billing_token_wallets/billing_token_ledger). Sempre que a resposta já é
-- 'seguir' por um motivo anterior (modo diferente de bloquear, carência
-- nula ou futura, ou plano Ilimitado), "saldo" volta null: a carteira nem
-- chega a ser lida, de propósito, para não gastar uma consulta a mais
-- quando o motivo já está decidido.
--
-- Saldo total do mês: soma plano + adicional do ciclo atual (com o
-- fallback do parágrafo acima quando falta a linha de plano) mais avulso
-- pela PROPORÇÃO DO MÊS, mesma fórmula de "saldo de abertura do mês" de
-- fn_billing_saldo_da_carteira/fn_billing_avisar_carteira (0906): creditado
-- da vida inteira do avulso menos o que já foi consumido em ciclos
-- ANTERIORES a este entra no disponível do mês; o consumo do avulso NESTE
-- ciclo entra no consumido do mês. Sem isso, um pacote avulso grande
-- comprado há meses inflaria o "10% do disponível" de todo mês futuro.
--
-- Limiar de 10% (decisão 6, "avisa antes do gate"): o aviso de 50/80/100%
-- já existe DENTRO da carteira (fn_billing_avisar_carteira, 0906, Central);
-- este é um aviso DIFERENTE, do próprio gate de resposta, para o agente
-- sinalizar ao usuário antes do corte de verdade. Partição exaustiva sobre
-- o saldo total do mês: saldo <= 0 bloqueia; 0 < saldo <= 10% do
-- disponível do mês avisa e segue; saldo > 10% do disponível segue. NOTA
-- (registrada também na resposta desta tarefa): o texto da Tarefa 3
-- descreve a faixa de 'seguir' como "abaixo do limiar de aviso", que bate
-- ao contrário da faixa de 'avisar_e_seguir' ("menor ou igual a 10%"); para
-- as três faixas serem exaustivas e mutuamente exclusivas (todo saldo cai
-- em exatamente uma), implementado aqui como "acima do limiar" para
-- seguir: é a única leitura consistente com o resto do texto.
create or replace function public.fn_billing_ia_pode_responder(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_bloqueio_a_partir_de timestamptz;
  v_ciclo date := public.fn_billing_ciclo_de(now());
  v_teto bigint;
  v_creditado_plano bigint;
  v_consumido_plano bigint;
  v_creditado_adicional bigint;
  v_consumido_adicional bigint;
  v_avulso_creditado_total bigint;
  v_avulso_consumido_antes bigint;
  v_avulso_consumido_mes bigint;
  v_disponivel bigint;
  v_restante bigint;
begin
  select modo into v_modo from public.billing_settings where id = 1;

  if v_modo is distinct from 'bloquear' then
    return jsonb_build_object('acao', 'seguir', 'motivo', 'modo nao bloqueia', 'saldo', null, 'ciclo', v_ciclo);
  end if;

  select bc.bloqueio_a_partir_de into v_bloqueio_a_partir_de
    from public.billing_contracts bc
    where bc.organization_id = p_org;

  if v_bloqueio_a_partir_de is null or v_bloqueio_a_partir_de > now() then
    return jsonb_build_object('acao', 'seguir', 'motivo', 'carencia nao vencida', 'saldo', null, 'ciclo', v_ciclo);
  end if;

  v_teto := (public.fn_billing_limites_efetivos(p_org) ->> 'tokens_ia_mes')::bigint;

  if v_teto is null then
    return jsonb_build_object('acao', 'seguir', 'motivo', 'plano sem teto de tokens', 'saldo', null, 'ciclo', v_ciclo);
  end if;

  -- Só a partir daqui a carteira é lida (decisão 3: zero custo a mais
  -- quando a resposta já saiu antes por modo, carência ou teto).
  select creditado, consumido into v_creditado_plano, v_consumido_plano
    from public.billing_token_wallets
    where organization_id = p_org and fonte = 'plano' and ciclo = v_ciclo;

  if not found then
    -- Decisão 6: nunca bloqueia por falta de linha de concessão. Conta o
    -- teto efetivo como se já estivesse creditado, sem gravar nada (esta
    -- função é STABLE e não chama fn_billing_garantir_concessoes).
    v_creditado_plano := v_teto;
    v_consumido_plano := 0;
  end if;

  select coalesce(sum(creditado), 0), coalesce(sum(consumido), 0)
    into v_creditado_adicional, v_consumido_adicional
    from public.billing_token_wallets
    where organization_id = p_org and fonte = 'adicional' and ciclo = v_ciclo;

  select coalesce(creditado, 0) into v_avulso_creditado_total
    from public.billing_token_wallets
    where organization_id = p_org and fonte = 'avulso' and ciclo is null;

  select coalesce(sum(-tokens), 0) into v_avulso_consumido_antes
    from public.billing_token_ledger
    where organization_id = p_org and fonte = 'avulso' and chave like 'consumo:%'
      and ciclo is not null and ciclo < v_ciclo;

  select coalesce(sum(-tokens), 0) into v_avulso_consumido_mes
    from public.billing_token_ledger
    where organization_id = p_org and fonte = 'avulso' and chave like 'consumo:%' and ciclo = v_ciclo;

  v_disponivel := v_creditado_plano + v_creditado_adicional
    + (coalesce(v_avulso_creditado_total, 0) - v_avulso_consumido_antes);

  v_restante := v_disponivel
    - (v_consumido_plano + v_consumido_adicional + v_avulso_consumido_mes);

  if v_restante <= 0 then
    return jsonb_build_object('acao', 'bloquear', 'motivo', 'saldo de tokens esgotado', 'saldo', v_restante, 'ciclo', v_ciclo);
  end if;

  if v_restante::numeric <= (v_disponivel::numeric * 0.1) then
    return jsonb_build_object('acao', 'avisar_e_seguir', 'motivo', 'saldo de tokens abaixo de 10 por cento do mes', 'saldo', v_restante, 'ciclo', v_ciclo);
  end if;

  return jsonb_build_object('acao', 'seguir', 'motivo', 'saldo de tokens dentro do normal', 'saldo', v_restante, 'ciclo', v_ciclo);
end;
$$;

comment on function public.fn_billing_ia_pode_responder(uuid) is
  '0907, Tarefa 3, decisão 6: gate de tokens do agente ANTES de responder. STABLE, não grava nada (nunca chama fn_billing_garantir_concessoes, que escreve): sem linha de plano no ciclo atual, conta o teto efetivo (fn_billing_limites_efetivos ->> tokens_ia_mes) como creditado, nunca bloqueia por falta de linha. Devolve {"acao": seguir|avisar_e_seguir|bloquear, "motivo": texto curto fixo, "saldo": bigint ou null (null quando a resposta já saiu antes de ler a carteira), "ciclo": date}. Partição pelo saldo total do mês (plano+adicional do ciclo, avulso pela proporção do mês): saldo <= 0 bloqueia; saldo positivo <= 10% do disponível do mês avisa e segue; acima disso segue. Esta função NÃO sabe de quem é a chave nem o propósito da chamada: quem decide SE chama (origemDaChave === chave_da_instalacao, propósito fora de PURPOSES_ISENTOS, modo/variável de ambiente permitindo bloquear) e o que fazer com o resultado é o TypeScript de run-model-call (Tarefa 8), não esta função.';

revoke execute on function public.fn_billing_ia_pode_responder(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_ia_pode_responder(uuid) to service_role;

-- IMPORTANTE, NÃO COPIAR ESTE GRANT PARA OUTRA FUNÇÃO POR REFLEXO: esta
-- função fica DE PROPÓSITO fora de todo bloco de revoke do agent_worker
-- desta migração (blocos das partes 1 e 2, acima) e de qualquer bloco
-- futuro que revogue "toda função nova do schema public" dessa role. O
-- motivo: fn_billing_ia_pode_responder é chamada pelo run-model-call
-- (lib/agent-engine/edge/llm/run-model-call.ts, decisão 6 da fase), que usa
-- o pool de conexão do próprio agent_worker (SUPABASE_DB_URL/DB_URL do
-- worker, não o service_role do servidor Next); é a ÚNICA função desta
-- faixa que o agente precisa executar em nome próprio antes de responder.
-- Confirmado em pg_default_acl (banco local) que o "alter default
-- privileges" do papel dono das migrações já concede este EXECUTE a
-- agent_worker de fábrica (defaclacl com "agent_worker=X" para objtype 'f'
-- no schema public): o grant abaixo é redundante com isso, mas fica
-- EXPLÍCITO de propósito, documentando a intenção e sobrevivendo a uma
-- reforma futura desse default privilege.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'grant execute on function public.fn_billing_ia_pode_responder(uuid) to agent_worker';
  end if;
end
$$;

-- ============================================================================
-- Parte 4 (Tarefa 7, banco): o gatilho de bloqueio em crm_leads.
-- ============================================================================
--
-- Decisão 5 da fase ("leads bloqueiam em TODA origem; o chat nunca para"):
-- toda criação ou reabertura de lead para no teto, venha de onde vier (tela,
-- API, clone, importação, reabertura à mão, MCP, automação, webhook, IA,
-- follow-up, prospecção). O chat ao vivo (mensagem, contato, conversa) NUNCA
-- para: esta parte 4 só mexe em crm_leads; separar a criação do lead da
-- gravação da mensagem/conversa nos caminhos automáticos é a metade de
-- servidor da Tarefa 7, fora do escopo desta migration.
--
-- Nome do gatilho e ordem alfabética dos BEFORE de crm_leads (conferidos no
-- catálogo antes de escrever; nenhum outro BEFORE existe hoje nesta tabela):
--   trg_crm_lead_close_on_stage        (autor, before insert or update of stage_id)
--   trg_crm_leads_billing_bloqueio     (este, novo)
--   trg_crm_leads_updated_at           (before UPDATE só, fn_set_updated_at)
--   trg_stamp_stage_changed_at         (before insert or update, sem coluna)
--   trg_validate_lost_reason_required  (before insert or update of status, lost_reason)
--
-- trg_crm_lead_close_on_stage (fn_crm_lead_close_on_stage, autor, NÃO
-- editado) é quem decide o status FINAL do lead na troca de etapa
-- (won/lost/open): este gatilho precisa rodar DEPOIS dele para enxergar
-- new.status já resolvido. Postgres dispara os triggers BEFORE do mesmo
-- evento em ordem ALFABÉTICA do nome (não da ordem de criação), e o filtro
-- "of stage_id" de trg_crm_lead_close_on_stage não muda isso: em INSERT o
-- filtro de coluna é ignorado (só vale para UPDATE) e aquele gatilho sempre
-- dispara. Comparando byte a byte "trg_crm_lead_close_on_stage" x
-- "trg_crm_leads_billing_bloqueio": os doze caracteres "trg_crm_lead" são
-- iguais, e no 13º caractere "_" (0x5F, do autor, antes de "close") é menor
-- que "s" (0x73, deste, de "leads"), então o autor sempre vem primeiro. Por
-- isso o nome NÃO pode começar com "trg_billing_..." (o "b" de billing é
-- menor que o "c" de crm e faria este gatilho rodar ANTES do autor, vendo o
-- status desatualizado): tem que ficar na família "trg_crm_lead..." e cair
-- depois de "trg_crm_lead_close_on_stage" no alfabeto, daí "trg_crm_leadS_"
-- (o "s" do plural já resolve). A ordem deste gatilho em relação aos outros
-- três BEFORE não importa para o resultado: nenhum deles muda new.status
-- (trg_crm_leads_updated_at só toca updated_at; trg_stamp_stage_changed_at
-- só toca stage_changed_at; trg_validate_lost_reason_required só LÊ
-- new.status para exigir lost_reason quando é 'lost', nunca grava nele).
--
-- Mesmo motivo do gatilho AFTER de leads (fn_billing_trava_crm_leads, 0905,
-- decisão 6) para não usar "of status" aqui também: o autor muda new.status
-- por dentro de OUTRO gatilho (new.status := ... no corpo de
-- fn_crm_lead_close_on_stage), e um filtro de coluna olha a lista SET do
-- comando SQL original, não o que um gatilho anterior alterou na linha; a
-- reabertura por mover de etapa nunca lista "status" no SET, só "stage_id".
-- Por isso este gatilho é "before insert or update" sem lista de colunas,
-- igual a trg_stamp_stage_changed_at.
--
-- Transição vigiada: v_novo_aberto = (new.status = 'open'); v_antigo_aberto
-- = false em INSERT, (old.status = 'open') em UPDATE. Bloqueia só quando
-- v_novo_aberto and not v_antigo_aberto (nasceu aberto, ou voltou de
-- ganho/perdido para aberto). Fechar (aberto -> ganho/perdido) NUNCA
-- bloqueia (libera vaga, não ocupa). Mover entre etapas abertas sem trocar o
-- status (aberto continua aberto) não é transição nenhuma (v_antigo_aberto
-- já era true) e não bloqueia.
--
-- fn_billing_bloqueia(org, 'leads', null) é a MESMA função da decisão 3
-- (parte 1 desta migration): lê modo e carência ANTES de travar (avisar/
-- desligado saem sem lock nenhum, decisão 3, "zero custo a mais"), pega o
-- MESMO pg_advisory_xact_lock bloqueante de fn_billing_conferir_teto/
-- fn_billing_trava_crm_leads (chave 'billing:<org>:leads'), e o veredito
-- roda dentro do begin/exception dela, que libera em qualquer falha interna
-- (raise warning primeiro). O CONTADOR (billing_usage_counters) ainda NÃO
-- somou este lead quando este BEFORE roda: quem soma é o AFTER
-- (fn_billing_trava_crm_leads, 0905), disparado só depois que a linha é de
-- fato escrita. Por isso fn_billing_pode_criar enxerga o valor de ANTES
-- deste lead, e "não pode" quando o contador JÁ ESTÁ no teto é a semântica
-- certa: o N-ésimo lead (contador em teto-1) passa, o N+1-ésimo (contador já
-- em teto) não.
--
-- raise exception FORA de qualquer bloco exception (decisão 3): esta função
-- não tem "exception when others" nenhum, então o raise sempre propaga (e a
-- transação inteira desfaz, inclusive um insert de mensagem/conversa feito
-- ANTES dele na mesma transação sem savepoint: é isso que a metade de
-- servidor da Tarefa 7 precisa separar). fn_billing_bloqueia é quem decide o
-- veredito com segurança (libera em falha interna); este gatilho só levanta
-- o PT402 quando ela diz true.
--
-- Modos avisar/desligado: NADA muda aqui, de propósito nenhuma linha extra
-- de código cuida disso: fn_billing_bloqueia já lê billing_settings.modo
-- ANTES de qualquer trabalho e devolve false direto quando o modo é
-- diferente de 'bloquear' (decisão 3), então o if abaixo nunca levanta
-- PT402 nesses modos, com o mesmo custo de hoje (uma leitura de
-- billing_settings, sem lock).
--
-- Mesmo padrão de segurança das partes 1 a 3: security definer, search_path
-- fixo em public, pg_temp, revoke de public/anon/authenticated, grant só
-- para service_role, bloco final revogando de agent_worker (se existir).
--
-- Idempotente: create or replace, drop trigger if exists antes de recriar.
create or replace function public.fn_billing_bloqueia_crm_leads()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_novo_aberto boolean;
  v_antigo_aberto boolean;
begin
  v_novo_aberto := new.status = 'open';

  if tg_op = 'INSERT' then
    v_antigo_aberto := false;
  else
    v_antigo_aberto := old.status = 'open';
  end if;

  if v_novo_aberto and not v_antigo_aberto then
    if public.fn_billing_bloqueia(new.organization_id, 'leads', null) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'leads';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_bloqueia_crm_leads() is
  '0907, Tarefa 7 (decisão 5): gatilho BEFORE de bloqueio de verdade em crm_leads, na transição para aberto (insert com status open, ou reabertura de won/lost para open). Roda DEPOIS de trg_crm_lead_close_on_stage na ordem alfabética dos BEFORE (ver o cabeçalho desta parte 4 para a conta byte a byte), então enxerga new.status já resolvido pelo autor. Chama fn_billing_bloqueia(org, leads, null) e levanta PT402 FORA de qualquer bloco exception quando ela diz true; o contador de billing_usage_counters ainda não somou este lead (quem soma é o AFTER fn_billing_trava_crm_leads, 0905), então "não pode" no teto exato é a semântica certa (o N-ésimo passa, o N+1-ésimo não). Fechar (aberto -> ganho/perdido) nunca bloqueia. Modos avisar/desligado não mudam nada: fn_billing_bloqueia já lê o modo antes de qualquer lock.';

revoke execute on function public.fn_billing_bloqueia_crm_leads() from public, anon, authenticated;
grant execute on function public.fn_billing_bloqueia_crm_leads() to service_role;

drop trigger if exists trg_crm_leads_billing_bloqueio on public.crm_leads;
create trigger trg_crm_leads_billing_bloqueio
  before insert or update on public.crm_leads
  for each row
  execute function public.fn_billing_bloqueia_crm_leads();

comment on trigger trg_crm_leads_billing_bloqueio on public.crm_leads is
  '0907, Tarefa 7, decisão 5: bloqueio de verdade na transição para aberto. Nome escolhido para rodar DEPOIS de trg_crm_lead_close_on_stage na ordem alfabética dos BEFORE (trg_crm_lead_close_on_stage < trg_crm_leadS_... pelo "_" x "s" no 13º caractere), então já vê new.status final. Sem "of status": o autor muda new.status por dentro de OUTRO gatilho (troca de etapa), e um filtro de coluna olharia o SET do comando original, não isso.';

-- agent_worker não decide bloqueio de leads pela peça nova desta parte 4
-- (mesmo racional dos blocos 7 e 2 acima): por alter default privileges ela
-- ganharia execute em toda função nova do schema public, e tem bypassrls.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_bloqueia_crm_leads() from agent_worker';
  end if;
end
$$;
