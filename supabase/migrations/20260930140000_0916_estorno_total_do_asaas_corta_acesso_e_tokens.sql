-- 0916, o estorno TOTAL no Asaas corta o acesso e os tokens (D-086, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A decisão do Filipe (30/09/2026): "em caso de estorno, é porque o cliente cancelou,
-- e se cancelou ele precisa não ter acesso e não ter os tokens mais."
--
-- O defeito medido na homologação (hiperbold/planos/homologacao-asaas-sandbox.md,
-- parte 2, passo 7): depois do PAYMENT_REFUNDED a 0909 só marcava o pedido como
-- estornado. O contrato seguia Pro e ativo, a assinatura seguia viva no Asaas (ia
-- cobrar de novo), os 3 milhões de tokens ficavam, e o cliente não conseguia
-- recomprar, porque fn_billing_criar_pedido recusa enquanto houver assinatura sem o
-- marcador de encerramento.
--
-- O que muda, só para o estorno TOTAL (PAYMENT_REFUNDED com o status REFUNDED
-- confirmado por GET, que no Asaas é o único estado de devolução do valor inteiro;
-- o parcial continua sendo PAYMENT_PARTIALLY_REFUNDED e o chargeback segue a família
-- dele, os dois só alarmam, como antes):
--
--   A. Cobrança de ASSINATURA (pedido do tipo assinatura, ou renovação sem pedido):
--      (a) o alarme remover_assinatura_pendente é devolvido junto com o estorno, e o
--          processador (lib/billing/asaas/processar-eventos.ts) faz o que já fazia
--          para esse alarme: DELETE da assinatura no Asaas (idempotente) e DEPOIS
--          fn_billing_asaas_marcar_assinatura_encerrada, que grava o marcador. O
--          marcador só entra depois que o Asaas confirmou a remoção: gravar antes
--          deixaria o cliente recomprar com a assinatura velha ainda cobrando (duas
--          cobranças). Nunca há chamada de rede dentro de transação de banco. A
--          conciliação diária refaz a remoção que falhar (lib/billing/asaas/conciliar.ts).
--      (b) o contrato, quando depende desta cobrança, vira cancelada na hora, com o
--          fim do período em now() e cancel_at_period_end ligado; cada mudança deixa
--          evento em billing_contract_eventos (motivo estorno_asaas). O acesso segue a
--          regra que já existe para conta sem plano pago: o status cancelada entra em
--          fn_billing_modo_leitura (0908). Nenhum estado novo.
--      (c) os tokens de fonte plano do ciclo atual são zerados por um lançamento
--          NEGATIVO no livro-caixa (chave ajuste:estorno-plano:<ciclo>:<n>, nota com o
--          pagamento), nunca por apagar linha. fn_billing_garantir_concessoes passa a
--          não conceder o plano enquanto o contrato estiver cancelada e, quando um novo
--          pagamento o reativa dentro do MESMO ciclo em que houve corte, concede de
--          novo por um lançamento ajuste:reconcessao-plano:<ciclo>:<n> (a chave
--          plano:<ciclo> já está gasta, e o conferidor de carteira só soma plano:<ciclo>,
--          ajuste:% e credito:%, então o lançamento tem de ser um ajuste).
--   B. Cobrança de PACOTE DE TOKENS: saem só os tokens daquele pacote que ainda
--      restarem (o menor entre os tokens do pedido e o saldo avulso, então o saldo não
--      fica negativo por causa do estorno), por um lançamento negativo
--      ajuste:estorno:<pedido> na fonte avulso. Só quando o crédito do pedido existe no
--      livro-caixa (estorno que chegou antes do pagamento não concedeu nada, e nada é
--      retirado).
--
-- Idempotência: o corte roda UMA vez, na mesma transação que grava a linha REFUNDED
-- (índice único por pagamento e status, decisão 9 da 0909). O mesmo evento reentregue,
-- ou um segundo PAYMENT_REFUNDED do mesmo pagamento, cai em ja_aplicado antes de chegar
-- aqui e não duplica lançamento nem remoção. Toda chave do livro-caixa tem on conflict
-- do nothing.
--
-- O corte é isolado num begin/exception: uma falha inesperada nele NÃO desfaz o
-- registro do estorno (vira o alarme estorno_corte_falhou para o admin, como era
-- antes), mas deadlock, lock_not_available e serialization_failure sobem, para o
-- evento ficar aguardando e tentar de novo.
--
-- Ajustes da auditoria (mesma 0916, ainda não publicada):
--   * Só corta quando o pagamento estornado é o do período VIGENTE (fn_billing_asaas_
--     estorno_do_periodo_vigente). Estorno total de cobrança antiga (a de setembro
--     estornada em outubro com a de outubro já paga) só alarma com
--     estorno_de_periodo_antigo: não cancela, não remove a assinatura, não mexe em tokens.
--   * estorno_corte_falhou mantém o remover_assinatura_pendente da assinatura do período
--     vigente; o processador loga o alarme e a tela do admin conta os dois alarmes novos.
--   * fn_billing_garantir_concessoes também não concede os adicionais a contrato cancelado.
--   * As quantidades retiradas saem do livro-caixa (soma do crédito da fonte menos o
--     consumido, a regra do conferidor de carteira), e a carteira é realinhada com o livro
--     na mesma escrita: carteira divergente nunca gera creditado negativo.
--   * A conta reativada por um novo pagamento recupera a carência de conta normal
--     (fn_billing_asaas_devolver_carencia, chamada por fn_billing_asaas_aplicar_pagamento).
--   * As funções internas novas nascem dentro de begin ... commit, com create, comment e
--     revoke juntos.
--
-- Funções: create or replace de fn_billing_asaas_aplicar_estorno, de
-- fn_billing_asaas_aplicar_pagamento (mesma assinatura, mesmo ACL: deny-all) e de
-- fn_billing_garantir_concessoes; três funções internas novas (vigência, corte e
-- devolução da carência; deny-all, agent_worker revogado). Sem tabela, constraint,
-- índice nem reescrita de linha: reaplicável com o app no ar, instrução por instrução.

-- ── 1. Funções internas novas do corte por estorno total ──
--
-- As três funções abaixo (vigência, corte, devolução da carência) são internas:
-- deny-all, agent_worker revogado. Vão dentro de UMA transação (begin ... commit),
-- com create, comment e revoke juntos, para não haver janela em que anon ou
-- authenticated executem uma delas na primeira aplicação (o ACL padrão do Supabase dá
-- execute a todos os papéis a cada função nova, e o revoke só vem depois do create).
-- Se qualquer instrução falhar, o commit desfaz o bloco inteiro em vez de deixar uma
-- função exposta.
begin;

-- ── 1a. fn_billing_asaas_estorno_do_periodo_vigente ──
--
-- O pagamento estornado é o do período VIGENTE do contrato? Verdadeiro quando o fim do
-- período dele é o current_period_end do contrato (foi ele que o estendeu), ou quando o
-- período dele cobre now() e nenhum outro pagamento não estornado vai além dele. O
-- estorno de uma cobrança ANTIGA (por exemplo a de setembro, estornada em outubro com a
-- de outubro já paga) é falso aqui: o cliente pagou o período atual com outra cobrança,
-- e cancelar por causa da antiga tiraria o que ele pagou.
create or replace function public.fn_billing_asaas_estorno_do_periodo_vigente(
  p_org uuid,
  p_payment_id text,
  p_periodo_inicio timestamptz,
  p_periodo_fim timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_fim timestamptz;
begin
  if p_periodo_fim is null then
    return false;
  end if;

  select current_period_end into v_fim
    from public.billing_contracts
    where organization_id = p_org;

  if v_fim is not distinct from p_periodo_fim then
    return true;
  end if;

  if p_periodo_inicio is null or p_periodo_inicio > now() or now() >= p_periodo_fim then
    return false;
  end if;

  return not exists (
    select 1 from public.billing_payments p
    where p.organization_id = p_org
      and p.asaas_payment_id is distinct from p_payment_id
      and p.status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
      and p.billing_period_end > p_periodo_fim
      and not exists (
        select 1 from public.billing_payments r
        where r.estorna_pagamento_id = p.id and r.status = 'REFUNDED'
      )
  );
end;
$$;

comment on function public.fn_billing_asaas_estorno_do_periodo_vigente(uuid, text, timestamptz, timestamptz) is
  '0916 (D-086): o pagamento estornado é o do período VIGENTE? Verdadeiro quando o fim do período dele é o current_period_end do contrato, ou quando o período dele cobre now() e nenhum outro pagamento não estornado da organização vai além dele. Falso para cobrança antiga (já substituída por outra paga) e para período desconhecido. STABLE, interna: deny-all.';

revoke execute on function public.fn_billing_asaas_estorno_do_periodo_vigente(uuid, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- ── 1b. fn_billing_asaas_cortar_por_estorno_total: o corte do estorno total ──
--
-- Chamada só por fn_billing_asaas_aplicar_estorno, sob as travas billing:<org> e
-- billing_assinatura:<org> que ela já segura. A trava billing_tokens:<org> vem depois
-- das duas, a mesma ordem de fn_billing_asaas_aplicar_pagamento quando credita um
-- pacote (decisão 12 da 0909).
--
-- Devolve os alarmes a somar ao estorno_confirmado, separados por vírgula, ou nulo:
--   estorno_cortou_acesso             contrato cancelado e tokens do plano zerados
--   remover_assinatura_pendente       o processador remove a assinatura no Asaas
--   estorno_removeu_tokens_do_pacote  saíram os tokens do pacote
--   estorno_de_periodo_antigo         cobrança que não é a do período vigente: só alarma,
--                                     não cancela, não remove a assinatura, não mexe em tokens
--
-- p_concedeu é falso quando o original foi reconstruído pelo próprio estorno (M2,
-- estorno que chegou antes do pagamento): nada foi concedido, então nada é retirado. A
-- assinatura ainda precisa sair do Asaas para não cobrar de novo, salvo quando é a
-- assinatura viva do contrato (renovação estornada antes de ser aplicada), caso em que
-- só alarma, como o de período antigo.
--
-- As quantidades retiradas saem do LIVRO-CAIXA (a soma do que foi creditado na fonte,
-- mesma regra do conferidor de carteira, menos o consumido), não da carteira: carteira
-- divergente nunca produz retirada maior que o saldo real, e a carteira é realinhada
-- com o livro na mesma escrita.
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
  '0916 (D-086): o corte do estorno total do Asaas, chamada só por fn_billing_asaas_aplicar_estorno, na mesma transação que grava a linha REFUNDED. Pacote de tokens: retira do saldo avulso (calculado pelo livro-caixa) o menor entre os tokens do pedido e o saldo, por lançamento negativo ajuste:estorno:<pedido>, só quando o crédito do pedido existe. Assinatura: só corta quando o contrato depende da cobrança (mesma assinatura, ou Pix anual sem assinatura viva) E o pagamento é o do período vigente (fn_billing_asaas_estorno_do_periodo_vigente); então pede a remoção da assinatura pelo alarme remover_assinatura_pendente, cancela o contrato na hora (status cancelada, fim do período em now(), cancel_at_period_end ligado, bloqueio_a_partir_de antecipado para now() para o modo leitura valer na hora, eventos com motivo estorno_asaas) e zera os tokens do plano do ciclo (saldo pelo livro-caixa) por lançamento negativo ajuste:estorno-plano:<ciclo>:<n>. Cobrança antiga só devolve estorno_de_periodo_antigo. p_concedeu falso (original reconstruído pelo estorno, M2) não retira nada. Interna: deny-all.';

revoke execute on function public.fn_billing_asaas_cortar_por_estorno_total(uuid, text, text, uuid, timestamptz, timestamptz, boolean) from public, anon, authenticated, service_role;

-- ── 1c. fn_billing_asaas_devolver_carencia: a carência volta quando um pagamento reativa ──
--
-- fn_billing_asaas_aplicar_pagamento chama esta função quando o contrato volta de
-- cancelada para ativa por um pagamento. Só age quando a última mudança de carência do
-- contrato foi a do estorno (motivo estorno_asaas): apaga a carência e, com a plataforma
-- em bloquear, dá a de uma conta nova (fn_billing_dar_carencia, now() mais
-- billing_settings.carencia_dias), o mesmo que o gatilho de contrato novo faz. Fora de
-- bloquear a coluna fica nula, e fn_billing_definir_modo dá a carência quando o bloqueio
-- for ligado. Sem isso a conta reativada ficaria com a carência no passado e qualquer
-- atraso futuro já nasceria em modo leitura sem prazo nenhum.
create or replace function public.fn_billing_asaas_devolver_carencia(p_org uuid, p_contract_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_motivo text;
  v_antes timestamptz;
  v_depois timestamptz;
  v_modo text;
  v_dias integer;
begin
  select motivo into v_motivo
    from public.billing_contract_eventos
    where contract_id = p_contract_id and tipo = 'carencia'
    order by criado_em desc
    limit 1;

  if v_motivo is distinct from 'estorno_asaas' then
    return;
  end if;

  select bloqueio_a_partir_de into v_antes
    from public.billing_contracts
    where id = p_contract_id;

  update public.billing_contracts set bloqueio_a_partir_de = null where id = p_contract_id;

  select modo, carencia_dias into v_modo, v_dias
    from public.billing_settings
    where id = 1;

  if v_modo = 'bloquear' then
    perform public.fn_billing_dar_carencia(p_contract_id, v_dias);
  end if;

  select bloqueio_a_partir_de into v_depois
    from public.billing_contracts
    where id = p_contract_id;

  insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
  values (p_org, p_contract_id, 'carencia', v_antes::text, v_depois::text, 'reativacao_por_pagamento', null);
end;
$$;

comment on function public.fn_billing_asaas_devolver_carencia(uuid, uuid) is
  '0916 (D-086): chamada por fn_billing_asaas_aplicar_pagamento quando um pagamento reativa um contrato cancelado. Se a última mudança de carência do contrato foi a do estorno (motivo estorno_asaas), apaga o bloqueio_a_partir_de e, com billing_settings.modo em bloquear, dá a carência de conta nova (fn_billing_dar_carencia, carencia_dias); fora de bloquear deixa nulo. Grava evento carencia com motivo reativacao_por_pagamento. Não mexe em contrato cuja carência não veio do estorno. Interna: deny-all.';

revoke execute on function public.fn_billing_asaas_devolver_carencia(uuid, uuid) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_asaas_estorno_do_periodo_vigente(uuid, text, timestamptz, timestamptz), public.fn_billing_asaas_cortar_por_estorno_total(uuid, text, text, uuid, timestamptz, timestamptz, boolean), public.fn_billing_asaas_devolver_carencia(uuid, uuid) from agent_worker';
  end if;
end
$$;

commit;

-- ── 2. fn_billing_asaas_aplicar_estorno REDEFINIDA: o estorno total corta ──
--
-- Mesmo corpo da PARTE 8 da 0909 (item 4), com o acréscimo de D-086 no fim: depois de
-- gravar a linha REFUNDED e marcar o pedido estornado, PAYMENT_REFUNDED chama
-- fn_billing_asaas_cortar_por_estorno_total e soma os alarmes dela ao
-- estorno_confirmado. O original reconstruído pelo próprio estorno (M2) avisa a
-- função de corte que nada foi concedido, e o período do original vai junto para a
-- função decidir se a cobrança é a do período vigente. Estorno parcial, reversão de
-- chargeback e chargeback seguem exatamente como eram.
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
        v_periodo_inicio_original, v_periodo_fim_original, not v_reconstruido
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
  '0909, PARTE 8 (item 4), redefinida na 0916 (D-086): PAYMENT_PARTIALLY_REFUNDED e PAYMENT_AWAITING_CHARGEBACK_REVERSAL conferem o status CONFIRMADO antes de alarmar; chargeback só alarma. PAYMENT_REFUNDED (status REFUNDED confirmado) grava a linha REFUNDED, marca o pedido estornado e chama fn_billing_asaas_cortar_por_estorno_total na mesma transação: cancela o contrato que depende da cobrança do período vigente e zera os tokens do plano (assinatura), ou retira os tokens do pacote (pacote_tokens), e devolve o alarme estorno_confirmado seguido de estorno_cortou_acesso, remover_assinatura_pendente, estorno_removeu_tokens_do_pacote ou estorno_de_periodo_antigo (cobrança antiga: só alarma). Falha inesperada do corte vira o alarme estorno_corte_falhou (com remover_assinatura_pendente quando é a assinatura do período vigente) sem desfazer o registro; deadlock, trava e serialização sobem. Reentrega e segundo PAYMENT_REFUNDED do mesmo pagamento caem em ja_aplicado e não cortam de novo.';

revoke execute on function public.fn_billing_asaas_aplicar_estorno(text, jsonb, text) from public, anon, authenticated, service_role;

-- ── 3. fn_billing_asaas_aplicar_pagamento REDEFINIDA: a reativação devolve a carência ──
--
-- Mesmo corpo da versão da 0909 (PARTE 7, itens 4, 5, 10, 11 e 13), com UM acréscimo em
-- cada ramo que pode reativar o contrato (primeiro pagamento e renovação): quando o
-- status passa de cancelada para ativa, chama fn_billing_asaas_devolver_carencia, que só
-- age se a última carência do contrato foi a zerada pelo estorno.
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
  '0909, PARTE 7 (itens 4, 5, 10, 11, 13), redefinida na 0916 (D-086): mesmo corpo, mais a devolução da carência quando o pagamento reativa um contrato cancelado (fn_billing_asaas_devolver_carencia, só se a última carência foi a zerada pelo estorno). Sandbox só concede com billing_settings.asaas_sandbox_concede ligada, checado antes de tudo; contrato com outra assinatura Asaas viva e diferente não concede (alarme assinatura_duplicada); status ativa só quando o novo current_period_end é posterior a now(); asaas_ambiente gravado com asaas_subscription_id no primeiro pagamento; Pix anual com paymentDate nulo usa o início do dia em America/Sao_Paulo.';

revoke execute on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) from public, anon, authenticated, service_role;

-- ── 4. fn_billing_garantir_concessoes REDEFINIDA: conta cancelada não recebe nada ──
--
-- Mesmo corpo da 0906 (decisão 9), com duas mudanças:
--
--   1. Contrato com status cancelada não concede nada, em nenhum ciclo: nem o plano nem
--      os adicionais (billing_token_adicionais). No plano, é o que impede a concessão
--      preguiçosa de devolver os tokens que o estorno total zerou
--      (fn_billing_asaas_cortar_por_estorno_total, acima) no ciclo do corte e nos
--      seguintes, até um novo pagamento reativar o contrato. A leitura do status é uma
--      consulta por organização (chave única).
--   2. Reconcessão: a chave plano:<ciclo> só entra uma vez por ciclo. Quando o contrato
--      deixa de estar cancelada dentro de um ciclo que teve corte por estorno (existe
--      ajuste:estorno-plano:<ciclo>:<n>), cada corte ganha UM crédito novo do teto
--      efetivo, ajuste:reconcessao-plano:<ciclo>:<n>. Tem de ser um ajuste: o conferidor
--      de carteira só soma plano:<ciclo>, ajuste:% (com o ciclo da própria linha) e
--      credito:%, e desfaria qualquer outra chave. Caminho quente: sem corte no ciclo, é
--      UMA consulta por chave única a mais por chamada.
--
-- Mesmo padrão de segurança da 0906: security definer, search_path fixo, sem trava
-- própria (quem chama já está sob billing_tokens:<org>). create or replace não reseta
-- o ACL; os revoke/grant abaixo repetem o da 0906.
create or replace function public.fn_billing_garantir_concessoes(p_org uuid, p_ciclo date)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_teto bigint;
  v_linhas int;
  v_adicional record;
  v_status text;
  v_corte int;
begin
  -- Nunca concede para ciclo que já fechou (decisão 9). Comparação com o
  -- ciclo ATUAL (de now()), não com o ciclo da chamada que disparou a
  -- concessão: esta função é chamada com p_ciclo = ciclo DA CHAMADA por
  -- fn_billing_debitar_chamada, e uma chamada tardia de ciclo fechado
  -- (Tarefa 8) nunca deve criar concessão nova para um mês que já acabou.
  if p_ciclo < public.fn_billing_ciclo_de(now()) then
    return;
  end if;

  v_teto := (public.fn_billing_limites_efetivos(p_org) ->> 'tokens_ia_mes')::bigint;

  -- D-086: conta cancelada (estorno total, ou fim do período depois de
  -- cancelar) não recebe o plano nem os adicionais. Volta a receber quando um
  -- pagamento reativa o contrato.
  select status into v_status
    from public.billing_contracts
    where organization_id = p_org;

  if v_status is not distinct from 'cancelada' then
    return;
  end if;

  -- Ilimitado (teto nulo) não concede nada: o consumo cai direto na fonte
  -- plano sem saldo, e o extrato mostra "sem limite" (decisão 9).
  if v_teto is not null then
    -- Item 8 da revisão (23/09/2026): to_char, não ::text. O cast de date
    -- depende do DateStyle da sessão (ISO por padrão, mas não garantido);
    -- to_char('YYYY-MM-DD') é o MESMO texto que o ::text de sempre produzia
    -- (DateStyle ISO), então não duplica concessão nenhuma já gravada.
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
    values (p_org, 'plano', v_teto, 'plano:' || to_char(p_ciclo, 'YYYY-MM-DD'))
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (p_org, 'plano', p_ciclo, v_teto, 0)
      on conflict (organization_id, fonte, ciclo) do update
        set creditado = public.billing_token_wallets.creditado + excluded.creditado,
            updated_at = now();
    end if;

    -- D-086: um crédito novo para cada corte por estorno deste ciclo.
    v_corte := 1;
    while exists (
      select 1 from public.billing_token_ledger
      where organization_id = p_org
        and chave = 'ajuste:estorno-plano:' || to_char(p_ciclo, 'YYYY-MM-DD') || ':' || v_corte::text
    ) loop
      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, ciclo, nota)
      values (
        p_org, 'plano', v_teto,
        'ajuste:reconcessao-plano:' || to_char(p_ciclo, 'YYYY-MM-DD') || ':' || v_corte::text, p_ciclo,
        'Plano concedido de novo: novo pagamento depois de estorno neste ciclo'
      )
      on conflict (organization_id, chave) do nothing;

      get diagnostics v_linhas = row_count;
      if v_linhas > 0 then
        insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
        values (p_org, 'plano', p_ciclo, v_teto, 0)
        on conflict (organization_id, fonte, ciclo) do update
          set creditado = public.billing_token_wallets.creditado + excluded.creditado,
              updated_at = now();
      end if;

      v_corte := v_corte + 1;
    end loop;
  end if;

  for v_adicional in
    select id, tokens_por_ciclo
    from public.billing_token_adicionais
    where organization_id = p_org and ativo
  loop
    -- Item 8 da revisão: to_char no ciclo (ver comentário acima); o id do
    -- adicional continua ::text (uuid, DateStyle não afeta).
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
    values (p_org, 'adicional', v_adicional.tokens_por_ciclo, 'adicional:' || v_adicional.id::text || ':' || to_char(p_ciclo, 'YYYY-MM-DD'))
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (p_org, 'adicional', p_ciclo, v_adicional.tokens_por_ciclo, 0)
      on conflict (organization_id, fonte, ciclo) do update
        set creditado = public.billing_token_wallets.creditado + excluded.creditado,
            updated_at = now();
    end if;
  end loop;
end;
$$;

comment on function public.fn_billing_garantir_concessoes(uuid, date) is
  '0906, decisão 9, redefinida na 0916 (D-086): concessão preguiçosa e idempotente da fonte plano (teto efetivo do momento) e de cada adicional ativo, para o ciclo informado. NÃO trava sozinha: quem chama (fn_billing_debitar_chamada ou a RPC de saldo) já precisa estar sob pg_try_advisory_xact_lock(''billing_tokens:<org>''). insert ... on conflict do nothing no livro-caixa; billing_token_wallets.creditado só soma quando o insert entrou de fato. Ilimitado (tokens_ia_mes nulo) não concede plano. Nunca concede para ciclo anterior ao ciclo atual. 0916: contrato cancelada não recebe nada, nem o plano nem os adicionais (o estorno total zera os tokens do plano e eles não voltam enquanto não houver novo pagamento); contrato que volta a ativa dentro de um ciclo com corte por estorno ganha um crédito novo do teto por corte (ajuste:reconcessao-plano:<ciclo>:<n>).';

revoke execute on function public.fn_billing_garantir_concessoes(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_garantir_concessoes(uuid, date) to service_role;
