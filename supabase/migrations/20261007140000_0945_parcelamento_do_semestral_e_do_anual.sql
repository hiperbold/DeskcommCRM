-- 0945, parcelamento do semestral e do anual no cartão (D-177, parte 1, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do Filipe em 06/10/2026: o semestral parcela em até 6x e o anual em até 12x, só no cartão,
-- em todos os planos (Pro, Max e Escale). De 1x a 3x o total é o preço do ciclo (a Hiperbold arca
-- com a taxa do cartão). De 4x em diante o comprador paga juros de 1,99% ao mês, Tabela Price:
-- parcela = preço x i / (1 - (1 + i)^-n), arredondada ao centavo (half-up), total = parcela x n. O
-- mensal não parcela, o Pix segue à vista, e o 1x continua a assinatura do Asaas que renova sozinha.
-- De 2x em diante o Asaas cria uma COBRANÇA PARCELADA avulsa (POST /payments com installmentCount e
-- totalValue, sem assinatura): paga o período e NÃO renova sozinha.
--
-- O que esta migration faz:
--   1. billing_orders ganha parcelas (1 = à vista) e asaas_installment_id (o id do parcelamento no
--      Asaas, um UUID, só em pedido parcelado). amount_cents do pedido parcelado é o TOTAL com juros.
--      Check: parcelas só passa de 1 em pedido de assinatura, no cartão, semestral ou anual.
--   2. billing_settings guarda os parâmetros (taxa mensal, até quantas parcelas sem juros, teto do
--      semestral e do anual), semeados UMA vez pela marca parcelamento_semeado_em, como os preços de
--      ciclo da 0942: o admin que mudar um valor depois não o vê voltar na reaplicação do baseline.
--   3. fn_billing_parcelamento_total refaz no banco a conta do total (a mesma de
--      lib/billing/asaas/parcelamento.ts). fn_billing_criar_pedido ganha p_parcelas e p_total_cents
--      (por último, com default) e recusa parcelamento fora do cartão, fora do semestral e do anual,
--      acima do teto do ciclo e com total diferente do que o banco calcula.
--   4. fn_billing_pedido_registrar_parcelamento grava o id do parcelamento no pedido (função à parte,
--      para não mexer na assinatura de fn_billing_pedido_registrar_cobranca).
--   5. fn_billing_asaas_rotear_pagamento: a parcela seguinte de um parcelamento cujo pedido já está
--      pago ainda é roteada para o pedido (todas as parcelas levam o externalReference do pedido).
--   6. fn_billing_asaas_aplicar_pagamento: o período é concedido UMA vez por parcelamento, pela
--      primeira parcela confirmada, com a conta do Pix (6 ou 12 meses, empilhando sobre período pago
--      a frente). A conferência de valor usa o TOTAL do parcelamento (GET /installments/{id}) contra
--      amount_cents, nunca o valor da parcela contra o preço. Cada parcela entra em billing_payments,
--      ligada ao pedido: a primeira com o período, as demais com período nulo (como o pacote de
--      tokens: o período é um só e não se repete por parcela). As parcelas seguintes são idempotentes
--      pelo asaas_payment_id.
--   7. fn_billing_asaas_aplicar_estorno: estorno de parcela no parcelamento só vale como estorno do
--      pedido quando TODAS as parcelas foram estornadas; antes disso só alarma
--      (estorno_parcial_do_parcelamento), sem cortar o acesso nem marcar o pedido estornado. Estornadas
--      todas, corta como o estorno total de hoje, com o período da parcela que concedeu.
--
-- "Não renova sozinho" não tem coluna: é derivado. Contrato com gateway asaas e SEM assinatura viva
-- (asaas_subscription_id nulo ou com asaas_assinatura_encerrada_em preenchido) tem o período corrente
-- pago por Pix ou por parcelamento, e nada o cobra de novo. O pedido pago (billing_orders.parcelas e
-- metodo) diz de qual dos dois se trata. A régua de aviso de renovação (tarefa à parte) lê isso.
--
-- Cancelamento no meio do período parcelado: igual ao à vista. O acesso vai até o fim do período, não
-- há estorno automático e nenhuma chamada ao Asaas para as parcelas; estorno só manual pelo admin.
--
-- Reaplicável com o app no ar: DDL só com lock_timeout curto e só quando falta; tudo que cria ou
-- derruba função vai dentro de UMA transação curta (begin ... commit), com ACL junto, como a 0943.

-- ── 1. As colunas e a restrição de billing_orders; os parâmetros de billing_settings ──
do $parcelamento_ddl$
declare
  v_coluna record;
begin
  perform set_config('lock_timeout', '3s', true);

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'billing_orders' and column_name = 'parcelas'
  ) then
    alter table public.billing_orders add column parcelas integer not null default 1;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'billing_orders' and column_name = 'asaas_installment_id'
  ) then
    alter table public.billing_orders add column asaas_installment_id text;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.billing_orders'::regclass and conname = 'billing_orders_parcelas_check'
  ) then
    alter table public.billing_orders
      add constraint billing_orders_parcelas_check
      check (
        parcelas between 1 and 12
        and (parcelas = 1 or (tipo = 'assinatura' and metodo = 'CREDIT_CARD' and ciclo in ('semiannual', 'yearly')))
        and (asaas_installment_id is null or parcelas > 1)
      );
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'billing_orders_asaas_installment_id_unique'
  ) then
    create unique index billing_orders_asaas_installment_id_unique
      on public.billing_orders (asaas_installment_id)
      where asaas_installment_id is not null;
  end if;

  for v_coluna in
    select * from (values
      ('parcelamento_taxa_mensal', 'numeric(7,6)'),
      ('parcelamento_sem_juros_ate', 'integer'),
      ('parcelamento_max_semestral', 'integer'),
      ('parcelamento_max_anual', 'integer'),
      ('parcelamento_semeado_em', 'timestamptz')
    ) as t(nome, tipo)
  loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'billing_settings' and column_name = v_coluna.nome
    ) then
      execute format('alter table public.billing_settings add column %I %s', v_coluna.nome, v_coluna.tipo);
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.billing_settings'::regclass and conname = 'billing_settings_parcelamento_check'
  ) then
    alter table public.billing_settings
      add constraint billing_settings_parcelamento_check
      check (
        (parcelamento_taxa_mensal is null or (parcelamento_taxa_mensal >= 0 and parcelamento_taxa_mensal <= 0.2))
        and (parcelamento_sem_juros_ate is null or parcelamento_sem_juros_ate between 1 and 12)
        and (parcelamento_max_semestral is null or parcelamento_max_semestral between 1 and 12)
        and (parcelamento_max_anual is null or parcelamento_max_anual between 1 and 12)
      );
  end if;

  -- Semeadura UMA vez (a marca é o último passo): taxa de 1,99% ao mês, 3x sem juros, semestral até
  -- 6x e anual até 12x. Parâmetro que o admin mudar ou zerar depois não volta na reaplicação do
  -- baseline.
  if exists (select 1 from public.billing_settings where id = 1 and parcelamento_semeado_em is null) then
    update public.billing_settings
       set parcelamento_taxa_mensal = 0.0199,
           parcelamento_sem_juros_ate = 3,
           parcelamento_max_semestral = 6,
           parcelamento_max_anual = 12,
           parcelamento_semeado_em = now()
     where id = 1;
  end if;
end
$parcelamento_ddl$;

comment on column public.billing_orders.parcelas is
  '0945 (D-177): em quantas parcelas o cartão foi vendido. 1 = à vista (assinatura do Asaas que renova sozinha, ou Pix). De 2 em diante é cobrança parcelada avulsa (sem assinatura, não renova sozinha) e amount_cents é o TOTAL com juros, igual ao totalValue enviado ao Asaas.';

comment on column public.billing_orders.asaas_installment_id is
  '0945 (D-177): id do parcelamento no Asaas (um UUID, sem prefixo), só em pedido parcelado. As cobranças das parcelas levam o externalReference do pedido; o total do parcelamento (GET /installments/{id}) é o que se confere contra amount_cents.';

comment on column public.billing_settings.parcelamento_taxa_mensal is
  '0945 (D-177): taxa de juros ao mês pagos pelo comprador no parcelamento (0,0199 = 1,99%), Tabela Price, a partir da primeira parcela acima de parcelamento_sem_juros_ate. Nula ou zero = parcelamento sem juros.';

comment on column public.billing_settings.parcelamento_sem_juros_ate is
  '0945 (D-177): até quantas parcelas o total é o preço do ciclo (a Hiperbold arca com a taxa do cartão). Nulo conta como 1.';

comment on column public.billing_settings.parcelamento_max_semestral is
  '0945 (D-177): teto de parcelas do semestral. Nulo = só à vista.';

comment on column public.billing_settings.parcelamento_max_anual is
  '0945 (D-177): teto de parcelas do anual. Nulo = só à vista.';

comment on column public.billing_settings.parcelamento_semeado_em is
  '0945 (D-177): quando os parâmetros de parcelamento da decisão de 06/10/2026 foram semeados. Nula = ainda não semeou. A semeadura roda uma única vez: valor que o admin mudar depois não volta na reaplicação do baseline.';

-- ── 2. Funções novas e redefinidas, numa transação curta (ACL junto) ──
--
-- fn_billing_criar_pedido ganha dois parâmetros no fim, com default. A assinatura antiga (dez
-- parâmetros, da 0943) e a de nove (da 0909) são derrubadas ANTES do create: com elas ao lado da
-- nova, toda chamada com menos argumentos casaria com mais de uma e o Postgres recusaria por
-- ambiguidade. As funções novas nascem expostas (ACL padrão do Supabase) até o revoke; sem a
-- transação haveria uma janela em que anon e authenticated as executariam. Se qualquer instrução
-- falhar, o commit desfaz o bloco inteiro.
begin;

-- ── 2a. fn_billing_parcelamento_total: a conta do total, refeita no banco ──
create or replace function public.fn_billing_parcelamento_total(
  p_preco_cents integer,
  p_parcelas integer,
  p_taxa numeric,
  p_sem_juros_ate integer
)
returns integer
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
declare
  v_parcela numeric;
begin
  if p_preco_cents is null or p_preco_cents <= 0 or p_parcelas is null or p_parcelas < 1 then
    raise exception 'billing_parcelamento_entrada_invalida' using errcode = '22023';
  end if;

  -- 1x, até o limite sem juros, ou taxa nula: o total é o preço do ciclo.
  if p_parcelas = 1 or coalesce(p_taxa, 0) <= 0 or p_parcelas <= coalesce(p_sem_juros_ate, 1) then
    return p_preco_cents;
  end if;

  -- Tabela Price: parcela = preço x i / (1 - (1 + i)^-n), arredondada ao centavo (round do numeric é
  -- half-up em valor positivo); total = parcela x n.
  v_parcela := round(p_preco_cents::numeric * p_taxa / (1 - power(1 + p_taxa, -p_parcelas::numeric)));
  return (v_parcela * p_parcelas)::integer;
end;
$$;

comment on function public.fn_billing_parcelamento_total(integer, integer, numeric, integer) is
  '0945 (D-177): o total que o comprador paga no parcelamento do cartão. 1x, até p_sem_juros_ate parcelas ou taxa nula: o preço do ciclo. Acima disso, Tabela Price a p_taxa ao mês: parcela = preço x i / (1 - (1 + i)^-n) arredondada ao centavo, total = parcela x n. A mesma conta de lib/billing/asaas/parcelamento.ts (o teste de banco compara as duas). Interna: deny-all.';

revoke execute on function public.fn_billing_parcelamento_total(integer, integer, numeric, integer) from public, anon, authenticated, service_role;

-- ── 2b. fn_billing_pedido_registrar_parcelamento: grava o id do parcelamento no pedido ──
create or replace function public.fn_billing_pedido_registrar_parcelamento(
  p_org uuid,
  p_pedido uuid,
  p_asaas_installment_id text
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
  if p_asaas_installment_id is null or p_asaas_installment_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'billing_asaas_installment_id_formato_invalido' using errcode = '22023';
  end if;

  select * into v_pedido
    from public.billing_orders
    where id = p_pedido and organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_pedido_nao_encontrado' using errcode = 'P0002';
  end if;

  if v_pedido.parcelas <= 1 then
    raise exception 'billing_pedido_nao_e_parcelado' using errcode = '22023';
  end if;

  if v_pedido.status not in ('criado', 'processando', 'aguardando_pagamento', 'inconclusivo') then
    raise exception 'billing_pedido_status_invalido_para_cobranca' using errcode = '22023';
  end if;

  if v_pedido.asaas_installment_id is not null then
    if v_pedido.asaas_installment_id = p_asaas_installment_id then
      return jsonb_build_object('ja_registrado', true, 'pedido_id', v_pedido.id);
    end if;
    raise exception 'billing_parcelamento_conflito' using errcode = '22023';
  end if;

  update public.billing_orders set asaas_installment_id = p_asaas_installment_id where id = v_pedido.id;

  return jsonb_build_object('ja_registrado', false, 'pedido_id', v_pedido.id);
end;
$$;

comment on function public.fn_billing_pedido_registrar_parcelamento(uuid, uuid, text) is
  '0945 (D-177): grava no pedido parcelado o id do parcelamento no Asaas (a resposta do POST /payments com installmentCount traz o id na primeira parcela). Idempotente: o mesmo id devolve ja_registrado; id diferente do já gravado é 22023 (billing_parcelamento_conflito). Pedido à vista é 22023 (billing_pedido_nao_e_parcelado); pedido que não está aberto também. Pedido inexistente ou de outra organização: P0002.';

revoke execute on function public.fn_billing_pedido_registrar_parcelamento(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_billing_pedido_registrar_parcelamento(uuid, uuid, text) to service_role;

-- ── 2c. fn_billing_criar_pedido com parcelas e total ──
drop function if exists public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text);
drop function if exists public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid);

create or replace function public.fn_billing_criar_pedido(
  p_org uuid,
  p_tipo text,
  p_plan_code text,
  p_ciclo text,
  p_pacote text,
  p_metodo text,
  p_ambiente text,
  p_chave uuid,
  p_actor uuid,
  p_termos_versao text default null,
  p_parcelas integer default 1,
  p_total_cents integer default null
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
  v_preco_ciclo integer;
  v_existente record;
  v_pedido_id uuid;
  v_external_reference text;
  v_proxima_cobranca_em date;
  v_parcelas integer := coalesce(p_parcelas, 1);
  v_cfg record;
  v_teto_parcelas integer;
  v_total_calculado integer;
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

  -- 0943 (D-133): aceite dos Termos de Uso. A compra do CLIENTE (p_actor preenchido: o usuário que
  -- clicou) só nasce com a versão dos Termos aceita; a chamada interna sem ator (script de
  -- homologação, ferramenta do operador) segue sem aceite, com p_termos_versao nulo. Versão em
  -- branco ou longa demais é recusada em qualquer chamada: o banco nunca guarda lixo como versão.
  if p_termos_versao is not null and (btrim(p_termos_versao) = '' or length(p_termos_versao) > 40) then
    raise exception 'billing_termos_invalidos' using errcode = '22023';
  end if;

  if p_actor is not null and p_termos_versao is null then
    raise exception 'billing_termos_nao_aceitos' using errcode = '22023';
  end if;

  -- 0945 (D-177): parcelamento. Número de parcelas inteiro de 1 a 12 (o teto do ciclo vem de
  -- billing_settings, mais abaixo). Só a assinatura semestral ou anual no cartão parcela: pacote de
  -- tokens, mensal e Pix ficam à vista.
  if v_parcelas < 1 or v_parcelas > 12 then
    raise exception 'billing_parcelas_invalidas' using errcode = '22023';
  end if;

  if v_parcelas > 1 then
    if p_tipo <> 'assinatura' or p_ciclo is null or p_ciclo not in ('semiannual', 'yearly') then
      raise exception 'billing_parcelamento_indisponivel' using errcode = '22023';
    end if;
    if p_metodo <> 'CREDIT_CARD' then
      raise exception 'billing_parcelamento_so_no_cartao' using errcode = '22023';
    end if;
  end if;

  if p_tipo = 'assinatura' then
    if p_plan_code is null or btrim(p_plan_code) = '' then
      raise exception 'billing_plan_code_obrigatorio' using errcode = '22023';
    end if;
    if p_ciclo not in ('monthly', 'semiannual', 'yearly') then
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
      -- semiannual e yearly: cartão ou Pix (decisão 2, estendida ao semestral na
      -- 0941), cada um com o próprio preço do período inteiro. Plano sem preço
      -- do ciclo (coluna nula ou zero) não aparece para compra desse ciclo, com
      -- CREDIT_CARD ou com PIX: o preço nunca vem da entrada nem se calcula.
      v_preco_ciclo := case p_ciclo
        when 'semiannual' then v_plan.price_semiannual_cents
        else v_plan.price_yearly_cents
      end;
      if coalesce(v_preco_ciclo, 0) <= 0 then
        raise exception 'billing_preco_nao_definido' using errcode = '22023';
      end if;
      v_amount_cents := v_preco_ciclo;

      -- 0945 (D-177): parcelamento. O teto e a taxa vêm de billing_settings (nunca da entrada); o
      -- total é a conta do banco, e quem chama manda o que calculou só para ser CONFERIDO: total
      -- diferente é recusado, e o amount_cents do pedido parcelado é sempre o do banco.
      if v_parcelas > 1 then
        select parcelamento_taxa_mensal, parcelamento_sem_juros_ate,
               parcelamento_max_semestral, parcelamento_max_anual
          into v_cfg
          from public.billing_settings
          where id = 1;

        v_teto_parcelas := coalesce(
          case p_ciclo when 'semiannual' then v_cfg.parcelamento_max_semestral else v_cfg.parcelamento_max_anual end,
          1
        );
        if v_parcelas > v_teto_parcelas then
          raise exception 'billing_parcelas_acima_do_teto' using errcode = '22023';
        end if;

        v_total_calculado := public.fn_billing_parcelamento_total(
          v_preco_ciclo, v_parcelas, v_cfg.parcelamento_taxa_mensal, v_cfg.parcelamento_sem_juros_ate
        );
        if p_total_cents is distinct from v_total_calculado then
          raise exception 'billing_parcelamento_total_divergente' using errcode = '22023';
        end if;
        v_amount_cents := v_total_calculado;
      end if;
    end if;

    -- 0942: troca de PLANO com período pago vigente também fica de fora. O Pix de outro plano
    -- empilhava o período sobre o do plano atual e, no pagamento, o plan_id trocava na hora: o
    -- cliente passava a ter o plano novo pelo período velho, e o período empilhado pagava um
    -- plano que ele ainda não podia usar. Vale para cartão e Pix. Mesmo plano e mesmo ciclo
    -- empilha normalmente (renovação antecipada). Período pago vigente = pagamento recebido, não
    -- estornado, com fim no futuro: contrato com período só de cortesia (sem pagamento) troca
    -- de plano comprando, como sempre. Vem ANTES da recusa de troca de ciclo.
    if v_contract.status = 'ativa'
       and v_contract.plan_id is distinct from v_plan_id
       and v_contract.current_period_end is not null
       and v_contract.current_period_end > now()
       and exists (
         select 1 from public.billing_payments p
          where p.organization_id = p_org
            and p.status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
            and p.billing_period_end > now()
            and not exists (
              select 1 from public.billing_payments r
               where r.estorna_pagamento_id = p.id and r.status = 'REFUNDED'
            )
       )
    then
      raise exception 'billing_troca_de_plano_indisponivel' using errcode = '22023';
    end if;

    -- 0941: troca de ciclo de quem já tem contrato em andamento fica de fora
    -- desta fase. Contrato ativo, com ciclo conhecido e período ainda pago, não
    -- aceita pedido de OUTRO ciclo (nem pelo cartão, nem pelo Pix): a troca
    -- pediria crédito proporcional e cancelar a assinatura do Asaas, e isso
    -- ainda não foi decidido. Contrato sem ciclo (registro manual), vencido,
    -- suspenso ou cancelado não entra aqui. Vem ANTES da recusa de assinatura
    -- viva para a pessoa ler o motivo certo.
    if v_contract.status = 'ativa'
       and v_contract.cycle is not null
       and v_contract.cycle <> p_ciclo
       and v_contract.current_period_end is not null
       and v_contract.current_period_end > now()
    then
      raise exception 'billing_troca_de_ciclo_indisponivel' using errcode = '22023';
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

  -- 0945: à vista com total informado também é conferido (o total de quem não parcela é o preço).
  if v_parcelas = 1 and p_total_cents is not null and p_total_cents <> v_amount_cents then
    raise exception 'billing_parcelamento_total_divergente' using errcode = '22023';
  end if;

  -- Idempotência pela chave (decisão 13), DEPOIS de resolver o catálogo
  -- (decisão 17): compara contra o que o banco decidiu, nunca contra a
  -- entrada crua.
  select * into v_existente
    from public.billing_orders
    where organization_id = p_org and chave = p_chave;

  if found then
    if v_existente.tipo = p_tipo
      and v_existente.parcelas = v_parcelas
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
        'parcelas', v_existente.parcelas,
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
    metodo, amount_cents, chave, criado_por, termos_versao, termos_aceitos_em, parcelas
  ) values (
    p_org, p_ambiente, p_tipo, v_plan_id, v_ciclo, v_pacote_id, v_tokens,
    p_metodo, v_amount_cents, p_chave, p_actor, btrim(p_termos_versao),
    case when p_termos_versao is null then null else now() end,
    v_parcelas
  )
  returning id, external_reference into v_pedido_id, v_external_reference;

  return jsonb_build_object(
    'pedido_id', v_pedido_id,
    'external_reference', v_external_reference,
    'amount_cents', v_amount_cents,
    'parcelas', v_parcelas,
    'ja_existia', false,
    'proxima_cobranca_em', v_proxima_cobranca_em
  );
end;
$$;

comment on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer) is
  '0909, Tarefa 3, redefinida na 0941 (venda semestral e anual, D-176), na 0942 (auditoria do lote 15), na 0943 (aceite dos Termos, D-133) e na 0945 (parcelamento, D-177): cria o pedido de compra (decisões 2, 6, 8, 11, 12, 17, 18, 25, 26). Ciclos monthly (só cartão), semiannual e yearly (cartão ou Pix), cada um com o preço da sua coluna do catálogo. Contrato ativo com período pago em OUTRO ciclo recusa com billing_troca_de_ciclo_indisponivel (22023); com período PAGO vigente de OUTRO plano, billing_troca_de_plano_indisponivel (22023). Aceite dos Termos (0943): p_termos_versao é gravado com o momento; a compra com ator sem versão recusa com billing_termos_nao_aceitos (22023). Parcelamento (0945): p_parcelas (default 1) e p_total_cents (default nulo), os dois últimos. Só a assinatura semestral ou anual no cartão parcela (billing_parcelamento_indisponivel, billing_parcelamento_so_no_cartao, billing_parcelas_invalidas fora de 1 a 12, billing_parcelas_acima_do_teto contra billing_settings.parcelamento_max_semestral e parcelamento_max_anual). O total é a conta do banco (fn_billing_parcelamento_total: preço do ciclo até parcelamento_sem_juros_ate parcelas, Tabela Price à taxa parcelamento_taxa_mensal acima disso); p_total_cents é só conferido e total diferente recusa com billing_parcelamento_total_divergente (22023). amount_cents do pedido parcelado é o total com juros, e billing_orders.parcelas guarda o número de parcelas. Preço, plano (versão ativa), ciclo, pacote, tokens e total vêm SEMPRE do banco, nunca da entrada (decisão 17). Recusas 22023 com mensagem própria: billing_compra_desligada, billing_plano_fora_de_venda, billing_preco_nao_definido, billing_metodo_invalido_para_oferta, billing_ja_tem_assinatura_asaas, billing_pedido_aberto_existe (mais as validações estruturais de tipo/metodo/ambiente/ciclo/plan_code/pacote). Lê billing_settings SEM for share (decisão 12). Idempotente pela chave: mesmos valores (inclusive as parcelas) devolve ja_existia = true e o pedido (e o aceite) originais; valores diferentes, 22023 (billing_chave_com_valores_diferentes). Devolve proxima_cobranca_em (decisão 26) e parcelas.';

revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer) to service_role;

-- agent_worker (se a role existir) perde execute nas funções novas e na assinatura nova de criar_pedido.
do $agent_worker_parcelamento$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer), public.fn_billing_parcelamento_total(integer, integer, numeric, integer), public.fn_billing_pedido_registrar_parcelamento(uuid, uuid, text) from agent_worker';
  end if;
end
$agent_worker_parcelamento$;

-- ── 2d. fn_billing_asaas_rotear_pagamento: a parcela seguinte de um parcelamento já pago ──
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
        and status not in ('pago', 'estornado')
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
      where asaas_subscription_id = p_subscription and asaas_ambiente = p_ambiente
        and asaas_assinatura_encerrada_em is null;
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
          and (
            status not in ('pago', 'estornado', 'falhou')
            -- 0945 (D-177): as parcelas seguintes de um parcelamento já pago (a primeira concedeu o
            -- período e fechou o pedido) ainda pertencem ao pedido.
            or (status = 'pago' and parcelas > 1)
          );
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
        and status not in ('pago', 'estornado');
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
  '0909, PARTE 8 (correção, item 3), redefinida na 0942 e na 0945: a busca por asaas_subscription_id e a busca por asaas_payment_id admitem pedido falhou (só pago e estornado ficam fora); a busca por external_reference continua excluindo pago, estornado E falhou, EXCETO o pedido PARCELADO já pago (billing_orders.parcelas > 1, D-177): as parcelas seguintes ao período concedido pela primeira ainda são roteadas para o pedido. A RENOVAÇÃO só casa com contrato cuja assinatura NÃO tem o marcador de encerramento (asaas_assinatura_encerrada_em nulo): cobrança tardia de assinatura encerrada cai como sem_vinculo, nunca estende o período. STABLE, sem travar nada.';

revoke execute on function public.fn_billing_asaas_rotear_pagamento(text, text, text, text) from public, anon, authenticated, service_role;

-- ── 2e. fn_billing_asaas_aplicar_pagamento: o período uma vez por parcelamento ──
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
  v_inicio_do_dia timestamptz;
  v_intervalo interval;
  v_estado_anterior text;
  v_fim_anterior timestamptz;
  v_plan_id_anterior uuid;
  v_cancel_anterior boolean;
  v_novo_fim timestamptz;
  v_novo_status text;
  v_sandbox_concede boolean;
  v_org_sandbox uuid;
  v_installment text := nullif(p_confirmacao->>'installment', '');
  v_total_parcelamento_cents bigint;
  v_comparado_cents bigint;
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

    if not found or (v_pedido.status = 'pago' and v_pedido.parcelas <= 1) then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
    end if;

    -- 0945 (D-177): parcela SEGUINTE de um parcelamento cujo pedido já está pago. O período foi
    -- concedido uma vez, pela primeira parcela confirmada; esta só entra em billing_payments, ligada
    -- ao pedido, com período nulo (como o pacote de tokens), e não mexe em contrato nem em tokens.
    -- Idempotente pelo asaas_payment_id (índice único) e confere que a cobrança é do MESMO parcelamento.
    if v_pedido.status = 'pago' then
      if v_installment is distinct from v_pedido.asaas_installment_id then
        return jsonb_build_object(
          'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
          'alarmes', to_jsonb(array['parcela_de_outro_parcelamento'])
        );
      end if;

      begin
        insert into public.billing_payments (
          organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
          billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
        ) values (
          v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
          null, null, v_chave, 'Asaas: parcela do parcelamento', null, 'asaas', v_pedido.id
        )
        returning id into v_payment_row_id;
      exception when unique_violation then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
      end;

      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
        'order_id', v_pedido.id, 'alarmes', '[]'::jsonb
      );
    end if;

    -- (7) valor (decisão 7/M5) e prazo (decisão 4/A1). Pedido PARCELADO (0945, D-177): o valor da
    -- parcela nunca se compara com o preço do plano. Compara-se o TOTAL do parcelamento (GET
    -- /installments/{id}, que o processador manda em parcelamento_total) com o amount_cents do
    -- pedido, e confere que é o parcelamento do pedido e que tem o número de parcelas do pedido.
    v_esperado_cents := v_pedido.amount_cents;
    v_comparado_cents := v_valor_cents;
    if v_pedido.parcelas > 1 then
      v_total_parcelamento_cents := round((nullif(p_confirmacao->>'parcelamento_total', ''))::numeric * 100);
      if v_installment is null or v_total_parcelamento_cents is null then
        return jsonb_build_object(
          'resultado', 'aguardando', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
          'alarmes', '[]'::jsonb, 'erro_codigo', 'billing_parcelamento_sem_total'
        );
      end if;
      if (v_pedido.asaas_installment_id is not null and v_pedido.asaas_installment_id is distinct from v_installment)
        or coalesce((nullif(p_confirmacao->>'parcelamento_parcelas', ''))::integer, 0) <> v_pedido.parcelas
      then
        return jsonb_build_object(
          'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
          'alarmes', to_jsonb(array['parcelamento_diferente_do_pedido'])
        );
      end if;
      v_comparado_cents := v_total_parcelamento_cents;
    end if;
    if v_comparado_cents < v_esperado_cents then
      return jsonb_build_object('resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
    end if;
    if v_comparado_cents > v_esperado_cents then
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
    -- semestral ou anual (decisão 2: Pix não tem assinatura Asaas, cada renovação é um
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

    -- 0942: defesa em profundidade da recusa de troca de plano de fn_billing_criar_pedido. Se um
    -- pagamento de pedido de OUTRO plano chegar com período pago vigente (pedido criado antes de
    -- existir o período, evento atrasado, corrida), o plano não troca na hora: o contrato fica
    -- como está, nada é gravado e o admin recebe o alarme troca_de_plano_com_periodo_vigente.
    if v_contract.status = 'ativa'
      and v_contract.plan_id is distinct from v_pedido.plan_id
      and v_contract.current_period_end is not null
      and v_contract.current_period_end > now()
      and exists (
        select 1 from public.billing_payments p
         where p.organization_id = v_org
           and p.status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
           and p.billing_period_end > now()
           and not exists (
             select 1 from public.billing_payments r
              where r.estorna_pagamento_id = p.id and r.status = 'REFUNDED'
           )
      )
    then
      return jsonb_build_object(
        'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', to_jsonb(array['troca_de_plano_com_periodo_vigente'])
      );
    end if;

    if (v_pedido.metodo = 'PIX' or v_pedido.parcelas > 1) and v_pedido.ciclo in ('semiannual', 'yearly') then
      -- 0945 (D-177): o parcelamento do cartão (cobrança avulsa, sem assinatura) conta o período
      -- como o Pix: a primeira parcela confirmada concede os 6 ou 12 meses, uma vez só.
      -- Decisão 5, regra especial do Pix semestral e anual. Sem período pago a frente, o período
      -- começa no dia do pagamento e vai até o mesmo dia do ciclo seguinte MAIS UM DIA (limite
      -- exclusivo, a mesma conta do cartão: o último dia pago inclui o dia do vencimento). Com
      -- período pago a frente, o novo empilha: começa em current_period_end (que já é esse
      -- limite) e dura exatamente seis meses ou um ano, SEM o dia extra (0942: cada compra
      -- empilhada ganhava um dia de graça). Correção (revisão F5, item 13): paymentDate nulo usa
      -- o INÍCIO DO DIA em SP, nunca now() (que traria hora exata e quebraria a normalização de
      -- período sempre à meia-noite).
      v_inicio_do_dia := coalesce(
        (nullif(p_confirmacao->>'paymentDate', ''))::date,
        (now() at time zone 'America/Sao_Paulo')::date
      )::timestamp at time zone 'America/Sao_Paulo';
      v_intervalo := case v_pedido.ciclo when 'semiannual' then interval '6 months' else interval '1 year' end;
      if v_contract.current_period_end is not null and v_contract.current_period_end > v_inicio_do_dia then
        v_periodo_inicio := v_contract.current_period_end;
        v_periodo_fim := v_periodo_inicio + v_intervalo;
      else
        v_periodo_inicio := v_inicio_do_dia;
        v_periodo_fim := v_periodo_inicio + v_intervalo + interval '1 day';
      end if;
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
        v_periodo_inicio, v_periodo_fim, v_chave,
        case when v_pedido.parcelas > 1 then 'Asaas: assinatura parcelada' else 'Asaas: assinatura' end,
        null, 'asaas', v_pedido.id
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
          -- 0942: cobrança avulsa (Pix) depois de encerrar a assinatura do cartão não leva o id da
          -- assinatura encerrada para o contrato: id e marcador saem juntos. Contrato sem
          -- assinatura continua sem (o ramo de assinatura viva diferente já saiu acima).
          asaas_subscription_id = case
            when v_subscription is not null then v_subscription
            when v_contract.asaas_assinatura_encerrada_em is not null then null
            else v_contract.asaas_subscription_id
          end,
          asaas_ambiente = p_ambiente,
          asaas_assinatura_encerrada_em = case
            when v_subscription is not null or v_contract.asaas_assinatura_encerrada_em is not null then null
            else v_contract.asaas_assinatura_encerrada_em
          end,
          cancel_at_period_end = false,
          -- 0942: o início do período do contrato nunca vai para o futuro (o Pix empilhado começa
          -- em current_period_end; o início do contrato continua o do período em andamento).
          current_period_start = case
            when v_periodo_inicio <= now() then v_periodo_inicio
            else least(coalesce(v_contract.current_period_start, now()), now())
          end,
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

    -- D-086 (0916): conta reativada por pagamento depois de um corte por estorno
    -- recupera a carência de uma conta normal.
    if v_estado_anterior = 'cancelada' and v_novo_status = 'ativa' then
      perform public.fn_billing_asaas_devolver_carencia(v_org, v_contract.id);
    end if;

    -- 0945: o pedido parcelado guarda o id do parcelamento que concedeu (quando o registro da cobrança
    -- ainda não o tinha gravado).
    update public.billing_orders
       set status = 'pago', pago_em = now(),
           asaas_installment_id = case when parcelas > 1 then coalesce(asaas_installment_id, v_installment) else asaas_installment_id end
     where id = v_pedido.id;

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

  v_esperado_cents := case v_contract.cycle
    when 'yearly' then v_plano.price_yearly_cents
    when 'semiannual' then v_plano.price_semiannual_cents
    else v_plano.price_monthly_cents
  end;
  -- 0942: renovação com valor ABAIXO do preço do ciclo do contrato não estende o período
  -- (divergente, como o pedido de valor menor): o cliente pagou menos do que o ciclo custa e o
  -- admin decide. Valor acima segue concedendo com o alarme divergente_valor.
  if v_esperado_cents is not null and v_valor_cents < v_esperado_cents then
    return jsonb_build_object(
      'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', null,
      'alarmes', to_jsonb(array['renovacao_valor_abaixo_do_ciclo'])
    );
  end if;
  if v_esperado_cents is not null and v_valor_cents > v_esperado_cents then
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
    set current_period_start = greatest(v_contract.current_period_start, least(v_periodo_inicio, now())),
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

  -- D-086 (0916): mesma devolução da carência do primeiro pagamento.
  if v_estado_anterior = 'cancelada' and v_novo_status = 'ativa' then
    perform public.fn_billing_asaas_devolver_carencia(v_org, v_contract.id);
  end if;

  return jsonb_build_object(
    'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
    'order_id', null, 'alarmes', to_jsonb(v_alarmes)
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) is
  '0909, PARTE 7 (itens 4, 5, 10, 11, 13), redefinida na 0916 (D-086), na 0941 (D-176), na 0942 (auditoria do lote 15) e na 0945 (parcelamento, D-177). PARCELAMENTO (pedido com parcelas > 1, cobrança avulsa do cartão sem assinatura): cada parcela confirmada leva o externalReference do pedido e o id do parcelamento em p_confirmacao.installment. A PRIMEIRA parcela confirmada concede o período, uma vez por parcelamento, com a conta do Pix (6 ou 12 meses a partir do dia do pagamento mais um dia, ou empilhando a partir de current_period_end sem o dia extra), e fecha o pedido. A conferência de valor NÃO compara o valor da parcela com o preço: compara parcelamento_total (GET /installments/{id}, em reais) com billing_orders.amount_cents, e recusa (divergente) parcelamento de outro id ou com número de parcelas diferente do pedido; sem installment ou sem parcelamento_total devolve aguardando (billing_parcelamento_sem_total) para o processador tentar de novo. As parcelas SEGUINTES (pedido já pago) entram em billing_payments ligadas ao pedido, com período nulo e a nota Asaas: parcela do parcelamento, sem mexer em contrato nem em tokens; idempotentes pelo asaas_payment_id, e parcela de outro parcelamento é divergente (parcela_de_outro_parcelamento). Pix semestral soma 6 meses e Pix anual 1 ano; o Pix que começa no dia do pagamento leva um dia a mais (limite exclusivo, como o cartão) e o Pix EMPILHADO sobre período pago a frente começa em current_period_end e dura exatamente 6 meses ou 1 ano, sem o dia extra. O início do período do contrato nunca é gravado no futuro. Pedido de OUTRO plano com período pago vigente não troca o plan_id (divergente, alarme troca_de_plano_com_periodo_vigente, nada gravado). A renovação confere o valor contra o preço do ciclo do contrato (mensal, semestral ou anual): abaixo do preço não estende o período (divergente, alarme renovacao_valor_abaixo_do_ciclo), acima concede com divergente_valor. Cobrança avulsa depois de encerrar a assinatura do cartão limpa o id e o marcador da assinatura encerrada. Devolução da carência quando o pagamento reativa um contrato cancelado (fn_billing_asaas_devolver_carencia). Sandbox só concede com billing_settings.asaas_sandbox_concede ligada, checado antes de tudo; contrato com outra assinatura Asaas viva e diferente não concede (alarme assinatura_duplicada); status ativa só quando o novo current_period_end é posterior a now(); asaas_ambiente gravado com asaas_subscription_id no primeiro pagamento; Pix com paymentDate nulo usa o início do dia em America/Sao_Paulo.';

revoke execute on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) from public, anon, authenticated, service_role;

-- ── 2f. fn_billing_asaas_aplicar_estorno: o estorno de parcela só vale pelo pedido quando cobre todas ──
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
  v_reconstruido boolean := false;
  v_periodo_inicio_original timestamptz;
  v_periodo_fim_original timestamptz;
  v_corte text;
  v_parcelas_do_pedido integer := 1;
  v_estornadas integer;
  v_concedeu boolean;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if v_payment_id is null then
    raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
  end if;

  -- N43/decisão 9: reversão de chargeback e estorno parcial só alarmam.
  --
  -- Correção (revisão F5, PARTE 8, item 4): confere o status CONFIRMADO
  -- antes de alarmar (mesma defesa do item 1 da PARTE 7).
  if p_evento_tipo in ('PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    if p_evento_tipo = 'PAYMENT_PARTIALLY_REFUNDED' then
      if v_status_confirmado not in ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH') then
        return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'status_nao_confirma_evento');
      end if;
    else
      -- disputa ainda aberta: continua tentando, não é forjado nem
      -- resolvido.
      if v_status_confirmado in ('CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE') then
        return jsonb_build_object('resultado', 'aguardando', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'billing_status_em_andamento');
      end if;
      -- confirmado = ainda em análise OU já resolvida de volta a recebido.
      if v_status_confirmado not in ('AWAITING_CHARGEBACK_REVERSAL', 'CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH') then
        return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'status_nao_confirma_evento');
      end if;
    end if;

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
    v_periodo_inicio_original := v_original.billing_period_start;
    v_periodo_fim_original := v_original.billing_period_end;
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
      v_reconstruido := true;
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

  -- 0945 (D-177): pedido PARCELADO. Cada parcela tem a sua linha em billing_payments e o Asaas manda um
  -- PAYMENT_REFUNDED por parcela estornada (a do parcelamento inteiro ou só de algumas). O estorno só
  -- vale como estorno do PEDIDO quando cobre todas as parcelas; antes disso só alarma, sem marcar o
  -- pedido estornado e sem cortar o acesso (o admin decide, como no estorno parcial de hoje).
  -- Chargeback de parcela também só alarma. Estornadas todas, corta como o estorno total, com o
  -- período da parcela que CONCEDEU (a primeira confirmada; as outras têm período nulo).
  v_concedeu := not v_reconstruido;
  if v_pedido_id is not null then
    select parcelas into v_parcelas_do_pedido from public.billing_orders where id = v_pedido_id;
  end if;

  if coalesce(v_parcelas_do_pedido, 1) > 1 then
    if p_evento_tipo <> 'PAYMENT_REFUNDED' then
      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id,
        'alarme', 'chargeback_confirmado', 'erro_codigo', null
      );
    end if;

    select count(*) into v_estornadas
      from public.billing_payments r
      join public.billing_payments o on o.id = r.estorna_pagamento_id
      where r.status = 'REFUNDED' and o.order_id = v_pedido_id;

    if v_estornadas < v_parcelas_do_pedido then
      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id,
        'alarme', 'estorno_confirmado,estorno_parcial_do_parcelamento', 'erro_codigo', null
      );
    end if;

    select billing_period_start, billing_period_end
      into v_periodo_inicio_original, v_periodo_fim_original
      from public.billing_payments
      where order_id = v_pedido_id and estorna_pagamento_id is null and billing_period_end is not null
      order by created_at asc
      limit 1;
    v_concedeu := found;
  end if;

  -- decisão 9: o pedido passa a estornado.
  if v_pedido_id is not null then
    update public.billing_orders set status = 'estornado' where id = v_pedido_id and status <> 'estornado';
  end if;

  -- D-086 (0916): o estorno TOTAL é cancelamento. Corta o contrato e os tokens do
  -- plano (assinatura do período vigente) ou os tokens do pacote, e pede a remoção da
  -- assinatura no Asaas pelo alarme remover_assinatura_pendente. Estorno de cobrança
  -- antiga só alarma. Chargeback continua só alarmando. Uma falha inesperada do corte
  -- não desfaz o registro do estorno (vira o alarme estorno_corte_falhou, que mantém o
  -- pedido de remoção da assinatura do período vigente); o que pede nova tentativa
  -- (deadlock, trava, serialização) sobe.
  if p_evento_tipo = 'PAYMENT_REFUNDED' then
    begin
      v_corte := public.fn_billing_asaas_cortar_por_estorno_total(
        v_org, v_payment_id, v_subscription, v_pedido_id,
        v_periodo_inicio_original, v_periodo_fim_original, v_concedeu
      );
    exception
      when lock_not_available or deadlock_detected or serialization_failure then
        raise;
      when others then
        raise warning 'billing_estorno_total_corte_falhou: organizacao=%, pagamento=%, sqlerrm=%', v_org, v_payment_id, sqlerrm;
        v_corte := 'estorno_corte_falhou';
        begin
          if v_subscription is not null
            and not v_reconstruido
            and coalesce((select tipo from public.billing_orders where id = v_pedido_id), 'assinatura') = 'assinatura'
            and exists (
              select 1 from public.billing_contracts
              where organization_id = v_org and asaas_subscription_id = v_subscription
            )
            and public.fn_billing_asaas_estorno_do_periodo_vigente(
              v_org, v_payment_id, v_periodo_inicio_original, v_periodo_fim_original
            )
          then
            v_corte := v_corte || ',remover_assinatura_pendente';
          end if;
        exception when others then
          null;
        end;
    end;
  end if;

  return jsonb_build_object(
    'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_estorno_id, 'order_id', v_pedido_id,
    'alarme', case p_evento_tipo
      when 'PAYMENT_REFUNDED' then 'estorno_confirmado' || coalesce(',' || v_corte, '')
      else 'chargeback_confirmado'
    end,
    'erro_codigo', null
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_estorno(text, jsonb, text) is
  '0909, PARTE 8 (item 4), redefinida na 0916 (D-086) e na 0945 (parcelamento, D-177): PAYMENT_PARTIALLY_REFUNDED e PAYMENT_AWAITING_CHARGEBACK_REVERSAL conferem o status CONFIRMADO antes de alarmar; chargeback só alarma. PAYMENT_REFUNDED (status REFUNDED confirmado) grava a linha REFUNDED, marca o pedido estornado e chama fn_billing_asaas_cortar_por_estorno_total na mesma transação: cancela o contrato que depende da cobrança do período vigente e zera os tokens do plano (assinatura), ou retira os tokens do pacote (pacote_tokens), e devolve o alarme estorno_confirmado seguido de estorno_cortou_acesso, remover_assinatura_pendente, estorno_removeu_tokens_do_pacote ou estorno_de_periodo_antigo (cobrança antiga: só alarma). PEDIDO PARCELADO (parcelas > 1): cada parcela estornada grava a sua linha REFUNDED, mas o estorno só vale como estorno do pedido quando TODAS as parcelas foram estornadas; antes disso devolve estorno_confirmado,estorno_parcial_do_parcelamento sem marcar o pedido estornado nem cortar o acesso, e chargeback de parcela só alarma (chargeback_confirmado) sem marcar o pedido. Estornadas todas, corta como o estorno total, com o período da parcela que concedeu (a única com período). Falha inesperada do corte vira o alarme estorno_corte_falhou (com remover_assinatura_pendente quando é a assinatura do período vigente) sem desfazer o registro; deadlock, trava e serialização sobem. Reentrega e segundo PAYMENT_REFUNDED do mesmo pagamento caem em ja_aplicado e não cortam de novo.';

revoke execute on function public.fn_billing_asaas_aplicar_estorno(text, jsonb, text) from public, anon, authenticated, service_role;

commit;
