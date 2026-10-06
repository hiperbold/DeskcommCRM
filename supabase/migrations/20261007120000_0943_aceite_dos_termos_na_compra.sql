-- 0943, aceite dos Termos de Uso na compra do plano (D-133, parte adiada, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Até aqui a compra do plano e do pacote de tokens não pedia aceite dos Termos de Uso, e o aceite do
-- onboarding gravava só a data, sem dizer QUAL texto foi aceito. Esta migration dá o lugar do
-- aceite no pedido:
--
--   1. billing_orders ganha termos_versao (a versão dos Termos que a pessoa aceitou, a constante
--      lib/legal/versao-dos-termos.ts) e termos_aceitos_em (o momento). Colunas nulas: pedido
--      antigo e pedido de chamada interna não têm aceite, e nada é inventado para eles.
--   2. fn_billing_criar_pedido ganha o parâmetro p_termos_versao, por ÚLTIMO e com default nulo.
--      Quem chama sem ele (script de homologação, ferramenta do operador, os testes de banco) segue
--      igual. A compra do CLIENTE, que sempre leva o usuário em p_actor, só nasce se a versão vier:
--      sem ela, billing_termos_nao_aceitos (22023), a mesma recusa que o servidor de aplicação já
--      faz antes de chegar aqui (defesa em profundidade). Versão em branco ou com mais de 40
--      caracteres: billing_termos_invalidos (22023). Pedido repetido pela mesma chave devolve o
--      pedido original e o aceite original, não grava outro.
--
-- Por que a assinatura antiga é DERRUBADA: com a nova (dez parâmetros, o último com default) ao
-- lado da antiga (nove), toda chamada de nove argumentos casaria com as duas e o Postgres recusaria
-- por ambiguidade. O drop vem ANTES do create, aqui e no baseline, e o ACL é repetido logo abaixo
-- (a função nova nasce exposta e é revogada, só service_role executa).
--
-- A única DDL de tabela é a coluna, só quando falta (information_schema, sem a trava exclusiva do
-- add column if not exists a cada reaplicação), com lock_timeout curto. Reaplicável com o app no ar.

-- ── 1. As colunas do aceite em billing_orders ──
do $aceite_dos_termos$
begin
  perform set_config('lock_timeout', '3s', true);

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'billing_orders' and column_name = 'termos_versao'
  ) then
    alter table public.billing_orders add column termos_versao text;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'billing_orders' and column_name = 'termos_aceitos_em'
  ) then
    alter table public.billing_orders add column termos_aceitos_em timestamptz;
  end if;
end
$aceite_dos_termos$;

comment on column public.billing_orders.termos_versao is
  '0943 (D-133): a versão dos Termos de Uso (lib/legal/versao-dos-termos.ts, uma data AAAA-MM-DD) que o cliente aceitou ao comprar. Nula em pedido anterior à 0943 e em pedido de chamada interna, sem ator.';

comment on column public.billing_orders.termos_aceitos_em is
  '0943 (D-133): o momento do aceite dos Termos de Uso, junto de termos_versao. Nulo quando termos_versao é nula.';

-- ── 2. fn_billing_criar_pedido com o aceite dos Termos ──
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
  p_termos_versao text default null
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
    metodo, amount_cents, chave, criado_por, termos_versao, termos_aceitos_em
  ) values (
    p_org, p_ambiente, p_tipo, v_plan_id, v_ciclo, v_pacote_id, v_tokens,
    p_metodo, v_amount_cents, p_chave, p_actor, btrim(p_termos_versao),
    case when p_termos_versao is null then null else now() end
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

comment on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text) is
  '0909, Tarefa 3, redefinida na 0941 (venda semestral e anual, D-176), na 0942 (auditoria do lote 15) e na 0943 (aceite dos Termos, D-133): cria o pedido de compra (decisões 2, 6, 8, 11, 12, 17, 18, 25, 26). Ciclos monthly (só cartão), semiannual e yearly (cartão ou Pix), cada um com o preço da sua coluna do catálogo. Contrato ativo com período pago em OUTRO ciclo recusa com billing_troca_de_ciclo_indisponivel (22023); com período PAGO vigente de OUTRO plano, billing_troca_de_plano_indisponivel (22023). Aceite dos Termos (0943): p_termos_versao, o último parâmetro e com default nulo, é gravado com o momento em billing_orders.termos_versao e termos_aceitos_em; a compra com ator (p_actor, o cliente) sem versão recusa com billing_termos_nao_aceitos (22023), versão em branco ou acima de 40 caracteres com billing_termos_invalidos (22023); chamada sem ator e sem versão (interna) segue sem aceite. Preço, plano (versão ativa), ciclo, pacote e tokens vêm SEMPRE do banco, nunca da entrada (decisão 17). Recusas 22023 com mensagem própria: billing_compra_desligada, billing_plano_fora_de_venda, billing_preco_nao_definido, billing_metodo_invalido_para_oferta, billing_ja_tem_assinatura_asaas, billing_pedido_aberto_existe (mais as validações estruturais de tipo/metodo/ambiente/ciclo/plan_code/pacote). Lê billing_settings SEM for share (decisão 12). Idempotente pela chave: mesmos valores devolve ja_existia = true e o pedido (e o aceite) originais; valores diferentes, 22023 (billing_chave_com_valores_diferentes). Devolve proxima_cobranca_em (decisão 26).';

revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text) to service_role;

-- A 0909 revoga de agent_worker (se a role existir) a assinatura antiga; a nova entra aqui.
do $agent_worker_criar_pedido$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text) from agent_worker';
  end if;
end
$agent_worker_criar_pedido$;
