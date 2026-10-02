-- 0931, os tokens do plano seguem o contrato em dia, não só o calendário (D-106, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. fn_billing_garantir_concessoes (0906, 0916) concedia `plano:<ciclo>` de cada mês civil a
-- qualquer contrato que não estivesse `cancelada`. Cenário A: assina o Pro em 30/09 e paga um mês;
-- recebe o teto cheio em setembro e outro teto cheio em 01/10, dois ciclos por um pagamento; marcando
-- para cancelar no fim do período, levava os dois. Cenário B: contrato `atrasada` ou `suspensa` ganhava
-- o teto do mês seguinte em 1º do mês, sem pagar.
--
-- A correção, nas duas frentes que o item (D-106) aponta, sem mudar preço, plano nem quantidade:
--   * Só recebe o ciclo NOVO (plano e adicionais) o contrato em dia: `ativa` ou `avaliacao`, com o
--     período pago ainda no futuro. Atrasada, suspensa, cancelada e o que passou do fim do período
--     não ganham o mês que vira; voltam a ganhar quando um pagamento reativa o contrato. O que já foi
--     concedido num ciclo aberto continua valendo. Organização sem contrato segue como antes.
--   * A primeira concessão de plano da organização, quando o período pago começou no mesmo mês, é
--     proporcional aos dias que restam do mês (do dia do início do período até o fim do mês, em
--     America/Sao_Paulo). Todo ciclo seguinte, e o plano atribuído na mão sem período, levam o teto
--     inteiro.
--
-- Decisão de produto registrada: o ciclo da carteira segue sendo o mês civil (a chave `plano:<ciclo>`,
-- as carteiras, o extrato e as telas leem o mês), e o que se alinha ao período pago é QUANDO e
-- QUANTO se concede. Alinhar o próprio ciclo ao período do contrato mexeria em todas as leituras de
-- ciclo (extrato, livro-caixa, margem, conferidor de carteira, gate da IA) e fica fora desta
-- migration. fn_billing_ciclo_de não muda.
--
-- Só troca o CORPO de fn_billing_garantir_concessoes (create or replace, mesmo ACL), sem DDL em tabela:
-- reaplicável com o app no ar. Mesmo padrão de segurança da 0906: security definer, search_path fixo,
-- sem trava própria (quem chama já está sob billing_tokens:<org>).
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
  v_inicio timestamptz;
  v_fim timestamptz;
  v_corte int;
  v_chave text;
  v_valor bigint;
  v_dias_do_mes int;
  v_dias_restantes int;
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

  -- D-086 e D-106: só recebe o plano e os adicionais de um ciclo NOVO o contrato em dia, isto é,
  -- `ativa` ou `avaliacao` e sem o período já vencido. Cancelada (estorno total, ou fim do período
  -- depois de cancelar), atrasada, suspensa e o que passou do fim do período pago não ganham o
  -- ciclo do mês que vira: voltam a receber quando um pagamento reativa o contrato. O que já foi
  -- concedido num ciclo aberto continua valendo. Organização sem contrato segue como antes.
  select status, current_period_start, current_period_end
    into v_status, v_inicio, v_fim
    from public.billing_contracts
    where organization_id = p_org;

  if v_status is not null
     and (v_status not in ('ativa', 'avaliacao') or (v_fim is not null and v_fim <= now())) then
    return;
  end if;

  -- Ilimitado (teto nulo) não concede nada: o consumo cai direto na fonte
  -- plano sem saldo, e o extrato mostra "sem limite" (decisão 9).
  if v_teto is not null then
    -- Item 8 da revisão (23/09/2026): to_char, não ::text. O cast de date
    -- depende do DateStyle da sessão (ISO por padrão, mas não garantido);
    -- to_char('YYYY-MM-DD') é o MESMO texto que o ::text de sempre produzia
    -- (DateStyle ISO), então não duplica concessão nenhuma já gravada.
    v_chave := 'plano:' || to_char(p_ciclo, 'YYYY-MM-DD');

    -- D-106: a primeira concessão de um plano pago no meio do mês é proporcional aos dias que
    -- restam (do dia em que o período pago começou até o fim do mês). Sem isto quem assinava no
    -- dia 30 recebia o mês cheio no dia 30 e outro mês cheio no dia 1, dois ciclos por um
    -- pagamento. Só vale quando é a PRIMEIRA concessão de plano da organização e o período pago
    -- começou neste mesmo mês; plano atribuído na mão, sem período, e todo ciclo seguinte levam o
    -- teto inteiro. A consulta só roda quando a chave do ciclo ainda não existe (uma vez por
    -- organização por mês), nunca no caminho quente do débito.
    if not exists (
      select 1 from public.billing_token_ledger
      where organization_id = p_org and chave = v_chave
    ) then
      v_valor := v_teto;

      if v_inicio is not null
         and public.fn_billing_ciclo_de(v_inicio) = p_ciclo
         and not exists (
           select 1 from public.billing_token_ledger
           where organization_id = p_org and fonte = 'plano' and chave like 'plano:%'
         ) then
        v_dias_do_mes := ((p_ciclo + interval '1 month')::date - p_ciclo);
        v_dias_restantes := ((p_ciclo + interval '1 month')::date - (v_inicio at time zone 'America/Sao_Paulo')::date);
        v_valor := (v_teto * v_dias_restantes) / v_dias_do_mes;
      end if;

      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
      values (p_org, 'plano', v_valor, v_chave)
      on conflict (organization_id, chave) do nothing;

      get diagnostics v_linhas = row_count;
      if v_linhas > 0 then
        insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
        values (p_org, 'plano', p_ciclo, v_valor, 0)
        on conflict (organization_id, fonte, ciclo) do update
          set creditado = public.billing_token_wallets.creditado + excluded.creditado,
              updated_at = now();
      end if;
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
  '0906, decisão 9, redefinida na 0916 (D-086) e na 0931 (D-106): concessão preguiçosa e idempotente da fonte plano (teto efetivo do momento) e de cada adicional ativo, para o ciclo informado. Só concede ciclo novo a contrato em dia (ativa ou avaliacao, período não vencido); a primeira concessão de plano de um período pago que começou no mês é proporcional aos dias restantes do mês. NÃO trava sozinha: quem chama (fn_billing_debitar_chamada ou a RPC de saldo) já precisa estar sob pg_try_advisory_xact_lock(''billing_tokens:<org>''). insert ... on conflict do nothing no livro-caixa; billing_token_wallets.creditado só soma quando a linha do livro-caixa entra.';

revoke execute on function public.fn_billing_garantir_concessoes(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_garantir_concessoes(uuid, date) to service_role;
