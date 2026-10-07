-- 0947, correções da auditoria do parcelamento (D-177, parte 1, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Redefine fn_billing_asaas_aplicar_pagamento (a versão da 0945) com duas mudanças, as duas só no
-- caminho do pedido PARCELADO:
--
--   M2. O período era concedido na primeira parcela CONFIRMED sem olhar as outras. Agora o processador
--       lista as parcelas do parcelamento no Asaas e declara em p_confirmacao.parcelamento_confirmadas
--       quantas estão CONFIRMED, RECEIVED ou RECEIVED_IN_CASH; o banco só concede quando são pelo menos
--       tantas quanto as parcelas do pedido. Antes disso devolve aguardando
--       (billing_parcelamento_parcelas_pendentes) e o evento tenta de novo com o backoff de sempre. A
--       conferência vem depois da conferência do total (total errado continua divergente). As parcelas
--       seguintes de um pedido já pago não exigem a contagem.
--   B4. Parcelamento removido no Asaas com parcela CONFIRMED (p_confirmacao.parcelamento_removido): o
--       processador deixava o evento ser ignorado em silêncio. Agora, com o pedido aberto, nada é
--       concedido e o evento fecha divergente com o alarme parcelamento_removido_com_pagamento; com o
--       pedido já pago, a parcela é registrada (o dinheiro entrou) com o mesmo alarme.
--
-- Nada de DDL, nada de dado: só create or replace de uma função que já existe, com o ACL repetido, numa
-- transação curta com lock_timeout.

begin;
select set_config('lock_timeout', '3s', true);

-- ── fn_billing_asaas_aplicar_pagamento: parcelas confirmadas e parcelamento removido ──
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

      -- 0947 (B4): o dinheiro da parcela entrou, mas o parcelamento já não existe no Asaas (removido
      -- por alguém). A parcela é registrada e o admin recebe o alarme.
      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
        'order_id', v_pedido.id,
        'alarmes', case
          when coalesce(p_confirmacao->>'parcelamento_removido', '') = 'true'
            then to_jsonb(array['parcelamento_removido_com_pagamento'])
          else '[]'::jsonb
        end
      );
    end if;

    -- 0947 (B4): parcela confirmada de um parcelamento que foi REMOVIDO no Asaas, com o pedido ainda
    -- aberto. Não há total para conferir e não se concede período sobre cobrança que o Asaas apagou:
    -- nada é gravado e o evento fecha divergente com o alarme parcelamento_removido_com_pagamento,
    -- para o admin decidir (o pagamento pode ter entrado).
    if v_pedido.parcelas > 1 and coalesce(p_confirmacao->>'parcelamento_removido', '') = 'true' then
      return jsonb_build_object(
        'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', to_jsonb(array['parcelamento_removido_com_pagamento'])
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
    -- 0947 (M2): o período só é concedido com TODAS as parcelas confirmadas. O processador lista as
    -- parcelas do parcelamento (GET /installments/{id}/payments) e declara quantas estão CONFIRMED,
    -- RECEIVED ou RECEIVED_IN_CASH em parcelamento_confirmadas; o banco confere que são tantas quantas
    -- as parcelas do pedido. Antes disso o evento fica aguardando (nova tentativa com backoff, e a
    -- confirmação das outras parcelas também chega por evento). A contagem ausente conta como zero.
    if v_pedido.parcelas > 1
      and coalesce((nullif(p_confirmacao->>'parcelamento_confirmadas', ''))::integer, 0) < v_pedido.parcelas
    then
      return jsonb_build_object(
        'resultado', 'aguardando', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', '[]'::jsonb, 'erro_codigo', 'billing_parcelamento_parcelas_pendentes'
      );
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
  '0909, PARTE 7 (itens 4, 5, 10, 11, 13), redefinida na 0916 (D-086), na 0941 (D-176), na 0942 (auditoria do lote 15), na 0945 (parcelamento, D-177) e na 0947 (D-177, auditoria da parte 1). PARCELAMENTO (pedido com parcelas > 1, cobrança avulsa do cartão sem assinatura): cada parcela confirmada leva o externalReference do pedido e o id do parcelamento em p_confirmacao.installment. A PRIMEIRA parcela confirmada concede o período, uma vez por parcelamento, mas SÓ quando todas as parcelas do pedido estão confirmadas (0947: parcelamento_confirmadas, declarado pelo processador depois de listar as parcelas no Asaas, tem de ser pelo menos parcelas do pedido; senão aguardando, billing_parcelamento_parcelas_pendentes), com a conta do Pix (6 ou 12 meses a partir do dia do pagamento mais um dia, ou empilhando a partir de current_period_end sem o dia extra), e fecha o pedido. A conferência de valor NÃO compara o valor da parcela com o preço: compara parcelamento_total (GET /installments/{id}, em reais) com billing_orders.amount_cents, e recusa (divergente) parcelamento de outro id ou com número de parcelas diferente do pedido; sem installment ou sem parcelamento_total devolve aguardando (billing_parcelamento_sem_total) para o processador tentar de novo. As parcelas SEGUINTES (pedido já pago) entram em billing_payments ligadas ao pedido, com período nulo e a nota Asaas: parcela do parcelamento, sem mexer em contrato nem em tokens; idempotentes pelo asaas_payment_id, e parcela de outro parcelamento é divergente (parcela_de_outro_parcelamento). Parcelamento removido no Asaas com parcela confirmada (parcelamento_removido, 0947): pedido aberto não concede e fecha divergente, pedido já pago registra a parcela, os dois com o alarme parcelamento_removido_com_pagamento. Pix semestral soma 6 meses e Pix anual 1 ano; o Pix que começa no dia do pagamento leva um dia a mais (limite exclusivo, como o cartão) e o Pix EMPILHADO sobre período pago a frente começa em current_period_end e dura exatamente 6 meses ou 1 ano, sem o dia extra. O início do período do contrato nunca é gravado no futuro. Pedido de OUTRO plano com período pago vigente não troca o plan_id (divergente, alarme troca_de_plano_com_periodo_vigente, nada gravado). A renovação confere o valor contra o preço do ciclo do contrato (mensal, semestral ou anual): abaixo do preço não estende o período (divergente, alarme renovacao_valor_abaixo_do_ciclo), acima concede com divergente_valor. Cobrança avulsa depois de encerrar a assinatura do cartão limpa o id e o marcador da assinatura encerrada. Devolução da carência quando o pagamento reativa um contrato cancelado (fn_billing_asaas_devolver_carencia). Sandbox só concede com billing_settings.asaas_sandbox_concede ligada, checado antes de tudo; contrato com outra assinatura Asaas viva e diferente não concede (alarme assinatura_duplicada); status ativa só quando o novo current_period_end é posterior a now(); asaas_ambiente gravado com asaas_subscription_id no primeiro pagamento; Pix com paymentDate nulo usa o início do dia em America/Sao_Paulo.';

revoke execute on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) from public, anon, authenticated, service_role;

commit;
