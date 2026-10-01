-- 0923, financeiro: escrita e exclusão no papel da rota (D-138, parte de D-127) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A policy `for all` das tabelas do financeiro conferia o papel só no `with check` (e
-- só `agent` onde a rota exige `manager`), e o DELETE só aplicava o `using` (ser membro):
-- qualquer membro, inclusive viewer, apagava lançamento pago, conta, forma de pagamento
-- e comanda direto pelo PostgREST. Cada tabela vira SELECT para membro mais escrita
-- por papel igual ao da rota:
--   sales: insert e update de agent; update só em comanda aberta; nenhum delete.
--   sale_items: agent, só enquanto a comanda é aberta e da mesma organização (D-127,
--     `fn_finalizar_comanda` soma por `sale_id` sem conferir organização).
--   financial_entries: insert de agent só `origin = 'manual'`; update e delete só em
--     lançamento ainda não pago (a rota já recusa o resto); delete só manual.
--   loyalty_ledger: só insert de agent (livro-razão, o estorno é função definer).
--   commission_rules, financial_accounts, payment_methods, account_plans: manager.
--   commissions: só leitura (quem grava é `fn_finalizar_comanda`, definer).
-- O ramo de admin de plataforma fica como estava. Reaplicável com o app no ar: um DO
-- por tabela (troca atômica das policies), lock_timeout curto. Sem função.

do $t_sales$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_sales_all on public.sales;
 drop policy if exists tenant_isolation_sales_select on public.sales;
 create policy tenant_isolation_sales_select on public.sales for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_sales_insert on public.sales;
 create policy tenant_isolation_sales_insert on public.sales for insert with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))));
 drop policy if exists tenant_isolation_sales_update on public.sales;
 create policy tenant_isolation_sales_update on public.sales for update using (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and status = 'open')) with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))));
end
$t_sales$;
do $t_sale_items$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_sale_items_all on public.sale_items;
 drop policy if exists tenant_isolation_sale_items_select on public.sale_items;
 create policy tenant_isolation_sale_items_select on public.sale_items for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_sale_items_insert on public.sale_items;
 create policy tenant_isolation_sale_items_insert on public.sale_items for insert with check (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = 'open')));
 drop policy if exists tenant_isolation_sale_items_update on public.sale_items;
 create policy tenant_isolation_sale_items_update on public.sale_items for update using (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = 'open'))) with check (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = 'open')));
 drop policy if exists tenant_isolation_sale_items_delete on public.sale_items;
 create policy tenant_isolation_sale_items_delete on public.sale_items for delete using (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = 'open')));
end
$t_sale_items$;
do $t_commission_rules$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_commission_rules_all on public.commission_rules;
 drop policy if exists tenant_isolation_commission_rules_select on public.commission_rules;
 create policy tenant_isolation_commission_rules_select on public.commission_rules for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_commission_rules_insert on public.commission_rules;
 create policy tenant_isolation_commission_rules_insert on public.commission_rules for insert with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
 drop policy if exists tenant_isolation_commission_rules_update on public.commission_rules;
 create policy tenant_isolation_commission_rules_update on public.commission_rules for update using ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))) with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
end
$t_commission_rules$;
do $t_financial_accounts$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_financial_accounts_all on public.financial_accounts;
 drop policy if exists tenant_isolation_financial_accounts_select on public.financial_accounts;
 create policy tenant_isolation_financial_accounts_select on public.financial_accounts for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_financial_accounts_insert on public.financial_accounts;
 create policy tenant_isolation_financial_accounts_insert on public.financial_accounts for insert with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
 drop policy if exists tenant_isolation_financial_accounts_update on public.financial_accounts;
 create policy tenant_isolation_financial_accounts_update on public.financial_accounts for update using ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))) with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
end
$t_financial_accounts$;
do $t_payment_methods$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_payment_methods_all on public.payment_methods;
 drop policy if exists tenant_isolation_payment_methods_select on public.payment_methods;
 create policy tenant_isolation_payment_methods_select on public.payment_methods for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_payment_methods_insert on public.payment_methods;
 create policy tenant_isolation_payment_methods_insert on public.payment_methods for insert with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
 drop policy if exists tenant_isolation_payment_methods_update on public.payment_methods;
 create policy tenant_isolation_payment_methods_update on public.payment_methods for update using ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))) with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
end
$t_payment_methods$;
do $t_account_plans$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_account_plans_all on public.account_plans;
 drop policy if exists tenant_isolation_account_plans_select on public.account_plans;
 create policy tenant_isolation_account_plans_select on public.account_plans for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_account_plans_insert on public.account_plans;
 create policy tenant_isolation_account_plans_insert on public.account_plans for insert with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
 drop policy if exists tenant_isolation_account_plans_update on public.account_plans;
 create policy tenant_isolation_account_plans_update on public.account_plans for update using ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))) with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager'))));
end
$t_account_plans$;
do $t_commissions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_commissions_all on public.commissions;
 drop policy if exists tenant_isolation_commissions_select on public.commissions;
 create policy tenant_isolation_commissions_select on public.commissions for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
end
$t_commissions$;
do $t_financial_entries$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_financial_entries_all on public.financial_entries;
 drop policy if exists tenant_isolation_financial_entries_select on public.financial_entries;
 create policy tenant_isolation_financial_entries_select on public.financial_entries for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_financial_entries_insert on public.financial_entries;
 create policy tenant_isolation_financial_entries_insert on public.financial_entries for insert with check (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and origin = 'manual'));
 drop policy if exists tenant_isolation_financial_entries_update on public.financial_entries;
 create policy tenant_isolation_financial_entries_update on public.financial_entries for update using (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and paid_at is null and status <> 'paid')) with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))));
 drop policy if exists tenant_isolation_financial_entries_delete on public.financial_entries;
 create policy tenant_isolation_financial_entries_delete on public.financial_entries for delete using (public.fn_is_platform_admin() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) and paid_at is null and status <> 'paid' and origin = 'manual'));
end
$t_financial_entries$;
do $t_loyalty_ledger$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_loyalty_ledger_all on public.loyalty_ledger;
 drop policy if exists tenant_isolation_loyalty_ledger_select on public.loyalty_ledger;
 create policy tenant_isolation_loyalty_ledger_select on public.loyalty_ledger for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()));
 drop policy if exists tenant_isolation_loyalty_ledger_insert on public.loyalty_ledger;
 create policy tenant_isolation_loyalty_ledger_insert on public.loyalty_ledger for insert with check ((public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent'))));
end
$t_loyalty_ledger$;
