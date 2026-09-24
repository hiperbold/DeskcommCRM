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

-- ============================================================================
-- PARTE 3 (Tarefa 3): pedido, cliente e chaves.
-- ============================================================================
--
-- Sete funções da Tarefa 3 da fase F5 (hiperbold/planos/fase-F5-tarefas.md):
-- fn_billing_definir_compra_pelo_cliente e fn_billing_definir_a_venda (as
-- duas metades da chave de compra, decisão 18); fn_billing_criar_pedido (o
-- pedido em si, decisões 2, 6, 8, 11, 12, 17, 18, 25 e 26); fn_billing_pedido_
-- tomar (posse atômica, decisão 25); fn_billing_vincular_cliente_asaas
-- (decisão 16); fn_billing_pedido_registrar_cobranca e fn_billing_pedido_
-- marcar (avanço e correção manual do pedido). Nenhuma chamada real ao Asaas
-- acontece aqui (restrição fixa 1 da fase): estas funções só leem e escrevem
-- o banco, o cliente HTTP é da Tarefa 11, fora desta migration.
--
-- Mesmo padrão de segurança das peças anteriores desta faixa: security
-- definer, search_path fixo em public, pg_temp, revoke de public/anon/
-- authenticated, grant só para service_role, bloco final revogando de
-- agent_worker (se a role existir).
--
-- Lógica de três valores: toda condição booleana que envolve coluna nula usa
-- coalesce ou "is not distinct from" (nunca comparação direta, que vira NULL
-- em silêncio e faz um if dar falso sem avisar, HANDOFF item 14).

-- ── 9. fn_billing_definir_compra_pelo_cliente: a metade da chave de compra
-- que mora no banco (decisão 18) ──
create or replace function public.fn_billing_definir_compra_pelo_cliente(p_sim boolean, p_actor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_anterior boolean;
begin
  if p_sim is null then
    raise exception 'billing_sim_obrigatorio' using errcode = '22023';
  end if;

  -- billing_settings é linha única (id = 1); for update trava a linha para
  -- duas chamadas concorrentes não lerem o mesmo "anterior" (mesmo padrão de
  -- fn_billing_definir_modo, 0907).
  select compra_pelo_cliente into v_anterior
    from public.billing_settings
    where id = 1
    for update;

  update public.billing_settings
    set compra_pelo_cliente = p_sim
    where id = 1;

  return jsonb_build_object(
    'compra_pelo_cliente_anterior', v_anterior,
    'compra_pelo_cliente_novo', p_sim
  );
end;
$$;

comment on function public.fn_billing_definir_compra_pelo_cliente(boolean, uuid) is
  '0909, decisão 18: liga/desliga billing_settings.compra_pelo_cliente, a metade da chave de compra que mora no banco (a outra é ASAAS_ENABLED no ambiente, conferida pelo servidor). p_actor recebido para a auditoria do chamador, não gravado por esta função (mesmo padrão de fn_billing_trocar_plano/fn_billing_definir_modo, 0904/0907).';

revoke execute on function public.fn_billing_definir_compra_pelo_cliente(boolean, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_definir_compra_pelo_cliente(boolean, uuid) to service_role;

-- ── 10. fn_billing_definir_a_venda: liga/desliga for_sale na VERSÃO ativa do
-- plano (decisão 18) ──
create or replace function public.fn_billing_definir_a_venda(p_plan_code text, p_sim boolean, p_actor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan record;
begin
  if p_sim is null then
    raise exception 'billing_sim_obrigatorio' using errcode = '22023';
  end if;

  select * into v_plan
    from public.billing_plans
    where code = p_plan_code and active
    for update;

  if not found then
    raise exception 'plano_nao_encontrado_ou_inativo' using errcode = 'P0002';
  end if;

  -- Decisão 18: ligar a venda exige preço mensal definido e positivo. Preço
  -- não se inventa (restrição fixa 3 da fase): um plano com price_monthly_
  -- cents = 0 não pode virar vendável até o Filipe definir o preço de
  -- verdade.
  if p_sim and coalesce(v_plan.price_monthly_cents, 0) <= 0 then
    raise exception 'billing_preco_nao_definido' using errcode = '22023';
  end if;

  update public.billing_plans
    set for_sale = p_sim
    where id = v_plan.id;

  return jsonb_build_object(
    'plan_code', p_plan_code,
    'for_sale_anterior', v_plan.for_sale,
    'for_sale_novo', p_sim
  );
end;
$$;

comment on function public.fn_billing_definir_a_venda(text, boolean, uuid) is
  '0909, decisão 18: liga/desliga billing_plans.for_sale na VERSÃO ATIVA do code informado (plano não encontrado ou sem versão ativa é P0002). Ligar (p_sim = true) exige price_monthly_cents > 0, senão 22023 (billing_preco_nao_definido, restrição fixa 3 da fase: preço não se inventa). Desligar não tem essa exigência. p_actor recebido para a auditoria do chamador, não gravado por esta função.';

revoke execute on function public.fn_billing_definir_a_venda(text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_definir_a_venda(text, boolean, uuid) to service_role;

-- ── 11. fn_billing_criar_pedido: o pedido de compra, com preço, plano,
-- ciclo, pacote e tokens sempre lidos do banco (decisões 2, 6, 8, 11, 12, 17,
-- 18, 25, 26) ──
--
-- Ordem das travas (decisão 12): esta função só usa pg_advisory_xact_lock
-- ('billing_assinatura:<org>'), a segunda da ordem fixa (billing:<org>,
-- billing_assinatura:<org>, for update no contrato, billing_tokens:<org>).
-- Não precisa da primeira (billing:<org>, do domínio de troca de plano): esta
-- função nunca muda billing_contracts.plan_id, só lê para decidir o pedido.
-- billing_settings é lida SEM for share (decisão 12: essa leitura não precisa
-- travar a linha; a outra metade da chave de compra, ASAAS_ENABLED, já é
-- conferida pelo servidor antes de chamar esta função).
--
-- Idempotência pela chave (decisão 13, mesmo padrão de fn_billing_registrar_
-- pagamento, 0908): checada DEPOIS de resolver o catálogo (decisão 17: preço,
-- plano, ciclo, pacote e tokens vêm do banco, nunca da entrada, então é
-- preciso primeiro RESOLVER o que o pedido seria para poder comparar). Mesma
-- chave com os MESMOS valores devolve ja_existia = true; com valores
-- diferentes, 22023 (billing_chave_com_valores_diferentes). O check de
-- "pedido aberto único" (decisão 11) só roda DEPOIS da idempotência: um
-- reenvio da mesma chave não pode esbarrar no próprio pedido que ele mesmo
-- criou.
create or replace function public.fn_billing_criar_pedido(
  p_org uuid,
  p_tipo text,
  p_plan_code text,
  p_ciclo text,
  p_pacote text,
  p_metodo text,
  p_ambiente text,
  p_chave uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_compra_pelo_cliente boolean;
  v_contract record;
  v_plan record;
  v_pacote record;
  v_plan_id uuid;
  v_ciclo text;
  v_pacote_id uuid;
  v_tokens bigint;
  v_amount_cents integer;
  v_existente record;
  v_pedido_id uuid;
  v_external_reference text;
  v_proxima_cobranca_em date;
begin
  if p_chave is null then
    raise exception 'billing_chave_obrigatoria' using errcode = '22023';
  end if;

  if p_tipo not in ('assinatura', 'pacote_tokens') then
    raise exception 'billing_tipo_invalido' using errcode = '22023';
  end if;

  if p_metodo not in ('CREDIT_CARD', 'PIX') then
    raise exception 'billing_metodo_invalido' using errcode = '22023';
  end if;

  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if p_tipo = 'assinatura' then
    if p_plan_code is null or btrim(p_plan_code) = '' then
      raise exception 'billing_plan_code_obrigatorio' using errcode = '22023';
    end if;
    if p_ciclo not in ('monthly', 'yearly') then
      raise exception 'billing_ciclo_invalido' using errcode = '22023';
    end if;
  else
    if p_pacote is null or btrim(p_pacote) = '' then
      raise exception 'billing_pacote_obrigatorio' using errcode = '22023';
    end if;
  end if;

  -- Decisão 12: leitura de billing_settings SEM for share, feita ANTES de
  -- tomar a trava (não precisa travar a linha, e é o rejeite mais barato).
  select compra_pelo_cliente into v_compra_pelo_cliente
    from public.billing_settings
    where id = 1;

  if not coalesce(v_compra_pelo_cliente, false) then
    raise exception 'billing_compra_desligada' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  if p_tipo = 'assinatura' then
    select * into v_plan
      from public.billing_plans
      where code = p_plan_code and active
      limit 1;

    if not found then
      raise exception 'plano_nao_encontrado_ou_inativo' using errcode = 'P0002';
    end if;

    if not v_plan.for_sale then
      raise exception 'billing_plano_fora_de_venda' using errcode = '22023';
    end if;

    v_plan_id := v_plan.id;
    v_ciclo := p_ciclo;

    if p_ciclo = 'monthly' then
      -- Preço não se inventa (N8/N9, restrição fixa 3): plano sem preço
      -- mensal positivo não aparece para compra mensal.
      if coalesce(v_plan.price_monthly_cents, 0) <= 0 then
        raise exception 'billing_preco_nao_definido' using errcode = '22023';
      end if;
      -- Decisão 2 (oferta desta fase): mensal só no cartão.
      if p_metodo <> 'CREDIT_CARD' then
        raise exception 'billing_metodo_invalido_para_oferta' using errcode = '22023';
      end if;
      v_amount_cents := v_plan.price_monthly_cents;
    else
      -- yearly: cartão ou Pix (decisão 2), mas price_yearly_cents é nulo até
      -- o Filipe definir (N8): plano sem preço anual não aparece para compra
      -- anual, com CREDIT_CARD ou com PIX.
      if coalesce(v_plan.price_yearly_cents, 0) <= 0 then
        raise exception 'billing_preco_nao_definido' using errcode = '22023';
      end if;
      v_amount_cents := v_plan.price_yearly_cents;
    end if;

    -- Decisão 18: "billing_ja_tem_assinatura_asaas" só considera assinatura
    -- SEM o marcador de encerramento (decisão 22): uma assinatura já
    -- encerrada (ou nunca existente) não bloqueia um pedido novo.
    if v_contract.asaas_subscription_id is not null and v_contract.asaas_assinatura_encerrada_em is null then
      raise exception 'billing_ja_tem_assinatura_asaas' using errcode = '22023';
    end if;

    -- Decisão 26: com período ainda vigente (pago no futuro), a próxima
    -- cobrança nasce no dia seguinte ao último dia já pago, ou seja, a data
    -- civil em America/Sao_Paulo de current_period_end (que já é esse limite
    -- exclusivo, 00h de SP do dia seguinte). Sem período vigente, null: o
    -- serviço de compra (Tarefa 14) usa hoje em SP.
    if v_contract.current_period_end is not null and v_contract.current_period_end > now() then
      v_proxima_cobranca_em := (v_contract.current_period_end at time zone 'America/Sao_Paulo')::date;
    else
      v_proxima_cobranca_em := null;
    end if;
  else
    select * into v_pacote
      from public.billing_token_pacotes
      where codigo = p_pacote and ativo
      limit 1;

    if not found then
      raise exception 'pacote_nao_encontrado_ou_inativo' using errcode = 'P0002';
    end if;

    -- Preço não se inventa (N9, restrição fixa 3): pacote sem preço não
    -- aparece para compra.
    if coalesce(v_pacote.preco_cents, 0) <= 0 then
      raise exception 'billing_preco_nao_definido' using errcode = '22023';
    end if;

    -- Decisão 2: pacote aceita CREDIT_CARD ou PIX, os dois únicos valores
    -- possíveis de p_metodo (já validado acima). Nenhuma restrição extra.
    v_ciclo := null;
    v_pacote_id := v_pacote.id;
    v_tokens := v_pacote.tokens;
    v_amount_cents := v_pacote.preco_cents;
    v_proxima_cobranca_em := null;
  end if;

  -- Idempotência pela chave (decisão 13), DEPOIS de resolver o catálogo
  -- (decisão 17): compara contra o que o banco decidiu, nunca contra a
  -- entrada crua.
  select * into v_existente
    from public.billing_orders
    where organization_id = p_org and chave = p_chave;

  if found then
    if v_existente.tipo = p_tipo
      and v_existente.plan_id is not distinct from v_plan_id
      and v_existente.ciclo is not distinct from v_ciclo
      and v_existente.pacote_id is not distinct from v_pacote_id
      and v_existente.tokens is not distinct from v_tokens
      and v_existente.metodo = p_metodo
      and v_existente.ambiente = p_ambiente
      and v_existente.amount_cents = v_amount_cents
    then
      return jsonb_build_object(
        'pedido_id', v_existente.id,
        'external_reference', v_existente.external_reference,
        'amount_cents', v_existente.amount_cents,
        'ja_existia', true,
        'proxima_cobranca_em', v_proxima_cobranca_em
      );
    end if;
    raise exception 'billing_chave_com_valores_diferentes' using errcode = '22023';
  end if;

  -- Decisão 11 (idempotência em três camadas) e decisão 25 (posse atômica):
  -- um pedido ABERTO por organização e por tipo, incluindo 'processando'. O
  -- índice único parcial billing_orders_aberto_por_tipo_unique (Tarefa 1) é a
  -- rede de segurança final; este select devolve a mensagem PRÓPRIA antes de
  -- deixar o insert estourar um erro genérico de unicidade.
  if exists (
    select 1 from public.billing_orders
    where organization_id = p_org and tipo = p_tipo
      and status in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando')
  ) then
    raise exception 'billing_pedido_aberto_existe' using errcode = '22023';
  end if;

  insert into public.billing_orders (
    organization_id, ambiente, tipo, plan_id, ciclo, pacote_id, tokens,
    metodo, amount_cents, chave, criado_por
  ) values (
    p_org, p_ambiente, p_tipo, v_plan_id, v_ciclo, v_pacote_id, v_tokens,
    p_metodo, v_amount_cents, p_chave, p_actor
  )
  returning id, external_reference into v_pedido_id, v_external_reference;

  return jsonb_build_object(
    'pedido_id', v_pedido_id,
    'external_reference', v_external_reference,
    'amount_cents', v_amount_cents,
    'ja_existia', false,
    'proxima_cobranca_em', v_proxima_cobranca_em
  );
end;
$$;

comment on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid) is
  '0909, Tarefa 3: cria o pedido de compra (decisões 2, 6, 8, 11, 12, 17, 18, 25, 26). Preço, plano (versão ativa), ciclo, pacote e tokens vêm SEMPRE do banco, nunca da entrada (decisão 17). Recusas 22023 com mensagem própria: billing_compra_desligada, billing_plano_fora_de_venda, billing_preco_nao_definido, billing_metodo_invalido_para_oferta, billing_ja_tem_assinatura_asaas, billing_pedido_aberto_existe (mais as validações estruturais de tipo/metodo/ambiente/ciclo/plan_code/pacote, também 22023). Lê billing_settings SEM for share (decisão 12). Idempotente pela chave: mesmos valores devolve ja_existia = true; valores diferentes, 22023 (billing_chave_com_valores_diferentes). Devolve proxima_cobranca_em (decisão 26): a data civil em America/Sao_Paulo de current_period_end quando o período do contrato ainda está no futuro, para o serviço de compra (Tarefa 14) montar o nextDueDate da assinatura nova sem cobrar de novo o período já pago.';

revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid) to service_role;

-- ── 12. fn_billing_pedido_tomar: posse atômica antes do POST ao Asaas
-- (decisão 25) ──
--
-- Sem advisory lock: o próprio UPDATE condicional É a trava (decisão 25).
-- Duas chamadas simultâneas para o mesmo pedido nunca fazem duas chamadas ao
-- Asaas: só uma ganha a linha (tomado = true); a outra lê o estado atual sem
-- tomar nada (tomado = false).
create or replace function public.fn_billing_pedido_tomar(p_org uuid, p_pedido uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_ganhou record;
  v_atual record;
begin
  update public.billing_orders
    set status = 'processando'
    where id = p_pedido and organization_id = p_org and status in ('criado', 'inconclusivo')
  returning * into v_ganhou;

  if found then
    return jsonb_build_object(
      'tomado', true,
      'pedido_id', v_ganhou.id,
      'status', v_ganhou.status,
      'tipo', v_ganhou.tipo,
      'ambiente', v_ganhou.ambiente,
      'metodo', v_ganhou.metodo,
      'amount_cents', v_ganhou.amount_cents,
      'external_reference', v_ganhou.external_reference
    );
  end if;

  -- Não ganhou: lê o estado atual, sempre filtrado por organization_id
  -- (decisão 17, mesma forma do "404 igual" que a leitura do pedido usa: não
  -- existe e é de outra organização caem no MESMO not found, nunca revelando
  -- qual dos dois é o caso).
  select * into v_atual
    from public.billing_orders
    where id = p_pedido and organization_id = p_org;

  if not found then
    raise exception 'billing_pedido_nao_encontrado' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'tomado', false,
    'pedido_id', v_atual.id,
    'status', v_atual.status,
    'tipo', v_atual.tipo,
    'ambiente', v_atual.ambiente,
    'metodo', v_atual.metodo,
    'amount_cents', v_atual.amount_cents,
    'external_reference', v_atual.external_reference
  );
end;
$$;

comment on function public.fn_billing_pedido_tomar(uuid, uuid) is
  '0909, decisão 25 (posse atômica): update billing_orders set status = processando where id = p_pedido and organization_id = p_org and status in (criado, inconclusivo) returning *. Quem ganha a linha (tomado = true) é quem pode fazer o POST ao Asaas (Tarefa 14, fora desta migration); quem não ganha (tomado = false) só lê o estado atual, sem chamar nada. Pedido inexistente ou de outra organização: P0002 (billing_pedido_nao_encontrado), o mesmo erro para os dois casos (decisão 17).';

revoke execute on function public.fn_billing_pedido_tomar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_pedido_tomar(uuid, uuid) to service_role;

-- ── 13. fn_billing_vincular_cliente_asaas: o vínculo organização <-> cliente
-- Asaas (decisão 16) ──
create or replace function public.fn_billing_vincular_cliente_asaas(p_org uuid, p_ambiente text, p_asaas_customer_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_existente text;
begin
  -- pg_advisory_xact_lock('billing:<org>'), a primeira trava da ordem fixa
  -- da decisão 12: serializa duas chamadas concorrentes desta função para a
  -- MESMA organização (o vínculo ainda não existe, então não há linha para
  -- "for update" travar sozinho antes do insert).
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text, 0));

  select asaas_customer_id into v_existente
    from public.billing_customers
    where organization_id = p_org and ambiente = p_ambiente
    for update;

  if found then
    if v_existente = p_asaas_customer_id then
      -- Reenvio idempotente: o mesmo vínculo já existe.
      return jsonb_build_object('ja_existia', true, 'asaas_customer_id', v_existente);
    end if;
    -- Vínculo DIFERENTE para a MESMA organização e o MESMO ambiente.
    raise exception 'billing_organizacao_ja_tem_outro_cliente_asaas' using errcode = '22023';
  end if;

  -- O MESMO cliente Asaas, no MESMO ambiente, já vinculado a OUTRA
  -- organização (decisão 6): o índice único (ambiente, asaas_customer_id) já
  -- garante isso no banco, mas o erro próprio (42501, IDOR) vem daqui, antes
  -- do insert estourar um erro genérico de unicidade.
  if exists (
    select 1 from public.billing_customers
    where ambiente = p_ambiente and asaas_customer_id = p_asaas_customer_id and organization_id <> p_org
  ) then
    raise exception 'billing_cliente_asaas_de_outra_organizacao' using errcode = '42501';
  end if;

  insert into public.billing_customers (organization_id, ambiente, asaas_customer_id)
  values (p_org, p_ambiente, p_asaas_customer_id);

  return jsonb_build_object('ja_existia', false, 'asaas_customer_id', p_asaas_customer_id);
end;
$$;

comment on function public.fn_billing_vincular_cliente_asaas(uuid, text, text) is
  '0909, decisão 16: grava o vínculo organização <-> cliente Asaas (billing_customers, chamada pela Tarefa 11, fora desta migration, antes ou depois do primeiro POST /customers). Vínculo DIFERENTE para a MESMA organização e ambiente: 22023 (billing_organizacao_ja_tem_outro_cliente_asaas). O MESMO cliente Asaas já vinculado a OUTRA organização, no mesmo ambiente: 42501 (billing_cliente_asaas_de_outra_organizacao, decisão 6, IDOR). Reenvio do MESMO vínculo é idempotente (ja_existia = true). pg_advisory_xact_lock(''billing:<org>''), a primeira trava da ordem fixa da decisão 12.';

revoke execute on function public.fn_billing_vincular_cliente_asaas(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_billing_vincular_cliente_asaas(uuid, text, text) to service_role;

-- ── 14. fn_billing_pedido_registrar_cobranca: grava a cobrança que o POST ao
-- Asaas devolveu, e o pedido passa a aguardando_pagamento ──
create or replace function public.fn_billing_pedido_registrar_cobranca(
  p_org uuid,
  p_pedido uuid,
  p_asaas_payment_id text,
  p_asaas_subscription_id text,
  p_invoice_url text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_pedido record;
begin
  if p_asaas_payment_id is not null and p_asaas_payment_id !~ '^pay_' then
    raise exception 'billing_asaas_payment_id_formato_invalido' using errcode = '22023';
  end if;

  if p_asaas_subscription_id is not null and p_asaas_subscription_id !~ '^sub_' then
    raise exception 'billing_asaas_subscription_id_formato_invalido' using errcode = '22023';
  end if;

  select * into v_pedido
    from public.billing_orders
    where id = p_pedido and organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_pedido_nao_encontrado' using errcode = 'P0002';
  end if;

  -- invoice_url amarrada ao AMBIENTE DO PRÓPRIO PEDIDO (nunca a uma
  -- variável global de ambiente do servidor): sandbox só aceita a fatura de
  -- sandbox.asaas.com, produção só a de www.asaas.com ou asaas.com. Risco de
  -- redirecionamento aberto (auditoria da fase): a URL nunca sai daqui sem
  -- essa amarra.
  if p_invoice_url is not null then
    if v_pedido.ambiente = 'sandbox' and p_invoice_url !~ '^https://sandbox\.asaas\.com/' then
      raise exception 'billing_invoice_url_fora_do_ambiente' using errcode = '22023';
    end if;
    if v_pedido.ambiente = 'producao' and p_invoice_url !~ '^https://(www\.)?asaas\.com/' then
      raise exception 'billing_invoice_url_fora_do_ambiente' using errcode = '22023';
    end if;
  end if;

  if v_pedido.status = 'aguardando_pagamento' then
    -- Retentativa idempotente (decisão 13): a MESMA cobrança já registrada
    -- não é erro, é reenvio (a chamada ao Asaas pode ter tido sucesso e a
    -- resposta se perdido no caminho). Cobrança DIFERENTE com o pedido já
    -- aguardando é recusada.
    if v_pedido.asaas_payment_id is not distinct from p_asaas_payment_id
      and v_pedido.asaas_subscription_id is not distinct from p_asaas_subscription_id
      and v_pedido.invoice_url is not distinct from p_invoice_url
    then
      return jsonb_build_object('ja_registrado', true, 'pedido_id', v_pedido.id, 'status', v_pedido.status);
    end if;
    raise exception 'billing_pedido_status_invalido_para_cobranca' using errcode = '22023';
  elsif v_pedido.status not in ('criado', 'processando', 'inconclusivo') then
    raise exception 'billing_pedido_status_invalido_para_cobranca' using errcode = '22023';
  end if;

  update public.billing_orders
    set asaas_payment_id = coalesce(p_asaas_payment_id, asaas_payment_id),
        asaas_subscription_id = coalesce(p_asaas_subscription_id, asaas_subscription_id),
        invoice_url = coalesce(p_invoice_url, invoice_url),
        status = 'aguardando_pagamento'
    where id = v_pedido.id;

  return jsonb_build_object('ja_registrado', false, 'pedido_id', v_pedido.id, 'status', 'aguardando_pagamento');
end;
$$;

comment on function public.fn_billing_pedido_registrar_cobranca(uuid, uuid, text, text, text) is
  '0909, Tarefa 3: grava o que o POST ao Asaas devolveu (Tarefa 14, fora desta migration) e o pedido passa a aguardando_pagamento. Formatos ^pay_ e ^sub_ (22023 quando informado fora do formato). invoice_url amarrada ao AMBIENTE DO PRÓPRIO PEDIDO: só sandbox.asaas.com em sandbox, só www.asaas.com ou asaas.com em produção (22023, billing_invoice_url_fora_do_ambiente, risco de redirecionamento aberto). Pedido inexistente ou de outra organização: P0002 (mesmo erro para os dois casos, decisão 17). Só transiciona de criado/processando/inconclusivo; a partir de aguardando_pagamento, a MESMA cobrança é idempotente (ja_registrado = true) e uma cobrança DIFERENTE é 22023; qualquer outro status de origem também é 22023 (billing_pedido_status_invalido_para_cobranca).';

revoke execute on function public.fn_billing_pedido_registrar_cobranca(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_billing_pedido_registrar_cobranca(uuid, uuid, text, text, text) to service_role;

-- ── 15. fn_billing_pedido_marcar: inconclusivo, falhou ou cancelado, nunca a
-- partir de pago ──
create or replace function public.fn_billing_pedido_marcar(p_org uuid, p_pedido uuid, p_status text, p_motivo text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_pedido record;
begin
  if p_status not in ('inconclusivo', 'falhou', 'cancelado') then
    raise exception 'billing_status_invalido_para_marcar' using errcode = '22023';
  end if;

  if p_motivo is null or btrim(p_motivo) = '' then
    raise exception 'billing_motivo_obrigatorio' using errcode = '22023';
  end if;

  select * into v_pedido
    from public.billing_orders
    where id = p_pedido and organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_pedido_nao_encontrado' using errcode = 'P0002';
  end if;

  -- Nunca a partir de pago: o pedido já foi honrado, marcar depois disso
  -- apagaria o rastro de um pagamento de verdade.
  if v_pedido.status = 'pago' then
    raise exception 'billing_pedido_ja_pago' using errcode = '22023';
  end if;

  update public.billing_orders
    set status = p_status
    where id = v_pedido.id;

  return jsonb_build_object('pedido_id', v_pedido.id, 'status_anterior', v_pedido.status, 'status_novo', p_status);
end;
$$;

comment on function public.fn_billing_pedido_marcar(uuid, uuid, text, text) is
  '0909, Tarefa 3: marca o pedido como inconclusivo, falhou ou cancelado (qualquer outro valor de p_status é 22023). p_motivo obrigatório (mesmo padrão de fn_billing_corrigir_periodo, 0908), recebido para a auditoria do chamador (Tarefa 17, fora desta migration): billing_orders ainda não tem uma coluna de motivo ou uma tabela de eventos própria, então não é gravado por esta função. Nunca a partir de pago (22023, billing_pedido_ja_pago): o rastro de um pagamento de verdade nunca é apagado por uma marcação manual. Pedido inexistente ou de outra organização: P0002 (mesmo erro para os dois casos, decisão 17).';

revoke execute on function public.fn_billing_pedido_marcar(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_billing_pedido_marcar(uuid, uuid, text, text) to service_role;

-- ── 16. agent_worker (se a role existir) perde execute nas sete funções da
-- Tarefa 3, num único bloco condicional (mesmo padrão das seções 7 e 8,
-- acima) ──
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function '
      || 'public.fn_billing_definir_compra_pelo_cliente(boolean, uuid), '
      || 'public.fn_billing_definir_a_venda(text, boolean, uuid), '
      || 'public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid), '
      || 'public.fn_billing_pedido_tomar(uuid, uuid), '
      || 'public.fn_billing_vincular_cliente_asaas(uuid, text, text), '
      || 'public.fn_billing_pedido_registrar_cobranca(uuid, uuid, text, text, text), '
      || 'public.fn_billing_pedido_marcar(uuid, uuid, text, text) '
      || 'from agent_worker';
  end if;
end
$$;
