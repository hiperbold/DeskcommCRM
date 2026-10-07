-- 0948, o token da URL de webhook só é lido pelo servidor (D-128) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- `channel_sessions.webhook_path_token`, `webhook_sources.path_token` e
-- `tenant_integrations.webhook_path_token` eram legíveis pela sessão de qualquer membro (inclusive
-- Somente leitura) direto pela REST. Quem tem o token posta na rota pública: na conexão e no status
-- (que passam só com o token da URL) marca o canal como caído ou forja status de entrega, e em fonte
-- de webhook sem segredo injeta lead falso.
-- Medido no código antes de revogar: nenhum leitor com a sessão do usuário pede essa coluna. Os
-- canais (oficial, UAZAPI, parceiro, social, WAHA) e a Nuvemshop leem pelo cliente admin; as rotas de
-- `webhook-sources` passaram a ler o token pelo cliente de servidor, depois de conferido o papel.
-- Forma: `revoke select` de tabela mais `grant select` por lista de colunas, a mesma da 0261 e da 0150
-- (revoke de uma coluna só não tira o que o grant de tabela deu). A lista sai do catálogo no momento
-- de aplicar, então não depende de lembrar coluna nenhuma. Coluna criada depois NASCE sem SELECT para
-- `authenticated`: é o lado seguro, e o invariante reprova até alguém decidir se ela entra no grant.
-- Nada de INSERT, UPDATE e DELETE muda.
-- ORDEM DE PUBLICAÇÃO: código novo antes (ou junto). Código antigo que pede o token pela sessão
-- (`webhook-sources`) responde 500 depois desta migration.
-- Reaplicável com o app no ar: um DO só (revoke e grant na mesma transação), lock_timeout curto.
-- Sem função: nada a ver com a VARREDURA anon.

do $d128$
declare
  alvo record;
  colunas text;
begin
  perform set_config('lock_timeout', '3s', true);
  for alvo in
    select * from (values
      ('channel_sessions', 'webhook_path_token'),
      ('webhook_sources', 'path_token'),
      ('tenant_integrations', 'webhook_path_token')
    ) as v(tabela, coluna)
  loop
    select string_agg(format('%I', a.attname), ', ' order by a.attnum)
      into colunas
      from pg_attribute a
     where a.attrelid = format('public.%I', alvo.tabela)::regclass
       and a.attnum > 0
       and not a.attisdropped
       and a.attname <> alvo.coluna;
    execute format('revoke select on public.%I from authenticated, anon', alvo.tabela);
    execute format('grant select (%s) on public.%I to authenticated', colunas, alvo.tabela);
  end loop;
end
$d128$;

notify pgrst, 'reload schema';
