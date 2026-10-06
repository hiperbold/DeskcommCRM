-- 0940, a organização que se cadastra sozinha nasce SEM plano ativo, e não em avaliação (D-094 revisto, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do Filipe em 06/10/2026: não há período gratuito. A 0928 fazia a organização do
-- cadastro do próprio visitante nascer em `avaliacao` no plano `pro`, com um mês de uso. Esta
-- migration desfaz isso: a função passa a gravar o contrato no estado `suspensa`, sem período e
-- sem ciclo, com `bloqueio_a_partir_de` 5 segundos adiante. É o estado que o modelo de billing já tem e que
-- já bloqueia o uso (modo leitura, `fn_billing_modo_leitura`, 0908): IA, automação, campanha,
-- follow-up e importação param, e funil, etapa, integração e convite não se criam. O chat segue
-- recebendo e respondendo à mão, como em toda conta em modo leitura.
--
-- Por que `suspensa` e não um estado novo. O CHECK de `billing_contracts.status` e o vocabulário
-- do TypeScript têm cinco estados; um sexto mexeria em tabela, em trinta leitores e na tela do
-- admin. `suspensa` sem período e sem ciclo é distinguível de uma suspensão por falta de
-- pagamento (essa sempre tem `current_period_end`, porque o conferidor 0908 só muda contrato com
-- período): é o "ainda não assinou nada". O app lê assim em
-- `lib/billing/assinatura/sem-plano.ts` e leva quem entra em /app para a tela de assinatura.
--
-- Como a organização sai dali. O primeiro pagamento (`fn_billing_asaas_aplicar_pagamento`,
-- caminho `pay_primeiro_pagamento`) já grava o plano do pedido, o ciclo, o período e o estado
-- `ativa` quando o novo fim é futuro; o admin da plataforma também pode atribuir plano e estado à
-- mão. Nenhuma dessas funções muda.
--
-- Qual plano o contrato carrega. `plan_id` é NOT NULL, então a linha precisa apontar para alguma
-- versão: usa a de entrada já cadastrada (`pro`, a versão ativa), e na falta dela o Ilimitado.
-- É só a chave da linha: com o contrato `suspensa` nenhum teto do plano vale, e o primeiro
-- pagamento troca o `plan_id` pelo do pedido. Nenhum preço, plano ou quantidade novos.
--
-- Carência e semeadura. `bloqueio_a_partir_de` já vem preenchido na inserção: sem isso o gatilho
-- da 0907 (after insert em billing_contracts) daria `carencia_dias` ao contrato novo no modo
-- `bloquear`, e a organização teria uma semana de IA e automação sem plano nenhum. Com a data
-- preenchida, `fn_billing_dar_carencia` não faz nada (só grava quando a coluna está nula). A data é
-- `now() + 5 segundos`, e não `now()`, de propósito: o insert da organização dispara a semeadura do
-- funil padrão (`fn_seed_default_pipeline_for_org`), e `fn_billing_trava_crm_pipelines` recusaria
-- esse funil se o modo leitura já valesse na MESMA transação, derrubando a criação da organização
-- inteira (medido no banco de teste ao escrever esta migration). `now()` é o início da transação:
-- dentro dela o bloqueio ainda não venceu e a semeadura passa; a partir da próxima requisição ele
-- vale. Nenhuma ação do usuário cabe nesses 5 segundos.
--
-- Marcador. O servidor grava `settings.billing_inicio = 'sem_plano'` no insert (ensureTenantForUser).
-- O valor antigo `avaliacao` (0928) segue valendo como sinônimo, para um escritor que ainda o use
-- nunca cair no Ilimitado por engano.
--
-- O que NÃO muda, de propósito, para não derrubar cliente real:
--   * organização criada pelo admin da plataforma (fn_create_tenant_with_owner) e pelo
--     provisionamento externo (provisionExternalTenant) não trazem o marcador: seguem no
--     Ilimitado, como hoje;
--   * a instalação com o billing `desligado` (billing_settings.modo) segue no Ilimitado;
--   * insert direto em organizations (script de instalação, bootstrap do dono, testes) sem o
--     marcador segue no Ilimitado;
--   * o bloqueio só vale com o modo `bloquear`, como todo o resto do billing: no modo `avisar` o
--     contrato nasce `suspensa` mas nada para (a instalação ainda não ligou a cobrança);
--   * contratos já gravados (inclusive os `avaliacao` que a 0928 tenha criado em ambiente de
--     desenvolvimento) não são tocados: a função só roda na criação da organização.
--
-- Só troca o CORPO da função, sem DDL em tabela nem recriar o gatilho: reaplicável com o app no
-- ar, sem reescrever linha nenhuma.
create or replace function public.fn_billing_contrato_da_organizacao_nova()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
  v_modo text;
begin
  if coalesce(new.settings ->> 'billing_inicio', '') in ('sem_plano', 'avaliacao') then
    select modo into v_modo from public.billing_settings where id = 1;

    if v_modo is distinct from 'desligado' then
      select id into v_plan_id
      from public.billing_plans
      where code = 'pro' and active
      limit 1;

      if v_plan_id is null then
        select id into v_plan_id
        from public.billing_plans
        where code = 'ilimitado' and active
        limit 1;
      end if;

      if v_plan_id is not null then
        insert into public.billing_contracts
          (organization_id, plan_id, status, bloqueio_a_partir_de)
        values (new.id, v_plan_id, 'suspensa', now() + interval '5 seconds')
        on conflict (organization_id) do nothing;

        return new;
      end if;

      raise warning 'billing_plano_de_entrada_ausente_na_criacao_da_organizacao';
    end if;
  end if;

  select id into v_plan_id
  from public.billing_plans
  where code = 'ilimitado' and active
  limit 1;

  if v_plan_id is null then
    -- Sem Ilimitado ativo: não insere, avisa, e a criação da organização
    -- segue (nada nesta fase pode bloquear a criação de organização).
    raise warning 'billing_plano_ilimitado_ausente_na_criacao_da_organizacao';
    return new;
  end if;

  insert into public.billing_contracts (organization_id, plan_id, status)
  values (new.id, v_plan_id, 'ativa')
  on conflict (organization_id) do nothing;

  return new;
end;
$$;

comment on function public.fn_billing_contrato_da_organizacao_nova() is
  '0904, redefinida na 0928 e de novo na 0940 (D-094 revisto): organização com settings.billing_inicio = sem_plano (o cadastro do próprio visitante; avaliacao é sinônimo antigo) nasce suspensa, sem período e sem ciclo, com bloqueio_a_partir_de = now() + 5 segundos (a semeadura da própria criação passa), no plano pro (ou Ilimitado se faltar) só como chave da linha: modo leitura imediato no modo bloquear, até o primeiro pagamento. Qualquer outra (admin da plataforma, provisionamento externo, instalação, billing desligado) segue ativa no Ilimitado.';

revoke execute on function public.fn_billing_contrato_da_organizacao_nova() from public, anon, authenticated;
grant execute on function public.fn_billing_contrato_da_organizacao_nova() to service_role;
