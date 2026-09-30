-- 0913, a estimativa de custo da margem casa o modelo pelo prefixo "fabricante/" (D-082, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. A linha de embedding que passa pelo gateway grava em llm_calls
-- provider = 'gateway' e model = 'openai/text-embedding-3-small' (antes gravava
-- provider = 'openai'). Quando o cost_cents dessa linha sai nulo (o catálogo
-- estava ilegível na hora da gravação), fn_billing_margem_do_ciclo tenta
-- estimar o custo pelo catálogo ai_models, e o "modelo sem prefixo" que ela
-- calcula só tira o prefixo quando ele é igual ao PROVIDER da linha
-- ("openai/..." com provider = 'openai'). Com provider = 'gateway' o prefixo
-- não bate, o modelo fica "openai/text-embedding-3-small", e o catálogo, que
-- guarda provider = 'openai' e model_id = 'text-embedding-3-small', não casa
-- por nenhuma das cinco condições: a linha cai em chamadas_sem_preco e o painel
-- de margem some com um custo que tem preço.
--
-- A correção. Quando o model tem prefixo "algo/", passa a valer também a
-- leitura do prefixo como provider do preço (a parte antes da primeira barra) e
-- do resto como model_id (a parte depois dela): (ai_models.provider = "algo",
-- ai_models.model_id = "resto"). É uma condição a MAIS na busca, colocada por
-- último na ordem de preferência: toda linha que já casava por uma das cinco
-- condições anteriores continua casando com a MESMA linha do catálogo (nenhum
-- candidato antigo perde a vez, e a fórmula de custo não muda), e as linhas sem
-- barra no model não ganham candidato novo. Só ganha preço a linha que antes
-- caía em chamadas_sem_preco por causa do prefixo.
--
-- Só troca o CORPO da função (create or replace): assinatura, STABLE, security
-- definer, search_path fixo, revoke e grant ficam como na 0906. Sem DDL em
-- tabela. Reaplicável em produção com o app no ar, instrução por instrução.

create or replace function public.fn_billing_margem_do_ciclo(p_org uuid, p_ciclo date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_receita_plano_cents bigint := 0;
  v_receita_adicionais_cents bigint := 0;
  v_receita_creditos_cents bigint := 0;
  v_custo_conhecido_cents numeric := 0;
  v_custo_estimado_cents numeric := 0;
  v_chamadas_estimadas int := 0;
  v_chamadas_sem_preco int := 0;
begin
  select coalesce(bp.price_monthly_cents, 0) into v_receita_plano_cents
    from public.billing_contracts bc
    join public.billing_plans bp on bp.id = bc.plan_id
    where bc.organization_id = p_org;

  select coalesce(sum(valor_cents), 0) into v_receita_adicionais_cents
    from public.billing_token_adicionais
    where organization_id = p_org and ativo;

  select coalesce(sum(l.valor_cents), 0) into v_receita_creditos_cents
    from public.billing_token_ledger l
    where l.organization_id = p_org
      and l.chave like 'credito:%'
      and (
        (l.ciclo is not null and l.ciclo = p_ciclo)
        or (l.ciclo is null and public.fn_billing_ciclo_de(l.created_at) = p_ciclo)
      );

  -- Custo CONHECIDO: tudo que a Hiperbold paga (origem NÃO
  -- credencial_da_organizacao, inclusive nula), com cost_cents gravado,
  -- inclusive peso ponderado 0 (llm_calls não sabe de peso; a carteira, sim,
  -- mas o painel de margem é sobre DINHEIRO gasto com o fornecedor de IA,
  -- não sobre token debitado da carteira). Usa idx_llm_calls_org_time
  -- (organization_id, created_at), já existente.
  select coalesce(sum(c.cost_cents), 0) into v_custo_conhecido_cents
    from public.llm_calls c
    where c.organization_id = p_org
      and c.origem_da_chave is distinct from 'credencial_da_organizacao'
      and public.fn_billing_ciclo_de(c.created_at) = p_ciclo
      and c.cost_cents is not null;

  -- Custo ESTIMADO: as chamadas do ciclo com cost_cents nulo, casando o
  -- modelo com o catálogo ai_models pela MESMA ordem de busca da correção do
  -- item 10 (lib/ai/runtime/cost.ts): (provider, modelo exato), (provider,
  -- sem prefixo), (openrouter, modelo com prefixo), qualquer provider com
  -- model_id igual. Ignora deprecated_at (linha que saiu do catálogo não é
  -- preço de hoje) e preço parcialmente nulo (metade do preço não é preço).
  -- 0913 (D-082): por último, quando o model tem "algo/resto", o par
  -- (provider = algo, model_id = resto), que cobre a chamada pelo gateway
  -- (provider 'gateway', model 'openai/text-embedding-3-small').
  with sem_custo as (
    select c.id, c.provider, c.model, c.input_tokens, c.output_tokens,
      case when c.model like c.provider || '/%' then substring(c.model from length(c.provider) + 2) else c.model end as modelo_sem_prefixo,
      case when position('/' in c.model) > 1 then split_part(c.model, '/', 1) else null end as provider_do_prefixo,
      case when position('/' in c.model) > 1 then substring(c.model from position('/' in c.model) + 1) else null end as modelo_depois_da_barra
    from public.llm_calls c
    where c.organization_id = p_org
      and c.origem_da_chave is distinct from 'credencial_da_organizacao'
      and public.fn_billing_ciclo_de(c.created_at) = p_ciclo
      and c.cost_cents is null
  ),
  com_preco as (
    select s.input_tokens, s.output_tokens, mc.input_price_per_million_cents, mc.output_price_per_million_cents
    from sem_custo s
    left join lateral (
      select m.input_price_per_million_cents, m.output_price_per_million_cents
      from public.ai_models m
      where m.deprecated_at is null
        and m.input_price_per_million_cents is not null
        and m.output_price_per_million_cents is not null
        and (
          (m.provider = s.provider and m.model_id = s.model)
          or (m.provider = s.provider and m.model_id = s.modelo_sem_prefixo)
          or (m.provider = 'openrouter' and m.model_id = s.model)
          or m.model_id = s.model
          or m.model_id = s.modelo_sem_prefixo
          or (m.provider = s.provider_do_prefixo and m.model_id = s.modelo_depois_da_barra)
        )
      order by (case
        when m.provider = s.provider and m.model_id = s.model then 1
        when m.provider = s.provider and m.model_id = s.modelo_sem_prefixo then 2
        when m.provider = 'openrouter' and m.model_id = s.model then 3
        when m.model_id = s.model or m.model_id = s.modelo_sem_prefixo then 4
        else 5
      end)
      limit 1
    ) mc on true
  )
  select
    coalesce(sum(ceil((coalesce(input_tokens, 0) * input_price_per_million_cents + coalesce(output_tokens, 0) * output_price_per_million_cents)::numeric / 1000000)) filter (where input_price_per_million_cents is not null), 0),
    count(*) filter (where input_price_per_million_cents is not null),
    count(*) filter (where input_price_per_million_cents is null)
    into v_custo_estimado_cents, v_chamadas_estimadas, v_chamadas_sem_preco
  from com_preco;

  return jsonb_build_object(
    'receita_plano_cents', v_receita_plano_cents,
    'receita_adicionais_cents', v_receita_adicionais_cents,
    'receita_creditos_cents', v_receita_creditos_cents,
    'receita_total_cents', v_receita_plano_cents + v_receita_adicionais_cents + v_receita_creditos_cents,
    'custo_conhecido_cents', v_custo_conhecido_cents,
    'custo_estimado_cents', v_custo_estimado_cents,
    'chamadas_estimadas', v_chamadas_estimadas,
    'chamadas_sem_preco', v_chamadas_sem_preco
  );
end;
$$;

comment on function public.fn_billing_margem_do_ciclo(uuid, date) is
  '0906, Parte 6, item 1c da revisão (23/09/2026): receita (preço mensal do contrato + valor_cents dos adicionais ativos + valor_cents dos créditos avulsos do ciclo, tudo em CENTAVOS DE REAL) e custo do ciclo (soma de cost_cents CONHECIDO de llm_calls que a Hiperbold paga, origem distinta de credencial_da_organizacao, inclusive nula, inclusive peso 0, mais ESTIMATIVA pelo catálogo ai_models para o que tem cost_cents nulo, e a contagem do que nem o catálogo sabe precificar). Devolve {"receita_plano_cents", "receita_adicionais_cents", "receita_creditos_cents", "receita_total_cents", "custo_conhecido_cents", "custo_estimado_cents" (CENTAVOS DE DÓLAR, nunca convertidos), "chamadas_estimadas", "chamadas_sem_preco"}. STABLE, security definer, execute só service_role. 0913 (D-082): a estimativa também casa o model com prefixo "fabricante/resto" pelo par (provider = fabricante, model_id = resto) do catálogo, como última preferência, para a chamada pelo gateway (provider gateway, model openai/text-embedding-3-small) não cair em chamadas_sem_preco; as linhas que já casavam seguem com a mesma linha do catálogo.';

revoke execute on function public.fn_billing_margem_do_ciclo(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_margem_do_ciclo(uuid, date) to service_role;
