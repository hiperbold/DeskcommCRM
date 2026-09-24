-- 0908, pagamentos, estados e conferidor de vencimento da assinatura (fase
-- F4, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F4-tarefas.md, decisões 1 a 4 e Tarefa 1.
--
-- Esta migration (0908) é dividida em partes, cada uma uma tarefa da fase.
-- Esta aplicação traz só a PARTE 1 (Tarefa 1): billing_payments (decisão 1),
-- as três funções de pagamento (fn_billing_registrar_pagamento,
-- fn_billing_estornar_pagamento, fn_billing_corrigir_periodo, decisão 2), as
-- duas funções de estado manual (fn_billing_mudar_estado,
-- fn_billing_cancelar_no_fim_do_periodo, decisão 3) e o conferidor diário
-- (fn_billing_conferir_vencimento, decisão 4). Modo leitura (Tarefa 2) e
-- catálogo de pacotes/D-046 (Tarefa 3) ficam para partes seguintes deste
-- mesmo arquivo.
--
-- billing_settings.modo continua 'avisar' em qualquer banco ao fim desta
-- migration: nada aqui liga bloqueio nenhum, é só o registro de pagamentos e
-- a máquina de estados da assinatura, hoje só lida à mão pelo admin (N24).
--
-- Decisão 1 (billing_payments, molde do manual comum
-- F:\github-projects\hiper-track\docs\manual-api-asaas-saas.md, linha ~229):
-- SÓ DE ACRÉSCIMO, igual ao livro-caixa da carteira de tokens (0906):
-- ninguém tem update, delete nem truncate, nem o service_role, e não há
-- gatilho BEFORE UPDATE/DELETE (a exclusão em cascata da organização
-- funciona porque a ação referencial roda como dono da tabela). Estorno é
-- uma linha NOVA (status REFUNDED), nunca uma edição da linha original.
-- Duplicidade de período é conferida DENTRO das funções (fn_billing_
-- registrar_pagamento), não por índice: a F5 precisa aceitar estorno seguido
-- de novo pagamento do mesmo período, e um índice de unicidade por período
-- proibiria isso. asaas_payment_id nulo aqui (pagamento na mão, sem
-- gateway), único só quando preenchido (índice parcial, para não colidir
-- com os vários nulos). (organization_id, chave) único: chave é o uuid que o
-- FORMULÁRIO gera, a mesma peça de idempotência do livro-caixa de tokens
-- (0906), só que aqui é uuid (o manual do Asaas fala em chave do formulário,
-- não em texto livre). Sem grant para authenticated (as telas leem pelo
-- servidor, com service_role).
--
-- Decisão 2 (registrar, estornar, corrigir período):
-- fn_billing_registrar_pagamento(p_org, p_fim date, p_valor_cents, p_chave,
-- p_nota, p_actor): p_fim vale até o FIM DO DIA em America/Sao_Paulo (o
-- instante em que o dia SEGUINTE começa, nesse fuso, é o limite EXCLUSIVO do
-- período: mesma forma de "fim de dia" que fn_billing_ciclo_de, 0906, usa
-- para início de mês, só que aqui é o limite de CIMA). Início = greatest
-- (current_period_end, now()) -- o Postgres ignora NULL em GREATEST/LEAST
-- (só é NULL se TODOS os argumentos forem NULL), então isso já cobre "sem
-- período" sem precisar de coalesce à parte. O fim informado tem que ser
-- POSTERIOR a essa mesma referência, senão 22023. A mesma chave com os
-- MESMOS valores (gross_cents e o fim calculado) devolve "já registrado"
-- (idempotente, checado ANTES da validação de "fim posterior": um reenvio
-- da primeira chamada já avançou o período, e comparar o mesmo fim contra o
-- período JÁ avançado recusaria um reenvio legítimo); com valores
-- diferentes, 22023. fn_billing_estornar_pagamento(p_org, p_pagamento,
-- p_chave, p_nota, p_actor) grava uma linha REFUNDED com o MESMO
-- gross_cents/período do pagamento original (positivo, decisão 1) e NÃO
-- mexe no período do contrato (quem corrige é a função seguinte, à parte).
-- Pagamento de outra organização é 42501; pagamento que já não está
-- RECEIVED_IN_CASH (já estornado) é 22023. fn_billing_corrigir_periodo
-- (p_org, p_fim date, p_motivo, p_actor) exige p_motivo (erro de digitação,
-- com auditoria feita pelo CHAMADOR: mesmo padrão de p_actor em
-- fn_billing_trocar_plano/fn_billing_definir_modo, 0904/0907, recebido mas
-- não gravado por esta função -- a auditoria de quem/por quê mora em
-- app/actions/admin, Tarefa 5).
--
-- Decisão 3 (estados manuais):
-- fn_billing_mudar_estado(p_org, p_estado, p_motivo, p_actor): qualquer
-- estado vira 'cancelada' sem condição; 'ativa' vira 'atrasada' ou
-- 'suspensa'; 'atrasada'/'suspensa'/'cancelada' voltam para 'ativa' só com
-- período VIGENTE (current_period_end preenchido e no futuro -- senão
-- 22023, "registre um pagamento antes"); 'avaliacao' exige current_period_end
-- já preenchido (reusa o período existente, não cria um novo). Toda
-- transição fora dessa lista é 22023. fn_billing_cancelar_no_fim_do_periodo
-- (p_org, p_sim, p_actor) só liga/desliga cancel_at_period_end.
--
-- Decisão 4 (conferidor diário):
-- fn_billing_conferir_vencimento(p_org) returns text, uma organização por
-- chamada (o loop que varre todas fica na rota da Tarefa 5). Ordem FIXA: (a)
-- cancel_at_period_end e período vencido -> cancelada (vence ANTES do
-- atraso: uma organização que pediu para não renovar não pode passar por
-- "atrasada" no caminho); (b) 'ativa' ou 'avaliacao' com período vencido ->
-- 'atrasada'; (c) 'atrasada' com current_period_end + grace_days no passado
-- -> 'suspensa'. Cada passo é um UPDATE ATÔMICO cujo WHERE lê o status e o
-- período DIRETO da tabela (nunca de uma variável lida antes): é isso que
-- faz o UPDATE nunca sobrescrever um pagamento que entrou no meio -- se
-- fn_billing_registrar_pagamento já segura a linha (select ... for update,
-- dentro do advisory lock 'billing_assinatura:<org>'), o UPDATE do
-- conferidor fica bloqueado até aquela transação terminar e, ao continuar,
-- reavalia o WHERE contra o valor JÁ COMMITADO (EvalPlanQual do Postgres em
-- READ COMMITTED) -- por isso o conferidor NÃO precisa do mesmo advisory
-- lock das funções de escrita (só elas precisam, decisão 4, "updates
-- atômicos... no conferidor" é a alternativa à trava). Organização sem
-- contrato ou sem current_period_end nunca muda (devolve null). Erro numa
-- organização não para a rodada: corpo inteiro em begin/exception, devolve
-- null e grava raise warning, nunca propaga.
--
-- Mesmo padrão de segurança das migrations anteriores da faixa (0904 a
-- 0907): security definer, search_path fixo em public, pg_temp, revoke de
-- public/anon/authenticated, grant só para service_role, bloco final
-- revogando de agent_worker (se a role existir) o acesso às peças novas.
--
-- Idempotente: create table if not exists, create index if not exists,
-- create or replace, create unique index if not exists, bloco de
-- agent_worker condicional à existência da role.

-- ============================================================================
-- 1. billing_payments: o livro-caixa dos pagamentos, SÓ DE ACRÉSCIMO
-- (decisão 1).
-- ============================================================================
create table if not exists public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.billing_contracts(id) on delete cascade,
  -- Nulo aqui: pagamento registrado NA MÃO, sem gateway (N24). A F5 (Asaas
  -- de verdade) passa a preencher esta coluna pelos webhooks.
  asaas_payment_id text,
  gross_cents integer not null,
  -- Vocabulário do Asaas (decisão 1): só os dois valores que esta migration
  -- produz. Um webhook de gateway real (fase futura) amplia este CHECK.
  status text not null,
  paid_at timestamptz not null,
  billing_period_start timestamptz not null,
  billing_period_end timestamptz not null,
  -- uuid do FORMULÁRIO (decisão 1), a peça de idempotência: mesmo papel da
  -- "chave" do livro-caixa de tokens (0906), só que ali é texto e aqui é
  -- uuid, porque é isso que a tela do admin gera por submissão.
  chave uuid not null,
  nota text,
  -- Sem chave estrangeira, de propósito (mesmo racional do livro-caixa de
  -- tokens, 0906, decisão 7): não há ação de borda sensata numa tabela sem
  -- UPDATE, e apagar o usuário não pode travar apagar o registro do
  -- pagamento.
  criado_por uuid,
  created_at timestamptz not null default now(),
  constraint billing_payments_status_check check (status in ('RECEIVED_IN_CASH', 'REFUNDED')),
  constraint billing_payments_gross_cents_positivo check (gross_cents > 0),
  constraint billing_payments_org_chave_unique unique (organization_id, chave)
);

comment on table public.billing_payments is
  '0908, decisão 1: pagamentos registrados NA MÃO (N24), no molde do manual comum (hiper-track/docs/manual-api-asaas-saas.md). SÓ DE ACRÉSCIMO: ninguém tem update, delete nem truncate, nem o service_role (ver grants), e não há gatilho BEFORE UPDATE/DELETE. Estorno é uma linha NOVA (status=REFUNDED), nunca uma edição da linha original. Duplicidade de período é conferida DENTRO de fn_billing_registrar_pagamento, não por índice (a F5 precisa aceitar estorno seguido de novo pagamento do mesmo período).';
comment on column public.billing_payments.chave is
  '0908, decisão 1: uuid do FORMULÁRIO, único por organização (constraint billing_payments_org_chave_unique). Peça de idempotência de fn_billing_registrar_pagamento/fn_billing_estornar_pagamento: reenviar a mesma chamada com a mesma chave nunca duplica linha nem período.';
comment on column public.billing_payments.asaas_payment_id is
  '0908, decisão 1: nulo em todo pagamento registrado na mão (esta fase). Único quando preenchido (índice parcial billing_payments_asaas_payment_id_unique), para a fase futura do gateway real não colidir entre si sem impedir vários nulos.';

create unique index if not exists billing_payments_asaas_payment_id_unique
  on public.billing_payments (asaas_payment_id)
  where asaas_payment_id is not null;

create index if not exists billing_payments_org_idx
  on public.billing_payments (organization_id, created_at desc);
create index if not exists billing_payments_contract_id_idx
  on public.billing_payments (contract_id);

alter table public.billing_payments enable row level security;

revoke all on public.billing_payments from anon, authenticated;

-- Só select e insert, para QUALQUER escritor, inclusive service_role
-- (decisão 1: SÓ DE ACRÉSCIMO, mesmo padrão do livro-caixa de tokens, 0906).
-- Sem update/delete/truncate: a exclusão em cascata da organização continua
-- funcionando porque a ação referencial roda como DONO da tabela, não com o
-- privilégio do papel que disparou o DELETE. Nenhuma policy para
-- authenticated: as telas leem pelo servidor, com service_role.
grant select, insert on public.billing_payments to service_role;
revoke update, delete, truncate on public.billing_payments from service_role;

-- ============================================================================
-- 2. fn_billing_registrar_pagamento: registra um pagamento e renova o
-- período (decisão 2).
-- ============================================================================
create or replace function public.fn_billing_registrar_pagamento(
  p_org uuid,
  p_fim date,
  p_valor_cents integer,
  p_chave uuid,
  p_nota text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_existente record;
  v_referencia timestamptz;
  v_periodo_fim timestamptz;
  v_payment_id uuid;
begin
  if p_valor_cents is null or p_valor_cents <= 0 then
    raise exception 'billing_valor_invalido' using errcode = '22023';
  end if;

  if p_chave is null then
    raise exception 'billing_chave_obrigatoria' using errcode = '22023';
  end if;

  if p_fim is null then
    raise exception 'billing_fim_obrigatorio' using errcode = '22023';
  end if;

  -- Advisory lock por organização (chave própria "billing_assinatura:<org>",
  -- decisão 4): serializa duas chamadas concorrentes desta família de
  -- funções para a MESMA organização, e faz o conferidor esperar esta
  -- transação terminar quando ele tenta mexer na mesma linha (ver o "select
  -- ... for update" logo abaixo, que é quem de fato prende a linha).
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  -- Decisão 2: o fim vale até o FIM DO DIA informado, no fuso
  -- America/Sao_Paulo -- o instante em que o dia SEGUINTE começa nesse fuso
  -- é o limite EXCLUSIVO de cima do período.
  v_periodo_fim := (p_fim + 1)::timestamp at time zone 'America/Sao_Paulo';

  -- Decisão 2: início = maior entre o fim do período atual e agora.
  -- GREATEST ignora NULL (só é NULL se os dois argumentos forem NULL), então
  -- isto já cobre "organização sem período" (vira now()) sem coalesce.
  v_referencia := greatest(v_contract.current_period_end, now());

  -- Idempotência pela chave, ANTES da validação de "fim posterior" (decisão
  -- 2): um REENVIO da mesma chamada já avançou o período na primeira vez, e
  -- comparar o mesmo fim contra o período JÁ avançado recusaria um reenvio
  -- legítimo -- checar a chave primeiro resolve isso.
  select * into v_existente
    from public.billing_payments
    where organization_id = p_org and chave = p_chave;

  if found then
    if v_existente.gross_cents = p_valor_cents and v_existente.billing_period_end = v_periodo_fim then
      return jsonb_build_object(
        'ja_registrado', true,
        'payment_id', v_existente.id,
        'current_period_start', v_contract.current_period_start,
        'current_period_end', v_contract.current_period_end,
        'status_contrato', v_contract.status
      );
    end if;
    raise exception 'billing_chave_com_valores_diferentes' using errcode = '22023';
  end if;

  if v_periodo_fim <= v_referencia then
    raise exception 'billing_fim_anterior_ao_periodo_atual' using errcode = '22023';
  end if;

  insert into public.billing_payments (
    organization_id, contract_id, asaas_payment_id, gross_cents, status,
    paid_at, billing_period_start, billing_period_end, chave, nota, criado_por
  ) values (
    p_org, v_contract.id, null, p_valor_cents, 'RECEIVED_IN_CASH',
    now(), v_referencia, v_periodo_fim, p_chave, p_nota, p_actor
  )
  returning id into v_payment_id;

  -- Decisão 2: volta para 'ativa'; NÃO mexe em cancel_at_period_end (quem
  -- liga/desliga é fn_billing_cancelar_no_fim_do_periodo, à parte).
  update public.billing_contracts
    set current_period_start = v_referencia,
        current_period_end = v_periodo_fim,
        status = 'ativa'
    where id = v_contract.id;

  return jsonb_build_object(
    'ja_registrado', false,
    'payment_id', v_payment_id,
    'current_period_start', v_referencia,
    'current_period_end', v_periodo_fim,
    'status_contrato', 'ativa'
  );
end;
$$;

comment on function public.fn_billing_registrar_pagamento(uuid, date, integer, uuid, text, uuid) is
  '0908, decisão 2: registra um pagamento na mão e renova o período (início = greatest(current_period_end, now()); fim = fim do dia p_fim em America/Sao_Paulo), voltando o estado para ativa sem mexer em cancel_at_period_end. Idempotente pela chave (mesmos valores devolve ja_registrado=true; valores diferentes, 22023); fim que não é posterior ao período de referência também é 22023. p_actor recebido para a auditoria do chamador (mesmo padrão de fn_billing_trocar_plano/fn_billing_definir_modo, 0904/0907), não gravado por esta função.';

revoke execute on function public.fn_billing_registrar_pagamento(uuid, date, integer, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_registrar_pagamento(uuid, date, integer, uuid, text, uuid) to service_role;

-- ============================================================================
-- 3. fn_billing_estornar_pagamento: grava REFUNDED, sem mexer no período
-- (decisão 2).
-- ============================================================================
create or replace function public.fn_billing_estornar_pagamento(
  p_org uuid,
  p_pagamento uuid,
  p_chave uuid,
  p_nota text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_pagamento record;
  v_existente record;
  v_estorno_id uuid;
begin
  if p_chave is null then
    raise exception 'billing_chave_obrigatoria' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  select * into v_pagamento
    from public.billing_payments
    where id = p_pagamento;

  if not found then
    raise exception 'billing_pagamento_nao_encontrado' using errcode = 'P0002';
  end if;

  -- 42501: o pagamento existe, mas é de OUTRA organização.
  if v_pagamento.organization_id <> p_org then
    raise exception 'billing_pagamento_de_outra_organizacao' using errcode = '42501';
  end if;

  -- Idempotência pela chave (decisão 1/2): um REENVIO da mesma chamada
  -- (mesmo pagamento, já estornado por esta chave) devolve "já registrado";
  -- a mesma chave usada para outro pagamento é erro. Checado ANTES da
  -- checagem de "pode estornar" logo abaixo, para o reenvio de um estorno
  -- que já aconteceu não esbarrar nela.
  select * into v_existente
    from public.billing_payments
    where organization_id = p_org and chave = p_chave;

  if found then
    if v_existente.status = 'REFUNDED'
      and v_existente.gross_cents = v_pagamento.gross_cents
      and v_existente.billing_period_start = v_pagamento.billing_period_start
      and v_existente.billing_period_end = v_pagamento.billing_period_end
    then
      return jsonb_build_object('ja_registrado', true, 'estorno_id', v_existente.id);
    end if;
    raise exception 'billing_chave_com_valores_diferentes' using errcode = '22023';
  end if;

  -- Só se estorna um pagamento que ainda está RECEIVED_IN_CASH (nunca a
  -- própria linha de estorno, nem um pagamento já estornado por outra
  -- chave).
  if v_pagamento.status <> 'RECEIVED_IN_CASH' then
    raise exception 'billing_pagamento_nao_pode_ser_estornado' using errcode = '22023';
  end if;

  insert into public.billing_payments (
    organization_id, contract_id, asaas_payment_id, gross_cents, status,
    paid_at, billing_period_start, billing_period_end, chave, nota, criado_por
  ) values (
    p_org, v_pagamento.contract_id, null, v_pagamento.gross_cents, 'REFUNDED',
    now(), v_pagamento.billing_period_start, v_pagamento.billing_period_end, p_chave, p_nota, p_actor
  )
  returning id into v_estorno_id;

  -- Decisão 2: o estorno NÃO mexe no período do contrato; quem corrige é
  -- fn_billing_corrigir_periodo, chamada à parte pelo admin.
  return jsonb_build_object('ja_registrado', false, 'estorno_id', v_estorno_id);
end;
$$;

comment on function public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid) is
  '0908, decisão 2: grava uma linha REFUNDED com o MESMO gross_cents/período do pagamento original (positivo, decisão 1) e NÃO mexe no período do contrato. Pagamento de outra organização é 42501; pagamento que não está RECEIVED_IN_CASH (já estornado) é 22023. Idempotente pela chave (mesmo padrão de fn_billing_registrar_pagamento).';

revoke execute on function public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid) to service_role;

-- ============================================================================
-- 4. fn_billing_corrigir_periodo: erro de digitação, com motivo obrigatório
-- (decisão 2).
-- ============================================================================
create or replace function public.fn_billing_corrigir_periodo(
  p_org uuid,
  p_fim date,
  p_motivo text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_periodo_fim timestamptz;
begin
  if p_motivo is null or btrim(p_motivo) = '' then
    raise exception 'billing_motivo_obrigatorio' using errcode = '22023';
  end if;

  if p_fim is null then
    raise exception 'billing_fim_obrigatorio' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  -- Mesma regra de fim de dia SP das demais funções desta migração.
  v_periodo_fim := (p_fim + 1)::timestamp at time zone 'America/Sao_Paulo';

  if v_contract.current_period_start is not null and v_periodo_fim <= v_contract.current_period_start then
    raise exception 'billing_fim_anterior_ao_inicio_do_periodo' using errcode = '22023';
  end if;

  update public.billing_contracts
    set current_period_end = v_periodo_fim
    where id = v_contract.id;

  -- p_motivo e p_actor recebidos para a auditoria do CHAMADOR (mesmo padrão
  -- de p_actor em fn_billing_trocar_plano/fn_billing_definir_modo, 0904/
  -- 0907): não são gravados por esta função.
  return jsonb_build_object(
    'current_period_end_anterior', v_contract.current_period_end,
    'current_period_end_novo', v_periodo_fim
  );
end;
$$;

comment on function public.fn_billing_corrigir_periodo(uuid, date, text, uuid) is
  '0908, decisão 2: corrige o fim do período por erro de digitação (p_motivo obrigatório, 22023 se ausente/vazio). Só mexe em current_period_end; current_period_start e status ficam como estão. p_actor recebido para a auditoria do chamador, não gravado por esta função (mesmo padrão de 0904/0907).';

revoke execute on function public.fn_billing_corrigir_periodo(uuid, date, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_corrigir_periodo(uuid, date, text, uuid) to service_role;

-- ============================================================================
-- 5. fn_billing_mudar_estado: as transições manuais da decisão 3.
-- ============================================================================
create or replace function public.fn_billing_mudar_estado(
  p_org uuid,
  p_estado text,
  p_motivo text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
  v_permitido boolean := false;
begin
  if p_estado not in ('avaliacao', 'ativa', 'atrasada', 'suspensa', 'cancelada') then
    raise exception 'billing_estado_invalido' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  -- Decisão 3: uma checagem por destino. coalesce(..., false) em toda
  -- condição booleana que envolve current_period_end (pode ser nulo): lógica
  -- de três valores nunca pode decidir "permitido" por acidente.
  if p_estado = 'cancelada' then
    -- Qualquer estado vira cancelada, sem condição.
    v_permitido := true;
  elsif p_estado = 'avaliacao' then
    -- Reusa o current_period_end já existente; não cria período novo.
    v_permitido := coalesce(v_contract.current_period_end is not null, false);
  elsif p_estado in ('atrasada', 'suspensa') then
    -- Só sai de 'ativa' por esta função (a transição atrasada -> suspensa é
    -- do conferidor diário, decisão 4, não desta função manual).
    v_permitido := coalesce(v_contract.status = 'ativa', false);
  elsif p_estado = 'ativa' then
    v_permitido := coalesce(
      v_contract.status in ('atrasada', 'suspensa', 'cancelada')
        and v_contract.current_period_end is not null
        and v_contract.current_period_end > now(),
      false
    );
  end if;

  if not coalesce(v_permitido, false) then
    if p_estado = 'ativa' then
      raise exception 'billing_estado_sem_periodo_vigente' using errcode = '22023';
    else
      raise exception 'billing_transicao_nao_permitida' using errcode = '22023';
    end if;
  end if;

  update public.billing_contracts
    set status = p_estado
    where id = v_contract.id;

  -- p_motivo e p_actor recebidos para a auditoria do chamador, não gravados
  -- por esta função (mesmo padrão de 0904/0907).
  return jsonb_build_object('estado_anterior', v_contract.status, 'estado_novo', p_estado);
end;
$$;

comment on function public.fn_billing_mudar_estado(uuid, text, text, uuid) is
  '0908, decisão 3: transições manuais do admin. Qualquer estado -> cancelada, sem condição. ativa -> atrasada ou suspensa. atrasada/suspensa/cancelada -> ativa só com período vigente (current_period_end preenchido e no futuro; senão 22023, "registre um pagamento antes"). avaliacao exige current_period_end já preenchido (reusa o período existente). Toda transição fora desta lista é 22023.';

revoke execute on function public.fn_billing_mudar_estado(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_mudar_estado(uuid, text, text, uuid) to service_role;

-- ============================================================================
-- 6. fn_billing_cancelar_no_fim_do_periodo: liga/desliga cancel_at_period_end
-- (decisão 3).
-- ============================================================================
create or replace function public.fn_billing_cancelar_no_fim_do_periodo(
  p_org uuid,
  p_sim boolean,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract record;
begin
  if p_sim is null then
    raise exception 'billing_sim_obrigatorio' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  update public.billing_contracts
    set cancel_at_period_end = p_sim
    where id = v_contract.id;

  return jsonb_build_object('cancel_at_period_end', p_sim);
end;
$$;

comment on function public.fn_billing_cancelar_no_fim_do_periodo(uuid, boolean, uuid) is
  '0908, decisão 3: liga/desliga billing_contracts.cancel_at_period_end. Não mexe em status nem em período.';

revoke execute on function public.fn_billing_cancelar_no_fim_do_periodo(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_cancelar_no_fim_do_periodo(uuid, boolean, uuid) to service_role;

-- ============================================================================
-- 7. fn_billing_conferir_vencimento: o conferidor diário (decisão 4).
-- ============================================================================
--
-- VOLATILE: faz UPDATE. NÃO pega o advisory lock 'billing_assinatura:<org>'
-- das funções de escrita acima (decisão 4 trata as duas técnicas como
-- alternativas: lock nas funções de escrita, update atômico aqui): cada
-- UPDATE abaixo lê status e current_period_end DIRETO da tabela dentro do
-- próprio WHERE, nunca de uma variável lida antes. Se uma chamada
-- concorrente de fn_billing_registrar_pagamento já segura a linha (select
-- ... for update, sob o advisory lock dela), o UPDATE daqui fica bloqueado
-- pelo lock de LINHA (não pelo advisory lock) até aquela transação
-- terminar; ao continuar, o Postgres reavalia o WHERE contra o valor JÁ
-- COMMITADO (EvalPlanQual, READ COMMITTED) -- por isso o conferidor nunca
-- sobrescreve um pagamento que entrou no meio.
create or replace function public.fn_billing_conferir_vencimento(p_org uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_period_end timestamptz;
  v_grace_days integer;
  v_estado_novo text;
begin
  select bc.current_period_end, bp.grace_days
    into v_current_period_end, v_grace_days
    from public.billing_contracts bc
    join public.billing_plans bp on bp.id = bc.plan_id
    where bc.organization_id = p_org;

  if not found or v_current_period_end is null then
    -- Organização sem contrato ou sem período nunca muda (decisão 4).
    return null;
  end if;

  -- (a) cancel_at_period_end e período vencido: cancelada. Vence ANTES do
  -- atraso (decisão 4): quem pediu para não renovar não passa por
  -- "atrasada" no caminho.
  update public.billing_contracts
    set status = 'cancelada'
    where organization_id = p_org
      and status <> 'cancelada'
      and coalesce(cancel_at_period_end, false)
      and current_period_end <= now()
    returning status into v_estado_novo;
  if found then
    return v_estado_novo;
  end if;

  -- (b) ativa ou avaliacao com período vencido: atrasada.
  update public.billing_contracts
    set status = 'atrasada'
    where organization_id = p_org
      and status in ('ativa', 'avaliacao')
      and current_period_end <= now()
    returning status into v_estado_novo;
  if found then
    return v_estado_novo;
  end if;

  -- (c) atrasada além da carência do plano (current_period_end + grace_days
  -- no passado): suspensa.
  update public.billing_contracts
    set status = 'suspensa'
    where organization_id = p_org
      and status = 'atrasada'
      and current_period_end + (v_grace_days || ' days')::interval <= now()
    returning status into v_estado_novo;
  if found then
    return v_estado_novo;
  end if;

  return null;
exception
  when others then
    -- Erro numa organização não para a rodada (decisão 4): a rota que varre
    -- todas as organizações (Tarefa 5) segue para a próxima.
    raise warning 'billing_conferir_vencimento_falhou: organizacao=%, sqlerrm=%', p_org, sqlerrm;
    return null;
end;
$$;

comment on function public.fn_billing_conferir_vencimento(uuid) is
  '0908, decisão 4: conferidor diário, uma organização por chamada. Ordem fixa: (a) cancel_at_period_end + período vencido -> cancelada; (b) ativa/avaliacao + período vencido -> atrasada; (c) atrasada + current_period_end + grace_days no passado -> suspensa. Cada passo é um UPDATE atômico com WHERE lido direto da tabela (nunca sobrescreve um pagamento que entrou no meio). Organização sem contrato ou sem período nunca muda. Devolve o estado novo ou null quando nada mudou; nunca lança (erro interno vira raise warning + null, decisão 4).';

revoke execute on function public.fn_billing_conferir_vencimento(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_conferir_vencimento(uuid) to service_role;

-- ============================================================================
-- 8. agent_worker não registra pagamento, não muda estado nem confere
-- vencimento pelas peças novas desta migration (mesmo racional de todo
-- bloco análogo em 0904/0905/0906/0907): por alter default privileges ela
-- ganharia select/insert na tabela nova e execute em toda função nova do
-- schema public, e tem bypassrls.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert on public.billing_payments from agent_worker';
    execute 'revoke execute on function public.fn_billing_registrar_pagamento(uuid, date, integer, uuid, text, uuid), public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid), public.fn_billing_corrigir_periodo(uuid, date, text, uuid), public.fn_billing_mudar_estado(uuid, text, text, uuid), public.fn_billing_cancelar_no_fim_do_periodo(uuid, boolean, uuid), public.fn_billing_conferir_vencimento(uuid) from agent_worker';
  end if;
end
$$;
