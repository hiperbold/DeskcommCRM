-- 0902: webhook_events_log_tenant_read passa a exigir papel manager ou acima.
--
-- Faixa 09xx reservada ao fork (ver 0901): o autor upstream numera em
-- sequência própria, e um número perto do dele colide no próximo merge.
--
-- ACHADO 1 (auditoria de segurança do canal UAZAPI, 2026-09-22): o corpo cru
-- do webhook da UAZAPI traz o token da instância em claro (campo `token`, ver
-- `lib/channels/uazapi/envelope.ts`), e `webhook_events_log.raw_body` /
-- `payload_parsed` guardam esse corpo. A policy antiga liberava SELECT para
-- QUALQUER membro ativo da organização, sem olhar papel, então um membro com
-- o papel mínimo lia a credencial da conexão só entrando na tabela.
--
-- O código já redige o valor das chaves sensíveis antes de gravar
-- (`lib/channels/arquivo-de-webhook.ts`, `redigirValoresSensiveis` /
-- `redigirTextoCru`); esta migration é a segunda metade do conserto, no
-- banco: reduz QUEM alcança a tabela, mesmo que uma chave nova escape da
-- lista de redação no futuro. Piso `manager`, o mesmo de `merge_queue`
-- (0113) e `campaigns` (0375), que também expõem dado sensível de operação.
--
-- `fn_role_at_least` é a função que o resto do repositório usa para conferir
-- papel nas policies (ver `merge_queue_manager_select` no baseline).

drop policy if exists webhook_events_log_tenant_read on public.webhook_events_log;

create policy webhook_events_log_tenant_read on public.webhook_events_log
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id is not null
      and organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );
