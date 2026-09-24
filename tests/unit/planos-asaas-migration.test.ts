import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_0909 = readFileSync(
  join(process.cwd(), "supabase/migrations/20260924140000_0909_planos_asaas.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/**
 * Extrai o bloco 0909 do baseline: do marcador de início até (sem incluir) o
 * cabeçalho do PRÓXIMO bloco (`-- ---- `). Mesmo extrator das migrações
 * 0905/0906/0907/0908 (tests/unit/planos-*-migration.test.ts).
 */
function extraiBloco0909Baseline(): string {
  const marcadorInicio = "-- ---- cobrança pelo Asaas: tabelas (migration 0909";
  const posicaoMarcador = BASELINE.indexOf(marcadorInicio);
  const fim = BASELINE.indexOf("\n-- ---- ", posicaoMarcador);
  return BASELINE.slice(posicaoMarcador, fim + 1);
}

/** Remove linhas de comentário (--) e linhas em branco, para comparar só o SQL. */
function removeComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0909 cobrança pelo Asaas (Tarefas 1 e 2): posição e igualdade do bloco no baseline", () => {
  it("o bloco vem depois do bloco da 0908 e antes da VARREDURA anon", () => {
    const inicioBloco0908 = BASELINE.indexOf(
      "-- ---- pagamentos, estados e conferidor de vencimento da assinatura (migration 0908",
    );
    const inicioBloco0909 = BASELINE.indexOf("-- ---- cobrança pelo Asaas: tabelas (migration 0909");
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");

    expect(inicioBloco0908).toBeGreaterThan(-1);
    expect(inicioBloco0909).toBeGreaterThan(-1);
    expect(varreduraAnon).toBeGreaterThan(-1);
    expect(inicioBloco0908).toBeLessThan(inicioBloco0909);
    expect(inicioBloco0909).toBeLessThan(varreduraAnon);
  });

  it("o SQL da migração 0909 e o SQL do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    const sqlMigracao = removeComentariosEBrancas(MIGRATION_0909);
    const sqlBloco = removeComentariosEBrancas(extraiBloco0909Baseline());
    expect(sqlBloco).toBe(sqlMigracao);
  });

  it("nenhum travessão (U+2014) na migração nem no bloco do baseline", () => {
    const travessao = String.fromCharCode(8212);
    expect(MIGRATION_0909).not.toContain(travessao);
    expect(extraiBloco0909Baseline()).not.toContain(travessao);
  });
});

describe("0909: billing_customers (decisão 16)", () => {
  it("colunas e checks: ambiente, formato do asaas_customer_id, dois únicos", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/create table if not exists public\.billing_customers \(/);
      expect(sql).toMatch(
        /constraint billing_customers_ambiente_check check \(ambiente in \('sandbox', 'producao'\)\)/,
      );
      expect(sql).toMatch(
        /constraint billing_customers_asaas_customer_id_formato check \(asaas_customer_id ~ '\^cus_\[A-Za-z0-9\]\{1,64\}\$'\)/,
      );
      expect(sql).toMatch(
        /constraint billing_customers_organization_ambiente_unique unique \(organization_id, ambiente\)/,
      );
      expect(sql).toMatch(
        /constraint billing_customers_ambiente_asaas_customer_id_unique unique \(ambiente, asaas_customer_id\)/,
      );
    }
  });

  it("organization_id em cascata; criado_por SEM chave estrangeira", () => {
    const corpo = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create table if not exists public.billing_customers"),
      MIGRATION_0909.indexOf("create table if not exists public.billing_orders"),
    );
    expect(corpo).toMatch(/organization_id uuid not null references public\.organizations\(id\) on delete cascade,/);
    expect(corpo).not.toMatch(/criado_por uuid references/);
  });
});

describe("0909: billing_orders (decisões 2, 6, 11, 25)", () => {
  it("external_reference é coluna GERADA a partir do id, e única", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /external_reference text generated always as \('HC:ord:' \|\| id::text\) stored,/,
      );
      expect(sql).toMatch(/constraint billing_orders_external_reference_unique unique \(external_reference\)/);
    }
  });

  it("status aceita processando, e o vocabulário fechado completo", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint billing_orders_status_check check \(\s*\n\s*status in \('criado', 'processando', 'aguardando_pagamento', 'inconclusivo', 'pago', 'vencido', 'cancelado', 'falhou', 'estornado'\)\s*\n\s*\),/,
      );
    }
  });

  it("índice único parcial de pedido aberto inclui processando (decisão 25)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_aberto_por_tipo_unique\s*\n\s*on public\.billing_orders \(organization_id, tipo\)\s*\n\s*where status in \('criado', 'aguardando_pagamento', 'inconclusivo', 'processando'\);/,
      );
    }
  });

  it("checks de coerência por tipo: assinatura exige plan_id/ciclo e proíbe pacote_id/tokens, e vice-versa", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint billing_orders_coerencia_assinatura check \(\s*\n\s*tipo <> 'assinatura' or \(plan_id is not null and ciclo is not null and pacote_id is null and tokens is null\)\s*\n\s*\),/,
      );
      expect(sql).toMatch(
        /constraint billing_orders_coerencia_pacote check \(\s*\n\s*tipo <> 'pacote_tokens' or \(pacote_id is not null and tokens is not null and plan_id is null and ciclo is null\)\s*\n\s*\)/,
      );
    }
  });

  it("(organization_id, chave) único (decisão 11)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint billing_orders_organization_chave_unique unique \(organization_id, chave\)/,
      );
    }
  });

  it("asaas_payment_id, asaas_subscription_id e invoice_url: únicos parciais (só quando preenchidos, sem CHECK de formato aqui)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_asaas_payment_id_unique\s*\n\s*on public\.billing_orders \(asaas_payment_id\)\s*\n\s*where asaas_payment_id is not null;/,
      );
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_asaas_subscription_id_unique\s*\n\s*on public\.billing_orders \(asaas_subscription_id\)\s*\n\s*where asaas_subscription_id is not null;/,
      );
      expect(sql).toMatch(
        /create unique index if not exists billing_orders_invoice_url_unique\s*\n\s*on public\.billing_orders \(invoice_url\)\s*\n\s*where invoice_url is not null;/,
      );
    }
    const corpoOrders = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create table if not exists public.billing_orders"),
      MIGRATION_0909.indexOf(");", MIGRATION_0909.indexOf("create table if not exists public.billing_orders")),
    );
    expect(corpoOrders).not.toMatch(/asaas_payment_id text check/);
    expect(corpoOrders).not.toMatch(/asaas_subscription_id text check/);
  });

  it("amount_cents positivo; metodo só CREDIT_CARD/PIX", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/constraint billing_orders_amount_cents_positivo check \(amount_cents > 0\)/);
      expect(sql).toMatch(/constraint billing_orders_metodo_check check \(metodo in \('CREDIT_CARD', 'PIX'\)\)/);
    }
  });

  it("trg_billing_orders_updated_at existe (mesmo padrão de billing_contracts/billing_settings)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/drop trigger if exists trg_billing_orders_updated_at on public\.billing_orders;/);
      expect(sql).toMatch(
        /create trigger trg_billing_orders_updated_at\s*\n\s*before update on public\.billing_orders\s*\n\s*for each row execute function public\.fn_set_updated_at\(\);/,
      );
    }
  });
});

describe("0909: asaas_webhook_events (decisões 19, 20, 21)", () => {
  it("event_id único com tamanho 1..100; event_type com formato fechado", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/constraint asaas_webhook_events_event_id_unique unique \(event_id\)/);
      expect(sql).toMatch(
        /constraint asaas_webhook_events_event_id_tamanho check \(char_length\(event_id\) between 1 and 100\)/,
      );
      expect(sql).toMatch(
        /constraint asaas_webhook_events_event_type_formato check \(event_type ~ '\^\[A-Z_\]\{3,64\}\$'\)/,
      );
    }
  });

  it("resultado: vocabulário fechado com os oito valores da decisão 3/19", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /constraint asaas_webhook_events_resultado_check check \(\s*\n\s*resultado in \('aplicado', 'ja_aplicado', 'ignorado', 'outro_app', 'sem_vinculo', 'divergente', 'aguardando', 'erro'\)\s*\n\s*\),/,
      );
    }
  });

  it("lease_token e lease_expira_em existem (decisão 20)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/lease_token uuid,/);
      expect(sql).toMatch(/lease_expira_em timestamptz,/);
    }
  });

  it("organization_id SEM chave estrangeira, de propósito", () => {
    const corpo = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create table if not exists public.asaas_webhook_events"),
      MIGRATION_0909.indexOf(
        ");",
        MIGRATION_0909.indexOf("create table if not exists public.asaas_webhook_events"),
      ),
    );
    expect(corpo).toMatch(/organization_id uuid,/);
    expect(corpo).not.toMatch(/organization_id uuid references/);
  });

  it("índice dos pendentes por proxima_tentativa_em onde resultado = aguardando", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /create index if not exists asaas_webhook_events_pendentes_idx\s*\n\s*on public\.asaas_webhook_events \(proxima_tentativa_em\)\s*\n\s*where resultado = 'aguardando';/,
      );
    }
  });
});

describe("0909: billing_contracts.asaas_assinatura_encerrada_em (decisão 22)", () => {
  it("coluna nova, nullable, sem default", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_contracts add column if not exists asaas_assinatura_encerrada_em timestamptz;/,
      );
    }
  });
});

describe("0909: billing_payments (decisões 8, 9)", () => {
  it("order_id: FK para billing_orders, on delete set null (não cascade)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments add column if not exists order_id uuid references public\.billing_orders\(id\) on delete set null;/,
      );
    }
  });

  it("origem: not null default manual, CHECK manual/asaas", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments add column if not exists origem text not null default 'manual';/,
      );
      expect(sql).toMatch(/alter table public\.billing_payments drop constraint if exists billing_payments_origem_check;/);
      expect(sql).toMatch(
        /alter table public\.billing_payments add constraint billing_payments_origem_check check \(origem in \('manual', 'asaas'\)\);/,
      );
    }
  });

  it("CHECK de status recriado (drop + add) com os cinco valores do vocabulário Asaas", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments drop constraint if exists billing_payments_status_check;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments add constraint billing_payments_status_check check \(\s*\n\s*status in \('RECEIVED_IN_CASH', 'CONFIRMED', 'RECEIVED', 'REFUNDED', 'CHARGEBACK_REQUESTED'\)\s*\n\s*\);/,
      );
    }
  });

  it("billing_period_start/end perdem NOT NULL, e o CHECK só permite nulo com origem=asaas", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_payments alter column billing_period_start drop not null;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments alter column billing_period_end drop not null;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments drop constraint if exists billing_payments_periodo_check;/,
      );
      expect(sql).toMatch(
        /alter table public\.billing_payments add constraint billing_payments_periodo_check check \(\s*\n\s*\(billing_period_start is null\) = \(billing_period_end is null\)\s*\n\s*and \(billing_period_start is not null or origem = 'asaas'\)\s*\n\s*\);/,
      );
    }
  });

  it("índice de estorna_pagamento_id recriado (drop + create), restrito a status = REFUNDED (decisão 9)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(/drop index if exists billing_payments_estorna_pagamento_id_unique;/);
      expect(sql).toMatch(
        /create unique index if not exists billing_payments_estorna_pagamento_id_unique\s*\n\s*on public\.billing_payments \(estorna_pagamento_id\)\s*\n\s*where estorna_pagamento_id is not null and status = 'REFUNDED';/,
      );
    }
  });
});

describe("0909: billing_settings.compra_pelo_cliente (decisão 18)", () => {
  it("boolean not null default false", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /alter table public\.billing_settings add column if not exists compra_pelo_cliente boolean not null default false;/,
      );
    }
  });
});

describe("0909: fn_billing_protege_assinatura_asaas + trg_billing_protege_assinatura_asaas (decisão 22)", () => {
  it("a função raise exception quando asaas_subscription_id preenchido e o marcador nulo, e SEMPRE devolve old (nunca null)", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      const inicio = sql.indexOf("create or replace function public.fn_billing_protege_assinatura_asaas()");
      expect(inicio, "fn_billing_protege_assinatura_asaas não encontrada").toBeGreaterThan(-1);
      const fim = sql.indexOf("$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      expect(corpo).toMatch(/security definer/);
      expect(corpo).toMatch(/set search_path = public, pg_temp/);
      expect(corpo).toMatch(
        /if old\.asaas_subscription_id is not null and old\.asaas_assinatura_encerrada_em is null then\s*\n\s*raise exception 'billing_cancele_no_asaas_antes' using errcode = '22023';\s*\n\s*end if;/,
      );
      expect(corpo).toMatch(/return old;/);
      expect(corpo).not.toMatch(/return null;/);
    }
  });

  it("é BEFORE DELETE em billing_contracts (drop trigger if exists + create trigger)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /drop trigger if exists trg_billing_protege_assinatura_asaas on public\.billing_contracts;/,
      );
      expect(sql).toMatch(
        /create trigger trg_billing_protege_assinatura_asaas\s*\n\s*before delete on public\.billing_contracts\s*\n\s*for each row execute function public\.fn_billing_protege_assinatura_asaas\(\);/,
      );
    }
  });

  it("revoga execute de public/anon/authenticated e concede só a service_role", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_protege_assinatura_asaas\(\) from public, anon, authenticated;/,
      );
      expect(sql).toMatch(
        /grant execute on function public\.fn_billing_protege_assinatura_asaas\(\) to service_role;/,
      );
    }
  });

  it("agent_worker (se a role existir) perde execute na função de gatilho", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      expect(sql).toMatch(
        /revoke execute on function public\.fn_billing_protege_assinatura_asaas\(\) from agent_worker/,
      );
    }
  });
});

describe("0909: grants das três tabelas novas (Tarefa 2)", () => {
  const TABELAS = ["billing_customers", "billing_orders", "asaas_webhook_events"] as const;

  it("RLS ligada nas três, sem nenhuma policy criada por esta migração", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(new RegExp(`alter table public\\.${tabela} enable row level security;`));
      }
    }
    for (const tabela of TABELAS) {
      expect(MIGRATION_0909).not.toMatch(new RegExp(`create policy[^;]*on public\\.${tabela}`));
    }
  });

  it("revoke all de anon/authenticated nas três", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(new RegExp(`revoke all on public\\.${tabela} from anon, authenticated;`));
      }
    }
  });

  it("service_role só select nas três (revoke insert/update/delete/truncate logo depois do grant select)", () => {
    for (const sql of [MIGRATION_0909, BASELINE]) {
      for (const tabela of TABELAS) {
        expect(sql).toMatch(new RegExp(`grant select on public\\.${tabela} to service_role;`));
        expect(sql).toMatch(
          new RegExp(`revoke insert, update, delete, truncate on public\\.${tabela} from service_role;`),
        );
      }
    }
  });

  it("agent_worker (se a role existir) perde select/insert/update/delete/truncate nas três, num único bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      expect(sql).toMatch(/if exists \(select 1 from pg_roles where rolname = 'agent_worker'\) then/);
      expect(sql).toMatch(
        /revoke select, insert, update, delete, truncate on public\.billing_customers, public\.billing_orders, public\.asaas_webhook_events from agent_worker/,
      );
    }
  });
});

describe("0909: nenhuma chamada real ao Asaas (restrição fixa 1 da fase)", () => {
  it("a migração não referencia URL de API nem chave do Asaas", () => {
    expect(MIGRATION_0909).not.toMatch(/api\.asaas\.com/);
    expect(MIGRATION_0909).not.toMatch(/api-sandbox\.asaas\.com/);
    expect(MIGRATION_0909).not.toMatch(/aact_/);
  });
});

// ============================================================================
// TAREFA 3: pedido, cliente e chaves.
// ============================================================================

describe("0909 Tarefa 3: as sete funções existem, com a assinatura do plano, em security definer", () => {
  const FUNCOES: Array<{ nome: string; assinatura: string }> = [
    { nome: "fn_billing_definir_compra_pelo_cliente", assinatura: "(boolean, uuid)" },
    { nome: "fn_billing_definir_a_venda", assinatura: "(text, boolean, uuid)" },
    {
      nome: "fn_billing_criar_pedido",
      assinatura: "(uuid, text, text, text, text, text, text, uuid, uuid)",
    },
    { nome: "fn_billing_pedido_tomar", assinatura: "(uuid, uuid)" },
    { nome: "fn_billing_vincular_cliente_asaas", assinatura: "(uuid, text, text)" },
    {
      nome: "fn_billing_pedido_registrar_cobranca",
      assinatura: "(uuid, uuid, text, text, text)",
    },
    { nome: "fn_billing_pedido_marcar", assinatura: "(uuid, uuid, text, text)" },
  ];

  it.each(FUNCOES)("$nome$assinatura existe na migração e no bloco do baseline, com security definer e search_path fixo", ({ nome, assinatura }) => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      const criacao = new RegExp(`create or replace function public\\.${nome}\\(`);
      expect(sql, `${nome} não encontrada`).toMatch(criacao);

      const inicio = sql.indexOf(`create or replace function public.${nome}(`);
      const fim = sql.indexOf("\n$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      expect(corpo, `${nome} sem security definer`).toMatch(/security definer/);
      expect(corpo, `${nome} sem search_path fixo`).toMatch(/set search_path = public, pg_temp/);

      const assinaturaEscapada = assinatura.replace(/[()]/g, (c) => `\\${c}`);
      expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated`).toMatch(
        new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated;`),
      );
      expect(sql, `${nome}${assinatura} não tem grant só a service_role`).toMatch(
        new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
      );
    }
  });

  it("agent_worker (se a role existir) perde execute nas sete funções, num único bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      // Âncora pelo comentário da seção 16 (único: "sete funções da\n--
      // Tarefa 3"), não pelo último "if exists" do arquivo: a Tarefa 4
      // (seção 23, abaixo) acrescentou um QUARTO bloco condicional de
      // agent_worker depois deste, e lastIndexOf passaria a pegar o dela.
      const ancora = sql.indexOf("perde execute nas sete funções da");
      expect(ancora, "comentário da seção 16 (Tarefa 3) não encontrado").toBeGreaterThan(-1);
      const inicio = sql.indexOf("if exists (select 1 from pg_roles where rolname = 'agent_worker') then", ancora);
      expect(inicio, "bloco condicional de agent_worker da Tarefa 3 não encontrado").toBeGreaterThan(-1);
      const fim = sql.indexOf("$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      for (const { nome } of FUNCOES) {
        expect(corpo, `${nome} não está no revoke de agent_worker da Tarefa 3`).toContain(`public.${nome}(`);
      }
    }
  });
});

describe("0909 Tarefa 3: fn_billing_criar_pedido, as seis mensagens de recusa do plano e a ordem das travas (decisão 12)", () => {
  it("as seis mensagens próprias existem no corpo da função", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    for (const mensagem of [
      "billing_compra_desligada",
      "billing_plano_fora_de_venda",
      "billing_preco_nao_definido",
      "billing_metodo_invalido_para_oferta",
      "billing_ja_tem_assinatura_asaas",
      "billing_pedido_aberto_existe",
      "billing_chave_com_valores_diferentes",
    ]) {
      expect(corpo, `mensagem ${mensagem} ausente de fn_billing_criar_pedido`).toContain(mensagem);
    }
  });

  it("lê billing_settings SEM for share nem for update (decisão 12)", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    const leituraSettings = corpo.match(/select compra_pelo_cliente into v_compra_pelo_cliente\s*\n\s*from public\.billing_settings\s*\n\s*where id = 1;/);
    expect(leituraSettings, "a leitura de billing_settings deveria existir, sem for share/for update").not.toBeNull();
  });

  it("usa só o advisory lock billing_assinatura:<org> (a segunda trava da ordem fixa, decisão 12), nunca billing:<org>", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing_assinatura:' \|\| p_org::text, 0\)\)/);
    expect(corpo).not.toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing:' \|\| p_org::text, 0\)\)/);
  });

  it("devolve proxima_cobranca_em (decisão 26)", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_criar_pedido(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/at time zone 'America\/Sao_Paulo'\)::date/);
    expect(corpo).toContain("'proxima_cobranca_em', v_proxima_cobranca_em");
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_tomar é a posse atômica pelo próprio update, sem advisory lock (decisão 25)", () => {
  it("o update condicional está presente, e nenhum pg_advisory_xact_lock aparece no corpo", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_pedido_tomar(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(
      /update public\.billing_orders\s*\n\s*set status = 'processando'\s*\n\s*where id = p_pedido and organization_id = p_org and status in \('criado', 'inconclusivo'\)/,
    );
    expect(corpo).not.toMatch(/pg_advisory_xact_lock/);
  });
});

describe("0909 Tarefa 3: fn_billing_vincular_cliente_asaas usa billing:<org>, a primeira trava da ordem fixa (decisão 12)", () => {
  it("o advisory lock é billing:<org>, não billing_assinatura:<org>", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_vincular_cliente_asaas(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing:' \|\| p_org::text, 0\)\)/);
    expect(corpo).not.toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing_assinatura:' \|\| p_org::text, 0\)\)/);
  });

  it("42501 é o código de outra organização, 22023 o de vínculo diferente na mesma organização", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_vincular_cliente_asaas(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/raise exception 'billing_organizacao_ja_tem_outro_cliente_asaas' using errcode = '22023';/);
    expect(corpo).toMatch(/raise exception 'billing_cliente_asaas_de_outra_organizacao' using errcode = '42501';/);
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_registrar_cobranca amarra invoice_url ao ambiente do PRÓPRIO pedido (decisão 6, risco de redirecionamento aberto)", () => {
  it("formatos ^pay_ e ^sub_, e a URL comparada contra v_pedido.ambiente (nunca uma variável global)", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_pedido_registrar_cobranca(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toContain("p_asaas_payment_id !~ '^pay_'");
    expect(corpo).toContain("p_asaas_subscription_id !~ '^sub_'");
    expect(corpo).toMatch(/v_pedido\.ambiente = 'sandbox' and p_invoice_url !~ '\^https:\/\/sandbox\\\.asaas\\\.com\/'/);
    expect(corpo).toMatch(/v_pedido\.ambiente = 'producao' and p_invoice_url !~/);
  });
});

describe("0909 Tarefa 3: fn_billing_pedido_marcar nunca a partir de pago", () => {
  it("só inconclusivo/falhou/cancelado, e recusa a partir de pago", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_pedido_marcar(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/p_status not in \('inconclusivo', 'falhou', 'cancelado'\)/);
    expect(corpo).toMatch(/if v_pedido\.status = 'pago' then\s*\n\s*raise exception 'billing_pedido_ja_pago'/);
  });
});

// ============================================================================
// TAREFA 4: registrar, reservar com lease, falha, reprocessar, podar.
// ============================================================================

describe("0909 Tarefa 4: as seis peças existem, com a assinatura do plano, em security definer", () => {
  const FUNCOES_TAREFA_4: Array<{ nome: string; assinatura: string; temGrant: boolean }> = [
    { nome: "fn_billing_asaas_registrar_evento", assinatura: "(text, text, text, text, text, jsonb)", temGrant: true },
    { nome: "fn_billing_asaas_reservar_eventos", assinatura: "(integer, integer)", temGrant: true },
    { nome: "fn_billing_asaas_lease_e_meu", assinatura: "(uuid, uuid)", temGrant: false },
    { nome: "fn_billing_asaas_registrar_falha", assinatura: "(uuid, uuid, text)", temGrant: true },
    { nome: "fn_billing_asaas_reprocessar_evento", assinatura: "(uuid, uuid)", temGrant: true },
    { nome: "fn_billing_asaas_podar_eventos", assinatura: "(integer)", temGrant: true },
  ];

  it.each(FUNCOES_TAREFA_4)(
    "$nome$assinatura existe na migração e no bloco do baseline, com security definer e search_path fixo",
    ({ nome, assinatura, temGrant }) => {
      for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
        const criacao = new RegExp(`create or replace function public\\.${nome}\\(`);
        expect(sql, `${nome} não encontrada`).toMatch(criacao);

        const inicio = sql.indexOf(`create or replace function public.${nome}(`);
        const fimCorpo = nome === "fn_billing_asaas_lease_e_meu" ? sql.indexOf("$$;", inicio) : sql.indexOf("\n$$;", inicio);
        const corpo = sql.slice(inicio, fimCorpo);
        expect(corpo, `${nome} sem security definer`).toMatch(/security definer/);
        expect(corpo, `${nome} sem search_path fixo`).toMatch(/set search_path = public, pg_temp/);

        const assinaturaEscapada = assinatura.replace(/[()]/g, (c) => `\\${c}`);
        if (temGrant) {
          expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated`).toMatch(
            new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated;`),
          );
          expect(sql, `${nome}${assinatura} não tem grant só a service_role`).toMatch(
            new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
          );
        } else {
          // fn_billing_asaas_lease_e_meu: o revoke inclui service_role
          // explicitamente (este banco tem alter default privileges que
          // concede EXECUTE a service_role por padrão, o mesmo mecanismo do
          // agent_worker); sem isso a função ficaria executável de graça.
          expect(sql, `${nome}${assinatura} não tem revoke de public/anon/authenticated/service_role`).toMatch(
            new RegExp(`revoke execute on function public\\.${nome}${assinaturaEscapada} from public, anon, authenticated, service_role;`),
          );
          expect(sql, `${nome}${assinatura} é interna e NÃO deveria ter grant a service_role`).not.toMatch(
            new RegExp(`grant execute on function public\\.${nome}${assinaturaEscapada} to service_role;`),
          );
        }
      }
    },
  );

  it("agent_worker (se a role existir) perde execute nas seis funções, num único bloco condicional", () => {
    for (const sql of [MIGRATION_0909, extraiBloco0909Baseline()]) {
      const inicio = sql.lastIndexOf("if exists (select 1 from pg_roles where rolname = 'agent_worker') then");
      expect(inicio, "bloco condicional de agent_worker da Tarefa 4 não encontrado").toBeGreaterThan(-1);
      const fim = sql.indexOf("$$;", inicio);
      const corpo = sql.slice(inicio, fim);
      for (const { nome } of FUNCOES_TAREFA_4) {
        expect(corpo, `${nome} não está no revoke de agent_worker da Tarefa 4`).toContain(`public.${nome}(`);
      }
    }
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_registrar_evento, idempotência e quarentena (decisão 19/M6)", () => {
  const corpo = (() => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_registrar_evento(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("on conflict (event_id) do nothing (evento repetido guardado uma vez só)", () => {
    expect(corpo).toMatch(/on conflict \(event_id\) do nothing/);
  });

  it("checa o formato de event_id (1..100) e de event_type (^[A-Z_]{3,64}$) antes de inserir", () => {
    expect(corpo).toMatch(/char_length\(p_event_id\) < 1 or char_length\(p_event_id\) > 100/);
    expect(corpo).toMatch(/p_event_type !~ '\^\[A-Z_\]\{3,64\}\$'/);
  });

  it("teto de 64 KB (65536 bytes) medido no payload", () => {
    expect(corpo).toMatch(/octet_length\(p_payload::text\) > 65536/);
  });

  it("quarentena grava resultado erro, payload CORTADO (jsonb_build_object, nunca o original) e devolve sucesso", () => {
    expect(corpo).toMatch(/v_resultado := 'erro';/);
    expect(corpo).toMatch(/v_payload := jsonb_build_object\('quarentena', true, 'motivo', v_erro_codigo\);/);
    // O retorno (jsonb_build_object com 'novo') não lança exceção nenhuma no
    // caminho de quarentena: nenhum "raise exception" depois do bloco "if
    // v_quarentena then".
    const trechoQuarentena = corpo.slice(corpo.indexOf("if v_quarentena then"));
    expect(trechoQuarentena).not.toMatch(/raise exception/);
  });

  it("erro_codigo cortado em 200 caracteres no insert", () => {
    expect(corpo).toMatch(/left\(v_erro_codigo, 200\)/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_reservar_eventos, skip locked e lease (decisão 20)", () => {
  const corpo = (() => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_reservar_eventos(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("for update skip locked, só resultado = aguardando", () => {
    expect(corpo).toMatch(/for update skip locked/);
    expect(corpo).toMatch(/aw\.resultado = 'aguardando'/);
  });

  it("proxima_tentativa_em vencido (nulo ou passado) e lease vencido ou nulo", () => {
    expect(corpo).toMatch(/aw\.proxima_tentativa_em is null or aw\.proxima_tentativa_em <= now\(\)/);
    expect(corpo).toMatch(/aw\.lease_expira_em is null or aw\.lease_expira_em < now\(\)/);
  });

  it("grava lease_token novo (gen_random_uuid) com validade p_lease_segundos", () => {
    expect(corpo).toMatch(/lease_token = gen_random_uuid\(\)/);
    expect(corpo).toMatch(/lease_expira_em = now\(\) \+ \(p_lease_segundos \|\| ' seconds'\)::interval/);
  });

  it("p_lease_segundos tem default 300 na assinatura", () => {
    const assinatura = MIGRATION_0909.slice(
      MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_reservar_eventos("),
      MIGRATION_0909.indexOf(")\nreturns table"),
    );
    expect(assinatura).toMatch(/p_lease_segundos integer default 300/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_lease_e_meu, interna e sem grant a service_role", () => {
  it("confere lease_token igual e lease_expira_em no futuro", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_lease_e_meu(");
    const fim = MIGRATION_0909.indexOf("$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);
    expect(corpo).toMatch(/lease_token = p_lease_token/);
    expect(corpo).toMatch(/lease_expira_em > now\(\)/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_registrar_falha, lease alheio recusado e backoff (decisão 20)", () => {
  const corpo = (() => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_registrar_falha(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    return MIGRATION_0909.slice(inicio, fim);
  })();

  it("recusa quando o lease não é mais o do chamador", () => {
    expect(corpo).toMatch(
      /if p_lease_token is null or v_evento\.lease_token is distinct from p_lease_token then\s*\n\s*raise exception 'billing_lease_invalido' using errcode = '22023';/,
    );
  });

  it("tentativas + 1, vira erro na décima (tentativas >= 10)", () => {
    expect(corpo).toMatch(/v_tentativas := v_evento\.tentativas \+ 1;/);
    expect(corpo).toMatch(/if v_tentativas >= 10 then\s*\n\s*v_resultado := 'erro';/);
  });

  it("backoff now() + least(2^tentativas minutos, 6 horas)", () => {
    expect(corpo).toMatch(/least\(\s*\n\s*power\(2::double precision, v_tentativas::double precision\) \* interval '1 minute',\s*\n\s*interval '6 hours'\s*\n\s*\)/);
  });

  it("erro_codigo cortado em 200 caracteres", () => {
    expect(corpo).toMatch(/erro_codigo = left\(p_codigo, 200\)/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_reprocessar_evento, só a partir de erro", () => {
  it("recusa fora de resultado = erro, e zera tentativas/proxima_tentativa_em/erro_codigo/lease", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_reprocessar_evento(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(
      /if v_evento\.resultado <> 'erro' then\s*\n\s*raise exception 'billing_evento_nao_esta_em_erro' using errcode = '22023';/,
    );
    expect(corpo).toMatch(/tentativas = 0,/);
    expect(corpo).toMatch(/proxima_tentativa_em = now\(\),/);
    expect(corpo).toMatch(/erro_codigo = null,/);
    expect(corpo).toMatch(/lease_token = null,/);
  });
});

describe("0909 Tarefa 4: fn_billing_asaas_podar_eventos, payload vira {} e marca payload_podado_em (decisão 21/N38)", () => {
  it("where payload_podado_em is null and recebido_em mais velho que p_dias", () => {
    const inicio = MIGRATION_0909.indexOf("create or replace function public.fn_billing_asaas_podar_eventos(");
    const fim = MIGRATION_0909.indexOf("\n$$;", inicio);
    const corpo = MIGRATION_0909.slice(inicio, fim);

    expect(corpo).toMatch(/set payload = '\{\}'::jsonb,/);
    expect(corpo).toMatch(/payload_podado_em = now\(\)/);
    expect(corpo).toMatch(/where payload_podado_em is null\s*\n\s*and recebido_em < now\(\) - \(p_dias \|\| ' days'\)::interval;/);
    expect(corpo).toMatch(/get diagnostics v_quantos = row_count;/);
  });
});
