-- 0942, correção da auditoria do lote 15 (venda semestral e anual, 0941) (D-176, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A auditoria do commit 4a3efaf20 achou sete defeitos na venda semestral e anual. Esta migration
-- redefine as funções (a 0941 já está no histórico e não se reescreve):
--
--   1. ALTA, troca de PLANO com período pago vigente. fn_billing_criar_pedido recusa o pedido de
--      OUTRO plano (cartão ou Pix) enquanto o contrato ativo tem período pago a frente, com
--      billing_troca_de_plano_indisponivel. Antes, o Pix de outro plano empilhava o período e o
--      pagamento trocava o plan_id na hora. Mesmo plano e mesmo ciclo continua empilhando. Defesa
--      em profundidade: fn_billing_asaas_aplicar_pagamento não troca o plano se mesmo assim chegar
--      pagamento de pedido de outro plano com período vigente (divergente + alarme
--      troca_de_plano_com_periodo_vigente, nada gravado). O início do período do contrato nunca é
--      gravado no futuro.
--   2. ALTA, estorno com pagamentos empilhados. fn_billing_asaas_cortar_por_estorno_total recalcula
--      o fim do período como o maior fim entre os pagamentos NÃO estornados: com cobertura ainda
--      no futuro, só encurta o período (estorno_encurtou_periodo) e não cancela nem zera tokens;
--      cancelar e zerar os tokens do mês só quando nenhum pagamento restante cobre o futuro.
--      fn_billing_asaas_estorno_do_periodo_vigente continua como na 0916: já separa o estorno do
--      primeiro (só alarma) do estorno do último (fim igual ao do contrato).
--   3. MÉDIA, preços semestral e anual na reaplicação do baseline. A semeadura passa a valer UMA
--      vez: billing_settings.precos_de_ciclo_semeados_em marca que já aconteceu, e só a versão 1
--      do plano é semeada. Preço zerado pelo admin não volta na próxima publicação e versão nova
--      do plano não herda preço velho. Aqui (cadeia de migrations) a 0941 acabou de semear, então
--      a coluna só nasce e é marcada. No baseline, que repete o bloco da 0941 a cada atualização, o
--      bloco da 0941 foi corrigido para conferir a marca antes de semear.
--   4. MÉDIA, renovação. Pagamento de renovação com valor abaixo do preço do ciclo do contrato
--      não estende o período (divergente + alarme renovacao_valor_abaixo_do_ciclo);
--      fn_billing_asaas_rotear_pagamento não roteia como renovação a assinatura com
--      asaas_assinatura_encerrada_em preenchido; o Pix comprado depois de encerrar o cartão não
--      leva o id da assinatura encerrada para o contrato.
--   5. BAIXA, o ALTER de billing_plans com `add column if not exists` pegava a trava exclusiva da
--      tabela a cada reaplicação do baseline mesmo sem fazer nada. O bloco da 0941 no baseline só
--      altera quando a coluna não existe (information_schema); esta migration usa a mesma guarda.
--   6. BAIXA, Pix empilhado ganhava um dia a cada compra. O Pix que começa no dia do pagamento
--      segue indo até o mesmo dia do ciclo seguinte mais um dia (limite exclusivo, igual ao
--      cartão); o empilhado começa em current_period_end e dura exatamente seis meses ou um ano.
--
-- O item 7 (cancelamento do cliente achar a assinatura agendada de quem tem Pix vigente e assina
-- no cartão) é só de aplicação (lib/billing/asaas/compra.ts): o id da assinatura já fica no
-- pedido, e o banco não muda.
--
-- Funções por create or replace com o ACL repetido (deny-all nas internas; service_role em
-- fn_billing_criar_pedido). A única DDL é a coluna da marca, só quando falta, com lock_timeout
-- curto. Reaplicável com o app no ar.

-- ── 1. A marca de que os preços semestral e anual já foram semeados ──
do $marca_precos_de_ciclo$
begin
  perform set_config('lock_timeout', '3s', true);

  -- `alter table ... add column if not exists` pega a trava exclusiva da tabela mesmo quando a
  -- coluna já existe. A pergunta ao catálogo não trava nada.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'billing_plans' and column_name = 'price_semiannual_cents'
  ) then
    alter table public.billing_plans add column price_semiannual_cents integer;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'billing_settings' and column_name = 'precos_de_ciclo_semeados_em'
  ) then
    alter table public.billing_settings add column precos_de_ciclo_semeados_em timestamptz;
  end if;

  -- A 0941, na cadeia de migrations, já semeou os preços. A marca só registra isso: nenhuma
  -- linha de plano é tocada aqui.
  update public.billing_settings
     set precos_de_ciclo_semeados_em = coalesce(precos_de_ciclo_semeados_em, now())
   where id = 1;
end
$marca_precos_de_ciclo$;

comment on column public.billing_settings.precos_de_ciclo_semeados_em is
  '0942 (D-176): quando os preços semestral e anual da decisão de 29/09/2026 foram semeados em billing_plans (versão 1 de Pro, Max e Escale). Nula = ainda não semeou. A semeadura roda uma única vez (preencher esta marca é o último passo dela): preço que o admin zerar depois não volta na reaplicação do baseline, e plano em versão nova não herda preço velho.';

-- ── 2. fn_billing_asaas_rotear_pagamento: assinatura ENCERRADA não é renovação ──
--
-- Mesmo corpo da PARTE 8 da 0909 (item 3), com UMA cláusula a mais na busca de renovação: o
-- contrato só casa pela assinatura enquanto ela não tem o marcador de encerramento. Uma
-- cobrança tardia de assinatura que o cliente já cancelou (ou que o estorno total mandou
-- remover) caía como renovação e estendia o período de quem cancelou; agora cai pelo resto do
-- roteamento e, sem pedido que a reclame, vira sem_vinculo.
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
  '0909, PARTE 8 (correção, item 3), redefinida na 0942: a busca por asaas_subscription_id e a busca por asaas_payment_id admitem pedido falhou (só pago e estornado ficam fora); a busca por external_reference continua excluindo pago, estornado E falhou. A RENOVAÇÃO só casa com contrato cuja assinatura NÃO tem o marcador de encerramento (asaas_assinatura_encerrada_em nulo): cobrança tardia de assinatura encerrada cai como sem_vinculo, nunca estende o período. STABLE, sem travar nada.';

revoke execute on function public.fn_billing_asaas_rotear_pagamento(text, text, text, text) from public, anon, authenticated, service_role;

-- ── 3. fn_billing_criar_pedido: recusa também a troca de PLANO com período pago vigente ──
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
  '0909, Tarefa 3, redefinida na 0941 (venda semestral e anual, D-176) e na 0942 (auditoria do lote 15): cria o pedido de compra (decisões 2, 6, 8, 11, 12, 17, 18, 25, 26). Ciclos monthly (só cartão), semiannual e yearly (cartão ou Pix), cada um com o preço da sua coluna do catálogo (price_monthly_cents, price_semiannual_cents, price_yearly_cents). Contrato ativo com período pago em OUTRO ciclo recusa com billing_troca_de_ciclo_indisponivel (22023); contrato ativo com período PAGO vigente (pagamento recebido, não estornado, com fim no futuro) recusa pedido de OUTRO plano com billing_troca_de_plano_indisponivel (22023), no cartão e no Pix; mesmo plano e mesmo ciclo segue podendo empilhar. Preço, plano (versão ativa), ciclo, pacote e tokens vêm SEMPRE do banco, nunca da entrada (decisão 17). Recusas 22023 com mensagem própria: billing_compra_desligada, billing_plano_fora_de_venda, billing_preco_nao_definido, billing_metodo_invalido_para_oferta, billing_ja_tem_assinatura_asaas, billing_pedido_aberto_existe (mais as validações estruturais de tipo/metodo/ambiente/ciclo/plan_code/pacote, também 22023). Lê billing_settings SEM for share (decisão 12). Idempotente pela chave: mesmos valores devolve ja_existia = true; valores diferentes, 22023 (billing_chave_com_valores_diferentes). Devolve proxima_cobranca_em (decisão 26): a data civil em America/Sao_Paulo de current_period_end quando o período do contrato ainda está no futuro, para o serviço de compra (Tarefa 14) montar o nextDueDate da assinatura nova sem cobrar de novo o período já pago.';

revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid) to service_role;

-- ── 4. fn_billing_asaas_aplicar_pagamento: Pix empilhado, troca de plano, renovação e assinatura encerrada ──
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

    if v_pedido.metodo = 'PIX' and v_pedido.ciclo in ('semiannual', 'yearly') then
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
  '0909, PARTE 7 (itens 4, 5, 10, 11, 13), redefinida na 0916 (D-086), na 0941 (D-176, venda semestral e anual) e na 0942 (auditoria do lote 15). Pix semestral soma 6 meses e Pix anual 1 ano; o Pix que começa no dia do pagamento leva um dia a mais (limite exclusivo, como o cartão) e o Pix EMPILHADO sobre período pago a frente começa em current_period_end e dura exatamente 6 meses ou 1 ano, sem o dia extra. O início do período do contrato nunca é gravado no futuro. Pedido de OUTRO plano com período pago vigente não troca o plan_id (divergente, alarme troca_de_plano_com_periodo_vigente, nada gravado). A renovação confere o valor contra o preço do ciclo do contrato (mensal, semestral ou anual): abaixo do preço não estende o período (divergente, alarme renovacao_valor_abaixo_do_ciclo), acima concede com divergente_valor. Cobrança avulsa depois de encerrar a assinatura do cartão limpa o id e o marcador da assinatura encerrada. Antes disso, na 0916: devolução da carência quando o pagamento reativa um contrato cancelado (fn_billing_asaas_devolver_carencia, só se a última carência foi a zerada pelo estorno). Sandbox só concede com billing_settings.asaas_sandbox_concede ligada, checado antes de tudo; contrato com outra assinatura Asaas viva e diferente não concede (alarme assinatura_duplicada); status ativa só quando o novo current_period_end é posterior a now(); asaas_ambiente gravado com asaas_subscription_id no primeiro pagamento; Pix com paymentDate nulo usa o início do dia em America/Sao_Paulo.';

revoke execute on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) from public, anon, authenticated, service_role;

-- ── 5. fn_billing_asaas_cortar_por_estorno_total: o estorno recalcula o período com pagamentos empilhados ──
--
-- Mesmo corpo da 0916, com o recálculo do fim do período a partir dos pagamentos que NÃO foram
-- estornados. fn_billing_asaas_estorno_do_periodo_vigente (0916) segue como está: ela já decide
-- certo quem é o pagamento do período vigente (cenário A, estorno do PRIMEIRO de dois
-- empilhados: há outro pagamento além do dele, então só alarma e o período fica inteiro;
-- cenário B, estorno do ÚLTIMO: o fim do período dele é o do contrato). O que faltava era o
-- corte inteiro do cenário B cancelar quem ainda tinha o primeiro pagamento valendo.
create or replace function public.fn_billing_asaas_cortar_por_estorno_total(
  p_org uuid,
  p_payment_id text,
  p_subscription text,
  p_pedido_id uuid,
  p_periodo_inicio timestamptz,
  p_periodo_fim timestamptz,
  p_concedeu boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tipo text;
  v_tokens_pacote bigint;
  v_ciclo date := public.fn_billing_ciclo_de(now());
  v_contract record;
  v_fim_novo timestamptz;
  v_fim_restante timestamptz;
  v_carencia_nova timestamptz;
  v_creditado_real bigint;
  v_consumido_real bigint;
  v_retirar bigint;
  v_corte integer;
  v_linhas integer;
  v_alarmes text[] := array[]::text[];
begin
  if p_pedido_id is not null then
    select tipo, tokens into v_tipo, v_tokens_pacote
      from public.billing_orders
      where id = p_pedido_id and organization_id = p_org;
  end if;

  -- B. Pacote de tokens: saem só os tokens dele que ainda restarem.
  if v_tipo = 'pacote_tokens' then
    if not p_concedeu then
      return null;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));

    if not exists (
      select 1 from public.billing_token_ledger
      where organization_id = p_org and chave = 'credito:' || p_pedido_id::text
    ) then
      return null;
    end if;

    -- Saldo avulso pelo livro-caixa: créditos e ajustes sem ciclo, menos o consumo.
    select coalesce(sum(tokens), 0) into v_creditado_real
      from public.billing_token_ledger
      where organization_id = p_org and fonte = 'avulso'
        and (chave like 'credito:%' or (chave like 'ajuste:%' and ciclo is null));

    select coalesce(sum(-tokens), 0) into v_consumido_real
      from public.billing_token_ledger
      where organization_id = p_org and fonte = 'avulso' and chave like 'consumo:%';

    v_retirar := least(coalesce(v_tokens_pacote, 0), greatest(v_creditado_real - v_consumido_real, 0));

    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, ciclo, nota)
    values (
      p_org, 'avulso', -v_retirar, 'ajuste:estorno:' || p_pedido_id::text, null,
      'Estorno total no Asaas (' || p_payment_id || '): tokens do pacote retirados'
    )
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      update public.billing_token_wallets
         set creditado = v_creditado_real - v_retirar, updated_at = now()
       where organization_id = p_org and fonte = 'avulso' and ciclo is null;
    end if;

    return 'estorno_removeu_tokens_do_pacote';
  end if;

  -- A. Assinatura (pedido do tipo assinatura ou renovação sem pedido).
  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    return null;
  end if;

  if not p_concedeu then
    if p_subscription is null then
      return null;
    end if;
    if v_contract.asaas_subscription_id is distinct from p_subscription then
      return 'remover_assinatura_pendente';
    end if;
    return 'estorno_de_periodo_antigo';
  end if;

  -- Só corta quando o contrato depende DESTA cobrança: a assinatura é a do contrato (ou,
  -- sem assinatura no Asaas, o contrato não tem assinatura viva) E o pagamento é o do
  -- período vigente. Cobrança antiga só alarma.
  if p_subscription is not null then
    if v_contract.asaas_subscription_id is distinct from p_subscription then
      return 'estorno_de_periodo_antigo';
    end if;
  elsif v_contract.asaas_subscription_id is not null and v_contract.asaas_assinatura_encerrada_em is null then
    return 'estorno_de_periodo_antigo';
  end if;

  if not public.fn_billing_asaas_estorno_do_periodo_vigente(p_org, p_payment_id, p_periodo_inicio, p_periodo_fim) then
    return 'estorno_de_periodo_antigo';
  end if;

  -- 0942: pagamentos empilhados (Pix a frente, renovação adiantada). A cobertura que sobra
  -- depois deste estorno é o maior fim de período entre os pagamentos NÃO estornados. Enquanto
  -- esse fim estiver no futuro, o cliente ainda tem período pago: o contrato só ENCURTA para
  -- ele (nunca estende), nada é cancelado e os tokens do mês ficam. Só quando nenhum
  -- pagamento restante cobre o futuro vale o corte inteiro abaixo.
  select max(p.billing_period_end) into v_fim_restante
    from public.billing_payments p
    where p.organization_id = p_org
      and p.asaas_payment_id is distinct from p_payment_id
      and p.status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
      and p.billing_period_end is not null
      and not exists (
        select 1 from public.billing_payments r
        where r.estorna_pagamento_id = p.id and r.status = 'REFUNDED'
      );

  if v_fim_restante > now() then
    v_fim_novo := least(coalesce(v_contract.current_period_end, v_fim_restante), v_fim_restante);
    if v_contract.current_period_end is not distinct from v_fim_novo then
      return 'estorno_de_periodo_antigo';
    end if;

    if p_subscription is not null then
      v_alarmes := array_append(v_alarmes, 'remover_assinatura_pendente');
    end if;

    update public.billing_contracts set current_period_end = v_fim_novo where id = v_contract.id;
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (p_org, v_contract.id, 'periodo', v_contract.current_period_end::text, v_fim_novo::text, 'estorno_asaas', null);

    return array_to_string(array_prepend('estorno_encurtou_periodo', v_alarmes), ',');
  end if;

  if p_subscription is not null then
    v_alarmes := array_append(v_alarmes, 'remover_assinatura_pendente');
  end if;

  v_fim_novo := least(coalesce(v_contract.current_period_end, now()), now());
  -- Quem estornou não tem carência: o modo leitura vale na hora (quando a plataforma
  -- está em bloquear). Só antecipa, nunca adia uma carência que já venceu. Um novo
  -- pagamento devolve a carência (fn_billing_asaas_devolver_carencia).
  v_carencia_nova := least(coalesce(v_contract.bloqueio_a_partir_de, now()), now());

  update public.billing_contracts
     set status = 'cancelada',
         current_period_end = v_fim_novo,
         cancel_at_period_end = true,
         bloqueio_a_partir_de = v_carencia_nova
   where id = v_contract.id;

  if v_contract.status <> 'cancelada' then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (p_org, v_contract.id, 'estado', v_contract.status, 'cancelada', 'estorno_asaas', null);
  end if;
  if v_contract.current_period_end is distinct from v_fim_novo then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (p_org, v_contract.id, 'periodo', v_contract.current_period_end::text, v_fim_novo::text, 'estorno_asaas', null);
  end if;
  if not coalesce(v_contract.cancel_at_period_end, false) then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (p_org, v_contract.id, 'cancelar_no_fim', 'false', 'true', 'estorno_asaas', null);
  end if;
  if v_contract.bloqueio_a_partir_de is distinct from v_carencia_nova then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (p_org, v_contract.id, 'carencia', v_contract.bloqueio_a_partir_de::text, v_carencia_nova::text, 'estorno_asaas', null);
  end if;

  -- Tokens do plano no ciclo atual: zera pelo livro-caixa. O lançamento de corte só
  -- existe quando o plano JÁ foi concedido neste ciclo (chave plano:<ciclo>): sem
  -- concessão, não há o que zerar e o pagamento seguinte concede normalmente; com ela,
  -- o lançamento numera o corte para a reconcessão de fn_billing_garantir_concessoes
  -- saber que o mesmo ciclo precisa de um crédito novo depois de um novo pagamento.
  perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));

  if exists (
    select 1 from public.billing_token_ledger
    where organization_id = p_org and chave = 'plano:' || to_char(v_ciclo, 'YYYY-MM-DD')
  ) then
    -- Saldo do plano no ciclo pelo livro-caixa, a mesma soma do conferidor de carteira.
    select coalesce(sum(tokens), 0) into v_creditado_real
      from public.billing_token_ledger
      where organization_id = p_org and fonte = 'plano'
        and (chave = 'plano:' || to_char(v_ciclo, 'YYYY-MM-DD')
             or (chave like 'ajuste:%' and ciclo is not distinct from v_ciclo));

    select coalesce(sum(-tokens), 0) into v_consumido_real
      from public.billing_token_ledger
      where organization_id = p_org and fonte = 'plano' and chave like 'consumo:%' and ciclo = v_ciclo;

    v_retirar := greatest(v_creditado_real - v_consumido_real, 0);

    v_corte := 1;
    while exists (
      select 1 from public.billing_token_ledger
      where organization_id = p_org
        and chave = 'ajuste:estorno-plano:' || to_char(v_ciclo, 'YYYY-MM-DD') || ':' || v_corte::text
    ) loop
      v_corte := v_corte + 1;
    end loop;

    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, ciclo, nota)
    values (
      p_org, 'plano', -v_retirar,
      'ajuste:estorno-plano:' || to_char(v_ciclo, 'YYYY-MM-DD') || ':' || v_corte::text, v_ciclo,
      'Estorno total no Asaas (' || p_payment_id || '): tokens do plano do ciclo zerados'
    )
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      update public.billing_token_wallets
         set creditado = v_creditado_real - v_retirar, updated_at = now()
       where organization_id = p_org and fonte = 'plano' and ciclo = v_ciclo;
    end if;
  end if;

  -- O aviso "Assinatura cancelada" da Central (dedup própria, nunca lança).
  perform public.fn_billing_avisar_assinatura(p_org);

  return array_to_string(array_prepend('estorno_cortou_acesso', v_alarmes), ',');
end;
$$;

comment on function public.fn_billing_asaas_cortar_por_estorno_total(uuid, text, text, uuid, timestamptz, timestamptz, boolean) is
  '0916 (D-086), redefinida na 0942: o corte do estorno total do Asaas, chamada só por fn_billing_asaas_aplicar_estorno, na mesma transação que grava a linha REFUNDED. Pacote de tokens: retira do saldo avulso (calculado pelo livro-caixa) o menor entre os tokens do pedido e o saldo, por lançamento negativo ajuste:estorno:<pedido>, só quando o crédito do pedido existe. Assinatura: só mexe quando o contrato depende da cobrança (mesma assinatura, ou Pix sem assinatura viva) E o pagamento é o do período vigente (fn_billing_asaas_estorno_do_periodo_vigente). Com pagamentos empilhados (0942), recalcula o fim do período como o maior fim entre os pagamentos não estornados: se ele ainda está no futuro, só ENCURTA o período (alarme estorno_encurtou_periodo, evento periodo com motivo estorno_asaas, nada cancelado, tokens intactos, remover_assinatura_pendente quando a cobrança era de assinatura); se nenhum pagamento restante cobre o futuro, pede a remoção da assinatura pelo alarme remover_assinatura_pendente, cancela o contrato na hora (status cancelada, fim do período em now(), cancel_at_period_end ligado, bloqueio_a_partir_de antecipado para now(), eventos com motivo estorno_asaas) e zera os tokens do plano do ciclo (saldo pelo livro-caixa) por lançamento negativo ajuste:estorno-plano:<ciclo>:<n>. Cobrança antiga só devolve estorno_de_periodo_antigo. p_concedeu falso (original reconstruído pelo estorno, M2) não retira nada. Interna: deny-all.';

revoke execute on function public.fn_billing_asaas_cortar_por_estorno_total(uuid, text, text, uuid, timestamptz, timestamptz, boolean) from public, anon, authenticated, service_role;
