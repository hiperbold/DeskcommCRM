-- 0906, carteira de tokens de IA (fase F2-B, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Racional completo em
-- hiperbold/planos/fase-F2-B-tarefas.md.
--
-- Objetivo da fase: medir, debitar e mostrar o consumo de IA pago pela
-- Hiperbold, em token PONDERADO. Nesta fase nada bloqueia (a trava de
-- verdade é a F3): a carteira mede, debita, avisa e mostra.
--
-- Esta migration (0906) é dividida em partes, cada uma uma tarefa da fase.
-- Esta aplicação traz só a PARTE 1 (Tarefa 1): configuração (pesos, marca de
-- início, tetos em billing_settings), a origem da chave em llm_calls, as
-- quatro tabelas da carteira (livro-caixa, saldo materializado, adicionais,
-- agregado do extrato) e as duas funções puras de cálculo (ciclo do mês,
-- token ponderado). Concessão, débito, gatilho, avisos e travas são as
-- Tarefas 2a/2b, em partes seguintes deste mesmo arquivo.
--
-- Decisão 1 (unidade):
-- ponderado = ceil((max(input - cache_read, 0) + output + cache_read *
-- peso_cache / 100) * peso_proposito / 100), sempre bigint. Os pesos entram
-- como PARÂMETRO de fn_billing_tokens_ponderados (immutable): quem chama lê
-- a configuração vigente e grava o resultado na linha do livro-caixa;
-- trocar o peso no meio do ciclo não recalcula o passado.
--
-- Decisão 4 (ciclo):
-- Ciclo = mês civil no fuso America/Sao_Paulo, sempre calculado de
-- llm_calls.created_at da CHAMADA, nunca de now(): fn_billing_ciclo_de.
--
-- Decisão 5 (marca de início):
-- billing_settings.carteira_desde, preenchida uma única vez (coalesce, nunca
-- sobrescrita) nesta migration. Sem isso, o conferidor da Tarefa 2a cobraria
-- de uma vez todo o histórico anterior à carteira existir.
--
-- Decisões 6 a 9 (livro-caixa, saldo, agregado):
-- billing_token_ledger é SÓ DE ACRÉSCIMO: toda concessão, crédito, ajuste e
-- consumo vira linha, nenhum saldo muda sem linha. Ninguém tem update,
-- delete nem truncate nesta tabela, nem o service_role, e não há gatilho
-- BEFORE UPDATE/DELETE: a exclusão em cascata de uma organização funciona
-- porque a ação referencial roda como dono da tabela. `llm_call_id` e
-- `criado_por` são uuid SEM chave estrangeira de propósito: uma FK com
-- `on delete set null` viraria UPDATE numa tabela que não tem update; sem
-- ação, travaria apagar a linha de origem. billing_token_wallets é o saldo
-- MATERIALIZADO (creditado/consumido por organização, fonte e ciclo, com
-- `avulso` de ciclo nulo; unique nulls not distinct, Postgres 15.8).
-- billing_token_consumo_diario é o agregado que o extrato lê, atualizado
-- dentro do débito (Tarefa 2a) só quando a linha do livro-caixa entrou de
-- fato; sem FK em cascata para agente nem contato (apagar agente não apaga
-- histórico de consumo).
--
-- Decisão 19 (quem vê o quê):
-- Carteira e agregado: gerente para cima da própria organização (grant
-- select + policy fn_role_at_least(organization_id, 'manager') ou
-- fn_is_platform_admin()), mesma régua de "Plano e uso" (0905). Livro-caixa
-- e adicionais: privilégio NENHUM para authenticated, só a plataforma, pelo
-- servidor com service_role.
--
-- Idempotente: add column if not exists, create table if not exists, create
-- or replace, constraint nomeada criada só se ainda não existe (mesmo molde
-- da 0128/0904), bloco final revogando de agent_worker (se a role existir)
-- a escrita nas tabelas novas e o execute das funções novas: essa role tem
-- bypassrls e ganharia os dois por alter default privileges se este bloco
-- não existisse.

-- ============================================================================
-- 1. billing_settings: pesos, marca de início da carteira, tetos de segurança.
-- ============================================================================

-- fn_billing_pesos_validos: valida o jsonb de pesos por propósito ANTES da
-- tabela usar a função no CHECK (mesmo desenho de fn_billing_limites_validos,
-- 0904: função primeiro, porque o CHECK a chama). Em plpgsql, não em SQL
-- puro, pelo mesmo motivo daquela: confere o tipo do jsonb ANTES de iterar
-- as chaves, para nunca chamar jsonb_each num valor que não é objeto.
-- Conjunto de chaves ABERTO de propósito (ao contrário dos 7 tetos fechados
-- da 0904): um propósito novo de IA pode ganhar peso próprio sem migration.
create or replace function public.fn_billing_pesos_validos(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_chave text;
  v_valor jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;

  for v_chave, v_valor in select * from jsonb_each(p)
  loop
    -- Inteiro puro entre 0 e 100: o texto do número precisa casar com
    -- '^[0-9]+$' (mesma guarda da 0904 contra '5.0'::int quebrar depois).
    if jsonb_typeof(v_valor) <> 'number'
      or (v_valor::text) !~ '^[0-9]+$'
      or (v_valor::text)::int < 0
      or (v_valor::text)::int > 100
    then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

comment on function public.fn_billing_pesos_validos(jsonb) is
  'Valida billing_settings.pesos_por_proposito: objeto jsonb com qualquer conjunto de chaves (aberto, ao contrário dos tetos de plano), cada valor inteiro 0..100. EXCEÇÃO deliberada ao item de padrão do arquivo (mesma exceção de fn_billing_limites_validos, 0904): pura, não lê tabela nenhuma, chamada pelo CHECK de quem já tem permissão de escrever a linha, sem revoke/grant explícito.';

alter table public.billing_settings add column if not exists peso_cache_leitura_pct integer not null default 10;
alter table public.billing_settings add column if not exists pesos_por_proposito jsonb not null default '{"embedding_indexar": 0, "embedding_consultar": 0}'::jsonb;
alter table public.billing_settings add column if not exists carteira_desde timestamptz;
alter table public.billing_settings add column if not exists teto_org_tokens_dia bigint;
alter table public.billing_settings add column if not exists teto_conversa_tokens_dia bigint;
alter table public.billing_settings add column if not exists teto_instalacao_tokens_dia bigint;

-- Marca de início da carteira (decisão 5): preenchida UMA vez, nunca
-- sobrescrita (coalesce). A linha única (id = 1) já existe desde a 0905.
update public.billing_settings set carteira_desde = coalesce(carteira_desde, now()) where id = 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_settings_peso_cache_leitura_pct_check') then
    alter table public.billing_settings
      add constraint billing_settings_peso_cache_leitura_pct_check
      check (peso_cache_leitura_pct >= 0 and peso_cache_leitura_pct <= 100);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_settings_pesos_por_proposito_check') then
    alter table public.billing_settings
      add constraint billing_settings_pesos_por_proposito_check
      check (public.fn_billing_pesos_validos(pesos_por_proposito));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_settings_teto_org_tokens_dia_check') then
    alter table public.billing_settings
      add constraint billing_settings_teto_org_tokens_dia_check
      check (teto_org_tokens_dia is null or teto_org_tokens_dia > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_settings_teto_conversa_tokens_dia_check') then
    alter table public.billing_settings
      add constraint billing_settings_teto_conversa_tokens_dia_check
      check (teto_conversa_tokens_dia is null or teto_conversa_tokens_dia > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_settings_teto_instalacao_tokens_dia_check') then
    alter table public.billing_settings
      add constraint billing_settings_teto_instalacao_tokens_dia_check
      check (teto_instalacao_tokens_dia is null or teto_instalacao_tokens_dia > 0);
  end if;
end
$$;

comment on column public.billing_settings.peso_cache_leitura_pct is
  '0906, decisão 1: peso do token lido do cache no cálculo do ponderado (0..100, default 10 = pergunta N3). Parâmetro de fn_billing_tokens_ponderados, nunca lido direto por ela.';
comment on column public.billing_settings.pesos_por_proposito is
  '0906, decisão 2: peso por propósito de IA (jsonb, chave aberta, valor 0..100; ausente = 100, decisão 1). Embedding nasce com peso 0 (N16): custa uma fração do token de modelo, e indexar uma base grande não pode comer metade do mês do cliente.';
comment on column public.billing_settings.carteira_desde is
  '0906, decisão 5: quando a carteira passou a valer para esta instalação. Preenchida UMA vez (coalesce) por esta migration; o gatilho e o conferidor da Tarefa 2a ignoram chamada com created_at anterior a esta marca.';
comment on column public.billing_settings.teto_org_tokens_dia is
  '0906, decisão 15 (N14): teto de segurança por organização por dia, em token ponderado. Nulo = desligado (padrão). Nesta fase só avisa, nunca bloqueia.';
comment on column public.billing_settings.teto_conversa_tokens_dia is
  '0906, decisão 15 (N14): teto de segurança por conversa (contact_id) por dia. Nulo = desligado (padrão). Nesta fase só avisa.';
comment on column public.billing_settings.teto_instalacao_tokens_dia is
  '0906, decisão 15 (N14): teto de segurança da INSTALAÇÃO inteira por dia, conferido só pelo conferidor de cron (nunca dentro do gatilho, que serializaria todas as organizações). Nulo = desligado.';

-- ============================================================================
-- 1b. billing_settings.pesos_alterados_em: revisão da fase (23/09/2026, item
-- 3), adiantada para AQUI (antes da Parte 4 usar a coluna em
-- fn_billing_debitos_pendentes, mais abaixo neste mesmo arquivo: a coluna
-- tem que existir antes de qualquer função que a referencie, o arquivo roda
-- de cima para baixo numa aplicação só). Gatilho BEFORE UPDATE que marca
-- now() só quando peso_cache_leitura_pct ou pesos_por_proposito muda de
-- verdade (IS DISTINCT FROM, cobre NULL): um UPDATE que só mexe noutra
-- coluna de billing_settings não pode empurrar esta marca para a frente à
-- toa, ou o pendente (item 3, Parte 4) perdoaria 35 dias de chamada sem
-- motivo.
-- ============================================================================
alter table public.billing_settings add column if not exists pesos_alterados_em timestamptz;

comment on column public.billing_settings.pesos_alterados_em is
  '0906, item 3 da revisão (23/09/2026): quando peso_cache_leitura_pct ou pesos_por_proposito mudou pela última vez, gravado pelo gatilho fn_billing_trg_pesos_alterados. fn_billing_debitos_pendentes (Parte 4) nunca recalcula chamada anterior a esta marca: o peso vigente NO MOMENTO da chamada era outro, e recalcular com o peso de hoje cobraria (ou perdoaria) histórico que a chamada nunca deveria ter gerado.';

create or replace function public.fn_billing_trg_pesos_alterados()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.peso_cache_leitura_pct is distinct from old.peso_cache_leitura_pct
    or new.pesos_por_proposito is distinct from old.pesos_por_proposito
  then
    new.pesos_alterados_em := now();
  end if;
  return new;
end;
$$;

comment on function public.fn_billing_trg_pesos_alterados() is
  '0906, item 3 da revisão: gatilho BEFORE UPDATE em billing_settings que grava pesos_alterados_em = now() só quando peso_cache_leitura_pct ou pesos_por_proposito muda de verdade (IS DISTINCT FROM, cobre NULL). Independente de trg_billing_settings_updated_at (0904, fn_set_updated_at): Postgres roda os dois gatilhos BEFORE UPDATE da tabela, cada um mexendo na sua própria coluna.';

drop trigger if exists trg_billing_settings_pesos_alterados on public.billing_settings;
create trigger trg_billing_settings_pesos_alterados
  before update on public.billing_settings
  for each row execute function public.fn_billing_trg_pesos_alterados();

revoke execute on function public.fn_billing_trg_pesos_alterados() from public, anon, authenticated;
grant execute on function public.fn_billing_trg_pesos_alterados() to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_trg_pesos_alterados() from agent_worker';
  end if;
end
$$;

-- ============================================================================
-- 2. llm_calls.origem_da_chave: só consome carteira o que é pago pela Hiperbold.
-- ============================================================================
--
-- Decisão 3: coluna nova (nula), gravada nos pontos que conhecem a origem.
-- Debita só 'chave_da_instalacao'; nulo (histórico, ponto que não sabe) NÃO
-- debita: é a leitura que não cobra do cliente por engano.
alter table public.llm_calls add column if not exists origem_da_chave text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'llm_calls_origem_da_chave_check') then
    alter table public.llm_calls
      add constraint llm_calls_origem_da_chave_check
      check (origem_da_chave is null or origem_da_chave in ('chave_da_instalacao', 'credencial_da_organizacao'));
  end if;
end
$$;

comment on column public.llm_calls.origem_da_chave is
  '0906, decisão 3: de QUEM é a chave desta chamada: ''chave_da_instalacao'' (a Hiperbold paga) ou ''credencial_da_organizacao'' (a empresa paga com a própria chave BYOK). Nulo = ponto do código que ainda não grava a origem (histórico ou lacuna declarada). Só ''chave_da_instalacao'' debita a carteira (N17): consumo com a chave da própria organização fica de fora, por decisão do plano mestre 6.7.';

-- ============================================================================
-- 3. billing_token_ledger: o livro-caixa, só de acréscimo (decisões 6, 7).
-- ============================================================================
create table if not exists public.billing_token_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fonte text not null,
  -- Token PONDERADO (bigint sempre; nunca numeric de ponto flutuante).
  -- Positivo = entrada (concessão, crédito, ajuste a favor); negativo =
  -- saída (consumo, ajuste a débito).
  tokens bigint not null,
  -- Único por organização (decisão 6): 'plano:<ciclo>', 'adicional:<id>:<ciclo>',
  -- 'consumo:<llm_call_id>:<fonte>', 'credito:<uuid>', 'ajuste:<uuid>'. O
  -- formato é convenção de quem escreve (Tarefa 2a/4); o banco só garante a
  -- unicidade, que é o que faz o "insert ... on conflict do nothing" (decisão
  -- 6) nunca duplicar uma concessão ou um consumo da mesma chamada.
  chave text not null,
  -- SEM chave estrangeira, de propósito (decisão 7): uma FK com "on delete
  -- set null" viraria UPDATE numa tabela sem UPDATE nenhum; sem ação de
  -- borda, travaria apagar a linha de origem (a chamada de IA, o usuário).
  llm_call_id uuid,
  criado_por uuid,
  -- Nunca apagada (decisão 7): o formulário de crédito avisa para não pôr
  -- dado pessoal aqui.
  nota text,
  -- Valor em reais recebido, quando houver (decisão 16), para o painel de
  -- margem. Nulo na maioria das linhas (concessão de plano não tem valor
  -- próprio, o preço já está no contrato).
  valor_cents bigint,
  created_at timestamptz not null default now(),
  constraint billing_token_ledger_fonte_check check (fonte in ('plano', 'adicional', 'avulso')),
  constraint billing_token_ledger_org_chave_unique unique (organization_id, chave)
);

comment on table public.billing_token_ledger is
  '0906, decisões 6 e 7: livro-caixa da carteira de tokens, SÓ DE ACRÉSCIMO. Toda concessão, crédito, ajuste e consumo vira linha; nenhum saldo muda sem linha. Ninguém tem update, delete nem truncate, nem o service_role (ver grants), e não há gatilho BEFORE UPDATE/DELETE: a exclusão em cascata da organização funciona porque a ação referencial roda como dono da tabela.';

create index if not exists billing_token_ledger_llm_call_id_idx
  on public.billing_token_ledger (llm_call_id);
create index if not exists billing_token_ledger_org_idx
  on public.billing_token_ledger (organization_id, created_at desc);

-- ============================================================================
-- 4. billing_token_wallets: o saldo MATERIALIZADO (decisão 8).
-- ============================================================================
create table if not exists public.billing_token_wallets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fonte text not null,
  -- Nulo só para 'avulso' (decisão 6: pacote avulso não tem ciclo, N13: não
  -- vence). 'plano' e 'adicional' sempre têm ciclo (primeiro dia do mês).
  ciclo date,
  creditado bigint not null default 0,
  consumido bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_token_wallets_fonte_check check (fonte in ('plano', 'adicional', 'avulso')),
  constraint billing_token_wallets_creditado_nao_negativo check (creditado >= 0),
  constraint billing_token_wallets_consumido_nao_negativo check (consumido >= 0),
  -- Postgres 15.8: nulls not distinct trata os nulos de `ciclo` (linha de
  -- avulso) como iguais entre si, então só pode existir UMA linha de avulso
  -- por organização; sem isso, "nulo é sempre distinto de nulo" deixaria
  -- nascer uma linha de saldo avulso por consumo, nunca reaproveitada.
  constraint billing_token_wallets_org_fonte_ciclo_unique unique nulls not distinct (organization_id, fonte, ciclo)
);

comment on table public.billing_token_wallets is
  '0906, decisão 8: saldo MATERIALIZADO por organização, fonte e ciclo (avulso com ciclo nulo). creditado e consumido são alterados na MESMA transação da linha do livro-caixa que os explica (Tarefa 2a); o conferidor diário recalcula do livro-caixa e corrige divergência. Saldo disponível (creditado - consumido) pode ficar negativo sem travar nada nesta fase (decisão 15).';

drop trigger if exists trg_billing_token_wallets_updated_at on public.billing_token_wallets;
create trigger trg_billing_token_wallets_updated_at
  before update on public.billing_token_wallets
  for each row execute function public.fn_set_updated_at();

-- ============================================================================
-- 5. billing_token_adicionais: assinatura mensal a mais, por cima do plano.
-- ============================================================================
--
-- Decisão 6: fonte "adicional" é concedida todo ciclo e não acumula. Esta
-- tabela é o CATÁLOGO das contratações ativas (o que fn_billing_garantir_
-- concessoes, Tarefa 2a, lê para saber quanto conceder); a concessão em si
-- vira linha no livro-caixa. Escrita só por fn_billing_contratar_adicional /
-- cancelar (decisão 16, Tarefa 4); nesta parte 1 só a tabela nasce.
create table if not exists public.billing_token_adicionais (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tokens_por_ciclo bigint not null,
  ativo boolean not null default true,
  -- Valor em reais recebido, quando houver (decisão 16), para o painel de margem.
  valor_cents bigint,
  nota text,
  criado_por uuid,
  created_at timestamptz not null default now(),
  cancelado_em timestamptz,
  constraint billing_token_adicionais_tokens_positivo check (tokens_por_ciclo > 0)
);

comment on table public.billing_token_adicionais is
  '0906, decisões 6 e 16: contratações ativas da fonte "adicional" (assinatura mensal a mais, concedida todo ciclo, não acumula). criado_por SEM chave estrangeira, mesmo racional do livro-caixa (decisão 7). Escrita pelas funções da Tarefa 4 (fn_billing_contratar_adicional e cancelar); esta migration só cria a tabela.';

create index if not exists billing_token_adicionais_org_idx
  on public.billing_token_adicionais (organization_id) where ativo;

-- ============================================================================
-- 6. billing_token_consumo_diario: o agregado que o extrato lê (decisão 13).
-- ============================================================================
create table if not exists public.billing_token_consumo_diario (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  dia date not null,
  -- SEM FK em cascata para agente nem contato (decisão 13): apagar um
  -- agente não pode apagar o histórico de consumo, e contact_id aqui é só
  -- chave de agrupamento para o teto por conversa (decisão 15), não um
  -- vínculo que precise sobreviver ao contato.
  agent_id uuid,
  contact_id uuid,
  purpose text not null,
  tokens_ponderados bigint not null default 0,
  tokens_entrada bigint not null default 0,
  tokens_saida bigint not null default 0,
  tokens_cache_lido bigint not null default 0,
  chamadas bigint not null default 0,
  -- Soma de llm_calls.cost_cents CONHECIDO (nunca inventa valor para chamada
  -- com custo nulo, D-050) e a contagem de quantas chamadas do dia tinham
  -- custo nulo: as duas juntas dizem ao painel de margem (decisão 17) que
  -- fração do dia é estimativa. numeric e não bigint: modelo barato custa
  -- fração de centavo por chamada (o GPT-5.6 Luna sai perto de 0,03 centavo
  -- numa resposta de 1.000 tokens), e arredondar cada chamada para inteiro
  -- zeraria o custo do dia inteiro.
  cost_cents_conhecido numeric(14,4) not null default 0,
  chamadas_custo_nulo bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_token_consumo_diario_unique
    unique nulls not distinct (organization_id, dia, agent_id, contact_id, purpose)
);

-- Banco que criou a coluna como bigint antes da correção (só o local, a 0906
-- não foi para produção): converte no lugar. Sem efeito quando já é numeric.
--
-- Item 7 da revisão (23/09/2026): sem a guarda abaixo, este ALTER pegava
-- ACCESS EXCLUSIVE em billing_token_consumo_diario TODA VEZ que o apêndice
-- é reaplicado em produção (update.sh reaplica o baseline inteiro), mesmo
-- quando o tipo já é numeric. Só altera quando o tipo ATUAL não é numeric.
do $$
begin
  if (
    select data_type from information_schema.columns
    where table_schema = 'public'
      and table_name = 'billing_token_consumo_diario'
      and column_name = 'cost_cents_conhecido'
  ) <> 'numeric' then
    alter table public.billing_token_consumo_diario
      alter column cost_cents_conhecido type numeric(14,4);
  end if;
end
$$;

comment on table public.billing_token_consumo_diario is
  '0906, decisão 13: agregado diário que o extrato lê (organização, dia, agente, contato, propósito). Atualizado DENTRO do débito (Tarefa 2a), só quando a linha do livro-caixa entrou de fato. unique nulls not distinct trata agent_id/contact_id nulos como iguais entre si, para o agregado de uma chamada auxiliar sem agente nem contato não duplicar linha a cada chamada do dia.';

-- Índice para o teto por conversa por dia (decisão 15): soma do agregado por
-- (organização, dia, contact_id).
create index if not exists billing_token_consumo_diario_org_dia_contato_idx
  on public.billing_token_consumo_diario (organization_id, dia, contact_id);

drop trigger if exists trg_billing_token_consumo_diario_updated_at on public.billing_token_consumo_diario;
create trigger trg_billing_token_consumo_diario_updated_at
  before update on public.billing_token_consumo_diario
  for each row execute function public.fn_set_updated_at();

-- ============================================================================
-- 7. RLS e grants das quatro tabelas (decisão 19).
-- ============================================================================
alter table public.billing_token_ledger enable row level security;
alter table public.billing_token_wallets enable row level security;
alter table public.billing_token_adicionais enable row level security;
alter table public.billing_token_consumo_diario enable row level security;

revoke all on
  public.billing_token_ledger,
  public.billing_token_wallets,
  public.billing_token_adicionais,
  public.billing_token_consumo_diario
  from anon, authenticated;

-- Carteira (saldo) e agregado (extrato): gerente para cima da própria
-- organização, ou admin da plataforma, mesma régua de "Plano e uso" (0905).
grant select on public.billing_token_wallets, public.billing_token_consumo_diario to authenticated;

drop policy if exists billing_token_wallets_select on public.billing_token_wallets;
create policy billing_token_wallets_select on public.billing_token_wallets
  for select using (
    public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin()
  );

drop policy if exists billing_token_consumo_diario_select on public.billing_token_consumo_diario;
create policy billing_token_consumo_diario_select on public.billing_token_consumo_diario
  for select using (
    public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin()
  );

-- Livro-caixa e adicionais: privilégio NENHUM para authenticated (decisão
-- 19), só a plataforma, pelo servidor com service_role. Nenhuma policy
-- para authenticated nas duas.
grant all on public.billing_token_wallets, public.billing_token_adicionais, public.billing_token_consumo_diario to service_role;

-- Livro-caixa: só select e insert, para QUALQUER escritor, inclusive
-- service_role (decisão 7 e 6). Sem update/delete/truncate, o gatilho de
-- exclusão em cascata da organização (on delete cascade em organization_id)
-- continua funcionando porque a ação referencial roda como DONO da tabela,
-- não com o privilégio do papel que disparou o DELETE.
grant select, insert on public.billing_token_ledger to service_role;
revoke update, delete, truncate on public.billing_token_ledger from service_role;

-- ============================================================================
-- 8. fn_billing_ciclo_de e fn_billing_tokens_ponderados (decisões 1 e 4).
-- ============================================================================

-- fn_billing_ciclo_de: primeiro dia do mês civil no fuso America/Sao_Paulo.
-- STABLE, não IMMUTABLE: a conversão "at time zone" por NOME depende da base
-- de fuso horário do sistema (pg_timezone_names), que pode mudar numa
-- atualização do Postgres/SO; IMMUTABLE prometeria um resultado que nunca
-- muda nem entre versões, o que não é verdade aqui.
create or replace function public.fn_billing_ciclo_de(p_momento timestamptz)
returns date
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select date_trunc('month', p_momento at time zone 'America/Sao_Paulo')::date
$$;

comment on function public.fn_billing_ciclo_de(timestamptz) is
  '0906, decisão 4: primeiro dia do mês civil no fuso America/Sao_Paulo, sempre calculado do momento da CHAMADA (llm_calls.created_at), nunca de now(). O orçamento do autor usa mês UTC; aqui o extrato não pode virar o mês às 21h do último dia. STABLE (não IMMUTABLE): depende da base de fuso horário do sistema.';

revoke execute on function public.fn_billing_ciclo_de(timestamptz) from public, anon, authenticated;
grant execute on function public.fn_billing_ciclo_de(timestamptz) to service_role;

-- fn_billing_tokens_ponderados: a fórmula exata da decisão 1. IMMUTABLE:
-- pura aritmética sobre os argumentos, sem tabela nem fuso horário.
create or replace function public.fn_billing_tokens_ponderados(
  p_input int,
  p_output int,
  p_cache_read int,
  p_peso_cache int,
  p_peso_proposito int
)
returns bigint
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select ceil(
    (
      greatest(p_input - p_cache_read, 0)
      + p_output
      + (p_cache_read::numeric * p_peso_cache::numeric / 100)
    )
    * p_peso_proposito::numeric / 100
  )::bigint
$$;

comment on function public.fn_billing_tokens_ponderados(int, int, int, int, int) is
  '0906, decisão 1: ponderado = ceil((max(input - cache_read, 0) + output + cache_read * peso_cache / 100) * peso_proposito / 100), sempre bigint. Os pesos entram como PARÂMETRO (nunca lidos de billing_settings por esta função): quem chama lê a configuração vigente no momento do débito e grava o resultado na linha do livro-caixa; trocar o peso no meio do ciclo não recalcula o passado. Ponderado zero não gera linha (decisão 1, aplicado por quem chama).';

revoke execute on function public.fn_billing_tokens_ponderados(int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.fn_billing_tokens_ponderados(int, int, int, int, int) to service_role;

-- ============================================================================
-- 9. agent_worker não escreve nem confere carteira pelas peças novas desta
-- parte 1 (mesmo racional dos blocos análogos da 0904/0905): por alter
-- default privileges ela ganharia escrita em toda tabela nova e execute em
-- toda função nova do schema public, e tem bypassrls.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke insert, update, delete, truncate on public.billing_token_ledger, public.billing_token_wallets, public.billing_token_adicionais, public.billing_token_consumo_diario from agent_worker';
    execute 'revoke execute on function public.fn_billing_ciclo_de(timestamptz), public.fn_billing_tokens_ponderados(int, int, int, int, int) from agent_worker';
  end if;
end
$$;

-- ── Parte 2 (Tarefa 2a): concessão, débito e gatilho ──
--
-- A parte 1 (acima) trouxe configuração, tabelas e as duas funções puras de
-- cálculo. Esta parte 2 traz quem de fato CONCEDE e DEBITA:
-- fn_billing_garantir_concessoes (decisão 9), fn_billing_debitar_chamada (a
-- peça única de débito, decisão 10), o gatilho after insert em llm_calls que
-- a chama (decisão 11), e o agregado diário (decisão 13), atualizado DENTRO
-- do débito. Avisos (50/80/100%) e as três travas de segurança são a Tarefa
-- 2b, ainda NÃO estão nesta parte.
--
-- fn_billing_garantir_concessoes NÃO trava sozinha: quem chama (o débito,
-- abaixo, ou a RPC de leitura de saldo da Tarefa 5) já está sob
-- pg_try_advisory_xact_lock('billing_tokens:<org>'). Chamá-la duas vezes no
-- mesmo ciclo não duplica nada: a concessão em si é "insert ... on conflict
-- do nothing" pela chave única (organization_id, chave) do livro-caixa, e só
-- quando o insert entra de fato é que billing_token_wallets.creditado soma
-- (decisão 9). Nunca concede para ciclo que já fechou (comparação com
-- fn_billing_ciclo_de(now()), não com o ciclo da chamada): a guarda mora
-- DENTRO desta função porque ela nasce pensada para mais de um chamador.
--
-- fn_billing_debitar_chamada é a ÚNICA função de débito (decisão 10), usada
-- pelo gatilho abaixo e, na Tarefa 8, pelo conferidor. Sai sem fazer nada
-- (sem travar, sem contar) quando: a chamada tem legacy_invocation_id
-- (histórico copiado, decisão 5), a origem da chave não é
-- 'chave_da_instalacao' (nula ou credencial_da_organizacao, decisão 3/N17),
-- created_at é anterior a billing_settings.carteira_desde (decisão 5), ou o
-- ponderado calculado é zero (decisão 1). Ciclo e dia são SEMPRE calculados
-- de llm_calls.created_at, nunca de now() (decisão 4). A trava é
-- pg_try_advisory_xact_lock (NÃO pg_advisory_xact_lock): se outra sessão já
-- segura a mesma organização, sai imediatamente com false, sem esperar; o
-- conferidor da Tarefa 8 pega essa chamada depois. Sob a trava, garante a
-- concessão do ciclo da chamada e divide o ponderado pelas três fontes, na
-- ordem plano, adicional, avulso, pelo saldo (creditado - consumido, nunca
-- negativo na conta, embora o saldo ARMAZENADO possa ficar negativo,
-- decisão 15) de cada uma; o que sobra depois de zerar as três é SOMADO na
-- linha de plano da mesma chamada (decisão 6): nunca uma quarta linha, nunca
-- duas linhas de plano. No Ilimitado (sem concessão nenhuma, saldo de plano
-- sempre zero) isso faz o ponderado inteiro cair em plano, e a chamada fica
-- registrada mesmo sem teto (decisão 9). Cada fonte escreve no máximo UMA
-- linha no livro-caixa por chamada, com chave
-- 'consumo:<llm_call_id>:<fonte>' e "on conflict do nothing": chamar esta
-- função de novo para a MESMA chamada não gera nenhuma linha nova (todas
-- colidem pela chave), billing_token_wallets.consumido só soma quando o
-- insert do livro-caixa entra de fato, e o retorno (v_entrou) é
-- exatamente esse "debitou AGORA": true na primeira vez, false num reenvio.
-- billing_token_consumo_diario só é atualizado quando ALGUMA linha de
-- consumo entrou (decisão 13), uma vez só por chamada, com o ponderado
-- TOTAL (não fatiado por fonte) e os brutos (input/output/cache) crus da
-- chamada.
--
-- O gatilho (fn_billing_trg_debitar_chamada, after insert on llm_calls)
-- nunca derruba o insert (decisão 11): corpo inteiro dentro de
-- "begin ... exception when others then raise warning ...; return null;
-- end", e "set lock_timeout = '1s'" no próprio create function (não vaza
-- para a transação de quem inseriu a chamada), para qualquer espera de
-- linha (por exemplo em billing_token_wallets, sob concorrência) virar erro
-- capturável muito antes do statement_timeout de 8s de authenticator, que
-- não é capturável e apagaria a própria linha de llm_calls que o fornecedor
-- de IA já cobrou.
--
-- Idempotente: create or replace, drop trigger if exists antes de recriar.

-- A1 (auditoria de segurança, 23/09/2026, defesa em profundidade item 2):
-- billing_token_ledger.ciclo precisa existir ANTES de fn_billing_debitar_
-- chamada, logo abaixo, gravar nela nas três linhas de CONSUMO (a versão
-- original desta migration só criava esta coluna na Parte 4, item 17, para
-- fn_billing_ajustar_tokens; adiantada aqui, de propósito, para o débito
-- também gravar o ciclo da chamada em toda linha de consumo, sem depender de
-- llm_calls continuar viva para o conferidor de carteira recalcular
-- consumido). add column if not exists é idempotente com o item 17 da Parte
-- 4, mais abaixo, que continua intacto (a mesma instrução ali não faz nada
-- quando a coluna já existe).
alter table public.billing_token_ledger add column if not exists ciclo date;

-- ============================================================================
-- 10. fn_billing_garantir_concessoes: concessão preguiçosa e idempotente
-- (decisão 9).
-- ============================================================================
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
  '0906, decisão 9: concessão preguiçosa e idempotente da fonte plano (teto efetivo do momento) e de cada adicional ativo, para o ciclo informado. NÃO trava sozinha: quem chama (fn_billing_debitar_chamada, abaixo, ou a RPC de saldo da Tarefa 5) já precisa estar sob pg_try_advisory_xact_lock(''billing_tokens:<org>''). insert ... on conflict do nothing no livro-caixa; billing_token_wallets.creditado só soma quando o insert entrou de fato. Ilimitado (tokens_ia_mes nulo) não concede nada. Nunca concede para ciclo anterior ao ciclo atual (fn_billing_ciclo_de(now())).';

revoke execute on function public.fn_billing_garantir_concessoes(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_garantir_concessoes(uuid, date) to service_role;

-- ============================================================================
-- 11. fn_billing_debitar_chamada: a peça única de débito (decisão 10).
-- ============================================================================
create or replace function public.fn_billing_debitar_chamada(p_llm_call_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_chamada record;
  v_settings record;
  v_peso_proposito int;
  v_ponderado bigint;
  v_ciclo date;
  v_dia date;
  v_restante bigint;
  v_saldo bigint;
  v_teto_efetivo bigint;
  v_debito_plano bigint := 0;
  v_debito_adicional bigint := 0;
  v_debito_avulso bigint := 0;
  v_linhas int;
  v_entrou boolean := false;
begin
  select c.organization_id, c.created_at, c.legacy_invocation_id, c.origem_da_chave,
         c.purpose, c.agent_id, c.contact_id, c.input_tokens, c.output_tokens,
         c.cache_read_tokens, c.cost_cents
    into v_chamada
    from public.llm_calls c
    where c.id = p_llm_call_id;

  if not found then
    return false;
  end if;

  -- Decisão 5: histórico copiado nunca debita.
  if v_chamada.legacy_invocation_id is not null then
    return false;
  end if;

  -- Decisão 3/N17: só a chave da instalação passa pela carteira. Nulo
  -- (ponto do código que ainda não grava a origem) e credencial_da_organizacao
  -- (BYOK, o cliente já paga direto) saem sem debitar.
  if v_chamada.origem_da_chave is distinct from 'chave_da_instalacao' then
    return false;
  end if;

  select carteira_desde, peso_cache_leitura_pct, pesos_por_proposito
    into v_settings
    from public.billing_settings
    where id = 1;

  -- Decisão 5: marca de início. Sem isso a primeira noite do conferidor
  -- (Tarefa 8) cobraria de uma vez todo o histórico anterior à carteira.
  if v_chamada.created_at < v_settings.carteira_desde then
    return false;
  end if;

  v_peso_proposito := coalesce((v_settings.pesos_por_proposito ->> v_chamada.purpose)::int, 100);

  v_ponderado := public.fn_billing_tokens_ponderados(
    v_chamada.input_tokens,
    v_chamada.output_tokens,
    v_chamada.cache_read_tokens,
    v_settings.peso_cache_leitura_pct,
    v_peso_proposito
  );

  -- Decisão 1: ponderado zero não gera linha nenhuma.
  if v_ponderado = 0 then
    return false;
  end if;

  -- Decisão 4: ciclo e dia SEMPRE do momento da CHAMADA, nunca de now().
  v_ciclo := public.fn_billing_ciclo_de(v_chamada.created_at);
  v_dia := (v_chamada.created_at at time zone 'America/Sao_Paulo')::date;

  -- Decisão 10/11: trava SEM espera, por organização. Se outra sessão já
  -- segura, sai já (o conferidor da Tarefa 8 pega depois); nunca atrasa
  -- quem inseriu a chamada.
  if not pg_try_advisory_xact_lock(hashtextextended('billing_tokens:' || v_chamada.organization_id::text, 0)) then
    return false;
  end if;

  -- M1 (auditoria de segurança, 23/09/2026): idempotência de verdade, logo
  -- depois de pegar a trava. As chaves 'consumo:<id>:<fonte>' só travam
  -- reenvio da MESMA fonte; se entre duas execuções desta função um crédito
  -- avulso mudar a divisão entre fontes (decisão 6), a segunda execução
  -- gravava uma linha de fonte NOVA para a MESMA chamada, debitando duas
  -- vezes o total (30.000 viravam 31.000, medido). Uma chamada já debitada
  -- (QUALQUER linha 'consumo:%' dela no livro-caixa) nunca é debitada de
  -- novo, ponto final.
  if exists (
    select 1 from public.billing_token_ledger
    where organization_id = v_chamada.organization_id and llm_call_id = p_llm_call_id
  ) then
    return false;
  end if;

  -- Já sob a trava: garante a concessão do ciclo DA CHAMADA (fn_billing_
  -- garantir_concessoes não faz nada sozinha se esse ciclo já fechou).
  perform public.fn_billing_garantir_concessoes(v_chamada.organization_id, v_ciclo);

  -- Item 4 da revisão (23/09/2026): Ilimitado (teto efetivo nulo) não pode
  -- consumir adicional nem avulso, mesmo que a organização tenha saldo de
  -- sobra nessas duas fontes (por exemplo, um pacote avulso comprado antes
  -- de virar Ilimitado): o ponderado inteiro cai direto em plano, sem
  -- fatiar. Sem este desvio, uma organização Ilimitada com avulso sobrando
  -- via aquele saldo escoar antes de "sem limite" fazer sentido de verdade.
  v_teto_efetivo := (public.fn_billing_limites_efetivos(v_chamada.organization_id) ->> 'tokens_ia_mes')::bigint;

  if v_teto_efetivo is null then
    v_debito_plano := v_ponderado;
  else
    -- Decisão 6: divide pelas fontes, nesta ordem, pelo saldo (creditado -
    -- consumido) de cada uma. sum() garante uma linha sempre (mesmo sem
    -- wallet ainda criada, vira 0 pelo coalesce) em vez de "select" simples,
    -- que sobre zero linhas deixaria a variável com o valor da fonte anterior.
    select coalesce(sum(creditado - consumido), 0) into v_saldo
      from public.billing_token_wallets
      where organization_id = v_chamada.organization_id and fonte = 'plano' and ciclo = v_ciclo;
    v_restante := v_ponderado;
    v_debito_plano := least(v_restante, greatest(v_saldo, 0));
    v_restante := v_restante - v_debito_plano;

    select coalesce(sum(creditado - consumido), 0) into v_saldo
      from public.billing_token_wallets
      where organization_id = v_chamada.organization_id and fonte = 'adicional' and ciclo = v_ciclo;
    v_debito_adicional := least(v_restante, greatest(v_saldo, 0));
    v_restante := v_restante - v_debito_adicional;

    select coalesce(sum(creditado - consumido), 0) into v_saldo
      from public.billing_token_wallets
      where organization_id = v_chamada.organization_id and fonte = 'avulso' and ciclo is null;
    v_debito_avulso := least(v_restante, greatest(v_saldo, 0));
    v_restante := v_restante - v_debito_avulso;

    -- O que sobra depois de zerar as três vai SOMADO na linha de plano
    -- (decisão 6): nunca uma quarta linha, nunca duas linhas de plano na
    -- mesma chamada. É o caso que atravessa o fim do saldo.
    v_debito_plano := v_debito_plano + v_restante;
  end if;

  if v_debito_plano > 0 then
    -- A1 (auditoria de segurança, item 2, defesa em profundidade): grava o
    -- ciclo DA CHAMADA também na linha de CONSUMO, não só na de concessão
    -- (que já carrega o ciclo na chave). fn_billing_conferir_carteira (Parte
    -- 4, abaixo) passa a recalcular consumido por esta coluna, sem depender
    -- de llm_calls continuar viva nem gravável por ninguém além de
    -- service_role.
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id, ciclo)
    values (v_chamada.organization_id, 'plano', -v_debito_plano, 'consumo:' || p_llm_call_id::text || ':plano', p_llm_call_id, v_ciclo)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      v_entrou := true;
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (v_chamada.organization_id, 'plano', v_ciclo, 0, v_debito_plano)
      on conflict (organization_id, fonte, ciclo) do update
        set consumido = public.billing_token_wallets.consumido + excluded.consumido,
            updated_at = now();
    end if;
  end if;

  if v_debito_adicional > 0 then
    -- A1, item 2 (defesa em profundidade): mesmo racional do bloco de plano,
    -- acima.
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id, ciclo)
    values (v_chamada.organization_id, 'adicional', -v_debito_adicional, 'consumo:' || p_llm_call_id::text || ':adicional', p_llm_call_id, v_ciclo)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      v_entrou := true;
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (v_chamada.organization_id, 'adicional', v_ciclo, 0, v_debito_adicional)
      on conflict (organization_id, fonte, ciclo) do update
        set consumido = public.billing_token_wallets.consumido + excluded.consumido,
            updated_at = now();
    end if;
  end if;

  if v_debito_avulso > 0 then
    -- A1, item 2 (defesa em profundidade): a linha de consumo também grava
    -- o ciclo da chamada, informativo (a carteira avulso não usa ciclo,
    -- decisão 6/N13: fn_billing_conferir_carteira, abaixo, ignora esta
    -- coluna para a fonte avulso e soma a fonte inteira, como já fazia).
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id, ciclo)
    values (v_chamada.organization_id, 'avulso', -v_debito_avulso, 'consumo:' || p_llm_call_id::text || ':avulso', p_llm_call_id, v_ciclo)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      v_entrou := true;
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (v_chamada.organization_id, 'avulso', null, 0, v_debito_avulso)
      on conflict (organization_id, fonte, ciclo) do update
        set consumido = public.billing_token_wallets.consumido + excluded.consumido,
            updated_at = now();
    end if;
  end if;

  -- Decisão 13: o agregado só muda quando ALGUMA linha de consumo entrou de
  -- fato, uma vez por chamada, com o ponderado TOTAL (não fatiado por fonte)
  -- e os brutos crus da chamada.
  if v_entrou then
    insert into public.billing_token_consumo_diario (
      organization_id, dia, agent_id, contact_id, purpose,
      tokens_ponderados, tokens_entrada, tokens_saida, tokens_cache_lido,
      chamadas, cost_cents_conhecido, chamadas_custo_nulo
    )
    values (
      v_chamada.organization_id, v_dia, v_chamada.agent_id, v_chamada.contact_id, v_chamada.purpose,
      v_ponderado, v_chamada.input_tokens, v_chamada.output_tokens, v_chamada.cache_read_tokens,
      1, coalesce(v_chamada.cost_cents, 0), case when v_chamada.cost_cents is null then 1 else 0 end
    )
    on conflict (organization_id, dia, agent_id, contact_id, purpose) do update
      set tokens_ponderados = public.billing_token_consumo_diario.tokens_ponderados + excluded.tokens_ponderados,
          tokens_entrada = public.billing_token_consumo_diario.tokens_entrada + excluded.tokens_entrada,
          tokens_saida = public.billing_token_consumo_diario.tokens_saida + excluded.tokens_saida,
          tokens_cache_lido = public.billing_token_consumo_diario.tokens_cache_lido + excluded.tokens_cache_lido,
          chamadas = public.billing_token_consumo_diario.chamadas + excluded.chamadas,
          cost_cents_conhecido = public.billing_token_consumo_diario.cost_cents_conhecido + excluded.cost_cents_conhecido,
          chamadas_custo_nulo = public.billing_token_consumo_diario.chamadas_custo_nulo + excluded.chamadas_custo_nulo,
          updated_at = now();
  end if;

  -- Tarefa 2b (decisões 14 e 15): avisos de limiar (50/80/100%) e travas de
  -- segurança por organização e por conversa, só quando ALGUMA linha de
  -- consumo entrou de fato E o ciclo DA CHAMADA é o ciclo ATUAL: débito
  -- tardio de um ciclo já fechado (o conferidor da Tarefa 8) nunca avisa.
  -- Já dentro da MESMA advisory lock da organização que este débito segura
  -- (item 10, acima); fn_billing_avisar_carteira (Parte 3, fim deste
  -- arquivo) nunca lança (captura o próprio erro), então uma falha ali nunca
  -- derruba este débito.
  if v_entrou and v_ciclo = public.fn_billing_ciclo_de(now()) then
    perform public.fn_billing_avisar_carteira(v_chamada.organization_id, v_ciclo, v_dia, v_chamada.contact_id);
  end if;

  return v_entrou;
end;
$$;

comment on function public.fn_billing_debitar_chamada(uuid) is
  '0906, decisão 10: peça ÚNICA de débito, usada pelo gatilho (abaixo) e pelo conferidor (Tarefa 8). Devolve true só quando debitou AGORA (pelo menos uma linha nova no livro-caixa); reenviar a MESMA chamada devolve false sem mudar livro-caixa, carteira nem agregado (todas as chaves de consumo colidem pelo conflict). Sai sem nada quando legacy_invocation_id não é nulo, origem_da_chave não é chave_da_instalacao, created_at é anterior a carteira_desde, ou o ponderado é zero. Ciclo e dia SEMPRE de created_at da chamada. pg_try_advisory_xact_lock (NUNCA pg_advisory_xact_lock) por organização, sem espera; ocupada = sai, o conferidor pega depois. Garante a concessão do ciclo da chamada já sob a trava, divide o ponderado por plano/adicional/avulso pelo saldo de cada uma, e soma o que sobra na linha de plano (decisão 6, o caso que atravessa o saldo). Tarefa 2b: chama fn_billing_avisar_carteira quando debitou de fato E o ciclo da chamada é o ATUAL (débito tardio de ciclo fechado não avisa).';

revoke execute on function public.fn_billing_debitar_chamada(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_debitar_chamada(uuid) to service_role;

-- ============================================================================
-- 12. Gatilho after insert em llm_calls chamando o débito (decisão 11).
-- ============================================================================
create or replace function public.fn_billing_trg_debitar_chamada()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '1s'
as $$
begin
  perform public.fn_billing_debitar_chamada(new.id);
  return null;
exception
  when others then
    raise warning 'billing_debitar_chamada_falhou: llm_call_id=%, sqlerrm=%', new.id, sqlerrm;
    return null;
end;
$$;

comment on function public.fn_billing_trg_debitar_chamada() is
  '0906, decisão 11: gatilho after insert em llm_calls que chama fn_billing_debitar_chamada. Corpo inteiro dentro de begin...exception when others, nunca derruba o insert (a resposta do agente já foi cobrada pelo fornecedor de IA). set lock_timeout = ''1s'' no próprio create function (restaurado ao sair, não vaza para a transação de quem inseriu a chamada): qualquer espera de linha vira erro capturável muito antes do statement_timeout de 8s de authenticator, que não é capturável.';

revoke execute on function public.fn_billing_trg_debitar_chamada() from public, anon, authenticated;
grant execute on function public.fn_billing_trg_debitar_chamada() to service_role;

drop trigger if exists trg_billing_debitar_llm_call on public.llm_calls;
create trigger trg_billing_debitar_llm_call
  after insert on public.llm_calls
  for each row
  execute function public.fn_billing_trg_debitar_chamada();

-- ============================================================================
-- 13. agent_worker não concede nem debita pelas peças novas desta parte 2
-- (mesmo racional do bloco 9, acima): por alter default privileges ela
-- ganharia execute em toda função nova do schema public, e tem bypassrls.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_garantir_concessoes(uuid, date), public.fn_billing_debitar_chamada(uuid), public.fn_billing_trg_debitar_chamada() from agent_worker';
  end if;
end
$$;

-- ── Parte 3 (Tarefa 2b): avisos de limiar e travas de segurança ──
--
-- As partes 1 e 2 (acima) trouxeram configuração, tabelas, concessão, débito
-- e o agregado diário. Esta parte 3 traz o que FALTAVA em
-- fn_billing_debitar_chamada (decisão 10): os avisos de 50/80/100% do total
-- disponível no ciclo (decisão 14) e as duas travas de segurança que avisam
-- sem bloquear (decisão 15, N14). fn_billing_debitar_chamada (Parte 2,
-- acima) já foi alterada NO LUGAR para chamar fn_billing_avisar_carteira,
-- abaixo, só quando debitou de fato e o ciclo da chamada é o ciclo ATUAL.
--
-- Dedup que sobrevive ao encerramento (decisão 14: "um aviso por limiar por
-- ciclo", nunca "enquanto aberto", diferente do padrão de
-- fn_billing_conferir_teto, 0905, que reabriria o mesmo limiar a cada
-- chamada depois que o membro encerra o aviso). Em vez de embutir a marca no
-- TÍTULO (frágil: exigiria formatar o mês em português só para RE-LER o
-- próprio título depois, e acoplaria o texto do aviso à lógica de dedup),
-- esta parte cria uma tabela pequena e só de acréscimo,
-- billing_token_avisos_emitidos, no MESMO molde do livro-caixa
-- (decisão 6/7): "insert ... on conflict do nothing" por (organização,
-- chave), e o aviso na Central só nasce quando o insert entrou de fato (get
-- diagnostics row_count). chave por caso: 'limiar:<ciclo>:<limiar>' (um por
-- limiar por ciclo, decisão 14), 'teto_org_dia:<dia>' (um por dia, decisão
-- 15) e 'teto_conversa_dia:<dia>:<contact_id>' (um por contato por dia,
-- decisão 15). Nenhuma dessas chaves olha status: resolver o item na Central
-- NÃO libera a chave, e por isso o mesmo limiar/teto nunca reabre sozinho no
-- mesmo ciclo/dia.
--
-- fn_billing_avisar_carteira nunca lança (mesmo molde de
-- fn_billing_conferir_teto, 0905): corpo inteiro sob "exception when others
-- then raise warning", para nunca derrubar o débito que a chama.
--
-- Idempotente: create table if not exists, create or replace, bloco final de
-- agent_worker igual ao das partes 1 e 2.

-- ============================================================================
-- 14. billing_token_avisos_emitidos: dedup dos avisos de carteira que
-- sobrevive ao encerramento (decisões 14 e 15).
-- ============================================================================
create table if not exists public.billing_token_avisos_emitidos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 'limiar:<ciclo>:<limiar>', 'teto_org_dia:<dia>' ou
  -- 'teto_conversa_dia:<dia>:<contact_id>' (convenção de quem escreve,
  -- fn_billing_avisar_carteira, abaixo; o banco só garante a unicidade, que
  -- é o que faz o "insert ... on conflict do nothing" nunca duplicar).
  chave text not null,
  created_at timestamptz not null default now(),
  constraint billing_token_avisos_emitidos_org_chave_unique unique (organization_id, chave)
);

comment on table public.billing_token_avisos_emitidos is
  '0906, Tarefa 2b (decisões 14 e 15): marca de dedup dos avisos de carteira (limiar do ciclo, teto por organização por dia, teto por conversa por dia) que SOBREVIVE ao encerramento do item na Central, diferente da dedup "enquanto status = open" de fn_billing_conferir_teto (0905), que reabriria o mesmo limiar a cada chamada depois que o membro resolve o aviso. Só de acréscimo, sem update nem delete, mesmo racional do livro-caixa (decisão 7).';

alter table public.billing_token_avisos_emitidos enable row level security;

revoke all on public.billing_token_avisos_emitidos from anon, authenticated;
grant select, insert on public.billing_token_avisos_emitidos to service_role;
revoke update, delete, truncate on public.billing_token_avisos_emitidos from service_role;

-- ============================================================================
-- 15. fn_billing_avisar_carteira: avisos de 50/80/100% e travas de segurança
-- (decisões 14 e 15).
-- ============================================================================
create or replace function public.fn_billing_avisar_carteira(
  p_org uuid,
  p_ciclo date,
  p_dia date,
  p_contact_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_teto_org_dia bigint;
  v_teto_conversa_dia bigint;
  v_teto_total bigint;
  v_consumido_ciclo bigint;
  v_teto_efetivo bigint;
  v_avulso_creditado_total bigint;
  v_avulso_consumido_antes bigint;
  v_avulso_consumido_mes bigint;
  v_mes_ano text;
  v_limiar int;
  v_titulo text;
  v_linhas int;
  v_tokens_org_dia bigint;
  v_tokens_conversa_dia bigint;
begin
  select teto_org_tokens_dia, teto_conversa_tokens_dia
    into v_teto_org_dia, v_teto_conversa_dia
    from public.billing_settings
    where id = 1;

  -- Item 4 da revisão (23/09/2026): Ilimitado (teto efetivo nulo) nunca
  -- avisa limiar de porcentagem, mesmo que a organização tenha adicional ou
  -- avulso creditado (que hoje nem são consumidos por ela, ver item 4 em
  -- fn_billing_debitar_chamada).
  v_teto_efetivo := (public.fn_billing_limites_efetivos(p_org) ->> 'tokens_ia_mes')::bigint;

  -- Decisão 14, revisada pelo item 2 (23/09/2026): total DISPONÍVEL no
  -- ciclo é plano + adicional DESTE ciclo mais avulso, mas o avulso entra
  -- pela PROPORÇÃO DO MÊS, não da vida inteira: disponível do avulso =
  -- creditado do avulso (a vida inteira, fonte sem ciclo) MENOS o consumido
  -- do avulso em ciclos ANTERIORES a este (pelo `ciclo` gravado em cada
  -- linha de consumo, correção A1 da auditoria de segurança); consumido do
  -- avulso no mês = só o consumo do avulso com `ciclo` = este ciclo. O saldo
  -- REAL do avulso (o que de fato pode ser debitado) não muda; só a
  -- proporção usada aqui, para o aviso de limiar, passa a ser do mês.
  select coalesce(sum(creditado) filter (where fonte in ('plano', 'adicional')), 0),
         coalesce(sum(consumido) filter (where fonte in ('plano', 'adicional')), 0)
    into v_teto_total, v_consumido_ciclo
    from public.billing_token_wallets
    where organization_id = p_org and fonte in ('plano', 'adicional') and ciclo = p_ciclo;

  select coalesce(creditado, 0) into v_avulso_creditado_total
    from public.billing_token_wallets
    where organization_id = p_org and fonte = 'avulso' and ciclo is null;

  select coalesce(sum(-tokens), 0) into v_avulso_consumido_antes
    from public.billing_token_ledger
    where organization_id = p_org and fonte = 'avulso' and chave like 'consumo:%'
      and ciclo is not null and ciclo < p_ciclo;

  select coalesce(sum(-tokens), 0) into v_avulso_consumido_mes
    from public.billing_token_ledger
    where organization_id = p_org and fonte = 'avulso' and chave like 'consumo:%' and ciclo = p_ciclo;

  v_teto_total := v_teto_total + (coalesce(v_avulso_creditado_total, 0) - v_avulso_consumido_antes);
  v_consumido_ciclo := v_consumido_ciclo + v_avulso_consumido_mes;

  if v_teto_efetivo is not null and v_teto_total > 0 then
    -- Nome do mês em português, sem depender do locale do servidor (to_char
    -- com 'Month' segue o locale do cluster, que pode não ser pt_BR): array
    -- fixo, indexado por extract(month from ...).
    v_mes_ano := (array['janeiro','fevereiro','março','abril','maio','junho','julho',
                         'agosto','setembro','outubro','novembro','dezembro'])[extract(month from p_ciclo)::int]
      || ' de ' || extract(year from p_ciclo)::text;

    foreach v_limiar in array array[50, 80, 100] loop
      -- v_consumido_ciclo/v_teto_total >= v_limiar/100, em bigint, sem ponto
      -- flutuante.
      if v_consumido_ciclo * 100 >= v_teto_total * v_limiar then
        -- Item 8 da revisão: to_char no ciclo (não ::text, ver comentário na
        -- concessão acima); v_limiar é int, ::text não depende de DateStyle.
        insert into public.billing_token_avisos_emitidos (organization_id, chave)
        values (p_org, 'limiar:' || to_char(p_ciclo, 'YYYY-MM-DD') || ':' || v_limiar::text)
        on conflict (organization_id, chave) do nothing;

        get diagnostics v_linhas = row_count;
        if v_linhas > 0 then
          v_titulo := 'Tokens de IA: ' || v_limiar::text || '% do mês usado (' || v_mes_ano || ')';
          insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
          values (
            p_org,
            'other',
            case when v_limiar = 100 then 'critical' else 'warn' end,
            v_titulo,
            case
              when v_limiar = 100 then
                'A organização usou 100% dos tokens de IA disponíveis neste ciclo. Nesta fase o assistente continua respondendo normalmente; veja Configurações › Plano e uso.'
              else
                'A organização já usou ' || v_limiar::text || '% dos tokens de IA disponíveis neste ciclo. Veja Configurações › Plano e uso.'
            end,
            'billing_limite',
            p_org
          );
        end if;
      end if;
    end loop;
  end if;

  -- Decisão 15 (N14): teto por organização por dia, soma de
  -- tokens_ponderados do agregado do dia inteiro. Nulo = desligado.
  if v_teto_org_dia is not null then
    select coalesce(sum(tokens_ponderados), 0) into v_tokens_org_dia
      from public.billing_token_consumo_diario
      where organization_id = p_org and dia = p_dia;

    if v_tokens_org_dia > v_teto_org_dia then
      -- Item 8 da revisão: to_char, não ::text.
      insert into public.billing_token_avisos_emitidos (organization_id, chave)
      values (p_org, 'teto_org_dia:' || to_char(p_dia, 'YYYY-MM-DD'))
      on conflict (organization_id, chave) do nothing;

      get diagnostics v_linhas = row_count;
      if v_linhas > 0 then
        insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
        values (
          p_org,
          'other',
          'warn',
          'Tokens de IA: teto de segurança da organização passou do previsto hoje',
          'O consumo de tokens de IA da organização passou do teto de segurança configurado para hoje. Nesta fase nada é bloqueado; veja Configurações › Plano e uso.',
          'billing_limite',
          p_org
        );
      end if;
    end if;
  end if;

  -- Decisão 15 (N14): teto por conversa por dia, só quando a chamada tem
  -- contact_id. teto_instalacao_tokens_dia NÃO entra aqui de propósito: é
  -- conferido só pelo conferidor de cron (Tarefa 8), nunca dentro do
  -- gatilho, que serializaria todas as organizações da instalação.
  if v_teto_conversa_dia is not null and p_contact_id is not null then
    select coalesce(sum(tokens_ponderados), 0) into v_tokens_conversa_dia
      from public.billing_token_consumo_diario
      where organization_id = p_org and dia = p_dia and contact_id = p_contact_id;

    if v_tokens_conversa_dia > v_teto_conversa_dia then
      -- Item 8 da revisão: to_char no dia (não ::text); p_contact_id é uuid,
      -- ::text não depende de DateStyle.
      insert into public.billing_token_avisos_emitidos (organization_id, chave)
      values (p_org, 'teto_conversa_dia:' || to_char(p_dia, 'YYYY-MM-DD') || ':' || p_contact_id::text)
      on conflict (organization_id, chave) do nothing;

      get diagnostics v_linhas = row_count;
      if v_linhas > 0 then
        insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
        values (
          p_org,
          'other',
          'warn',
          'Tokens de IA: teto de segurança de uma conversa passou do previsto hoje',
          'O consumo de tokens de IA de uma conversa passou do teto de segurança configurado para hoje. Nesta fase nada é bloqueado; veja Configurações › Plano e uso.',
          'billing_limite',
          p_org
        );
      end if;
    end if;
  end if;
exception
  when others then
    raise warning 'billing_avisar_carteira_falhou: organizacao=%, sqlerrm=%', p_org, sqlerrm;
end;
$$;

comment on function public.fn_billing_avisar_carteira(uuid, date, date, uuid) is
  '0906, Tarefa 2b (decisões 14 e 15): avisos de 50/80/100% do total disponível no ciclo (plano + adicional do ciclo + avulso sem ciclo) e as duas travas de segurança que só avisam nesta fase (teto por organização por dia, teto por conversa por dia, quando p_contact_id não é nulo). Chamada por fn_billing_debitar_chamada (Parte 2) só quando debitou de fato E o ciclo da CHAMADA é o ciclo ATUAL: débito tardio de um ciclo já fechado (o conferidor da Tarefa 8) nunca avisa. Já roda sob a MESMA advisory lock da organização que o débito segura. Dedup por billing_token_avisos_emitidos (acima), que sobrevive ao encerramento do item na Central. Sem teto (Ilimitado, total creditado zero e nenhuma concessão) não avisa nada. Nunca lança: qualquer erro vira raise warning, nunca derruba o débito que a chama.';

revoke execute on function public.fn_billing_avisar_carteira(uuid, date, date, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_avisar_carteira(uuid, date, date, uuid) to service_role;

-- ============================================================================
-- 16. agent_worker não emite aviso de carteira nem escreve na tabela nova
-- desta parte 3 (mesmo racional dos blocos 9 e 13, acima): por alter default
-- privileges ela ganharia escrita na tabela nova e execute na função nova do
-- schema public, e tem bypassrls.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke insert, update, delete, truncate on public.billing_token_avisos_emitidos from agent_worker';
    execute 'revoke execute on function public.fn_billing_avisar_carteira(uuid, date, date, uuid) from agent_worker';
  end if;
end
$$;

-- ── Parte 4 (Tarefas 4, 5, 8): crédito, adicional e ajuste pelo admin da
-- plataforma; leitura de saldo; os conferidores diários ──
--
-- As partes 1 a 3 (acima) trouxeram configuração, tabelas, concessão,
-- débito, gatilho, agregado, avisos e travas. Esta parte 4 traz as oito
-- funções que faltavam: as três de escrita do admin da plataforma (decisão
-- 16, crédito avulso, adicional e ajuste), a leitura de saldo que concede
-- (decisão 9) e os três conferidores/leituras de apoio da Tarefa 8
-- (conferidor de carteira, decisão 8; débitos pendentes, decisão 12; soma da
-- instalação no dia, decisão 15). O TypeScript que chama estas oito funções
-- é de OUTRAS tarefas, contra as assinaturas exatas abaixo.
--
-- Trava: as quatro funções do admin (creditar, contratar, cancelar, ajustar)
-- e o conferidor de carteira usam pg_advisory_xact_lock (BLOQUEANTE, não a
-- variante _try_ do débito): são ação humana da plataforma ou rotina de
-- cron, nenhuma das duas é o caminho quente de uma resposta de agente, então
-- podem esperar a organização ficar livre em vez de desistir. Mesma chave
-- 'billing_tokens:<org>' do débito (decisão 8), para as duas pontas nunca
-- correrem juntas sobre a mesma carteira. fn_billing_saldo_da_carteira é
-- DIFERENTE de propósito: usa pg_try_advisory_xact_lock, porque o próprio
-- comentário de fn_billing_garantir_concessoes (Parte 2, acima) já promete
-- isso ("a RPC de saldo da Tarefa 5 já precisa estar sob
-- pg_try_advisory_xact_lock"), e é uma leitura que qualquer gerente pode
-- disparar a qualquer momento: travar a tela do cliente atrás de um débito
-- concorrente da própria organização não teria propósito nenhum, e se a
-- trava não vier agora, o próximo consumo (ou a próxima leitura) concede.
--
-- Duas peças novas em tabelas da Parte 1, ambas add column if not exists,
-- sem FK (mesmo racional da decisão 7): billing_token_ledger.ciclo (usada só
-- por fn_billing_ajustar_tokens, abaixo, para o conferidor de carteira saber
-- a que ciclo uma linha de ajuste pertence; concessão já carrega o ciclo na
-- própria chave, crédito é sempre avulso sem ciclo, e consumo é reconciliado
-- pelo llm_call_id, que já existe) e billing_token_ledger.compensa_id (o id
-- da linha do livro-caixa que um ajuste estorna, só informativo, sem FK pelo
-- mesmo motivo de llm_call_id: apagar a linha compensada não pode travar).
--
-- A decisão 4 do plano da fase pede que ajuste NEGATIVO deixe
-- billing_token_wallets.creditado ficar negativo (para não misturar
-- consumo real com ajuste no extrato de consumido): a constraint
-- billing_token_wallets_creditado_nao_negativo, criada na Parte 1 antes de
-- esta decisão existir por escrito, é relaxada abaixo (drop constraint if
-- exists, idempotente). consumido continua sempre >= 0: só o débito grava
-- nele, e débito nunca é negativo.
--
-- fn_billing_conferir_carteira recomputa cada linha existente de
-- billing_token_wallets a partir do livro-caixa, sob a mesma trava:
-- creditado = soma das linhas de concessão (chave carrega o ciclo), crédito
-- avulso (chave 'credito:%', só a linha de avulso) e ajuste (chave
-- 'ajuste:%', ciclo lido da coluna nova, positivo e negativo, decisão 4);
-- consumido = soma (invertida de sinal) das linhas 'consumo:%' desta fonte,
-- casadas pela coluna ciclo GRAVADA NA PRÓPRIA LINHA de consumo (a mesma
-- coluna que fn_billing_debitar_chamada, Parte 2, passou a preencher com o
-- ciclo da chamada, correção A1 da auditoria de segurança de 23/09/2026) para
-- plano/adicional, e sem filtro de ciclo para avulso. Este recálculo NÃO
-- depende de llm_calls (nenhum join, nenhuma leitura): o comentário anterior
-- desta função atribuía a lacuna a uma rotina de expurgo de dados pessoais
-- (citando a migration numerada da limpeza de dados) que nunca existiu em
-- código nenhum deste repositório; a lacuna real era A1 (qualquer
-- membro podia apagar ou alterar linhas de llm_calls pelo PostgREST com a
-- policy `tenant_isolation_llm_calls_all`, FOR ALL, e zerar o consumido no
-- próximo ciclo do conferidor). Com A1 corrigido (revoke de insert/update/
-- delete/truncate em llm_calls para authenticated/anon, Parte 5, fim deste
-- arquivo) E este recálculo independente de llm_calls, a lacuna deixa de
-- existir nos dois lados: mesmo que uma llm_call seja apagada no futuro por
-- outro motivo, o consumido recalculado continua correto, porque a
-- informação de ciclo já está na própria linha do livro-caixa.
--
-- Idempotente: add column if not exists, drop constraint if exists, create
-- or replace, bloco final de agent_worker igual ao das partes 1 a 3.

-- ============================================================================
-- 17. billing_token_ledger ganha ciclo e compensa_id; billing_token_wallets
-- deixa de exigir creditado >= 0 (decisão 4 do ajuste com sinal livre).
-- ============================================================================
alter table public.billing_token_ledger add column if not exists ciclo date;
alter table public.billing_token_ledger add column if not exists compensa_id uuid;

comment on column public.billing_token_ledger.ciclo is
  '0906, Parte 4, revisado por A1 (auditoria de segurança, 23/09/2026): ciclo (mês civil) a que esta linha pertence. Gravado por fn_billing_ajustar_tokens (nulo para ajuste de avulso) E, desde A1, também por fn_billing_debitar_chamada (Parte 2) em toda linha de CONSUMO, com o ciclo da chamada (informativo para avulso, que a carteira não agrupa por ciclo). Concessão não precisa desta coluna (o ciclo já está na chave, ''plano:<ciclo>''/''adicional:<id>:<ciclo>''); crédito é sempre avulso, sem ciclo. SEM default: linha antiga de consumo gravada ANTES de A1 fica com ciclo nulo até o backfill idempotente logo abaixo rodar; linha antiga de concessão/crédito continua com ciclo nulo para sempre (não precisa dele).';
comment on column public.billing_token_ledger.compensa_id is
  '0906, Parte 4, decisão 16: id da linha do livro-caixa que este ajuste compensa (estorno de débito errado), só informativo. SEM chave estrangeira, mesmo racional de llm_call_id e criado_por (decisão 7): apagar a linha compensada não pode travar, e o livro-caixa não tem UPDATE para desfazer uma FK com on delete set null.';

-- A1 (auditoria de segurança, 23/09/2026, defesa em profundidade item 2):
-- preenchimento ÚNICO das linhas de CONSUMO gravadas ANTES desta correção
-- (só existem no banco local; nunca foi para produção), a partir do ciclo
-- REAL da chamada de origem (fn_billing_ciclo_de(llm_calls.created_at), a
-- MESMA regra que fn_billing_debitar_chamada, Parte 2, já aplica ao gravar
-- ciclo em toda linha NOVA de consumo). É o ÚNICO update que este arquivo
-- faz no livro-caixa: a tabela não tem UPDATE para ninguém (nem para
-- service_role, revoke na Parte 1), mas esta instrução roda AQUI, dentro da
-- própria migration, como DONO da tabela, bypassa o revoke, nunca em
-- código de aplicação. Chamada já apagada (llm_call_id sem linha em
-- llm_calls) permanece com ciclo nulo: mesma lacuna conhecida e declarada,
-- sem efeito prático porque fn_billing_conferir_carteira, abaixo, já não
-- depende de llm_calls para recalcular consumido.
update public.billing_token_ledger l
  set ciclo = public.fn_billing_ciclo_de(c.created_at)
  from public.llm_calls c
  where l.llm_call_id = c.id
    and l.chave like 'consumo:%'
    and l.ciclo is null;

alter table public.billing_token_wallets drop constraint if exists billing_token_wallets_creditado_nao_negativo;

comment on table public.billing_token_wallets is
  '0906, decisão 8, revisado na Parte 4: saldo MATERIALIZADO por organização, fonte e ciclo (avulso com ciclo nulo). creditado e consumido são alterados na MESMA transação da linha do livro-caixa que os explica; o conferidor diário (fn_billing_conferir_carteira, Parte 4) recalcula do livro-caixa e corrige divergência. Saldo disponível (creditado - consumido) pode ficar negativo sem travar nada nesta fase (decisão 15); a partir da Parte 4, creditado TAMBÉM pode ficar negativo (fn_billing_ajustar_tokens, ajuste negativo sem consumo real correspondente, decisão 4 do plano da fase): por isso a constraint billing_token_wallets_creditado_nao_negativo da Parte 1 foi derrubada aqui. consumido continua sempre >= 0 (só o débito escreve nele).';

-- ============================================================================
-- 18. fn_billing_creditar_tokens: crédito avulso pelo admin da plataforma
-- (decisão 16, Tarefa 4).
-- ============================================================================
create or replace function public.fn_billing_creditar_tokens(
  p_org uuid,
  p_tokens bigint,
  p_chave uuid,
  p_valor_cents bigint,
  p_nota text,
  p_criado_por uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_linhas int;
  v_creditou boolean := false;
  v_creditado bigint;
  v_consumido bigint;
begin
  if p_tokens <= 0 then
    raise exception 'credito_tokens_deve_ser_positivo' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));

  -- Fonte avulso, sem ciclo (decisão 6/N13: pacote avulso não vence). Chave
  -- idempotente nasce no formulário (decisão 16): reenvio da MESMA p_chave
  -- nunca credita duas vezes, o "on conflict do nothing" garante.
  insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, nota, valor_cents, criado_por)
  values (p_org, 'avulso', p_tokens, 'credito:' || p_chave::text, p_nota, p_valor_cents, p_criado_por)
  on conflict (organization_id, chave) do nothing;

  get diagnostics v_linhas = row_count;

  if v_linhas > 0 then
    v_creditou := true;
    insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
    values (p_org, 'avulso', null, p_tokens, 0)
    on conflict (organization_id, fonte, ciclo) do update
      set creditado = public.billing_token_wallets.creditado + excluded.creditado,
          updated_at = now();
  end if;

  select creditado, consumido into v_creditado, v_consumido
    from public.billing_token_wallets
    where organization_id = p_org and fonte = 'avulso' and ciclo is null;

  return jsonb_build_object(
    'creditado', v_creditou,
    'saldo_avulso', coalesce(v_creditado, 0) - coalesce(v_consumido, 0)
  );
end;
$$;

comment on function public.fn_billing_creditar_tokens(uuid, bigint, uuid, bigint, text, uuid) is
  '0906, Parte 4, decisão 16: crédito avulso pelo admin da plataforma. p_tokens tem que ser positivo (senão 22023). Sob pg_advisory_xact_lock(''billing_tokens:<org>'') BLOQUEANTE (ação humana, pode esperar). Linha ''credito:<p_chave>'' no livro-caixa, on conflict do nothing (reenvio da mesma chave não credita de novo); billing_token_wallets (fonte avulso, ciclo nulo) só soma quando o insert entrou de fato. Devolve {"creditado": bool (false = reenvio da mesma chave), "saldo_avulso": creditado - consumido do avulso inteiro}.';

revoke execute on function public.fn_billing_creditar_tokens(uuid, bigint, uuid, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_creditar_tokens(uuid, bigint, uuid, bigint, text, uuid) to service_role;

-- ============================================================================
-- 19. fn_billing_contratar_adicional: assinatura mensal a mais pelo admin
-- (decisão 16, Tarefa 4).
-- ============================================================================
create or replace function public.fn_billing_contratar_adicional(
  p_org uuid,
  p_tokens_por_ciclo bigint,
  p_chave uuid,
  p_valor_cents bigint,
  p_nota text,
  p_criado_por uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_linhas int;
begin
  perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));

  -- id = p_chave (chave idempotente nascida no formulário, decisão 16):
  -- reenvio da MESMA p_chave não duplica a contratação, o "on conflict
  -- (id) do nothing" garante.
  insert into public.billing_token_adicionais (id, organization_id, tokens_por_ciclo, valor_cents, nota, criado_por)
  values (p_chave, p_org, p_tokens_por_ciclo, p_valor_cents, p_nota, p_criado_por)
  on conflict (id) do nothing;

  get diagnostics v_linhas = row_count;

  -- B1 (auditoria de segurança, 23/09/2026): "on conflict (id) do nothing"
  -- sozinho não confere DONO. Reenvio da MESMA p_chave (id) de OUTRA
  -- organização reaproveitaria em silêncio o adicional alheio (v_linhas = 0,
  -- "criado": false, sem erro nenhum). Só confere quando o insert NÃO
  -- entrou (a chave já existia): mesmo racional e mesmo errcode de
  -- fn_billing_cancelar_adicional, abaixo (42501, nunca revela mais do que
  -- "não é seu").
  if v_linhas = 0 and not exists (
    select 1 from public.billing_token_adicionais where id = p_chave and organization_id = p_org
  ) then
    raise exception 'adicional_de_outra_organizacao' using errcode = '42501';
  end if;

  -- Já concede o ciclo atual (decisão 9 e 16): sem isso, quem acabou de
  -- contratar um adicional no meio do mês veria saldo zero na tela até a
  -- próxima chamada de IA gerar débito (que é quem, hoje, dispara a
  -- concessão preguiçosa). fn_billing_garantir_concessoes não faz nada de
  -- novo se já tiver concedido este adicional neste ciclo (idempotente,
  -- Parte 2), inclusive no reenvio desta função.
  perform public.fn_billing_garantir_concessoes(p_org, public.fn_billing_ciclo_de(now()));

  return jsonb_build_object('id', p_chave, 'criado', v_linhas > 0);
end;
$$;

comment on function public.fn_billing_contratar_adicional(uuid, bigint, uuid, bigint, text, uuid) is
  '0906, Parte 4, decisão 16, revisado por B1 (auditoria de segurança, 23/09/2026): contrata (ou reaproveita) um adicional ativo. id = p_chave, idempotente: reenvio da MESMA chave DA MESMA organização devolve a linha existente sem duplicar ("criado": false). Reenvio da MESMA chave de OUTRA organização: 42501 (nunca reaproveita adicional alheio em silêncio). Sob pg_advisory_xact_lock(''billing_tokens:<org>'') BLOQUEANTE. Concede o ciclo atual chamando fn_billing_garantir_concessoes (decisão 9) já sob a mesma trava, sempre (mesmo em reenvio, é idempotente). Devolve {"id": uuid, "criado": bool}.';

revoke execute on function public.fn_billing_contratar_adicional(uuid, bigint, uuid, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_contratar_adicional(uuid, bigint, uuid, bigint, text, uuid) to service_role;

-- ============================================================================
-- 20. fn_billing_cancelar_adicional: cancela adicional ativo (decisão 16,
-- Tarefa 4). Não mexe no que já foi concedido no ciclo corrente: só para de
-- conceder a PARTIR do próximo ciclo (fn_billing_garantir_concessoes só
-- olha "ativo" na Parte 2, código já pronto e não tocado aqui).
-- ============================================================================
create or replace function public.fn_billing_cancelar_adicional(
  p_org uuid,
  p_adicional uuid,
  p_criado_por uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_dono uuid;
  v_ativo boolean;
begin
  select organization_id, ativo into v_org_dono, v_ativo
    from public.billing_token_adicionais
    where id = p_adicional;

  if not found then
    raise exception 'adicional_nao_encontrado' using errcode = 'P0002';
  end if;

  if v_org_dono <> p_org then
    raise exception 'adicional_de_outra_organizacao' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));

  -- Idempotente: se já estava inativo, não sobrescreve cancelado_em (a
  -- data do PRIMEIRO cancelamento é a que importa) nem faz UPDATE nenhum.
  -- p_criado_por não é gravado nesta tabela (mesmo molde de p_actor em
  -- fn_billing_trocar_plano, migration 0904: quem audita QUEM cancelou é a
  -- ação do servidor que chama esta função, não esta linha).
  if v_ativo then
    update public.billing_token_adicionais
      set ativo = false, cancelado_em = now()
      where id = p_adicional;
  end if;

  return jsonb_build_object('id', p_adicional, 'cancelado', true, 'cancelado_agora', v_ativo);
end;
$$;

comment on function public.fn_billing_cancelar_adicional(uuid, uuid, uuid) is
  '0906, Parte 4, decisão 16: cancela um adicional ativo (ativo = false, cancelado_em = now()). Adicional inexistente: P0002. Adicional de OUTRA organização: 42501 (nunca revela se existe em outra organização além do erro). Idempotente: cancelar de novo não sobrescreve cancelado_em nem falha. Não mexe no que já foi concedido no ciclo corrente (billing_token_ledger não é tocado): fn_billing_garantir_concessoes, Parte 2, só olha "ativo" para o PRÓXIMO ciclo. Devolve {"id", "cancelado": true, "cancelado_agora": bool (false = já estava cancelado)}.';

revoke execute on function public.fn_billing_cancelar_adicional(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_cancelar_adicional(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 21. fn_billing_ajustar_tokens: ajuste manual com sinal livre pelo admin
-- (decisão 16, Tarefa 4), para estornar débito errado ou corrigir na mão.
-- ============================================================================
create or replace function public.fn_billing_ajustar_tokens(
  p_org uuid,
  p_fonte text,
  p_tokens bigint,
  p_chave uuid,
  p_compensa uuid,
  p_nota text,
  p_criado_por uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_ciclo date;
  v_linhas int;
  v_entrou boolean := false;
  v_creditado bigint;
  v_consumido bigint;
begin
  if p_tokens = 0 then
    raise exception 'ajuste_tokens_nao_pode_ser_zero' using errcode = '22023';
  end if;

  if p_fonte not in ('plano', 'adicional', 'avulso') then
    raise exception 'ajuste_fonte_invalida' using errcode = '22023';
  end if;

  if p_nota is null or btrim(p_nota) = '' then
    raise exception 'ajuste_precisa_de_nota' using errcode = '22023';
  end if;

  -- p_compensa (opcional) tem que ser uma linha do livro-caixa DA MESMA
  -- organização; inexistente OU de outra organização cai no mesmo "não".
  if p_compensa is not null and not exists (
    select 1 from public.billing_token_ledger where id = p_compensa and organization_id = p_org
  ) then
    raise exception 'ajuste_compensa_linha_invalida' using errcode = '42501';
  end if;

  -- B2 (auditoria de segurança, 23/09/2026): a MESMA linha do livro-caixa
  -- não pode ser estornada duas vezes por AJUSTES DIFERENTES (a chave
  -- 'ajuste:<p_chave>' só protege reenvio da MESMA p_chave, decisão 16; uma
  -- p_chave NOVA apontando para o compensa_id de um ajuste já feito passava
  -- direto). Recusa quando já existe outra linha 'ajuste:%' desta
  -- organização com este compensa_id.
  if p_compensa is not null and exists (
    select 1 from public.billing_token_ledger
    where organization_id = p_org and chave like 'ajuste:%' and compensa_id = p_compensa
  ) then
    raise exception 'ajuste_compensa_ja_usado' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));

  -- Ciclo = ATUAL para plano/adicional (o admin ajusta o mês corrente, nunca
  -- reabre um mês fechado); nulo para avulso (fonte sem ciclo, decisão 6).
  v_ciclo := case when p_fonte = 'avulso' then null else public.fn_billing_ciclo_de(now()) end;

  -- Decisão do plano da fase (item 4 desta tarefa): para não misturar
  -- consumo real com ajuste no extrato de consumido, ajuste NEGATIVO
  -- SUBTRAI de creditado (pode ficar negativo, constraint derrubada no item
  -- 17 acima) e ajuste POSITIVO soma em creditado. Nunca toca consumido: os
  -- dois sinais usam a MESMA coluna, porque billing_token_ledger.tokens já
  -- carrega o sinal e o upsert abaixo só soma "excluded.creditado" (=
  -- p_tokens) em creditado, positivo ou negativo.
  insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, ciclo, compensa_id, nota, criado_por)
  values (p_org, p_fonte, p_tokens, 'ajuste:' || p_chave::text, v_ciclo, p_compensa, p_nota, p_criado_por)
  on conflict (organization_id, chave) do nothing;

  get diagnostics v_linhas = row_count;

  if v_linhas > 0 then
    v_entrou := true;
    insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
    values (p_org, p_fonte, v_ciclo, p_tokens, 0)
    on conflict (organization_id, fonte, ciclo) do update
      set creditado = public.billing_token_wallets.creditado + excluded.creditado,
          updated_at = now();
  end if;

  select creditado, consumido into v_creditado, v_consumido
    from public.billing_token_wallets
    where organization_id = p_org and fonte = p_fonte and ciclo is not distinct from v_ciclo;

  return jsonb_build_object(
    'ajustado', v_entrou,
    'saldo', coalesce(v_creditado, 0) - coalesce(v_consumido, 0)
  );
end;
$$;

comment on function public.fn_billing_ajustar_tokens(uuid, text, bigint, uuid, uuid, text, uuid) is
  '0906, Parte 4, revisado por B2 (auditoria de segurança, 23/09/2026): ajuste manual com sinal livre (nunca zero, 22023), fonte em plano/adicional/avulso (senão 22023), nota obrigatória (texto não vazio, senão 22023). p_compensa opcional referencia uma linha do livro-caixa DA MESMA organização (senão 42501): fica gravado em compensa_id (item 17), sem FK. A MESMA linha compensada não pode ser estornada duas vezes por ajustes DIFERENTES: já existir outro ''ajuste:%'' desta organização com este compensa_id é 22023 (ajuste_compensa_ja_usado). Ciclo = ATUAL para plano/adicional, nulo para avulso. Linha ''ajuste:<p_chave>'', idempotente por chave. Ajuste POSITIVO soma em creditado; NEGATIVO subtrai de creditado (pode ficar negativo, decisão do plano da fase): a diferença entre consumo real e ajuste nunca se mistura no extrato de consumido, que só o débito escreve. Sob pg_advisory_xact_lock(''billing_tokens:<org>'') BLOQUEANTE. Devolve {"ajustado": bool (false = reenvio da mesma chave), "saldo": creditado - consumido da fonte/ciclo ajustados}.';

revoke execute on function public.fn_billing_ajustar_tokens(uuid, text, bigint, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_ajustar_tokens(uuid, text, bigint, uuid, uuid, text, uuid) to service_role;

-- ============================================================================
-- 22. fn_billing_saldo_da_carteira: leitura que CONCEDE (decisão 9, Tarefa
-- 5). Devolve o retrato completo do ciclo atual.
-- ============================================================================
create or replace function public.fn_billing_saldo_da_carteira(p_org uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_ciclo date := public.fn_billing_ciclo_de(now());
  v_teto bigint;
  v_por_fonte jsonb;
  v_disponivel bigint;
  v_consumido bigint;
  v_obteve_trava boolean;
  v_tem_linha_plano boolean;
  v_concessao_pendente boolean;
  v_avulso_creditado_total bigint;
  v_avulso_consumido_antes bigint;
  v_avulso_consumido_mes bigint;
begin
  -- pg_try_advisory_xact_lock (NÃO a variante bloqueante do item 18 a 21 e
  -- do item 23, abaixo): é o que o comentário de fn_billing_garantir_
  -- concessoes (Parte 2) já promete para "a RPC de saldo da Tarefa 5", e
  -- esta função pode ser chamada por qualquer gerente a qualquer momento:
  -- travar a tela de um cliente atrás de um débito concorrente DA MESMA
  -- organização não teria propósito. Sem a trava agora, só pula a concessão
  -- preguiçosa desta vez (o próximo consumo ou a próxima leitura concede) e
  -- devolve o retrato com o que já existe.
  v_obteve_trava := pg_try_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));
  if v_obteve_trava then
    perform public.fn_billing_garantir_concessoes(p_org, v_ciclo);
  end if;

  v_teto := (public.fn_billing_limites_efetivos(p_org) ->> 'tokens_ia_mes')::bigint;

  select exists(
    select 1 from public.billing_token_wallets
    where organization_id = p_org and fonte = 'plano' and ciclo = v_ciclo
  ) into v_tem_linha_plano;

  -- Item 6 da revisão (23/09/2026): não conseguir a trava (outra sessão já
  -- está debitando esta organização) e ainda não existir linha de plano no
  -- ciclo NÃO é "sem saldo": é concessão que ainda não rodou. Sem este
  -- desvio a tela mostrava creditado 0 (e portanto "estourou") no primeiro
  -- segundo do mês, ou sempre que a trava está ocupada. Só se aplica quando
  -- existe teto: Ilimitado nunca tem linha de plano, por desenho (decisão
  -- 9), e isso nunca é pendência.
  v_concessao_pendente := (not v_obteve_trava) and (not v_tem_linha_plano) and (v_teto is not null);

  -- por_fonte sempre com as três chaves (plano, adicional, avulso), mesmo
  -- quando a fonte não tem linha em billing_token_wallets ainda (Ilimitado
  -- nunca cria linha de plano, decisão 9): left join contra os três nomes
  -- fixos, nunca jsonb_object_agg cru sobre o que existir. Quando a
  -- concessão está pendente (acima), a linha de plano mostra o TETO EFETIVO
  -- como creditado (sem gravar nada), para a tela nunca ler "0 disponível".
  select jsonb_object_agg(f.fonte, jsonb_build_object(
      'creditado', case when f.fonte = 'plano' and v_concessao_pendente then v_teto else coalesce(w.creditado, 0) end,
      'consumido', coalesce(w.consumido, 0),
      'saldo', case
        when f.fonte = 'plano' and v_concessao_pendente then v_teto - coalesce(w.consumido, 0)
        else coalesce(w.creditado, 0) - coalesce(w.consumido, 0)
      end
    ))
    into v_por_fonte
    from (values ('plano'), ('adicional'), ('avulso')) as f(fonte)
    left join public.billing_token_wallets w
      on w.organization_id = p_org
      and w.fonte = f.fonte
      and ((f.fonte in ('plano', 'adicional') and w.ciclo = v_ciclo) or (f.fonte = 'avulso' and w.ciclo is null));

  -- Total disponível/consumido do ciclo (decisão 14), revisado pelo item 2
  -- (23/09/2026): plano + adicional DESTE ciclo, mais avulso pela PROPORÇÃO
  -- DO MÊS (mesma fórmula de fn_billing_avisar_carteira, ver comentário lá):
  -- disponível do avulso = creditado da vida inteira menos consumido do
  -- avulso em ciclos ANTERIORES; consumido do avulso no mês = só o consumo
  -- do avulso com `ciclo` = este ciclo. por_fonte.avulso (acima) continua
  -- mostrando o saldo REAL da vida inteira (o que de fato é debitado); só
  -- este total, usado pela tela para calcular a porcentagem do mês, muda.
  select coalesce(sum(creditado) filter (where fonte in ('plano', 'adicional')), 0),
         coalesce(sum(consumido) filter (where fonte in ('plano', 'adicional')), 0)
    into v_disponivel, v_consumido
    from public.billing_token_wallets
    where organization_id = p_org and fonte in ('plano', 'adicional') and ciclo = v_ciclo;

  select coalesce(creditado, 0) into v_avulso_creditado_total
    from public.billing_token_wallets
    where organization_id = p_org and fonte = 'avulso' and ciclo is null;

  select coalesce(sum(-tokens), 0) into v_avulso_consumido_antes
    from public.billing_token_ledger
    where organization_id = p_org and fonte = 'avulso' and chave like 'consumo:%'
      and ciclo is not null and ciclo < v_ciclo;

  select coalesce(sum(-tokens), 0) into v_avulso_consumido_mes
    from public.billing_token_ledger
    where organization_id = p_org and fonte = 'avulso' and chave like 'consumo:%' and ciclo = v_ciclo;

  v_disponivel := v_disponivel + (coalesce(v_avulso_creditado_total, 0) - v_avulso_consumido_antes);
  v_consumido := v_consumido + v_avulso_consumido_mes;

  if v_concessao_pendente then
    v_disponivel := v_disponivel + v_teto;
  end if;

  return jsonb_build_object(
    'ciclo', v_ciclo,
    'por_fonte', coalesce(v_por_fonte, '{}'::jsonb),
    'sem_limite', v_teto is null,
    'total_disponivel', v_disponivel,
    'total_consumido', v_consumido,
    'concessao_pendente', v_concessao_pendente
  );
end;
$$;

comment on function public.fn_billing_saldo_da_carteira(uuid) is
  '0906, Parte 4, decisão 9 (Tarefa 5): leitura que CONCEDE. pg_try_advisory_xact_lock (não bloqueante, diferente das funções do admin/conferência desta parte): promessa já feita no comentário de fn_billing_garantir_concessoes (Parte 2). Devolve {"ciclo": date, "por_fonte": {"plano"|"adicional"|"avulso": {"creditado","consumido","saldo"}}, "sem_limite": bool (tokens_ia_mes efetivo nulo, Ilimitado), "total_disponivel": creditado(plano+adicional do ciclo+avulso), "total_consumido": consumido dos mesmos}. Concede o plano no primeiro uso do ciclo e devolve o MESMO retrato em usos seguintes (fn_billing_garantir_concessoes é idempotente).';

revoke execute on function public.fn_billing_saldo_da_carteira(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_saldo_da_carteira(uuid) to service_role;

-- ============================================================================
-- 23. fn_billing_conferir_carteira: o conferidor diário de carteira
-- (decisão 8, Tarefa 8). Recalcula do livro-caixa e corrige.
-- ============================================================================
create or replace function public.fn_billing_conferir_carteira(p_org uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_divergentes int := 0;
  v_linha record;
  v_creditado_real bigint;
  v_consumido_real bigint;
  -- Item 5 da revisão (23/09/2026): o conferidor rodava sobre TODA a
  -- carteira da organização, ciclo por ciclo, desde carteira_desde: o custo
  -- cresce com o histórico e nunca diminui. Ciclo fechado não recebe linha
  -- nova (concessão só concede para o ciclo atual, decisão 9; consumo,
  -- crédito e ajuste do admin sempre usam o ciclo atual, exceto o consumo
  -- tardio de fn_billing_debitar_chamada, que ainda pode gravar no ciclo
  -- ANTERIOR se uma chamada demorou a debitar); confere só o ciclo
  -- atual, o anterior e o avulso (que nunca tem ciclo e nunca "fecha").
  v_ciclo_atual date := public.fn_billing_ciclo_de(now());
  v_ciclo_anterior date := (public.fn_billing_ciclo_de(now()) - interval '1 month')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || p_org::text, 0));

  for v_linha in
    select id, fonte, ciclo, creditado, consumido
    from public.billing_token_wallets
    where organization_id = p_org
      and (ciclo in (v_ciclo_atual, v_ciclo_anterior) or fonte = 'avulso')
    for update
  loop
    -- creditado real: concessão (chave carrega o ciclo: 'plano:<ciclo>' ou
    -- 'adicional:<id>:<ciclo>'), crédito avulso (chave 'credito:%', só a
    -- linha de avulso) e ajuste (chave 'ajuste:%', ciclo lido da coluna
    -- ciclo, item 17; positivo E negativo entram aqui, nunca em consumido,
    -- coerente com fn_billing_ajustar_tokens, item 21).
    select coalesce(sum(l.tokens), 0)
      into v_creditado_real
      from public.billing_token_ledger l
      where l.organization_id = p_org
        and l.fonte = v_linha.fonte
        and (
          -- Item 8 da revisão: to_char, não ::text (ver comentário na
          -- concessão, Parte 2): a chave foi gravada com to_char, a
          -- comparação tem que usar a mesma conversão.
          (v_linha.fonte = 'plano' and l.chave = 'plano:' || to_char(v_linha.ciclo, 'YYYY-MM-DD'))
          or (v_linha.fonte = 'adicional' and l.chave like 'adicional:%:' || to_char(v_linha.ciclo, 'YYYY-MM-DD'))
          or (v_linha.fonte = 'avulso' and l.chave like 'credito:%')
          or (l.chave like 'ajuste:%' and l.ciclo is not distinct from v_linha.ciclo)
        );

    -- consumido real: linhas 'consumo:<llm_call_id>:<fonte>' desta fonte.
    -- avulso não tem ciclo, entra inteiro; plano/adicional casam pela coluna
    -- ciclo GRAVADA NA PRÓPRIA LINHA (fn_billing_debitar_chamada, Parte 2,
    -- grava o ciclo da chamada em toda linha de consumo desde a correção A1
    -- da auditoria de segurança de 23/09/2026; linha antiga sem ciclo já foi
    -- preenchida pelo backfill idempotente do item 17, acima). SEM join em
    -- llm_calls, de propósito: o comentário anterior desta função atribuía a
    -- lacuna a uma rotina de expurgo de dados pessoais que nunca existiu em
    -- código nenhum deste repositório: a lacuna real era A1 (qualquer membro apagava ou
    -- alterava llm_calls pelo PostgREST e zerava o consumido no próximo
    -- ciclo deste conferidor). Com o ciclo gravado na própria linha, o
    -- recálculo é correto mesmo que a llm_call de origem seja apagada no
    -- futuro por outro motivo.
    select coalesce(sum(-l.tokens), 0)
      into v_consumido_real
      from public.billing_token_ledger l
      where l.organization_id = p_org
        and l.fonte = v_linha.fonte
        and l.chave like 'consumo:%'
        and (
          v_linha.fonte = 'avulso'
          or l.ciclo = v_linha.ciclo
        );

    if v_linha.creditado <> v_creditado_real or v_linha.consumido <> v_consumido_real then
      update public.billing_token_wallets
        set creditado = v_creditado_real,
            consumido = v_consumido_real,
            updated_at = now()
        where id = v_linha.id;
      v_divergentes := v_divergentes + 1;
    end if;
  end loop;

  return v_divergentes;
end;
$$;

comment on function public.fn_billing_conferir_carteira(uuid) is
  '0906, Parte 4, decisão 8 (Tarefa 8), revisado por A1 (auditoria de segurança, 23/09/2026): conferidor diário de UMA organização. Sob pg_advisory_xact_lock(''billing_tokens:<org>'') BLOQUEANTE, trava cada linha existente de billing_token_wallets (for update) e recalcula creditado/consumido do livro-caixa (ver comentários no corpo para a regra exata de cada fonte). Corrige só quando diverge; devolve quantas linhas divergiam (0 = carteira íntegra). Desde A1, o recálculo de consumido usa SÓ a coluna ciclo gravada na própria linha de consumo (fn_billing_debitar_chamada, Parte 2): NENHUM join em llm_calls, e nenhuma dependência de a chamada continuar viva. A versão anterior deste comentário atribuía a lacuna a uma rotina de expurgo de dados pessoais que nunca existiu neste repositório; a lacuna real era llm_calls gravável por qualquer membro via PostgREST (corrigido na Parte 5, fim deste arquivo).';

revoke execute on function public.fn_billing_conferir_carteira(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_conferir_carteira(uuid) to service_role;

-- ============================================================================
-- 24. fn_billing_debitos_pendentes: o conferidor diário de débito (decisão
-- 12, Tarefa 8): acha chamada que deveria ter debitado e não debitou.
-- ============================================================================
create or replace function public.fn_billing_debitos_pendentes(p_org uuid, p_limite integer default 500)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id
  from public.llm_calls c, public.billing_settings s
  where s.id = 1
    and c.organization_id = p_org
    -- Item 3 da revisão (23/09/2026): sem s.pesos_alterados_em aqui, trocar
    -- um peso de 0 para um valor maior (ex.: embedding_indexar) faria este
    -- conferidor recalcular com o peso NOVO até 35 dias de chamada ANTIGA
    -- que nunca deveriam ter debitado nada (o peso vigente no momento da
    -- chamada era 0). greatest() ignora NULL sozinho (pesos_alterados_em
    -- nunca mudou = coluna nula = sem efeito nesta comparação).
    and c.created_at >= greatest(s.carteira_desde, s.pesos_alterados_em, now() - interval '35 days')
    and c.legacy_invocation_id is null
    and c.origem_da_chave = 'chave_da_instalacao'
    and public.fn_billing_tokens_ponderados(
          c.input_tokens,
          c.output_tokens,
          c.cache_read_tokens,
          s.peso_cache_leitura_pct,
          coalesce((s.pesos_por_proposito ->> c.purpose)::int, 100)
        ) > 0
    and not exists (
      select 1 from public.billing_token_ledger l where l.llm_call_id = c.id
    )
  order by c.created_at
  limit p_limite
$$;

comment on function public.fn_billing_debitos_pendentes(uuid, integer) is
  '0906, Parte 4, decisão 12 (Tarefa 8): ids de llm_calls da organização que DEVERIAM ter debitado (mesmos filtros de fn_billing_debitar_chamada: created_at >= greatest(carteira_desde, hoje - 35 dias), legacy_invocation_id nulo, origem_da_chave = chave_da_instalacao, ponderado calculado com os MESMOS pesos > 0) e ainda não têm nenhuma linha de consumo no livro-caixa (anti-join por llm_call_id, índice billing_token_ledger_llm_call_id_idx já criado na Parte 1, nenhum índice novo foi preciso). Ordem por created_at, até p_limite (default 500). Quem chama debita cada id com fn_billing_debitar_chamada (Parte 2); depois de debitado, a mesma chamada some desta lista (a linha de consumo passa a existir).';

revoke execute on function public.fn_billing_debitos_pendentes(uuid, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_debitos_pendentes(uuid, integer) to service_role;

-- ============================================================================
-- 25. fn_billing_consumo_da_instalacao_no_dia: soma de todas as
-- organizações no dia, para o teto da instalação (decisão 15, Tarefa 8). A
-- comparação com teto_instalacao_tokens_dia e o alarme são do TypeScript do
-- conferidor (decisão 15: "o alarme... vai para o log... e para a aba da
-- plataforma"), nunca desta função.
-- ============================================================================
create or replace function public.fn_billing_consumo_da_instalacao_no_dia(p_dia date)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(tokens_ponderados), 0)
  from public.billing_token_consumo_diario
  where dia = p_dia
$$;

comment on function public.fn_billing_consumo_da_instalacao_no_dia(date) is
  '0906, Parte 4, decisão 15 (Tarefa 8): soma de tokens_ponderados do agregado de TODAS as organizações no dia informado, para o conferidor comparar com billing_settings.teto_instalacao_tokens_dia. Só a soma; a comparação com o teto e o alarme (log + aba da plataforma) são do TypeScript do conferidor, nunca desta função: o teto da instalação nunca é conferido dentro do gatilho de débito (decisão 15: serializaria todas as organizações).';

revoke execute on function public.fn_billing_consumo_da_instalacao_no_dia(date) from public, anon, authenticated;
grant execute on function public.fn_billing_consumo_da_instalacao_no_dia(date) to service_role;

-- ============================================================================
-- 26. agent_worker não escreve nem executa nada das peças novas desta parte
-- 4 (mesmo racional dos blocos 9, 13 e 16, acima): por alter default
-- privileges ela ganharia execute em toda função nova do schema public, e
-- tem bypassrls. Nenhuma tabela NOVA nesta parte (só colunas em tabela já
-- coberta pelo bloco da Parte 1), então só as oito funções.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_creditar_tokens(uuid, bigint, uuid, bigint, text, uuid), public.fn_billing_contratar_adicional(uuid, bigint, uuid, bigint, text, uuid), public.fn_billing_cancelar_adicional(uuid, uuid, uuid), public.fn_billing_ajustar_tokens(uuid, text, bigint, uuid, uuid, text, uuid), public.fn_billing_saldo_da_carteira(uuid), public.fn_billing_conferir_carteira(uuid), public.fn_billing_debitos_pendentes(uuid, integer), public.fn_billing_consumo_da_instalacao_no_dia(date) from agent_worker';
  end if;
end
$$;

-- ── Parte 5: correções da auditoria de segurança da fase F2-B (23/09/2026) ──
--
-- As partes 1 a 4 (acima) são o texto ORIGINAL desta migration, como a fase
-- entregou. Esta parte 5 corrige os achados da auditoria de segurança que
-- bloqueavam a publicação (A1) e os achados médios/baixos (M1, B1, B2, B3),
-- sem editar nenhuma policy nem função do AUTOR (anterior a esta migration,
-- por exemplo `tenant_isolation_llm_calls_all`, da 0050) NO LUGAR: só
-- acrescenta. As correções nas OITO funções desta própria migration (M1 em
-- fn_billing_debitar_chamada, A1 item 2 em fn_billing_debitar_chamada e
-- fn_billing_conferir_carteira, B1 em fn_billing_contratar_adicional, B2 em
-- fn_billing_ajustar_tokens) já foram feitas NO LUGAR, acima, nas partes 2 e
-- 4 onde essas funções nasceram: só ficaram para cá o que é
-- estrutural/aditivo por natureza (grants, policy nova, revoke de agent_worker).
--
-- A1 (ALTO, bloqueava a publicação): qualquer membro, com o próprio token
-- pelo PostgREST, fazia UPDATE ou DELETE nas linhas de `llm_calls` da
-- própria organização (a policy `tenant_isolation_llm_calls_all`, FOR ALL,
-- da 0050, cobre update/delete/insert além de select) e também INSERT de
-- linhas forjadas com `cost_cents` arbitrário. Isso deixava apagar consumo
-- (o conferidor, Parte 4, recalculava e zerava o consumido no ciclo
-- seguinte, devolvendo saldo à organização) e estourar
-- `ai_budgets.current_month_consumed_cents` (numeric 12,4) com uma linha
-- forjada, derrubando toda chamada legítima seguinte no gatilho do autor
-- `fn_update_budget_consumption` ("numeric field overflow"). Conferido por
-- grep (ver relatório da tarefa) que NENHUM caminho de código grava
-- `llm_calls` pela sessão do usuário (`authenticated`): os únicos escritores
-- são `createAdminClient()` (service_role) e o pool `pg.Pool` do worker/
-- scripts (conexão direta por `SUPABASE_DB_URL`/`DB_URL`, fora do papel
-- `authenticated`). Revogar insert/update/delete/truncate de `authenticated`
-- e `anon` é seguro: nenhum escritor legítimo depende deles.
revoke insert, update, delete, truncate on public.llm_calls from authenticated, anon;

-- Suspensórios além do cinto (o revoke acima já barra por privilégio, antes
-- da RLS ser avaliada): três policies RESTRICTIVE para `authenticated`, uma
-- por comando de escrita. RESTRICTIVE combina em AND com a policy
-- PERMISSIVE do autor (`tenant_isolation_llm_calls_all`, FOR ALL, 0050, não
-- tocada): mesmo que um GRANT futuro reabra insert/update/delete/truncate
-- para `authenticated` por engano, a RLS ainda barra. Três policies
-- separadas, não uma FOR ALL: uma única "as restrictive for all using(true)
-- with check(false)" NÃO bloquearia DELETE, porque DELETE só avalia USING
-- (nunca WITH CHECK): with check(false) e using(true) juntos deixariam
-- DELETE passar livre, o oposto do que este bloco existe para fazer.
drop policy if exists billing_llm_calls_restringe_insert on public.llm_calls;
create policy billing_llm_calls_restringe_insert on public.llm_calls
  as restrictive
  for insert
  to authenticated
  with check (false);

drop policy if exists billing_llm_calls_restringe_update on public.llm_calls;
create policy billing_llm_calls_restringe_update on public.llm_calls
  as restrictive
  for update
  to authenticated
  using (false);

drop policy if exists billing_llm_calls_restringe_delete on public.llm_calls;
create policy billing_llm_calls_restringe_delete on public.llm_calls
  as restrictive
  for delete
  to authenticated
  using (false);

-- B3 (auditoria de segurança): `agent_worker` tem bypassrls e, pelas mesmas
-- default privileges que dão a ela select em toda tabela nova do schema
-- public (o motivo dos blocos de revoke de escrita nas partes 1 a 4, acima),
-- ficou também com SELECT em todo o livro-caixa (nota e valor incluídos),
-- adicionais, avisos emitidos, carteira e agregado: nenhuma delas revogava
-- select, só insert/update/delete/truncate. Conferido por grep (ver
-- relatório da tarefa) que nenhum código de `workers/` ou
-- `lib/agent-engine/` lê nenhuma destas cinco tabelas: revoga select das
-- cinco.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select on public.billing_token_ledger, public.billing_token_wallets, public.billing_token_adicionais, public.billing_token_consumo_diario, public.billing_token_avisos_emitidos from agent_worker';
  end if;
end
$$;

-- ── Parte 6: revisão da fase F2-B (23/09/2026), peças NOVAS ──
--
-- As partes 1 a 5 (acima) são o texto entregue mais as correções da
-- auditoria de segurança. Esta parte 6 traz o que a REVISÃO pediu de NOVO:
-- as quatro RPCs de agregação no banco (item 1, corrige o ALTO da revisão:
-- as leituras em TypeScript traziam linha crua, cortada em 1000 pelo
-- max_rows do PostgREST, e somavam no Node: os totais saíam menores que o
-- real), a coluna e o gatilho de `pesos_alterados_em` (infraestrutura do
-- item 3) e o índice que o item 5 pede para o conferidor não fazer `like
-- 'consumo:%'` sem apoio de índice. As correções NO LUGAR das oito funções
-- originais (itens 2 a 8) já foram feitas acima, nas partes 1 a 4 onde cada
-- função nasceu; só o que é estrutural/aditivo por natureza fica aqui,
-- mesmo molde das partes 1 a 5.
--
-- Trava e transação: as quatro RPCs são STABLE (só leem, nunca escrevem:
-- mesmo fn_billing_livro_caixa_do_ciclo e fn_billing_margem_do_ciclo, que
-- usam PL/pgSQL para um `select ... into` antes do jsonb_build_object, não
-- gravam nada). Nenhuma trava advisory: leitura pura não disputa a carteira
-- com o débito.
--
-- Idempotente: add column if not exists, create index if not exists, create
-- or replace function, drop trigger if exists antes de recriar, bloco final
-- de agent_worker igual ao das partes 1 a 5.

-- ============================================================================
-- 28. Índice de apoio ao conferidor (item 5 da revisão): sem ele, o `like
-- 'consumo:%'` dentro do loop de fn_billing_conferir_carteira (Parte 4, já
-- editada acima para varrer só o ciclo atual/anterior/avulso) varreria a
-- fatia (organização, fonte) inteira por sequential scan a cada linha da
-- carteira conferida.
-- ============================================================================
create index if not exists billing_token_ledger_org_fonte_ciclo_idx
  on public.billing_token_ledger (organization_id, fonte, ciclo);

-- ============================================================================
-- 29. fn_billing_extrato_do_ciclo: por dia e por agente, agregados NO BANCO
-- (item 1a da revisão). Substitui a leitura crua de
-- `lib/billing/tokens/extrato-do-ciclo.ts` (Tarefa 9), que trazia linha a
-- linha e cortava em max_rows = 1000 do PostgREST.
-- ============================================================================
create or replace function public.fn_billing_extrato_do_ciclo(p_org uuid, p_ciclo date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'por_dia', coalesce((
      select jsonb_agg(jsonb_build_object(
          'dia', to_char(d.dia, 'YYYY-MM-DD'),
          'tokens_ponderados', d.tokens_ponderados,
          'chamadas', d.chamadas
        ) order by d.dia)
      from (
        select dia, sum(tokens_ponderados) as tokens_ponderados, sum(chamadas) as chamadas
        from public.billing_token_consumo_diario
        where organization_id = p_org
          and dia >= p_ciclo and dia < (p_ciclo + interval '1 month')::date
        group by dia
      ) d
    ), '[]'::jsonb),
    'por_agente', coalesce((
      select jsonb_agg(jsonb_build_object(
          'agent_id', a.agent_id,
          'tokens_ponderados', a.tokens_ponderados,
          'chamadas', a.chamadas
        ) order by a.tokens_ponderados desc)
      from (
        select agent_id, sum(tokens_ponderados) as tokens_ponderados, sum(chamadas) as chamadas
        from public.billing_token_consumo_diario
        where organization_id = p_org
          and dia >= p_ciclo and dia < (p_ciclo + interval '1 month')::date
        group by agent_id
      ) a
    ), '[]'::jsonb)
  )
$$;

comment on function public.fn_billing_extrato_do_ciclo(uuid, date) is
  '0906, Parte 6, item 1a da revisão (23/09/2026): extrato do ciclo agregado NO BANCO, {"por_dia": [{dia, tokens_ponderados, chamadas}], "por_agente": [{agent_id, tokens_ponderados, chamadas}]}, a partir de billing_token_consumo_diario (dia >= p_ciclo e < mês seguinte). agent_id nulo é o grupo "sem agente" (a tela junta o nome do agente depois, tarefa 9). STABLE, security definer, execute só service_role.';

revoke execute on function public.fn_billing_extrato_do_ciclo(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_extrato_do_ciclo(uuid, date) to service_role;

-- ============================================================================
-- 30. fn_billing_livro_caixa_do_ciclo: linhas não-consumo (concessão,
-- crédito, ajuste) mais o consumo agrupado por dia e fonte (item 1b da
-- revisão).
-- ============================================================================
create or replace function public.fn_billing_livro_caixa_do_ciclo(p_org uuid, p_ciclo date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_total_nao_consumo int;
begin
  -- Filtro do ciclo (item 1b): pelo `ciclo` GRAVADO na linha quando não é
  -- nulo (ajuste de plano/adicional); para o que nunca tem ciclo gravado
  -- (concessão: o ciclo já está na chave, nunca na coluna; e crédito/
  -- ajuste avulso), pelo `created_at` convertido para ciclo NO BANCO
  -- (fn_billing_ciclo_de, fuso America/Sao_Paulo), nunca com um offset fixo
  -- tipo "-03:00" calculado no TypeScript.
  select count(*) into v_total_nao_consumo
    from public.billing_token_ledger l
    where l.organization_id = p_org
      and l.chave not like 'consumo:%'
      and (
        (l.ciclo is not null and l.ciclo = p_ciclo)
        or (l.ciclo is null and public.fn_billing_ciclo_de(l.created_at) = p_ciclo)
      );

  return jsonb_build_object(
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', x.id,
          'created_at', x.created_at,
          'fonte', x.fonte,
          'tipo', x.tipo,
          'tokens', x.tokens,
          'valor_cents', x.valor_cents,
          'nota', x.nota,
          'criado_por', x.criado_por,
          'compensa_id', x.compensa_id
        ) order by x.created_at desc)
      from (
        select l.id, l.created_at, l.fonte, l.tokens, l.valor_cents, l.nota, l.criado_por, l.compensa_id,
          case
            when l.chave like 'credito:%' then 'credito'
            when l.chave like 'ajuste:%' then 'ajuste'
            else 'concessao'
          end as tipo
        from public.billing_token_ledger l
        where l.organization_id = p_org
          and l.chave not like 'consumo:%'
          and (
            (l.ciclo is not null and l.ciclo = p_ciclo)
            or (l.ciclo is null and public.fn_billing_ciclo_de(l.created_at) = p_ciclo)
          )
        order by l.created_at desc
        -- Item 1b: limite de 500 linhas não-consumo; `truncado`, abaixo,
        -- avisa quando o corte de fato tirou linha.
        limit 500
      ) x
    ), '[]'::jsonb),
    'consumo_por_dia_fonte', coalesce((
      select jsonb_agg(jsonb_build_object(
          'dia', to_char(c.dia, 'YYYY-MM-DD'),
          'fonte', c.fonte,
          'tokens', c.tokens,
          'chamadas', c.chamadas
        ) order by c.dia desc, c.fonte)
      from (
        -- Consumo sempre tem `ciclo` gravado na própria linha desde a
        -- correção A1 (Parte 2, defesa em profundidade), inclusive avulso
        -- (informativo lá, usado aqui de verdade): sem depender de
        -- created_at nem de llm_calls continuar viva.
        select (l.created_at at time zone 'America/Sao_Paulo')::date as dia, l.fonte,
          sum(l.tokens) as tokens, count(*) as chamadas
        from public.billing_token_ledger l
        where l.organization_id = p_org and l.chave like 'consumo:%' and l.ciclo = p_ciclo
        group by 1, 2
      ) c
    ), '[]'::jsonb),
    'truncado', v_total_nao_consumo > 500
  );
end;
$$;

comment on function public.fn_billing_livro_caixa_do_ciclo(uuid, date) is
  '0906, Parte 6, item 1b da revisão (23/09/2026): livro-caixa do ciclo agregado NO BANCO. "linhas": até 500 linhas não-consumo (concessão/crédito/ajuste), mais recente primeiro, cada uma com id, created_at, fonte, tipo (pela chave), tokens, valor_cents, nota, criado_por, compensa_id; "truncado" avisa quando havia mais de 500. "consumo_por_dia_fonte": consumo agrupado por dia (fuso America/Sao_Paulo) e fonte, tokens negativo. STABLE, security definer, execute só service_role.';

revoke execute on function public.fn_billing_livro_caixa_do_ciclo(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_livro_caixa_do_ciclo(uuid, date) to service_role;

-- ============================================================================
-- 31. fn_billing_margem_do_ciclo: receita e custo do ciclo (item 1c da
-- revisão), com estimativa de custo pelo catálogo para chamada sem
-- cost_cents.
-- ============================================================================
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
  with sem_custo as (
    select c.id, c.provider, c.model, c.input_tokens, c.output_tokens,
      case when c.model like c.provider || '/%' then substring(c.model from length(c.provider) + 2) else c.model end as modelo_sem_prefixo
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
        )
      order by (case
        when m.provider = s.provider and m.model_id = s.model then 1
        when m.provider = s.provider and m.model_id = s.modelo_sem_prefixo then 2
        when m.provider = 'openrouter' and m.model_id = s.model then 3
        else 4
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
  '0906, Parte 6, item 1c da revisão (23/09/2026): receita (preço mensal do contrato + valor_cents dos adicionais ativos + valor_cents dos créditos avulsos do ciclo, tudo em CENTAVOS DE REAL) e custo do ciclo (soma de cost_cents CONHECIDO de llm_calls que a Hiperbold paga, origem distinta de credencial_da_organizacao, inclusive nula, inclusive peso 0, mais ESTIMATIVA pelo catálogo ai_models para o que tem cost_cents nulo, e a contagem do que nem o catálogo sabe precificar). Devolve {"receita_plano_cents", "receita_adicionais_cents", "receita_creditos_cents", "receita_total_cents", "custo_conhecido_cents", "custo_estimado_cents" (CENTAVOS DE DÓLAR, nunca convertidos), "chamadas_estimadas", "chamadas_sem_preco"}. STABLE, security definer, execute só service_role.';

revoke execute on function public.fn_billing_margem_do_ciclo(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_margem_do_ciclo(uuid, date) to service_role;

-- ============================================================================
-- 32. fn_billing_consumo_para_estimativa: tokens e respostas dos últimos
-- p_dias, para a estimativa de quanto vai durar o saldo (item 1d da
-- revisão).
-- ============================================================================
create or replace function public.fn_billing_consumo_para_estimativa(p_org uuid, p_dias int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tokens_ponderados bigint;
  v_respostas bigint;
  v_carteira_desde timestamptz;
  v_desde timestamptz := now() - (p_dias || ' days')::interval;
begin
  select carteira_desde into v_carteira_desde from public.billing_settings where id = 1;

  -- Tokens: do livro-caixa (consumo), não de llm_calls: é o token PONDERADO
  -- que a carteira debita, não o token cru do fornecedor.
  select coalesce(sum(-l.tokens), 0) into v_tokens_ponderados
    from public.billing_token_ledger l
    where l.organization_id = p_org and l.chave like 'consumo:%' and l.created_at >= v_desde;

  -- Respostas: chamadas purpose = agent_turn, status = ok, origem =
  -- chave_da_instalacao, created_at >= greatest(carteira_desde, v_desde).
  -- Uma resposta pode gerar VÁRIAS chamadas (uso de ferramenta no meio do
  -- turno, mesmo job_id): count(distinct ...) com coalesce(job_id, id) conta
  -- uma por job_id quando houver, uma por linha quando job_id for nulo (cada
  -- id é único, nunca colide com outro job_id nem com outro id).
  select count(distinct coalesce(c.job_id::text, c.id::text)) into v_respostas
    from public.llm_calls c
    where c.organization_id = p_org
      and c.purpose = 'agent_turn'
      and c.status = 'ok'
      and c.origem_da_chave = 'chave_da_instalacao'
      and c.created_at >= greatest(v_carteira_desde, v_desde);

  return jsonb_build_object('tokens_ponderados', v_tokens_ponderados, 'respostas', v_respostas);
end;
$$;

comment on function public.fn_billing_consumo_para_estimativa(uuid, int) is
  '0906, Parte 6, item 1d da revisão (23/09/2026): {"tokens_ponderados", "respostas"} dos últimos p_dias. tokens_ponderados vem do livro-caixa (consumo); respostas conta chamadas purpose=agent_turn, status=ok, origem_da_chave=chave_da_instalacao, created_at >= greatest(carteira_desde, hoje - p_dias), uma por job_id quando houver (várias chamadas de ferramenta no mesmo turno), uma por linha quando job_id é nulo. STABLE, security definer, execute só service_role.';

revoke execute on function public.fn_billing_consumo_para_estimativa(uuid, int) from public, anon, authenticated;
grant execute on function public.fn_billing_consumo_para_estimativa(uuid, int) to service_role;

-- ============================================================================
-- 33. agent_worker não executa nem escreve nas peças novas desta parte 6
-- (mesmo racional dos blocos de revoke das partes 1 a 5, acima): por alter
-- default privileges ela ganharia execute em toda função nova do schema
-- public, e tem bypassrls.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_extrato_do_ciclo(uuid, date), public.fn_billing_livro_caixa_do_ciclo(uuid, date), public.fn_billing_margem_do_ciclo(uuid, date), public.fn_billing_consumo_para_estimativa(uuid, int) from agent_worker';
  end if;
end
$$;
