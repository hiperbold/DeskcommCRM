-- 0901 — conexões MCP externas para os agentes (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork: o autor numera em sequência e anda rápido; um
-- número perto do dele colide no próximo merge (a nossa 0261 já colidiu).
--
-- Uma linha = um servidor MCP que a organização conectou. As ferramentas que
-- ele oferece ficam COPIADAS em `tools_cache`: o turno do agente precisa do
-- esquema de cada uma para montar o prompt, e não pode pagar uma ida ao
-- servidor externo a cada mensagem só para descobri-lo. A conexão de verdade
-- só abre quando o modelo decide chamar a ferramenta.
--
-- A credencial (`auth_header_value_encrypted`) é cifrada por fn_encrypt_oauth,
-- igual ao token da UAZAPI (0261). Por isso a tabela não é legível pela API
-- pública: anon e authenticated perdem todo acesso, e as rotas usam o client
-- admin com filtro programático por organização (mesmo desenho da 0257).
--
-- Idempotente: create if not exists, constraints nomeadas, revoke repetível.

create table if not exists public.ai_mcp_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  url text not null,
  auth_header_name text,
  auth_header_value_encrypted bytea,
  is_active boolean not null default true,
  tools_cache jsonb not null default '[]'::jsonb,
  tools_refreshed_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_mcp_connections_slug_formato check (slug ~ '^[a-z0-9]{2,12}$'),
  constraint ai_mcp_connections_nome_tamanho check (char_length(name) between 2 and 80),
  constraint ai_mcp_connections_url_https check (url ~ '^https://' and char_length(url) <= 500),
  constraint ai_mcp_connections_cabecalho_nome check (
    auth_header_name is null or auth_header_name ~ '^[A-Za-z0-9-]{1,64}$'
  ),
  constraint ai_mcp_connections_cabecalho_par check (
    (auth_header_name is null) = (auth_header_value_encrypted is null)
  ),
  constraint ai_mcp_connections_tools_cache_lista check (jsonb_typeof(tools_cache) = 'array'),
  constraint ai_mcp_connections_org_slug_key unique (organization_id, slug)
);

create index if not exists ai_mcp_connections_org_ativas_idx
  on public.ai_mcp_connections (organization_id)
  where is_active;

comment on table public.ai_mcp_connections is
  'Servidores MCP externos da organização (fork Hiperbold, 0901). Cada ferramenta em tools_cache vira a capacidade mcp_<slug>__<nome> no agente.';
comment on column public.ai_mcp_connections.slug is
  'Apelido IMUTÁVEL que prefixa o id das ferramentas (mcp_<slug>__<nome>). Renomear órfã as capacidades já publicadas nos agentes.';
comment on column public.ai_mcp_connections.auth_header_value_encrypted is
  'Valor do cabeçalho de acesso (ex.: "Bearer ..."), cifrado por fn_encrypt_oauth. Nunca devolvido pela API.';
comment on column public.ai_mcp_connections.tools_cache is
  'Cópia de tools/list: [{nome, descricao, input_schema, somente_leitura, id, recusada}]. Regravada ao cadastrar e em "Atualizar ferramentas".';

alter table public.ai_mcp_connections enable row level security;
revoke all on public.ai_mcp_connections from anon, authenticated;
grant select, insert, update, delete on public.ai_mcp_connections to service_role;

drop trigger if exists trg_ai_mcp_connections_updated_at on public.ai_mcp_connections;
create trigger trg_ai_mcp_connections_updated_at
  before update on public.ai_mcp_connections
  for each row execute function public.fn_set_updated_at();
