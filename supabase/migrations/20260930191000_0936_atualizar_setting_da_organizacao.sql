-- 0936, uma chave de `organizations.settings` por vez, atômica (D-132, resto) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- `organizations.settings` é um jsonb compartilhado por vários escritores (política de MFA, atendimento,
-- campanhas, sons, régua de atrito, IA padrão, configuração do Jev). Cada um lia o objeto INTEIRO,
-- espalhava em memória e regravava o objeto inteiro em outro round-trip: o último apagava o que o
-- outro tinha acabado de gravar (a política de MFA gravada pelo admin sumia quando o gerente salvava a
-- régua de atrito). A 0157 fechou isso só para a marca.
--
-- `fn_atualizar_setting_da_organizacao(p_org, p_caminho, p_valor)` grava UMA chave (ou um caminho
-- aninhado) com `jsonb_set` sobre a linha travada, dentro da mesma transação, e nunca toca nas demais.
--   * `p_caminho` é a lista de chaves (`'{security,mfa_required}'`), de 1 a 4 níveis, sem item vazio;
--   * os níveis intermediários que faltam são criados como objeto; se um nível existente não for
--     objeto, a função recusa (22023) em vez de apagar um valor que não é dela;
--   * `p_valor` nulo (SQL NULL ou jsonb 'null') REMOVE a chave do caminho;
--   * devolve as linhas afetadas (0 = a organização não existe), como a 0157.
-- Autorização: servidor (`fn_billing_e_servidor`, o service_role dos handlers que já passaram pelo
-- gate de papel) ou admin da própria organização ou admin de plataforma; senão 42501. O EXECUTE vai só
-- para service_role, então o segundo ramo é a defesa para o dia em que o grant escapar.
-- Reaplicável com o app no ar: `create or replace` e grants idempotentes.
-- Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_atualizar_setting_da_organizacao(
  p_org     uuid,
  p_caminho text[],
  p_valor   jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_settings jsonb;
  v_nivel    integer;
  v_pai      jsonb;
  v_linhas   integer;
begin
  if p_org is null or p_caminho is null then
    raise exception 'setting_da_organizacao_argumento_nulo' using errcode = '22023';
  end if;
  if coalesce(array_length(p_caminho, 1), 0) not between 1 and 4
     or exists (select 1 from unnest(p_caminho) as c(k) where c.k is null or btrim(c.k) = '')
  then
    raise exception 'setting_da_organizacao_caminho_invalido' using errcode = '22023';
  end if;

  if not public.fn_billing_e_servidor()
     and not public.fn_role_at_least(p_org, 'admin')
     and not public.fn_is_platform_admin()
  then
    raise exception 'setting_da_organizacao_sem_permissao' using errcode = '42501';
  end if;

  -- A linha fica travada até o fim da transação: dois escritores de chaves diferentes se enfileiram
  -- aqui e cada um parte do estado que o outro acabou de gravar.
  select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    return 0;
  end if;

  if p_valor is null or jsonb_typeof(p_valor) = 'null' then
    v_settings := v_settings #- p_caminho;
  else
    -- jsonb_set só cria a ÚLTIMA chave; os pais que faltam são criados aqui.
    for v_nivel in 1 .. array_length(p_caminho, 1) - 1 loop
      v_pai := v_settings #> p_caminho[1:v_nivel];
      if v_pai is null or jsonb_typeof(v_pai) = 'null' then
        v_settings := jsonb_set(v_settings, p_caminho[1:v_nivel], '{}'::jsonb, true);
      elsif jsonb_typeof(v_pai) <> 'object' then
        raise exception 'setting_da_organizacao_caminho_atravessa_valor_que_nao_e_objeto'
          using errcode = '22023';
      end if;
    end loop;
    v_settings := jsonb_set(v_settings, p_caminho, p_valor, true);
  end if;

  update public.organizations o set settings = v_settings where o.id = p_org;
  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_atualizar_setting_da_organizacao(uuid, text[], jsonb) is
  'Grava UMA chave (ou caminho aninhado) de organizations.settings com a linha travada e jsonb_set, sem tocar nas demais. valor nulo remove a chave. Devolve linhas afetadas (0 = organização inexistente). Servidor, admin da organização ou admin de plataforma; senão 42501.';

revoke execute on function public.fn_atualizar_setting_da_organizacao(uuid, text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_atualizar_setting_da_organizacao(uuid, text[], jsonb)
  to service_role;
