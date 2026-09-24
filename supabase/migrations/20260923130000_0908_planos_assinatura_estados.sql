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
-- 1b. billing_payments.estorna_pagamento_id: fecha o ESTORNO DUPLO (achado
-- da Tarefa 1, corrigido aqui na Tarefa 2, dentro da mesma migração 0908).
-- ============================================================================
--
-- fn_billing_estornar_pagamento (seção 3, abaixo) recusava um segundo
-- estorno do MESMO pagamento só pela CHAVE (idempotência) e pelo status do
-- pagamento ORIGINAL -- mas billing_payments é só de acréscimo (decisão 1):
-- o status da linha original NUNCA muda para refletir que ela já foi
-- estornada. Duas chamadas com CHAVES diferentes estornavam o MESMO
-- pagamento duas vezes, sem vínculo nenhum entre a linha REFUNDED e o
-- pagamento que ela estorna. estorna_pagamento_id fecha isso: grava o id do
-- pagamento ORIGINAL, preenchido SÓ nas linhas REFUNDED (nulo em toda
-- RECEIVED_IN_CASH), com índice único PARCIAL -- um pagamento nunca tem duas
-- linhas REFUNDED apontando para ele.
--
-- Sem chave estrangeira, de propósito (mesmo racional de criado_por, decisão
-- 1 desta migração): um FK auto-referencial NESTA MESMA tabela, sem
-- UPDATE/DELETE, complicaria a ordem da cascata de exclusão de organização
-- (billing_payments cascade de organizations.id): se a linha ORIGINAL for
-- apagada antes da linha REFUNDED que a referencia, dentro do MESMO comando
-- de cascata, um FK NOT DEFERRABLE recusaria a exclusão. O índice único
-- parcial já garante a invariante que importa (no máximo um estorno por
-- pagamento) sem esse risco.
--
-- Idempotente: add column if not exists, índice if not exists.
alter table public.billing_payments add column if not exists estorna_pagamento_id uuid;

comment on column public.billing_payments.estorna_pagamento_id is
  'Achado da Tarefa 1 (estorno duplo), corrigido na Tarefa 2: id do pagamento ORIGINAL, preenchido só nas linhas REFUNDED (nulo em toda RECEIVED_IN_CASH). Sem chave estrangeira, de propósito (mesmo racional de criado_por): índice único parcial billing_payments_estorna_pagamento_id_unique garante no máximo UM estorno por pagamento original.';

create unique index if not exists billing_payments_estorna_pagamento_id_unique
  on public.billing_payments (estorna_pagamento_id)
  where estorna_pagamento_id is not null;

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

  -- Achado da Tarefa 1 (estorno duplo), corrigido aqui na Tarefa 2: a checagem
  -- de status logo abaixo NÃO detecta um segundo estorno do MESMO pagamento
  -- (billing_payments é só de acréscimo, decisão 1: o status da linha
  -- ORIGINAL nunca muda para refletir que ela já foi estornada). Esta consulta
  -- olha estorna_pagamento_id (seção 1b) para o pagamento original já ter
  -- sido estornado por QUALQUER chave, não só a desta chamada (a idempotência
  -- pela MESMA chave já voltou acima, no "if found" de v_existente).
  if exists (
    select 1 from public.billing_payments
    where organization_id = p_org and estorna_pagamento_id = p_pagamento
  ) then
    raise exception 'billing_pagamento_ja_estornado' using errcode = '22023';
  end if;

  -- Só se estorna um pagamento que ainda está RECEIVED_IN_CASH (nunca a
  -- própria linha de estorno, nem um pagamento já estornado por outra
  -- chave).
  if v_pagamento.status <> 'RECEIVED_IN_CASH' then
    raise exception 'billing_pagamento_nao_pode_ser_estornado' using errcode = '22023';
  end if;

  insert into public.billing_payments (
    organization_id, contract_id, asaas_payment_id, gross_cents, status,
    paid_at, billing_period_start, billing_period_end, chave, nota, criado_por,
    estorna_pagamento_id
  ) values (
    p_org, v_pagamento.contract_id, null, v_pagamento.gross_cents, 'REFUNDED',
    now(), v_pagamento.billing_period_start, v_pagamento.billing_period_end, p_chave, p_nota, p_actor,
    p_pagamento
  )
  returning id into v_estorno_id;

  -- Decisão 2: o estorno NÃO mexe no período do contrato; quem corrige é
  -- fn_billing_corrigir_periodo, chamada à parte pelo admin.
  return jsonb_build_object('ja_registrado', false, 'estorno_id', v_estorno_id);
end;
$$;

comment on function public.fn_billing_estornar_pagamento(uuid, uuid, uuid, text, uuid) is
  '0908, decisão 2: grava uma linha REFUNDED com o MESMO gross_cents/período do pagamento original (positivo, decisão 1) e NÃO mexe no período do contrato. Pagamento de outra organização é 42501; pagamento que não está RECEIVED_IN_CASH (já estornado) é 22023. Idempotente pela chave (mesmo padrão de fn_billing_registrar_pagamento). Achado da Tarefa 1 (estorno duplo), corrigido na Tarefa 2: grava estorna_pagamento_id = p_pagamento (seção 1b) e recusa com 22023 um segundo estorno do MESMO pagamento por QUALQUER chave (índice único parcial billing_payments_estorna_pagamento_id_unique garante o invariante no banco também).';

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
    -- Tarefa 2, decisão 9: fn_billing_avisar_assinatura roda DEPOIS de cada
    -- mudança de estado (dedup própria por período/estado, nunca duplica; erro
    -- interno vira warning, nunca desfaz a transição que já aconteceu, ver o
    -- comentário dela).
    perform public.fn_billing_avisar_assinatura(p_org);
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
    -- Tarefa 2, decisão 9: fn_billing_avisar_assinatura roda DEPOIS de cada
    -- mudança de estado (dedup própria por período/estado, nunca duplica; erro
    -- interno vira warning, nunca desfaz a transição que já aconteceu, ver o
    -- comentário dela).
    perform public.fn_billing_avisar_assinatura(p_org);
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
    -- Tarefa 2, decisão 9: fn_billing_avisar_assinatura roda DEPOIS de cada
    -- mudança de estado (dedup própria por período/estado, nunca duplica; erro
    -- interno vira warning, nunca desfaz a transição que já aconteceu, ver o
    -- comentário dela).
    perform public.fn_billing_avisar_assinatura(p_org);
    return v_estado_novo;
  end if;

  -- Tarefa 2, decisão 9: nenhuma das três transições acima aconteceu hoje
  -- (o "passo diário" sem mudança de estado nenhuma) -- é AQUI que o aviso de
  -- três dias antes da suspensão nasce, porque a organização já está
  -- 'atrasada' há dias, sem transição NOVA nenhuma no dia em que a janela dos
  -- três dias abre. fn_billing_avisar_assinatura decide sozinha, pelo status
  -- ATUAL do contrato, o que avisar (ou nada).
  perform public.fn_billing_avisar_assinatura(p_org);
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
  '0908, decisão 4: conferidor diário, uma organização por chamada. Ordem fixa: (a) cancel_at_period_end + período vencido -> cancelada; (b) ativa/avaliacao + período vencido -> atrasada; (c) atrasada + current_period_end + grace_days no passado -> suspensa. Cada passo é um UPDATE atômico com WHERE lido direto da tabela (nunca sobrescreve um pagamento que entrou no meio). Organização sem contrato ou sem período nunca muda. Devolve o estado novo ou null quando nada mudou; nunca lança (erro interno vira raise warning + null, decisão 4). Tarefa 2, decisão 9: chama fn_billing_avisar_assinatura(p_org) em TODO caminho de saída (depois de cada mudança de estado, e também no passo diário sem mudança nenhuma, para o aviso de três dias antes da suspensão nascer enquanto a organização segue atrasada); a chamada nunca lança (ver o comentário daquela função).';

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

-- ============================================================================
-- PARTE 2 (Tarefa 2): modo leitura da conta suspensa.
-- ============================================================================
--
-- Racional completo em hiperbold/planos/fase-F4-tarefas.md, decisões 5, 6, 7
-- e 9 e "Tarefa 2". Modo leitura em si (decisão 5): fn_billing_modo_leitura,
-- abaixo, é o interruptor -- true só com modo='bloquear' E
-- bloqueio_a_partir_de preenchido e VENCIDO (mesma carência da F3, decisão 2
-- daquela fase: ligar o bloqueio não suspende ninguém de surpresa) E
-- status in ('suspensa', 'cancelada'). Lê o modo ANTES de qualquer outra
-- coisa (no modo avisar sai logo, zero consulta a billing_contracts), mesmo
-- padrão de fn_billing_bloqueia/fn_billing_bloqueio_ativo (0907).
--
-- Decisão 6: a checagem da IA (fn_billing_ia_pode_responder, 0907) NÃO muda
-- nesta migração -- fica separada de propósito, e o TypeScript de
-- run-model-call (Tarefa 6, fora do escopo desta migração) chama
-- fn_billing_modo_leitura ANTES dos atalhos de origem/propósito da chave.
--
-- Decisão 7: a recusa por modo leitura entra nos QUATRO gatilhos de CRIAÇÃO
-- (funis, etapas, integrações webhook, convites), editados NO LUGAR na
-- migração 0905 (fn_billing_trava_crm_pipelines, fn_billing_trava_crm_stages,
-- fn_billing_trava_webhook_sources, fn_billing_trava_team_invites) e no
-- baseline.sql (mesmo bloco, mantido idêntico). NÃO em fn_billing_bloqueia
-- (que também serve leads e o aceite de convite): leads continuam sendo
-- criados (N23), aceite de convite pendente continua (decisão 4 da F3), e
-- channel_sessions (conectar/reconectar WhatsApp) nunca teve gatilho de plano
-- nenhum -- o chat nunca para. fn_billing_modo_leitura roda ANTES do
-- bloqueio de teto (fn_billing_bloqueia), na MESMA transição que já confere
-- o teto: PT402 com detail='assinatura_suspensa', FORA de qualquer bloco
-- exception (mesma doutrina do PT402 de teto, 0907).
--
-- Decisão 9: os avisos (fn_billing_avisar_assinatura, abaixo) nascem em
-- QUALQUER modo (são informativos); só a PARADA de verdade depende do modo
-- leitura. Por isso billing_assinatura entrou nas três proteções contra o
-- membro (as duas policies RESTRICTIVE e o gatilho de update em
-- agent_inbox_items, M2 da 0905), editadas NO LUGAR na 0905 e no baseline,
-- ao lado de billing_limite/billing_carteira.
--
-- Mesmo padrão de segurança das migrations anteriores da faixa (0904 a
-- 0907): security definer, search_path fixo em public, pg_temp, revoke de
-- public/anon/authenticated, grant só para service_role. EXCEÇÃO:
-- fn_billing_modo_leitura também é concedida a agent_worker, DE PROPÓSITO
-- FORA do bloco de revoke (comentário forte logo abaixo, mesmo padrão de
-- fn_billing_ia_pode_responder, 0907): o worker do agente PRECISA chamá-la
-- (Tarefa 6, run-model-call.ts, roda com o pool do próprio agent_worker).
--
-- Idempotente: create or replace, revoke/grant repetíveis.

-- ============================================================================
-- 9. fn_billing_modo_leitura: o interruptor do modo leitura (decisão 5).
-- ============================================================================
create or replace function public.fn_billing_modo_leitura(p_org uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_bloqueio_a_partir_de timestamptz;
  v_status text;
begin
  -- Lê o modo ANTES de qualquer outra coisa (decisão 5, "zero custo a mais"
  -- no modo avisar): sai sem tocar billing_contracts, sem ler status nem
  -- carência.
  select modo into v_modo from public.billing_settings where id = 1;

  if v_modo is distinct from 'bloquear' then
    return false;
  end if;

  select bc.bloqueio_a_partir_de, bc.status
    into v_bloqueio_a_partir_de, v_status
    from public.billing_contracts bc
    where bc.organization_id = p_org;

  -- coalesce(..., false) na condição INTEIRA (decisão 5): organização sem
  -- contrato (v_status nulo), sem carência (nula) ou com carência no futuro
  -- nunca lê como "modo leitura", nunca por acidente de lógica de três
  -- valores.
  return coalesce(
    v_bloqueio_a_partir_de is not null
      and v_bloqueio_a_partir_de <= now()
      and v_status in ('suspensa', 'cancelada'),
    false
  );
end;
$$;

comment on function public.fn_billing_modo_leitura(uuid) is
  'Tarefa 2, decisão 5: o interruptor do modo leitura. true só quando billing_settings.modo=bloquear E billing_contracts.bloqueio_a_partir_de preenchido e VENCIDO (mesma carência da F3) E status in (suspensa, cancelada). coalesce(..., false) na condição inteira. Lê o modo ANTES de qualquer outra coisa (sai sem consulta a billing_contracts no modo avisar/desligado). Usada pelos quatro gatilhos de criação (funis, etapas, integrações webhook, convites, editados NO LUGAR na 0905) e pelo TypeScript de run-model-call (Tarefa 6) ANTES dos atalhos de origem/propósito da chave. security definer com search_path fixo, revoke de public/anon/authenticated, grant a service_role.';

revoke execute on function public.fn_billing_modo_leitura(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_modo_leitura(uuid) to service_role;

-- IMPORTANTE, NÃO COPIAR ESTE GRANT PARA OUTRA FUNÇÃO POR REFLEXO: esta
-- função fica DE PROPÓSITO fora de todo bloco de revoke do agent_worker
-- desta migração (blocos de agent_worker acima e abaixo) e de qualquer bloco
-- futuro que revogue "toda função nova do schema public" dessa role. O
-- motivo: fn_billing_modo_leitura é chamada pelo run-model-call
-- (lib/agent-engine/edge/llm/run-model-call.ts, decisão 6 da fase, Tarefa
-- 6, fora do escopo desta migração), que usa o pool de conexão do próprio
-- agent_worker (SUPABASE_DB_URL/DB_URL do worker, não o service_role do
-- servidor Next) -- é a mesma exceção de fn_billing_ia_pode_responder
-- (0907), pelo mesmo motivo. O grant abaixo é redundante com o "alter
-- default privileges" do papel dono das migrações (mesma prova feita em
-- 0907), mas fica EXPLÍCITO de propósito, documentando a intenção e
-- sobrevivendo a uma reforma futura desse default privilege.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'grant execute on function public.fn_billing_modo_leitura(uuid) to agent_worker';
  end if;
end
$$;

-- ============================================================================
-- 10. fn_billing_avisar_assinatura: os quatro avisos da decisão 9.
-- ============================================================================
--
-- Chamada por fn_billing_conferir_vencimento (parte 1, seção 7, acima,
-- editada NO LUGAR) depois de CADA mudança de estado e também no passo
-- diário sem mudança nenhuma (é assim que o aviso de três dias antes da
-- suspensão nasce: a organização já está 'atrasada' há dias, sem transição
-- NOVA nenhuma no dia em que a janela dos três dias abre).
--
-- Os avisos nascem em QUALQUER modo (são informativos, decisão 9): só a
-- PARADA de verdade depende do modo leitura (fn_billing_modo_leitura,
-- acima). Por isso esta função nem lê billing_settings.modo.
--
-- Dedup por billing_token_avisos_emitidos (0906), chave
-- 'assinatura:<estado>:<fim do período em YYYY-MM-DD>': sobrevive ao
-- encerramento do item na Central (mesma doutrina do dedup de carteira,
-- 0906, decisões 14/15), diferente do dedup "enquanto status=open" de
-- fn_billing_conferir_teto (0905), que reabriria o MESMO aviso de assinatura
-- toda vez que o admin resolvesse o anterior. '<estado>' aqui não é sempre
-- billing_contracts.status: 'atrasada_aviso_3_dias' é uma CHAVE própria,
-- distinta de 'atrasada' (o aviso de entrada), para as duas mensagens
-- conviverem no mesmo período sem uma apagar o dedup da outra.
--
-- Datas em dd/mm/aaaa, America/Sao_Paulo, SEM nome de mês (to_char com
-- máscara só numérica: nome de mês dependeria do locale do cluster, que pode
-- não ser pt_BR, mesmo cuidado do array fixo de fn_billing_avisar_carteira,
-- 0906, só que aqui a máscara numérica já resolve sem precisar de array).
--
-- Nunca derruba o conferidor (decisão 9): begin/exception PRÓPRIO. Chamada
-- de DENTRO do begin/exception de fn_billing_conferir_vencimento, que
-- envolve a FUNÇÃO INTEIRA (inclusive os UPDATEs de transição já
-- executados): um erro que escapasse daqui acionaria o savepoint IMPLÍCITO
-- daquele bloco exception externo e desfaria a mudança de estado que já
-- tinha acontecido, não só o aviso. Por isso este exception é interno e
-- silencioso (raise warning), nunca propaga.
create or replace function public.fn_billing_avisar_assinatura(p_org uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_current_period_end timestamptz;
  v_grace_days integer;
  v_data_suspensao timestamptz;
  v_periodo_fmt text;
  v_titulo text;
  v_corpo text;
  v_linhas integer;
begin
  select bc.status, bc.current_period_end, bp.grace_days
    into v_status, v_current_period_end, v_grace_days
    from public.billing_contracts bc
    join public.billing_plans bp on bp.id = bc.plan_id
    where bc.organization_id = p_org;

  if not found or v_current_period_end is null then
    return;
  end if;

  v_periodo_fmt := to_char(v_current_period_end, 'YYYY-MM-DD');

  if v_status = 'atrasada' then
    v_data_suspensao := v_current_period_end + (v_grace_days || ' days')::interval;

    -- Aviso de entrada em atrasada, com a data prevista da suspensão
    -- (America/Sao_Paulo, DD/MM/YYYY, sem nome de mês).
    v_titulo := 'Pagamento em atraso';
    v_corpo := 'O pagamento desta organização está atrasado. Sem regularização, o acesso entra em modo leitura em '
      || to_char(v_data_suspensao at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '.';

    insert into public.billing_token_avisos_emitidos (organization_id, chave)
    values (p_org, 'assinatura:atrasada:' || v_periodo_fmt)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
      values (p_org, 'other', 'warn', v_titulo, v_corpo, 'billing_assinatura', p_org);
    end if;

    -- Três dias antes da suspensão, só com carência maior que três dias
    -- (decisão 9): com carência de até 3 dias, o aviso de entrada acima já
    -- avisa em cima da hora, um segundo aviso não cabe.
    if v_grace_days > 3 and now() >= v_data_suspensao - interval '3 days' then
      v_titulo := 'Suspensão em três dias';
      v_corpo := 'Em três dias esta organização entra em modo leitura por falta de pagamento. Regularize antes de '
        || to_char(v_data_suspensao at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || ' para não perder o acesso de escrita.';

      insert into public.billing_token_avisos_emitidos (organization_id, chave)
      values (p_org, 'assinatura:atrasada_aviso_3_dias:' || v_periodo_fmt)
      on conflict (organization_id, chave) do nothing;

      get diagnostics v_linhas = row_count;
      if v_linhas > 0 then
        insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
        values (p_org, 'other', 'warn', v_titulo, v_corpo, 'billing_assinatura', p_org);
      end if;
    end if;
  elsif v_status = 'suspensa' then
    v_titulo := 'Conta suspensa';
    v_corpo := 'Esta organização está suspensa por falta de pagamento: a criação de funis, etapas, integrações webhook e convites está parada até a regularização.';

    insert into public.billing_token_avisos_emitidos (organization_id, chave)
    values (p_org, 'assinatura:suspensa:' || v_periodo_fmt)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
      values (p_org, 'other', 'critical', v_titulo, v_corpo, 'billing_assinatura', p_org);
    end if;
  elsif v_status = 'cancelada' then
    v_titulo := 'Assinatura cancelada';
    v_corpo := 'A assinatura desta organização foi cancelada.';

    insert into public.billing_token_avisos_emitidos (organization_id, chave)
    values (p_org, 'assinatura:cancelada:' || v_periodo_fmt)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
      values (p_org, 'other', 'warn', v_titulo, v_corpo, 'billing_assinatura', p_org);
    end if;
  end if;
exception
  when others then
    -- Nunca derruba o conferidor (decisão 9): ver o cabeçalho desta função.
    raise warning 'billing_avisar_assinatura_falhou: organizacao=%, sqlerrm=%', p_org, sqlerrm;
end;
$$;

comment on function public.fn_billing_avisar_assinatura(uuid) is
  'Tarefa 2, decisão 9: os quatro avisos da assinatura (entrada em atrasada com a data prevista da suspensão; três dias antes, só com grace_days > 3; suspensão; cancelamento), chamada por fn_billing_conferir_vencimento depois de CADA mudança de estado e no passo diário sem mudança nenhuma. Nascem em QUALQUER modo (são informativos; só a parada de verdade depende do modo leitura). kind=other, ref_kind=billing_assinatura, ref_id=organization_id. Dedup por billing_token_avisos_emitidos (0906), chave assinatura:<estado>:<fim do período YYYY-MM-DD>, que sobrevive ao encerramento do item. Datas em dd/mm/aaaa, America/Sao_Paulo, sem nome de mês. Nunca lança: begin/exception próprio (raise warning), para não acionar o savepoint implícito do bloco exception do CHAMADOR e desfazer a mudança de estado já commitada.';

revoke execute on function public.fn_billing_avisar_assinatura(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_avisar_assinatura(uuid) to service_role;

-- ============================================================================
-- 11. agent_worker não decide modo leitura nem emite aviso de assinatura pela
-- peça nova desta parte 2 (mesmo racional de todo bloco análogo acima):
-- fn_billing_avisar_assinatura NÃO entra aqui (ela é chamada só de dentro do
-- conferidor, service_role); fn_billing_modo_leitura fica DE PROPÓSITO FORA
-- deste bloco (ver o comentário forte acima do grant dela).
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_avisar_assinatura(uuid) from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- PARTE 3 (Tarefa 3): catálogo de pacotes de tokens vendidos na mão, e o
-- fechamento do D-046 (registro falso na auditoria).
-- ============================================================================
--
-- Racional completo em hiperbold/planos/fase-F4-tarefas.md, decisões 10 e 11
-- e "Tarefa 3", e em hiperbold/DEBITO.md, D-046.
--
-- Decisão 10 (catálogo de pacotes):
-- billing_token_pacotes é o CATÁLOGO do que o admin da plataforma vende na
-- mão (código no mesmo formato de billing_plans.code, nome, tokens, ativo).
-- Não confundir com billing_token_adicionais (0906, assinatura MENSAL
-- recorrente, concedida todo ciclo) nem com o crédito avulso já existente,
-- fn_billing_creditar_tokens (0906): billing_token_pacotes é só a lista de
-- produtos vendáveis, fn_billing_creditar_pacote (abaixo) é a ponte entre um
-- item do catálogo e aquele crédito. preco_cents fica NULO até o Filipe
-- definir (N9): esta migração não semeia pacote nenhum, nem código nem
-- preço, o admin cadastra pela tela (Tarefa 5). Sem grant para
-- anon/authenticated (a tela lê pelo servidor, mesmo padrão de
-- billing_payments); service_role com select, insert e update (o admin
-- cadastra e desativa), sem delete: um pacote já vendido fica no histórico
-- (o crédito em billing_token_ledger continua referindo um código que precisa
-- seguir existindo, mesmo desativado).
--
-- fn_billing_creditar_pacote(p_org, p_pacote, p_valor_cents, p_chave, p_nota,
-- p_actor): pacote inexistente é P0002; pacote com ativo=false é 22023 (não
-- se vende mais, mesmo que ainda apareça no histórico); o valor creditado é
-- preco_cents do catálogo quando preenchido, senão p_valor_cents informado na
-- hora pelo admin, e os DOIS ausentes é 22023 (nunca inventa preço, N9,
-- mesma doutrina do padrão do arquivo). Delega a fn_billing_creditar_tokens
-- (0906) com os tokens do pacote: reaproveita a mesma trava por organização e
-- a mesma idempotência por p_chave daquela função, sem duplicar nenhuma das
-- duas.
--
-- Decisão 11 (D-046, api_audit_log): a política `audit_log_insert_tenant_member`
-- do AUTOR (baseline.sql, FOR INSERT TO authenticated, sem exigir
-- actor_user_id = auth.uid() nem organization_id preenchido) NÃO é editada
-- (regra do briefing: nunca no lugar). Em vez disso, api_audit_log ganha uma
-- política RESTRICTIVE própria desta migração, `for insert to authenticated
-- with check (false)`: pelo modelo de RLS do Postgres, uma linha só passa
-- quando satisfaz PELO MENOS UMA permissive E TODAS as restrictive da mesma
-- ação, então esta política sozinha fecha o insert de `authenticated` por
-- completo, mesmo com a permissive do autor de pé.
--
-- Mapa de quem grava api_audit_log hoje (conferido por grep antes desta
-- migração, nenhum gravador editado):
--   - lib/audit/index.ts (audit(), auditForOrganizations()): prefere
--     createAdminClient() (service_role, bypassrls, ignora esta política) quando
--     há SUPABASE_SERVICE_ROLE_KEY configurada; SEM a chave (só em
--     desenvolvimento, isServiceRoleConfigured() falso) cai para
--     createClient() (sessão do usuário, authenticated) e é o ÚNICO caminho
--     que esta política passa a recusar. audit() já é fire-and-forget: o
--     erro do insert vira reportAuditFailure (console.error + Sentry), nunca
--     propaga para a mutação principal, então o plano B de desenvolvimento
--     sem chave de serviço passa a só REGISTRAR NO LOG que a auditoria
--     falhou, sem derrubar nada (mesma previsão da decisão 11 da fase).
--   - lib/ai/handoff/orchestrator.ts: só grava com createAdminClient()
--     (service_role); esta política não muda nada para ele.
--   - Toda função SQL que grava (0906, 0907, 0908 e as do autor) é `security
--     definer`, então o insert roda como o DONO da função (postgres), não
--     como `authenticated`; RLS nunca filtra o dono de uma tabela, então
--     nenhuma dessas funções é afetada.
-- Nenhum gravador de PRODUÇÃO grava api_audit_log pela sessão do usuário.
--
-- agent_worker (se a role existir) perde update, delete e truncate na tabela
-- (mesmo vocabulário da migration 0258, que já fez isso para
-- anon/authenticated/service_role no baseline): defesa em profundidade, essa
-- role nunca teve select/insert concedido nela por nenhuma migração deste
-- fork, mas tem bypassrls e ganhou update/delete no provisionamento
-- (`grant select, insert, update, delete on all tables in schema public to
-- agent_worker`, hiperbold/scripts/role-agent-worker.sql) antes de qualquer
-- revoke específico existir.
--
-- Mesmo padrão de segurança das partes anteriores: security definer,
-- search_path fixo em public, pg_temp, revoke de public/anon/authenticated,
-- grant só para service_role, bloco final de agent_worker (se a role
-- existir).
--
-- Idempotente: create table if not exists, create or replace, create policy
-- protegida por drop policy if exists, revoke/grant repetíveis.

-- ============================================================================
-- 12. billing_token_pacotes: o catálogo dos pacotes vendidos na mão (decisão
-- 10).
-- ============================================================================
create table if not exists public.billing_token_pacotes (
  id uuid primary key default gen_random_uuid(),
  codigo text not null,
  nome text not null,
  tokens bigint not null,
  -- Nulo até o Filipe definir (N9, decisão 10): nenhum preço é inventado.
  -- fn_billing_creditar_pacote exige p_valor_cents na hora quando este campo
  -- está nulo.
  preco_cents integer,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_token_pacotes_codigo_unique unique (codigo),
  -- Mesmo formato de billing_plans.code (0904): letra minúscula, depois
  -- letra/dígito/underscore, até 31 caracteres.
  constraint billing_token_pacotes_codigo_formato check (codigo ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint billing_token_pacotes_tokens_positivo check (tokens > 0),
  constraint billing_token_pacotes_preco_cents_nao_negativo check (preco_cents is null or preco_cents >= 0)
);

comment on table public.billing_token_pacotes is
  'Tarefa 3, decisão 10: catálogo dos pacotes de tokens vendidos NA MÃO pelo admin da plataforma (N24). Não é uma tabela de crédito em si (o crédito é billing_token_ledger, via fn_billing_creditar_pacote); é o CADASTRO do que pode ser vendido. Sem delete (revoke, ver grants): um pacote já vendido fica no histórico, o admin só desativa (ativo=false). Sem grant para anon/authenticated: a tela lê pelo servidor, com service_role.';
comment on column public.billing_token_pacotes.preco_cents is
  'Tarefa 3, decisão 10 (N9): nulo até o Filipe definir o preço. Esta migração NÃO semeia nenhum pacote (nem código, nem preço): nenhum valor de produto é inventado. Com preco_cents nulo, fn_billing_creditar_pacote exige p_valor_cents informado na hora pelo admin; com os dois ausentes, 22023.';
comment on column public.billing_token_pacotes.ativo is
  'Tarefa 3, decisão 10: pacote inativo não pode mais ser creditado (fn_billing_creditar_pacote recusa com 22023), mas a linha permanece (histórico do que já foi vendido). Não existe delete concedido nesta tabela.';

drop trigger if exists trg_billing_token_pacotes_updated_at on public.billing_token_pacotes;
create trigger trg_billing_token_pacotes_updated_at
  before update on public.billing_token_pacotes
  for each row execute function public.fn_set_updated_at();

alter table public.billing_token_pacotes enable row level security;

revoke all on public.billing_token_pacotes from anon, authenticated;

-- Decisão 10: select, insert e update para service_role (o admin cadastra e
-- desativa); SEM delete (pacote vendido fica no histórico). O revoke
-- explícito de delete/truncate fecha o default ACL do Supabase, que concede
-- os quatro (select/insert/update/delete) mais truncate a service_role na
-- criação de toda tabela nova, do mesmo jeito que billing_payments (Parte 1)
-- já faz.
grant select, insert, update on public.billing_token_pacotes to service_role;
revoke delete, truncate on public.billing_token_pacotes from service_role;

-- ============================================================================
-- 13. fn_billing_creditar_pacote: credita um pacote do catálogo (decisão 10).
-- ============================================================================
create or replace function public.fn_billing_creditar_pacote(
  p_org uuid,
  p_pacote uuid,
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
  v_pacote record;
  v_valor_cents integer;
  v_credito jsonb;
begin
  select id, tokens, preco_cents, ativo into v_pacote
    from public.billing_token_pacotes
    where id = p_pacote;

  if not found then
    raise exception 'billing_pacote_nao_encontrado' using errcode = 'P0002';
  end if;

  -- coalesce(..., false): pacote sem linha de ativo definida (não deveria
  -- existir, a coluna é not null, mas a checagem não confia em três valores
  -- por acidente) nunca é tratado como "pode creditar".
  if not coalesce(v_pacote.ativo, false) then
    raise exception 'billing_pacote_inativo' using errcode = '22023';
  end if;

  -- Decisão 10: preço do catálogo quando preenchido; senão o valor informado
  -- na hora. Os DOIS ausentes é 22023, nunca inventa preço (N9).
  v_valor_cents := coalesce(v_pacote.preco_cents, p_valor_cents);

  if v_valor_cents is null then
    raise exception 'billing_valor_obrigatorio' using errcode = '22023';
  end if;

  -- fn_billing_creditar_tokens (0906) já trava por organização
  -- (pg_advisory_xact_lock('billing_tokens:<org>')) e já é idempotente pela
  -- mesma p_chave (reenvio não credita duas vezes): esta função não repete
  -- nenhuma das duas, só resolve tokens/valor a partir do catálogo.
  v_credito := public.fn_billing_creditar_tokens(p_org, v_pacote.tokens, p_chave, v_valor_cents, p_nota, p_actor);

  return v_credito || jsonb_build_object('pacote_id', v_pacote.id, 'tokens', v_pacote.tokens, 'valor_cents', v_valor_cents);
end;
$$;

comment on function public.fn_billing_creditar_pacote(uuid, uuid, integer, uuid, text, uuid) is
  'Tarefa 3, decisão 10: credita um pacote do catálogo (billing_token_pacotes) pela ponte com fn_billing_creditar_tokens (0906). Pacote inexistente é P0002; pacote inativo é 22023. Valor = preco_cents do catálogo quando preenchido, senão p_valor_cents informado na hora; os DOIS ausentes é 22023 (N9, nenhum preço inventado). Idempotência e trava por organização herdadas de fn_billing_creditar_tokens. Devolve o jsonb dela acrescido de pacote_id, tokens e valor_cents efetivamente usados.';

revoke execute on function public.fn_billing_creditar_pacote(uuid, uuid, integer, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_creditar_pacote(uuid, uuid, integer, uuid, text, uuid) to service_role;

-- ============================================================================
-- 14. agent_worker não cadastra, não desativa nem credita pacote pelas peças
-- novas desta parte 3 (mesmo racional de todo bloco análogo acima).
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update on public.billing_token_pacotes from agent_worker';
    execute 'revoke execute on function public.fn_billing_creditar_pacote(uuid, uuid, integer, uuid, text, uuid) from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- 15. D-046: api_audit_log ganha uma policy RESTRICTIVE que fecha o insert de
-- authenticated (decisão 11). A policy do AUTOR (audit_log_insert_tenant_member)
-- NÃO é tocada, só esta acrescenta.
-- ============================================================================
drop policy if exists api_audit_log_insert_authenticated_restritiva on public.api_audit_log;
create policy api_audit_log_insert_authenticated_restritiva on public.api_audit_log
  as restrictive
  for insert to authenticated
  with check (false);

comment on policy api_audit_log_insert_authenticated_restritiva on public.api_audit_log is
  'D-046 (hiperbold/DEBITO.md), Tarefa 3 da fase F4: RESTRICTIVE que fecha o insert de authenticated por completo (with check(false) numa restrictive é AND com toda permissive da mesma ação, nenhuma linha passa), sem editar a policy permissive do autor audit_log_insert_tenant_member. Todo gravador de produção usa service_role (bypassrls) ou função security definer, nenhum depende do insert de authenticated (ver o comentário da Parte 3, acima); o único caminho fechado é o plano B de desenvolvimento sem chave de serviço (lib/audit/index.ts), que já é fire-and-forget e passa a só registrar a falha no log.';

-- ============================================================================
-- 16. agent_worker perde update, delete e truncate em api_audit_log (mesmo
-- vocabulário da migration 0258, defesa em profundidade: ver o comentário da
-- Parte 3, acima).
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke update, delete, truncate on public.api_audit_log from agent_worker';
  end if;
end
$$;
