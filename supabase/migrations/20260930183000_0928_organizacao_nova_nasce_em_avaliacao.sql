-- 0928, a organização que se cadastra sozinha nasce em avaliação, não no Ilimitado (D-094, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. fn_billing_contrato_da_organizacao_nova (0904) grava toda organização
-- nova como `ativa` no plano Ilimitado, sem período e sem teto. Com o cadastro aberto
-- (`signup_mode` em `aberto` ou `com_aprovacao`), qualquer pessoa criava uma empresa e
-- ganhava funis, leads, membros, conexões e IA sem limite na chave da Hiperbold, e o
-- conferidor de vencimento (0908) nunca mexe em contrato sem período.
--
-- A correção. A organização criada pelo cadastro do próprio visitante (o servidor grava
-- `settings.billing_inicio = 'avaliacao'` no insert, em ensureTenantForUser) nasce em
-- `avaliacao`, no plano de entrada já cadastrado (`pro`, a versão ativa), com período de
-- um mês: início agora, fim no fim do dia do mesmo dia do mês seguinte em
-- America/Sao_Paulo (mesma forma de "fim de dia" de fn_billing_registrar_pagamento, 0908).
-- Nenhum preço, plano ou quantidade novos: é o plano e o ciclo mensal que já existem. Vencida
-- a avaliação, o conferidor (0908) a leva a `atrasada` e depois a `suspensa`, e a organização
-- só volta a `ativa` por pagamento. O Ilimitado passa a ser só por atribuição manual do admin.
--
-- O que NÃO muda, de propósito, para não derrubar cliente real:
--   * organização criada pelo admin da plataforma (fn_create_tenant_with_owner) e pelo
--     provisionamento externo (provisionExternalTenant) não trazem o marcador: seguem no
--     Ilimitado, como hoje;
--   * a instalação com o billing `desligado` (billing_settings.modo) segue no Ilimitado;
--   * insert direto em organizations (script de instalação, bootstrap do dono, testes) sem
--     o marcador segue no Ilimitado;
--   * se o plano de entrada não existe ou não está ativo, cai no Ilimitado com aviso, como já
--     fazia quando faltava o Ilimitado: criar organização nunca é bloqueado por esta função.
--
-- Só troca o CORPO da função, sem DDL em tabela nem recriar o gatilho: reaplicável com o
-- app no ar, sem reescrever linha nenhuma.
create or replace function public.fn_billing_contrato_da_organizacao_nova()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
  v_modo text;
  v_fim timestamptz;
begin
  if coalesce(new.settings ->> 'billing_inicio', '') = 'avaliacao' then
    select modo into v_modo from public.billing_settings where id = 1;

    if v_modo is distinct from 'desligado' then
      select id into v_plan_id
      from public.billing_plans
      where code = 'pro' and active
      limit 1;

      if v_plan_id is not null then
        v_fim := (((now() at time zone 'America/Sao_Paulo')::date + interval '1 month')::date + 1)::timestamp
                 at time zone 'America/Sao_Paulo';

        insert into public.billing_contracts
          (organization_id, plan_id, status, current_period_start, current_period_end)
        values (new.id, v_plan_id, 'avaliacao', now(), v_fim)
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
  '0904, redefinida na 0928 (D-094): organização com settings.billing_inicio = avaliacao (o cadastro do próprio visitante) nasce em avaliacao no plano pro, com período de um mês em America/Sao_Paulo; qualquer outra (admin da plataforma, provisionamento externo, instalação, billing desligado) segue ativa no Ilimitado. Plano de entrada ausente cai no Ilimitado com aviso.';

revoke execute on function public.fn_billing_contrato_da_organizacao_nova() from public, anon, authenticated;
grant execute on function public.fn_billing_contrato_da_organizacao_nova() to service_role;
