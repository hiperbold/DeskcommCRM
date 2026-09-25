-- 0909, cobrança pelo Asaas: tabelas (fase F5, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F5-tarefas.md, decisões 4 a 12, 22 e 25, e nas
-- decisões 1 a 27 do plano mestre (hiperbold/planos/2026-09-22-planos-e-
-- assinatura.md). Contrato comum: F:\github-projects\hiper-track\docs\manual-
-- api-asaas-saas.md.
--
-- Esta migration (0909) traz as Tarefas 1 a 6 da fase: o SCHEMA (tabelas,
-- colunas, checks, índices), o gatilho/grants das três tabelas novas, o
-- pedido/cliente/chaves, o registro/reserva/falha/reprocesso/poda do webhook,
-- a aplicação do pagamento confirmado (período, troca de plano, pacote de
-- tokens) e a aplicação de estorno, chargeback, fim de assinatura e remoção
-- de pedido avulso (decisões 9, 10, 22 e 23, mais a recriação de
-- fn_billing_estornar_pagamento e fn_billing_mudar_estado da 0908, correções
-- B2 e M4). Nenhuma chamada real ao Asaas acontece aqui nem em nenhuma parte
-- desta fase (restrição fixa 1 do plano da fase).
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

-- Correção (revisão F5, item 10): o ambiente (sandbox/producao) da
-- assinatura Asaas do contrato, gravado no PRIMEIRO PAGAMENTO junto com
-- asaas_subscription_id (fn_billing_asaas_aplicar_pagamento, PARTE 7,
-- abaixo). fn_billing_asaas_rotear_pagamento (PARTE 7) só casa uma
-- renovação com o contrato do MESMO ambiente do evento: sandbox e produção
-- nunca compartilham assinatura, mesmo racional de billing_customers
-- (ambiente, asaas_customer_id) único, decisão 6.
alter table public.billing_contracts add column if not exists asaas_ambiente text;

alter table public.billing_contracts drop constraint if exists billing_contracts_asaas_ambiente_check;
alter table public.billing_contracts add constraint billing_contracts_asaas_ambiente_check check (
  asaas_ambiente is null or asaas_ambiente in ('sandbox', 'producao')
);

comment on column public.billing_contracts.asaas_ambiente is
  '0909, correção (revisão F5, item 10): ambiente da assinatura Asaas do contrato, gravado no primeiro pagamento junto com asaas_subscription_id. Nulo enquanto o contrato nunca teve assinatura Asaas. fn_billing_asaas_rotear_pagamento exige asaas_ambiente = ambiente do evento para casar uma renovação: um evento de sandbox nunca casa com contrato de produção, nem o contrário.';

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

-- Correção (revisão F5, item 11): sandbox nunca concede acesso numa
-- instalação de PRODUÇÃO. Nasce false: uma instalação de HOMOLOGAÇÃO (uso
-- interno, para testar o fluxo inteiro no sandbox do Asaas) liga esta chave
-- à mão; a instalação real de um cliente nunca liga. fn_billing_asaas_
-- aplicar_pagamento (PARTE 7, abaixo) confere esta chave ANTES de qualquer
-- idempotência ou trava: um pagamento de ambiente=sandbox nunca toca em
-- contrato nem em tokens quando ela está desligada.
alter table public.billing_settings add column if not exists asaas_sandbox_concede boolean not null default false;

comment on column public.billing_settings.asaas_sandbox_concede is
  '0909, correção (revisão F5, item 11): liga a concessão de acesso por pagamento CONFIRMADO no AMBIENTE SANDBOX. Nasce false: só liga na instalação de homologação (documente isso no README/HANDOFF de quem ligar), nunca numa instalação de produção real. fn_billing_asaas_aplicar_pagamento recusa (resultado=ignorado, erro_codigo=sandbox_nao_concede) todo pagamento de sandbox enquanto esta chave estiver desligada.';

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

-- ============================================================================
-- PARTE 6 (Tarefa 6): estorno, chargeback, fim de assinatura, remoção.
-- ============================================================================
--
-- Quatro peças da Tarefa 6 da fase F5 (hiperbold/planos/fase-F5-tarefas.md,
-- decisões 9, 10, 22 e 23; correções M1, M2, M3, M4, B2, B4, B8):
-- fn_billing_asaas_aplicar_estorno (interna, sem grant: estorno, chargeback,
-- estorno parcial e reversão de chargeback, decisão 9); fn_billing_asaas_
-- aplicar_fim_da_assinatura (interna, sem grant: fim/remoção de assinatura e
-- de pedido avulso, decisão 10); fn_billing_asaas_aplicar_evento (redefinida
-- para despachar as duas funções acima no lugar do código tarefa_6_pendente
-- da Tarefa 5); fn_billing_asaas_marcar_assinatura_encerrada (pública, só
-- service_role: o serviço de compra chama depois de um DELETE bem sucedido
-- feito pelo próprio CRM, decisão 22). Mais duas recriações da 0908 (B2, M4):
-- fn_billing_estornar_pagamento (exige origem = manual) e fn_billing_mudar_
-- estado (recusa cancelada manual com assinatura Asaas viva).
--
-- Contrato do jsonb p_confirmacao de fn_billing_asaas_aplicar_estorno (o
-- objeto que o GET /payments/{id} confirmado devolve, decisão 3, mesmo molde
-- da Tarefa 5):
--   id                text  (obrigatório, "pay_...", o MESMO id do pagamento
--                             original: o Asaas representa o estorno como
--                             MUDANÇA DE STATUS do mesmo objeto, não um
--                             objeto novo)
--   status             text  (o que o GET devolveu; não é usado para decidir
--                              o resultado, quem decide é o event_type)
--   value              numeric (obrigatório)
--   originalValue      numeric ou nulo (decisão 7/M5, mesmo racional da
--                              Tarefa 5)
--   paymentDate        date ou nulo
--   confirmedDate      date ou nulo
--   subscription       text ou nulo ("sub_..."), para o roteamento quando não
--                              existe linha original local
--   externalReference  text ou nulo ("HC:ord:<uuid>" ou outro prefixo), idem
--
-- Contrato do jsonb p_confirmacao de fn_billing_asaas_aplicar_fim_da_
-- assinatura, dois formatos conforme o event_type:
--   PAYMENT_OVERDUE / PAYMENT_DELETED (o mesmo GET /payments/{id} da Tarefa
--   5, mais o marcador de remoção):
--     id                text     (obrigatório, "pay_...")
--     status             text     (obrigatório para PAYMENT_OVERDUE: só
--                                   confirma quando igual a "OVERDUE")
--     removida           boolean  (obrigatório para PAYMENT_DELETED: true
--                                   quando o GET confirmou a remoção, 404 ou
--                                   deleted:true, decisão 10)
--     subscription/externalReference  iguais à Tarefa 5, para o roteamento
--   SUBSCRIPTION_DELETED / SUBSCRIPTION_INACTIVATED / SUBSCRIPTION_UPDATED
--   (o GET /subscriptions/{id} confirmado):
--     id                text     (obrigatório, "sub_...")
--     status             text ou nulo (o que o GET devolveu quando achou o
--                                       objeto; ACTIVE/INACTIVE/etc; nulo
--                                       quando removida = true)
--     removida           boolean  (true quando o GET confirmou 404 ou
--                                   deleted:true, decisão 10/22; a fonte da
--                                   verdade da remoção, qualquer que seja o
--                                   event_type que disparou a checagem)
--
-- Mesmo padrão de segurança das peças anteriores desta faixa: security
-- definer, search_path fixo em public, pg_temp. fn_billing_asaas_aplicar_
-- estorno e fn_billing_asaas_aplicar_fim_da_assinatura são INTERNAS: nenhum
-- grant a ninguém, revoke explícito de public/anon/authenticated E
-- service_role (mesmo racional de fn_billing_asaas_lease_e_meu e das peças
-- internas da Tarefa 5: este banco concede EXECUTE em função nova a
-- service_role por privilégio padrão). fn_billing_asaas_aplicar_evento e
-- fn_billing_asaas_marcar_assinatura_encerrada têm grant só para
-- service_role. Bloco final revogando de agent_worker (se a role existir).
--
-- Lógica de três valores: toda condição booleana que envolve coluna nula usa
-- coalesce ou "is not distinct from" (HANDOFF item 14).

-- ── 31. fn_billing_asaas_aplicar_estorno: estorno, chargeback, estorno
-- parcial e reversão de chargeback (decisão 9, N31, N32, N43) ──
--
-- PAYMENT_PARTIALLY_REFUNDED e PAYMENT_AWAITING_CHARGEBACK_REVERSAL só
-- registram um alarme na tela do admin, sem tocar em billing_payments nem em
-- billing_orders (N43: o admin decide, nada volta sozinho). PAYMENT_REFUNDED
-- e PAYMENT_CHARGEBACK_REQUESTED gravam uma linha NOVA em billing_payments
-- (REFUNDED ou CHARGEBACK_REQUESTED), com estorna_pagamento_id apontando para
-- o pagamento ORIGINAL e SEM asaas_payment_id (o índice único de asaas_
-- payment_id já usa este mesmo id na linha ORIGINAL; period NULO, decisão 9:
-- não mexe em período nem em tokens). A chave inclui o status (diferente de
-- "md5('HC:asaas:refund:' || id)" da decisão 9 tal e qual): um chargeback
-- seguido de um estorno de verdade para o MESMO pagamento não pode colidir no
-- único (organization_id, chave) de billing_payments (0908) com a MESMA
-- chave para dois status diferentes; a decisão 9 já separa os dois pelo
-- índice de estorna_pagamento_id (só para REFUNDED), este é o mesmo
-- raciocínio aplicado à chave. M2: quando o objeto confirmado já chega
-- estornado e a linha original não existe localmente, grava o ORIGINAL sem
-- conceder (nenhum update em billing_contracts, nenhum crédito de tokens,
-- pago com o mesmo cálculo de valor/data da Tarefa 5) e o estorno na MESMA
-- transação.
create or replace function public.fn_billing_asaas_aplicar_estorno(p_evento_tipo text, p_confirmacao jsonb, p_ambiente text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id text := nullif(p_confirmacao->>'id', '');
  v_subscription text := nullif(p_confirmacao->>'subscription', '');
  v_external_reference text := nullif(p_confirmacao->>'externalReference', '');
  v_valor_cents bigint;
  v_pago_em timestamptz;
  v_rota record;
  v_org uuid;
  v_contract_id uuid;
  v_original record;
  v_original_id uuid;
  v_pedido_id uuid;
  v_status_novo text;
  v_chave_estorno uuid;
  v_chave_original uuid;
  v_estorno_id uuid;
  v_alarme text;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if v_payment_id is null then
    raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
  end if;

  -- N43/decisão 9: reversão de chargeback e estorno parcial só alarmam.
  if p_evento_tipo in ('PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    select organization_id into v_org from public.billing_payments where asaas_payment_id = v_payment_id limit 1;
    if v_org is null then
      select * into v_rota from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);
      if v_rota.categoria in ('pedido', 'renovacao') then
        v_org := v_rota.organization_id;
      end if;
    end if;
    v_alarme := case p_evento_tipo
      when 'PAYMENT_PARTIALLY_REFUNDED' then 'parcialmente_estornado'
      else 'reversao_de_chargeback'
    end;
    return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarme', v_alarme);
  end if;

  if p_evento_tipo not in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
    raise exception 'billing_evento_tipo_invalido' using errcode = '22023';
  end if;

  v_status_novo := case p_evento_tipo when 'PAYMENT_REFUNDED' then 'REFUNDED' else 'CHARGEBACK_REQUESTED' end;
  v_valor_cents := round(coalesce(
    (p_confirmacao->>'originalValue')::numeric,
    (p_confirmacao->>'value')::numeric
  ) * 100);
  v_pago_em := coalesce(
    (nullif(p_confirmacao->>'paymentDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    (nullif(p_confirmacao->>'confirmedDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    now()
  );
  v_chave_estorno := md5('HC:asaas:refund:' || v_payment_id || ':' || v_status_novo)::uuid;
  v_chave_original := md5('HC:asaas:pay:' || v_payment_id)::uuid;

  -- (1) idempotência do estorno, ANTES de qualquer trava (mesmo padrão da
  -- Tarefa 5, decisão 4/8/B1).
  select id, organization_id, order_id into v_estorno_id, v_org, v_pedido_id
    from public.billing_payments where chave = v_chave_estorno and status = v_status_novo;
  if v_estorno_id is not null then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id, 'alarme', null);
  end if;

  -- (2) acha o pagamento ORIGINAL (se existir localmente) para saber a
  -- organização, sem trava nenhuma ainda.
  select * into v_original from public.billing_payments where asaas_payment_id = v_payment_id order by created_at asc limit 1;

  if found then
    v_org := v_original.organization_id;
  else
    select * into v_rota from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);
    if v_rota.categoria in ('outro_app', 'sem_vinculo') then
      return jsonb_build_object('resultado', v_rota.categoria, 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null);
    end if;
    v_org := v_rota.organization_id;
  end if;

  -- (3) travas na ordem fixa da decisão 12.
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_org::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org::text, 0));

  -- (4) idempotência de novo, sob a trava.
  select id, order_id into v_estorno_id, v_pedido_id
    from public.billing_payments where chave = v_chave_estorno and status = v_status_novo;
  if v_estorno_id is not null then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id, 'alarme', null);
  end if;

  -- (5) releitura do original SOB a trava (decisão 12/B5: o estado pode ter
  -- mudado enquanto esperava).
  select * into v_original from public.billing_payments where asaas_payment_id = v_payment_id order by created_at asc limit 1;

  if found then
    v_original_id := v_original.id;
    v_pedido_id := v_original.order_id;
    v_contract_id := v_original.contract_id;
  else
    -- M2: objeto confirmado já chega estornado, sem linha original gravada.
    -- Roteia de novo (decisão 12/B5), grava o ORIGINAL sem conceder e o
    -- estorno na MESMA transação.
    select * into v_rota from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);
    if v_rota.categoria in ('outro_app', 'sem_vinculo') or v_rota.organization_id is distinct from v_org then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarme', null);
    end if;
    if v_rota.categoria = 'pedido' then
      v_pedido_id := v_rota.pedido_id;
    end if;

    select id into v_contract_id from public.billing_contracts where organization_id = v_org;
    if v_contract_id is null then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarme', null);
    end if;

    begin
      insert into public.billing_payments (
        organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
        billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
      ) values (
        v_org, v_contract_id, v_payment_id, v_valor_cents, 'RECEIVED', v_pago_em,
        null, null, v_chave_original, 'Asaas: original reconstituido pelo estorno (M2)', null, 'asaas', v_pedido_id
      )
      returning id into v_original_id;
    exception when unique_violation then
      select id, order_id, contract_id into v_original_id, v_pedido_id, v_contract_id
        from public.billing_payments where asaas_payment_id = v_payment_id;
    end;
  end if;

  -- (6) o estorno em si: linha NOVA, sem asaas_payment_id, período NULO
  -- (decisão 9: não mexe em período nem em tokens).
  begin
    insert into public.billing_payments (
      organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
      billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id,
      estorna_pagamento_id
    ) values (
      v_org, v_contract_id, null, v_valor_cents, v_status_novo, now(),
      null, null, v_chave_estorno, 'Asaas: ' || lower(v_status_novo), null, 'asaas', v_pedido_id,
      v_original_id
    )
    returning id into v_estorno_id;
  exception when unique_violation then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido_id, 'alarme', null);
  end;

  -- decisão 9: o pedido passa a estornado. Não mexe em billing_contracts.
  if v_pedido_id is not null then
    update public.billing_orders set status = 'estornado' where id = v_pedido_id and status <> 'estornado';
  end if;

  return jsonb_build_object(
    'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id,
    'alarme', case p_evento_tipo when 'PAYMENT_REFUNDED' then 'estorno_confirmado' else 'chargeback_confirmado' end
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_estorno(text, jsonb, text) is
  '0909, Tarefa 6, decisão 9 (N31, N32, N43, correção M2): PAYMENT_PARTIALLY_REFUNDED e PAYMENT_AWAITING_CHARGEBACK_REVERSAL só alarmam (parcialmente_estornado, reversao_de_chargeback), sem tocar em billing_payments nem em billing_orders. PAYMENT_REFUNDED e PAYMENT_CHARGEBACK_REQUESTED gravam uma linha NOVA (REFUNDED ou CHARGEBACK_REQUESTED) com estorna_pagamento_id do original e SEM asaas_payment_id, período NULO (nunca mexe em período nem em tokens); o pedido (se houver) passa a estornado. Chave inclui o status (md5(HC:asaas:refund:<id>:<status>)) para um chargeback e um estorno de verdade do MESMO pagamento conviverem sem colidir no único (organization_id, chave). M2: sem linha original local, roteia, grava o original SEM CONCEDER e o estorno na MESMA transação. Interna: nenhum grant, nem a service_role.';

revoke execute on function public.fn_billing_asaas_aplicar_estorno(text, jsonb, text) from public, anon, authenticated, service_role;

-- ── 32. fn_billing_asaas_aplicar_fim_da_assinatura: fim/remoção de
-- assinatura e de pedido avulso (decisão 10, 22; N39) ──
--
-- PAYMENT_OVERDUE/PAYMENT_DELETED: roteia como a Tarefa 5 (sem trava,
-- STABLE), marca o PEDIDO (vencido ou cancelado); não mexe no contrato (quem
-- atrasa/suspende é o conferidor da F4, decisão 10). SUBSCRIPTION_DELETED/
-- SUBSCRIPTION_INACTIVATED/SUBSCRIPTION_UPDATED: acha o contrato pelo
-- asaas_subscription_id, trava na ordem fixa (decisão 12), liga cancel_at_
-- period_end sempre que confirmado, grava o marcador asaas_assinatura_
-- encerrada_em só quando DELETED ou removida = true (M3: INACTIVE puro é
-- reversível), cancela pedido aberto daquela assinatura. SUBSCRIPTION_UPDATED
-- com status ACTIVE confirmado desliga cancel_at_period_end (M3).
create or replace function public.fn_billing_asaas_aplicar_fim_da_assinatura(p_evento_tipo text, p_confirmacao jsonb, p_ambiente text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id text;
  v_subscription_id text;
  v_status text;
  v_removida boolean;
  v_rota record;
  v_org uuid;
  v_org_pre uuid;
  v_pedido record;
  v_contract record;
  v_cancel_anterior boolean;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if p_evento_tipo in ('PAYMENT_OVERDUE', 'PAYMENT_DELETED') then
    v_payment_id := nullif(p_confirmacao->>'id', '');
    if v_payment_id is null then
      raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
    end if;

    if p_evento_tipo = 'PAYMENT_OVERDUE' then
      if coalesce(p_confirmacao->>'status', '') <> 'OVERDUE' then
        return jsonb_build_object('resultado', 'aguardando', 'organization_id', null, 'order_id', null, 'alarme', null);
      end if;
    else
      v_removida := coalesce((p_confirmacao->>'removida')::boolean, false);
      if not v_removida then
        return jsonb_build_object('resultado', 'aguardando', 'organization_id', null, 'order_id', null, 'alarme', null);
      end if;
    end if;

    select * into v_rota from public.fn_billing_asaas_rotear_pagamento(
      p_ambiente, nullif(p_confirmacao->>'subscription', ''), nullif(p_confirmacao->>'externalReference', ''), v_payment_id
    );

    if v_rota.categoria <> 'pedido' then
      return jsonb_build_object('resultado', v_rota.categoria, 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null);
    end if;

    select * into v_pedido from public.billing_orders where id = v_rota.pedido_id for update;
    if not found or v_pedido.status = 'pago' then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null);
    end if;

    if p_evento_tipo = 'PAYMENT_OVERDUE' then
      if v_pedido.status = 'vencido' then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null);
      end if;
      update public.billing_orders set status = 'vencido' where id = v_pedido.id;
      -- A1: o alarme avisa o processador (Tarefa 13, fora desta migration)
      -- para remover a cobrança no Asaas antes de um pedido novo poder
      -- nascer (decisão 10, decisão 11 do pedido aberto único).
      return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', 'remover_cobranca_pendente');
    else
      if v_pedido.status = 'cancelado' then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null);
      end if;
      update public.billing_orders set status = 'cancelado' where id = v_pedido.id;
      return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null);
    end if;
  end if;

  if p_evento_tipo not in ('SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED') then
    raise exception 'billing_evento_tipo_invalido' using errcode = '22023';
  end if;

  v_subscription_id := nullif(p_confirmacao->>'id', '');
  if v_subscription_id is null then
    raise exception 'billing_subscription_id_obrigatorio' using errcode = '22023';
  end if;

  select organization_id into v_org_pre from public.billing_contracts where asaas_subscription_id = v_subscription_id;
  if v_org_pre is null then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', null, 'order_id', null, 'alarme', null);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_org_pre::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org_pre::text, 0));

  select * into v_contract from public.billing_contracts where organization_id = v_org_pre for update;
  if not found or v_contract.asaas_subscription_id is distinct from v_subscription_id then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org_pre, 'order_id', null, 'alarme', null);
  end if;

  v_org := v_contract.organization_id;
  v_status := nullif(p_confirmacao->>'status', '');

  if p_evento_tipo = 'SUBSCRIPTION_UPDATED' then
    if coalesce(v_status, '') <> 'ACTIVE' then
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
    end if;
    if not coalesce(v_contract.cancel_at_period_end, false) then
      return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
    end if;
    update public.billing_contracts set cancel_at_period_end = false where id = v_contract.id;
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', 'true', 'false', 'sub_updated_active', null);
    return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
  end if;

  v_removida := coalesce((p_confirmacao->>'removida')::boolean, false);

  if p_evento_tipo = 'SUBSCRIPTION_DELETED' and not v_removida then
    return jsonb_build_object('resultado', 'aguardando', 'organization_id', v_org, 'order_id', null, 'alarme', null);
  end if;

  if p_evento_tipo = 'SUBSCRIPTION_INACTIVATED' and not v_removida and coalesce(v_status, '') <> 'INACTIVE' then
    return jsonb_build_object('resultado', 'aguardando', 'organization_id', v_org, 'order_id', null, 'alarme', null);
  end if;

  -- confirmado: liga cancel_at_period_end sempre; grava o marcador (decisão
  -- 22) só quando DELETED ou removida = true (M3: INACTIVE puro não marca).
  v_cancel_anterior := coalesce(v_contract.cancel_at_period_end, false);

  update public.billing_contracts
     set cancel_at_period_end = true,
         asaas_assinatura_encerrada_em = case
           when p_evento_tipo = 'SUBSCRIPTION_DELETED' or v_removida then coalesce(v_contract.asaas_assinatura_encerrada_em, now())
           else v_contract.asaas_assinatura_encerrada_em
         end
   where id = v_contract.id;

  if not v_cancel_anterior then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', v_cancel_anterior::text, 'true',
      case when p_evento_tipo = 'SUBSCRIPTION_DELETED' then 'sub_deletada' else 'sub_inativada' end, null);
  end if;

  update public.billing_orders
     set status = 'cancelado'
   where organization_id = v_org
     and asaas_subscription_id = v_subscription_id
     and status in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando');

  return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
end;
$$;

comment on function public.fn_billing_asaas_aplicar_fim_da_assinatura(text, jsonb, text) is
  '0909, Tarefa 6, decisões 10 e 22 (N39): PAYMENT_OVERDUE marca o pedido avulso vencido com o alarme remover_cobranca_pendente (A1); PAYMENT_DELETED confirmado (removida = true) cancela o pedido; nenhum dos dois mexe no contrato. SUBSCRIPTION_DELETED/SUBSCRIPTION_INACTIVATED confirmados ligam cancel_at_period_end e cancelam pedido aberto daquela assinatura; o marcador asaas_assinatura_encerrada_em só é gravado quando DELETED ou removida = true (404/deleted:true no GET, M3: INACTIVE puro é reversível e não marca). SUBSCRIPTION_UPDATED com status ACTIVE confirmado desliga cancel_at_period_end (M3). Interna: nenhum grant, nem a service_role.';

revoke execute on function public.fn_billing_asaas_aplicar_fim_da_assinatura(text, jsonb, text) from public, anon, authenticated, service_role;

-- ── 33. fn_billing_asaas_aplicar_evento: REDEFINIDA para despachar estorno,
-- chargeback e fim de assinatura no lugar do código tarefa_6_pendente da
-- Tarefa 5 ──
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
  v_tentativas integer;
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

  -- M8 (Tarefa 6, correção pedida depois do processador pronto): o pré-
  -- roteamento sem GET (decisão 6) já decidiu "outro_app" olhando só o
  -- payload, sem gastar GET nenhum. O processador (lib/billing/asaas/
  -- processar-eventos.ts, fora desta migration) chama esta função com o
  -- SENTINELA p_confirmacao = {"pre_roteamento":"outro_app"} (nenhum outro
  -- campo) em vez de null: sem este ramo, o evento ficava aguardando para
  -- sempre e voltava a ser reservado a cada minuto (o mesmo defeito do
  -- aguardando sem backoff, corrigido abaixo). Comparação por igualdade
  -- estrutural de jsonb (chave/valor, não texto): qualquer campo a mais no
  -- objeto NÃO casa com o sentinela.
  if p_confirmacao is not null and p_confirmacao = '{"pre_roteamento":"outro_app"}'::jsonb then
    v_resultado := 'outro_app';
    v_erro_codigo := null;
    v_organization_id := null;
    v_alarme := null;
  elsif v_evento.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH') then
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
    'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL'
  ) then
    if p_confirmacao is null then
      v_resultado := 'aguardando';
      v_erro_codigo := 'billing_confirmacao_ausente';
      v_organization_id := null;
      v_alarme := null;
    else
      begin
        v_aplicacao := public.fn_billing_asaas_aplicar_estorno(v_evento.event_type, p_confirmacao, v_evento.ambiente);
        v_resultado := v_aplicacao->>'resultado';
        v_organization_id := nullif(v_aplicacao->>'organization_id', '')::uuid;
        v_alarme := nullif(v_aplicacao->>'alarme', '');
        v_erro_codigo := null;
      exception when others then
        v_resultado := 'erro';
        v_erro_codigo := left(sqlerrm, 200);
        v_organization_id := null;
        v_alarme := null;
      end;
    end if;
  elsif v_evento.event_type in (
    'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED'
  ) then
    if p_confirmacao is null then
      v_resultado := 'aguardando';
      v_erro_codigo := 'billing_confirmacao_ausente';
      v_organization_id := null;
      v_alarme := null;
    else
      begin
        v_aplicacao := public.fn_billing_asaas_aplicar_fim_da_assinatura(v_evento.event_type, p_confirmacao, v_evento.ambiente);
        v_resultado := v_aplicacao->>'resultado';
        v_organization_id := nullif(v_aplicacao->>'organization_id', '')::uuid;
        v_alarme := nullif(v_aplicacao->>'alarme', '');
        v_erro_codigo := null;
      exception when others then
        v_resultado := 'erro';
        v_erro_codigo := left(sqlerrm, 200);
        v_organization_id := null;
        v_alarme := null;
      end;
    end if;
  else
    v_resultado := 'ignorado';
    v_erro_codigo := null;
    v_organization_id := null;
    v_alarme := null;
  end if;

  -- M8: aguardando NÃO pode ser reservado de novo a cada minuto sem limite
  -- (o mesmo backoff de fn_billing_asaas_registrar_falha, Tarefa 4, decisão
  -- 20, reaproveitando a MESMA coluna tentativas): tentativas + 1; até a
  -- nona continua aguardando com backoff now() + least(2^tentativas
  -- minutos, 6 horas); na décima vira erro, visível ao admin. Qualquer outro
  -- resultado (aplicado, ja_aplicado, divergente, outro_app, sem_vinculo,
  -- ignorado, erro) é terminal: tentativas fica como está (histórico) e
  -- proxima_tentativa_em volta a null (o evento já não está no índice dos
  -- pendentes, que exige resultado = aguardando).
  if v_resultado = 'aguardando' then
    v_tentativas := v_evento.tentativas + 1;
    if v_tentativas >= 10 then
      v_resultado := 'erro';
      v_erro_codigo := coalesce(v_erro_codigo, 'billing_aguardando_sem_confirmacao_apos_10_tentativas');
    end if;
  else
    v_tentativas := v_evento.tentativas;
  end if;

  update public.asaas_webhook_events
     set resultado = v_resultado,
         erro_codigo = v_erro_codigo,
         organization_id = coalesce(v_organization_id, organization_id),
         alarme = v_alarme,
         tentativas = v_tentativas,
         proxima_tentativa_em = case
           when v_resultado = 'aguardando' then now() + least(
             power(2::double precision, v_tentativas::double precision) * interval '1 minute',
             interval '6 hours'
           )
           else null
         end,
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
  '0909, Tarefa 6 (redefine a versão da Tarefa 5; correção M8): confere o lease (fn_billing_asaas_lease_e_meu) e recusa gravar se não for mais o do chamador (billing_lease_invalido). p_confirmacao = {"pre_roteamento":"outro_app"} (sentinela do pré-roteamento sem GET, decisão 6) fecha o evento como outro_app direto, sem despachar para função nenhuma. Despacha por event_type: PAYMENT_CONFIRMED/PAYMENT_RECEIVED/PAYMENT_RECEIVED_IN_CASH chamam fn_billing_asaas_aplicar_pagamento (Tarefa 5); PAYMENT_REFUNDED/PAYMENT_PARTIALLY_REFUNDED/PAYMENT_CHARGEBACK_REQUESTED/PAYMENT_AWAITING_CHARGEBACK_REVERSAL chamam fn_billing_asaas_aplicar_estorno (decisão 9); PAYMENT_OVERDUE/PAYMENT_DELETED/SUBSCRIPTION_DELETED/SUBSCRIPTION_INACTIVATED/SUBSCRIPTION_UPDATED chamam fn_billing_asaas_aplicar_fim_da_assinatura (decisão 10); cada despacho roda num begin/exception interno (uma falha vira resultado=erro sem propagar a exceção nem desfazer o registro do evento); sem p_confirmacao fica aguardando; qualquer outro tipo só fica registrado (ignorado, decisão 10). M8: todo resultado aguardando ganha o MESMO backoff de fn_billing_asaas_registrar_falha (tentativas + 1, now() + least(2^tentativas minutos, 6 horas), vira erro na décima), para nunca ser reservado de novo a cada minuto sem limite. Grava resultado, erro_codigo, organization_id, alarme, tentativas, proxima_tentativa_em e processado_em, e libera o lease.';

revoke execute on function public.fn_billing_asaas_aplicar_evento(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_aplicar_evento(uuid, uuid, jsonb) to service_role;

comment on column public.asaas_webhook_events.alarme is
  '0909: código (ou vários, separados por vírgula) que a tela do admin (Tarefa 18, fora desta migration) mostra sem abrir o payload. Tarefa 5: divergente_valor (decisão 7, pagamento maior que o esperado) e pago_fora_do_prazo (decisão 4/A1, pedido vencido ou cancelado pago mesmo assim). Tarefa 6 (decisão 9, N31, N32, N43, A1): estorno_confirmado, chargeback_confirmado, parcialmente_estornado, reversao_de_chargeback, remover_cobranca_pendente. Nulo quando o evento não precisa de atenção.';

-- ── 34. fn_billing_asaas_marcar_assinatura_encerrada: função PÚBLICA para o
-- serviço de compra confirmar o DELETE feito pelo próprio CRM (decisão 22) ──
--
-- Chamada por lib/billing/asaas/compra.ts (Tarefa 14, fora desta migration)
-- depois de um DELETE /subscriptions/{id} bem sucedido, ANTES ou depois de
-- fn_billing_cancelar_no_fim_do_periodo (que hoje é a única chamada de
-- cancelarAssinaturaDoCliente). Grava o marcador (decisão 22) e liga cancel_
-- at_period_end, mesmo efeito de fn_billing_asaas_aplicar_fim_da_assinatura
-- para SUBSCRIPTION_DELETED confirmado, só que disparado pelo próprio CRM
-- (sem esperar o webhook/GET), e cancela pedido aberto daquela assinatura.
-- Idempotente: chamada de novo com o MESMO asaas_subscription_id, com o
-- marcador já preenchido, devolve ja_registrado = true sem mexer em nada.
create or replace function public.fn_billing_asaas_marcar_assinatura_encerrada(p_org uuid, p_asaas_subscription_id text, p_actor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_cancel_anterior boolean;
begin
  if p_asaas_subscription_id is null or p_asaas_subscription_id !~ '^sub_' then
    raise exception 'billing_asaas_subscription_id_formato_invalido' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract from public.billing_contracts where organization_id = p_org for update;
  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  if v_contract.asaas_subscription_id is distinct from p_asaas_subscription_id then
    raise exception 'billing_assinatura_nao_confere' using errcode = '22023';
  end if;

  if v_contract.asaas_assinatura_encerrada_em is not null then
    return jsonb_build_object('ja_registrado', true, 'asaas_assinatura_encerrada_em', v_contract.asaas_assinatura_encerrada_em);
  end if;

  v_cancel_anterior := coalesce(v_contract.cancel_at_period_end, false);

  update public.billing_contracts
     set cancel_at_period_end = true,
         asaas_assinatura_encerrada_em = now()
   where id = v_contract.id;

  if not v_cancel_anterior then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (p_org, v_contract.id, 'cancelar_no_fim', v_cancel_anterior::text, 'true', 'asaas_delete_confirmado_pelo_crm', p_actor);
  end if;

  update public.billing_orders
     set status = 'cancelado'
   where organization_id = p_org
     and asaas_subscription_id = p_asaas_subscription_id
     and status in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando');

  return jsonb_build_object('ja_registrado', false, 'asaas_assinatura_encerrada_em', now());
end;
$$;

comment on function public.fn_billing_asaas_marcar_assinatura_encerrada(uuid, text, uuid) is
  '0909, Tarefa 6, decisão 22: chamada pelo serviço de compra (lib/billing/asaas/compra.ts, Tarefa 14, fora desta migration) depois de um DELETE /subscriptions/{id} bem sucedido feito pelo próprio CRM. Grava asaas_assinatura_encerrada_em = now() e liga cancel_at_period_end, cancela pedido aberto daquela assinatura, grava billing_contract_eventos na mesma transação. Assinatura informada diferente da gravada no contrato é 22023 (billing_assinatura_nao_confere). Idempotente: marcador já preenchido devolve ja_registrado = true, sem mexer em nada. Pública: grant só para service_role.';

revoke execute on function public.fn_billing_asaas_marcar_assinatura_encerrada(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_asaas_marcar_assinatura_encerrada(uuid, text, uuid) to service_role;

-- ── 35. fn_billing_estornar_pagamento RECRIADA (B2): exige origem = 'manual'
-- ──
--
-- Mesmo corpo da 0908 (decisão 2), com UMA checagem nova logo depois do
-- controle de organização (42501): pagamento com origem = 'asaas' nunca é
-- estornado por esta função (que é o estorno MANUAL do admin, 0908, N24); as
-- linhas do Asaas são estornadas só pelo caminho confirmado por GET (decisão
-- 9, fn_billing_asaas_aplicar_estorno, acima).
create or replace function public.fn_billing_estornar_pagamento(
  p_org uuid,
  p_pagamento uuid,
  p_chave uuid,
  p_nota text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_pagamento record;
  v_existente record;
  v_estorno_id uuid;
begin
  if p_chave is null then
    raise exception 'billing_chave_obrigatoria' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  select * into v_pagamento
    from public.billing_payments
    where id = p_pagamento;

  if not found then
    raise exception 'billing_pagamento_nao_encontrado' using errcode = 'P0002';
  end if;

  -- 42501: o pagamento existe, mas é de OUTRA organização.
  if v_pagamento.organization_id <> p_org then
    raise exception 'billing_pagamento_de_outra_organizacao' using errcode = '42501';
  end if;

  -- B2 (0909, Tarefa 6): esta função é o estorno MANUAL; uma linha origem =
  -- 'asaas' só é estornada pelo caminho confirmado por GET (decisão 9).
  if v_pagamento.origem <> 'manual' then
    raise exception 'billing_pagamento_nao_e_manual' using errcode = '22023';
  end if;

  -- Idempotência pela chave (decisão 1/2): um REENVIO da mesma chamada
  -- (mesmo pagamento, já estornado por esta chave) devolve "já registrado";
  -- a mesma chave usada para outro pagamento é erro. Checado ANTES da
  -- checagem de "pode estornar" logo abaixo, para o reenvio de um estorno
  -- que já aconteceu não esbarrar nela.
  select * into v_existente
    from public.billing_payments
    where organization_id = p_org and chave = p_chave;

  if found then
    if v_existente.status = 'REFUNDED'
      and v_existente.gross_cents = v_pagamento.gross_cents
      and v_existente.billing_period_start = v_pagamento.billing_period_start
      and v_existente.billing_period_end = v_pagamento.billing_period_end
    then
      return jsonb_build_object('ja_registrado', true, 'estorno_id', v_existente.id);
    end if;
    raise exception 'billing_chave_com_valores_diferentes' using errcode = '22023';
  end if;

  -- Achado da Tarefa 1 (estorno duplo), corrigido aqui na Tarefa 2: a checagem
  -- de status logo abaixo NÃO detecta um segundo estorno do MESMO pagamento
  -- (billing_payments é só de acréscimo, decisão 1: o status da linha
  -- ORIGINAL nunca muda para refletir que ela já foi estornada). Esta consulta
  -- olha estorna_pagamento_id (seção 1b) para o pagamento original já ter
  -- sido estornado por QUALQUER chave, não só a desta chamada (a idempotência
  -- pela MESMA chave já voltou acima, no "if found" de v_existente).
  if exists (
    select 1 from public.billing_payments
    where organization_id = p_org and estorna_pagamento_id = p_pagamento
  ) then
    raise exception 'billing_pagamento_ja_estornado' using errcode = '22023';
  end if;

  -- Só se estorna um pagamento que ainda está RECEIVED_IN_CASH (nunca a
  -- própria linha de estorno, nem um pagamento já estornado por outra
  -- chave).
  if v_pagamento.status <> 'RECEIVED_IN_CASH' then
    raise exception 'billing_pagamento_nao_pode_ser_estornado' using errcode = '22023';
  end if;

  insert into public.billing_payments (
    organization_id, contract_id, asaas_payment_id, gross_cents, status,
    paid_at, billing_period_start, billing_period_end, chave, nota, criado_por,
    estorna_pagamento_id
  ) values (
    p_org, v_pagamento.contract_id, null, v_pagamento.gross_cents, 'REFUNDED',
    now(), v_pagamento.billing_period_start, v_pagamento.billing_period_end, p_chave, p_nota, p_actor,
    p_pagamento
  )
  returning id into v_estorno_id;

  -- Decisão 2: o estorno NÃO mexe no período do contrato; quem corrige é
  -- fn_billing_corrigir_periodo, chamada à parte pelo admin.
  return jsonb_build_object('ja_registrado', false, 'estorno_id', v_estorno_id);
end;
$$;

comment on function public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid) is
  '0908, decisão 2, RECRIADA na 0909/Tarefa 6 (B2): grava uma linha REFUNDED com o MESMO gross_cents/período do pagamento original (positivo, decisão 1) e NÃO mexe no período do contrato. Pagamento de outra organização é 42501; pagamento com origem diferente de manual é 22023 (billing_pagamento_nao_e_manual, B2: as linhas do Asaas só se estornam pelo caminho confirmado por GET, decisão 9); pagamento que não está RECEIVED_IN_CASH (já estornado) é 22023. Idempotente pela chave (mesmo padrão de fn_billing_registrar_pagamento). Achado da Tarefa 1/0908 (estorno duplo): grava estorna_pagamento_id = p_pagamento e recusa com 22023 um segundo estorno do MESMO pagamento por QUALQUER chave (índice único parcial billing_payments_estorna_pagamento_id_unique garante o invariante no banco também).';

revoke execute on function public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid) to service_role;

-- ── 36. fn_billing_mudar_estado RECRIADA (M4): recusa cancelada manual com
-- assinatura Asaas viva ──
--
-- Mesmo corpo da 0908 (decisão 3), com UMA checagem nova no início do ramo
-- 'cancelada': contrato com asaas_subscription_id preenchido e sem o
-- marcador de encerramento (decisão 22) nunca vira cancelada por esta função
-- manual (a tela manda o admin cancelar a assinatura no Asaas primeiro, ou
-- esperar SUBSCRIPTION_DELETED confirmado gravar o marcador).
create or replace function public.fn_billing_mudar_estado(
  p_org uuid,
  p_estado text,
  p_motivo text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_permitido boolean := false;
begin
  if p_estado not in ('avaliacao', 'ativa', 'atrasada', 'suspensa', 'cancelada') then
    raise exception 'billing_estado_invalido' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  -- Correção (revisão F4, item 3): ativa -> ativa é sucesso SEM MUDANÇA
  -- quando o período está vigente (reenvio idempotente, não é uma transição
  -- de verdade), retorno antecipado antes de qualquer checagem de destino
  -- abaixo. Com período vencido, cai no MESMO caminho de sempre (v_permitido
  -- fica false porque 'ativa' não está na lista de origem aceita por
  -- p_estado = 'ativa', logo abaixo) e mantém o erro atual
  -- (billing_estado_sem_periodo_vigente): reenviar não finge que o período
  -- está em dia.
  if p_estado = 'ativa' and v_contract.status = 'ativa'
    and coalesce(v_contract.current_period_end > now(), false)
  then
    return jsonb_build_object('estado_anterior', 'ativa', 'estado_novo', 'ativa');
  end if;

  -- Decisão 3: uma checagem por destino. coalesce(..., false) em toda
  -- condição booleana que envolve current_period_end (pode ser nulo): lógica
  -- de três valores nunca pode decidir "permitido" por acidente.
  if p_estado = 'cancelada' then
    -- M4 (0909, Tarefa 6, decisão 22): contrato com assinatura Asaas viva
    -- (sem o marcador de encerramento) nunca vira cancelada por AQUI; o
    -- admin cancela a assinatura no Asaas primeiro.
    if v_contract.asaas_subscription_id is not null and v_contract.asaas_assinatura_encerrada_em is null then
      raise exception 'billing_cancele_no_asaas_antes' using errcode = '22023';
    end if;
    -- Qualquer estado vira cancelada, sem condição.
    v_permitido := true;
  elsif p_estado = 'avaliacao' then
    -- Reusa o current_period_end já existente; não cria período novo.
    -- Correção (revisão F4, item 2): exige período FUTURO (current_period_end
    -- > now()), não só preenchido -- avaliação com data no passado não é
    -- avaliação de verdade, e o erro é próprio (billing_avaliacao_sem_data_
    -- futura, abaixo), não o genérico billing_transicao_nao_permitida.
    v_permitido := coalesce(
      v_contract.current_period_end is not null and v_contract.current_period_end > now(),
      false
    );
  elsif p_estado in ('atrasada', 'suspensa') then
    -- Só sai de 'ativa' por esta função (a transição atrasada -> suspensa é
    -- do conferidor diário, decisão 4, não desta função manual).
    v_permitido := coalesce(v_contract.status = 'ativa', false);
  elsif p_estado = 'ativa' then
    v_permitido := coalesce(
      v_contract.status in ('atrasada', 'suspensa', 'cancelada')
        and v_contract.current_period_end is not null
        and v_contract.current_period_end > now(),
      false
    );
  end if;

  if not coalesce(v_permitido, false) then
    if p_estado = 'ativa' then
      raise exception 'billing_estado_sem_periodo_vigente' using errcode = '22023';
    elsif p_estado = 'avaliacao' then
      raise exception 'billing_avaliacao_sem_data_futura' using errcode = '22023';
    else
      raise exception 'billing_transicao_nao_permitida' using errcode = '22023';
    end if;
  end if;

  update public.billing_contracts
    set status = p_estado
    where id = v_contract.id;

  -- Correção (revisão F4, item 4): registro de autor e motivo dentro da
  -- MESMA transação, na tabela de acréscimo billing_contract_eventos (seção
  -- nova, Parte 4, abaixo). p_motivo e p_actor continuam recebidos também
  -- para a auditoria do chamador (mesmo padrão de 0904/0907), agora com um
  -- segundo destino, próprio da assinatura.
  insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
  values (p_org, v_contract.id, 'estado', v_contract.status, p_estado, p_motivo, p_actor);

  return jsonb_build_object('estado_anterior', v_contract.status, 'estado_novo', p_estado);
end;
$$;

comment on function public.fn_billing_mudar_estado(uuid, text, text, uuid) is
  '0908, decisão 3, RECRIADA na 0909/Tarefa 6 (M4): transições manuais do admin. Qualquer estado -> cancelada, EXCETO quando o contrato tem asaas_subscription_id preenchido sem o marcador de encerramento (22023, billing_cancele_no_asaas_antes, decisão 22: o admin cancela a assinatura no Asaas primeiro). ativa -> atrasada ou suspensa. atrasada/suspensa/cancelada -> ativa só com período vigente (current_period_end preenchido e no futuro; senão 22023, "registre um pagamento antes"). avaliacao exige current_period_end já preenchido e FUTURO (senão 22023 próprio, billing_avaliacao_sem_data_futura). ativa -> ativa com período vigente é sucesso sem mudança (idempotência de reenvio); com período vencido mantém o erro de sempre. Toda transição fora desta lista é 22023. Grava um evento em billing_contract_eventos (tipo=estado, de/para/motivo/actor) na MESMA transação, exceto no atalho ativa->ativa sem mudança (não é uma transição de verdade).';

revoke execute on function public.fn_billing_mudar_estado(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_mudar_estado(uuid, text, text, uuid) to service_role;

-- ── 37. agent_worker (se a role existir) perde execute nas peças novas da
-- Tarefa 6, num único bloco condicional (mesmo padrão das seções 16, 23 e 30,
-- acima); fn_billing_estornar_pagamento e fn_billing_mudar_estado já tinham
-- sido revogadas dela na 0908 (ACL persiste no create or replace, nada a
-- repetir aqui) ──
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function '
      || 'public.fn_billing_asaas_aplicar_estorno(text, jsonb, text), '
      || 'public.fn_billing_asaas_aplicar_fim_da_assinatura(text, jsonb, text), '
      || 'public.fn_billing_asaas_marcar_assinatura_encerrada(uuid, text, uuid) '
      || 'from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- PARTE 7: correções da revisão e da auditoria de segurança da fase F5
-- (hiperbold/planos/fase-F5-tarefas.md). Migration ainda não aplicada em
-- produção (restrição fixa 2 da fase): corrige NO LUGAR, redefinindo função
-- (a ÚLTIMA definição vale, tests/unit/sonda-do-baseline-ancora-na-ultima-
-- definicao.test.ts) em vez de abrir uma migration nova. As colunas novas
-- (asaas_ambiente, asaas_sandbox_concede) foram editadas nas suas PARTES de
-- origem (PARTE 1, acima), não aqui: só função se redefine nesta parte.
-- Nenhuma chamada real ao Asaas nesta parte também (restrição fixa 1).
--
-- Treze itens:
--   1. fn_billing_asaas_aplicar_estorno: só aplica quando o status
--      CONFIRMADO (do GET, nunca do corpo do webhook) casa com o evento.
--   2. fn_billing_asaas_aplicar_fim_da_assinatura: PAYMENT_OVERDUE/PAYMENT_
--      DELETED de cobrança de RENOVAÇÃO fecha ignorado, nunca um "resultado"
--      fora do CHECK; fn_billing_asaas_aplicar_evento nunca deixa o UPDATE
--      final propagar uma falha (vira retentativa com backoff).
--   3. fn_billing_asaas_rotear_pagamento: pedido estornado/pago/falhou nunca
--      casa como primeiro pagamento.
--   4. fn_billing_asaas_aplicar_pagamento: assinatura Asaas duplicada não
--      concede (divergente, alarme assinatura_duplicada); fn_billing_asaas_
--      aplicar_fim_da_assinatura: alarme por tipo de pedido no
--      PAYMENT_OVERDUE (remover_assinatura_pendente/remover_cobranca_
--      pendente).
--   5. fn_billing_asaas_aplicar_pagamento: contrato só volta a ativa quando
--      o novo fim é posterior a now(), nos dois pontos.
--   6. fn_billing_asaas_aplicar_fim_da_assinatura: mais estados definitivos
--      fecham ignorado (nunca aguardando para sempre); fn_billing_asaas_
--      aplicar_evento: falha transitória (lock/deadlock/serialização) dentro
--      do bloco interno vira retentativa com backoff, nunca erro final.
--   7. fn_billing_pedido_marcar: inconclusivo só a partir de processando.
--   8. fn_billing_asaas_registrar_evento: prefixo reservado (conc:/
--      quarentena:) vindo do WEBHOOK vai para quarentena.
--   9. fn_billing_asaas_aplicar_evento: evento fechado outro_app poda o
--      payload ({}) na hora.
--  10. billing_contracts.asaas_ambiente (coluna na PARTE 1): fn_billing_
--      asaas_aplicar_pagamento grava no primeiro pagamento; fn_billing_
--      asaas_rotear_pagamento só casa renovação do MESMO ambiente.
--  11. billing_settings.asaas_sandbox_concede (coluna na PARTE 1):
--      fn_billing_asaas_aplicar_pagamento recusa (ignorado, sandbox_nao_
--      concede) pagamento de sandbox enquanto a chave estiver desligada.
--  12. fn_billing_asaas_reprocessar_evento: aceita também sem_vinculo.
--  13. fn_billing_asaas_aplicar_pagamento: Pix anual com paymentDate nulo usa
--      o início do dia em América/São Paulo, nunca now().
--
-- Mesmo padrão de segurança das partes anteriores: security definer,
-- search_path fixo em public, pg_temp. create or replace NÃO reseta grant
-- nem revoke (comentado na PARTE 6, seção 33): as ACLs das Tarefas 3, 4, 5 e
-- 6 continuam valendo tal qual, nenhum revoke/grant repetido aqui.
-- ============================================================================

-- ── 38. fn_billing_asaas_registrar_evento REDEFINIDA (item 8): prefixo
-- reservado (conc:/quarentena:) vindo do WEBHOOK vai para quarentena ──
--
-- conc:<id>:<status> é o formato do evento SINTÉTICO da conciliação diária
-- (decisão 21, origem=conciliacao); quarentena:<hash> é o formato que esta
-- própria função usa para o event_id fora do formato (mesma função, ramo
-- abaixo). Sem esta checagem, um evento de WEBHOOK (origem controlada por
-- quem tem só o token, não necessariamente confiável contra colisão de id)
-- podia chegar com event_id = 'conc:<id>:<status>' IGUAL ao que a
-- conciliação geraria depois: o "on conflict (event_id) do nothing" fazia o
-- evento sintético de VERDADE ser silenciosamente ignorado (a linha já
-- existe), sequestrando o namespace de idempotência da conciliação. Mesmo
-- racional para 'quarentena:': ninguém de fora finge ser um evento que esta
-- própria função decidiu isolar.
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
  elsif p_origem = 'webhook' and (p_event_id like 'conc:%' or p_event_id like 'quarentena:%') then
    -- Correção (revisão F5, item 8): prefixo reservado à conciliação e à
    -- própria quarentena nunca chega do webhook.
    v_quarentena := true;
    v_erro_codigo := 'evento_fora_do_formato:prefixo_reservado';
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
  '0909, PARTE 7 (correção, revisão F5, item 8): redefine a versão da Tarefa 4 acrescentando UMA checagem, logo depois do tamanho de event_id: origem=webhook com event_id começando por conc: ou quarentena: (os dois prefixos reservados, da conciliação e desta própria função) vai para quarentena (evento_fora_do_formato:prefixo_reservado), para ninguém de fora sequestrar pelo on conflict do nothing o namespace de idempotência da conciliação ou da quarentena. Resto do corpo idêntico à Tarefa 4.';

-- ── 39. fn_billing_asaas_reprocessar_evento REDEFINIDA (item 12): aceita
-- também sem_vinculo ──
--
-- O admin corrige o vínculo (ex.: cadastra o customer que faltava, ou liga o
-- pedido certo) e manda reprocessar um evento que o roteamento não achou
-- organização nenhuma (decisão 6): sem_vinculo nunca é erro do Asaas, é
-- FALTA DE DADO local, e o reprocesso é exatamente o caminho para corrigir
-- sem esperar outro evento chegar.
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

  if v_evento.resultado not in ('erro', 'sem_vinculo') then
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
  '0909, PARTE 7 (correção, revisão F5, item 12): redefine a versão da Tarefa 4 aceitando também sem_vinculo (billing_evento_nao_esta_em_erro só recusa fora de erro/sem_vinculo agora): o admin reprocessa depois de corrigir o vínculo local (cliente, pedido) sem esperar outro evento do Asaas chegar. Resto do corpo idêntico à Tarefa 4.';

-- ── 40. fn_billing_pedido_marcar REDEFINIDA (item 7): inconclusivo só a
-- partir de processando ──
--
-- fn_billing_pedido_tomar (Tarefa 3) já move o pedido para processando ANTES
-- do POST ao Asaas (decisão 25); só um POST que respondeu timeout ou 5xx
-- (decisão 13) marca inconclusivo, e isso só pode acontecer depois da posse.
-- Marcar inconclusivo a partir de criado (sem nunca ter tentado o POST)
-- escondia um pedido que nunca chegou a sair daqui.
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

  -- Correção (revisão F5, item 7): inconclusivo só a partir de processando
  -- (o único status de onde um POST ao Asaas pode de fato ter sido
  -- tentado, decisão 25).
  if p_status = 'inconclusivo' and v_pedido.status <> 'processando' then
    raise exception 'billing_pedido_nao_esta_processando' using errcode = '22023';
  end if;

  update public.billing_orders
    set status = p_status
    where id = v_pedido.id;

  return jsonb_build_object('pedido_id', v_pedido.id, 'status_anterior', v_pedido.status, 'status_novo', p_status);
end;
$$;

comment on function public.fn_billing_pedido_marcar(uuid, uuid, text, text) is
  '0909, PARTE 7 (correção, revisão F5, item 7): redefine a versão da Tarefa 3 exigindo status=processando para marcar inconclusivo (billing_pedido_nao_esta_processando, 22023): só um pedido que fn_billing_pedido_tomar já tomou, e cujo POST ao Asaas respondeu timeout/5xx (decisão 13), vira inconclusivo. falhou e cancelado continuam de qualquer status que não seja pago. Resto do corpo idêntico à Tarefa 3.';

-- ── 41. fn_billing_asaas_rotear_pagamento REDEFINIDA (itens 3 e 10) ──
--
-- Item 3: pedido estornado, pago ou falhou nunca casa como PRIMEIRO
-- PAGAMENTO (era só "status <> 'pago'", que deixava estornado e falhou
-- casarem de novo). Pagamento da mesma assinatura depois de um pedido
-- estornado segue pela ASSINATURA DO CONTRATO (o select seguinte, renovação),
-- se ela for a do contrato; senão cai pelo resto do roteamento até
-- sem_vinculo, nunca reabre o pedido estornado.
--
-- Item 10: a busca de RENOVAÇÃO por assinatura agora também exige
-- asaas_ambiente = p_ambiente: um evento de sandbox nunca casa com o
-- contrato de produção do MESMO id de assinatura por coincidência (ids do
-- Asaas não se repetem entre sandbox e produção na prática, mas a defesa em
-- profundidade custa uma cláusula).
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
      where ambiente = p_ambiente and asaas_subscription_id = p_subscription
        and status not in ('pago', 'estornado', 'falhou')
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
      where asaas_subscription_id = p_subscription and asaas_ambiente = p_ambiente;
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
        where id = v_id_do_pedido and ambiente = p_ambiente
          and status not in ('pago', 'estornado', 'falhou');
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
      where ambiente = p_ambiente and asaas_payment_id = p_payment_id
        and status not in ('pago', 'estornado', 'falhou');
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
  '0909, PARTE 7 (correção, revisão F5, itens 3 e 10): redefine a versão da Tarefa 5. Item 3: as três buscas de pedido excluem também estornado e falhou (antes só excluíam pago): um pedido estornado ou que falhou nunca volta a casar como primeiro pagamento; um pagamento da mesma assinatura depois disso cai na busca de RENOVAÇÃO (pela assinatura do contrato) ou, sem casar ali, no resto do roteamento até sem_vinculo. Item 10: a busca de renovação por assinatura exige também asaas_ambiente = p_ambiente no contrato (coluna da PARTE 1): um evento de sandbox nunca casa com contrato de outro ambiente. Resto do corpo idêntico à Tarefa 5 (STABLE, sem travar nada).';

-- ── 42. fn_billing_asaas_aplicar_pagamento REDEFINIDA (itens 4, 5, 10, 11,
-- 13) ──
--
-- Item 11 primeiro de tudo, ANTES de qualquer idempotência/roteamento/trava:
-- sandbox só concede com billing_settings.asaas_sandbox_concede ligada
-- (coluna da PARTE 1, nasce false). Item 4: contrato com OUTRA assinatura
-- Asaas viva (sem o marcador de encerramento) e DIFERENTE da desta cobrança
-- nunca concede (defesa em profundidade: fn_billing_criar_pedido, Tarefa 3,
-- já bloqueia isso na criação do pedido). Item 5: current_period_end
-- calculado, o contrato só volta a 'ativa' se esse NOVO FIM for posterior a
-- now() (evento velho reprocessado não ativa um contrato que devia continuar
-- do jeito que estava), nos DOIS pontos (primeiro pagamento e renovação).
-- Item 10: asaas_ambiente gravado junto com asaas_subscription_id, no
-- primeiro pagamento. Item 13: Pix anual com paymentDate nulo usa o início
-- do dia em América/São Paulo, nunca now() (que traria hora exata e
-- quebraria a normalização de período sempre à meia-noite).
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
  v_novo_status text;
  v_sandbox_concede boolean;
  v_org_sandbox uuid;
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

  -- Correção (revisão F5, item 11): sandbox nunca concede numa instalação
  -- que não ligou billing_settings.asaas_sandbox_concede (nasce false): a
  -- homologação no sandbox de uma instalação de TESTE liga essa chave; uma
  -- instalação de PRODUÇÃO real nunca concede acesso por um "pagamento" de
  -- sandbox. Sai ANTES de qualquer idempotência, roteamento ou trava: nunca
  -- toca em contrato nem em tokens.
  if p_ambiente = 'sandbox' then
    select coalesce(asaas_sandbox_concede, false) into v_sandbox_concede
      from public.billing_settings where id = 1;
    if not coalesce(v_sandbox_concede, false) then
      select r.organization_id into v_org_sandbox
        from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id) r
       where r.categoria in ('pedido', 'renovacao');
      return jsonb_build_object(
        'resultado', 'ignorado', 'organization_id', v_org_sandbox, 'payment_id', null, 'order_id', null,
        'alarmes', to_jsonb(array['sandbox_nao_concede']), 'erro_codigo', 'sandbox_nao_concede'
      );
    end if;
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
    --
    -- Correção (revisão F5, item 4): contrato já com OUTRA assinatura Asaas
    -- viva (sem o marcador de encerramento) e DIFERENTE da desta cobrança
    -- nunca concede: seria duplicar a cobrança do cliente. fn_billing_criar_
    -- pedido (Tarefa 3) já bloqueia isso na CRIAÇÃO do pedido; esta é a
    -- defesa em profundidade na APLICAÇÃO (evento atrasado, corrida, ou uma
    -- duplicação criada por outro caminho).
    if v_contract.asaas_subscription_id is not null
      and v_contract.asaas_assinatura_encerrada_em is null
      and v_contract.asaas_subscription_id is distinct from v_subscription
    then
      return jsonb_build_object(
        'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', to_jsonb(array['assinatura_duplicada'])
      );
    end if;

    if v_pedido.metodo = 'PIX' and v_pedido.ciclo = 'yearly' then
      -- Decisão 5, regra especial do Pix anual: início = greatest(current_
      -- period_end, paymentDate); fim = início + 1 ano + 1 dia. Correção
      -- (revisão F5, item 13): paymentDate nulo usa o INÍCIO DO DIA em SP,
      -- nunca now() (que traria hora exata e quebraria a normalização de
      -- período sempre à meia-noite).
      v_periodo_inicio := greatest(
        v_contract.current_period_end,
        coalesce(
          (nullif(p_confirmacao->>'paymentDate', ''))::date,
          (now() at time zone 'America/Sao_Paulo')::date
        )::timestamp at time zone 'America/Sao_Paulo'
      );
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
    -- fim), evento velho nunca encurta (decisão 5/B9). Correção (revisão F5,
    -- item 5): só volta a ativa quando o NOVO FIM é posterior a now(); o
    -- reprocesso de um evento velho, cujo período já passou, nunca ativa um
    -- contrato que devia continuar do jeito que estava.
    v_estado_anterior := v_contract.status;
    v_fim_anterior := v_contract.current_period_end;
    v_plan_id_anterior := v_contract.plan_id;
    v_novo_fim := greatest(v_contract.current_period_end, v_periodo_fim);
    v_novo_status := case when v_novo_fim > now() then 'ativa' else v_contract.status end;

    -- Correção (revisão F5, item 10): asaas_ambiente gravado JUNTO com
    -- asaas_subscription_id, no primeiro pagamento; fn_billing_asaas_rotear_
    -- pagamento (acima) só casa uma renovação do MESMO ambiente do evento.
    update public.billing_contracts
      set plan_id = v_pedido.plan_id,
          cycle = v_pedido.ciclo,
          gateway = 'asaas',
          asaas_subscription_id = coalesce(v_subscription, v_contract.asaas_subscription_id),
          asaas_ambiente = p_ambiente,
          asaas_assinatura_encerrada_em = case when v_subscription is not null then null else v_contract.asaas_assinatura_encerrada_em end,
          cancel_at_period_end = false,
          current_period_start = v_periodo_inicio,
          current_period_end = v_novo_fim,
          status = v_novo_status
      where id = v_contract.id;

    if v_estado_anterior <> v_novo_status then
      insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
      values (v_org, v_contract.id, 'estado', v_estado_anterior, v_novo_status, 'pay_primeiro_pagamento', null);
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

  -- Correção (revisão F5, item 5): mesmo cuidado da branch acima, só volta a
  -- ativa quando o novo fim é posterior a now().
  v_estado_anterior := v_contract.status;
  v_fim_anterior := v_contract.current_period_end;
  v_cancel_anterior := v_contract.cancel_at_period_end;
  v_novo_fim := greatest(v_contract.current_period_end, v_periodo_fim);
  v_novo_status := case when v_novo_fim > now() then 'ativa' else v_contract.status end;

  update public.billing_contracts
    set current_period_start = greatest(v_contract.current_period_start, v_periodo_inicio),
        current_period_end = v_novo_fim,
        status = v_novo_status,
        cancel_at_period_end = case when coalesce(p_confirmacao->>'assinatura_status', '') = 'ACTIVE' then false else cancel_at_period_end end
    where id = v_contract.id;

  if v_estado_anterior <> v_novo_status then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'estado', v_estado_anterior, v_novo_status, 'pay_renovacao', null);
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
  '0909, PARTE 7 (correção, revisão F5, itens 4, 5, 10, 11, 13): redefine a versão da Tarefa 5. Item 11: sandbox só concede com billing_settings.asaas_sandbox_concede ligada, checado ANTES de qualquer idempotência/roteamento/trava, nunca toca em contrato nem em tokens quando desligada (ignorado, sandbox_nao_concede). Item 4: contrato com outra assinatura Asaas viva e diferente não concede (divergente, alarme assinatura_duplicada). Item 5: status = ativa só quando o novo current_period_end é posterior a now(), nos dois pontos (primeiro pagamento e renovação); senão mantém o status anterior do contrato. Item 10: asaas_ambiente gravado junto com asaas_subscription_id no primeiro pagamento. Item 13: Pix anual com paymentDate nulo usa o início do dia em America/Sao_Paulo, nunca now(). Resto do corpo idêntico à Tarefa 5 (ordem das travas, idempotência dupla, roteamento refeito sob a trava, ORDEM FIXA inserir-antes-de-estender).';

-- ── 43. fn_billing_asaas_aplicar_estorno REDEFINIDA (item 1) ──
--
-- Só aplica quando o status CONFIRMADO (o que o GET devolveu, nunca o corpo
-- do webhook) CASA com o evento: REFUNDED para estorno; CHARGEBACK_REQUESTED
-- ou CHARGEBACK_DISPUTE para chargeback. Um evento REFUNDED forjado sobre um
-- pay_ legítimo, cujo GET ainda diz RECEIVED (nunca foi estornado de
-- verdade), não estorna nada nem bloqueia o pagamento real. Status EM
-- ANDAMENTO (o estorno/chargeback começou no Asaas, mas ainda não liquidou):
-- REFUND_REQUESTED, REFUND_IN_PROGRESS, AWAITING_CHARGEBACK_REVERSAL, volta a
-- aguardando (tenta de novo depois); qualquer outro status fecha ignorado com
-- erro_codigo = status_nao_confirma_evento. O caminho M2 (gravar o original
-- SEM CONCEDER, quando não existe linha local) passa a valer só para
-- PAYMENT_REFUNDED com status REFUNDED confirmado: um chargeback sem linha
-- original local nunca fabrica um pagamento que este banco nunca viu.
create or replace function public.fn_billing_asaas_aplicar_estorno(p_evento_tipo text, p_confirmacao jsonb, p_ambiente text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id text := nullif(p_confirmacao->>'id', '');
  v_subscription text := nullif(p_confirmacao->>'subscription', '');
  v_external_reference text := nullif(p_confirmacao->>'externalReference', '');
  v_status_confirmado text := nullif(p_confirmacao->>'status', '');
  v_valor_cents bigint;
  v_pago_em timestamptz;
  v_rota record;
  v_org uuid;
  v_contract_id uuid;
  v_original record;
  v_original_id uuid;
  v_pedido_id uuid;
  v_status_novo text;
  v_chave_estorno uuid;
  v_chave_original uuid;
  v_estorno_id uuid;
  v_alarme text;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if v_payment_id is null then
    raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
  end if;

  -- N43/decisão 9: reversão de chargeback e estorno parcial só alarmam.
  if p_evento_tipo in ('PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    select organization_id into v_org from public.billing_payments where asaas_payment_id = v_payment_id limit 1;
    if v_org is null then
      select * into v_rota from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);
      if v_rota.categoria in ('pedido', 'renovacao') then
        v_org := v_rota.organization_id;
      end if;
    end if;
    v_alarme := case p_evento_tipo
      when 'PAYMENT_PARTIALLY_REFUNDED' then 'parcialmente_estornado'
      else 'reversao_de_chargeback'
    end;
    return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarme', v_alarme, 'erro_codigo', null);
  end if;

  -- Acréscimo (revisão F5, pedido do coordenador): PAYMENT_CHARGEBACK_
  -- DISPUTE entra na MESMA família de PAYMENT_CHARGEBACK_REQUESTED (o "else"
  -- da checagem de status logo abaixo já aceita status CHARGEBACK_REQUESTED
  -- ou CHARGEBACK_DISPUTE para os dois); v_status_novo cai no mesmo
  -- 'CHARGEBACK_REQUESTED' (o único valor que o CHECK de billing_payments.
  -- status permite para chargeback), então uma DISPUTE que chega depois de
  -- uma REQUESTED já registrada é idempotente pela MESMA chave (mesmo
  -- payment_id, mesmo status_novo), não duplica linha nenhuma.
  if p_evento_tipo not in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE') then
    raise exception 'billing_evento_tipo_invalido' using errcode = '22023';
  end if;

  -- Correção (revisão F5, item 1): só aplica quando o status CONFIRMADO
  -- casa com o evento.
  if p_evento_tipo = 'PAYMENT_REFUNDED' then
    if v_status_confirmado is distinct from 'REFUNDED' then
      if v_status_confirmado in ('REFUND_REQUESTED', 'REFUND_IN_PROGRESS') then
        return jsonb_build_object('resultado', 'aguardando', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'billing_status_em_andamento');
      end if;
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'status_nao_confirma_evento');
    end if;
  else
    if v_status_confirmado not in ('CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE') then
      if v_status_confirmado = 'AWAITING_CHARGEBACK_REVERSAL' then
        return jsonb_build_object('resultado', 'aguardando', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'billing_status_em_andamento');
      end if;
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'status_nao_confirma_evento');
    end if;
  end if;

  v_status_novo := case p_evento_tipo when 'PAYMENT_REFUNDED' then 'REFUNDED' else 'CHARGEBACK_REQUESTED' end;
  v_valor_cents := round(coalesce(
    (p_confirmacao->>'originalValue')::numeric,
    (p_confirmacao->>'value')::numeric
  ) * 100);
  v_pago_em := coalesce(
    (nullif(p_confirmacao->>'paymentDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    (nullif(p_confirmacao->>'confirmedDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    now()
  );
  v_chave_estorno := md5('HC:asaas:refund:' || v_payment_id || ':' || v_status_novo)::uuid;
  v_chave_original := md5('HC:asaas:pay:' || v_payment_id)::uuid;

  -- (1) idempotência do estorno, ANTES de qualquer trava (mesmo padrão da
  -- Tarefa 5, decisão 4/8/B1).
  select id, organization_id, order_id into v_estorno_id, v_org, v_pedido_id
    from public.billing_payments where chave = v_chave_estorno and status = v_status_novo;
  if v_estorno_id is not null then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id, 'alarme', null, 'erro_codigo', null);
  end if;

  -- (2) acha o pagamento ORIGINAL (se existir localmente) para saber a
  -- organização, sem trava nenhuma ainda.
  select * into v_original from public.billing_payments where asaas_payment_id = v_payment_id order by created_at asc limit 1;

  if found then
    v_org := v_original.organization_id;
  else
    select * into v_rota from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);
    if v_rota.categoria in ('outro_app', 'sem_vinculo') then
      return jsonb_build_object('resultado', v_rota.categoria, 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;
    v_org := v_rota.organization_id;
  end if;

  -- (3) travas na ordem fixa da decisão 12.
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_org::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org::text, 0));

  -- (4) idempotência de novo, sob a trava.
  select id, order_id into v_estorno_id, v_pedido_id
    from public.billing_payments where chave = v_chave_estorno and status = v_status_novo;
  if v_estorno_id is not null then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id, 'alarme', null, 'erro_codigo', null);
  end if;

  -- (5) releitura do original SOB a trava (decisão 12/B5: o estado pode ter
  -- mudado enquanto esperava).
  select * into v_original from public.billing_payments where asaas_payment_id = v_payment_id order by created_at asc limit 1;

  if found then
    v_original_id := v_original.id;
    v_pedido_id := v_original.order_id;
    v_contract_id := v_original.contract_id;
  else
    -- Correção (revisão F5, item 1): o caminho M2 (reconstruir o original
    -- SEM CONCEDER) só existe para PAYMENT_REFUNDED com status REFUNDED
    -- confirmado (o único caso em que "reconstruir um pagamento RECEIVED que
    -- este banco nunca viu, já estornado" é seguro): um chargeback sem linha
    -- original local nunca fabrica um pagamento que não aconteceu por aqui.
    if p_evento_tipo <> 'PAYMENT_REFUNDED' then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;

    -- M2: objeto confirmado já chega estornado, sem linha original gravada.
    -- Roteia de novo (decisão 12/B5), grava o ORIGINAL sem conceder e o
    -- estorno na MESMA transação.
    select * into v_rota from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);
    if v_rota.categoria in ('outro_app', 'sem_vinculo') or v_rota.organization_id is distinct from v_org then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;
    if v_rota.categoria = 'pedido' then
      v_pedido_id := v_rota.pedido_id;
    end if;

    select id into v_contract_id from public.billing_contracts where organization_id = v_org;
    if v_contract_id is null then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;

    begin
      insert into public.billing_payments (
        organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
        billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
      ) values (
        v_org, v_contract_id, v_payment_id, v_valor_cents, 'RECEIVED', v_pago_em,
        null, null, v_chave_original, 'Asaas: original reconstituido pelo estorno (M2)', null, 'asaas', v_pedido_id
      )
      returning id into v_original_id;
    exception when unique_violation then
      select id, order_id, contract_id into v_original_id, v_pedido_id, v_contract_id
        from public.billing_payments where asaas_payment_id = v_payment_id;
    end;
  end if;

  -- (6) o estorno em si: linha NOVA, sem asaas_payment_id, período NULO
  -- (decisão 9: não mexe em período nem em tokens).
  begin
    insert into public.billing_payments (
      organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
      billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id,
      estorna_pagamento_id
    ) values (
      v_org, v_contract_id, null, v_valor_cents, v_status_novo, now(),
      null, null, v_chave_estorno, 'Asaas: ' || lower(v_status_novo), null, 'asaas', v_pedido_id,
      v_original_id
    )
    returning id into v_estorno_id;
  exception when unique_violation then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido_id, 'alarme', null, 'erro_codigo', null);
  end;

  -- decisão 9: o pedido passa a estornado. Não mexe em billing_contracts.
  if v_pedido_id is not null then
    update public.billing_orders set status = 'estornado' where id = v_pedido_id and status <> 'estornado';
  end if;

  return jsonb_build_object(
    'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id,
    'alarme', case p_evento_tipo when 'PAYMENT_REFUNDED' then 'estorno_confirmado' else 'chargeback_confirmado' end,
    'erro_codigo', null
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_estorno(text, jsonb, text) is
  '0909, PARTE 7 (correção, revisão F5, item 1): redefine a versão da Tarefa 6 acrescentando a checagem de status CONFIRMADO contra o event_type: REFUNDED só aplica com status=REFUNDED (senão aguardando se em andamento, do contrário ignorado com erro_codigo=status_nao_confirma_evento); CHARGEBACK_REQUESTED só aplica com status in (CHARGEBACK_REQUESTED, CHARGEBACK_DISPUTE), mesma regra de aguardando/ignorado. O caminho M2 (reconstruir o original sem conceder) passa a valer só para PAYMENT_REFUNDED (chargeback sem linha original local vira sem_vinculo). Um evento forjado com um pay_ legítimo, cujo GET nunca confirmou o estorno/chargeback, não estorna nada nem bloqueia o pagamento real. Resto do corpo idêntico à Tarefa 6 (chave com status, período nulo, pedido vira estornado). Interna: nenhum grant, nem a service_role (revoke da Tarefa 6 continua valendo).';

-- ── 44. fn_billing_asaas_aplicar_fim_da_assinatura REDEFINIDA (itens 2, 4,
-- 6) ──
--
-- Item 2: PAYMENT_OVERDUE/PAYMENT_DELETED cuja assinatura roteia como
-- RENOVAÇÃO (categoria=renovacao, uma cobrança de assinatura já ativa, nunca
-- "o pedido" desta função) fecha ignorado; devolver a categoria crua
-- ('renovacao') fazia o UPDATE final de fn_billing_asaas_aplicar_evento
-- estourar fora do CHECK de resultado (asaas_webhook_events_resultado_
-- check), porque 'renovacao' nunca esteve no vocabulário da coluna. Item 4:
-- PAYMENT_OVERDUE do primeiro pagamento de um pedido de ASSINATURA grava o
-- alarme remover_assinatura_pendente (o processador remove a ASSINATURA no
-- Asaas, N39); pedido avulso (pacote de tokens) continua com remover_
-- cobranca_pendente. Item 6: GET síncrono que já mostra o pagamento recebido
-- (PAYMENT_OVERDUE) ou o pagamento restaurado (PAYMENT_DELETED com
-- removida=false) ou a assinatura reativada (SUBSCRIPTION_INACTIVATED com
-- status=ACTIVE) são estados DEFINITIVOS: fecham ignorado com erro_codigo
-- explicando, nunca ficam aguardando para sempre.
create or replace function public.fn_billing_asaas_aplicar_fim_da_assinatura(p_evento_tipo text, p_confirmacao jsonb, p_ambiente text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id text;
  v_subscription_id text;
  v_status text;
  v_removida boolean;
  v_rota record;
  v_org uuid;
  v_org_pre uuid;
  v_pedido record;
  v_contract record;
  v_cancel_anterior boolean;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if p_evento_tipo in ('PAYMENT_OVERDUE', 'PAYMENT_DELETED') then
    v_payment_id := nullif(p_confirmacao->>'id', '');
    if v_payment_id is null then
      raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
    end if;

    if p_evento_tipo = 'PAYMENT_OVERDUE' then
      -- Correção (revisão F5, item 6): GET que já mostra o pagamento
      -- recebido é estado DEFINITIVO (nunca vai virar OVERDUE depois): fecha
      -- ignorado, nunca fica aguardando para sempre.
      if coalesce(p_confirmacao->>'status', '') in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') then
        return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'pagamento_ja_recebido');
      end if;
      if coalesce(p_confirmacao->>'status', '') <> 'OVERDUE' then
        return jsonb_build_object('resultado', 'aguardando', 'organization_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', null);
      end if;
    else
      v_removida := coalesce((p_confirmacao->>'removida')::boolean, false);
      if not v_removida then
        -- Correção (revisão F5, item 6): removida=false é a resposta
        -- SÍNCRONA do GET dizendo, agora, que o pagamento não está removido
        -- (restaurado): estado definitivo, nunca aguardando para sempre.
        return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'pagamento_restaurado');
      end if;
    end if;

    select * into v_rota from public.fn_billing_asaas_rotear_pagamento(
      p_ambiente, nullif(p_confirmacao->>'subscription', ''), nullif(p_confirmacao->>'externalReference', ''), v_payment_id
    );

    if v_rota.categoria = 'renovacao' then
      -- Correção (revisão F5, item 2): 'renovacao' não é um valor do CHECK
      -- de resultado (asaas_webhook_events_resultado_check); devolver a
      -- categoria crua aqui fazia o UPDATE final estourar fora do bloco
      -- interno. Uma cobrança de RENOVAÇÃO nunca é "o pedido" desta função
      -- (ela não marca vencido/cancelado pedido nenhum, decisão 10): o
      -- conferidor da F4 já cuida do atraso da assinatura.
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null, 'erro_codigo', 'cobranca_de_renovacao');
    end if;

    if v_rota.categoria <> 'pedido' then
      return jsonb_build_object('resultado', v_rota.categoria, 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;

    select * into v_pedido from public.billing_orders where id = v_rota.pedido_id for update;
    if not found or v_pedido.status = 'pago' then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;

    if p_evento_tipo = 'PAYMENT_OVERDUE' then
      if v_pedido.status = 'vencido' then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null, 'erro_codigo', null);
      end if;
      update public.billing_orders set status = 'vencido' where id = v_pedido.id;
      -- A1: o alarme avisa o processador (Tarefa 13, fora desta migration)
      -- para remover a cobrança no Asaas antes de um pedido novo poder
      -- nascer (decisão 10, decisão 11 do pedido aberto único). Correção
      -- (revisão F5, item 4): pedido de ASSINATURA sem primeiro pagamento
      -- avisa para remover a ASSINATURA (N39, "remove sozinho"); pedido
      -- avulso continua avisando para remover só a COBRANÇA.
      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id,
        'alarme', case when v_pedido.tipo = 'assinatura' then 'remover_assinatura_pendente' else 'remover_cobranca_pendente' end,
        'erro_codigo', null
      );
    else
      if v_pedido.status = 'cancelado' then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null, 'erro_codigo', null);
      end if;
      update public.billing_orders set status = 'cancelado' where id = v_pedido.id;
      return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null, 'erro_codigo', null);
    end if;
  end if;

  if p_evento_tipo not in ('SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED') then
    raise exception 'billing_evento_tipo_invalido' using errcode = '22023';
  end if;

  v_subscription_id := nullif(p_confirmacao->>'id', '');
  if v_subscription_id is null then
    raise exception 'billing_subscription_id_obrigatorio' using errcode = '22023';
  end if;

  select organization_id into v_org_pre from public.billing_contracts where asaas_subscription_id = v_subscription_id;
  if v_org_pre is null then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', null, 'order_id', null, 'alarme', null);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_org_pre::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org_pre::text, 0));

  select * into v_contract from public.billing_contracts where organization_id = v_org_pre for update;
  if not found or v_contract.asaas_subscription_id is distinct from v_subscription_id then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org_pre, 'order_id', null, 'alarme', null);
  end if;

  v_org := v_contract.organization_id;
  v_status := nullif(p_confirmacao->>'status', '');

  if p_evento_tipo = 'SUBSCRIPTION_UPDATED' then
    if coalesce(v_status, '') <> 'ACTIVE' then
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
    end if;
    if not coalesce(v_contract.cancel_at_period_end, false) then
      return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
    end if;
    update public.billing_contracts set cancel_at_period_end = false where id = v_contract.id;
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', 'true', 'false', 'sub_updated_active', null);
    return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
  end if;

  v_removida := coalesce((p_confirmacao->>'removida')::boolean, false);

  if p_evento_tipo = 'SUBSCRIPTION_DELETED' and not v_removida then
    return jsonb_build_object('resultado', 'aguardando', 'organization_id', v_org, 'order_id', null, 'alarme', null);
  end if;

  if p_evento_tipo = 'SUBSCRIPTION_INACTIVATED' and not v_removida and coalesce(v_status, '') <> 'INACTIVE' then
    -- Correcao (revisao F5, item 6): status ACTIVE confirmado e ESTADO
    -- DEFINITIVO (a assinatura foi reativada, nunca vai virar INACTIVE
    -- sozinha): fecha ignorado. Qualquer outro status intermediario
    -- (ambiguo, ainda pode virar INACTIVE) continua aguardando.
    if coalesce(v_status, '') = 'ACTIVE' then
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', v_org, 'order_id', null, 'alarme', null, 'erro_codigo', 'assinatura_reativada');
    end if;
    return jsonb_build_object('resultado', 'aguardando', 'organization_id', v_org, 'order_id', null, 'alarme', null, 'erro_codigo', null);
  end if;

  -- confirmado: liga cancel_at_period_end sempre; grava o marcador (decisão
  -- 22) só quando DELETED ou removida = true (M3: INACTIVE puro não marca).
  v_cancel_anterior := coalesce(v_contract.cancel_at_period_end, false);

  update public.billing_contracts
     set cancel_at_period_end = true,
         asaas_assinatura_encerrada_em = case
           when p_evento_tipo = 'SUBSCRIPTION_DELETED' or v_removida then coalesce(v_contract.asaas_assinatura_encerrada_em, now())
           else v_contract.asaas_assinatura_encerrada_em
         end
   where id = v_contract.id;

  if not v_cancel_anterior then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', v_cancel_anterior::text, 'true',
      case when p_evento_tipo = 'SUBSCRIPTION_DELETED' then 'sub_deletada' else 'sub_inativada' end, null);
  end if;

  update public.billing_orders
     set status = 'cancelado'
   where organization_id = v_org
     and asaas_subscription_id = v_subscription_id
     and status in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando');

  return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
end;
$$;

comment on function public.fn_billing_asaas_aplicar_fim_da_assinatura(text, jsonb, text) is
  '0909, PARTE 7 (correção, revisão F5, itens 2, 4, 6): redefine a versão da Tarefa 6. Item 2: PAYMENT_OVERDUE/PAYMENT_DELETED cuja assinatura roteia como renovacao fecha ignorado (nunca devolve a categoria crua, que não está no CHECK de resultado). Item 4: PAYMENT_OVERDUE do primeiro pagamento de um pedido de ASSINATURA grava remover_assinatura_pendente; pedido avulso continua com remover_cobranca_pendente. Item 6: PAYMENT_OVERDUE com status já RECEIVED/CONFIRMED/RECEIVED_IN_CASH, PAYMENT_DELETED com removida=false (restaurado) e SUBSCRIPTION_INACTIVATED com status=ACTIVE (reativada) são estados DEFINITIVOS: fecham ignorado com erro_codigo, nunca ficam aguardando para sempre. Resto do corpo idêntico à Tarefa 6 (marcador de encerramento só com DELETED/removida, SUBSCRIPTION_UPDATED ACTIVE desliga cancel_at_period_end, cancela pedido aberto). Interna: nenhum grant, nem a service_role (revoke da Tarefa 6 continua valendo).';

-- ── 45. fn_billing_asaas_aplicar_evento REDEFINIDA (itens 1, 2, 6, 9) ──
--
-- Item 9: todo evento fechado outro_app (pelo sentinela do pré-roteamento OU
-- por uma categoria outro_app vinda de dentro de aplicar_pagamento/
-- aplicar_estorno) tem o payload zerado ({}) e payload_podado_em gravado na
-- hora, no MESMO ponto único (o UPDATE final): é dado de cliente de OUTRO
-- produto, sem motivo para ficar guardado aqui. Item 1/6/11: erro_codigo
-- passa a vir de v_aplicacao->>erro_codigo nos três despachos (pagamento,
-- estorno, fim de assinatura), não mais hardcoded null: os códigos novos
-- (status_nao_confirma_evento, sandbox_nao_concede, pagamento_ja_recebido,
-- etc.) chegam até a tela do admin. Item 6: dentro de cada um dos três
-- begin/exception, uma falha TRANSITÓRIA de banco (lock_not_available,
-- deadlock_detected, serialization_failure) volta para aguardando (o MESMO
-- backoff do M8, logo abaixo), nunca vira erro final igual a uma falha de
-- verdade (when others, inalterado). Item 2: o UPDATE final inteiro passa a
-- rodar dentro de um begin/exception próprio: se ele falhar por qualquer
-- motivo (inclusive um resultado fora do CHECK, que não deveria mais
-- acontecer depois do item 2 acima, mas a defesa em profundidade é o próprio
-- pedido da revisão), a função grava a falha com o MESMO backoff de
-- fn_billing_asaas_registrar_falha em vez de propagar a exceção (o que
-- travaria o processador inteiro na mesma rodada).
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
  v_tentativas integer;
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

  -- M8 (Tarefa 6): o pré-roteamento sem GET (decisão 6) já decidiu
  -- "outro_app" olhando só o payload, sem gastar GET nenhum. O processador
  -- (lib/billing/asaas/processar-eventos.ts, fora desta migration) chama
  -- esta função com o SENTINELA p_confirmacao = {"pre_roteamento":"outro_app"}
  -- (nenhum outro campo) em vez de null.
  if p_confirmacao is not null and p_confirmacao = '{"pre_roteamento":"outro_app"}'::jsonb then
    v_resultado := 'outro_app';
    v_erro_codigo := null;
    v_organization_id := null;
    v_alarme := null;
  elsif v_evento.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH') then
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
        -- Correção (revisão F5, item 11 e outros): erro_codigo vem da
        -- própria aplicação (sandbox_nao_concede, por exemplo), não mais
        -- hardcoded null.
        v_erro_codigo := nullif(v_aplicacao->>'erro_codigo', '');
      exception
        -- Correção (revisão F5, item 6): falha TRANSITÓRIA de banco nunca é
        -- erro final na primeira vez, é retentativa com backoff (M8, abaixo
        -- decide o resto: até a nona falha continua aguardando, na décima
        -- vira erro).
        when lock_not_available or deadlock_detected or serialization_failure then
          v_resultado := 'aguardando';
          v_erro_codigo := left(sqlerrm, 200);
          v_organization_id := null;
          v_alarme := null;
        when others then
          v_resultado := 'erro';
          v_erro_codigo := left(sqlerrm, 200);
          v_organization_id := null;
          v_alarme := null;
      end;
    end if;
  elsif v_evento.event_type in (
    -- Acréscimo (revisão F5, pedido do coordenador): PAYMENT_CHARGEBACK_
    -- DISPUTE despacha para fn_billing_asaas_aplicar_estorno como o resto da
    -- família de chargeback; o processador (fora desta migration) manda a
    -- confirmação desse tipo no MESMO contrato de p_confirmacao do estorno.
    'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED',
    'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL'
  ) then
    if p_confirmacao is null then
      v_resultado := 'aguardando';
      v_erro_codigo := 'billing_confirmacao_ausente';
      v_organization_id := null;
      v_alarme := null;
    else
      begin
        v_aplicacao := public.fn_billing_asaas_aplicar_estorno(v_evento.event_type, p_confirmacao, v_evento.ambiente);
        v_resultado := v_aplicacao->>'resultado';
        v_organization_id := nullif(v_aplicacao->>'organization_id', '')::uuid;
        v_alarme := nullif(v_aplicacao->>'alarme', '');
        -- Correção (revisão F5, item 1): erro_codigo vem da própria
        -- aplicação (status_nao_confirma_evento, por exemplo).
        v_erro_codigo := nullif(v_aplicacao->>'erro_codigo', '');
      exception
        when lock_not_available or deadlock_detected or serialization_failure then
          v_resultado := 'aguardando';
          v_erro_codigo := left(sqlerrm, 200);
          v_organization_id := null;
          v_alarme := null;
        when others then
          v_resultado := 'erro';
          v_erro_codigo := left(sqlerrm, 200);
          v_organization_id := null;
          v_alarme := null;
      end;
    end if;
  elsif v_evento.event_type in (
    'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED'
  ) then
    if p_confirmacao is null then
      v_resultado := 'aguardando';
      v_erro_codigo := 'billing_confirmacao_ausente';
      v_organization_id := null;
      v_alarme := null;
    else
      begin
        v_aplicacao := public.fn_billing_asaas_aplicar_fim_da_assinatura(v_evento.event_type, p_confirmacao, v_evento.ambiente);
        v_resultado := v_aplicacao->>'resultado';
        v_organization_id := nullif(v_aplicacao->>'organization_id', '')::uuid;
        v_alarme := nullif(v_aplicacao->>'alarme', '');
        -- Correção (revisão F5, itens 2 e 6): erro_codigo vem da própria
        -- aplicação (cobranca_de_renovacao, pagamento_ja_recebido,
        -- pagamento_restaurado, assinatura_reativada, etc.).
        v_erro_codigo := nullif(v_aplicacao->>'erro_codigo', '');
      exception
        when lock_not_available or deadlock_detected or serialization_failure then
          v_resultado := 'aguardando';
          v_erro_codigo := left(sqlerrm, 200);
          v_organization_id := null;
          v_alarme := null;
        when others then
          v_resultado := 'erro';
          v_erro_codigo := left(sqlerrm, 200);
          v_organization_id := null;
          v_alarme := null;
      end;
    end if;
  else
    v_resultado := 'ignorado';
    v_erro_codigo := null;
    v_organization_id := null;
    v_alarme := null;
  end if;

  -- M8: aguardando NÃO pode ser reservado de novo a cada minuto sem limite
  -- (o mesmo backoff de fn_billing_asaas_registrar_falha, Tarefa 4, decisão
  -- 20, reaproveitando a MESMA coluna tentativas): tentativas + 1; até a
  -- nona continua aguardando com backoff now() + least(2^tentativas
  -- minutos, 6 horas); na décima vira erro, visível ao admin. Qualquer outro
  -- resultado (aplicado, ja_aplicado, divergente, outro_app, sem_vinculo,
  -- ignorado, erro) é terminal: tentativas fica como está (histórico) e
  -- proxima_tentativa_em volta a null (o evento já não está no índice dos
  -- pendentes, que exige resultado = aguardando).
  if v_resultado = 'aguardando' then
    v_tentativas := v_evento.tentativas + 1;
    if v_tentativas >= 10 then
      v_resultado := 'erro';
      v_erro_codigo := coalesce(v_erro_codigo, 'billing_aguardando_sem_confirmacao_apos_10_tentativas');
    end if;
  else
    v_tentativas := v_evento.tentativas;
  end if;

  -- Correção (revisão F5, item 2): o UPDATE final nunca propaga. Qualquer
  -- falha aqui (inclusive um resultado fora do CHECK, que não deveria mais
  -- acontecer depois da correção do item 2 em fn_billing_asaas_aplicar_fim_
  -- da_assinatura, mas a defesa em profundidade é o próprio pedido da
  -- revisão) vira retentativa com o MESMO backoff de fn_billing_asaas_
  -- registrar_falha, em vez de derrubar o processador inteiro na rodada.
  begin
    update public.asaas_webhook_events
       set resultado = v_resultado,
           erro_codigo = v_erro_codigo,
           organization_id = coalesce(v_organization_id, organization_id),
           alarme = v_alarme,
           -- Item 9: outro_app poda o payload na hora, dado de cliente de
           -- outro produto.
           payload = case when v_resultado = 'outro_app' then '{}'::jsonb else payload end,
           payload_podado_em = case when v_resultado = 'outro_app' then now() else payload_podado_em end,
           tentativas = v_tentativas,
           proxima_tentativa_em = case
             when v_resultado = 'aguardando' then now() + least(
               power(2::double precision, v_tentativas::double precision) * interval '1 minute',
               interval '6 hours'
             )
             else null
           end,
           processado_em = now(),
           lease_token = null,
           lease_expira_em = null
     where id = p_evento;
  exception when others then
    v_resultado := 'aguardando';
    v_erro_codigo := left('billing_update_final_falhou:' || sqlerrm, 200);
    v_tentativas := v_evento.tentativas + 1;
    if v_tentativas >= 10 then
      v_resultado := 'erro';
    end if;
    update public.asaas_webhook_events
       set resultado = v_resultado,
           erro_codigo = v_erro_codigo,
           tentativas = v_tentativas,
           proxima_tentativa_em = case
             when v_resultado = 'aguardando' then now() + least(
               power(2::double precision, v_tentativas::double precision) * interval '1 minute',
               interval '6 hours'
             )
             else null
           end,
           processado_em = now(),
           lease_token = null,
           lease_expira_em = null
     where id = p_evento;
  end;

  return jsonb_build_object(
    'evento_id', p_evento,
    'resultado', v_resultado,
    'organization_id', v_organization_id,
    'alarme', v_alarme
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_evento(uuid, uuid, jsonb) is
  '0909, PARTE 7 (correção, revisão F5, itens 1, 2, 6, 9): redefine a versão da Tarefa 6. Item 9: todo resultado outro_app poda o payload ({}) e grava payload_podado_em na hora, num único ponto (o UPDATE final), qualquer que seja o caminho que decidiu outro_app (sentinela do pré-roteamento ou categoria vinda de dentro de aplicar_pagamento/aplicar_estorno). Itens 1/6/11: erro_codigo passa a vir de v_aplicacao->>erro_codigo nos três despachos, não mais hardcoded null. Item 6: cada um dos três begin/exception ganha um WHEN específico para lock_not_available/deadlock_detected/serialization_failure, que vira aguardando (retentativa com o backoff do M8) em vez de erro final; when others continua erro imediato (falha de verdade, não transitória). Item 2: o UPDATE final roda dentro do seu próprio begin/exception; qualquer falha ali (inclusive um resultado fora do CHECK) vira retentativa com o mesmo backoff de fn_billing_asaas_registrar_falha, nunca propaga. Resto do corpo idêntico à Tarefa 6 (sentinela do pré-roteamento, despacho por event_type, M8: todo aguardando ganha backoff e vira erro na décima).';
