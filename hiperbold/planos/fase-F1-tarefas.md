# Fase F1: catálogo de planos e contrato da organização

Parte do plano `hiperbold/planos/2026-09-22-planos-e-assinatura.md` (seção 11). Escrito em 23/09/2026 pelo loop da noite, revisado uma vez (achados incorporados; ver "Histórico da revisão" no fim).

**Objetivo da fase:** o banco passa a saber em que plano cada organização está, e o admin da plataforma consegue ver e trocar isso na mão. **Nada bloqueia nesta fase.** Toda organização, existente ou nova, fica no plano Ilimitado.

## Decisões de desenho (valem para todas as tarefas)

1. **Nomes do contrato comum Asaas**: `billing_plans` (catálogo) e `billing_contracts` (a assinatura da organização). O ajuste por organização é do CRM: `billing_plan_adjustments`. O `asaas_customer_id` NÃO entra no contrato: pelo manual ele mora em `billing_customers`, que nasce na F5.
2. **Versão de plano**: coluna `active boolean`, como no manual. **Uma única versão ativa por `code`** (índice único parcial `where active`). Mudar preço ou teto de um plano = nova versão ativa, a antiga fica inativa; o contrato aponta para a VERSÃO (`plan_id`), então quem já assinou mantém o preço que contratou. Toda busca por `code` usa `where active`.
3. **Divergência declarada do manual**: um plano guarda preço mensal e anual na mesma linha (o manual sugere uma linha por ciclo). Reconciliar na F5, quando o Asaas entrar.
4. **Tetos em `jsonb` com conjunto FECHADO de chaves, todas presentes** no plano. Valor inteiro entre 0 e 2147483647, ou `null` que significa sem limite. As chaves:
   - `funis`, `etapas_por_funil`, `leads`, `membros`, `conexoes`, `integracoes_webhook`, `tokens_ia_mes`

   Chave nova de limite exige migração que acrescente a chave a todos os planos. É aceitável: limitar um item novo exige código de contagem na F2 de qualquer jeito, então nunca é "só cadastro".
5. **Uma linha de contrato por organização** (`unique (organization_id)`), histórico na auditoria.
6. **Organização nova ganha contrato por gatilho no banco**, com `on conflict (organization_id) do nothing` (a F5 poderá criar o contrato na mesma transação).
7. **Escrita só por funções SQL `security definer` executáveis apenas pelo `service_role`**, chamadas depois da checagem no servidor. Elas travam a linha (`for update`), gravam e devolvem o antes e o depois, para a auditoria não mentir em troca concorrente. Nenhuma política de escrita para `authenticated`.
8. **Só admin da plataforma com escopo `full` escreve.** `support_readonly` lê e é recusado ao escrever.
9. **A precedência dos limites mora em UMA função SQL**, `fn_billing_limites_efetivos(org uuid) returns jsonb`, estável, uma consulta só. O servidor a chama por RPC; os gatilhos da F2 vão reaproveitar a mesma. Não há segunda implementação em TypeScript.
10. **Carência é dado do plano**: `grace_days integer not null default 7`.
11. **Preço em centavos inteiros.** Anual fica nulo até o Filipe responder (N8).
12. **O campo antigo `organizations.settings.plan`** (valores `standard | pro | enterprise`, gravado pela criação de organização do autor) é aposentado como fonte de plano: a tela para de mostrá-lo e de oferecê-lo, e nada novo pode lê-lo. A função SQL do autor que o grava não é tocada. Registrado no débito.

## Dados semeados

| code | nome | à venda | mensal (centavos) | carência (dias) | funis | etapas_por_funil | leads | membros | conexoes | integracoes_webhook | tokens_ia_mes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ilimitado | Ilimitado | não | 0 | 7 | null | null | null | null | null | null | null |
| pro | Pro | não | 19900 | 7 | 5 | 10 | 5000 | 3 | 3 | 3 | 1000000 |
| max | Max | não | 39900 | 7 | 10 | 15 | 50000 | 15 | 10 | 10 | 1000000 |
| escale | Scale | não | 59900 | 7 | 25 | 20 | 100000 | 30 | 20 | 20 | 1000000 |

Todos `version = 1`, `active = true`. Semeadura idempotente (`on conflict (code, version) do nothing`): o baseline roda de novo a cada atualização de produção e **não pode sobrescrever** um preço mudado depois.

---

## Tarefa 1: as tabelas e funções, na migração 0904 e no baseline

**Arquivos:** `supabase/migrations/20260923020000_0904_planos_de_assinatura.sql` (novo), `supabase/baseline.sql` (bloco novo ANTES de `-- ---- VARREDURA anon:`), `supabase/migrations/MANIFEST.md` (linha nova, no formato das linhas da 0901 a 0903), `tests/unit/planos-migration.test.ts` (novo).

**A migração tem o MESMO texto idempotente do bloco do baseline** (`if not exists`, `or replace`, `drop ... if exists` antes de `create policy` e `create trigger`). Conteúdo, nesta ordem:

1. `fn_billing_limites_validos(l jsonb, parcial boolean) returns boolean`, imutável: objeto; só chaves do conjunto fechado; se `parcial = false`, todas presentes; cada valor `null` ou número inteiro entre 0 e 2147483647.
2. `billing_plans`: `id uuid pk default gen_random_uuid()`, `code text not null check (code ~ '^[a-z][a-z0-9_]{1,30}$')`, `version integer not null default 1 check (version >= 1)`, `active boolean not null default true`, `name text not null`, `for_sale boolean not null default false`, `price_monthly_cents integer not null check (>= 0)`, `price_yearly_cents integer null check (>= 0)`, `grace_days integer not null default 7 check (between 0 and 90)`, `limits jsonb not null check (fn_billing_limites_validos(limits, false))`, `created_at`, `updated_at`. `unique (code, version)`. Índice único parcial `(code) where active`.
3. `billing_contracts`: `id uuid pk`, `organization_id uuid not null references organizations(id) on delete cascade`, `plan_id uuid not null references billing_plans(id)`, `status text not null default 'ativa'` (check: `avaliacao`, `ativa`, `atrasada`, `suspensa`, `cancelada`), `cycle text null` (check: `monthly`, `yearly`), `gateway text null` (check: `asaas`), `current_period_start timestamptz null`, `current_period_end timestamptz null`, `cancel_at_period_end boolean not null default false`, `asaas_subscription_id text null unique`, `created_at`, `updated_at`. `unique (organization_id)`.
4. `billing_plan_adjustments`: `organization_id uuid pk references organizations(id) on delete cascade`, `limits jsonb not null check (fn_billing_limites_validos(limits, true))`, `note text null check (char_length(note) <= 500)`, `granted_by uuid null references auth.users(id) on delete set null`, `created_at`, `updated_at`.
5. Gatilho `updated_at` nas três, com `fn_set_updated_at()`.
6. Semeadura dos quatro planos (tabela acima).
7. Contrato Ilimitado para toda organização existente sem contrato (`insert ... select ... where not exists`), apontando para a versão ATIVA do Ilimitado.
8. `fn_billing_contrato_da_organizacao_nova()`, `security definer`, `set search_path = public, pg_temp`, e o gatilho `after insert on organizations`. Insere com `on conflict (organization_id) do nothing`. Se não houver Ilimitado ativo: não insere, `raise warning`, e a criação da organização segue.
9. `fn_billing_limites_efetivos(p_org uuid) returns jsonb`, `stable`, `security definer`, `search_path` fixo, UMA consulta: para cada chave do plano ativo do contrato, o valor do ajuste vence se a chave estiver presente no ajuste (inclusive `null`); senão vale o do plano. Organização sem contrato: devolve os limites do Ilimitado ativo.
10. `fn_billing_trocar_plano(p_org uuid, p_plan_code text, p_actor uuid) returns jsonb` e `fn_billing_ajustar_limites(p_org uuid, p_limits jsonb, p_note text, p_actor uuid) returns jsonb`, ambas `security definer`, `search_path` fixo:
    - trocar: confere que a organização existe e que o plano ativo com o código existe (senão `raise exception` com código próprio, sem texto de dado); trava o contrato com `for update`; faz `insert ... on conflict (organization_id) do update set plan_id = ...`; devolve `{antes: {plan_code, version}, depois: {plan_code, version}}`.
    - ajustar: confere a organização; `p_limits` vazio (`'{}'`) apaga o ajuste; senão faz upsert; devolve `{antes, depois}` do `limits`.
11. RLS ligada nas três. Políticas:
    - `billing_plans`: `select` para `authenticated` (`using (true)`).
    - `billing_contracts` e `billing_plan_adjustments`: `select` com `organization_id in (select fn_user_org_ids()) or fn_is_platform_admin()`.
    - Nenhuma política de escrita.
12. `revoke all on` as três `from anon`; `revoke insert, update, delete on` as três `from authenticated`; `grant all ... to service_role`. Toda função nova: `revoke execute ... from public, anon, authenticated` e `grant execute ... to service_role`. EXCEÇÃO: `fn_billing_limites_validos` precisa ser executável por quem escreve na tabela (o check roda no contexto de quem escreve), então fica com o `grant` padrão; ela é pura e não lê nada.

**Teste que prova (`tests/unit/planos-migration.test.ts`)**, no estilo de `tests/unit/mcp-externo-migration.test.ts`: o bloco existe no baseline, está antes de `-- ---- VARREDURA anon:`, as três tabelas têm `enable row level security`, não há `create policy` de `insert`, `update`, `delete` ou `all` nas três, a semeadura usa `on conflict do nothing`, os números semeados batem com a tabela desta fase, e as funções de escrita têm `revoke execute` de `authenticated`.

**Critério de pronto:** o arquivo da migração aplicado DUAS vezes no banco local sem erro (`docker exec -i supabase_db_deskcomm-crm psql -U postgres -d postgres -v ON_ERROR_STOP=1 < arquivo`), o bloco do baseline também aplicado duas vezes sem erro, e o teste unitário verde.

## Tarefa 2: provas de banco

**Arquivos:**
- `tests/invariants/planos-de-assinatura.test.ts` (novo)
- `tests/invariants/rls-isolation.test.ts`: acrescentar `billing_contracts` e `billing_plan_adjustments` à lista `TABLES`, E uma linha de `billing_plan_adjustments` por organização semeada, dentro do bloco `$seed$`, porque o teste exige que cada organização leia ao menos uma linha própria (controle positivo, linhas 645 a 651). O `billing_contracts` já nasce pelo gatilho. **Só essas duas mudanças nesse arquivo.** Exigência do checklist de contribuição do próprio projeto (`.claude/skills/deskcomm-contribuir/references/pre-voo.md`).

**O que o teste novo prova**, seguindo o padrão de `tests/invariants/mcp-nao-alcanca-outro-tenant.test.ts` (leia antes):
1. Organização criada depois da migração nasce com contrato no Ilimitado ativo.
2. Sem Ilimitado ativo, a organização ainda é criada, sem contrato (e sem erro).
3. Membro da organização A lê o próprio contrato e ajuste, e NÃO lê os da organização B.
4. Membro comum e admin da organização não conseguem `insert`, `update` nem `delete` nas três tabelas, nem executar as funções de escrita.
5. `fn_billing_limites_validos` recusa chave desconhecida, chave faltando (no modo completo), número negativo, número quebrado, número acima de 2147483647 e texto; aceita parcial no modo parcial.
6. `fn_billing_limites_efetivos`: ajuste vence; ajuste `null` libera; chave ausente no ajuste herda do plano; organização sem contrato recebe o Ilimitado.
7. `fn_billing_trocar_plano`: organização sem contrato RECEBE o contrato (upsert); duas trocas seguidas devolvem o "antes" certo na segunda; plano inexistente e plano inativo são recusados.
8. A semeadura rodada duas vezes não duplica e não sobrescreve um preço alterado entre as duas.

**Critério de pronto:** `pnpm test:db` verde (bateria inteira de banco, uns 10 minutos).

**Não tocar:** nenhum outro arquivo em `tests/invariants/`.

## Tarefa 3: o módulo de leitura de plano

**Arquivos:** `lib/billing/planos/limites.ts` (novo), `lib/billing/planos/plano-da-organizacao.ts` (novo), `tests/unit/planos-limites.test.ts` (novo).

- `limites.ts`: a lista fechada de chaves (`CHAVES_DE_LIMITE`), o tipo `Limites`, e os esquemas zod do plano (todas as chaves) e do ajuste (parcial), com o teto de 2147483647. Sem função de precedência: ela mora no banco.
- `plano-da-organizacao.ts`: `planoDaOrganizacao(admin, organizationId)` devolve `{ plano, contrato: { status, cycle } | null, limites, leituraFalhou: boolean }`. `limites` vem de `fn_billing_limites_efetivos` por RPC. Três casos distintos:
  - contrato existe: devolve tudo;
  - sem contrato: plano Ilimitado, `contrato: null`, `log.warn`;
  - **erro de leitura do banco**: `leituraFalhou: true`, limites todos `null`, e `log.error` com a marca `alarme_planos_leitura`. Nunca lança: esta função vai para o caminho de criação na F2, e não pode derrubar nada. A decisão de liberar em caso de erro é deliberada e fica escrita no comentário.

**Teste que prova:** os três casos, e que o esquema do ajuste recusa chave estranha e número acima do teto.

## Tarefa 4: as ações do admin da plataforma

**Arquivos:** `app/actions/admin/planoDaOrganizacao.ts` (novo), `lib/audit/index.ts` (ou onde estiver a lista `AUDIT_ACTIONS`: acrescentar `billing.plan_changed` e `billing.adjustment_granted`), `tests/unit/planos-acoes-do-admin.test.ts` (novo).

Duas server actions, no padrão de `app/actions/admin/salvarConfiguracaoDaInstalacao.ts`:
1. `trocarPlanoDaOrganizacao({ organizationId, planCode })`
2. `ajustarLimitesDaOrganizacao({ organizationId, limites, nota })` (objeto vazio remove o ajuste)

Cada uma: `requirePlatformAdmin()` primeiro, e **recusa quando o escopo não é `full`** (veja como `app/api/v1/admin/tenants/route.ts:166` confere); entrada validada com zod; escrita chamando a função SQL correspondente pelo cliente de serviço; `audit()` com o antes e o depois que a FUNÇÃO devolveu (não uma leitura separada); erro com frase fixa, nunca `error.message` do banco; `revalidatePath` da aba.

**Teste que prova:** não-admin recusado sem escrever; admin `support_readonly` recusado sem escrever; plano inexistente recusado; organização inexistente recusada; auditoria com o antes e o depois devolvidos pela função; erro de banco não aparece na resposta.

## Tarefa 5: a aba "Plano" no painel do admin da plataforma

**Arquivos:** `app/admin/(protected)/tenants/[id]/layout.tsx` (só acrescentar a aba na lista `TABS`), `app/admin/(protected)/tenants/[id]/plano/page.tsx` e `_client.tsx` (novos), `lib/i18n/dicionario.ts` (textos novos, com a versão em espanhol).

A aba mostra: o plano atual, a versão e o estado do contrato; uma tabela com cada limite em três colunas (do plano, do ajuste, em vigor), com "sem limite" no lugar de `null`; um seletor para trocar o plano (só planos ativos); e o ajuste com **um seletor por chave com três opções explícitas: herdar do plano, sem limite, valor** (o campo de número só aparece em "valor"). Campo em branco nunca vira "sem limite". Nota do ajuste. Toda escrita vai pelas ações da tarefa 4. Admin `support_readonly` vê a aba sem os controles de escrita. Aviso visível: "Nesta fase nenhum limite bloqueia; eles só passam a valer quando o bloqueio for ligado."

**Teste que prova:** a conversão do formulário (herdar remove a chave, sem limite vira `null`, valor vira número) como função pura testada em `tests/unit/`. O resto da tela fica para a conferência manual do Filipe.

**Não tocar:** as outras abas.

## Tarefa 6: aposentar o "Plano" antigo da criação de organização

**Arquivos:** `app/admin/(protected)/tenants/new/_form.tsx` (tirar o seletor de plano), `lib/schemas/tenant-creation.ts` (o campo passa a opcional, sem ser oferecido), `components/admin/tenants/TenantOverview.tsx` (a linha "Plano" passa a mostrar o plano do contrato, pela mesma leitura da tarefa 3), e os testes existentes que quebrarem por isso (ajustados com o motivo escrito).

A rota `app/api/v1/admin/tenants/route.ts` continua aceitando o campo, para não quebrar quem chama a API, mas ele deixa de significar plano. A função SQL do autor não muda.

**Teste que prova:** a Visão Geral mostra o plano do contrato; o formulário não oferece mais o campo.

---

## Fechamento da fase

1. Revisor na fase inteira.
2. Auditor com o foco da seção 6 do prompt do loop, especialmente: nenhuma escrita para `authenticated`; isolamento entre organizações provado em banco; funções `security definer` com `search_path` fixo e `execute` revogado de quem não deve; escopo `full` exigido; nada vindo do navegador decidindo organização ou plano sem conferência.
3. Portões completos: typecheck, lint, lint:channels, unitários, test:db, build.

## Para as fases seguintes (registrado, não é desta fase)

- A F2 NUNCA lê `organizations.settings.plan`.
- A relação entre `organizations.status` (ativa, suspensa, redigida, arquivada) e `billing_contracts.status` precisa ser decidida na F2 (contagem) e na F4 (cobrança). Organização arquivada hoje recebe contrato Ilimitado pelo preenchimento inicial.

## Histórico da revisão

Revisão 1 (23/09/2026): 2 achados altos (lista `TABLES` exige linha semeada do ajuste; admin `support_readonly` conseguiria escrever), 7 médios (campo `settings.plan` antigo, troca sem contrato, troca concorrente e auditoria, versão de plano, precedência só em TypeScript, erro de leitura liberando sem alarme, campo em branco virando "sem limite") e 7 baixos. Todos incorporados acima.
