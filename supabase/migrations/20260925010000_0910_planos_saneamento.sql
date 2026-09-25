-- 0910, saneamento do módulo de planos (fase F7, lote 1, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F7-tarefas.md e nas entradas D-069, D-070, D-060,
-- D-047, D-055 e D-068 de hiperbold/DEBITO.md. D-070 e D-060 NÃO mudam nada
-- nesta migration (justificativa na PARTE 4, abaixo, sem instrução SQL). D-068
-- é só prova de banco (roteiro fora desta migration, em transação com
-- rollback no banco local de desenvolvimento); nenhuma linha de SQL aqui.
--
-- Mesmo padrão de segurança das migrations anteriores da faixa (0904 a 0909):
-- security definer, search_path fixo em public, pg_temp, revoke de
-- public/anon/authenticated, grant só para service_role, bloco final
-- revogando de agent_worker (se a role existir) o acesso às peças novas: essa
-- role tem bypassrls e ganharia tudo por privilégio padrão (alter default
-- privileges) se não fosse revogado explicitamente.
--
-- Idempotente: revoke/grant são repetíveis por natureza (revogar um
-- privilégio que já não existe não é erro), create table if not exists,
-- create or replace function, drop trigger if exists + create trigger.

-- ============================================================================
-- PARTE 1 (D-069, achado da auditoria da F5): billing_payments e
-- billing_contracts só escritos pelas funções, não mais pelo service_role
-- direto.
-- ============================================================================
--
-- Achado: `grant select, insert on billing_payments to service_role`
-- (decisão 1 da 0908, "SÓ DE ACRÉSCIMO, para QUALQUER escritor") e
-- `grant all on billing_contracts to service_role` (0904, "service_role
-- mantém acesso total") deixam o INSERT de billing_payments e o INSERT,
-- UPDATE e DELETE de billing_contracts abertos a QUALQUER código que use o
-- cliente de serviço, por fora de fn_billing_registrar_pagamento,
-- fn_billing_estornar_pagamento, fn_billing_mudar_estado etc., que são
-- security definer, dono postgres, e por isso nunca dependeram desse grant
-- para escrever (a ação roda com o privilégio do DONO da função, não do
-- papel que a chamou).
--
-- Levantamento (grep em lib/, app/, workers/, scripts/, supabase/, nenhum
-- desses três diretórios de workers/scripts existe neste repo hoje):
--
--   - Nenhum `.insert(`/`.update(`/`.delete(`/`.upsert(` em
--     `.from("billing_payments")` fora das migrações: todo uso em TS é
--     `.select(...)` (lib/billing/assinatura/estado-da-assinatura.ts,
--     lib/billing/asaas/leitura.ts, lib/billing/asaas/processar-eventos.ts).
--     INSERT revogado do service_role sem achado pendente.
--
--   - `billing_contracts`: um caminho real usa UPDATE direto com o cliente
--     de serviço: `app/actions/admin/planoDaOrganizacao.ts`
--     (`estenderCarenciaDaOrganizacao`), grava só a coluna
--     `bloqueio_a_partir_de` (concorrência resolvida por
--     `.eq("bloqueio_a_partir_de", antes)`, comentário "achado médio 3-a").
--     UPDATE NÃO É REVOGADO aqui: revogar quebraria essa tela hoje. Fica
--     registrado para o Filipe decidir se essa escrita deve migrar para uma
--     função `security definer` (padrão do resto do módulo) numa fase
--     futura; nenhum outro caminho usa INSERT/DELETE/TRUNCATE diretos, e os
--     três são revogados abaixo. DELETE inclui a cascata de apagar
--     organização: a ação referencial (ON DELETE CASCADE) roda com o
--     privilégio do DONO da tabela, não do papel que disparou o DELETE em
--     organizations (mesmo racional do comentário de billing_payments:
--     "apagar o usuário não pode travar o registro"), então revogar DELETE
--     do service_role não quebra a exclusão de organização nem o gatilho
--     `trg_billing_protege_assinatura_asaas` (0909) que a protege; só fecha o
--     caminho de apagar o CONTRATO direto por fora da cascata.
--
-- Prova de banco (idempotência e recusa): tests/invariants/planos-saneamento.test.ts.
-- Prova de que a cascata de organização não depende do grant revogado:
-- tests/invariants/planos-asaas.test.ts, describe "trg_billing_protege_assinatura_asaas".

revoke insert on public.billing_payments from service_role;

comment on table public.billing_payments is
  '0908, decisão 1: pagamentos registrados NA MÃO (N24), no molde do manual comum (hiper-track/docs/manual-api-asaas-saas.md). SÓ DE ACRÉSCIMO: ninguém tem update, delete nem truncate, nem o service_role (ver grants). Estorno é uma linha NOVA (status=REFUNDED), nunca uma edição da linha original. Duplicidade de período é conferida DENTRO de fn_billing_registrar_pagamento, não por índice (a F5 precisa aceitar estorno seguido de novo pagamento do mesmo período). Correção (0910, fase F7, D-069): INSERT também revogado do service_role, nenhum caminho em TypeScript escreve direto nesta tabela; toda escrita passa por fn_billing_registrar_pagamento, fn_billing_estornar_pagamento e pelas funções do Asaas (todas security definer, dono postgres, que nunca dependeram deste grant).';

revoke insert, delete, truncate on public.billing_contracts from service_role;

comment on table public.billing_contracts is
  'A assinatura da organização: uma linha só, unique(organization_id). Aponta para a VERSÃO do plano (plan_id), não para o code: preço e tetos contratados ficam congelados mesmo se o plano ganhar versão nova. Histórico de troca fica na auditoria (app/actions/admin), não nesta tabela. Correção (0910, fase F7, D-069): INSERT, DELETE e TRUNCATE revogados do service_role: só as funções (security definer, dono postgres) criam e mudam de estado. EXCEÇÃO DELIBERADA: UPDATE continua concedido, porque app/actions/admin/planoDaOrganizacao.ts (estenderCarenciaDaOrganizacao) grava bloqueio_a_partir_de direto com o cliente de serviço; revogar quebraria essa tela hoje. Decisão registrada em D-069 (hiperbold/DEBITO.md) para o Filipe avaliar mover essa escrita para uma função dedicada numa fase futura.';

-- ============================================================================
-- PARTE 2 (D-047, achado da auditoria da F1): revoga TRUNCATE de anon e
-- authenticated em todo o schema public, inclusive tabela futura.
-- ============================================================================
--
-- TRUNCATE passa por cima da RLS (mesmo racional do comentário da 0904, item
-- 12: "revogar só insert, update e delete deixava truncate, references e
-- trigger, que vêm no grant padrão do Supabase; e truncate passa por cima da
-- RLS"). O PostgREST não emite TRUNCATE (D-047: "hoje não há caminho de
-- exploração"), e o grep em lib/, app/, workers/, scripts/ não achou nenhum
-- uso de TRUNCATE em código do produto: a palavra só aparece em CSS
-- (`truncate` do Tailwind), truncamento de string e comentário. O risco é
-- futuro: uma função `security invoker` que aceitasse nome de tabela abriria
-- a porta. `alter default privileges for role postgres` cobre toda tabela
-- CRIADA DEPOIS desta migration (mesmo padrão de
-- hiperbold/scripts/role-agent-worker.sql para agent_worker): sem isso, o
-- default ACL do Supabase (que concede `arwdDxt`, incluindo o `D` de
-- TRUNCATE, a anon/authenticated em toda tabela nova) reabriria o mesmo
-- buraco na primeira tabela criada por uma migração futura.
--
-- Prova de banco (idempotência e recusa, inclusive numa tabela criada DEPOIS
-- desta migration dentro do próprio teste): tests/invariants/planos-saneamento.test.ts.

revoke truncate on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- ============================================================================
-- PARTE 3 (D-055, achado da auditoria da F2): o gatilho de leads deixa
-- rastro consultável quando o upsert do contador falha.
-- ============================================================================
--
-- Hoje fn_billing_trava_crm_leads (0905) só faz `raise warning` quando o
-- upsert de billing_usage_counters falha (lock_timeout de 4s da sessão
-- authenticated numa disputa pela linha, por exemplo): o lead nasce (decisão
-- 6, "o chat nunca para" continua valendo, comportamento preservado), mas
-- ninguém fica sabendo que aconteceu fora do log do Postgres: o conferidor
-- diário (fn_billing_conferir_contador) corrige o contador no dia seguinte,
-- só isso não avisa ninguém.
--
-- billing_trigger_alarmes é o rastro CONSULTÁVEL (padrão que o módulo já usa
-- para alarme legível: asaas_webhook_events.alarme, 0909, filtrado pela tela
-- do admin com "where alarme is not null"). Tabela nova, escopo mínimo (só
-- esta falha por ora; generalizar para outros gatilhos "trava_*" que também
-- só fazem raise warning não é pedido por D-055 e fica fora desta migration).
-- SÓ DE ACRÉSCIMO, mesmo desenho de billing_contract_eventos: RLS ligada,
-- ZERO policy, service_role só select+insert, sem update/delete/truncate
-- nem para o service_role.

create table if not exists public.billing_trigger_alarmes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  gatilho text not null,
  falha text not null,
  criado_em timestamptz not null default now()
);

comment on table public.billing_trigger_alarmes is
  '0910, fase F7, D-055: rastro CONSULTÁVEL de falha engolida por um gatilho de plano que hoje só faz raise warning (fn_billing_trava_crm_leads, 0905, upsert de billing_usage_counters). Escopo mínimo: só este gatilho grava aqui por ora. SÓ DE ACRÉSCIMO: ninguém tem update, delete nem truncate, nem o service_role. A escrita nunca derruba a operação original (o insert é feito dentro de um bloco exception PRÓPRIO, que também vira raise warning se falhar).';
comment on column public.billing_trigger_alarmes.gatilho is
  '0910: nome da função de gatilho que engoliu o erro (ex.: fn_billing_trava_crm_leads), para o admin filtrar por origem.';
comment on column public.billing_trigger_alarmes.falha is
  '0910: sqlerrm capturado no bloco exception do gatilho, mesmo texto que hoje só ia para raise warning.';

create index if not exists billing_trigger_alarmes_org_idx
  on public.billing_trigger_alarmes (organization_id, criado_em desc);

alter table public.billing_trigger_alarmes enable row level security;

revoke all on public.billing_trigger_alarmes from anon, authenticated;
grant select, insert on public.billing_trigger_alarmes to service_role;
revoke update, delete, truncate on public.billing_trigger_alarmes from service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.billing_trigger_alarmes from agent_worker';
  end if;
end
$$;

-- Redefinição (última definição vale, CLAUDE.md item 10) de
-- fn_billing_trava_crm_leads (0905): corpo IDÊNTICO, só o bloco exception
-- ganha a gravação do alarme. v_org já está atribuído em toda entrada da
-- função (INSERT/UPDATE/DELETE, ver as duas primeiras linhas do corpo), por
-- isso está disponível aqui mesmo quando o erro acontece dentro do próprio
-- upsert. A gravação do alarme roda dentro do SEU PRÓPRIO bloco
-- exception: uma falha ao gravar o alarme (ex.: billing_trigger_alarmes
-- indisponível) vira só mais um raise warning, nunca propaga e nunca
-- impede o lead de nascer, o mesmo comportamento de hoje, decisão 6.
create or replace function public.fn_billing_trava_crm_leads()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_status_antigo text;
  v_status_novo text;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_status_antigo := old.status;
    v_status_novo := null;
  else
    v_org := new.organization_id;
    v_status_novo := new.status;
    v_status_antigo := case when tg_op = 'UPDATE' then old.status else null end;
  end if;

  if v_status_antigo is not distinct from v_status_novo then
    return null;
  end if;

  if v_status_novo = 'open' and v_status_antigo is distinct from 'open' then
    if not public.fn_billing_bloqueio_ativo(v_org) then
      perform public.fn_billing_conferir_teto(v_org, 'leads', null);

      insert into public.billing_usage_counters (organization_id, item, valor)
      values (v_org, 'leads', 1)
      on conflict (organization_id, item) do update
        set valor = public.billing_usage_counters.valor + 1,
            updated_at = now();
    end if;
  elsif v_status_antigo = 'open' and v_status_novo is distinct from 'open' then
    update public.billing_usage_counters
      set valor = greatest(valor - 1, 0),
          updated_at = now()
      where organization_id = v_org and item = 'leads';
  end if;

  return null;
exception
  when others then
    raise warning 'billing_trava_crm_leads_falhou: organizacao=%, sqlerrm=%', v_org, sqlerrm;
    begin
      if v_org is not null then
        insert into public.billing_trigger_alarmes (organization_id, gatilho, falha)
        values (v_org, 'fn_billing_trava_crm_leads', sqlerrm);
      end if;
    exception
      when others then
        raise warning 'billing_trava_crm_leads_alarme_falhou: organizacao=%, sqlerrm=%', v_org, sqlerrm;
    end;
    return null;
end;
$$;

comment on function public.fn_billing_trava_crm_leads() is
  'Gatilho de plano (Tarefa 3, decisão 6): after insert/update/delete SEM lista de colunas em crm_leads, porque trg_crm_lead_close_on_stage (before, do autor) muda o status na troca de etapa e um gatilho com lista de colunas não veria essa mudança; só o valor final da linha resolve. Revisão pós-auditoria da F3 (achado médio 1): a soma da transição PARA aberto só acontece AQUI quando fn_billing_bloqueio_ativo(organizacao) é falso (avisar, desligado, ou dentro da carência), exatamente o comportamento de ANTES da correção A1. Com o bloqueio ativo, quem soma é o BEFORE (fn_billing_bloqueia_crm_leads, 0907), linha a linha, porque só ali existe o defeito do A1 (lote passando do teto). Fechamento (aberto -> ganho/perdido) e exclusão sempre subtraem AQUI (greatest(valor - 1, 0)), nos dois casos, nunca recriando a linha (decisão 11, exclusão em cascata de organização). Captura qualquer erro (decisão 11): o lead SEMPRE nasce/fecha, o chat nunca para. Correção (0910, fase F7, D-055): a falha engolida agora também grava um rastro consultável em billing_trigger_alarmes, dentro do seu próprio bloco exception (uma falha ao gravar o alarme não impede o lead de nascer, mesmo comportamento de hoje).';

revoke execute on function public.fn_billing_trava_crm_leads() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_crm_leads() to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_trava_crm_leads() from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- PARTE 4 (D-070 e D-060, achados da auditoria de segurança): SEM MUDANÇA DE
-- SQL. Justificativa para o Filipe fechar as duas entradas.
-- ============================================================================
--
-- D-070: fn_billing_modo_leitura, fn_billing_limites_efetivos e
-- fn_billing_ia_pode_responder aceitam qualquer p_org de quem pode
-- executá-las, sem conferir vínculo com a organização informada.
--
-- D-060: fn_billing_ia_pode_responder devolve o SALDO numérico (não só a
-- ação) de qualquer p_org.
--
-- Levantamento (catálogo do banco local, information_schema.role_routine_
-- grants): as ÚNICAS roles com EXECUTE nas três funções são postgres,
-- service_role e agent_worker, nenhuma outra (anon/authenticated já
-- revogadas nas migrations de origem). pg_roles.rolbypassrls das três:
--
--   postgres       | rolbypassrls = true
--   service_role   | rolbypassrls = true
--   agent_worker   | rolbypassrls = true
--
-- As três já leem qualquer organização por QUALQUER outro caminho (bypassrls
-- ignora toda policy de RLS em toda tabela do banco): restringir p_org nestas
-- três funções, ou esconder o saldo de fn_billing_ia_pode_responder, não
-- fecha nenhum vetor de leitura entre organizações: o mesmo chamador
-- consultaria a tabela direto. Não há decisão de produto pendente aqui: as
-- duas entradas descrevem alargamento de privilégio de um ator que já tem o
-- dado por construção, não vazamento para um ator sem acesso.
--
-- Prova de banco (rolbypassrls das três roles, para o gate travar se algum
-- dia uma role SEM bypassrls ganhar EXECUTE): tests/invariants/planos-saneamento.test.ts.
