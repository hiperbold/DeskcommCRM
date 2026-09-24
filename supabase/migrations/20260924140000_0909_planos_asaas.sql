-- 0909, cobrança pelo Asaas: tabelas (fase F5, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F5-tarefas.md, decisões 4 a 12, 22 e 25, e nas
-- decisões 1 a 27 do plano mestre (hiperbold/planos/2026-09-22-planos-e-
-- assinatura.md). Contrato comum: F:\github-projects\hiper-track\docs\manual-
-- api-asaas-saas.md.
--
-- Esta migration (0909) traz as Tarefas 1 a 5 da fase: o SCHEMA (tabelas,
-- colunas, checks, índices), o gatilho/grants das três tabelas novas, o
-- pedido/cliente/chaves, o registro/reserva/falha/reprocesso/poda do webhook
-- e a aplicação do pagamento confirmado (período, troca de plano, pacote de
-- tokens). Estorno, chargeback e fim de assinatura são da Tarefa 6, fora
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

-- ============================================================================
-- PARTE 4 (Tarefa 4): registrar, reservar com lease, falha, reprocessar,
-- podar.
-- ============================================================================
--
-- Seis peças da Tarefa 4 da fase F5 (hiperbold/planos/fase-F5-tarefas.md):
-- fn_billing_asaas_registrar_evento (o ingresso durável do webhook, com a
-- quarentena da decisão 19/M6), fn_billing_asaas_reservar_eventos (a reserva
-- com lease da decisão 20, for update skip locked), fn_billing_asaas_lease_e_
-- meu (conferidor interno do lease, sem grant, para a Tarefa 5 usar dentro de
-- fn_billing_asaas_aplicar_evento), fn_billing_asaas_registrar_falha (o
-- backoff da decisão 20), fn_billing_asaas_reprocessar_evento (a tela do
-- admin, decisão 20) e fn_billing_asaas_podar_eventos (a poda de payload da
-- decisão 21, N38). fn_billing_asaas_aplicar_evento e as funções internas que
-- aplicam pagamento, estorno e fim de assinatura são das Tarefas 5 e 6, fora
-- desta migration.
--
-- Mesmo padrão de segurança das peças anteriores desta faixa: security
-- definer, search_path fixo em public, pg_temp, revoke de public/anon/
-- authenticated, grant só para service_role (exceto fn_billing_asaas_lease_e_
-- meu, que fica SEM grant nenhum: é interna, chamada só de dentro de outra
-- função da mesma faixa, e o dono da função já tem privilégio implícito sobre
-- o que ele mesmo é dono), bloco final revogando de agent_worker (se a role
-- existir).
--
-- Lógica de três valores: toda condição booleana que envolve coluna nula usa
-- coalesce ou "is not distinct from" / "is distinct from" (HANDOFF item 14).

-- ── 17. fn_billing_asaas_registrar_evento: o registro durável do evento, com
-- quarentena para o que foge do formato ou do teto de tamanho (decisão
-- 19/M6) ──
--
-- on conflict (event_id) do nothing: evento repetido é guardado uma vez só
-- (decisão 11, idempotência em três camadas). Quarentena: o evento chega
-- AUTENTICADO até aqui (a rota, Tarefa 12, já validou o token do webhook e o
-- JSON com id/event), mas pode ainda assim violar o formato que a TABELA
-- exige (event_id fora de 1 a 100 caracteres, event_type fora de
-- ^[A-Z_]{3,64}$) ou passar do teto de 64 KB do payload. Em vez de deixar o
-- insert estourar o CHECK (o que derrubaria a função inteira e faria a rota
-- responder 500, e o Asaas reentregaria travando a fila SEQUENTIALLY), esta
-- função corrige o que precisa para caber no CHECK, grava com resultado =
-- 'erro' e o payload CORTADO (um resumo pequeno, nunca o original malformado
-- ou grande demais), e devolve sucesso, para a rota sempre responder 200.
create or replace function public.fn_billing_asaas_registrar_evento(
  p_event_id text,
  p_event_type text,
  p_resource_id text,
  p_ambiente text,
  p_origem text,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id text;
  v_event_type text;
  v_payload jsonb;
  v_resultado text;
  v_erro_codigo text;
  v_quarentena boolean := false;
  v_id uuid;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if p_origem not in ('webhook', 'conciliacao') then
    raise exception 'billing_origem_invalida' using errcode = '22023';
  end if;

  if p_payload is null then
    raise exception 'billing_payload_obrigatorio' using errcode = '22023';
  end if;

  if p_event_id is null or char_length(p_event_id) < 1 or char_length(p_event_id) > 100 then
    v_quarentena := true;
    v_erro_codigo := 'evento_fora_do_formato:event_id';
  elsif p_event_type is null or p_event_type !~ '^[A-Z_]{3,64}$' then
    v_quarentena := true;
    v_erro_codigo := 'evento_fora_do_formato:event_type';
  -- Teto de 64 KB (65536 bytes) medido no payload já sanitizado. A rota
  -- (Tarefa 12) também tem o seu próprio teto de 64 KB no CORPO cru; este é
  -- um segundo teto, independente, porque a conciliação (Tarefa 16) monta
  -- eventos sintéticos que nunca passam pela rota.
  elsif octet_length(p_payload::text) > 65536 then
    v_quarentena := true;
    v_erro_codigo := 'evento_acima_do_teto:64kb';
  end if;

  if v_quarentena then
    v_event_id := left(
      coalesce(nullif(btrim(p_event_id), ''), 'quarentena:' || md5(coalesce(p_event_type, '') || p_payload::text)),
      100
    );
    v_event_type := case
      when p_event_type is not null and p_event_type ~ '^[A-Z_]{3,64}$' then p_event_type
      else 'EVENTO_EM_QUARENTENA'
    end;
    v_payload := jsonb_build_object('quarentena', true, 'motivo', v_erro_codigo);
    v_resultado := 'erro';
  else
    v_event_id := p_event_id;
    v_event_type := p_event_type;
    v_payload := p_payload;
    v_resultado := 'aguardando';
  end if;

  insert into public.asaas_webhook_events (
    event_id, event_type, resource_id, ambiente, origem, payload, resultado, erro_codigo, processado_em
  ) values (
    v_event_id, v_event_type, p_resource_id, p_ambiente, p_origem, v_payload, v_resultado,
    left(v_erro_codigo, 200), case when v_quarentena then now() else null end
  )
  on conflict (event_id) do nothing
  returning id into v_id;

  return jsonb_build_object(
    'novo', v_id is not null,
    'event_id', v_event_id,
    'resultado', v_resultado,
    'quarentena', v_quarentena
  );
end;
$$;

comment on function public.fn_billing_asaas_registrar_evento(text, text, text, text, text, jsonb) is
  '0909, Tarefa 4: registra o evento do webhook (ou o sintético conc:<id>:<status> da conciliação, Tarefa 16). on conflict (event_id) do nothing: evento repetido é guardado uma vez só, novo = false na segunda chamada. Quarentena (decisão 19/M6): event_id fora de 1..100 caracteres, event_type fora de ^[A-Z_]{3,64}$, ou payload acima de 64 KB nunca deixam o insert estourar o CHECK da tabela; a função corrige o que precisa para caber, grava resultado = erro com o payload CORTADO (um resumo pequeno, nunca o original) e devolve sucesso mesmo assim, para a rota do webhook (Tarefa 12) sempre responder 200 e não travar a fila SEQUENTIALLY do Asaas.';

revoke execute on function public.fn_billing_asaas_registrar_evento(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_registrar_evento(text, text, text, text, text, jsonb) to service_role;

-- ── 18. fn_billing_asaas_reservar_eventos: a reserva com lease (decisão 20)
-- ──
--
-- for update skip locked: dois processadores reservando ao mesmo tempo nunca
-- pegam o MESMO evento. Só pendentes (resultado = 'aguardando') com
-- proxima_tentativa_em vencido (nulo, para o evento que nunca falhou, ou no
-- passado) e com o lease vencido ou nulo (evento nunca reservado, ou
-- reservado antes mas o lease expirou sem confirmação). Grava um lease_token
-- NOVO em cada evento reservado, com o prazo p_lease_segundos (padrão 300,
-- decisão 20).
create or replace function public.fn_billing_asaas_reservar_eventos(p_limite integer, p_lease_segundos integer default 300)
returns table (id uuid, event_type text, resource_id text, lease_token uuid)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_limite is null or p_limite <= 0 then
    raise exception 'billing_limite_invalido' using errcode = '22023';
  end if;

  if p_lease_segundos is null or p_lease_segundos <= 0 then
    raise exception 'billing_lease_segundos_invalido' using errcode = '22023';
  end if;

  return query
  with candidatos as (
    select aw.id
      from public.asaas_webhook_events aw
     where aw.resultado = 'aguardando'
       and (aw.proxima_tentativa_em is null or aw.proxima_tentativa_em <= now())
       and (aw.lease_expira_em is null or aw.lease_expira_em < now())
     order by aw.recebido_em
     limit p_limite
       for update skip locked
  )
  update public.asaas_webhook_events aw
     set lease_token = gen_random_uuid(),
         lease_expira_em = now() + (p_lease_segundos || ' seconds')::interval
    from candidatos
   where aw.id = candidatos.id
  returning aw.id, aw.event_type, aw.resource_id, aw.lease_token;
end;
$$;

comment on function public.fn_billing_asaas_reservar_eventos(integer, integer) is
  '0909, Tarefa 4, decisão 20: reserva até p_limite eventos pendentes com for update skip locked (dois processadores concorrentes nunca pegam o mesmo evento), só os que têm proxima_tentativa_em vencido (nulo ou no passado) e o lease vencido ou nulo, e grava um lease_token NOVO com validade p_lease_segundos (padrão 300). fn_billing_asaas_aplicar_evento (Tarefa 5, fora desta migration) recusa gravar quando o lease não é mais o do chamador (fn_billing_asaas_lease_e_meu, abaixo).';

revoke execute on function public.fn_billing_asaas_reservar_eventos(integer, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_reservar_eventos(integer, integer) to service_role;

-- ── 19. fn_billing_asaas_lease_e_meu: conferidor interno do lease, SEM
-- grant (decisão 20) ──
--
-- Interna, para a Tarefa 5 usar dentro de fn_billing_asaas_aplicar_evento:
-- nenhum grant a service_role, de propósito. O dono da função (o mesmo dono
-- de toda a faixa) já tem privilégio implícito sobre o que é dono; quem
-- chama de fora (authenticated, anon, e o próprio service_role sem passar
-- por outra função da faixa) nunca executa esta diretamente. O revoke
-- inclui service_role explicitamente (e não só public/anon/authenticated,
-- como nas outras peças): este banco tem "alter default privileges" que
-- concede EXECUTE em função nova a service_role (e a agent_worker) por
-- padrão, o mesmo mecanismo que o HANDOFF descreve para agent_worker; sem
-- este revoke, service_role ganharia a função de graça, sem grant nenhum.
create or replace function public.fn_billing_asaas_lease_e_meu(p_evento uuid, p_lease_token uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.asaas_webhook_events
     where id = p_evento
       and lease_token is not null
       and p_lease_token is not null
       and lease_token = p_lease_token
       and lease_expira_em is not null
       and lease_expira_em > now()
  );
$$;

comment on function public.fn_billing_asaas_lease_e_meu(uuid, uuid) is
  '0909, Tarefa 4, decisão 20: verdadeiro só quando p_lease_token é o lease ATUAL do evento e ainda não venceu. Interna, SEM grant a NINGUÉM (revoke explícito de public/anon/authenticated/service_role, e de agent_worker no bloco condicional abaixo, por causa do alter default privileges deste banco): chamada de dentro de fn_billing_asaas_aplicar_evento (Tarefa 5, fora desta migration), nunca diretamente de fora.';

revoke execute on function public.fn_billing_asaas_lease_e_meu(uuid, uuid) from public, anon, authenticated, service_role;

-- ── 20. fn_billing_asaas_registrar_falha: o backoff (decisão 20) ──
--
-- Recusa (billing_lease_invalido, 22023) se p_lease_token não é mais o dono
-- do evento: quem perdeu a corrida de fn_billing_asaas_reservar_eventos, ou
-- cujo lease já venceu, nunca grava a falha por cima de quem reservou
-- depois. tentativas + 1; até a nona falha (tentativas resultante até 9)
-- volta a 'aguardando' com backoff now() + least(2^tentativas minutos, 6
-- horas); na décima (tentativas = 10) vira 'erro', visível ao admin
-- (fn_billing_asaas_reprocessar_evento, abaixo). erro_codigo cortado em 200
-- caracteres (mesmo teto da coluna).
create or replace function public.fn_billing_asaas_registrar_falha(p_evento uuid, p_lease_token uuid, p_codigo text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_evento record;
  v_tentativas integer;
  v_resultado text;
  v_proxima timestamptz;
begin
  select * into v_evento
    from public.asaas_webhook_events
    where id = p_evento
    for update;

  if not found then
    raise exception 'billing_evento_nao_encontrado' using errcode = 'P0002';
  end if;

  if p_lease_token is null or v_evento.lease_token is distinct from p_lease_token then
    raise exception 'billing_lease_invalido' using errcode = '22023';
  end if;

  v_tentativas := v_evento.tentativas + 1;

  if v_tentativas >= 10 then
    v_resultado := 'erro';
    v_proxima := null;
  else
    v_resultado := 'aguardando';
    v_proxima := now() + least(
      power(2::double precision, v_tentativas::double precision) * interval '1 minute',
      interval '6 hours'
    );
  end if;

  update public.asaas_webhook_events
     set tentativas = v_tentativas,
         resultado = v_resultado,
         proxima_tentativa_em = v_proxima,
         erro_codigo = left(p_codigo, 200),
         processado_em = now(),
         lease_token = null,
         lease_expira_em = null
   where id = p_evento;

  return jsonb_build_object(
    'evento_id', p_evento,
    'tentativas', v_tentativas,
    'resultado', v_resultado,
    'proxima_tentativa_em', v_proxima
  );
end;
$$;

comment on function public.fn_billing_asaas_registrar_falha(uuid, uuid, text) is
  '0909, Tarefa 4, decisão 20: grava a falha do processamento de um evento reservado. Recusa (billing_lease_invalido, 22023) se p_lease_token não é mais o lease atual do evento. tentativas + 1; até a nona falha volta a aguardando com backoff now() + least(2^tentativas minutos, 6 horas); na décima vira erro. erro_codigo cortado em 200 caracteres. Libera o lease (lease_token/lease_expira_em nulos) nos dois casos, para o evento voltar a ser elegível pela próxima reserva (ou ficar fora do índice dos pendentes, quando virou erro).';

revoke execute on function public.fn_billing_asaas_registrar_falha(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_registrar_falha(uuid, uuid, text) to service_role;

-- ── 21. fn_billing_asaas_reprocessar_evento: a tela do admin reabre um
-- evento em erro (decisão 20) ──
--
-- Só parte de resultado = 'erro' (billing_evento_nao_esta_em_erro, 22023,
-- para qualquer outro estado). Zera tentativas, limpa erro_codigo e o lease,
-- e proxima_tentativa_em = now(): a próxima rodada de fn_billing_asaas_
-- reservar_eventos já pega o evento de novo. p_actor é recebido para a
-- auditoria do chamador (Tarefa 17, fora desta migration): esta tabela não
-- tem coluna própria para quem pediu o reprocesso (ao contrário de
-- billing_contract_eventos, 0908), então não é gravado aqui, só o log de
-- auditoria da ação do admin registra quem foi (mesmo padrão de p_actor em
-- fn_billing_pedido_marcar, Tarefa 3).
create or replace function public.fn_billing_asaas_reprocessar_evento(p_evento uuid, p_actor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_evento record;
begin
  select * into v_evento
    from public.asaas_webhook_events
    where id = p_evento
    for update;

  if not found then
    raise exception 'billing_evento_nao_encontrado' using errcode = 'P0002';
  end if;

  if v_evento.resultado <> 'erro' then
    raise exception 'billing_evento_nao_esta_em_erro' using errcode = '22023';
  end if;

  update public.asaas_webhook_events
     set resultado = 'aguardando',
         tentativas = 0,
         proxima_tentativa_em = now(),
         erro_codigo = null,
         lease_token = null,
         lease_expira_em = null
   where id = p_evento;

  return jsonb_build_object(
    'evento_id', p_evento,
    'resultado_anterior', v_evento.resultado,
    'resultado_novo', 'aguardando'
  );
end;
$$;

comment on function public.fn_billing_asaas_reprocessar_evento(uuid, uuid) is
  '0909, Tarefa 4, decisão 20: reabre um evento em erro (billing_evento_nao_esta_em_erro, 22023, para qualquer outro resultado). Zera tentativas e proxima_tentativa_em = now(), para a próxima rodada de fn_billing_asaas_reservar_eventos pegar o evento de novo. p_actor recebido para a auditoria do chamador (Tarefa 17, fora desta migration), não gravado por esta função: asaas_webhook_events não tem coluna própria para quem pediu.';

revoke execute on function public.fn_billing_asaas_reprocessar_evento(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_reprocessar_evento(uuid, uuid) to service_role;

-- ── 22. fn_billing_asaas_podar_eventos: a poda de payload (decisão 21, N38)
-- ──
--
-- payload vira '{}' e payload_podado_em recebe now() para todo evento mais
-- velho que p_dias (medido por recebido_em) que ainda não foi podado.
-- Devolve quantos foram podados nesta chamada.
create or replace function public.fn_billing_asaas_podar_eventos(p_dias integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_quantos integer;
begin
  if p_dias is null or p_dias <= 0 then
    raise exception 'billing_dias_invalido' using errcode = '22023';
  end if;

  update public.asaas_webhook_events
     set payload = '{}'::jsonb,
         payload_podado_em = now()
   where payload_podado_em is null
     and recebido_em < now() - (p_dias || ' days')::interval;

  get diagnostics v_quantos = row_count;

  return jsonb_build_object('podados', v_quantos);
end;
$$;

comment on function public.fn_billing_asaas_podar_eventos(integer) is
  '0909, Tarefa 4, decisão 21 (N38): payload vira {} e payload_podado_em recebe now() para todo evento com recebido_em mais velho que p_dias e ainda não podado. Devolve quantos foram podados nesta chamada. p_dias vem da chamada da cron conciliar-asaas (Tarefa 16, fora desta migration; padrão 180 dias).';

revoke execute on function public.fn_billing_asaas_podar_eventos(integer) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_podar_eventos(integer) to service_role;

-- ── 23. agent_worker (se a role existir) perde execute nas seis funções da
-- Tarefa 4, num único bloco condicional (mesmo padrão das seções 7, 8 e 16,
-- acima) ──
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function '
      || 'public.fn_billing_asaas_registrar_evento(text, text, text, text, text, jsonb), '
      || 'public.fn_billing_asaas_reservar_eventos(integer, integer), '
      || 'public.fn_billing_asaas_lease_e_meu(uuid, uuid), '
      || 'public.fn_billing_asaas_registrar_falha(uuid, uuid, text), '
      || 'public.fn_billing_asaas_reprocessar_evento(uuid, uuid), '
      || 'public.fn_billing_asaas_podar_eventos(integer) '
      || 'from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- PARTE 5 (Tarefa 5): pagamento, período, troca de plano, pacote.
-- ============================================================================
--
-- Quatro peças da Tarefa 5 da fase F5 (hiperbold/planos/fase-F5-tarefas.md):
-- fn_billing_asaas_periodo_do_ciclo (decisão 5, cálculo puro do período a
-- partir do dueDate confirmado); fn_billing_asaas_rotear_pagamento (o
-- roteamento da decisão 6, sem trava nenhuma, chamada duas vezes por quem
-- aplica: antes de travar, só para saber qual organização travar, e DEPOIS
-- das travas, decisão 12/B5, para decidir de verdade); fn_billing_asaas_
-- aplicar_pagamento (a função interna que faz o trabalho: cliente, valor,
-- período, troca de plano e pacote, decisões 4 a 8 e 27); fn_billing_asaas_
-- aplicar_evento (a função pública, chamada pelo processador, que confere o
-- lease, decide se o evento é de pagamento confirmado e despacha para
-- aplicar_pagamento dentro de um begin/exception interno, decisão 20).
--
-- Nesta tarefa só os eventos de PAGAMENTO CONFIRMADO são tratados
-- (PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_RECEIVED_IN_CASH, decisão 4).
-- Estorno, chargeback, PAYMENT_OVERDUE, PAYMENT_DELETED e fim de assinatura
-- (decisões 9 e 10) são da Tarefa 6, fora desta migration: o despacho de
-- fn_billing_asaas_aplicar_evento já reconhece esses tipos e devolve
-- ignorado com o código tarefa_6_pendente, para o processador não tratar
-- como falha.
--
-- Contrato do jsonb p_confirmacao (o objeto que a Tarefa 11/13, fora desta
-- migration, devolve depois do GET /payments/{id} confirmado, decisão 3):
--   id                text  (obrigatório, "pay_...")
--   status             text  (obrigatório: CONFIRMED, RECEIVED, RECEIVED_IN_CASH
--                              ou qualquer outro valor que o Asaas devolva)
--   value              numeric (obrigatório)
--   originalValue      numeric ou nulo (decisão 7/M5, valor sem juros e multa)
--   dueDate            date (obrigatório para calcular o período)
--   paymentDate        date ou nulo
--   confirmedDate      date ou nulo
--   customer           text ou nulo ("cus_...")
--   subscription       text ou nulo ("sub_...")
--   externalReference  text ou nulo ("HC:ord:<uuid>" ou outro prefixo)
--   assinatura_status  text ou nulo (decisão 10/M3: só presente numa
--                       renovação quando quem chamou também consultou
--                       GET /subscriptions/{id}; "ACTIVE" desliga
--                       cancel_at_period_end)
--
-- Os alarmes da decisão 7 (divergente_valor) e da decisão 4/A1
-- (pago_fora_do_prazo) ficam numa coluna nova, asaas_webhook_events.alarme
-- (texto livre, vários códigos separados por vírgula quando mais de um se
-- aplica ao mesmo evento): é aqui que a tela do admin (Tarefa 18, fora desta
-- migration) filtra "where alarme is not null" para mostrar o que precisa de
-- atenção, sem precisar reabrir o payload do webhook.
--
-- Mesmo padrão de segurança das peças anteriores desta faixa: security
-- definer, search_path fixo em public, pg_temp. fn_billing_asaas_periodo_do_
-- ciclo, fn_billing_asaas_rotear_pagamento e fn_billing_asaas_aplicar_
-- pagamento são INTERNAS: nenhum grant a ninguém, revoke explícito de
-- public/anon/authenticated E service_role (mesmo racional de fn_billing_
-- asaas_lease_e_meu, Tarefa 4: este banco concede EXECUTE em função nova a
-- service_role por privilégio padrão, achado da Tarefa 4). Só fn_billing_
-- asaas_aplicar_evento tem grant, para service_role. Bloco final revogando
-- de agent_worker (se a role existir) as quatro, num único bloco condicional.

-- ── 24. asaas_webhook_events.alarme: alerta consultável pela tela do admin
-- (decisões 4, 7; "coluna alarme no evento", decisão desta tarefa) ──
alter table public.asaas_webhook_events add column if not exists alarme text;

comment on column public.asaas_webhook_events.alarme is
  '0909, Tarefa 5: código (ou vários, separados por vírgula) que a tela do admin (Tarefa 18, fora desta migration) mostra sem abrir o payload. Valores conhecidos nesta tarefa: divergente_valor (decisão 7, pagamento maior que o esperado) e pago_fora_do_prazo (decisão 4/A1, pedido vencido ou cancelado pago mesmo assim). A Tarefa 6 acrescenta outros (reversão de chargeback, N43). Nulo quando o evento não precisa de atenção.';

-- ── 25. billing_contract_eventos.tipo ganha "plano" (B6: cada mudança de
-- estado, período OU PLANO grava um evento) ──
alter table public.billing_contract_eventos drop constraint if exists billing_contract_eventos_tipo_check;
alter table public.billing_contract_eventos add constraint billing_contract_eventos_tipo_check check (
  tipo in ('estado', 'periodo', 'cancelar_no_fim', 'conferidor', 'plano')
);

comment on column public.billing_contract_eventos.tipo is
  '0908 (revisão F4) + 0909 Tarefa 5 (B6): estado, periodo, cancelar_no_fim, conferidor (0908) e plano (0909, primeiro pagamento de uma assinatura troca billing_contracts.plan_id, decisão 8).';

-- ── 26. fn_billing_asaas_periodo_do_ciclo: cálculo puro do período (decisão
-- 5) ──
--
-- Início = dueDate às 00h de America/Sao_Paulo. Fim = (dueDate + 1 mês ou 1
-- ano, por calendário, com o interval do Postgres, sem nenhum clamp manual:
-- a decisão 5 manda usar "o interval do Postgres", ou seja, o que quer que a
-- aritmética nativa produza no dia 31) + 1 dia, às 00h de SP (limite
-- EXCLUSIVO: o dia a mais evita "pagamento em atraso" no próprio dia da
-- cobrança do cartão). IMMUTABLE: função pura, mesma entrada sempre produz a
-- mesma saída, nunca lê tabela nem now().
create or replace function public.fn_billing_asaas_periodo_do_ciclo(p_due date, p_ciclo text)
returns table (periodo_inicio timestamptz, periodo_fim timestamptz)
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
declare
  v_intervalo interval;
  v_fim_data date;
begin
  if p_due is null then
    raise exception 'billing_due_obrigatorio' using errcode = '22023';
  end if;

  if p_ciclo not in ('monthly', 'yearly') then
    raise exception 'billing_ciclo_invalido' using errcode = '22023';
  end if;

  v_intervalo := case when p_ciclo = 'monthly' then interval '1 month' else interval '1 year' end;
  v_fim_data := (p_due + v_intervalo)::date + 1;

  periodo_inicio := p_due::timestamp at time zone 'America/Sao_Paulo';
  periodo_fim := v_fim_data::timestamp at time zone 'America/Sao_Paulo';
  return next;
end;
$$;

comment on function public.fn_billing_asaas_periodo_do_ciclo(date, text) is
  '0909, Tarefa 5, decisão 5: início = p_due às 00h de America/Sao_Paulo; fim = (p_due + 1 mês ou 1 ano, aritmética NATIVA do Postgres, sem clamp manual) + 1 dia, às 00h de SP (limite exclusivo). Interna: nenhum grant, nem a service_role (revoke explícito abaixo).';

revoke execute on function public.fn_billing_asaas_periodo_do_ciclo(date, text) from public, anon, authenticated, service_role;

-- ── 27. fn_billing_asaas_rotear_pagamento: o roteamento sem trava nenhuma
-- (decisão 6), chamado duas vezes por quem aplica ──
--
-- STABLE, sem select ... for update em lugar nenhum: só lê. (a) por
-- assinatura: pedido NÃO PAGO com o mesmo asaas_subscription_id é o pedido
-- (primeiro pagamento de cartão, ou cada ciclo do Pix anual, decisão 2, que
-- não tem assinatura Asaas de verdade); senão, contrato com o mesmo
-- asaas_subscription_id é renovação. (b) sem assinatura (ou sem achar):
-- externalReference HC:ord:<uuid>, senão asaas_payment_id do pedido. (c)
-- outro prefixo (diferente de HC:) vira outro_app. (d) nada casou vira
-- sem_vinculo. categoria devolvida é uma de: pedido, renovacao, outro_app,
-- sem_vinculo. pedido_tipo (assinatura ou pacote_tokens) só vem preenchido
-- quando categoria = pedido.
create or replace function public.fn_billing_asaas_rotear_pagamento(
  p_ambiente text,
  p_subscription text,
  p_external_reference text,
  p_payment_id text
)
returns table (categoria text, organization_id uuid, pedido_id uuid, pedido_tipo text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pedido record;
  v_contrato record;
  v_id_do_pedido uuid;
begin
  if p_subscription is not null then
    select * into v_pedido
      from public.billing_orders
      where ambiente = p_ambiente and asaas_subscription_id = p_subscription and status <> 'pago'
      order by created_at desc
      limit 1;
    if found then
      categoria := 'pedido';
      organization_id := v_pedido.organization_id;
      pedido_id := v_pedido.id;
      pedido_tipo := v_pedido.tipo;
      return next;
      return;
    end if;

    select * into v_contrato
      from public.billing_contracts
      where asaas_subscription_id = p_subscription;
    if found then
      categoria := 'renovacao';
      organization_id := v_contrato.organization_id;
      pedido_id := null;
      pedido_tipo := null;
      return next;
      return;
    end if;
  end if;

  if p_external_reference is not null and p_external_reference ~ '^HC:ord:' then
    v_id_do_pedido := nullif(substring(p_external_reference from 8), '')::uuid;
    if v_id_do_pedido is not null then
      select * into v_pedido
        from public.billing_orders
        where id = v_id_do_pedido and ambiente = p_ambiente and status <> 'pago';
      if found then
        categoria := 'pedido';
        organization_id := v_pedido.organization_id;
        pedido_id := v_pedido.id;
        pedido_tipo := v_pedido.tipo;
        return next;
        return;
      end if;
    end if;
  end if;

  if p_payment_id is not null then
    select * into v_pedido
      from public.billing_orders
      where ambiente = p_ambiente and asaas_payment_id = p_payment_id and status <> 'pago';
    if found then
      categoria := 'pedido';
      organization_id := v_pedido.organization_id;
      pedido_id := v_pedido.id;
      pedido_tipo := v_pedido.tipo;
      return next;
      return;
    end if;
  end if;

  if p_external_reference is not null and p_external_reference !~ '^HC:' then
    categoria := 'outro_app';
    organization_id := null;
    pedido_id := null;
    pedido_tipo := null;
    return next;
    return;
  end if;

  categoria := 'sem_vinculo';
  organization_id := null;
  pedido_id := null;
  pedido_tipo := null;
  return next;
  return;
end;
$$;

comment on function public.fn_billing_asaas_rotear_pagamento(text, text, text, text) is
  '0909, Tarefa 5, decisão 6: roteia o pagamento confirmado até a organização, sem travar nada (STABLE). Chamado duas vezes por fn_billing_asaas_aplicar_pagamento: antes das travas (só para saber qual organização travar) e DEPOIS das travas (decisão 12/B5, a leitura que vale de verdade). categoria: pedido (primeiro pagamento de assinatura no cartão, cada ciclo do Pix anual, ou pacote de tokens), renovacao (assinatura Asaas de cartão já ativa), outro_app (externalReference de outro prefixo), sem_vinculo (nada casou). Interna: nenhum grant, nem a service_role.';

revoke execute on function public.fn_billing_asaas_rotear_pagamento(text, text, text, text) from public, anon, authenticated, service_role;

-- ── 28. fn_billing_asaas_aplicar_pagamento: o trabalho de verdade (decisões
-- 4 a 8, 12, 26, 27; correções A1, M2, M3, M5, M8, B1, B5, B6, B9) ──
--
-- Ordem: (1) idempotência global por asaas_payment_id, ANTES de qualquer
-- trava (o caminho mais barato para CONFIRMED seguido de RECEIVED, ou o
-- evento sintético conc: reprocessando o Pix anual, decisão 8/B1). (2)
-- roteamento sem trava, só para saber qual organização travar. (3) travas na
-- ordem fixa da decisão 12: billing:<org>, billing_assinatura:<org>, for
-- update no contrato. (4) idempotência de novo, sob a trava (corrida com
-- outra sessão). (5) roteamento REFEITO sob a trava (decisão 12/B5: o
-- estado pode ter mudado enquanto esperava). (6) cliente confirmado tem que
-- casar com billing_customers da MESMA organização e do MESMO ambiente,
-- senão divergente (decisão 6, última frase). (7) valor: coalesce(
-- originalValue, value) (decisão 7/M5); menor que o esperado é divergente
-- (não concede); maior concede com alarme divergente_valor; pedido vencido
-- ou cancelado concede com alarme pago_fora_do_prazo (decisão 4/A1). (8)
-- ORDEM FIXA por categoria (decisão 8/B1): insere em billing_payments
-- PRIMEIRO (dentro de um begin/exception que vira ja_aplicado no unique_
-- violation, mesma trava lógica de fn_billing_registrar_pagamento) e só
-- estende o contrato, credita o pacote ou marca o pedido pago se o insert
-- deu certo. Cada mudança de estado, período ou plano do contrato grava um
-- evento em billing_contract_eventos na MESMA transação (B6, motivo com o
-- prefixo pay_).
create or replace function public.fn_billing_asaas_aplicar_pagamento(p_confirmacao jsonb, p_ambiente text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id text := nullif(p_confirmacao->>'id', '');
  v_status text := p_confirmacao->>'status';
  v_subscription text := nullif(p_confirmacao->>'subscription', '');
  v_external_reference text := nullif(p_confirmacao->>'externalReference', '');
  v_customer text := nullif(p_confirmacao->>'customer', '');
  v_due_date date;
  v_valor_cents bigint;
  v_pago_em timestamptz;
  v_chave uuid;
  v_ja record;
  v_rota record;
  v_org uuid;
  v_contract record;
  v_pedido record;
  v_plano record;
  v_customer_local text;
  v_esperado_cents bigint;
  v_alarmes text[] := array[]::text[];
  v_payment_row_id uuid;
  v_periodo_inicio timestamptz;
  v_periodo_fim timestamptz;
  v_estado_anterior text;
  v_fim_anterior timestamptz;
  v_plan_id_anterior uuid;
  v_cancel_anterior boolean;
  v_novo_fim timestamptz;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if v_payment_id is null then
    raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
  end if;

  if coalesce(v_status, '') not in ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH') then
    raise exception 'billing_status_nao_confirma_pagamento' using errcode = '22023';
  end if;

  v_due_date := nullif(p_confirmacao->>'dueDate', '')::date;
  v_valor_cents := round(coalesce(
    (p_confirmacao->>'originalValue')::numeric,
    (p_confirmacao->>'value')::numeric
  ) * 100);
  v_pago_em := coalesce(
    (nullif(p_confirmacao->>'paymentDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    (nullif(p_confirmacao->>'confirmedDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    now()
  );
  v_chave := md5('HC:asaas:pay:' || v_payment_id)::uuid;

  -- (1) idempotência global, ANTES de qualquer trava (decisão 4/8/B1).
  select id, organization_id, order_id into v_ja
    from public.billing_payments
    where asaas_payment_id = v_payment_id;
  if found then
    return jsonb_build_object(
      'resultado', 'ja_aplicado', 'organization_id', v_ja.organization_id,
      'payment_id', v_ja.id, 'order_id', v_ja.order_id, 'alarmes', '[]'::jsonb
    );
  end if;

  -- (2) roteamento sem trava, só para decidir qual organização travar.
  select * into v_rota
    from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);

  if v_rota.categoria in ('outro_app', 'sem_vinculo') then
    return jsonb_build_object(
      'resultado', v_rota.categoria, 'organization_id', null,
      'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb
    );
  end if;

  v_org := v_rota.organization_id;

  -- (3) travas na ordem fixa da decisão 12.
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_org::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = v_org
    for update;

  if not found then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
  end if;

  -- (4) idempotência de novo, sob a trava.
  select id, organization_id, order_id into v_ja
    from public.billing_payments
    where asaas_payment_id = v_payment_id;
  if found then
    return jsonb_build_object(
      'resultado', 'ja_aplicado', 'organization_id', v_ja.organization_id,
      'payment_id', v_ja.id, 'order_id', v_ja.order_id, 'alarmes', '[]'::jsonb
    );
  end if;

  -- (5) roteamento REFEITO sob a trava (decisão 12/B5).
  select * into v_rota
    from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);

  if v_rota.categoria in ('outro_app', 'sem_vinculo') or v_rota.organization_id is distinct from v_org then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
  end if;

  -- (6) cliente confirmado tem que ser o vinculado a ESTA organização e a
  -- ESTE ambiente (decisão 6, última frase).
  if v_customer is not null then
    select asaas_customer_id into v_customer_local
      from public.billing_customers
      where organization_id = v_org and ambiente = p_ambiente;
    if v_customer_local is distinct from v_customer then
      return jsonb_build_object('resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
    end if;
  end if;

  if v_rota.categoria = 'pedido' then
    select * into v_pedido
      from public.billing_orders
      where id = v_rota.pedido_id
      for update;

    if not found or v_pedido.status = 'pago' then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
    end if;

    -- (7) valor (decisão 7/M5) e prazo (decisão 4/A1).
    v_esperado_cents := v_pedido.amount_cents;
    if v_valor_cents < v_esperado_cents then
      return jsonb_build_object('resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
    end if;
    if v_valor_cents > v_esperado_cents then
      v_alarmes := v_alarmes || 'divergente_valor'::text;
    end if;
    if v_pedido.status not in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando') then
      v_alarmes := v_alarmes || 'pago_fora_do_prazo'::text;
    end if;

    if v_pedido.tipo = 'pacote_tokens' then
      -- (8) pacote de tokens: insere PRIMEIRO (decisão 8/B1), período nulo
      -- (decisão 8, CHECK da 0909 já permite; confere o tipo do pedido aqui
      -- porque o CHECK da tabela não consegue), só credita se inseriu.
      begin
        insert into public.billing_payments (
          organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
          billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
        ) values (
          v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
          null, null, v_chave, 'Asaas: pacote de tokens', null, 'asaas', v_pedido.id
        )
        returning id into v_payment_row_id;
      exception when unique_violation then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
      end;

      perform public.fn_billing_creditar_tokens(v_org, v_pedido.tokens, v_pedido.id, v_pedido.amount_cents, 'Asaas', null);

      update public.billing_orders set status = 'pago', pago_em = now() where id = v_pedido.id;

      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
        'order_id', v_pedido.id, 'alarmes', to_jsonb(v_alarmes)
      );
    end if;

    -- tipo = assinatura: primeiro pagamento de cartão, OU cada ciclo do Pix
    -- anual (decisão 2: Pix não tem assinatura Asaas, cada renovação é um
    -- pedido novo, roteado aqui como categoria=pedido, não renovacao).
    if v_pedido.metodo = 'PIX' and v_pedido.ciclo = 'yearly' then
      -- Decisão 5, regra especial do Pix anual: início = greatest(current_
      -- period_end, paymentDate); fim = início + 1 ano + 1 dia.
      v_periodo_inicio := greatest(v_contract.current_period_end, v_pago_em);
      v_periodo_fim := v_periodo_inicio + interval '1 year' + interval '1 day';
    else
      select periodo_inicio, periodo_fim into v_periodo_inicio, v_periodo_fim
        from public.fn_billing_asaas_periodo_do_ciclo(v_due_date, v_pedido.ciclo);
    end if;

    begin
      insert into public.billing_payments (
        organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
        billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
      ) values (
        v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
        v_periodo_inicio, v_periodo_fim, v_chave, 'Asaas: assinatura', null, 'asaas', v_pedido.id
      )
      returning id into v_payment_row_id;
    exception when unique_violation then
      return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
    end;

    -- Decisão 8: só estende/troca de plano se o insert acima deu certo
    -- (chegamos até aqui, então deu). current_period_end = greatest(atual,
    -- fim), evento velho nunca encurta (decisão 5/B9).
    v_estado_anterior := v_contract.status;
    v_fim_anterior := v_contract.current_period_end;
    v_plan_id_anterior := v_contract.plan_id;
    v_novo_fim := greatest(v_contract.current_period_end, v_periodo_fim);

    update public.billing_contracts
      set plan_id = v_pedido.plan_id,
          cycle = v_pedido.ciclo,
          gateway = 'asaas',
          asaas_subscription_id = coalesce(v_subscription, v_contract.asaas_subscription_id),
          asaas_assinatura_encerrada_em = case when v_subscription is not null then null else v_contract.asaas_assinatura_encerrada_em end,
          cancel_at_period_end = false,
          current_period_start = v_periodo_inicio,
          current_period_end = v_novo_fim,
          status = 'ativa'
      where id = v_contract.id;

    if v_estado_anterior <> 'ativa' then
      insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
      values (v_org, v_contract.id, 'estado', v_estado_anterior, 'ativa', 'pay_primeiro_pagamento', null);
    end if;
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'periodo', v_fim_anterior::text, v_novo_fim::text, 'pay_primeiro_pagamento', null);
    if v_plan_id_anterior is distinct from v_pedido.plan_id then
      insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
      values (v_org, v_contract.id, 'plano', v_plan_id_anterior::text, v_pedido.plan_id::text, 'pay_primeiro_pagamento', null);
    end if;

    update public.billing_orders set status = 'pago', pago_em = now() where id = v_pedido.id;

    return jsonb_build_object(
      'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
      'order_id', v_pedido.id, 'alarmes', to_jsonb(v_alarmes)
    );
  end if;

  -- categoria = renovacao: contrato já com assinatura Asaas de cartão ativa,
  -- sem pedido nenhum envolvido.
  select * into v_plano from public.billing_plans where id = v_contract.plan_id;
  if not found then
    raise exception 'billing_plano_do_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  v_esperado_cents := case when v_contract.cycle = 'yearly' then v_plano.price_yearly_cents else v_plano.price_monthly_cents end;
  if v_esperado_cents is not null and v_valor_cents <> v_esperado_cents then
    v_alarmes := v_alarmes || 'divergente_valor'::text;
  end if;

  select periodo_inicio, periodo_fim into v_periodo_inicio, v_periodo_fim
    from public.fn_billing_asaas_periodo_do_ciclo(v_due_date, coalesce(v_contract.cycle, 'monthly'));

  begin
    insert into public.billing_payments (
      organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
      billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
    ) values (
      v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
      v_periodo_inicio, v_periodo_fim, v_chave, 'Asaas: renovacao', null, 'asaas', null
    )
    returning id into v_payment_row_id;
  exception when unique_violation then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
  end;

  v_estado_anterior := v_contract.status;
  v_fim_anterior := v_contract.current_period_end;
  v_cancel_anterior := v_contract.cancel_at_period_end;
  v_novo_fim := greatest(v_contract.current_period_end, v_periodo_fim);

  update public.billing_contracts
    set current_period_start = greatest(v_contract.current_period_start, v_periodo_inicio),
        current_period_end = v_novo_fim,
        status = 'ativa',
        cancel_at_period_end = case when coalesce(p_confirmacao->>'assinatura_status', '') = 'ACTIVE' then false else cancel_at_period_end end
    where id = v_contract.id;

  if v_estado_anterior <> 'ativa' then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'estado', v_estado_anterior, 'ativa', 'pay_renovacao', null);
  end if;
  insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
  values (v_org, v_contract.id, 'periodo', v_fim_anterior::text, v_novo_fim::text, 'pay_renovacao', null);
  if v_cancel_anterior and coalesce(p_confirmacao->>'assinatura_status', '') = 'ACTIVE' then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', 'true', 'false', 'pay_renovacao', null);
  end if;

  return jsonb_build_object(
    'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
    'order_id', null, 'alarmes', to_jsonb(v_alarmes)
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) is
  '0909, Tarefa 5, decisões 4 a 8, 12, 26, 27 (correções A1, M2, M3, M5, M8, B1, B5, B6, B9): aplica um pagamento CONFIRMADO (p_confirmacao, contrato documentado no comentário da PARTE 5, acima). Idempotência global por asaas_payment_id antes e depois das travas; roteamento (fn_billing_asaas_rotear_pagamento) chamado antes e depois das travas (decisão 12/B5); travas billing:<org>, billing_assinatura:<org>, for update no contrato (decisão 12); cliente divergente ou valor menor que o esperado não concedem (divergente); valor maior concede com alarme divergente_valor; pedido vencido/cancelado concede com alarme pago_fora_do_prazo; ORDEM FIXA insere billing_payments antes de estender o contrato, creditar o pacote ou marcar o pedido pago (decisão 8/B1); cada mudança de estado, período ou plano grava billing_contract_eventos na mesma transação (B6). Interna: nenhum grant, nem a service_role.';

revoke execute on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) from public, anon, authenticated, service_role;

-- ── 29. fn_billing_asaas_aplicar_evento: a função pública, chamada pelo
-- processador (decisão 20, begin/exception interno) ──
--
-- Confere o lease (fn_billing_asaas_lease_e_meu, Tarefa 4), decide pelo
-- event_type se é um evento de PAGAMENTO CONFIRMADO desta tarefa, e despacha
-- para fn_billing_asaas_aplicar_pagamento dentro de um begin/exception
-- interno: uma falha ali grava resultado=erro SEM desfazer o registro do
-- evento (o insert de fn_billing_asaas_registrar_evento já está commitado
-- numa chamada anterior) nem propagar a exceção para o chamador (decisão
-- 20). Evento de dinheiro sem p_confirmacao, ou cuja confirmação não é um
-- status de pagamento liquidado, fica aguardando (decisão 3). Estorno,
-- chargeback, PAYMENT_OVERDUE, PAYMENT_DELETED e fim de assinatura (Tarefa
-- 6) devolvem ignorado com o código tarefa_6_pendente; qualquer outro tipo
-- (PAYMENT_CREATED, SUBSCRIPTION_CREATED, CHECKOUT_*, etc.) só fica
-- registrado (decisão 10), ignorado sem código.
create or replace function public.fn_billing_asaas_aplicar_evento(p_evento uuid, p_lease_token uuid, p_confirmacao jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_evento record;
  v_resultado text;
  v_erro_codigo text;
  v_organization_id uuid;
  v_alarme text;
  v_aplicacao jsonb;
begin
  select * into v_evento
    from public.asaas_webhook_events
    where id = p_evento
    for update;

  if not found then
    raise exception 'billing_evento_nao_encontrado' using errcode = 'P0002';
  end if;

  if not public.fn_billing_asaas_lease_e_meu(p_evento, p_lease_token) then
    raise exception 'billing_lease_invalido' using errcode = '22023';
  end if;

  if v_evento.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH') then
    if p_confirmacao is null then
      v_resultado := 'aguardando';
      v_erro_codigo := 'billing_confirmacao_ausente';
      v_organization_id := null;
      v_alarme := null;
    elsif coalesce(p_confirmacao->>'status', '') not in ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH') then
      v_resultado := 'aguardando';
      v_erro_codigo := 'billing_status_confirmado_nao_e_pagamento';
      v_organization_id := null;
      v_alarme := null;
    else
      begin
        v_aplicacao := public.fn_billing_asaas_aplicar_pagamento(p_confirmacao, v_evento.ambiente);
        v_resultado := v_aplicacao->>'resultado';
        v_organization_id := nullif(v_aplicacao->>'organization_id', '')::uuid;
        v_alarme := case
          when jsonb_typeof(v_aplicacao->'alarmes') = 'array' and jsonb_array_length(v_aplicacao->'alarmes') > 0
            then (select string_agg(value, ',') from jsonb_array_elements_text(v_aplicacao->'alarmes'))
          else null
        end;
        v_erro_codigo := null;
      exception when others then
        v_resultado := 'erro';
        v_erro_codigo := left(sqlerrm, 200);
        v_organization_id := null;
        v_alarme := null;
      end;
    end if;
  elsif v_evento.event_type in (
    'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED',
    'PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED',
    'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED'
  ) then
    v_resultado := 'ignorado';
    v_erro_codigo := 'tarefa_6_pendente';
    v_organization_id := null;
    v_alarme := null;
  else
    v_resultado := 'ignorado';
    v_erro_codigo := null;
    v_organization_id := null;
    v_alarme := null;
  end if;

  update public.asaas_webhook_events
     set resultado = v_resultado,
         erro_codigo = v_erro_codigo,
         organization_id = coalesce(v_organization_id, organization_id),
         alarme = v_alarme,
         processado_em = now(),
         lease_token = null,
         lease_expira_em = null
   where id = p_evento;

  return jsonb_build_object(
    'evento_id', p_evento,
    'resultado', v_resultado,
    'organization_id', v_organization_id,
    'alarme', v_alarme
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_evento(uuid, uuid, jsonb) is
  '0909, Tarefa 5, decisão 20: confere o lease (fn_billing_asaas_lease_e_meu) e recusa gravar se não for mais o do chamador (billing_lease_invalido). Despacha por event_type: PAYMENT_CONFIRMED/PAYMENT_RECEIVED/PAYMENT_RECEIVED_IN_CASH chamam fn_billing_asaas_aplicar_pagamento dentro de um begin/exception interno (uma falha vira resultado=erro sem propagar a exceção nem desfazer o registro do evento); sem p_confirmacao, ou com p_confirmacao fora de um status de pagamento liquidado, fica aguardando; estorno/chargeback/PAYMENT_OVERDUE/PAYMENT_DELETED/fim de assinatura (Tarefa 6) viram ignorado com o código tarefa_6_pendente; qualquer outro tipo só fica registrado (ignorado, decisão 10). Grava resultado, erro_codigo, organization_id, alarme e processado_em, e libera o lease.';

revoke execute on function public.fn_billing_asaas_aplicar_evento(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_aplicar_evento(uuid, uuid, jsonb) to service_role;

-- ── 30. agent_worker (se a role existir) perde execute nas quatro peças da
-- Tarefa 5, num único bloco condicional (mesmo padrão das seções 16 e 23,
-- acima) ──
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function '
      || 'public.fn_billing_asaas_periodo_do_ciclo(date, text), '
      || 'public.fn_billing_asaas_rotear_pagamento(text, text, text, text), '
      || 'public.fn_billing_asaas_aplicar_pagamento(jsonb, text), '
      || 'public.fn_billing_asaas_aplicar_evento(uuid, uuid, jsonb) '
      || 'from agent_worker';
  end if;
end
$$;
