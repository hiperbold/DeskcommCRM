-- 0941, venda do plano no ciclo SEMESTRAL e ANUAL, à vista (D-176, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do Filipe em 29/09/2026: além do mensal, o plano se vende por seis meses (10% de
-- desconto) e por um ano (20%), cobrado no valor total do período, arredondado para baixo até o
-- final 49 ou 99. Pro R$ 1.049 e R$ 1.899, Max R$ 2.149 e R$ 3.799, Escale R$ 3.199 e R$ 5.749.
-- Parcelamento fica de fora (decisão pendente do Filipe); esta migration é só a venda à vista.
--
-- O que muda:
--   1. billing_plans ganha price_semiannual_cents (nulo até alguém definir, como o anual) e os
--      três planos pagos recebem os preços do semestral e do anual NA VERSÃO ATIVA, sem tocar no
--      mensal nem no Ilimitado. Só grava onde a coluna ainda está nula: o baseline é reaplicado a
--      cada atualização e nunca pode sobrescrever um preço que o admin já tenha mudado.
--   2. O vocabulário de ciclo (billing_contracts.cycle e billing_orders.ciclo) passa a aceitar
--      'semiannual'. A constraint só é recriada quando ainda não conhece o valor novo, para a
--      reaplicação do baseline não pegar trava de tabela à toa.
--   3. fn_billing_asaas_periodo_do_ciclo soma 6 meses no semestral. É a conta do período do
--      cartão (primeiro pagamento e renovação pelo dueDate da cobrança), que continua igual ao
--      que o Asaas devolve em nextDueDate mais um dia (limite exclusivo).
--   4. fn_billing_criar_pedido aceita 'semiannual', lê o preço da coluna do ciclo (cartão ou Pix
--      no semestral e no anual, como já era no anual; mensal segue só no cartão) e recusa a TROCA
--      DE CICLO de quem já tem contrato ativo com período pago em outro ciclo
--      (billing_troca_de_ciclo_indisponivel). A troca pediria crédito proporcional e cancelar a
--      assinatura do Asaas, e isso fica para depois.
--   5. fn_billing_asaas_aplicar_pagamento soma 6 meses ao período do Pix semestral e confere o
--      valor da renovação contra o preço do ciclo do contrato.
--
-- O que NÃO muda, de propósito:
--   * fn_billing_garantir_concessoes. A carteira de tokens segue pelo mês civil (D-106): contrato
--     ativo com o período pago ainda no futuro recebe o plano de cada mês, seja o período de um,
--     de seis ou de doze meses; a regra olha o status e o fim do período, nunca o ciclo.
--   * O estorno total (D-086). Corta o contrato que depende da cobrança do período vigente e zera
--     os tokens do plano do mês, qualquer que seja o tamanho do período.
--   * O cancelamento e a conciliação diária: não leem o ciclo.
--
-- Reaplicável com o app no ar: DDL só com lock_timeout curto e só quando falta; funções por
-- create or replace (o ACL é repetido); preço só onde está nulo.

-- ── 1. Coluna do preço semestral, vocabulário de ciclo e preços decididos ──
do $ciclos_semestral_e_anual$
begin
  perform set_config('lock_timeout', '3s', true);

  alter table public.billing_plans add column if not exists price_semiannual_cents integer;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.billing_plans'::regclass
       and conname = 'billing_plans_preco_semestral_nao_negativo'
  ) then
    alter table public.billing_plans
      add constraint billing_plans_preco_semestral_nao_negativo
      check (price_semiannual_cents is null or price_semiannual_cents >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.billing_contracts'::regclass
       and conname = 'billing_contracts_cycle_check'
       and pg_get_constraintdef(oid) like '%semiannual%'
  ) then
    alter table public.billing_contracts drop constraint if exists billing_contracts_cycle_check;
    alter table public.billing_contracts
      add constraint billing_contracts_cycle_check
      check (cycle is null or cycle in ('monthly', 'semiannual', 'yearly'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.billing_orders'::regclass
       and conname = 'billing_orders_ciclo_check'
       and pg_get_constraintdef(oid) like '%semiannual%'
  ) then
    alter table public.billing_orders drop constraint if exists billing_orders_ciclo_check;
    alter table public.billing_orders
      add constraint billing_orders_ciclo_check
      check (ciclo is null or ciclo in ('monthly', 'semiannual', 'yearly'));
  end if;

  -- Preços da decisão de 29/09/2026, em centavos, na versão ATIVA de cada plano pago. Só onde a
  -- coluna está nula: nunca sobrescreve um preço que o admin tenha definido depois.
  update public.billing_plans
     set price_semiannual_cents = case code
           when 'pro' then 104900
           when 'max' then 214900
           when 'escale' then 319900
         end
   where active
     and code in ('pro', 'max', 'escale')
     and price_semiannual_cents is null;

  update public.billing_plans
     set price_yearly_cents = case code
           when 'pro' then 189900
           when 'max' then 379900
           when 'escale' then 574900
         end
   where active
     and code in ('pro', 'max', 'escale')
     and price_yearly_cents is null;
end
$ciclos_semestral_e_anual$;

comment on column public.billing_plans.price_semiannual_cents is
  '0941 (D-176): preço do plano no ciclo SEMESTRAL, o período inteiro de seis meses em centavos, cobrado de uma vez. Nulo até alguém definir (plano sem esse preço não aparece para compra semestral, como o anual). Mesma regra de price_yearly_cents: o preço mora aqui e o navegador nunca manda valor.';

-- ── 2. fn_billing_asaas_periodo_do_ciclo: o semestral soma seis meses ──

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

  if p_ciclo not in ('monthly', 'semiannual', 'yearly') then
    raise exception 'billing_ciclo_invalido' using errcode = '22023';
  end if;

  v_intervalo := case p_ciclo
    when 'monthly' then interval '1 month'
    when 'semiannual' then interval '6 months'
    else interval '1 year'
  end;
  v_fim_data := (p_due + v_intervalo)::date + 1;

  periodo_inicio := p_due::timestamp at time zone 'America/Sao_Paulo';
  periodo_fim := v_fim_data::timestamp at time zone 'America/Sao_Paulo';
  return next;
end;
$$;

comment on function public.fn_billing_asaas_periodo_do_ciclo(date, text) is
  '0909, Tarefa 5, decisão 5, redefinida na 0941: início = p_due às 00h de America/Sao_Paulo; fim = (p_due + 1 mês, 6 meses ou 1 ano, aritmética NATIVA do Postgres, sem clamp manual) + 1 dia, às 00h de SP (limite exclusivo). Interna: nenhum grant, nem a service_role (revoke explícito abaixo).';

revoke execute on function public.fn_billing_asaas_periodo_do_ciclo(date, text) from public, anon, authenticated, service_role;

-- ── 3. fn_billing_criar_pedido: semestral, preço por ciclo e recusa da troca de ciclo ──
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
  v_preco_ciclo integer;
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
  '0909, Tarefa 3, redefinida na 0941 (venda semestral e anual, D-176): cria o pedido de compra (decisões 2, 6, 8, 11, 12, 17, 18, 25, 26). Ciclos monthly (só cartão), semiannual e yearly (cartão ou Pix), cada um com o preço da sua coluna do catálogo (price_monthly_cents, price_semiannual_cents, price_yearly_cents). Contrato ativo com período pago em OUTRO ciclo recusa com billing_troca_de_ciclo_indisponivel (22023). Preço, plano (versão ativa), ciclo, pacote e tokens vêm SEMPRE do banco, nunca da entrada (decisão 17). Recusas 22023 com mensagem própria: billing_compra_desligada, billing_plano_fora_de_venda, billing_preco_nao_definido, billing_metodo_invalido_para_oferta, billing_ja_tem_assinatura_asaas, billing_pedido_aberto_existe (mais as validações estruturais de tipo/metodo/ambiente/ciclo/plan_code/pacote, também 22023). Lê billing_settings SEM for share (decisão 12). Idempotente pela chave: mesmos valores devolve ja_existia = true; valores diferentes, 22023 (billing_chave_com_valores_diferentes). Devolve proxima_cobranca_em (decisão 26): a data civil em America/Sao_Paulo de current_period_end quando o período do contrato ainda está no futuro, para o serviço de compra (Tarefa 14) montar o nextDueDate da assinatura nova sem cobrar de novo o período já pago.';

revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid) to service_role;

-- ── 4. fn_billing_asaas_aplicar_pagamento: Pix semestral e renovação conferida pelo ciclo ──
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

    if v_pedido.metodo = 'PIX' and v_pedido.ciclo in ('semiannual', 'yearly') then
      -- Decisão 5, regra especial do Pix semestral e anual: início = greatest(
      -- current_period_end, paymentDate); fim = início + 6 meses (semestral) ou
      -- 1 ano (anual) + 1 dia. Correção
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
      v_periodo_fim := v_periodo_inicio
        + case v_pedido.ciclo when 'semiannual' then interval '6 months' else interval '1 year' end
        + interval '1 day';
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

    -- D-086 (0916): conta reativada por pagamento depois de um corte por estorno
    -- recupera a carência de uma conta normal.
    if v_estado_anterior = 'cancelada' and v_novo_status = 'ativa' then
      perform public.fn_billing_asaas_devolver_carencia(v_org, v_contract.id);
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

  v_esperado_cents := case v_contract.cycle
    when 'yearly' then v_plano.price_yearly_cents
    when 'semiannual' then v_plano.price_semiannual_cents
    else v_plano.price_monthly_cents
  end;
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
  '0909, PARTE 7 (itens 4, 5, 10, 11, 13), redefinida na 0916 (D-086) e na 0941 (D-176, venda semestral e anual): Pix semestral soma 6 meses e Pix anual 1 ano ao início do período, e a renovação confere o valor contra o preço do ciclo do contrato (mensal, semestral ou anual). Antes disso, na 0916: mesmo corpo, mais a devolução da carência quando o pagamento reativa um contrato cancelado (fn_billing_asaas_devolver_carencia, só se a última carência foi a zerada pelo estorno). Sandbox só concede com billing_settings.asaas_sandbox_concede ligada, checado antes de tudo; contrato com outra assinatura Asaas viva e diferente não concede (alarme assinatura_duplicada); status ativa só quando o novo current_period_end é posterior a now(); asaas_ambiente gravado com asaas_subscription_id no primeiro pagamento; Pix anual com paymentDate nulo usa o início do dia em America/Sao_Paulo.';

revoke execute on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) from public, anon, authenticated, service_role;
