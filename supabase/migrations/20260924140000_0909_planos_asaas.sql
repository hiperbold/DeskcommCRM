-- 0909, cobrança pelo Asaas: tabelas (fase F5, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F5-tarefas.md, decisões 4 a 12, 22 e 25, e nas
-- decisões 1 a 27 do plano mestre (hiperbold/planos/2026-09-22-planos-e-
-- assinatura.md). Contrato comum: F:\github-projects\hiper-track\docs\manual-
-- api-asaas-saas.md.
--
-- Esta migration (0909) traz só as Tarefas 1 e 2 da fase: o SCHEMA (tabelas,
-- colunas, checks, índices) e o gatilho/grants das três tabelas novas. As
-- funções que escrevem nessas tabelas (pedido, cliente, webhook, aplicação de
-- pagamento/estorno/fim de assinatura) são das Tarefas 3 em diante, fora
-- desta migration. Nenhuma chamada real ao Asaas acontece aqui nem em nenhuma
-- parte desta fase (restrição fixa 1 do plano da fase).
--
-- Mesmo padrão de segurança das migrations anteriores da faixa (0904 a
-- 0908): security definer, search_path fixo em public, pg_temp, revoke de
-- public/anon/authenticated, grant só para service_role, bloco final
-- revogando de agent_worker (se a role existir) o acesso às peças novas:
-- essa role tem bypassrls e ganharia tudo por privilégio padrão
-- (alter default privileges) se não fosse revogado explicitamente.
--
-- Idempotente: create table if not exists, add column if not exists, drop
-- constraint if exists + add constraint, drop index if exists + create index
-- if not exists, drop trigger if exists + create trigger, bloco de
-- agent_worker condicional à existência da role. Lógica de três valores:
-- coalesce em toda condição booleana que envolve coluna nula.

-- ============================================================================
-- PARTE 1 (Tarefa 1): tabelas e colunas.
-- ============================================================================

-- ── 1. billing_customers: o vínculo organização <-> cliente Asaas ──
--
-- Decisão 16 do plano da fase: nome, CPF/CNPJ, e-mail e celular do pagador
-- vão só ao POST /customers do Asaas; esta tabela guarda só o id que o Asaas
-- devolveu (asaas_customer_id) e o ambiente, nunca o dado da pessoa. Uma
-- linha por organização e por ambiente (sandbox e produção nunca dividem
-- cliente): dois cadastros na mesma organização e no mesmo ambiente seriam
-- vínculo ambíguo para fn_billing_vincular_cliente_asaas (Tarefa 3) decidir
-- qual usar. O segundo único, (ambiente, asaas_customer_id), impede o MESMO
-- cliente do Asaas ficar vinculado a duas organizações no mesmo ambiente:
-- decisão 6 do plano da fase depende disso para nunca confirmar um pagamento
-- de organização errada por cliente compartilhado.
create table if not exists public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ambiente text not null,
  asaas_customer_id text not null,
  -- Sem chave estrangeira, de propósito (mesmo racional de billing_payments.
  -- criado_por, 0908): apagar o usuário não pode travar o vínculo do cliente.
  criado_por uuid,
  created_at timestamptz not null default now(),
  constraint billing_customers_ambiente_check check (ambiente in ('sandbox', 'producao')),
  constraint billing_customers_asaas_customer_id_formato check (asaas_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  constraint billing_customers_organization_ambiente_unique unique (organization_id, ambiente),
  constraint billing_customers_ambiente_asaas_customer_id_unique unique (ambiente, asaas_customer_id)
);

comment on table public.billing_customers is
  '0909, Tarefa 1: vínculo organização <-> cliente do Asaas (id que POST /customers devolveu). NUNCA guarda nome, CPF/CNPJ, e-mail nem celular do pagador (decisão 16 da fase F5): esses dados vão só ao Asaas. Uma linha por (organization_id, ambiente); o segundo único, (ambiente, asaas_customer_id), impede o MESMO cliente Asaas ficar vinculado a duas organizações no mesmo ambiente (decisão 6). Escrita só por fn_billing_vincular_cliente_asaas (Tarefa 3, fora desta migration).';
comment on column public.billing_customers.ambiente is
  '0909: sandbox ou producao. O par (organization_id, ambiente) é único: sandbox e produção nunca compartilham cliente Asaas.';

-- ── 2. billing_orders: o pedido de compra, ponte entre o CRM e o Asaas ──
--
-- Decisão 25 do plano da fase (posse atômica): status ganha 'processando',
-- e o índice único parcial de pedido aberto (decisão 11) inclui esse status:
-- é ele que impede duas chamadas simultâneas de iniciarCompra (Tarefa 14,
-- fora desta migration) fazerem duas chamadas ao Asaas para o mesmo pedido.
-- external_reference é COLUNA GERADA ('HC:ord:' || id), nunca escrita à mão:
-- é o valor que viaja no externalReference do Asaas (decisão 6) e volta no
-- webhook para o roteamento. tokens e plan_id/ciclo são FOTOS congeladas na
-- criação do pedido (mesmo racional de billing_contracts.plan_id apontar
-- para a VERSÃO, não o code): o catálogo pode mudar depois sem alterar o que
-- já foi pedido.
create table if not exists public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ambiente text not null,
  tipo text not null,
  -- plan_id/ciclo só para tipo=assinatura; pacote_id/tokens só para
  -- tipo=pacote_tokens (checks de coerência abaixo). Sem "on delete" (mesmo
  -- padrão de billing_contracts.plan_id, 0904): plano e pacote nunca são
  -- apagados, só desativados.
  plan_id uuid references public.billing_plans(id),
  ciclo text,
  pacote_id uuid references public.billing_token_pacotes(id),
  tokens bigint,
  metodo text not null,
  amount_cents integer not null,
  status text not null default 'criado',
  -- Coluna GERADA: nunca escrita à mão, sempre 'HC:ord:' || o próprio id.
  -- Viaja no externalReference do POST ao Asaas (decisão 6) e volta no
  -- webhook para o pré-roteamento sem GET (decisão 6 do plano da fase).
  external_reference text generated always as ('HC:ord:' || id::text) stored,
  asaas_payment_id text,
  asaas_subscription_id text,
  invoice_url text,
  -- uuid do FORMULÁRIO, a peça de idempotência de fn_billing_criar_pedido
  -- (Tarefa 3), mesmo papel de billing_payments.chave (0908).
  chave uuid not null,
  criado_por uuid,
  pago_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_orders_ambiente_check check (ambiente in ('sandbox', 'producao')),
  constraint billing_orders_tipo_check check (tipo in ('assinatura', 'pacote_tokens')),
  constraint billing_orders_metodo_check check (metodo in ('CREDIT_CARD', 'PIX')),
  constraint billing_orders_ciclo_check check (ciclo is null or ciclo in ('monthly', 'yearly')),
  constraint billing_orders_amount_cents_positivo check (amount_cents > 0),
  constraint billing_orders_status_check check (
    status in ('criado', 'processando', 'aguardando_pagamento', 'inconclusivo', 'pago', 'vencido', 'cancelado', 'falhou', 'estornado')
  ),
  -- Checks de coerência por tipo (decisão 2 do plano da fase): um pedido de
  -- assinatura carrega plano/ciclo e NUNCA pacote/tokens, e vice-versa.
  constraint billing_orders_coerencia_assinatura check (
    tipo <> 'assinatura' or (plan_id is not null and ciclo is not null and pacote_id is null and tokens is null)
  ),
  constraint billing_orders_coerencia_pacote check (
    tipo <> 'pacote_tokens' or (pacote_id is not null and tokens is not null and plan_id is null and ciclo is null)
  ),
  constraint billing_orders_external_reference_unique unique (external_reference),
  -- Decisão 11 do plano da fase (idempotência em três camadas): a chave do
  -- FORMULÁRIO é única por organização, mesmo papel de billing_payments.chave
  -- (0908).
  constraint billing_orders_organization_chave_unique unique (organization_id, chave)
);

comment on table public.billing_orders is
  '0909, Tarefa 1: o pedido de compra (assinatura ou pacote de tokens), ponte entre o CRM e o Asaas. external_reference é coluna GERADA (HC:ord:<id>), nunca escrita à mão. status ganha processando (decisão 25, posse atômica): fn_billing_pedido_tomar (Tarefa 3, fora desta migration) é quem transiciona criado/inconclusivo -> processando antes do POST ao Asaas. Escrita só por funções da Tarefa 3 (fora desta migration).';
comment on column public.billing_orders.status is
  '0909, decisão 25: processando é o estado de POSSE ATÔMICA (fn_billing_pedido_tomar toma a linha antes de chamar o Asaas; quem não ganha o update só lê o estado atual). Entra no índice único parcial de pedido aberto (billing_orders_aberto_por_tipo_unique, abaixo) junto com criado/aguardando_pagamento/inconclusivo.';
comment on column public.billing_orders.tokens is
  '0909: fotografia dos tokens do pacote NO MOMENTO do pedido (billing_token_pacotes pode mudar depois). Só preenchido quando tipo=pacote_tokens (check billing_orders_coerencia_pacote).';

create unique index if not exists billing_orders_asaas_payment_id_unique
  on public.billing_orders (asaas_payment_id)
  where asaas_payment_id is not null;

create unique index if not exists billing_orders_asaas_subscription_id_unique
  on public.billing_orders (asaas_subscription_id)
  where asaas_subscription_id is not null;

create unique index if not exists billing_orders_invoice_url_unique
  on public.billing_orders (invoice_url)
  where invoice_url is not null;

-- Decisão 11 do plano da fase: um pedido ABERTO por organização e por tipo.
-- Decisão 25: 'processando' entra na lista (posse atômica não pode conviver
-- com um segundo pedido aberto do mesmo tipo).
create unique index if not exists billing_orders_aberto_por_tipo_unique
  on public.billing_orders (organization_id, tipo)
  where status in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando');

drop trigger if exists trg_billing_orders_updated_at on public.billing_orders;
create trigger trg_billing_orders_updated_at
  before update on public.billing_orders
  for each row execute function public.fn_set_updated_at();

-- ── 3. asaas_webhook_events: o registro durável do webhook ──
--
-- Decisão 19 do plano da fase: o webhook só guarda e responde 200; quem
-- aplica é o processador (Tarefa 4, fora desta migration), por cron.
-- Decisão 20 (processamento durável, lease): lease_token/lease_expira_em são
-- devolvidos pela reserva (fn_billing_asaas_reservar_eventos) e conferidos
-- por fn_billing_asaas_aplicar_evento antes de gravar: evento cujo lease
-- expirou não grava mais nada, mesmo que a chamada externa volte depois.
-- organization_id SEM chave estrangeira, de propósito (mesmo racional de
-- billing_payments.criado_por, 0908): o roteamento (decisão 6) pode não
-- achar organização nenhuma (sem_vinculo), e o valor aqui é só para a tela do
-- admin filtrar, nunca uma FK de integridade.
create table if not exists public.asaas_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  event_type text not null,
  resource_id text,
  ambiente text not null,
  origem text not null default 'webhook',
  payload jsonb not null,
  recebido_em timestamptz not null default now(),
  processado_em timestamptz,
  resultado text not null default 'aguardando',
  tentativas integer not null default 0,
  proxima_tentativa_em timestamptz,
  erro_codigo text,
  organization_id uuid,
  payload_podado_em timestamptz,
  lease_token uuid,
  lease_expira_em timestamptz,
  constraint asaas_webhook_events_event_id_unique unique (event_id),
  constraint asaas_webhook_events_event_id_tamanho check (char_length(event_id) between 1 and 100),
  constraint asaas_webhook_events_event_type_formato check (event_type ~ '^[A-Z_]{3,64}$'),
  constraint asaas_webhook_events_ambiente_check check (ambiente in ('sandbox', 'producao')),
  constraint asaas_webhook_events_origem_check check (origem in ('webhook', 'conciliacao')),
  constraint asaas_webhook_events_resultado_check check (
    resultado in ('aplicado', 'ja_aplicado', 'ignorado', 'outro_app', 'sem_vinculo', 'divergente', 'aguardando', 'erro')
  ),
  constraint asaas_webhook_events_tentativas_nao_negativo check (tentativas >= 0),
  constraint asaas_webhook_events_erro_codigo_tamanho check (erro_codigo is null or char_length(erro_codigo) <= 200)
);

comment on table public.asaas_webhook_events is
  '0909, Tarefa 1: registro durável de todo evento do webhook do Asaas (e dos eventos sintéticos conc:<id>:<status> da conciliação diária, decisão 21). O webhook só GUARDA e responde 200 (decisão 19); quem aplica é o processador por cron (Tarefa 4, fora desta migration). organization_id SEM chave estrangeira, de propósito: o roteamento (decisão 6) pode não achar organização nenhuma.';
comment on column public.asaas_webhook_events.lease_token is
  '0909, decisão 20 (processamento durável): devolvido por fn_billing_asaas_reservar_eventos junto com cada evento reservado (Tarefa 4, fora desta migration). fn_billing_asaas_aplicar_evento recusa gravar se este token não for mais o dono do evento (lease expirado).';
comment on column public.asaas_webhook_events.payload_podado_em is
  '0909, decisão 21 (N38): marcado quando o payload vira {} depois de 180 dias (fn_billing_asaas_podar_eventos, Tarefa 4, fora desta migration). Nulo enquanto o payload original ainda existe.';

-- Índice dos pendentes: é aqui que a reserva com lease (decisão 20) e o
-- "for update skip locked" do processador (Tarefa 4) fazem a varredura.
create index if not exists asaas_webhook_events_pendentes_idx
  on public.asaas_webhook_events (proxima_tentativa_em)
  where resultado = 'aguardando';

-- ── 4. billing_contracts ganha o marcador de assinatura Asaas encerrada ──
--
-- Decisão 22 do plano da fase: gravado quando SUBSCRIPTION_DELETED é
-- confirmado, quando o GET devolve 404/deleted:true confirmado, ou quando o
-- DELETE feito pelo próprio CRM dá certo (Tarefa 6, fora desta migration).
-- billing_ja_tem_assinatura_asaas (Tarefa 3) só considera assinatura SEM
-- este marcador. A trava de delete (Parte 2, abaixo) confere este marcador,
-- não o status.
alter table public.billing_contracts add column if not exists asaas_assinatura_encerrada_em timestamptz;

comment on column public.billing_contracts.asaas_assinatura_encerrada_em is
  '0909, decisão 22: gravado quando SUBSCRIPTION_DELETED é confirmado por GET, quando o GET devolve 404/deleted:true confirmado, ou quando o DELETE feito pelo próprio CRM dá certo (Tarefa 6, fora desta migration). Nulo enquanto a assinatura Asaas (se houver) segue ativa. trg_billing_protege_assinatura_asaas (Parte 2, abaixo) recusa apagar o contrato quando asaas_subscription_id está preenchido e este marcador está nulo.';

-- ── 5. billing_payments: origem, order_id, vocabulário de status ampliado,
-- período nulo condicional e estorno restrito a REFUNDED ──
--
-- Decisão 8 do plano da fase: todo pagamento confirmado pelo Asaas grava
-- origem='asaas' e order_id apontando para o pedido. order_id referencia
-- billing_orders com ON DELETE SET NULL (não cascade, ao contrário de
-- contract_id): billing_payments é SÓ DE ACRÉSCIMO (0908) e o histórico de
-- pagamento não pode desaparecer se, por algum caminho fora do produto hoje,
-- um pedido for apagado, o pagamento fica órfão de pedido, nunca órfão de
-- existir.
alter table public.billing_payments add column if not exists order_id uuid references public.billing_orders(id) on delete set null;
alter table public.billing_payments add column if not exists origem text not null default 'manual';

comment on column public.billing_payments.order_id is
  '0909, decisão 8: aponta para o pedido (billing_orders) quando origem=asaas. ON DELETE SET NULL, não cascade (billing_payments é SÓ DE ACRÉSCIMO, 0908): o histórico de pagamento sobrevive mesmo se o pedido, por algum caminho fora do produto hoje, deixar de existir.';
comment on column public.billing_payments.origem is
  '0909, decisão 8: manual (registrado na mão, 0908, N24) ou asaas (confirmado pelo gateway, fase F5). Governa o CHECK de período nulo (billing_payments_periodo_check, abaixo) e a exigência de fn_billing_estornar_pagamento (Tarefa 3+, decisão 23) de só estornar linha origem=manual.';

-- CHECK de status recriado (add constraint não é idempotente: drop + add,
-- mesmo padrão de toda constraint reconstruída neste repositório). Vocabulário
-- ampliado (decisão 8/9 do plano da fase): CONFIRMED e RECEIVED entram como
-- estados INTERMEDIÁRIOS possíveis do pagamento Asaas (o manual do Asaas
-- devolve um dos dois antes do pagamento estar definitivamente liquidado);
-- CHARGEBACK_REQUESTED é a linha própria do chargeback (decisão 9), nunca
-- reaproveitando o índice de estorno.
alter table public.billing_payments drop constraint if exists billing_payments_status_check;
alter table public.billing_payments add constraint billing_payments_status_check check (
  status in ('RECEIVED_IN_CASH', 'CONFIRMED', 'RECEIVED', 'REFUNDED', 'CHARGEBACK_REQUESTED')
);

alter table public.billing_payments drop constraint if exists billing_payments_origem_check;
alter table public.billing_payments add constraint billing_payments_origem_check check (origem in ('manual', 'asaas'));

-- billing_period_start/end passam a aceitar nulo (decisão 8: crédito de
-- pacote de tokens pelo Asaas não tem período de assinatura nenhum). O CHECK
-- de tabela só pode expressar a metade que NÃO depende de outra tabela ("nulo
-- só quando origem=asaas"); a metade "e o pedido é de pacote" (decisão 8) é
-- responsabilidade de fn_billing_asaas_aplicar_pagamento (Tarefa 5, fora
-- desta migration), que é quem tem o tipo do pedido em mãos. Os dois campos
-- são nulos JUNTOS ou preenchidos JUNTOS, nunca um sem o outro.
alter table public.billing_payments alter column billing_period_start drop not null;
alter table public.billing_payments alter column billing_period_end drop not null;

alter table public.billing_payments drop constraint if exists billing_payments_periodo_check;
alter table public.billing_payments add constraint billing_payments_periodo_check check (
  (billing_period_start is null) = (billing_period_end is null)
  and (billing_period_start is not null or origem = 'asaas')
);

-- Decisão 9 do plano da fase: o índice único de estorna_pagamento_id (0908)
-- passava a valer para QUALQUER status, o que impediria uma linha
-- CHARGEBACK_REQUESTED apontar para o MESMO pagamento original que uma linha
-- REFUNDED já aponta (chargeback é sempre linha PRÓPRIA, nunca reaproveita
-- este índice). Recriado restrito a status = 'REFUNDED'.
drop index if exists billing_payments_estorna_pagamento_id_unique;
create unique index if not exists billing_payments_estorna_pagamento_id_unique
  on public.billing_payments (estorna_pagamento_id)
  where estorna_pagamento_id is not null and status = 'REFUNDED';

-- ── 6. billing_settings.compra_pelo_cliente: a segunda metade da chave de
-- compra (decisão 18 do plano da fase) ──
--
-- ASAAS_ENABLED (ambiente) E compra_pelo_cliente (banco) têm que estar
-- ligadas AO MESMO TEMPO para o cliente comprar pela tela. Nasce false: a
-- compra pela tela do cliente continua desligada até o Filipe autorizar
-- (restrição fixa 6 da fase). Escrita só por fn_billing_definir_compra_pelo_
-- cliente (Tarefa 3, fora desta migration), com auditoria do admin.
alter table public.billing_settings add column if not exists compra_pelo_cliente boolean not null default false;

comment on column public.billing_settings.compra_pelo_cliente is
  '0909, decisão 18: a metade da chave de compra que mora no banco (a outra é ASAAS_ENABLED no ambiente). As duas têm que estar ligadas ao mesmo tempo para o cliente comprar pela tela. Nasce false (restrição fixa 6 da fase F5): só liga com autorização do Filipe. Escrita só por fn_billing_definir_compra_pelo_cliente (Tarefa 3, fora desta migration).';

-- ============================================================================
-- PARTE 2 (Tarefa 2): gatilho, grants e bloco da baseline.
-- ============================================================================

-- ── 7. trg_billing_protege_assinatura_asaas: a trava contra cobrança
-- fantasma (decisão 22 do plano da fase) ──
--
-- BEFORE DELETE em billing_contracts. Confere o MARCADOR
-- (asaas_assinatura_encerrada_em), não o status: uma organização suspensa ou
-- cancelada pode ainda ter assinatura Asaas ATIVA cobrando de verdade.
-- SEMPRE raise exception, NUNCA return null: um BEFORE DELETE que devolve
-- null cancela SÓ aquela linha, em silêncio, sem abortar o comando: dentro
-- de uma cascata (apagar a organização), a organização seria apagada mesmo
-- assim e o contrato ficaria ÓRFÃO, apontando para uma organização que não
-- existe mais, com uma assinatura Asaas viva cobrando ninguém. raise
-- exception aborta o comando INTEIRO (a cascata inclusive), a única forma
-- seria de não deixar isso acontecer.
create or replace function public.fn_billing_protege_assinatura_asaas()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.asaas_subscription_id is not null and old.asaas_assinatura_encerrada_em is null then
    raise exception 'billing_cancele_no_asaas_antes' using errcode = '22023';
  end if;
  return old;
end;
$$;

comment on function public.fn_billing_protege_assinatura_asaas() is
  '0909, decisão 22: BEFORE DELETE em billing_contracts. Recusa (raise exception, NUNCA return null) apagar um contrato com asaas_subscription_id preenchido e asaas_assinatura_encerrada_em nulo, inclusive pela CASCATA de apagar a organização (return null cancelaria só a linha em silêncio, e a organização seria apagada mesmo assim, deixando o contrato órfão com uma assinatura Asaas ainda cobrando). O admin cancela a assinatura no Asaas primeiro (ou espera SUBSCRIPTION_DELETED confirmado gravar o marcador).';

revoke execute on function public.fn_billing_protege_assinatura_asaas() from public, anon, authenticated;
grant execute on function public.fn_billing_protege_assinatura_asaas() to service_role;

drop trigger if exists trg_billing_protege_assinatura_asaas on public.billing_contracts;
create trigger trg_billing_protege_assinatura_asaas
  before delete on public.billing_contracts
  for each row execute function public.fn_billing_protege_assinatura_asaas();

-- agent_worker não precisa apagar contrato nenhum pelas peças desta
-- migration (mesmo racional de todo bloco análogo em 0904 a 0908): por
-- privilégio padrão ela ganharia execute na função de gatilho.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_protege_assinatura_asaas() from agent_worker';
  end if;
end
$$;

-- ── 8. Grants das três tabelas novas: RLS ligada, ZERO política,
-- service_role só SELECT (escrita só por função, Tarefa 3 em diante),
-- agent_worker sem nada. ──
--
-- Mesmo desenho deny-all de billing_payments/billing_contract_eventos
-- (0908): quem não tem bypassrls (anon, authenticated) não enxerga nem
-- escreve nada, mesmo sem policy nenhuma. service_role ganha só SELECT
-- porque toda escrita nestas três tabelas é feita por função security
-- definer (Tarefa 3 em diante): o próprio dono da função escreve, não o
-- privilégio do papel que chamou.
alter table public.billing_customers enable row level security;
alter table public.billing_orders enable row level security;
alter table public.asaas_webhook_events enable row level security;

revoke all on public.billing_customers from anon, authenticated;
revoke all on public.billing_orders from anon, authenticated;
revoke all on public.asaas_webhook_events from anon, authenticated;

grant select on public.billing_customers to service_role;
revoke insert, update, delete, truncate on public.billing_customers from service_role;

grant select on public.billing_orders to service_role;
revoke insert, update, delete, truncate on public.billing_orders from service_role;

grant select on public.asaas_webhook_events to service_role;
revoke insert, update, delete, truncate on public.asaas_webhook_events from service_role;

-- agent_worker (se a role existir) perde select/insert/update/delete/
-- truncate nas três tabelas novas: por alter default privileges ela ganharia
-- tudo (grant select, insert, update, delete on all tables in schema public
-- to agent_worker, hiperbold/scripts/role-agent-worker.sql) e tem bypassrls.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.billing_customers, public.billing_orders, public.asaas_webhook_events from agent_worker';
  end if;
end
$$;
