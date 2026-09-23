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
alter table public.billing_token_consumo_diario
  alter column cost_cents_conhecido type numeric(14,4);

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
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
    values (p_org, 'plano', v_teto, 'plano:' || p_ciclo::text)
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
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
    values (p_org, 'adicional', v_adicional.tokens_por_ciclo, 'adicional:' || v_adicional.id::text || ':' || p_ciclo::text)
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

  -- Já sob a trava: garante a concessão do ciclo DA CHAMADA (fn_billing_
  -- garantir_concessoes não faz nada sozinha se esse ciclo já fechou).
  perform public.fn_billing_garantir_concessoes(v_chamada.organization_id, v_ciclo);

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

  if v_debito_plano > 0 then
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id)
    values (v_chamada.organization_id, 'plano', -v_debito_plano, 'consumo:' || p_llm_call_id::text || ':plano', p_llm_call_id)
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
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id)
    values (v_chamada.organization_id, 'adicional', -v_debito_adicional, 'consumo:' || p_llm_call_id::text || ':adicional', p_llm_call_id)
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
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id)
    values (v_chamada.organization_id, 'avulso', -v_debito_avulso, 'consumo:' || p_llm_call_id::text || ':avulso', p_llm_call_id)
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

  -- Decisão 14: total DISPONÍVEL no ciclo é plano + adicional DESTE ciclo
  -- mais avulso (fonte sem ciclo, decisão 6), contra o consumido das mesmas
  -- três fontes. Sem teto (Ilimitado: nenhuma concessão, total creditado
  -- zero) não avisa nada.
  select
    coalesce(sum(creditado), 0),
    coalesce(sum(consumido), 0)
    into v_teto_total, v_consumido_ciclo
    from public.billing_token_wallets
    where organization_id = p_org
      and ((fonte in ('plano', 'adicional') and ciclo = p_ciclo) or (fonte = 'avulso' and ciclo is null));

  if v_teto_total > 0 then
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
        insert into public.billing_token_avisos_emitidos (organization_id, chave)
        values (p_org, 'limiar:' || p_ciclo::text || ':' || v_limiar::text)
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
      insert into public.billing_token_avisos_emitidos (organization_id, chave)
      values (p_org, 'teto_org_dia:' || p_dia::text)
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
      insert into public.billing_token_avisos_emitidos (organization_id, chave)
      values (p_org, 'teto_conversa_dia:' || p_dia::text || ':' || p_contact_id::text)
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
