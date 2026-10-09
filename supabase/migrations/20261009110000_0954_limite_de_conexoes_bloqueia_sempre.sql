-- 0954, o limite de Conexões do plano bloqueia sempre (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do dono (09/10/2026, D-188): o item `conexoes` dos planos (Pro 3, Max 10, Scale 20, em
-- billing_plans.limits, semeado na 0904) vale para TODOS os canais somados (WhatsApp pela UAZAPI,
-- WhatsApp oficial, Instagram, Messenger, tudo que vive em channel_sessions e não está arquivado) e
-- BLOQUEIA de verdade, qualquer que seja billing_settings.modo. Os outros itens (funis, etapas, leads,
-- membros, integrações, tokens) seguem o modo como antes.
--
-- O que já estava certo e não muda: a contagem (fn_billing_uso e fn_billing_pode_criar contam
-- `channel_sessions where archived_at is null`, sem olhar o provider, então todos os canais entram) e o
-- gatilho trg_billing_trava_channel_sessions (0905/0907), que só olha INSERT de linha ativa e a volta de
-- archived_at para nulo (desarquivar). Conexão que já existe não é tocada: o gatilho não roda em UPDATE
-- de outras colunas, então uma organização que já está acima do limite continua com o que tem e só não
-- cria nem reativa mais.
--
-- O que muda: fn_billing_bloqueia (0907) só dizia "bloqueia" quando billing_settings.modo = 'bloquear' E
-- o contrato tinha bloqueio_a_partir_de vencido. Para p_item = 'conexoes' passa a não ler nem o modo nem a
-- carência: segue direto ao teto efetivo. Organização sem limite (plano Ilimitado, beta, ajuste com
-- `conexoes` nulo) continua sem bloqueio, porque o teto efetivo nulo sai antes de qualquer contagem. Todos
-- os outros itens ficam byte a byte como na 0907. O PT402 com detail 'conexoes' é o que o gatilho já
-- levanta e o código já trata.
--
-- Forma escolhida: um desvio em fn_billing_bloqueia (uma função, um lugar) em vez de uma checagem própria
-- no gatilho de channel_sessions, para o gatilho, a pré-checagem e qualquer chamador futuro lerem a mesma
-- regra. billing_settings.modo = 'desligado' também deixa de desligar este item: é decisão do dono, e a
-- instalação sem plano com limite (self-host sem assinatura) segue livre pelo teto nulo.
--
-- Reaplicável com o app no ar: create or replace na função (mesma assinatura), revoke e grant repetidos,
-- lock_timeout curto, transação única.
begin;

set lock_timeout = '3s';

create or replace function public.fn_billing_bloqueia(p_org uuid, p_item text, p_pipeline uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_bloqueio_a_partir_de timestamptz;
  v_teto integer;
  v_resultado jsonb;
begin
  -- 0954: o item `conexoes` bloqueia sempre. Não lê modo nem carência.
  if p_item is distinct from 'conexoes' then
    -- Lê o modo ANTES de qualquer outra coisa (decisão 3, "zero custo a
    -- mais"): no modo avisar/desligado, sai sem tocar billing_contracts, sem
    -- ler o teto efetivo e sem pegar lock nenhum.
    select modo into v_modo from public.billing_settings where id = 1;

    if v_modo is distinct from 'bloquear' then
      return false;
    end if;

    select bc.bloqueio_a_partir_de into v_bloqueio_a_partir_de
    from public.billing_contracts bc
    where bc.organization_id = p_org;

    -- Nulo = não bloqueia (decisão 2); data no futuro = ainda em carência.
    if v_bloqueio_a_partir_de is null or v_bloqueio_a_partir_de > now() then
      return false;
    end if;
  end if;

  v_teto := (public.fn_billing_limites_efetivos(p_org) ->> p_item)::integer;

  -- Organização Ilimitado (ou item sem teto efetivo) nunca bloqueia.
  if v_teto is null then
    return false;
  end if;

  -- MESMA trava bloqueante de fn_billing_conferir_teto (0905), NUNCA a
  -- variante _try_: com _try_, duas criações simultâneas no teto menos um
  -- passariam as duas (cada uma veria "pode" antes de a outra commitar).
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text || ':' || p_item, 0));

  begin
    v_resultado := public.fn_billing_pode_criar(p_org, p_item, p_pipeline);
    return not (v_resultado ->> 'pode')::boolean;
  exception
    when others then
      -- Falha interna LIBERA (nunca bloqueia por acidente): mesma doutrina
      -- de fn_billing_conferir_teto e fn_billing_trava_crm_leads (0905).
      raise warning 'billing_bloqueia_falhou: organizacao=%, item=%, sqlerrm=%', p_org, p_item, sqlerrm;
      return false;
  end;
end;
$$;

comment on function public.fn_billing_bloqueia(uuid, text, uuid) is
  '0907, decisão 3, e 0954: o veredito de bloqueio de verdade. Para o item conexoes (0954, D-188) é true sempre que o teto efetivo existe e fn_billing_pode_criar diz que não pode, SEM ler billing_settings.modo nem a carência (bloqueio_a_partir_de). Para os demais itens continua true só quando modo=bloquear E bloqueio_a_partir_de preenchido e VENCIDO E teto efetivo não nulo E fn_billing_pode_criar diz que não pode (lê modo, carência e teto ANTES de travar: sai sem lock nenhum em avisar/desligado, sem carência, sem carência vencida ou sem teto). Só então pega pg_advisory_xact_lock BLOQUEANTE pela mesma chave de fn_billing_conferir_teto (billing:<org>:<item>), e a contagem roda dentro de begin/exception que devolve false (raise warning) em qualquer falha interna. Quem chama levanta o PT402 (este código nunca lança).';

revoke execute on function public.fn_billing_bloqueia(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_bloqueia(uuid, text, uuid) to service_role;

do $agent_worker_0954$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_bloqueia(uuid, text, uuid) from agent_worker';
  end if;
end
$agent_worker_0954$;

commit;

reset lock_timeout;
