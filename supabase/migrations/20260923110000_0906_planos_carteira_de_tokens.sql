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
  -- fração do dia é estimativa.
  cost_cents_conhecido bigint not null default 0,
  chamadas_custo_nulo bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_token_consumo_diario_unique
    unique nulls not distinct (organization_id, dia, agent_id, contact_id, purpose)
);

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
